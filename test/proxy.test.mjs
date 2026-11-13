import assert from "node:assert/strict";
import http, { createServer, request } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { AppProxy, PROBE, framedAddress, needsProxy, probe } from "../src/proxy.mjs";

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const freePort = async () => {
  const s = await listen(() => {});
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};
const call = (port, path, { method = "GET", body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const r = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  r.on("error", reject);
  r.end(body);
});

test("needsProxy: plain http in auto, or as the mode says", () => {
  assert.equal(needsProxy(new URL("http://craft-app-photocraft:8080/")), true);
  assert.equal(needsProxy(new URL("https://photocraft.example.com/")), false);
  assert.equal(needsProxy(new URL("https://photocraft.example.com/"), "always"), true);
  assert.equal(needsProxy(new URL("http://localhost:4101/"), "never"), false);
});

test("framedAddress keeps the app's path and query on the external origin", () => {
  const app = new URL("http://gw:8080/photocraft/?empty");
  assert.equal(framedAddress("https://47820--main--dev--alice.code.example.com/", app).href,
    "https://47820--main--dev--alice.code.example.com/photocraft/?empty");
  // A path-based forwarder (code-server's /proxy/<port>/).
  assert.equal(framedAddress("https://dev.example.com/proxy/47820/", app).href, "https://dev.example.com/proxy/47820/photocraft/?empty");
  assert.equal(framedAddress("http://localhost:47820/", new URL("http://x:1/")).href, "http://localhost:47820/");
});

test("AppProxy forwards requests, bodies and redirects to the upstream", async (t) => {
  const seen = [];
  const upstream = await listen((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, body: b });
      if (req.url === "/go") return res.writeHead(302, { location: `http://127.0.0.1:${upstream.address().port}/there` }).end();
      res.writeHead(200, { "content-type": "text/plain", "x-app": "yes" }).end(`got ${req.url}`);
    });
  });
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const up = new URL(`http://127.0.0.1:${upstream.address().port}/photocraft/`);
  const port = await freePort();
  const proxy = new AppProxy({ upstream: up, port, hosts: ["127.0.0.1"] });
  await proxy.listen();
  t.after(() => proxy.close());

  const r = await call(port, "/assets/a.js?v=1");
  assert.equal(r.status, 200);
  assert.equal(r.body, "got /assets/a.js?v=1");
  assert.equal(r.headers["x-app"], "yes");
  assert.equal(seen.at(-1).host, `127.0.0.1:${upstream.address().port}`);

  const post = await call(port, "/save", { method: "POST", body: "hello" });
  assert.equal(post.body, "got /save");
  assert.equal(seen.at(-1).body, "hello");

  const redirect = await call(port, "/go");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, "/there");

  const who = await call(port, PROBE);
  assert.deepEqual(JSON.parse(who.body), { upstream: `${up.origin}/` });
});

test("AppProxy doesn't use http.request, which VS Code replaces in the extension host", async (t) => {
  // VS Code's replacement asks the window for proxy settings; with the window gone it never
  // answers. Stand in for it with one that never sends anything.
  const upstream = await listen((req, res) => res.writeHead(200).end(`got ${req.url}`));
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const port = await freePort();
  const proxy = new AppProxy({ upstream: new URL(`http://127.0.0.1:${upstream.address().port}/`), port, hosts: ["127.0.0.1"] });
  await proxy.listen();
  t.after(() => proxy.close());
  const saved = [http.request, http.get, https.request, https.get];
  const never = () => { throw new Error("http.request was used"); };
  http.request = http.get = https.request = https.get = never;
  syncBuiltinESMExports();
  t.after(() => { [http.request, http.get, https.request, https.get] = saved; syncBuiltinESMExports(); });
  // fetch is undici, which doesn't go through http.request either.
  const r = await fetch(`http://127.0.0.1:${port}/a.js`, { signal: AbortSignal.timeout(5000) });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "got /a.js");
});

test("AppProxy answers 502 when the upstream is down", async (t) => {
  const dead = await freePort();
  const port = await freePort();
  const proxy = new AppProxy({ upstream: new URL(`http://127.0.0.1:${dead}/`), port, hosts: ["127.0.0.1"] });
  await proxy.listen();
  t.after(() => proxy.close());
  const r = await call(port, "/");
  assert.equal(r.status, 502);
  assert.match(r.body, /isn't reachable/);
});

test("AppProxy passes WebSocket upgrades through", async (t) => {
  const upstream = createServer();
  upstream.on("upgrade", (req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(`echo ${d}`));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const port = await freePort();
  const proxy = new AppProxy({ upstream: new URL(`http://127.0.0.1:${upstream.address().port}/`), port, hosts: ["127.0.0.1"] });
  await proxy.listen();
  t.after(() => proxy.close());
  const reply = await new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path: "/ws", headers: { connection: "Upgrade", upgrade: "websocket" } });
    r.on("upgrade", (res, socket) => {
      socket.once("data", (d) => { socket.destroy(); resolve(`${res.statusCode} ${d}`); });
      socket.write("ping");
    });
    r.on("error", reject);
    r.end();
  });
  assert.equal(reply, "101 echo ping");
});

test("a second proxy on a taken port fails with EADDRINUSE, and probe tells whose it is", async (t) => {
  const port = await freePort();
  const up = new URL("http://127.0.0.1:1/");
  const first = new AppProxy({ upstream: up, port, hosts: ["127.0.0.1"] });
  await first.listen();
  t.after(() => first.close());
  const second = new AppProxy({ upstream: up, port, hosts: ["127.0.0.1"] });
  await assert.rejects(second.listen(), (e) => e.code === "EADDRINUSE");
  assert.equal(await probe({ fetch, port, upstream: up }), "same");
  assert.equal(await probe({ fetch, port, upstream: new URL("http://127.0.0.1:2/") }), "other");
  first.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await probe({ fetch, port, upstream: up }), "none");
  // The port is free again: the second proxy can take it over.
  await second.listen();
  t.after(() => second.close());
  assert.equal(second.listening, true);
});

test("probe calls something that isn't a proxy 'other'", async (t) => {
  const other = await listen((req, res) => res.writeHead(404).end());
  t.after(() => { other.close(); other.closeAllConnections(); });
  assert.equal(await probe({ fetch, port: other.address().port, upstream: new URL("http://x:1/") }), "other");
});
