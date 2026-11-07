// Registers the local MCP server ("craft") with the coding agents on this machine, so each agent
// can drive the open apps with no setup. Each agent keeps its own user-level MCP list:
//
//   Claude Code  ~/.claude.json, through `claude mcp add` (Claude rewrites that file often)
//   Codex        ~/.codex/config.toml, [mcp_servers.craft] (also read by the Codex VS Code extension)
//   Gemini CLI   ~/.gemini/settings.json, mcpServers.craft
//
// An agent counts as installed when its CLI is on PATH or its config folder exists, so one that
// arrives later is picked up by the next sync. A sync changes nothing that is already right.
// No vscode import here, so the tests can run it in plain Node.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const bearer = (token) => `Bearer ${token}`;
const tokenOf = (header) => /^Bearer\s+(\S+)$/i.exec(String(header ?? "").trim())?.[1];

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { return e.code === "ENOENT" ? {} : undefined; }
}
function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Finds a program on PATH (with PATHEXT on Windows). Returns its full path or null. */
export function which(name, env = process.env) {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, name + ext.toLowerCase());
      try { if (statSync(file).isFile()) return file; } catch {}
    }
  }
  return null;
}

/** Runs a program; resolves {ok, out}. Windows .cmd shims need a shell, and then quoted args. */
export function run(bin, args) {
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  const quote = (a) => `"${String(a).replace(/"/g, '""')}"`;
  // With a shell, hand over one quoted command line: Node doesn't quote args for the shell.
  const [file, list] = shell ? [[bin, ...args].map(quote).join(" "), []] : [bin, args];
  return new Promise((resolve) => execFile(file, list, { shell, timeout: 30_000, windowsHide: true },
    (e, stdout, stderr) => resolve({ ok: !e, out: `${stdout}${stderr}`.trim() || (e?.message ?? "") })));
}

// ---- Codex: the [mcp_servers.<name>] table in config.toml ---------------------------------
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tomlString = (s) => JSON.stringify(String(s)); // a TOML basic string is JSON-compatible here

/** Splits config.toml into the server's own tables ([mcp_servers.<name>] and its subtables) and the rest. */
function codexSplit(text, name) {
  const own = new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:"${escRe(name)}"|${escRe(name)})\\s*(?:\\.|\\])`);
  const header = /^\s*\[/;
  const keep = [], mine = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (header.test(line)) inside = own.test(line);
    (inside ? mine : keep).push(line);
  }
  return { keep, mine };
}

export function codexRead(text, name) {
  const { mine } = codexSplit(text, name);
  if (!mine.length) return null;
  const body = mine.join("\n");
  const url = /^\s*url\s*=\s*"([^"]*)"/m.exec(body)?.[1];
  const auth = /"?Authorization"?\s*=\s*"([^"]*)"/i.exec(body)?.[1];
  return { url, token: tokenOf(auth) };
}

export function codexWrite(text, name, url, token) {
  const { keep } = codexSplit(text, name);
  while (keep.length && keep.at(-1).trim() === "") keep.pop();
  const table = [
    `[mcp_servers.${name}]`,
    `url = ${tomlString(url)}`,
    `http_headers = { Authorization = ${tomlString(bearer(token))} }`,
  ];
  return [...keep, ...(keep.length ? [""] : []), ...table, ""].join("\n");
}

// ---- the agents --------------------------------------------------------------------------
/**
 * Each agent: find() → {bin?, config} when installed, read() → {url, token} | null | undefined
 * (undefined: can't tell), write() → {ok, out}.
 */
export const AGENTS = [
  {
    id: "claude",
    label: "Claude Code",
    find: (ctx) => {
      const bin = which("claude", ctx.env) ?? ctx.extraBins.claude?.find((b) => existsSync(b))
        ?? [join(ctx.home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude")].find((b) => existsSync(b));
      return bin ? { bin } : null; // Claude's config is written through the CLI only
    },
    read: (ctx) => {
      const file = join(ctx.env.CLAUDE_CONFIG_DIR || ctx.home, ".claude.json");
      const config = readJson(file);
      if (config === undefined) return undefined;
      const server = config.mcpServers?.[ctx.name];
      return server ? { url: server.url, token: tokenOf(server.headers?.Authorization) } : null;
    },
    write: async (ctx, found, had) => {
      if (had !== null) await ctx.run(found.bin, ["mcp", "remove", ctx.name, "--scope", "user"]);
      // --header takes several values, so it goes last, after the name and URL.
      return ctx.run(found.bin, ["mcp", "add", "--transport", "http", "--scope", "user", ctx.name, ctx.url, "--header", `Authorization: ${bearer(ctx.token)}`]);
    },
  },
  {
    id: "codex",
    label: "Codex",
    find: (ctx) => {
      const dir = ctx.env.CODEX_HOME || join(ctx.home, ".codex");
      return which("codex", ctx.env) || existsSync(dir) ? { config: join(dir, "config.toml") } : null;
    },
    read: (ctx, found) => {
      try { return codexRead(readFileSync(found.config, "utf8"), ctx.name); } catch (e) { return e.code === "ENOENT" ? null : undefined; }
    },
    write: async (ctx, found) => {
      let text = "";
      try { text = readFileSync(found.config, "utf8"); } catch (e) { if (e.code !== "ENOENT") return { ok: false, out: e.message }; }
      writeText(found.config, codexWrite(text, ctx.name, ctx.url, ctx.token));
      return { ok: true, out: `wrote ${found.config}` };
    },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    find: (ctx) => {
      const dir = join(ctx.home, ".gemini");
      return which("gemini", ctx.env) || existsSync(dir) ? { config: join(dir, "settings.json") } : null;
    },
    read: (ctx, found) => {
      const settings = readJson(found.config);
      if (settings === undefined) return undefined;
      const server = settings.mcpServers?.[ctx.name];
      return server ? { url: server.httpUrl ?? server.url, token: tokenOf(server.headers?.Authorization) } : null;
    },
    write: async (ctx, found) => {
      const settings = readJson(found.config);
      // A settings.json with comments isn't plain JSON; leave it alone rather than drop them.
      if (settings === undefined) return { ok: false, out: `${found.config} isn't plain JSON; add the server by hand` };
      settings.mcpServers = { ...settings.mcpServers, [ctx.name]: { httpUrl: ctx.url, headers: { Authorization: bearer(ctx.token) } } };
      writeText(found.config, `${JSON.stringify(settings, null, 2)}\n`);
      return { ok: true, out: `wrote ${found.config}` };
    },
  },
];

/**
 * Brings every enabled agent's "craft" entry up to date with the server's URL and token.
 * @returns {Promise<{id: string, label: string, state: "off"|"missing"|"ok"|"added"|"updated"|"failed", detail?: string}[]>}
 */
export async function syncAgents({
  url, token, name = "craft", enabled = AGENTS.map((a) => a.id), home = homedir(), env = process.env,
  extraBins = {}, runner = run, agents = AGENTS,
}) {
  const ctx = { url, token, name, home, env, extraBins, run: runner };
  const results = [];
  for (const agent of agents) {
    const base = { id: agent.id, label: agent.label };
    if (!enabled.includes(agent.id)) { results.push({ ...base, state: "off" }); continue; }
    try {
      const found = agent.find(ctx);
      if (!found) { results.push({ ...base, state: "missing" }); continue; }
      const had = agent.read(ctx, found);
      if (had && had.url === url && had.token === token) { results.push({ ...base, state: "ok" }); continue; }
      const done = await agent.write(ctx, found, had);
      results.push({ ...base, state: done.ok ? (had ? "updated" : "added") : "failed", detail: done.out });
    } catch (e) {
      results.push({ ...base, state: "failed", detail: e.message });
    }
  }
  return results;
}
