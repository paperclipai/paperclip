import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NativeRuntimeAssetReference } from "../contracts/runtime-context.js";

type AssetFile = { path: string; sha256: string; mode: number; size: number };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fail(): never { throw new Error("native_runtime_asset_integrity_mismatch"); }
const MAX_BYTES = 64 * 1024 * 1024;

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\\<>:"|?*\u0000-\u001f\u007f]/u.test(value)
    && value.split("/").every(part => part && part !== "." && part !== ".." && !/[ .]$/.test(part)
      && !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part));
}

async function bytes(filename: string, max: number, exactSize?: number): Promise<Buffer> {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max || (exactSize !== undefined && before.size !== exactSize)) fail();
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail();
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail();
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function runtimeAssetManifest(asset: NativeRuntimeAssetReference): Promise<AssetFile[]> {
  if (!/^[a-f0-9]{64}$/.test(asset.digest) || !/^[a-f0-9]{64}$/.test(asset.manifestDigest)
    || asset.schema !== "paperclip.runtime-asset.v1") fail();
  const text = await bytes(join(dirname(dirname(asset.rootPath)), "manifests", `${asset.digest}.json`), MAX_BYTES);
  if (hash(text) !== asset.manifestDigest) fail();
  const manifest = JSON.parse(text.toString("utf8"));
  if (manifest.schema !== "paperclip.runtime-asset-manifest.v1" || manifest.digest !== asset.digest
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10_000
    || manifest.fileCount !== asset.fileCount || manifest.totalBytes !== asset.totalBytes
    || manifest.files.length !== asset.fileCount || hash(JSON.stringify(manifest.files)) !== asset.digest) fail();
  const names = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    if (!safePath(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0
      || !Number.isSafeInteger(file.mode) || file.mode < 0 || (file.mode & 0o555) !== file.mode) fail();
    const name = file.path.normalize("NFC").toLowerCase();
    if (names.has(name)) fail();
    names.add(name);
    total += file.size;
    if (total > MAX_BYTES) fail();
  }
  if (total !== asset.totalBytes) fail();
  return manifest.files;
}

/** Verify bytes on every platform; Windows timestamps never stand in for hashes. */
export async function verifyRuntimeAssetTree(root: string, files: AssetFile[], target?: string): Promise<void> {
  const expected = new Map(files.map(file => [file.path, file]));
  const seen = new Set<string>();
  const directories = new Set([""]);
  for (const file of files) {
    const segments = file.path.split("/"); segments.pop();
    while (segments.length) { directories.add(segments.join("/")); segments.pop(); }
  }
  async function visit(child = "") {
    const directory = join(root, child);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !directories.has(child)) fail();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = child ? `${child}/${entry.name}` : entry.name;
      const info = await lstat(join(root, name));
      if (info.isSymbolicLink()) fail();
      if (info.isDirectory()) { await visit(name); continue; }
      const file = expected.get(name);
      if (!file || !info.isFile() || (process.platform !== "win32" && (info.mode & 0o555) !== file.mode)) fail();
      const content = await bytes(join(root, name), MAX_BYTES, file.size);
      if (hash(content) !== file.sha256) fail();
      seen.add(name);
      if (target) {
        const destination = join(target, name);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content, { flag: "wx", mode: file.mode });
        await chmod(destination, file.mode);
      }
    }
  }
  await visit();
  if (seen.size !== expected.size) fail();
}

export async function copyVerifiedRuntimeAsset(asset: NativeRuntimeAssetReference, target: string): Promise<void> {
  const files = await runtimeAssetManifest(asset);
  await mkdir(target, { mode: 0o700, recursive: true });
  await verifyRuntimeAssetTree(asset.rootPath, files, target);
  await verifyRuntimeAssetTree(target, files);
}
