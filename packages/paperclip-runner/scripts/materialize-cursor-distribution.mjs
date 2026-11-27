import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyCursorRuntimePatch, CURSOR_RUNTIME_PATCH_VERSION } from "./cursor-runtime-patch.mjs";

const MANIFEST_PATH = fileURLToPath(new URL("../cursor-distributions.json", import.meta.url));
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_TREE_BYTES = 1024 * 1024 * 1024;
const TREE_MANIFEST = ".paperclip-cursor-closure.json";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export async function cursorDistribution(platform = process.platform, architecture = process.arch) {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const distribution = manifest.platforms[`${platform}-${architecture}`];
  if (!distribution) throw new Error(`Cursor has no pinned distribution for ${platform}/${architecture}`);
  if (manifest.patchVersion !== CURSOR_RUNTIME_PATCH_VERSION || !/^[a-f0-9]{64}$/.test(distribution.vendorClosureSha256)) throw new Error("Cursor distribution must pin its owned runtime patch and vendor closure");
  return { ...distribution, version: manifest.version, patchVersion: manifest.patchVersion, platform, architecture };
}

/** Hash every runtime file, including bundled Node, native addons and workers. */
export async function cursorDistributionClosure(directory) {
  const entries = [];
  let bytes = 0;
  async function walk(root, prefix = "") {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Cursor closure contains a linked or non-directory root");
    for (const name of (await readdir(root)).sort()) {
      if (prefix === "" && name === TREE_MANIFEST) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new Error("Cursor closure contains an unsafe path");
      const absolute = join(root, name);
      const before = await lstat(absolute);
      if (before.isDirectory()) await walk(absolute, path);
      else {
        if (!before.isFile() || before.nlink !== 1) throw new Error("Cursor closure contains links or special files");
        bytes += before.size;
        if (bytes > MAX_TREE_BYTES || entries.length >= 10_000) throw new Error("Cursor closure exceeds size limits");
        const source = await readFile(absolute);
        const after = await lstat(absolute);
        if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || source.length !== after.size || !after.isFile()) throw new Error("Cursor closure changed while being hashed");
        entries.push({ path, sha256: digest(source), size: source.length, executable: Boolean(after.mode & 0o111) });
      }
    }
  }
  await walk(directory);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { entries, sha256: digest(JSON.stringify(entries)) };
}

export async function verifyCursorDistribution(directory, distribution) {
  const closure = await cursorDistributionClosure(directory);
  if (closure.sha256 !== distribution.closureSha256) throw new Error("Cursor full execution closure digest mismatch");
  for (const required of [distribution.executable, distribution.entrypoint]) {
    if (!closure.entries.some(entry => entry.path === required)) throw new Error("Cursor execution closure is missing its entrypoint");
  }
  return closure;
}

/** A pinned archive only; never runs the vendor installer or discovers PATH. */
export async function materializePinnedCursorDistribution(options = {}) {
  const distribution = await cursorDistribution(options.platform, options.architecture);
  if (!options.destination) throw new Error("Cursor materialization requires an explicit destination");
  const destination = resolve(options.destination);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await lstat(destination);
    throw new Error("Cursor destination already exists; refusing to overwrite it");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = await mkdtemp(join(dirname(destination), ".cursor-install-"));
  try {
    let archive;
    if (options.archivePath) {
      const stat = await lstat(options.archivePath);
      if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) throw new Error("Cursor archive must be a bounded regular file");
      archive = await readFile(options.archivePath);
    } else {
      const response = await fetch(distribution.url, { redirect: "error", signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`Cursor archive download failed: ${response.status}`);
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > MAX_ARCHIVE_BYTES) throw new Error("Cursor archive download exceeds size limit");
        chunks.push(chunk);
      }
      archive = Buffer.concat(chunks);
    }
    if (digest(archive) !== distribution.archiveSha256) throw new Error("Cursor archive digest mismatch");
    const archivePath = join(temporary, "archive.tar.gz");
    const unpacked = join(temporary, "unpacked");
    await writeFile(archivePath, archive, { mode: 0o600 });
    await mkdir(unpacked, { mode: 0o700 });
    // Only authenticated vendor archive bytes reach tar. Inspect entries first;
    // links/special files are forbidden, and every path shares one fixed root.
    for (const flag of ["-tzf", "-tvzf"]) {
      const listing = spawnSync("/usr/bin/tar", [flag, archivePath], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      if (listing.status !== 0) throw new Error("Cursor archive listing failed");
      const lines = listing.stdout.trim().split("\n");
      if (flag === "-tzf" && lines.some(path => !path.startsWith("dist-package/") || path.split("/").includes("..") || /[\u0000-\u001f\u007f\\]/.test(path))) throw new Error("Cursor archive contains unsafe paths");
      if (flag === "-tvzf" && lines.some(line => !["-", "d"].includes(line[0]))) throw new Error("Cursor archive contains links or special entries");
    }
    const extraction = spawnSync("/usr/bin/tar", ["-xzf", archivePath, "-C", unpacked, "--no-same-owner"], { encoding: "utf8", timeout: 120_000 });
    if (extraction.status !== 0) throw new Error("Cursor archive extraction failed");
    const packageRoot = join(unpacked, "dist-package");
    await verifyCursorDistribution(packageRoot, { ...distribution, closureSha256: distribution.vendorClosureSha256 });
    await applyCursorRuntimePatch(packageRoot, `${distribution.platform}-${distribution.architecture}`);
    const closure = await verifyCursorDistribution(packageRoot, distribution);
    // Record the pinned inventory for a later runtime lease. Its digest must be
    // checked against the checked-in distribution pin before trusting entries.
    await writeFile(join(packageRoot, TREE_MANIFEST), `${JSON.stringify({ schema: "paperclip.cursor_closure.v1", ...distribution, entries: closure.entries })}\n`, { mode: 0o600 });
    for (const entry of closure.entries) await chmod(join(packageRoot, ...entry.path.split("/")), entry.executable ? 0o500 : 0o400);
    await chmod(packageRoot, 0o700);
    await rename(packageRoot, destination);
    return { version: distribution.version, patchVersion: distribution.patchVersion, platform: distribution.platform, architecture: distribution.architecture, destination, executable: join(destination, distribution.executable), entrypoint: join(destination, distribution.entrypoint), archiveSha256: distribution.archiveSha256, closureSha256: closure.sha256 };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1]?.endsWith("/materialize-cursor-distribution.mjs") && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [destination, platform, architecture, archivePath] = process.argv.slice(2);
  materializePinnedCursorDistribution({ destination, platform, architecture, archivePath }).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
