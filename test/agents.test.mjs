// Agent registration and the MCP token, against a temporary home folder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { codexRead, codexWrite, syncAgents } from "../src/agents.mjs";
import { Bridge } from "../src/bridge.mjs";
import { resolveToken, rotateToken, tokenFile } from "../src/token.mjs";

const homes = [];
const home = () => { const h = mkdtempSync(join(tmpdir(), "craft-home-")); homes.push(h); return h; };
after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const URL_ = "http://127.0.0.1:47811/mcp";
const env = { PATH: "" }; // no agent CLI on PATH; agents are found by their config folders

test("the token comes from CRAFT_MCP_TOKEN, else from a file made on first use", () => {
  const h = home();
  const file = tokenFile(h);
  assert.deepEqual(resolveToken({ env: { CRAFT_MCP_TOKEN: " set-by-me " }, file }), { token: "set-by-me", source: "env" });
  const made = resolveToken({ env: {}, file });
  assert.equal(made.source, "file");
  assert.match(made.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(resolveToken({ env: {}, file }).token, made.token, "the same token on the next start");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const next = rotateToken({ env: {}, file });
  assert.notEqual(next.token, made.token);
  assert.equal(readFileSync(file, "utf8").trim(), next.token);
});

test("codex: the craft table is written, read back, and replaced without touching the rest", () => {
  const before = 'model = "gpt-5"\n\n[mcp_servers.other]\nurl = "https://x/mcp"\n\n[mcp_servers.craft]\nurl = "http://old/mcp"\n\n[mcp_servers.craft.tools]\nx = 1\n\n[profiles.fast]\nmodel = "o4"\n';
  const after_ = codexWrite(before, "craft", URL_, "tok");
  assert.deepEqual(codexRead(after_, "craft"), { url: URL_, token: "tok" });
  assert.match(after_, /\[mcp_servers\.other\]\nurl = "https:\/\/x\/mcp"/);
  assert.match(after_, /\[profiles\.fast\]\nmodel = "o4"/);
  assert.doesNotMatch(after_, /old\/mcp|craft\.tools/);
  assert.equal(after_.match(/\[mcp_servers\.craft\]/g).length, 1);
  assert.equal(codexRead('model = "x"\n', "craft"), null);
});

test("a sync adds each installed agent, then leaves it alone, then updates it for a new token", async () => {
  const h = home();
  mkdirSync(join(h, ".codex"));
  mkdirSync(join(h, ".gemini"));
  writeFileSync(join(h, ".gemini", "settings.json"), JSON.stringify({ theme: "dark", mcpServers: { other: { httpUrl: "https://x" } } }));
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ mcpServers: { craft: { type: "http", url: URL_ } } }));
  const ran = [];
  const runner = async (bin, args) => { ran.push([bin, ...args]); return { ok: true, out: "ok" }; };
  const claudeBin = join(h, "claude-bin");
  writeFileSync(claudeBin, "");
  const sync = (token) => syncAgents({ url: URL_, token, home: h, env, runner, extraBins: { claude: [claudeBin] } });

  const first = await sync("t1");
  assert.deepEqual(first.map((r) => [r.id, r.state]), [["claude", "updated"], ["codex", "added"], ["gemini", "added"]]);
  // Claude's old entry had no token: removed, then added with the header (after the name and URL).
  assert.deepEqual(ran, [
    [claudeBin, "mcp", "remove", "craft", "--scope", "user"],
    [claudeBin, "mcp", "add", "--transport", "http", "--scope", "user", "craft", URL_, "--header", "Authorization: Bearer t1"],
  ]);
  const gemini = JSON.parse(readFileSync(join(h, ".gemini", "settings.json"), "utf8"));
  assert.equal(gemini.theme, "dark");
  assert.deepEqual(gemini.mcpServers, { other: { httpUrl: "https://x" }, craft: { httpUrl: URL_, headers: { Authorization: "Bearer t1" } } });
  assert.deepEqual(codexRead(readFileSync(join(h, ".codex", "config.toml"), "utf8"), "craft"), { url: URL_, token: "t1" });

  // Claude writes its own file; pretend the CLI did.
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ mcpServers: { craft: { type: "http", url: URL_, headers: { Authorization: "Bearer t1" } } } }));
  ran.length = 0;
  assert.deepEqual((await sync("t1")).map((r) => r.state), ["ok", "ok", "ok"]);
  assert.equal(ran.length, 0, "nothing runs when every entry is right");

  assert.deepEqual((await sync("t2")).map((r) => r.state), ["updated", "updated", "updated"]);
});

test("agents that aren't installed or are turned off are skipped; a settings.json with comments is left alone", async () => {
  const h = home();
  mkdirSync(join(h, ".gemini"));
  writeFileSync(join(h, ".gemini", "settings.json"), '{ // mine\n "theme": "dark" }');
  const r = await syncAgents({ url: URL_, token: "t", home: h, env, enabled: ["codex", "gemini"], runner: async () => ({ ok: true }) });
  assert.deepEqual(r.map((x) => [x.id, x.state]), [["claude", "off"], ["codex", "missing"], ["gemini", "failed"]]);
  assert.match(readFileSync(join(h, ".gemini", "settings.json"), "utf8"), /\/\/ mine/);
});

test("with a token, the server answers only requests that carry it", async () => {
  let token = "right";
  let refreshed = 0;
  const bridge = new Bridge({ apps: () => [], open: () => {}, token: () => token, refreshToken: () => { refreshed++; } });
  const port = await bridge.listen(0);
  try {
    const call = (auth) => fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    assert.equal((await call()).status, 401);
    assert.equal((await call("Bearer wrong")).status, 401);
    assert.ok(refreshed > 0, "a wrong token makes the server read the token again");
    assert.equal((await call("Bearer right")).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/commands?window=x`)).status, 401);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
    assert.equal(health.auth, true);
    token = "next"; // another window made a new token
    assert.equal((await call("Bearer next")).status, 200);
  } finally {
    await bridge.close();
  }
});
