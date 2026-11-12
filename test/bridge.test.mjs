// The bridge against a stand-in for craft-mcp: an MCP server per "tab" with a few tools.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Bridge } from "../src/bridge.mjs";

// A fake relay: /<key>/<app>/mcp, tools "ui.inspect" and "draw". forget() drops its sessions, as
// craft-mcp does when it restarts.
function relay() {
  const sessions = new Map();
  const calls = [];
  const http = createServer(async (req, res) => {
    const m = /^\/([^/]+)\/([a-z]+)\/mcp$/.exec(new URL(req.url, "http://x").pathname);
    if (!m) return res.writeHead(404).end();
    const id = req.headers["mcp-session-id"];
    let transport = id && sessions.get(id);
    if (id && !transport) return res.writeHead(404).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
    if (!transport) {
      const server = new Server({ name: m[2], version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
          { name: "ui.inspect", description: "What the app shows", inputSchema: { type: "object", properties: {} } },
          { name: "draw", description: "Draw a shape", inputSchema: { type: "object", properties: { shape: { type: "string" } } } },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, (r) => {
        calls.push({ key: m[1], app: m[2], name: r.params.name, args: r.params.arguments });
        return { content: [{ type: "text", text: `${m[2]} did ${r.params.name} ${JSON.stringify(r.params.arguments ?? {})}` }] };
      });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (sid) => sessions.set(sid, transport) });
      await server.connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  return new Promise((resolve) => http.listen(0, "127.0.0.1", () => resolve({
    url: (key, app) => `http://127.0.0.1:${http.address().port}/${key}/${app}/mcp`,
    calls,
    forget: () => sessions.clear(),
    close: () => new Promise((r) => { http.closeAllConnections(); http.close(r); }),
  })));
}

const APPS = [{ name: "photocraft", title: "PhotoCraft" }, { name: "vectorcraft", title: "VectorCraft" }];
let fake, bridge, port, client, opened, listChanged;

before(async () => {
  fake = await relay();
  opened = [];
  bridge = new Bridge({
    apps: () => APPS,
    // Opening a panel: the tab connects a moment later, as the webview's handshake would report.
    open: (app) => { opened.push(app); setTimeout(() => bridge.update(app, { mcp: fake.url("k2", app), state: "on", title: "VectorCraft" }), 50); },
  });
  port = await bridge.listen(0);
  client = new Client({ name: "test", version: "1" });
  listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged++; });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

after(async () => {
  await client.close();
  await bridge.close();
  await fake.close();
});

const names = async () => (await client.listTools()).tools.map((t) => t.name);
const until = async (f, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("with no app open there are only the bridge's own tools", async () => {
  assert.deepEqual(await names(), ["craft_apps", "craft_open", "craft_call"]);
  const r = await client.callTool({ name: "photocraft_draw", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /isn't open\. Call craft_open/);
});

test("a connected tab's tools appear as <app>_<tool>, and the client hears about it", async () => {
  const before = listChanged;
  bridge.update("photocraft", { mcp: fake.url("k1", "photocraft"), state: "on", title: "PhotoCraft" });
  await until(async () => (await names()).includes("photocraft_draw"));
  assert.ok((await names()).includes("photocraft_ui_inspect"), "dots become underscores");
  await until(() => listChanged > before);
  const tool = (await client.listTools()).tools.find((t) => t.name === "photocraft_draw");
  assert.equal(tool.description, "PhotoCraft: Draw a shape");
  assert.deepEqual(tool.inputSchema.properties, { shape: { type: "string" } });
});

test("calls reach the tab under the tool's own name", async () => {
  const r = await client.callTool({ name: "photocraft_ui_inspect", arguments: {} });
  assert.equal(textOf(r), "photocraft did ui.inspect {}");
  const c = await client.callTool({ name: "craft_call", arguments: { app: "photocraft", tool: "draw", arguments: { shape: "circle" } } });
  assert.equal(textOf(c), 'photocraft did draw {"shape":"circle"}');
  assert.deepEqual(fake.calls.at(-1), { key: "k1", app: "photocraft", name: "draw", args: { shape: "circle" } });
});

test("craft_apps says what is open", async () => {
  const status = JSON.parse(textOf(await client.callTool({ name: "craft_apps", arguments: {} })));
  assert.deepEqual(status.map((s) => [s.app, s.open, s.connected, s.tools]), [["photocraft", true, true, 2], ["vectorcraft", false, false, 0]]);
});

test("craft_open opens the panel and waits for its tab", async () => {
  const r = await client.callTool({ name: "craft_open", arguments: { app: "vectorcraft" } });
  assert.deepEqual(opened, ["vectorcraft"]);
  assert.match(textOf(r), /VectorCraft is open and connected/);
  assert.match(textOf(r), /- draw: Draw a shape/);
  assert.ok((await names()).includes("vectorcraft_draw"));
  const bad = await client.callTool({ name: "craft_open", arguments: { app: "nope" } });
  assert.equal(bad.isError, true);
});

test("a call after the relay forgot the session starts a new one", async () => {
  fake.forget();
  const r = await client.callTool({ name: "photocraft_draw", arguments: { shape: "square" } });
  assert.equal(textOf(r), 'photocraft did draw {"shape":"square"}');
});

test("a new MCP URL (New URL in the hub) replaces the old connection", async () => {
  bridge.update("photocraft", { mcp: fake.url("k3", "photocraft"), state: "on" });
  await until(async () => (await names()).includes("photocraft_draw"));
  await client.callTool({ name: "photocraft_draw", arguments: {} });
  assert.equal(fake.calls.at(-1).key, "k3");
});

test("closing a panel takes its tools away", async () => {
  bridge.remove("vectorcraft");
  assert.ok(!(await names()).includes("vectorcraft_draw"));
});

test("another window's panels count, through /tabs", async () => {
  const post = (body) => fetch(`http://127.0.0.1:${port}/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ window: "w2", tabs: { vectorcraft: { mcp: fake.url("k4", "vectorcraft"), state: "on", title: "VectorCraft" } } })).status, 204);
  await until(async () => (await names()).includes("vectorcraft_draw"));
  await post({ window: "w2", tabs: {} });
  await until(async () => !(await names()).includes("vectorcraft_draw"));
});

test("two windows with the same app: the tab of the window focused last counts", async () => {
  const post = (body) => fetch(`http://127.0.0.1:${port}/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const tab = (key) => ({ lightcraft: { mcp: fake.url(key, "lightcraft"), state: "on", title: "LightCraft" } });
  const used = async () => { await until(async () => (await names()).includes("lightcraft_draw")); await client.callTool({ name: "lightcraft_draw", arguments: {} }); return fake.calls.at(-1).key; };
  // A browser tab that is gone: its window was focused long ago, and goes on reporting.
  await post({ window: "ghost", focusedAt: 100, tabs: tab("k-ghost") });
  assert.equal(await used(), "k-ghost");
  await post({ window: "live", focusedAt: 200, tabs: tab("k-live") });
  assert.equal(await used(), "k-live");
  await post({ window: "ghost", focusedAt: 100, tabs: tab("k-ghost") });
  assert.equal(await used(), "k-live", "the older window's report doesn't take the app back");
  await post({ window: "ghost", focusedAt: 100, tabs: {} });
  assert.equal(await used(), "k-live", "nor does it take the live tab away");
  await post({ window: "live", focusedAt: 200, tabs: {} });
  await until(async () => !(await names()).includes("lightcraft_draw"));
});

test("another window long-polls /commands and gets what is sent to it", async () => {
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ window: "w3", focusedAt: 42, tabs: {} }) });
  assert.deepEqual(bridge.windows().find((w) => w.id === "w3"), { id: "w3", focusedAt: 42, apps: [] });
  const polled = fetch(`${base}/commands?window=w3`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(bridge.send("w3", { type: "open", app: "photocraft" }), true);
  assert.deepEqual(await polled, [{ type: "open", app: "photocraft" }]);
  assert.equal(bridge.send("nobody", { type: "open", app: "photocraft" }), false);
  assert.equal((await fetch(`${base}/commands?window=nobody`)).status, 404);
});

test("only requests addressed to 127.0.0.1 or localhost are served", async () => {
  const { request } = await import("node:http");
  const status = await new Promise((resolve) => request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example:80", "content-type": "application/json" } },
    (res) => { res.resume(); resolve(res.statusCode); }).end("{}"));
  assert.equal(status, 403);
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
  assert.ok(health.craft);
});
