// Craft apps in VS Code: each app from craft-ai-hub opens in an editor panel (the hub page in a
// webview's iframe), and one local MCP server (bridge.mjs) lets Claude Code, or any MCP client in
// this workspace, drive the apps that are open.
//
// The panel learns its tab's MCP URL from the hub's overlay (EMBED_ORIGINS on the hub): the
// webview says "craft-embed:hello" to the framed page, the overlay answers "craft-hub:session".
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { fetch as httpFetch } from "undici";
import { Bridge } from "./bridge.mjs";

const CATALOG = {
  photocraft: "PhotoCraft", vectorcraft: "VectorCraft", lightcraft: "LightCraft", filmcraft: "FilmCraft",
  effectcraft: "EffectCraft", designcraft: "DesignCraft", pdfcraft: "PDFCraft", figcraft: "FigCraft",
  gridcraft: "GridCraft", cadcraft: "CADCraft", deckcraft: "DeckCraft", soundcraft: "SoundCraft", wordcraft: "WordCraft",
};
const VIEW_TYPE = "craft.app";
const SERVER = "craft";

const settings = () => vscode.workspace.getConfiguration("craft");
const hubUrl = () => String(settings().get("hubUrl") || process.env.CRAFT_HUB_URL || "").trim().replace(/\/+$/, "");
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

export async function activate(context) {
  log = vscode.window.createOutputChannel("Craft apps", { log: true });
  changed = new vscode.EventEmitter();
  context.subscriptions.push(log, changed);

  const tree = { onDidChangeTreeData: changed.event, getTreeItem: (a) => item(a), getChildren: () => apps() };
  context.subscriptions.push(vscode.window.registerTreeDataProvider("craft.apps", tree));

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
    vscode.commands.registerCommand("craft.setMcpUrl", setMcpUrl),
    vscode.commands.registerCommand("craft.registerClaudeCode", () => registerClaudeCode(true)),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        const app = state?.app;
        if (typeof app === "string" && hubUrl()) setup(panel, app);
        else panel.dispose();
      },
    }),
  );

  await serve(context);
  if (vscode.lm?.registerMcpServerDefinitionProvider && vscode.McpHttpServerDefinition) {
    context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider("craft.mcp", {
      provideMcpServerDefinitions: () => [new vscode.McpHttpServerDefinition("Craft apps", vscode.Uri.parse(mcpUrl()))],
    }));
  }
  if (settings().get("registerWithClaudeCode", true)) registerClaudeCode(false);
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
  bridge = new Bridge({ apps, open: route, log: (s) => log.info(s) });
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
  const sent = await httpFetch(`http://127.0.0.1:${port()}/tabs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ window: follower.id, focusedAt, tabs: Object.fromEntries(local) }),
  }).then((r) => r.ok, () => false);
  if (sent) return;
  try {
    await bridge.listen(port());
    clearInterval(follower.timer);
    follower = undefined;
    log.info(`MCP server at ${mcpUrl()} (took over)`);
    for (const [app, tab] of local) bridge.update(app, tab);
    changed.fire();
  } catch {}
}

// A follower's commands from the window that holds the port.
async function poll(me) {
  while (follower === me) {
    const commands = await httpFetch(`http://127.0.0.1:${port()}/commands?window=${me.id}`).then((r) => (r.ok ? r.json() : []), () => null);
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

// Claude Code reads user-scope MCP servers from ~/.claude.json; add ours there once.
async function registerClaudeCode(asked) {
  const run = (bin, args) => new Promise((resolve) => execFile(bin, args, { shell: process.platform === "win32", timeout: 30_000 },
    (e, stdout, stderr) => resolve({ ok: !e, out: `${stdout}${stderr}`.trim() })));
  const bins = ["claude", join(homedir(), ".local", "bin", "claude")];
  let bin;
  for (const b of bins) if ((await run(b, ["--version"])).ok) { bin = b; break; }
  if (!bin) {
    if (asked) vscode.window.showWarningMessage("Craft apps: the Claude Code CLI (claude) isn't installed here.");
    return;
  }
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    if (config.mcpServers?.[SERVER]?.url === mcpUrl()) {
      if (asked) vscode.window.showInformationMessage(`Claude Code already has the ${SERVER} MCP server.`);
      return;
    }
    if (config.mcpServers?.[SERVER]) await run(bin, ["mcp", "remove", SERVER, "--scope", "user"]);
  } catch {}
  const added = await run(bin, ["mcp", "add", "--transport", "http", "--scope", "user", SERVER, mcpUrl()]);
  log.info(`claude mcp add ${SERVER}: ${added.out}`);
  if (asked || !added.ok) {
    vscode.window[added.ok ? "showInformationMessage" : "showWarningMessage"](added.ok
      ? `Claude Code now has the ${SERVER} MCP server. Start a new Claude conversation to use it.`
      : `Craft apps: couldn't add the MCP server to Claude Code: ${added.out}`);
  }
}

// ---- panels -------------------------------------------------------------------------------
async function pick() {
  const choice = await vscode.window.showQuickPick(apps().map((a) => ({
    label: a.title, description: local.get(a.name)?.state === "on" ? "connected" : panels.has(a.name) ? "open" : "", app: a.name,
  })), { placeHolder: "Open a craft app" });
  return choice?.app;
}

async function open(app, fromAgent) {
  if (!hubUrl()) {
    const url = await vscode.window.showInputBox({ prompt: "The craft-ai-hub address", placeHolder: "https://craft.example.com", ignoreFocusOut: true });
    if (!url) return;
    await settings().update("hubUrl", url, vscode.ConfigurationTarget.Global);
  }
  const existing = panels.get(app);
  if (existing) return existing.reveal(undefined, fromAgent);
  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, titleOf(app), { viewColumn: vscode.ViewColumn.Active, preserveFocus: fromAgent }, {
    enableScripts: true, retainContextWhenHidden: true,
  });
  setup(panel, app);
}

function setup(panel, app) {
  panels.get(app)?.dispose();
  panels.set(app, panel);
  panel.title = titleOf(app);
  panel.iconPath = vscode.Uri.joinPath(vscode.extensions.getExtension("hayone1.craft-vscode").extensionUri, "media", "app.svg");
  panel.webview.options = { enableScripts: true };
  panel.webview.html = page(app);
  panel.webview.onDidReceiveMessage((m) => {
    if (m?.type === "craft-hub:session") {
      const tab = typeof m.mcp === "string" && /^https:\/\/|^http:\/\//.test(m.mcp)
        ? { mcp: m.mcp, state: String(m.state ?? "off"), title: String(m.title ?? titleOf(app)) } : null;
      log.info(`${app}: ${m.state}${tab ? "" : " (no connection)"}`);
      tabChanged(app, tab);
    } else if (m?.type === "signin") signIn(app);
    else if (m?.type === "reload") panel.webview.html = page(app);
  });
  panel.onDidDispose(() => {
    if (panels.get(app) !== panel) return;
    panels.delete(app);
    tabChanged(app, null);
  });
}

const active = () => [...panels.values()].find((p) => p.active);
const activeApp = () => [...panels.entries()].find(([, p]) => p.active)?.[0];

async function signIn(app) {
  if (!hubUrl()) return;
  await vscode.env.openExternal(vscode.Uri.parse(`${hubUrl()}/${app ? `${app}/` : ""}`));
  const reload = await vscode.window.showInformationMessage("Sign in to the hub in the browser tab that opened, then come back and reload the app.", "Reload");
  if (reload) for (const p of panels.values()) p.webview.postMessage({ type: "reload" });
}

// For a hub without EMBED_ORIGINS: paste the URL from the overlay's Connect tab.
async function setMcpUrl() {
  const app = activeApp() ?? (await pick());
  if (!app) return;
  const url = await vscode.window.showInputBox({
    prompt: `${titleOf(app)}'s MCP URL, from the Connect tab of the app's Ask AI panel`, ignoreFocusOut: true,
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

function page(app) {
  const hub = new URL(hubUrl());
  const src = new URL(`${hub.pathname.replace(/\/$/, "")}/${app}/`, hub).href;
  const nonce = randomBytes(16).toString("base64");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${esc(hub.origin)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
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
<iframe id="app" src="${esc(src)}" allow="clipboard-read; clipboard-write; fullscreen; autoplay; microphone; camera; display-capture"></iframe>
<div id="note" hidden><span>No word from ${esc(titleOf(app))} yet. If the hub asks you to sign in and the page stays blank, sign in in a browser tab.</span>
  <button id="signin">Sign in</button><button id="reload" class="plain">Reload</button><button id="hide" class="plain">Hide</button></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  vscode.setState({ app: ${JSON.stringify(app)} });
  const HUB = ${JSON.stringify(hub.origin)};
  const frame = document.getElementById("app");
  const note = document.getElementById("note");
  let heard = false, loop, waited = 0;
  const hello = () => frame.contentWindow && frame.contentWindow.postMessage({ type: "craft-embed:hello" }, HUB);
  frame.addEventListener("load", () => {
    heard = false; waited = 0; clearInterval(loop); hello();
    loop = setInterval(() => {
      if (heard) return clearInterval(loop);
      hello();
      if (++waited === 25) note.hidden = false;
    }, 1000);
  });
  window.addEventListener("message", (e) => {
    if (e.source === frame.contentWindow) {
      if (e.origin !== HUB || !e.data || e.data.type !== "craft-hub:session") return;
      heard = true; note.hidden = true;
      vscode.postMessage(e.data);
    } else if (e.data && e.data.type === "reload") {
      frame.src = frame.src;
    }
  });
  document.getElementById("signin").onclick = () => vscode.postMessage({ type: "signin" });
  document.getElementById("reload").onclick = () => { frame.src = frame.src; };
  document.getElementById("hide").onclick = () => { note.hidden = true; };
</script>
</body></html>`;
}
