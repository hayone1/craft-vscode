// Where each app is, and the relay connection a panel hands to its app page. No vscode import, so
// the tests can run it in plain Node.
//
// The panel frames the app's own address: the hayone/<app>:remote image, or anything that serves
// it (a proxy, craft-web-gateway's /<app>/). The page answers the panel's hello itself
// (craft-embed.js in the image). It needs a relay connection for the agent: the panel makes one
// with the relay's mint token (craft.relayUrl and CRAFT_RELAY_TOKEN), else the page asks its own
// server (_assistant/session, which the proxy in front of the apps forwards to craft-mcp).

/**
 * The app's address. A `{app}` in the template stands for the app's name:
 * `https://{app}.example.com/`. A template without it is a base that serves every app under
 * `/<app>/`: `https://craft.example.com` gives `https://craft.example.com/photocraft/`.
 * @param {string} template
 * @param {string} app
 */
export function appAddress(template, app) {
  const t = String(template ?? "").trim();
  if (!t) return null;
  const text = t.includes("{app}") ? t.replaceAll("{app}", app) : `${t.replace(/\/+$/, "")}/${app}/`;
  let url;
  try { url = new URL(text); } catch { throw new Error(`The apps' address isn't a URL: ${t}`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`The apps' address must start with https:// or http://: ${t}`);
  return url;
}

const SESSION_HOURS = 168;

/**
 * A new relay connection for `app` from craft-mcp's POST /mint, with a token from its MINT_TOKENS.
 * @returns {Promise<{tab: string, mcp: string, expires: number}>}
 */
export async function mintSession({ fetch, relay, token, app, hours = SESSION_HOURS, timeoutMs = 10_000 }) {
  const base = String(relay).replace(/\/+$/, "");
  let r;
  try {
    r = await fetch(`${base}/mint?app=${encodeURIComponent(app)}&hours=${hours}`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`couldn't reach the relay at ${base}: ${e?.cause?.message ?? e?.message ?? e}`);
  }
  // craft-mcp answers 404 for a token it doesn't know, an app it doesn't bridge, or no PUBLIC_HOST.
  if (r.status === 404) throw new Error(`the relay at ${base} refused to make a key for ${app}: check the relay token against craft-mcp's MINT_TOKENS, and that craft-mcp has PUBLIC_HOST`);
  if (!r.ok) throw new Error(`the relay at ${base} answered ${r.status}`);
  const s = await r.json().catch(() => null);
  const valid = s && typeof s.tab === "string" && /^wss?:\/\//.test(s.tab) && s.tab.endsWith(`/tab/${app}`)
    && typeof s.mcp === "string" && /^https?:\/\//.test(s.mcp) && s.mcp.endsWith(`/${app}/mcp`)
    && Number(s.expires) > Date.now();
  if (!valid) throw new Error(`the relay at ${base} answered something other than a connection`);
  return { tab: s.tab, mcp: s.mcp, expires: Number(s.expires) };
}

/**
 * This window's relay connection per app: one per window, so two windows with the same app don't
 * take each other's tab over at the relay. A connection is made again an hour before it ends.
 */
export class Sessions {
  /** @param {{mint: (app: string) => Promise<{tab: string, mcp: string, expires: number}>, marginMs?: number}} o */
  constructor({ mint, marginMs = 3600_000 }) {
    this.mint = mint;
    this.marginMs = marginMs;
    /** @type {Map<string, {tab: string, mcp: string, expires: number}>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<any>>} */
    this.pending = new Map();
  }

  async get(app) {
    const s = this.cache.get(app);
    if (s && s.expires - Date.now() > this.marginMs) return s;
    if (this.pending.has(app)) return this.pending.get(app);
    const p = this.mint(app).then((fresh) => {
      this.cache.set(app, fresh);
      return fresh;
    }).finally(() => this.pending.delete(app));
    this.pending.set(app, p);
    return p;
  }

  clear() {
    this.cache.clear();
  }
}
