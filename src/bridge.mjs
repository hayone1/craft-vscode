// One local MCP server ("craft") for every craft app open in this editor. Each app panel reports
// its tab's relay MCP URL (craft-mcp, through craft-web-gateway); the bridge keeps an MCP client to
// each and offers their tools as <app>_<tool>, plus three tools that always exist:
//
//   craft_apps   which apps there are, and which are open and connected
//   craft_open   open an app in the editor and wait until it is connected
//   craft_call   call any tool of an open app (for clients that miss tools/list_changed)
//
// No vscode import here, so the tests can run it in plain Node.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
// undici, not the global fetch: VS Code wraps that one for proxies and asks the window to resolve
// them, so it hangs in an extension host whose browser tab has gone (code-server keeps those).
import { fetch as httpFetch } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

const VERSION = "0.3.4";
// The relay gives a tab 120 s per request; a long tool call can report progress and go on.
const CALL_TIMEOUT_MS = 10 * 60_000;
const OPEN_TIMEOUT_MS = 90_000;

const STATIC = [
  {
    name: "craft_apps",
    description: "List the craft apps (PhotoCraft, VectorCraft, …) and say which are open in the editor and connected. Each connected app's tools are also offered as <app>_<tool>.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "craft_open",
    description: "Open a craft app in the editor (or show it if it is open) and wait until it is connected. Returns the app's tools. The user sees and can use the app while you work in it.",
    inputSchema: { type: "object", properties: { app: { type: "string", description: "The app's name, e.g. photocraft" } }, required: ["app"] },
  },
  {
    name: "craft_call",
    description: "Call a tool of an open craft app by its own name (as craft_open lists it). Use the <app>_<tool> tools instead when you have them.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object", description: "The tool's arguments" },
      },
      required: ["app", "tool"],
    },
  },
];

// MCP clients (and the models behind them) accept [A-Za-z0-9_-]{1,64} for tool names.
const toolName = (app, tool) => `${app}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
// Hashing first gives both sides the same length, which timingSafeEqual needs.
const digest = (s) => createHash("sha256").update(String(s)).digest();
const sameToken = (a, b) => timingSafeEqual(digest(a), digest(b));

export class Bridge {
  /**
   * @param {{
   *   apps: () => {name: string, title: string}[],
   *   open: (app: string) => Promise<void> | void,
   *   token?: () => string,          the bearer token every request but /healthz must carry; none: no check
   *   refreshToken?: () => void,     reloads the token (another window may have made a new one)
   *   log?: (s: string) => void,
   *   focusedAt?: () => number,      when this window was last focused (ms), to pick between windows
   * }} host
   */
  constructor(host) {
    this.host = host;
    this.log = host.log ?? (() => {});
    /** @type {Map<string, {mcp: string, state: string, title: string, client?: Client, tools: any[], ready?: Promise<void>, error?: string}>} */
    this.tabs = new Map();
    this.sessions = new Map(); // MCP session id -> { server, transport }
    this.waiters = new Set();
    this.remotes = new Map(); // other windows: id -> {tabs, focusedAt, queue, polls, timer}
    this.owners = new Map(); // app -> the window whose tab it is: "" for this one, else its id
  }

  // ---- what the panels report -----------------------------------------------------------
  /**
   * A panel's tab: its relay MCP URL and connection state ("on", "connecting", "off", …), from
   * this window ("") or another one (its id). When two windows have the app open, the tab of the
   * window focused last counts. code-server keeps a window's extension host running for hours
   * after its browser tab is gone, and that window goes on reporting a panel that no longer
   * exists; without this rule the two tabs took turns, and every other call found no tab.
   */
  update(app, { mcp, state, title }, from = "") {
    if (!mcp) return this.remove(app, from);
    const owner = this.owners.get(app);
    if (owner !== undefined && owner !== from && this.tabs.has(app) && this.#focus(from) < this.#focus(owner)) return;
    this.owners.set(app, from);
    const old = this.tabs.get(app);
    if (old && old.mcp === mcp) {
      if (old.state === state && (title ?? old.title) === old.title) return;
      const wasOn = old.state === "on";
      Object.assign(old, { state, title: title ?? old.title });
      // A tab that reconnected may answer differently (a reload); ask again.
      if (state === "on" && !wasOn) this.#connect(app, old);
      this.#changed();
      return;
    }
    if (old) this.#close(old);
    const tab = { mcp, state, title: title ?? app, tools: [] };
    this.tabs.set(app, tab);
    if (state === "on") this.#connect(app, tab);
    this.#changed();
  }

  // Another window's panels, as {window, focusedAt, tabs: {app: {mcp, state, title}}}. They count
  // until that window stops reporting (it reports every 15 s, and whenever something changes).
  #remote({ window: from, tabs = {}, focusedAt = 0 }) {
    const w = this.remotes.get(from) ?? { queue: [], polls: new Set(), tabs: {} };
    Object.assign(w, { tabs, focusedAt: Number(focusedAt) || 0 });
    this.remotes.set(from, w);
    for (const [app, owner] of [...this.owners]) if (owner === from && !(app in tabs)) this.remove(app, from);
    for (const [app, tab] of Object.entries(tabs)) this.update(app, tab, from);
    clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      this.remotes.delete(from);
      for (const [app, owner] of [...this.owners]) if (owner === from) this.remove(app, from);
    }, 45_000);
    w.timer.unref?.();
  }

  // When a window ("" for this one) was last focused.
  #focus(id) {
    return id === "" ? Number(this.host.focusedAt?.()) || 0 : this.remotes.get(id)?.focusedAt ?? 0;
  }

  /** The other windows that report here: [{id, focusedAt, apps}]. */
  windows() {
    return [...this.remotes].map(([id, w]) => ({ id, focusedAt: w.focusedAt, apps: Object.keys(w.tabs) }));
  }

  /** Hands a command ({type: "open", app}) to another window, which long-polls /commands. */
  send(id, command) {
    const w = this.remotes.get(id);
    if (!w) return false;
    w.queue.push(command);
    for (const poll of [...w.polls]) poll();
    return true;
  }

  #poll(id, res) {
    const w = this.remotes.get(id);
    if (!w) return res.writeHead(404).end();
    const answer = () => {
      clearTimeout(t);
      w.polls.delete(answer);
      if (!res.writableEnded) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(w.queue.splice(0)));
    };
    const t = setTimeout(answer, 25_000);
    res.on("close", () => { clearTimeout(t); w.polls.delete(answer); });
    if (w.queue.length) return answer();
    w.polls.add(answer);
  }

  /** Takes the app's tab away, if it is the tab of window `from` ("" for this one). */
  remove(app, from = "") {
    const tab = this.tabs.get(app);
    const owner = this.owners.get(app);
    if (owner !== undefined && owner !== from) return;
    this.owners.delete(app);
    if (!tab) return;
    this.tabs.delete(app);
    this.#close(tab);
    this.#changed();
  }

  #close(tab) {
    tab.client?.close().catch(() => {});
    tab.client = undefined;
    tab.tools = [];
  }

  #connect(app, tab) {
    tab.ready = (async () => {
      this.#close(tab);
      const client = new Client({ name: "craft-vscode", version: VERSION });
      client.onerror = (e) => this.log(`${app}: ${e.message}`);
      await client.connect(new StreamableHTTPClientTransport(new URL(tab.mcp), { fetch: httpFetch }));
      if (this.tabs.get(app) !== tab) return void client.close().catch(() => {});
      tab.client = client;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.#loadTools(app, tab).catch(() => {}));
      await this.#loadTools(app, tab);
      tab.error = undefined;
      this.log(`${app}: connected, ${tab.tools.length} tools`);
    })().catch((e) => {
      tab.error = e.message;
      this.log(`${app}: ${e.message}`);
    });
    return tab.ready;
  }

  async #loadTools(app, tab) {
    const tools = [];
    let cursor;
    do {
      const page = await tab.client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    tab.tools = tools;
    this.#changed();
  }

  #changed() {
    for (const { server } of this.sessions.values()) server.sendToolListChanged().catch(() => {});
    for (const f of [...this.waiters]) f();
  }

  // ---- what MCP clients see ---------------------------------------------------------------
  listTools() {
    const tools = [...STATIC];
    for (const [app, tab] of this.tabs) {
      for (const t of tab.tools) {
        tools.push({ ...t, name: toolName(app, t.name), description: `${tab.title}: ${t.description ?? t.name}` });
      }
    }
    return tools;
  }

  async callTool(name, args = {}, extra = {}) {
    if (name === "craft_apps") return text(JSON.stringify(this.#status(), null, 2));
    if (name === "craft_open") return this.#open(String(args.app ?? ""));
    if (name === "craft_call") return this.#call(String(args.app ?? ""), String(args.tool ?? ""), args.arguments ?? {}, extra);
    for (const [app, tab] of this.tabs) {
      const tool = tab.tools.find((t) => toolName(app, t.name) === name);
      if (tool) return this.#call(app, tool.name, args, extra);
    }
    const app = this.host.apps().find((a) => name.startsWith(`${a.name}_`));
    return text(app ? `${app.title} isn't open. Call craft_open with app "${app.name}" first.` : `No tool named ${name}.`, true);
  }

  #status() {
    return this.host.apps().map(({ name, title }) => {
      const tab = this.tabs.get(name);
      return {
        app: name, title,
        open: Boolean(tab),
        connected: Boolean(tab?.client),
        state: tab?.state ?? "closed",
        tools: tab?.tools.length ?? 0,
        ...(tab?.error ? { error: tab.error } : {}),
      };
    });
  }

  async #open(app) {
    const known = this.host.apps().find((a) => a.name === app);
    if (!known) return text(`No app named "${app}". Apps: ${this.host.apps().map((a) => a.name).join(", ")}.`, true);
    await this.host.open(app);
    const ok = await this.#waitFor(() => this.tabs.get(app)?.client && this.tabs.get(app).tools.length > 0, OPEN_TIMEOUT_MS);
    const tab = this.tabs.get(app);
    if (!ok) {
      return text(tab
        ? `${known.title} is open but not connected yet (${tab.error ?? tab.state}). If the panel asks the user to sign in, they need to do that first.`
        : `${known.title} is open, but it hasn't connected. The user may need to sign in to the hub in the panel.`, true);
    }
    return text(`${known.title} is open and connected. Its tools (also offered directly as ${app}_<tool>):\n` +
      tab.tools.map((t) => `- ${t.name}: ${t.description ?? ""}`).join("\n"));
  }

  async #call(app, tool, args, extra) {
    const tab = this.tabs.get(app);
    if (!tab) return text(`${app} isn't open. Call craft_open with app "${app}" first.`, true);
    if (!tab.client) await tab.ready;
    if (!tab.client) return text(`${tab.title} is open but not connected (${tab.error ?? tab.state}).`, true);
    const run = () => tab.client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, signal: extra.signal,
    });
    try {
      return await run();
    } catch (e) {
      // The relay forgets a session it hasn't seen for an hour, or when it restarts: start over once.
      if (!/session|404|not found/i.test(String(e.message))) throw e;
      await this.#connect(app, tab);
      if (!tab.client) throw e;
      return await run();
    }
  }

  #waitFor(test, ms) {
    if (test()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(t); this.waiters.delete(check); resolve(v); };
      const check = () => test() && done(true);
      const t = setTimeout(() => done(false), ms);
      this.waiters.add(check);
    });
  }

  // ---- the server -------------------------------------------------------------------------
  #authorized(req) {
    if (!this.host.token) return true;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
    if (!m) return false;
    if (sameToken(m[1], this.host.token())) return true;
    this.host.refreshToken?.();
    return sameToken(m[1], this.host.token());
  }

  #server() {
    const server = new Server({ name: "craft", version: VERSION }, {
      capabilities: { tools: { listChanged: true } },
      instructions: "Drives the craft apps (PhotoCraft, VectorCraft, LightCraft, FilmCraft, EffectCraft) open in the user's editor. " +
        "Call craft_apps to see what is open, craft_open to open an app; then use its <app>_<tool> tools (or craft_call). " +
        "The user watches the app while you work, so tell them what you are doing. " +
        "Files: the apps run in a browser, not as desktop apps, so their --automation-read-root and --automation-write-root " +
        "flags don't apply and are not needed. PhotoCraft's doc_open, doc_save and doc_export read and write " +
        "files in the editor's workspace folders: pass an absolute path inside a folder open in the editor, e.g. " +
        "/home/coder/project/out/cat.png. The editor's craft.workspaceFiles setting must allow it (readWrite, the default). " +
        "Paths outside the workspace folders, and hidden folders, are refused. Tools that write several files at once " +
        "(doc_export_layers, doc_export_data_sets) don't work in the browser: export one file at a time with doc_export.",
    });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      try {
        return await this.callTool(req.params.name, req.params.arguments ?? {}, extra);
      } catch (e) {
        return text(String(e?.message ?? e), true);
      }
    });
    return server;
  }

  /** Serves MCP at http://127.0.0.1:<port>/mcp. Resolves with the port; rejects if it is taken. */
  listen(port, hostname = "127.0.0.1") {
    const hosts = []; // filled in once the port is known
    this.http = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://local");
        if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ craft: VERSION, auth: Boolean(this.host.token) }));
        if (!hosts.includes(req.headers.host ?? "")) return res.writeHead(403).end();
        // Any process on this machine can reach the port, so every request carries the token.
        if (!this.#authorized(req)) {
          return res.writeHead(401, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Missing or wrong bearer token (CRAFT_MCP_TOKEN)" }, id: null }));
        }
        // Another editor window on this machine reports its panels here (see Follower).
        if (url.pathname === "/tabs" && req.method === "POST" && req.headers["content-type"] === "application/json") {
          let body = "";
          for await (const chunk of req) body += chunk;
          this.#remote(JSON.parse(body));
          return res.writeHead(204).end();
        }
        if (url.pathname === "/commands" && req.method === "GET") return this.#poll(url.searchParams.get("window") ?? "", res);
        if (url.pathname !== "/mcp") return res.writeHead(404).end();
        const id = req.headers["mcp-session-id"];
        let session = typeof id === "string" ? this.sessions.get(id) : undefined;
        if (!session) {
          if (id) return res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
          const server = this.#server();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableDnsRebindingProtection: true,
            allowedHosts: hosts,
            onsessioninitialized: (sid) => this.sessions.set(sid, session),
          });
          transport.onclose = () => { if (transport.sessionId) this.sessions.delete(transport.sessionId); };
          session = { server, transport };
          await server.connect(transport);
        }
        await session.transport.handleRequest(req, res);
      } catch (e) {
        this.log(`mcp: ${e.message}`);
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, hostname, () => {
        const bound = this.http.address().port;
        hosts.push(`127.0.0.1:${bound}`, `localhost:${bound}`);
        resolve(bound);
      });
    });
  }

  async close() {
    for (const { transport } of this.sessions.values()) await transport.close().catch(() => {});
    this.sessions.clear();
    for (const tab of this.tabs.values()) this.#close(tab);
    for (const w of this.remotes.values()) { clearTimeout(w.timer); for (const poll of [...w.polls]) poll(); }
    await new Promise((r) => (this.http ? this.http.close(() => r()) : r()));
    this.http?.closeAllConnections?.();
  }
}
