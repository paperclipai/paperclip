// Executed inside a sandbox using its existing Node runtime. No storage secrets
// or database credentials enter this process. Each command has bounded output.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const MAX_CHUNK = 256 * 1024;
const MAX_ENTRIES = 100_000;
function safeRelative(value) {
  if (typeof value !== "string" || !value || /[\\\x00-\x1f\x7f]/.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe_path");
  return value;
}
// Hold every parent directory open while resolving its child. On Linux this
// uses procfs descriptor paths, so swapping a parent for a symlink cannot send
// an operation into another scope or a CLI credential directory.
function withParent(target, create, callback) {
  const resolved = path.resolve(target);
  const segments = resolved.split(path.sep).filter(Boolean);
  const name = segments.pop();
  if (!name) throw new Error("invalid_root");
  let current = path.parse(resolved).root;
  let fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const segment of segments) {
      const next = process.platform === "linux" ? `/proc/self/fd/${fd}/${segment}` : path.join(current, segment);
      if (create) {
        try { fs.mkdirSync(next, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      const stat = fs.lstatSync(next);
      if (stat.isSymbolicLink()) throw new Error("symlink_not_allowed");
      const child = fs.openSync(next, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(fd); fd = child;
      current = path.join(current, segment);
    }
    return callback(process.platform === "linux" ? `/proc/self/fd/${fd}/${name}` : path.join(current, name));
  } finally { fs.closeSync(fd); }
}
function checked(target, directory = false) {
  return withParent(target, false, (anchored) => {
    if (fs.lstatSync(anchored).isSymbolicLink()) throw new Error("symlink_not_allowed");
    const fd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (directory ? fs.constants.O_DIRECTORY : 0));
    const stat = fs.fstatSync(fd);
    if ((directory && !stat.isDirectory()) || (!directory && !stat.isFile())) { fs.closeSync(fd); throw new Error("unsupported_file"); }
    if (!directory && stat.nlink !== 1) { fs.closeSync(fd); throw new Error("hardlink_not_allowed"); }
    return fd;
  });
}
function children(target) {
  const fd = checked(target, true);
  try { return fs.readdirSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : target).sort(); }
  finally { fs.closeSync(fd); }
}
function checksum(target) {
  const fd = checked(target);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(MAX_CHUNK);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}
function ensureDirectory(target) {
  withParent(target, false, (anchored) => {
    try { fs.mkdirSync(anchored, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (fs.lstatSync(anchored).isSymbolicLink()) throw new Error("symlink_not_allowed");
    const fd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    fs.closeSync(fd);
  });
}
function full(relative) { return path.join(input.root, safeRelative(relative)); }
function parents(relative) {
  const parts = safeRelative(relative).split("/");
  let current = input.root;
  for (const part of parts.slice(0, -1)) { current = path.join(current, part); ensureDirectory(current); }
}
function scan() {
  const results = [];
  function entry(relative) {
    if (relative.split("/").includes(".paperclip-runtime")) return;
    if (relative.startsWith(".git/") && relative.endsWith(".lock")) throw new Error("repository_write_in_progress");
    if (results.length >= MAX_ENTRIES) throw new Error("too_many_files");
    const target = full(relative);
    const stat = withParent(target, false, (anchored) => fs.lstatSync(anchored));
    if (stat.isSymbolicLink()) {
      if (!input.repository || relative.startsWith(".git/")) throw new Error("symlink_not_allowed");
      const linkTarget = withParent(target, false, (anchored) => fs.readlinkSync(anchored));
      const destination = path.resolve(path.dirname(full(relative)), linkTarget);
      if (path.isAbsolute(linkTarget) || !destination.startsWith(`${input.root}/`)
        || destination === `${input.root}/.git` || destination.startsWith(`${input.root}/.git/`)) throw new Error("symlink_outside_repository");
      try { if (!fs.realpathSync(target).startsWith(`${input.root}/`)) throw new Error("symlink_outside_repository"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      results.push({ path: relative, kind: "file", byteSize: Buffer.byteLength(linkTarget),
        sha256: createHash("sha256").update(linkTarget).digest("hex"), executable: false, linkTarget });
      return;
    }
    if (stat.isDirectory()) {
      const fd = checked(target, true); fs.closeSync(fd);
      results.push({ path: relative, kind: "directory", byteSize: 0, sha256: null, executable: false });
      for (const child of children(target)) entry(`${relative}/${child}`);
    } else if (stat.isFile()) {
      results.push({ path: relative, kind: "file", byteSize: stat.size, sha256: checksum(target), executable: Boolean(stat.mode & 0o111) });
    } else throw new Error("unsupported_file");
  }
  if (input.repository) {
    const gitDir = path.join(input.root, ".git");
    const fd = checked(gitDir, true); fs.closeSync(fd);
    if (fs.existsSync(path.join(gitDir, "objects/info/alternates"))) throw new Error("repository_is_not_independent");
    const files = execFileSync("git", ["-C", input.root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean);
    for (const relative of [...new Set(files)].sort()) {
      try { fs.lstatSync(full(relative)); entry(relative); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    for (const name of children(gitDir)) {
      if (["config", "config.worktree", "hooks"].includes(name)) continue;
      if (name.endsWith(".lock")) throw new Error("repository_write_in_progress");
      entry(`.git/${name}`);
    }
  } else {
    for (const name of children(input.root)) entry(name);
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

let result;
if (input.operation === "home") {
  result = { home: os.homedir() };
} else if (input.operation === "mkdir-root") {
  ensureDirectory(input.root); result = {};
} else if (input.operation === "move-root") {
  const fd = checked(input.source, true); fs.closeSync(fd);
  withParent(input.source, false, (source) => withParent(input.root, false, (target) => {
    try { fs.lstatSync(target); throw new Error("repository_destination_already_exists"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.renameSync(source, target);
  })); result = {};
} else {
  const rootFd = checked(input.root, true); fs.closeSync(rootFd);
  if (input.operation === "scan") result = scan();
  else if (input.operation === "read") {
    const fd = checked(full(input.path));
    try {
      const buffer = Buffer.alloc(MAX_CHUNK);
      const count = fs.readSync(fd, buffer, 0, buffer.length, input.offset);
      result = { data: buffer.subarray(0, count).toString("base64") };
    } finally { fs.closeSync(fd); }
  } else if (input.operation === "mkdir") {
    parents(input.path); ensureDirectory(full(input.path)); result = {};
  } else if (input.operation === "write") {
    parents(input.path);
    const buffer = Buffer.from(input.data, "base64");
    if (buffer.length > MAX_CHUNK) throw new Error("chunk_too_large");
    const target = full(input.path);
    // Temporary writes happen in a separate host-selected staging root.
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | (input.offset === 0 ? fs.constants.O_EXCL : 0);
    withParent(target, false, (anchored) => {
      const fd = fs.openSync(anchored, flags, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsupported_file");
        if (stat.size !== input.offset) throw new Error("invalid_chunk_offset");
        fs.writeSync(fd, buffer, 0, buffer.length, input.offset);
      } finally { fs.closeSync(fd); }
    });
    result = {};
  } else if (input.operation === "publish") {
    parents(input.path);
    const source = path.join(input.stagingRoot, safeRelative(input.stagingPath));
    if (checksum(source) !== input.sha256) throw new Error("content_changed_during_transfer");
    const sourceFd = checked(source);
    try { fs.fchmodSync(sourceFd, input.executable ? 0o700 : 0o600); } finally { fs.closeSync(sourceFd); }
    const target = full(input.path);
    try { const fd = checked(target); fs.closeSync(fd); } catch (error) { if (error.code !== "ENOENT") throw error; }
    withParent(source, false, (from) => withParent(target, false, (to) => fs.renameSync(from, to))); result = {};
  } else if (input.operation === "symlink") {
    parents(input.path);
    const target = full(input.path);
    if (typeof input.linkTarget !== "string" || /[\x00-\x1f\x7f]/.test(input.linkTarget) || path.isAbsolute(input.linkTarget)
      || !path.resolve(path.dirname(target), input.linkTarget).startsWith(`${input.root}/`)) throw new Error("symlink_outside_repository");
    const temporary = path.join(input.stagingRoot, safeRelative(input.stagingPath));
    withParent(temporary, false, (from) => {
      fs.symlinkSync(input.linkTarget, from);
      withParent(target, false, (to) => fs.renameSync(from, to));
    }); result = {};
  } else if (input.operation === "remove") {
    const target = full(input.path);
    // Never recursively follow a user-created symlink during deletion.
    try {
      const stat = withParent(target, false, (anchored) => fs.lstatSync(anchored));
      const fd = checked(target, stat.isDirectory()); fs.closeSync(fd);
      withParent(target, false, (anchored) => { if (stat.isDirectory()) fs.rmdirSync(anchored); else fs.unlinkSync(anchored); });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    result = {};
  } else throw new Error("unknown_operation");
}
process.stdout.write(JSON.stringify(result));
