// Craft apps in VS Code: each app opens in an editor panel (the app's own page, from the
// hayone/<app>:remote images, in a webview's iframe), and one local MCP server (bridge.mjs) lets
// Claude Code, or any MCP client in this workspace, drive the apps that are open.
//
// The panel learns its tab's MCP URL from the app page (craft-embed.js in the images; the page's
// server lists the editor's origin in EMBED_ORIGINS): the webview says "craft-embed:hello" to the
// framed page, with a relay connection when this window made one (embed.mjs), and the page
// answers "craft-embed:session". The hello also lends the workspace's files to the page
// (files.mjs): the page asks with "craft-embed:files", the webview passes each request here and
// the answer back.
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { fetch as httpFetch } from "undici";
import { AGENTS, syncAgents } from "./agents.mjs";
import { Bridge } from "./bridge.mjs";
import { Sessions, appAddress, mintSession } from "./embed.mjs";
import { realWhere, workspaceFiles } from "./files.mjs";
import { resolveToken, rotateToken, tokenFile } from "./token.mjs";

const CATALOG = {
  photocraft: "PhotoCraft", vectorcraft: "VectorCraft", lightcraft: "LightCraft", filmcraft: "FilmCraft",
  effectcraft: "EffectCraft", designcraft: "DesignCraft", pdfcraft: "PDFCraft", figcraft: "FigCraft",
  gridcraft: "GridCraft", cadcraft: "CADCraft", deckcraft: "DeckCraft", soundcraft: "SoundCraft", wordcraft: "WordCraft",
};
const VIEW_TYPE = "craft.app";
const SERVER = "craft";

const settings = () => vscode.workspace.getConfiguration("craft");
// Where the apps are: https://{app}.example.com/, or a base that serves each app under /<app>/.
// craft.hubUrl and CRAFT_HUB_URL are the names from before 0.5, when the apps came from
// craft-web-gateway; such an address still works as a base.
const appTemplate = () => String(settings().get("appUrl") || process.env.CRAFT_APP_URL
  || settings().get("hubUrl") || process.env.CRAFT_HUB_URL || "").trim();
const appUrl = (app) => appAddress(appTemplate(), app);
// craft-mcp's public address and a token from its MINT_TOKENS: the panel makes its tab's relay
// connection itself. Without them, the app page asks its own server for one.
const relayUrl = () => String(settings().get("relayUrl") || process.env.CRAFT_RELAY_URL || "").trim().replace(/\/+$/, "");
const RELAY_SECRET = "craft.relayToken";
let secrets;
const relayToken = async () => String(process.env.CRAFT_RELAY_TOKEN || (await secrets?.get(RELAY_SECRET).then(undefined, () => "")) || "").trim();
const DEFAULT_APPS = ["photocraft", "vectorcraft", "lightcraft", "filmcraft", "effectcraft"];
const apps = () => {
  const names = settings().get("apps");
  const env = (process.env.CRAFT_APPS ?? "").split(",").filter((n) => n.trim());
  const list = Array.isArray(names) && names.length ? names : env.length ? env : DEFAULT_APPS;
  return list.map((n) => String(n).trim().toLowerCase()).filter((n) => /^[a-z0-9-]+$/.test(n))
    .map((name) => ({ name, title: CATALOG[name] ?? name[0].toUpperCase() + name.slice(1) }));
};
const titleOf = (app) => apps().find((a) => a.name === app)?.title ?? CATALOG[app] ?? app;

let log;
/** @type {Map<string, vscode.WebviewPanel>} */
const panels = new Map();
/** @type {Map<string, {mcp: string, state: string, title: string}>} this window's tabs */
const local = new Map();
let bridge;
let follower; // set when another window serves the MCP port
let changed;
let definitionsChanged; // VS Code's own MCP list: the token changed
let terminalEnv;

// ---- the MCP token: CRAFT_MCP_TOKEN, else ~/.craft-vscode/mcp-token (made on first start) ----
let auth;
function loadToken() {
  const before = auth?.token;
  try {
    auth = resolveToken();
    if (before && before !== auth.token) definitionsChanged?.fire();
  } catch (e) {
    // A home folder we can't write: keep a token for this window only.
    auth ??= { token: randomBytes(32).toString("base64url"), source: "memory" };
    log?.warn(`MCP token: couldn't use ${tokenFile()}: ${e.message}`);
  }
  terminalEnv?.replace("CRAFT_MCP_TOKEN", auth.token);
  return auth.token;
}
const token = () => auth?.token ?? loadToken();
const authHeader = () => ({ authorization: `Bearer ${token()}` });

export async function activate(context) {
  log = vscode.window.createOutputChannel("Craft apps", { log: true });
  secrets = context.secrets;
  changed = new vscode.EventEmitter();
  definitionsChanged = new vscode.EventEmitter();
  context.subscriptions.push(log, changed, definitionsChanged);
  // Terminals get the URL and token, so a script or an agent started there can reach the server.
  terminalEnv = context.environmentVariableCollection;
  terminalEnv.description = "The Craft apps MCP server (CRAFT_MCP_URL, CRAFT_MCP_TOKEN)";
  terminalEnv.persistent = false; // set again at each start; keeps the token out of VS Code's saved state
  loadToken();
  terminalEnv.replace("CRAFT_MCP_URL", mcpUrl());

  const tree = { onDidChangeTreeData: changed.event, getTreeItem: (a) => item(a), getChildren: () => apps() };
  // The apps list: in the Craft side bar and as a section of the Explorer. A file dragged from the
  // explorer onto an app opens in that app. (VS Code doesn't let a drag from inside the editor
  // reach a webview panel, so the list is where such drops land.)
  const dropOnApp = {
    dropMimeTypes: ["text/uri-list"],
    dragMimeTypes: [],
    handleDrop: async (target, data) => {
      const text = await data.get("text/uri-list")?.asString();
      const uris = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const app = target?.name ?? (await pick());
      if (app && uris.length) await openFilesIn(app, uris);
    },
  };
  for (const id of ["craft.apps", "craft.appsExplorer"]) {
    context.subscriptions.push(vscode.window.createTreeView(id, { treeDataProvider: tree, dragAndDropController: dropOnApp }));
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "craft.open";
  context.subscriptions.push(status, changed.event(() => {
    const on = [...local.values()].filter((t) => t.state === "on").length;
    status.text = `$(sparkle) Craft${local.size ? ` ${on}/${local.size}` : ""}`;
    status.tooltip = follower ? "Craft apps (MCP served by another window)" : `Craft apps: MCP at ${mcpUrl()}`;
  }));
  status.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("craft.open", async (arg) => {
      const app = typeof arg === "string" ? arg : arg?.name ?? (await pick());
      if (app) await open(app, false);
    }),
    vscode.commands.registerCommand("craft.reload", () => active()?.webview.postMessage({ type: "reload" })),
    vscode.commands.registerCommand("craft.signIn", () => signIn(activeApp())),
    vscode.commands.registerCommand("craft.copyMcpUrl", async () => {
      await vscode.env.clipboard.writeText(mcpUrl());
      vscode.window.showInformationMessage(`Copied ${mcpUrl()}`);
    }),
    vscode.commands.registerCommand("craft.copyMcpToken", async () => {
      await vscode.env.clipboard.writeText(token());
      vscode.window.showInformationMessage("Copied the MCP token. Send it as the header \"Authorization: Bearer <token>\".");
    }),
    vscode.commands.registerCommand("craft.newMcpToken", newToken),
    vscode.commands.registerCommand("craft.setMcpUrl", setMcpUrl),
    vscode.commands.registerCommand("craft.setRelayToken", setRelayToken),
    // Explorer › right-click › Open in a Craft App (one file or the selection).
    vscode.commands.registerCommand("craft.openInApp", async (uri, selected) => {
      const list = (Array.isArray(selected) && selected.length ? selected : uri ? [uri] : []).map((u) => u.toString());
      if (!list.length) return;
      const app = await pick();
      if (app) await openFilesIn(app, list);
    }),
    vscode.commands.registerCommand("craft.registerAgents", () => registerAgents({ asked: true })),
    // The 0.1 name of the command above.
    vscode.commands.registerCommand("craft.registerClaudeCode", () => registerAgents({ asked: true })),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        const app = state?.app;
        if (typeof app === "string" && appTemplate()) await setup(panel, app);
        else panel.dispose();
      },
    }),
  );

  await serve(context);
  if (vscode.lm?.registerMcpServerDefinitionProvider && vscode.McpHttpServerDefinition) {
    context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider("craft.mcp", {
      onDidChangeMcpServerDefinitions: definitionsChanged.event,
      provideMcpServerDefinitions: () => [new vscode.McpHttpServerDefinition("Craft apps", vscode.Uri.parse(mcpUrl()), { Authorization: `Bearer ${token()}` })],
    }));
  }
  watchAgents(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("craft.workspaceFiles") && lendAgain()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("craft.relayUrl") && sessions.clear()),
    vscode.workspace.onDidGrantWorkspaceTrust(lendAgain),
    vscode.workspace.onDidChangeWorkspaceFolders(lendAgain),
  );
  changed.fire();
}

export async function deactivate() {
  clearInterval(follower?.timer);
  await bridge?.close();
}

// ---- the MCP server --------------------------------------------------------------------------
const port = () => Number(settings().get("mcpPort")) || 47811;
const mcpUrl = () => `http://127.0.0.1:${port()}/mcp`;

// code-server keeps a window's extension host running for hours after its browser tab is gone,
// so the window that holds the port may be one nobody sees. Every window says when it was last
// focused, and an agent's "open this app" goes to the window that has the app, else to the one
// focused last.
let focusedAt = 0;

async function serve(context) {
  if (vscode.window.state.focused) focusedAt = Date.now();
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => {
    if (!s.focused) return;
    focusedAt = Date.now();
    if (follower) report();
  }));
  bridge = new Bridge({ apps, open: route, token, refreshToken: loadToken, log: (s) => log.info(s), focusedAt: () => focusedAt, workspace: agentFiles });
  context.subscriptions.push({ dispose: () => bridge.close() });
  try {
    await bridge.listen(port());
    log.info(`MCP server at ${mcpUrl()}`);
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    const peer = await httpFetch(`http://127.0.0.1:${port()}/healthz`).then((r) => r.json()).catch(() => null);
    if (!peer?.craft) {
      vscode.window.showErrorMessage(`Craft apps: port ${port()} is in use, so agents can't reach the apps. Pick another in the craft.mcpPort setting.`);
      return;
    }
    // Another window serves MCP: report this window's panels to it, take its commands, and take
    // over if it goes away.
    follower = { id: randomBytes(8).toString("hex") };
    follower.timer = setInterval(report, 15_000);
    log.info(`MCP is served by another window at ${mcpUrl()}; reporting to it`);
    await report();
    poll(follower);
  }
}

// An agent asked for an app: open it where the user is.
async function route(app) {
  if (panels.has(app)) return open(app, true);
  const others = bridge.windows();
  const target = others.find((w) => w.apps.includes(app))
    ?? others.filter((w) => w.focusedAt > focusedAt).sort((a, b) => b.focusedAt - a.focusedAt)[0];
  if (target && bridge.send(target.id, { type: "open", app })) return;
  return open(app, true);
}

async function report() {
  if (!follower) return;
  const status = await httpFetch(`http://127.0.0.1:${port()}/tabs`, {
    method: "POST", headers: { "content-type": "application/json", ...authHeader() },
    body: JSON.stringify({ window: follower.id, focusedAt, tabs: Object.fromEntries(local) }),
  }).then((r) => r.status, () => 0);
  if (status >= 200 && status < 300) return;
  // Another window made a new token: read it again, and report again on the next round.
  if (status === 401) return void loadToken();
  try {
    await bridge.listen(port());
    clearInterval(follower.timer);
    follower = undefined;
    log.info(`MCP server at ${mcpUrl()} (took over)`);
    for (const [app, tab] of local) bridge.update(app, tab);
    changed.fire();
    registerAgents({});
  } catch {}
}

// A follower's commands from the window that holds the port.
async function poll(me) {
  while (follower === me) {
    const commands = await httpFetch(`http://127.0.0.1:${port()}/commands?window=${me.id}`, { headers: authHeader() })
      // Not answered (a new token, or the server doesn't know this window yet): wait, then ask again.
      .then((r) => (r.ok ? r.json() : (r.status === 401 && loadToken(), null)), () => null);
    if (commands === null) await new Promise((r) => setTimeout(r, 5000));
    for (const c of commands ?? []) if (c?.type === "open" && typeof c.app === "string") open(c.app, true);
  }
}

function tabChanged(app, tab) {
  if (tab) local.set(app, tab);
  else local.delete(app);
  if (follower) report();
  else if (tab) bridge.update(app, tab);
  else bridge.remove(app);
  changed.fire();
}

// ---- coding agents (agents.mjs) ---------------------------------------------------------------
// The window that serves the port keeps each agent's "craft" entry up to date: at start, every
// few minutes and after a terminal command (an agent installed later is picked up), and when the
// settings or the token change. Entries that are already right are left alone.
const enabledAgents = () => {
  const list = settings().get("agents");
  const ids = Array.isArray(list) ? list.map(String) : AGENTS.map((a) => a.id);
  return settings().get("registerWithClaudeCode", true) ? ids : ids.filter((id) => id !== "claude");
};
// The Claude Code extension ships its own CLI, so Claude can be set up without one on PATH.
const bundledClaude = () => {
  const dir = vscode.extensions.getExtension("anthropic.claude-code")?.extensionPath;
  return dir ? [join(dir, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude")] : [];
};

let syncing = null;
const warned = new Set();
async function registerAgents({ asked = false, anyWindow = asked }) {
  if (follower && !anyWindow) return; // the window that serves the port does this
  if (!follower && !bridge?.http?.listening) return; // the port belongs to something else
  if (syncing) await syncing.catch(() => {});
  loadToken(); // another window may have made a new token
  syncing = syncAgents({ url: mcpUrl(), token: token(), name: SERVER, enabled: enabledAgents(), extraBins: { claude: bundledClaude() } });
  let results;
  try { results = await syncing; } finally { syncing = null; }
  for (const r of results) {
    if (r.state === "added" || r.state === "updated") {
      log.info(`${r.label}: ${r.state} the ${SERVER} MCP server (${r.detail})`);
      vscode.window.showInformationMessage(`Craft apps: ${r.label} now has the ${SERVER} MCP server. Start a new ${r.label} session to use it.`);
    } else if (r.state === "failed") {
      log.warn(`${r.label}: ${r.detail}`);
      if (asked || !warned.has(r.id)) vscode.window.showWarningMessage(`Craft apps: couldn't add the MCP server to ${r.label}: ${r.detail}`);
      warned.add(r.id);
    }
  }
  if (asked) {
    const word = { ok: "set up", added: "added", updated: "updated", failed: "failed", missing: "not installed", off: "turned off in craft.agents" };
    vscode.window.showInformationMessage(`Craft apps MCP server: ${results.map((r) => `${r.label} ${word[r.state]}`).join(", ")}.`);
  }
}

function watchAgents(context) {
  let timer;
  const soon = (ms = 3000) => { clearTimeout(timer); timer = setTimeout(() => registerAgents({}), ms); };
  const every = setInterval(() => registerAgents({}), 5 * 60_000);
  context.subscriptions.push({ dispose: () => { clearTimeout(timer); clearInterval(every); } });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("craft.agents") || e.affectsConfiguration("craft.registerWithClaudeCode")) soon(500);
  }));
  // npm i -g @openai/codex, curl … | sh, and the like: look again once a terminal command ends.
  if (vscode.window.onDidEndTerminalShellExecution) context.subscriptions.push(vscode.window.onDidEndTerminalShellExecution(() => soon()));
  context.subscriptions.push(vscode.window.onDidCloseTerminal(() => soon()));
  registerAgents({});
}

async function newToken() {
  if (auth?.source === "env") {
    vscode.window.showInformationMessage("Craft apps: the MCP token comes from CRAFT_MCP_TOKEN. Change it there and restart the editor.");
    return;
  }
  try {
    auth = rotateToken();
  } catch (e) {
    vscode.window.showErrorMessage(`Craft apps: couldn't save a new token in ${tokenFile()}: ${e.message}`);
    return;
  }
  terminalEnv.replace("CRAFT_MCP_TOKEN", auth.token);
  definitionsChanged.fire();
  await registerAgents({ anyWindow: true });
  vscode.window.showInformationMessage("Craft apps: made a new MCP token and gave it to the coding agents. Restart agent sessions that are running now.");
}

// ---- panels -------------------------------------------------------------------------------
async function pick() {
  const choice = await vscode.window.showQuickPick(apps().map((a) => ({
    label: a.title, description: local.get(a.name)?.state === "on" ? "connected" : panels.has(a.name) ? "open" : "", app: a.name,
  })), { placeHolder: "Open a craft app" });
  return choice?.app;
}

async function open(app, fromAgent) {
  if (!appTemplate()) {
    const url = await vscode.window.showInputBox({
      prompt: "Where the craft apps are: an address with {app} for the app's name, or one that serves every app under /<app>/",
      placeHolder: "https://{app}.example.com/", ignoreFocusOut: true,
      validateInput: (v) => { try { appAddress(v, "photocraft"); return null; } catch (e) { return e.message; } },
    });
    if (!url) return;
    await settings().update("appUrl", url.trim(), vscode.ConfigurationTarget.Global);
  }
  const existing = panels.get(app);
  if (existing) return existing.reveal(undefined, fromAgent);
  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, titleOf(app), { viewColumn: vscode.ViewColumn.Active, preserveFocus: fromAgent }, {
    enableScripts: true, retainContextWhenHidden: true,
  });
  await setup(panel, app);
}

async function setup(panel, app) {
  panels.get(app)?.dispose();
  panels.set(app, panel);
  panel.title = titleOf(app);
  panel.iconPath = vscode.Uri.joinPath(vscode.extensions.getExtension("hayone1.craft-vscode").extensionUri, "media", "app.svg");
  panel.webview.options = { enableScripts: true };
  panel.onDidDispose(() => {
    if (panels.get(app) !== panel) return;
    panels.delete(app);
    tabChanged(app, null);
  });
  const show = async () => {
    try {
      const session = await relaySession(app);
      panel.webview.html = page(app, session);
    } catch (e) {
      panel.webview.html = problem(app, e.message);
    }
  };
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m?.type === "craft-embed:files") {
      const reply = await files(unpackBytes(m));
      if (!reply.ok) log.warn(`${app}: ${m.op} ${typeof m.path === "string" ? m.path : ""}: ${reply.error}`);
      try { await panel.webview.postMessage(packBytes(reply)); } catch {} // the panel closed meanwhile
      return;
    }
    if (m?.type === "craft-embed:session") {
      flushFiles(app, panel);
      const tab = typeof m.mcp === "string" && /^https:\/\/|^http:\/\//.test(m.mcp)
        ? { mcp: m.mcp, state: String(m.state ?? "off"), title: String(m.title ?? titleOf(app)) } : null;
      log.info(`${app}: ${m.state}${tab ? "" : " (no connection)"}${typeof m.error === "string" ? `: ${m.error}` : ""}`);
      tabChanged(app, tab);
    } else if (m?.type === "craft-embed:refused") {
      log.warn(`${app}: the app page doesn't take this editor; add ${String(m.origin)} to EMBED_ORIGINS on the app's server`);
    } else if (m?.type === "signin") signIn(app);
    else if (m?.type === "reload") await show();
  });
  await show();
}

// This window's relay connection for the app, when craft.relayUrl and a relay token are set.
const sessions = new Sessions({
  mint: async (app) => mintSession({ fetch: httpFetch, relay: relayUrl(), token: await relayToken(), app }),
});
const relayWarned = new Set();
async function relaySession(app) {
  if (!relayUrl() || !(await relayToken())) return null;
  try {
    return await sessions.get(app);
  } catch (e) {
    log.warn(`${app}: no relay connection from ${relayUrl()}: ${e.message}`);
    if (!relayWarned.has(e.message)) vscode.window.showWarningMessage(`Craft apps: ${e.message}. The app page will ask its own server instead.`);
    relayWarned.add(e.message);
    return null;
  }
}

async function setRelayToken() {
  if (process.env.CRAFT_RELAY_TOKEN) {
    vscode.window.showInformationMessage("Craft apps: the relay token comes from CRAFT_RELAY_TOKEN. Change it there and restart the editor.");
    return;
  }
  const value = await vscode.window.showInputBox({
    prompt: "A relay token: one of craft-mcp's MINT_TOKENS. Leave it empty to remove the saved token.", password: true, ignoreFocusOut: true,
  });
  if (value === undefined) return;
  if (value.trim()) await secrets.store(RELAY_SECRET, value.trim());
  else await secrets.delete(RELAY_SECRET);
  sessions.clear();
  relayWarned.clear();
  if (value.trim() && !relayUrl()) vscode.window.showInformationMessage("Craft apps: saved. Set craft.relayUrl to craft-mcp's address too.");
}

const active = () => [...panels.values()].find((p) => p.active);
const activeApp = () => [...panels.entries()].find(([, p]) => p.active)?.[0];

async function signIn(app) {
  let url;
  try { url = appUrl(app ?? apps()[0]?.name ?? "photocraft"); } catch { return; }
  if (!url) return;
  await vscode.env.openExternal(vscode.Uri.parse(url.href));
  const reload = await vscode.window.showInformationMessage("Sign in to the app in the browser tab that opened, then come back and reload the app.", "Reload");
  if (reload) for (const p of panels.values()) p.webview.postMessage({ type: "reload" });
}

// For an app page that can't answer the panel: paste the URL from the app's AI assistant panel.
async function setMcpUrl() {
  const app = activeApp() ?? (await pick());
  if (!app) return;
  const url = await vscode.window.showInputBox({
    prompt: `${titleOf(app)}'s MCP URL, from the app's AI assistant panel (open the app in a browser tab)`, ignoreFocusOut: true,
    validateInput: (v) => (/^https?:\/\/.+\/mcp$/.test(v.trim()) ? null : "A URL that ends in /mcp"),
  });
  if (url) tabChanged(app, { mcp: url.trim(), state: "on", title: titleOf(app) });
}

function item(a) {
  const tab = local.get(a.name);
  const t = new vscode.TreeItem(a.title);
  t.id = a.name;
  t.description = tab ? (tab.state === "on" ? "connected" : tab.state) : panels.has(a.name) ? "open" : "";
  t.iconPath = new vscode.ThemeIcon(tab?.state === "on" ? "pass-filled" : panels.has(a.name) ? "circle-large-outline" : "symbol-color");
  t.command = { command: "craft.open", title: "Open", arguments: [a.name] };
  t.tooltip = `Open ${a.title}`;
  return t;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The app's address can't be used: say so in the panel.
function problem(app, message) {
  const nonce = randomBytes(16).toString("base64");
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">body { margin: 24px; color: #ddd; background: #1c1c1c; font: 13px/1.5 var(--vscode-font-family, system-ui); }</style></head>
<body><p>${esc(titleOf(app))} can't open: ${esc(message)}</p>
<p>Set <code>craft.appUrl</code> (or <code>CRAFT_APP_URL</code>) to where the apps are, for example <code>https://{app}.example.com/</code>.</p></body></html>`;
}

function page(app, session) {
  const src = appUrl(app);
  const lend = lending();
  const nonce = randomBytes(16).toString("base64");
  const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${esc(src.origin)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #1c1c1c; }
  iframe { display: block; border: 0; width: 100%; height: 100%; }
  #note { position: absolute; left: 12px; right: 12px; bottom: 12px; padding: 10px 12px; border-radius: 8px; background: #252526ee;
    color: #ddd; font: 13px/1.4 var(--vscode-font-family, system-ui); border: 1px solid #3c3c3c; display: flex; gap: 10px; align-items: center; }
  #note[hidden] { display: none; }
  #note span { flex: 1; }
  button { font: inherit; padding: 4px 10px; border-radius: 4px; border: 1px solid #3c3c3c; background: #0e639c; color: #fff; cursor: pointer; }
  button.plain { background: transparent; color: #ccc; }
</style></head>
<body>
<iframe id="app" src="${esc(src.href)}" allow="clipboard-read; clipboard-write; fullscreen; autoplay; microphone; camera; display-capture"></iframe>
<div id="note" hidden><span id="text"></span>
  <button id="signin">Sign in</button><button id="reload" class="plain">Reload</button><button id="hide" class="plain">Hide</button></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  vscode.setState({ app: ${json(app)} });
  const APP = ${json(src.origin)};
  const TITLE = ${json(titleOf(app))};
  const frame = document.getElementById("app");
  const note = document.getElementById("note");
  const text = document.getElementById("text");
  let heard = false, loop, waited = 0;
  let FILES = ${json(lend)};
  // This window's relay connection for the page, or null: the page then asks its own server.
  const SESSION = ${json(session ?? null)};
  let appFiles = true; // the app's server can turn the lending off (EMBED_FILES=false)
  const say = (s) => { text.textContent = s; note.hidden = false; };
  // File bytes cross to the extension as base64: some hosts (code-server) send messages as JSON,
  // which would turn bytes into long lists of numbers or a Node Buffer's JSON form.
  const pack = (v) => {
    if (v instanceof ArrayBuffer) v = new Uint8Array(v);
    if (ArrayBuffer.isView(v)) {
      const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return { __b64: btoa(s) };
    }
    if (Array.isArray(v)) return v.map(pack);
    if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = pack(v[k]); return o; }
    return v;
  };
  const unpack = (v) => {
    if (v && typeof v === "object" && typeof v.__b64 === "string") {
      const s = atob(v.__b64), b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      return b;
    }
    if (Array.isArray(v)) return v.map(unpack);
    if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = unpack(v[k]); return o; }
    return v;
  };
  const hello = () => frame.contentWindow && frame.contentWindow.postMessage({ type: "craft-embed:hello", files: FILES, session: SESSION }, APP);
  let answers = ""; // the name the page answers with
  frame.addEventListener("load", () => {
    heard = false; waited = 0; answers = ""; clearInterval(loop); hello();
    loop = setInterval(() => {
      if (heard) return clearInterval(loop);
      hello();
      if (++waited === 25) {
        say("No word from " + TITLE + " yet. If the app asks you to sign in and the page stays blank, sign in in a browser tab. "
          + "If the app shows but this stays, the app needs the remote image (hayone/<app>:remote) from November 2026 or later.");
      }
    }, 1000);
  });
  window.addEventListener("message", (e) => {
    if (e.source === frame.contentWindow) {
      if (e.origin !== APP || !e.data) return;
      if (e.data.type === "craft-embed:files" && FILES && appFiles) return vscode.postMessage(pack(e.data));
      if (e.data.type === "craft-embed:refused") {
        heard = true;
        say(TITLE + " doesn't take files or the agent from this editor. Add " + e.data.origin + " to EMBED_ORIGINS on the app's server, then reload.");
        return vscode.postMessage({ type: e.data.type, origin: String(e.data.origin) });
      }
      // "craft-hub:session" is the same answer from a page behind craft-web-gateway before
      // November 2026, whose overlay answered the editor. Newer pages send both names.
      if (e.data.type === "craft-embed:session") answers = "craft-embed:session";
      else if (e.data.type !== "craft-hub:session" || answers === "craft-embed:session") return;
      heard = true;
      if (e.data.mcp) note.hidden = true;
      else if (e.data.error) say(e.data.error + ". Give the editor a relay (craft.relayUrl and a relay token), or have the app's server forward _assistant/session to craft-mcp.");
      appFiles = e.data.files !== false;
      vscode.postMessage({ ...e.data, type: "craft-embed:session" });
    } else if (e.data && e.data.type === "craft-embed:files-reply") {
      frame.contentWindow && frame.contentWindow.postMessage(unpack(e.data), APP);
    } else if (e.data && e.data.type === "craft-embed:open-files") {
      frame.contentWindow && frame.contentWindow.postMessage(unpack(e.data), APP);
    } else if (e.data && e.data.type === "craft-embed:lend") {
      FILES = e.data.files; hello();
    } else if (e.data && e.data.type === "reload") {
      vscode.postMessage({ type: "reload" });
    }
  });
  document.getElementById("signin").onclick = () => vscode.postMessage({ type: "signin" });
  document.getElementById("reload").onclick = () => vscode.postMessage({ type: "reload" });
  document.getElementById("hide").onclick = () => { note.hidden = true; };
</script>
</body></html>`;
}

// ---- files handed to an app (a drop on the apps list, or Open in a Craft App) -------------------
/** @type {Map<string, object[]>} files waiting for their app's page to be ready */
const waiting = new Map();
async function openFilesIn(app, uris) {
  const reply = await files({ op: "drop", uris });
  if (!reply.ok) return vscode.window.showErrorMessage(`Craft apps: ${reply.error}`);
  const list = reply.value.files;
  if (!list.length) return vscode.window.showInformationMessage("Craft apps: only files can be opened in an app, not folders.");
  waiting.set(app, [...(waiting.get(app) ?? []), ...list]);
  const ready = panels.has(app) && local.get(app)?.state === "on";
  await open(app, false);
  if (ready) flushFiles(app, panels.get(app));
}
function flushFiles(app, panel) {
  const list = waiting.get(app);
  if (!list?.length || !panel) return;
  waiting.delete(app);
  panel.webview.postMessage(packBytes({ type: "craft-embed:open-files", files: list })).then(undefined, () => {});
}

// ---- workspace files for the app pages (files.mjs) --------------------------------------------
// The webview and the extension swap file bytes as {__b64} (see pack/unpack in the page): some
// hosts send webview messages as JSON, where bytes would arrive as a Node Buffer's JSON form.
function packBytes(v) {
  if (v instanceof Uint8Array) return { __b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  if (Array.isArray(v)) return v.map(packBytes);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, packBytes(x)]));
  return v;
}
function unpackBytes(v) {
  if (v && typeof v === "object" && typeof v.__b64 === "string") { const b = Buffer.from(v.__b64, "base64"); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  if (Array.isArray(v)) return v.map(unpackBytes);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpackBytes(x)]));
  return v;
}
// What the hello offers the page, and a fresh hello to open panels when the setting changes.
const lending = () => (filesMode() === "off" ? null
  : { label: "VS Code", name: vscode.workspace.name || "Workspace", readOnly: filesMode() === "readOnly" });
function lendAgain() {
  for (const p of panels.values()) p.webview.postMessage({ type: "craft-embed:lend", files: lending() }).then(undefined, () => {});
}

// craft.workspaceFiles: "readWrite" (default), "readOnly" or "off"; true and false still work.
function filesMode() {
  if (vscode.workspace.isTrusted === false) return "off";
  const v = settings().get("workspaceFiles");
  return v === false || v === "off" ? "off" : v === "readOnly" ? "readOnly" : "readWrite";
}

const kindOf = (t) => (t & vscode.FileType.Directory ? "dir" : t & vscode.FileType.File ? "file" : "other");
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
// Files on this extension host's own disk (file: URIs) are read and written with Node's fs. VS Code's
// fs API goes through the window, and code-server keeps an extension host running for hours after
// its window is gone; such a host may still serve the agents' MCP port (bridge.mjs), and its
// vscode.workspace.fs calls then fail with "Canceled". Other schemes use the API.
const nodeKind = (s) => (s.isDirectory() ? "dir" : s.isFile() ? "file" : "other");
const onDisk = (uri) => uri.scheme === "file";
const files = workspaceFiles({
  folders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, uri: f.uri })),
  mode: filesMode,
  fs: {
    join: (uri, ...p) => vscode.Uri.joinPath(uri, ...p),
    stat: async (uri) => {
      try {
        if (onDisk(uri)) {
          const s = await fsp.stat(uri.fsPath);
          return { type: nodeKind(s), size: s.size, mtime: s.mtimeMs };
        }
        const s = await vscode.workspace.fs.stat(uri);
        return { type: kindOf(s.type), size: s.size, mtime: s.mtime };
      } catch (e) {
        if (["FileNotFound", "EntryNotFound", "ENOENT", "ENOTDIR"].includes(e?.code)) return null;
        throw e;
      }
    },
    list: async (uri) => onDisk(uri)
      ? (await fsp.readdir(uri.fsPath, { withFileTypes: true })).map((d) => [d.name, nodeKind(d)])
      : (await vscode.workspace.fs.readDirectory(uri)).map(([n, t]) => [n, kindOf(t)]),
    read: async (uri) => {
      if (!onDisk(uri)) return vscode.workspace.fs.readFile(uri);
      const b = await fsp.readFile(uri.fsPath);
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    },
    write: (uri, bytes) => (onDisk(uri) ? fsp.writeFile(uri.fsPath, bytes) : vscode.workspace.fs.writeFile(uri, bytes)),
    mkdir: (uri) => (onDisk(uri) ? fsp.mkdir(uri.fsPath, { recursive: true }) : vscode.workspace.fs.createDirectory(uri)),
    // On a local disk, resolve links and short names; elsewhere the checked parts already keep
    // the path inside and visible.
    where: async (root, uri) => (await realWhere(root.fsPath, uri.fsPath)) ?? "inside",
    // A dropped URI: under which folder, and the parts below it. The UI may name a file with
    // another scheme than this extension host does (vscode-remote:// against file://), so the
    // paths are compared when the scheme differs.
    locate: (text) => {
      let uri;
      try { uri = vscode.Uri.parse(text, true); } catch { return null; }
      const list = vscode.workspace.workspaceFolders ?? [];
      const exact = vscode.workspace.getWorkspaceFolder(uri);
      for (const f of exact ? [exact] : list) {
        if (!exact && !(uri.scheme === "vscode-remote" || uri.scheme === "file")) break;
        const base = f.uri.path.replace(/\/+$/, "");
        if (!samePath(uri.path.slice(0, base.length), base) || (uri.path.length > base.length && uri.path[base.length] !== "/")) continue;
        return { folder: f.index, parts: uri.path.slice(base.length).split("/").filter(Boolean) };
      }
      return null;
    },
    // An absolute path; on Windows with either slash, which Uri.file takes there.
    locatePath(path) {
      if (!/^(\/|[a-z]:[\\/])/i.test(path)) return null;
      return this.locate(vscode.Uri.file(path).toString());
    },
  },
});

// The files an agent names for craft_send_file and craft_get_file (bridge.mjs): an absolute path
// in a workspace folder, or a path relative to the first folder. The same checks as the page's
// requests (files.mjs), so craft.workspaceFiles, hidden folders and node_modules count here too.
const fileOp = async (op, args) => {
  const reply = await files({ op, ...args });
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
};
function absolute(path) {
  if (typeof path !== "string" || !path.trim()) throw new Error("Name a file path.");
  if (/^(\/|[a-z]:[\\/])/i.test(path)) return path;
  const first = vscode.workspace.workspaceFolders?.[0];
  if (first?.uri.scheme !== "file") throw new Error(`Give an absolute path inside a workspace folder: ${path}`);
  return join(first.uri.fsPath, path);
}
const agentFiles = {
  async read(path) {
    const at = await fileOp("place", { path: absolute(path) });
    return { name: at.split("/").pop(), bytes: await fileOp("read", { path: at }) };
  },
  async write(path, bytes) {
    const full = absolute(path);
    await fileOp("write", { path: await fileOp("place", { path: full }), bytes });
    return { path: full };
  },
  // Refuses, before anything is copied, a path that write would refuse.
  async check(path) {
    await fileOp("writable", { path: await fileOp("place", { path: absolute(path) }) });
  },
};
