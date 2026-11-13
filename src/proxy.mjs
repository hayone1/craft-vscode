// A local reverse proxy for apps at an address the browser can't use: an internal one
// (http://craft-app-photocraft.apps.svc:8080/, reachable only from the machine the editor's
// extensions run on), or plain http in an https editor. The extension serves the app on a local
// port, and the editor makes that port reachable from the browser (vscode.env.asExternalUri:
// localhost on the desktop, the remote's port forwarding otherwise, such as Coder's
// https://<port>--<agent>--<workspace>--<user>.<domain>). No vscode import, so the tests can run
// it in plain Node.
import { Agent as HttpAgent, ClientRequest, createServer } from "node:http";
import { Agent as HttpsAgent } from "node:https";

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"]);
// Asked by another window that wants the same port: which app address does this proxy serve?
export const PROBE = "/.craft-vscode-proxy";

// Requests to the upstream are built from ClientRequest and agents of our own, not http.request or
// https.request: VS Code replaces those in the extension host to apply the window's proxy settings,
// and the window answers that lookup. code-server keeps an extension host running after its
// browser tab has gone, and this proxy keeps its port, so its requests would wait forever.
// (An https upstream still goes through VS Code's tls.connect, which may load certificates once.)
// Idle connections close before a typical upstream's own 5 s idle timeout would reset them.
const AGENTS = { "http:": new HttpAgent({ keepAlive: true, timeout: 4000 }), "https:": new HttpsAgent({ keepAlive: true, timeout: 4000 }) };
const upstreamRequest = (target, options, onResponse) =>
  new ClientRequest(target, { ...options, agent: options.agent ?? AGENTS[target.protocol] }, onResponse);

/**
 * Whether an app address goes through the local proxy. "auto": plain http, which an https editor
 * can't frame and which is usually an internal address. "always" and "never" as they say.
 * @param {URL} url
 * @param {string} mode
 */
export function needsProxy(url, mode = "auto") {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return url.protocol === "http:";
}

/**
 * The app's page on the proxy's external address: the external origin, with the app address's
 * path and query (a proxy forwards paths as they are).
 * @param {string} external e.g. https://47820--main--dev--alice.code.example.org/
 * @param {URL} app
 */
export function framedAddress(external, app) {
  const base = new URL(external);
  const prefix = base.pathname.replace(/\/+$/, ""); // a path-based forwarder: /proxy/47820
  return new URL(`${prefix}${app.pathname}${app.search}`, base.origin);
}

export class AppProxy {
  /** @param {{upstream: URL, port: number, hosts?: string[]}} o */
  constructor({ upstream, port, hosts = ["127.0.0.1", "::1"] }) {
    this.upstream = new URL(upstream.origin);
    this.port = port;
    this.hosts = hosts;
    /** @type {import("node:http").Server[]} */
    this.servers = [];
    /** @type {Set<import("node:net").Socket>} upgraded connections, which the servers no longer track */
    this.tunnels = new Set();
  }

  /** Serves the port. Rejects with code EADDRINUSE when something else has it. */
  async listen() {
    const servers = [];
    for (const [i, host] of this.hosts.entries()) {
      const server = createServer((req, res) => this.forward(req, res));
      server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.port, host, () => { server.off("error", reject); resolve(); });
        });
        servers.push(server);
      } catch (e) {
        // The first address must work; the others (IPv6 loopback) are a bonus.
        if (i === 0) { for (const s of servers) s.close(); throw e; }
      }
    }
    this.servers = servers;
  }

  get listening() {
    return this.servers.some((s) => s.listening);
  }

  close() {
    for (const s of this.servers) { s.close(); s.closeAllConnections(); }
    for (const socket of this.tunnels) socket.destroy();
    this.servers = [];
  }

  target(req) {
    return new URL(req.url, this.upstream);
  }

  forward(req, res) {
    if (req.url === PROBE) {
      return res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ upstream: this.upstream.href }));
    }
    const target = this.target(req);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    headers.host = target.host;
    const up = upstreamRequest(target, { method: req.method, headers }, (r) => {
      const h = { ...r.headers };
      for (const k of HOP) delete h[k];
      // A redirect to the upstream's own address stays on this proxy.
      if (typeof h.location === "string" && h.location.startsWith(this.upstream.origin)) h.location = h.location.slice(this.upstream.origin.length) || "/";
      res.writeHead(r.statusCode ?? 502, h);
      r.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(`The app at ${this.upstream.origin} isn't reachable: ${e.message}`);
      else res.destroy();
    });
    // A browser that goes away ends the upstream request too (a long stream would hold it open).
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }

  upgrade(req, socket, head) {
    const target = this.target(req);
    const headers = { ...req.headers, host: target.host };
    // A connection that becomes a tunnel never goes back to a pool: one agent each.
    const agent = target.protocol === "https:" ? new HttpsAgent() : new HttpAgent();
    const up = upstreamRequest(target, { method: req.method, headers, agent });
    up.on("upgrade", (r, upSocket, upHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      // Either side ending ends both (a WebSocket the app or the server closed).
      for (const [a, b] of [[upSocket, socket], [socket, upSocket]]) {
        a.on("error", () => b.destroy());
        a.on("close", () => b.destroy());
      }
      this.tunnels.add(socket);
      socket.on("close", () => this.tunnels.delete(socket));
    });
    up.on("response", (r) => socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`));
    up.on("error", () => socket.destroy());
    up.end();
  }
}

/**
 * What serves `port` now, when something does: another window's proxy for `upstream`, something
 * else, or nothing.
 * @returns {Promise<"same" | "other" | "none">}
 */
export async function probe({ fetch, port, upstream, timeoutMs = 2000 }) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${PROBE}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return "other";
    const body = await r.json().catch(() => null);
    return body?.upstream === new URL(upstream.origin).href ? "same" : "other";
  } catch (e) {
    return e?.cause?.code === "ECONNREFUSED" ? "none" : "other";
  }
}
