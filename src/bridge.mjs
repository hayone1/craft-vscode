// One local MCP server ("craft") for every craft app open in this editor. Each app panel reports
// its tab's relay MCP URL (craft-mcp, through craft-web-gateway); the bridge keeps an MCP client to
// each and offers their tools as <app>_<tool>, plus three tools that always exist:
//
//   craft_apps   which apps there are, and which are open and connected
//   craft_open   open an app in the editor and wait until it is connected
//   craft_call   call any tool of an open app (for clients that miss tools/list_changed)
//
// and three that move files between the workspace and an open app. The apps run in a browser
// tab, so the bytes go through the relay's files endpoint (craft-mcp), which hands them to the
// tab's page (craft-files.js in the app images):
//
//   craft_send_file   a workspace file into the app, as if the user dropped it there
//   craft_app_files   the files the app saved, exported or rendered in its tab
//   craft_get_file    one of those into the workspace
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

const VERSION = "0.4.0";
// The relay gives a tab 120 s per request; a long tool call can report progress and go on.
const CALL_TIMEOUT_MS = 10 * 60_000;
const OPEN_TIMEOUT_MS = 90_000;
// Files move through the relay in parts of this size (base64 in JSON, under the relay's 24 MB).
const FILE_PART = 4 << 20;
const MAX_FILE = 200 << 20; // as files.mjs' MAX_BYTES
const FILE_WAIT_S = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  {
    name: "craft_send_file",
    description: "Copy a file from the editor's workspace into an open craft app, as if the user dropped it on the app. " +
      "PhotoCraft and VectorCraft open it, LightCraft adds the photo to its library, FilmCraft imports it into the project " +
      "(a .fcproj opens as the project), EffectCraft adds it to its file table, opens (.ecproj) or imports it, and returns " +
      "the path to name in EffectCraft's tools.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app's name, e.g. filmcraft" },
        path: { type: "string", description: "The file: an absolute path inside a workspace folder (e.g. /home/coder/project/media/clip.mp4), or a path relative to the first workspace folder" },
      },
      required: ["app", "path"],
    },
  },
  {
    name: "craft_app_files",
    description: "List the files an open craft app has saved, exported or rendered in its browser tab (newest last), and " +
      "the files FilmCraft and EffectCraft keep in their own file tables. Copy one into the workspace with craft_get_file.",
    inputSchema: { type: "object", properties: { app: { type: "string", description: "The app's name" } }, required: ["app"] },
  },
  {
    name: "craft_get_file",
    description: "Copy a file that an open craft app saved, exported or rendered into the editor's workspace. The apps run " +
      "in a browser, so first save or export with the app's own tool (any file name or path): the tab keeps the file, " +
      "and this tool writes it where you say. Takes the newest file of that name. Waits up to `wait` seconds for the file " +
      "to appear (a render may take a while).",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app's name" },
        name: { type: "string", description: "The file's name as the app saved it (e.g. poster.png), or its path in craft_app_files" },
        path: { type: "string", description: "Where to write it: an absolute path inside a workspace folder, or a path relative to the first workspace folder. An existing file is replaced." },
        wait: { type: "number", description: `Seconds to wait for the file (default ${FILE_WAIT_S}, at most 600)` },
      },
      required: ["app", "name", "path"],
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
   *   workspace?: {                  the workspace files an agent names (craft_send_file, craft_get_file)
   *     read: (path: string) => Promise<{name: string, bytes: Uint8Array}>,
   *     write: (path: string, bytes: Uint8Array) => Promise<{path: string}>,
   *     check?: (path: string) => Promise<void>,   rejects a path write would refuse
   *   },
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
    if (name === "craft_send_file") return this.#sendFile(String(args.app ?? ""), args.path, extra);
    if (name === "craft_app_files") return text(JSON.stringify(await this.#tabFiles(String(args.app ?? ""), { op: "list" }, extra), null, 2));
    if (name === "craft_get_file") return this.#getFile(String(args.app ?? ""), args.name, args.path, args.wait, extra);
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

  // ---- files between the workspace and an app's tab ----------------------------------------
  // One request to the tab's page through the relay's files endpoint: its result, or an Error.
  async #tabFiles(app, params, extra = {}) {
    const tab = this.tabs.get(app);
    if (!tab) throw new Error(`${app || "That app"} isn't open. Call craft_open with app "${app}" first.`);
    const url = tab.mcp.replace(/\/mcp\/?$/, "/files");
    const res = await httpFetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal: extra.signal,
    });
    if (!res.ok) {
      throw new Error(res.status === 404
        ? `The relay doesn't take files for ${tab.title}: it may be older than this extension (craft-mcp needs the files endpoint), or the app's link has expired.`
        : `The relay answered ${res.status}.`);
    }
    const reply = await res.json();
    if (!reply?.ok) throw new Error(String(reply?.error ?? `${tab.title}'s tab refused.`));
    return reply.result;
  }

  async #sendFile(app, path, extra) {
    if (!this.host.workspace) return text("This editor can't read its workspace files.", true);
    if (!this.tabs.has(app)) return text(`${app || "That app"} isn't open. Call craft_open with app "${app}" first.`, true);
    const { name, bytes } = await this.host.workspace.read(String(path ?? ""));
    const upload = randomUUID();
    for (let at = 0; ; at += FILE_PART) {
      const part = bytes.subarray(at, at + FILE_PART);
      const done = at + FILE_PART >= bytes.byteLength;
      const data = Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString("base64");
      const result = await this.#tabFiles(app, { op: "put", upload, name, data, done }, extra);
      if (done) return text(JSON.stringify(result, null, 2));
    }
  }

  async #getFile(app, name, path, wait = FILE_WAIT_S, extra = {}) {
    if (!this.host.workspace) return text("This editor can't write its workspace files.", true);
    if (typeof name !== "string" || !name) return text("Name the file to copy (craft_app_files lists them).", true);
    if (typeof path !== "string" || !path) return text("Say where to write the file in the workspace.", true);
    const tab = this.tabs.get(app);
    if (!tab) return text(`${app || "That app"} isn't open. Call craft_open with app "${app}" first.`, true);
    await this.host.workspace.check?.(path);
    const seconds =Math.min(Math.max(Number(wait ?? FILE_WAIT_S) || 0, 0), 600);
    const until = Date.now() + seconds * 1000;
    let first;
    for (;;) {
      try {
        first = await this.#tabFiles(app, { op: "read", name, offset: 0, length: FILE_PART }, extra);
        break;
      } catch (e) {
        if (!/no saved file/i.test(e.message) || Date.now() >= until || extra.signal?.aborted) throw e;
        await sleep(1000);
      }
    }
    const size = Number(first.size) || 0;
    if (size > MAX_FILE) return text(`${first.name} has ${(size / 1048576).toFixed(0)} MB; the workspace takes files of up to ${MAX_FILE >> 20} MB.`, true);
    const parts = [Buffer.from(first.data ?? "", "base64")];
    let got = parts[0].length;
    while (got < size) {
      const r = await this.#tabFiles(app, { op: "read", name, offset: got, length: FILE_PART }, extra);
      const part = Buffer.from(r.data ?? "", "base64");
      if (Number(r.size) !== size || !part.length) throw new Error(`${first.name} changed in ${tab.title} while it was being copied; try again.`);
      parts.push(part);
      got += part.length;
    }
    const bytes = Buffer.concat(parts, got);
    const written = await this.host.workspace.write(path, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return text(`Copied ${first.name} (${got} bytes) from ${tab.title} to ${written.path}.`);
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
        "Files: the apps run in a browser tab, not as desktop apps, so their --automation-read-root and " +
        "--automation-write-root flags don't apply and are not needed, and an app's own tools can't read the workspace's files. " +
        "To give an app a file from the workspace, call craft_send_file (it opens or imports the file as a drop would). " +
        "To get a file out, save, export or render it with the app's own tool (the browser tab keeps the file instead " +
        "of writing a disk path), then call craft_get_file with its name and the workspace path to write; craft_app_files " +
        "lists what the tab keeps. PhotoCraft's doc_open, doc_save and doc_export also take workspace paths directly, " +
        "e.g. /home/coder/project/out/cat.png; its doc_export_layers and doc_export_data_sets don't work in the browser. Workspace paths are absolute paths inside a folder open in the editor, or " +
        "relative to the first folder; hidden folders and paths outside the folders are refused, and node_modules is " +
        "read-only. The editor's craft.workspaceFiles setting must allow it (readWrite, the default).",
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
