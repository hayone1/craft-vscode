// The workspace files a framed app page may use, against temporary folders on the local disk.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { after, test } from "node:test";
import { bytesOf, parts, realWhere, workspaceFiles } from "../src/files.mjs";

const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "craft-ws-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// The same small file system extension.mjs builds on vscode.workspace.fs, here on node:fs.
const nodeFs = (roots) => ({
  join: (uri, ...p) => join(uri, ...p),
  stat: async (uri) => {
    try { const s = await stat(uri); return { type: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other", size: s.size, mtime: s.mtimeMs }; }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  },
  list: async (uri) => (await readdir(uri, { withFileTypes: true })).map((d) => [d.name, d.isDirectory() ? "dir" : d.isFile() ? "file" : "other"]),
  read: (uri) => readFile(uri).then((b) => new Uint8Array(b)),
  write: (uri, bytes) => writeFile(uri, bytes),
  mkdir: (uri) => mkdir(uri, { recursive: true }).then(() => {}),
  where: async (root, uri) => (await realWhere(root, uri)) ?? "inside",
  locate: (text) => {
    const path = text.replace(/^file:\/\//, "");
    const i = roots.findIndex((r) => path === r || path.startsWith(r + sep));
    return i < 0 ? null : { folder: i, parts: relative(roots[i], path).split(sep).filter(Boolean) };
  },
  locatePath(path) { return this.locate(path); },
});

function setup(count = 1, mode = () => "readWrite", names = ["site", "assets"]) {
  const roots = Array.from({ length: count }, () => temp());
  const handle = workspaceFiles({ folders: () => roots.map((r, i) => ({ name: names[i], uri: r })), fs: nodeFs(roots), mode });
  let n = 0;
  const call = async (op, args = {}) => {
    const r = await handle({ type: "craft-embed:files", id: String(++n), op, ...args });
    assert.equal(r.type, "craft-embed:files-reply");
    assert.equal(r.id, String(n));
    return r;
  };
  return { roots, call, ok: async (op, args) => { const r = await call(op, args); assert.ok(r.ok, r.error); return r.value; } };
}

test("paths: relative, with / between parts, and nothing hidden or climbing out", () => {
  assert.deepEqual(parts(""), []);
  assert.deepEqual(parts("img/logo.png"), ["img", "logo.png"]);
  for (const bad of ["../x", "a/../b", "/abs", "a//b", "a/", ".git/config", "a/.env", "c:/x", "a\\b", "a\u0000b",
    ...(process.platform === "win32" ? ["nul", "CON.txt", "com1", "name.", "name "] : []), 5, null]) {
    assert.throws(() => parts(bad), undefined, String(bad));
  }
  assert.deepEqual(parts("img/photo~2.png"), ["img", "photo~2.png"], "a ~ in a name is fine; realWhere resolves short names");
  assert.deepEqual([...bytesOf({ 0: 1, 1: 2 })], [1, 2]);
  assert.deepEqual([...bytesOf([3, 4])], [3, 4]);
  assert.deepEqual([...bytesOf(new Uint8Array([5]).buffer)], [5]);
});

test("one folder: list, write (with new folders), read back, make a folder; hidden entries stay hidden", async () => {
  const { roots: [root], ok, call } = setup();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, "a10.txt"), "x");
  writeFileSync(join(root, "a9.txt"), "y");

  assert.deepEqual(await ok("write", { path: "art/logos/star.svg", bytes: new TextEncoder().encode("<svg/>") }), { path: "art/logos/star.svg" });
  assert.equal(readFileSync(join(root, "art", "logos", "star.svg"), "utf8"), "<svg/>");
  assert.equal(new TextDecoder().decode(await ok("read", { path: "art/logos/star.svg" })), "<svg/>");

  const top = await ok("list", { path: "" });
  assert.deepEqual(top.folders, ["art"]);
  assert.deepEqual(top.files.map((f) => f.name), ["a9.txt", "a10.txt"]);
  assert.equal(top.files[0].size, 1);
  assert.ok(!Number.isNaN(Date.parse(top.files[0].modified)));

  await ok("mkdir", { path: "exports" });
  assert.deepEqual((await ok("list", { path: "" })).folders, ["art", "exports"]);

  for (const [op, args] of [["read", { path: ".env" }], ["write", { path: ".vscode/tasks.json", bytes: [1] }], ["list", { path: ".git" }],
    ["read", { path: "../outside.txt" }], ["write", { path: "", bytes: [1] }], ["write", { path: "art", bytes: [1] }], ["read", { path: "nope.txt" }],
    ["list", { path: "a9.txt" }], ["delete", { path: "a9.txt" }], ["toString", {}]]) {
    const r = await call(op, args);
    assert.equal(r.ok, false, `${op} ${JSON.stringify(args)}`);
    assert.equal(typeof r.error, "string");
  }
  assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=1");
});

test("several folders: the first part of a path names the folder", async () => {
  const { roots, ok, call } = setup(2);
  assert.deepEqual(await ok("list", { path: "" }), { folders: ["site", "assets"], files: [] });
  await ok("write", { path: "assets/bg.png", bytes: new Uint8Array([1, 2, 3]) });
  assert.deepEqual([...readFileSync(join(roots[1], "bg.png"))], [1, 2, 3]);
  assert.equal((await call("write", { path: "bg.png", bytes: [1] })).ok, false, "a file can't sit above the folders");
  assert.equal((await call("read", { path: "other/x" })).ok, false);
});

test("a symbolic link that leads out of the folder is refused", async (t) => {
  const { roots: [root], call } = setup();
  const outside = temp();
  writeFileSync(join(outside, "secret.txt"), "s");
  try { symlinkSync(outside, join(root, "link"), "junction"); } catch { return t.skip("no symbolic links here"); }
  assert.equal((await call("read", { path: "link/secret.txt" })).ok, false);
  assert.equal((await call("write", { path: "link/new.txt", bytes: [1] })).ok, false);
  assert.equal((await call("write", { path: "link/deeper/new.txt", bytes: [1] })).ok, false);
  assert.equal((await call("list", { path: "link" })).ok, false);
});

test("a drop reads the dropped workspace files, skips folders, and refuses files elsewhere", async () => {
  const { roots: [root], ok, call } = setup();
  writeFileSync(join(root, "photo.jpg"), "jpg");
  mkdirSync(join(root, "dir"));
  const { files } = await ok("drop", { uris: [`file://${join(root, "photo.jpg")}`, `file://${join(root, "dir")}`] });
  assert.deepEqual(files.map((f) => [f.name, f.path, new TextDecoder().decode(f.bytes)]), [["photo.jpg", "photo.jpg", "jpg"]]);

  const outside = temp();
  writeFileSync(join(outside, "x.txt"), "x");
  assert.equal((await call("drop", { uris: [`file://${join(outside, "x.txt")}`] })).ok, false);
  writeFileSync(join(root, ".env"), "s");
  assert.equal((await call("drop", { uris: [`file://${join(root, ".env")}`] })).ok, false);
  assert.equal((await call("drop", { uris: "nope" })).ok, false);
});

test("an assistant's file system path becomes the page's path, only for files in the folders", async () => {
  const one = setup();
  assert.equal(await one.ok("place", { path: join(one.roots[0], "out", "cat.png") }), "out/cat.png", "a new file is fine");
  assert.equal((await one.call("place", { path: one.roots[0] })).ok, false, "the folder itself isn't a file");
  assert.equal((await one.call("place", { path: join(temp(), "x.png") })).ok, false, "outside the folders");
  assert.equal((await one.call("place", { path: join(one.roots[0], ".git", "x") })).ok, false, "hidden");
  assert.equal((await one.call("place", { path: "cat.png" })).ok, false, "relative");
  const two = setup(2);
  assert.equal(await two.ok("place", { path: join(two.roots[1], "bg.png") }), "assets/bg.png");
  const off = setup(1, () => "off");
  assert.equal((await off.call("place", { path: join(off.roots[0], "a.png") })).ok, false);
});

test("nothing is shared while the setting is off; read-only refuses writes", async () => {
  let on = "off";
  const { roots: [root], call } = setup(1, () => on);
  writeFileSync(join(root, "a.txt"), "a");
  for (const [op, args] of [["list", { path: "" }], ["read", { path: "a.txt" }], ["write", { path: "b.txt", bytes: [1] }], ["drop", { uris: [`file://${join(root, "a.txt")}`] }]]) {
    assert.equal((await call(op, args)).ok, false, op);
  }
  on = "readOnly";
  assert.equal((await call("read", { path: "a.txt" })).ok, true);
  assert.equal((await call("write", { path: "b.txt", bytes: [1] })).ok, false);
  assert.equal((await call("mkdir", { path: "c" })).ok, false);
  assert.equal((await call("writable", { path: "b.txt" })).ok, false);
  on = "readWrite";
  assert.equal((await call("writable", { path: "new/c.txt" })).ok, true, "a new file in a new folder may be written");
  assert.equal(existsSync(join(root, "new")), false, "writable writes nothing");
  assert.equal((await call("writable", { path: "node_modules/c.txt" })).ok, false);
  assert.equal((await call("write", { path: "b.txt", bytes: [1] })).ok, true);
  assert.equal(basename(root).startsWith("craft-ws-"), true);
});

test("a link to a hidden folder, and node_modules, are off limits; odd folder names are made usable", async (t) => {
  const { roots: [root], call, ok } = setup();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "secret");
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  writeFileSync(join(root, "node_modules", "x", "index.js"), "ok");
  assert.equal(new TextDecoder().decode(await ok("read", { path: "node_modules/x/index.js" })), "ok");
  assert.equal((await call("write", { path: "node_modules/x/index.js", bytes: [1] })).ok, false);
  assert.equal(readFileSync(join(root, "node_modules", "x", "index.js"), "utf8"), "ok");

  const multi = setup(3, () => "readWrite", ["API: v2", ".config", "node_modules"]);
  assert.deepEqual((await multi.ok("list", { path: "" })).folders, ["API_ v2", "_config", "node_modules"]);
  await multi.ok("write", { path: "_config/a.txt", bytes: [1] });
  assert.deepEqual([...readFileSync(join(multi.roots[1], "a.txt"))], [1]);
  assert.equal((await multi.call("write", { path: "node_modules/a.txt", bytes: [1] })).ok, false, "a node_modules workspace folder");

  try { symlinkSync(join(root, ".git"), join(root, "gitlink"), "junction"); } catch { return t.skip("no symbolic links here"); }
  assert.equal((await call("read", { path: "gitlink/config" })).ok, false);
  assert.equal((await call("list", { path: "gitlink" })).ok, false);
  assert.equal((await call("write", { path: "gitlink/hooks/pre-commit", bytes: [1] })).ok, false);
  symlinkSync(join(root, "node_modules"), join(root, "deps"), "junction");
  assert.equal(new TextDecoder().decode(await ok("read", { path: "deps/x/index.js" })), "ok");
  assert.equal((await call("write", { path: "deps/x/index.js", bytes: [1] })).ok, false, "a link into node_modules");
  assert.equal(readFileSync(join(root, "node_modules", "x", "index.js"), "utf8"), "ok");
});
