// The MCP server's bearer token. CRAFT_MCP_TOKEN wins when it is set; otherwise the token lives
// in ~/.craft-vscode/mcp-token, created on first use, so every editor window and every agent on
// this machine agrees on one token. No vscode import here, so the tests can run it in plain Node.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const tokenFile = (home = homedir()) => join(home, ".craft-vscode", "mcp-token");

const generate = () => randomBytes(32).toString("base64url");

function write(file, token) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}

/**
 * The token to use now: {token, source: "env" | "file"}. Creates the file when it is missing.
 * @param {{env?: NodeJS.ProcessEnv, file?: string}} [o]
 */
export function resolveToken({ env = process.env, file = tokenFile() } = {}) {
  const fromEnv = String(env.CRAFT_MCP_TOKEN ?? "").trim();
  if (fromEnv) return { token: fromEnv, source: "env" };
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return { token: saved, source: "file" };
  } catch {}
  const token = generate();
  write(file, token);
  return { token, source: "file" };
}

/** Replaces the saved token with a new one. CRAFT_MCP_TOKEN, when set, still wins. */
export function rotateToken({ env = process.env, file = tokenFile() } = {}) {
  write(file, generate());
  return resolveToken({ env, file });
}
