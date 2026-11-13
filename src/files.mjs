// The workspace files that a framed app page may use: the app's File › Open and Save list, read
// and write files under the workspace folders, and files dragged from the explorer onto the app
// are read here. The page asks with "craft-embed:files" messages (craft-embed.js in the app images); see
// extension.mjs for the relay.
//
// Paths are relative and use "/". With one workspace folder, a path starts inside that folder.
// With several, the first part of the path is the folder's name. A part that starts with "." is
// refused and hidden (.git, .vscode, .env), so the page can't change settings, tasks or history;
// the check runs again on the real path, so a link or a Windows short name (GIT~1) can't get
// around it. node_modules can be read but not written.
// No vscode import here: the caller hands in a small file system, so the tests run in plain Node.
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";

export const MAX_BYTES = 200 * 1024 * 1024; // one file, read or written
export const MAX_DROP_BYTES = 400 * 1024 * 1024; // all files of one drop together
export const MAX_DROP_FILES = 50;

const BAD_PART = /[\\:*?"<>|\u0000-\u001f]/;
// On Windows, names that Windows treats specially: devices (a write to NUL "succeeds" and keeps
// nothing) and a trailing dot or space (dropped by Windows). Short 8.3 names such as GIT~1 are
// resolved by realWhere, which then sees the long name.
const WINDOWS_ODD = process.platform === "win32" ? /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$|[. ]$/i : /$^/;
const NO_WRITE = new Set(["node_modules"]);

/** Thrown for a request the page must not make; the message goes back to the page. */
export class Refused extends Error {}

/** Splits a page path into checked parts. "" is the top. */
export function parts(path) {
  if (typeof path !== "string" || path.length > 1024) throw new Refused("A path is a string of up to 1024 characters.");
  if (path === "") return [];
  const list = path.split("/");
  for (const p of list) {
    if (!p || p === "." || p === "..") throw new Refused(`Not a valid path: ${path}`);
    if (p.startsWith(".")) throw new Refused(`Hidden files and folders are off limits: ${path}`);
    if (BAD_PART.test(p) || WINDOWS_ODD.test(p) || p.length > 255) throw new Refused(`Not a valid name: ${p}`);
  }
  return list;
}

/** Turns what came over postMessage into bytes (a Uint8Array, an ArrayBuffer, or older JSON forms). */
export function bytesOf(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v);
  if (v && typeof v === "object" && Object.keys(v).every((k) => /^\d+$/.test(k))) return Uint8Array.from(Object.values(v));
  throw new Refused("No file bytes in the request.");
}

/**
 * @param {object} o
 * @param {() => {name: string, uri: any}[]} o.folders the workspace folders
 * @param {object} o.fs the file system:
 *   join(uri, ...parts), stat(uri) -> {type: "file"|"dir"|"other", size, mtime} | null,
 *   list(uri) -> [name, "file"|"dir"|"other"][], read(uri), write(uri, bytes), mkdir(uri),
 *   where(rootUri, uri) -> "inside" | "outside" | "hidden" | "protected" (inside node_modules):
 *     where uri really is, links and short names resolved (for a path that doesn't exist yet: its
 *     nearest existing folder),
 *   locate(uriString) -> {folder index, parts} for a dropped URI under a folder, or null,
 *   locatePath(fsPath) -> the same for a file system path (absolute, as the editor's machine
 *     names it), or null.
 * @param {() => "readWrite"|"readOnly"|"off"} [o.mode] what the page may do right now
 */
export function workspaceFiles({ folders, fs, mode = () => "readWrite" }) {
  // The folders by the name a path uses: made a valid path part, and a repeated name gets
  // " (2)", " (3)", ...
  function named() {
    const seen = new Map();
    return folders().map((f) => {
      let base = String(f.name).replace(/[\\/:*?"<>|\u0000-\u001f~]/g, "_").replace(/^\.+/, "_").replace(/[. ]+$/, "").slice(0, 200) || "folder";
      if (WINDOWS_ODD.test(base)) base = `${base}_`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      // A workspace folder that is itself a node_modules folder is never written either.
      return { name: n > 1 ? `${base} (${n})` : base, uri: f.uri, protected: String(f.name).toLowerCase() === "node_modules" };
    });
  }

  // A path to {root, uri, rest}; at the top of several folders, uri is null.
  function resolve(path) {
    const list = named();
    if (!list.length) throw new Refused("No folder is open in the editor.");
    let p = parts(path);
    let root;
    if (list.length === 1) root = list[0];
    else {
      if (!p.length) return { root: null, uri: null, rest: p, list };
      root = list.find((f) => f.name === p[0]);
      if (!root) throw new Refused(`No workspace folder called ${p[0]}`);
      p = p.slice(1);
    }
    return { root, uri: p.length ? fs.join(root.uri, ...p) : root.uri, rest: p, list };
  }

  async function checked(path, { file = false, write = false } = {}) {
    const m = mode();
    if (m === "off") throw new Refused("The editor doesn't share files with this workspace (craft.workspaceFiles is off).");
    if (write && m !== "readWrite") throw new Refused("The editor shares this workspace read-only (craft.workspaceFiles).");
    const r = resolve(path);
    const noWrite = `The page may not write in node_modules: ${path}`;
    if (write && (r.root?.protected || r.rest.some((p) => NO_WRITE.has(p.toLowerCase())))) throw new Refused(noWrite);
    if (r.uri) {
      const at = await fs.where(r.root.uri, r.uri);
      if (at === "hidden") throw new Refused(`Hidden files and folders are off limits: ${path}`);
      if (at === "protected") { if (write) throw new Refused(noWrite); }
      else if (at !== "inside") throw new Refused(`Outside the workspace folder: ${path}`);
    }
    if (file && !r.rest.length) throw new Refused("Pick a file inside a workspace folder.");
    return r;
  }

  const ops = {
    async list({ path = "" }) {
      const r = await checked(path);
      if (!r.uri) return { folders: r.list.map((f) => f.name), files: [] };
      const st = await fs.stat(r.uri);
      if (st?.type !== "dir") throw new Refused(`Not a folder: ${path}`);
      const out = { folders: [], files: [] };
      const usable = (name) => { try { parts(name); return true; } catch { return false; } };
      for (const [name, type] of await fs.list(r.uri)) {
        if (!usable(name)) continue; // hidden, or a name the other requests would refuse
        if (type === "dir") out.folders.push(name);
        else if (type === "file") {
          const f = await fs.stat(fs.join(r.uri, name)).catch(() => null);
          if (f) out.files.push({ name, size: f.size, modified: new Date(f.mtime).toISOString() });
        }
      }
      const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
      out.folders.sort(byName);
      out.files.sort((a, b) => byName(a.name, b.name));
      return out;
    },
    async read({ path }) {
      const r = await checked(path, { file: true });
      const st = await fs.stat(r.uri);
      if (st?.type !== "file") throw new Refused(`No such file: ${path}`);
      if (st.size > MAX_BYTES) throw new Refused(`${path} is larger than ${MAX_BYTES / 1048576} MB.`);
      return fs.read(r.uri);
    },
    async write({ path, bytes }) {
      const data = bytesOf(bytes);
      if (data.byteLength > MAX_BYTES) throw new Refused(`A file can have at most ${MAX_BYTES / 1048576} MB.`);
      const r = await checked(path, { file: true, write: true });
      if ((await fs.stat(r.uri))?.type === "dir") throw new Refused(`${path} is a folder.`);
      if (r.rest.length > 1) await fs.mkdir(fs.join(r.root.uri, ...r.rest.slice(0, -1)));
      await fs.write(r.uri, data);
      return { path };
    },
    async mkdir({ path }) {
      const r = await checked(path, { file: true, write: true });
      await fs.mkdir(r.uri);
      return { path };
    },
    // Files dragged from the explorer: URIs, each under a workspace folder. Folders are skipped.
    async drop({ uris }) {
      if (mode() === "off") throw new Refused("The editor doesn't share files with this workspace.");
      if (!Array.isArray(uris)) throw new Refused("No files in the drop.");
      const files = [];
      let total = 0;
      for (const u of uris.slice(0, MAX_DROP_FILES)) {
        const at = typeof u === "string" ? fs.locate(u) : null;
        if (!at) throw new Refused(`Only files in the workspace can be dropped: ${String(u).slice(0, 200)}`);
        const path = pathOf(at);
        const r = await checked(path);
        if (!r.rest.length) continue;
        const st = await fs.stat(r.uri);
        if (st?.type !== "file") continue;
        total += st.size;
        if (st.size > MAX_BYTES || total > MAX_DROP_BYTES) throw new Refused("The dropped files are too large.");
        files.push({ name: r.rest.at(-1), path, bytes: await fs.read(r.uri) });
      }
      return { files };
    },
    // Whether `path` may be written (a file, or a new one), without writing it: the checks of write.
    async writable({ path }) {
      const r = await checked(path, { file: true, write: true });
      if ((await fs.stat(r.uri))?.type === "dir") throw new Refused(`${path} is a folder.`);
      return { path };
    },
    // A file system path (an AI assistant names files so) to the page's path for it. Only the
    // place is checked here; reading and writing the path check it again.
    async place({ path }) {
      if (mode() === "off") throw new Refused("The editor doesn't share files with this workspace.");
      const at = typeof path === "string" && path.length < 4096 ? fs.locatePath?.(path) : null;
      if (!at) throw new Refused(`Not in a folder open in the editor: ${String(path).slice(0, 200)}`);
      const inside = pathOf(at);
      if (!(await checked(inside)).rest.length) throw new Refused(`Name a file inside a workspace folder: ${path}`);
      return inside;
    },
  };

  // {folder index, parts} (fs.locate) to a path the other requests take.
  function pathOf(at) {
    const list = named();
    return list.length > 1 ? [list[at.folder].name, ...at.parts].join("/") : at.parts.join("/");
  }

  /** Answers one request: {id, op, ...args} -> {type, id, ok, value | error}. */
  return async function handle(m) {
    const reply = { type: "craft-embed:files-reply", id: m?.id };
    try {
      const op = Object.hasOwn(ops, m?.op) ? ops[m.op] : null;
      if (!op) throw new Refused(`Unknown request: ${String(m?.op).slice(0, 40)}`);
      return { ...reply, ok: true, value: await op(m) };
    } catch (e) {
      return { ...reply, ok: false, error: e instanceof Refused ? e.message : `The editor couldn't do that: ${e.message}` };
    }
  };
}

// ---- local disks -----------------------------------------------------------------------------

/**
 * Where `path` really is against `root`, with links and Windows short names resolved: "inside",
 * "outside", "hidden" (inside, but a part of the real path starts with a dot) or "protected"
 * (inside, but in a node_modules folder, the root included). A path that
 * doesn't exist yet is judged by its nearest existing folder. `undefined` when `root` isn't on a
 * local disk.
 */
export async function realWhere(root, path) {
  let top;
  try { top = await realpath(root); } catch { return undefined; }
  let at = path;
  const missing = [];
  for (;;) {
    let real;
    try { real = await realpath(at); } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") return "outside";
      const up = dirname(at);
      if (up === at) return "outside";
      missing.unshift(at.slice(up.length).replace(/^[\\/]+/, ""));
      at = up;
      continue;
    }
    const rel = relative(top, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "outside";
    const all = [...rel.split(sep), ...missing].filter(Boolean);
    if (all.some((p) => p.startsWith("."))) return "hidden";
    return [basename(top), ...all].some((p) => NO_WRITE.has(p.toLowerCase())) ? "protected" : "inside";
  }
}
