import { createHash } from "node:crypto";
import type { NativeRuntimeContextSnapshot } from "../../vendor/paperclip-runner/index.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
export function remoteRuntimeContextIdentity(context: NativeRuntimeContextSnapshot): string {
  return createHash("sha256").update(JSON.stringify(stable({ ...context, mcp: { ...context.mcp, bindingId: null } }))).digest("hex");
}

/** Runs in a bounded guest process after transport and before provider launch.
 * It reads only the owned staged context file; private prompt text is never a
 * command-line argument. The workspace anchor is already operator-authorized.
 */
export const verifyRemoteSharedSkills = `
(() => {
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const home = path.resolve(process.argv[1]), workspace = path.resolve(process.argv[2]);
const fail = () => { throw Error("runner_remote_runtime_asset_integrity_mismatch"); };
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function directory(root) {
  const relative = path.relative(workspace, path.resolve(root));
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) fail();
  let cursor = fs.realpathSync(workspace);
  for (const segment of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
}
function read(file, limit) {
  directory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) fail();
    const bytes = Buffer.alloc(opened.size + 1); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    const after = fs.fstatSync(fd);
    if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail();
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
const context = JSON.parse(read(path.resolve(process.argv[3]), 64 * 1024 * 1024));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
if (hash(JSON.stringify(stable({ ...context, mcp: { ...context.mcp, bindingId: null } }))) !== process.argv[4]) fail();
const assets = new Map(), manifests = new Map();
for (const asset of [context.instructions.bundle, ...context.skills.flatMap(skill => [skill.bundle, ...(skill.repository ? [skill.repository.bundle] : [])])]) {
  if (!/^[a-f0-9]{64}$/.test(asset.digest) || !/^[a-f0-9]{64}$/.test(asset.manifestDigest)) fail();
  const previous = assets.get(asset.digest);
  if (previous && (previous.rootPath !== asset.rootPath || previous.manifestDigest !== asset.manifestDigest || previous.fileCount !== asset.fileCount || previous.totalBytes !== asset.totalBytes)) fail();
  assets.set(asset.digest, asset);
}
function verify(root, files) {
  if (path.resolve(root) === workspace) fail();
  directory(root); const expected = new Map(files.map(file => [file.path, file])); const seen = new Set();
  function walk(relative = "") {
    for (const name of fs.readdirSync(path.join(root, relative))) {
      const child = relative ? relative + "/" + name : name, file = path.join(root, child), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) { if (!files.some(entry => entry.path.startsWith(child + "/"))) fail(); walk(child); continue; }
      const entry = expected.get(child);
      if (!entry || !stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o555) !== entry.mode)) fail();
      const bytes = read(file, 64 * 1024 * 1024);
      if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) fail();
      seen.add(child);
    }
  }
  walk(); if (seen.size !== expected.size) fail();
}
for (const asset of assets.values()) {
  const bytes = read(path.join(path.dirname(path.dirname(asset.rootPath)), "manifests", asset.digest + ".json"), 64 * 1024 * 1024);
  if (hash(bytes) !== asset.manifestDigest) fail();
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== "paperclip.runtime-asset-manifest.v1" || manifest.digest !== asset.digest || !Array.isArray(manifest.files)
    || manifest.files.length !== asset.fileCount || manifest.files.length > 10000 || manifest.fileCount !== asset.fileCount
    || manifest.totalBytes !== asset.totalBytes || manifest.files.reduce((n, file) => n + file.size, 0) !== asset.totalBytes
    || asset.totalBytes > 64 * 1024 * 1024 || hash(JSON.stringify(manifest.files)) !== asset.digest) fail();
  for (const file of manifest.files) if (typeof file.path !== "string" || /[\\\\:\\0]/.test(file.path) || file.path.split("/").some(part => !part || part === "." || part === "..")) fail();
  verify(asset.rootPath, manifest.files); manifests.set(asset.digest, manifest.files);
}
directory(home);
for (const skill of context.skills) {
  if (typeof skill.runtimeName !== "string" || /[\\\\:\\0]/.test(skill.runtimeName) || skill.runtimeName.split("/").some(part => !part || part === "." || part === "..")) fail();
  verify(path.join(home, "skills", skill.runtimeName), manifests.get(skill.bundle.digest));
  if (skill.repository && path.resolve(skill.repository.bundle.rootPath) !== path.join(home, "repositories", skill.repository.bundle.digest)) fail();
}
})();
`;
