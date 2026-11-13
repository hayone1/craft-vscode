import assert from "node:assert/strict";
import { test } from "node:test";
import { Sessions, appAddress, mintSession } from "../src/embed.mjs";

test("an app's address from a template with {app}, or under a base", () => {
  assert.equal(appAddress("https://{app}.example.com/", "photocraft").href, "https://photocraft.example.com/");
  assert.equal(appAddress("https://craft.example.com", "filmcraft").href, "https://craft.example.com/filmcraft/");
  assert.equal(appAddress("https://craft.example.com/apps/", "lightcraft").href, "https://craft.example.com/apps/lightcraft/");
  assert.equal(appAddress("http://localhost:8080/{app}/", "effectcraft").href, "http://localhost:8080/effectcraft/");
  assert.equal(appAddress("  ", "photocraft"), null);
  assert.throws(() => appAddress("craft.example.com", "photocraft"), /isn't a URL/);
  assert.throws(() => appAddress("ftp://{app}.example.com", "photocraft"), /https:\/\/ or http:\/\//);
});

const later = () => Date.now() + 7 * 24 * 3600_000;
const relayAnswer = (app, body = {}) => ({
  tab: `wss://relay.example.com/k1/tab/${app}`, mcp: `https://relay.example.com/k1/${app}/mcp`, expires: later(), ...body,
});

test("minting asks the relay with the token and checks the answer", async () => {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push({ url, init });
    return new Response(JSON.stringify(relayAnswer("vectorcraft")), { status: 200 });
  };
  const s = await mintSession({ fetch, relay: "https://relay.example.com/", token: "t0ken-abcdefghijkl", app: "vectorcraft" });
  assert.equal(s.mcp, "https://relay.example.com/k1/vectorcraft/mcp");
  assert.equal(asked[0].url, "https://relay.example.com/mint?app=vectorcraft&hours=168");
  assert.equal(asked[0].init.method, "POST");
  assert.equal(asked[0].init.headers.authorization, "Bearer t0ken-abcdefghijkl");
});

test("minting explains a refusal, an odd answer and a relay that can't be reached", async () => {
  const answer = (status, body) => async () => new Response(body, { status });
  const args = { relay: "https://relay.example.com", token: "x".repeat(20), app: "photocraft" };
  await assert.rejects(mintSession({ ...args, fetch: answer(404, "") }), /refused to make a key for photocraft.*MINT_TOKENS/);
  await assert.rejects(mintSession({ ...args, fetch: answer(502, "") }), /answered 502/);
  await assert.rejects(mintSession({ ...args, fetch: answer(200, JSON.stringify(relayAnswer("filmcraft"))) }), /something other than a connection/);
  await assert.rejects(mintSession({ ...args, fetch: answer(200, JSON.stringify(relayAnswer("photocraft", { expires: Date.now() - 1 }))) }), /something other/);
  await assert.rejects(mintSession({ ...args, fetch: async () => { throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }); } }), /couldn't reach the relay.*ECONNREFUSED/);
});

test("a window keeps one connection per app until an hour before it ends", async () => {
  let made = 0;
  let expires = later();
  const sessions = new Sessions({ mint: async (app) => ({ ...relayAnswer(app), tab: `wss://r/k${++made}/tab/${app}`, expires }) });
  const [a, b] = await Promise.all([sessions.get("photocraft"), sessions.get("photocraft")]);
  assert.equal(made, 1);
  assert.equal(a, b);
  await sessions.get("photocraft");
  assert.equal(made, 1);
  await sessions.get("lightcraft");
  assert.equal(made, 2);
  expires = Date.now() + 10 * 60_000; // the next one ends soon
  sessions.clear();
  await sessions.get("photocraft");
  await sessions.get("photocraft");
  assert.equal(made, 4); // made again, since it ends within the hour
});

test("a failed mint isn't kept", async () => {
  let fail = true;
  const sessions = new Sessions({ mint: async (app) => { if (fail) throw new Error("down"); return relayAnswer(app); } });
  await assert.rejects(sessions.get("effectcraft"), /down/);
  fail = false;
  assert.equal((await sessions.get("effectcraft")).mcp, "https://relay.example.com/k1/effectcraft/mcp");
});
