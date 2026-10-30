import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { inflateRawSync } from "node:zlib";
import { ANTIGRAVITY_PATCH_VERSION, patchAntigravityRuntime } from "./patch-antigravity-runtime.mjs";

const MANIFEST_PATH = fileURLToPath(new URL("../antigravity-distributions.json", import.meta.url));
const ADMISSION_SOURCE_PATH = fileURLToPath(new URL("./patch-antigravity-runtime.admission.py", import.meta.url));
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_TREE_BYTES = 1024 * 1024 * 1024;
export const ANTIGRAVITY_TREE_MANIFEST = ".paperclip-antigravity-closure.json";
const RUNTIME_FILES = ["agy_acp_server.par", "localharness_external"];
const SHA256 = /^[a-f0-9]{64}$/;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function assertTrustedOwner(stat) {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || !Number.isInteger(stat.uid) || (stat.uid !== uid && stat.uid !== 0)) {
    throw new Error("Antigravity assets have an untrusted filesystem owner");
  }
}

/** Resolve parent aliases once, then use only the checked canonical path.
 * A root-owned sticky temporary directory protects each owned child entry. */
async function ownedDirectory(directory, { privateRoot = false, parentAlias = false } = {}) {
  const original = await lstat(directory);
  if ((!original.isDirectory() || original.isSymbolicLink()) && !(parentAlias && original.isSymbolicLink())) {
    throw new Error("Antigravity closure must be a real directory with private write access");
  }
  const canonical = await realpath(directory);
  let current = canonical;
  let root;
  while (true) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Antigravity assets have an unsafe ancestor directory");
    assertTrustedOwner(stat);
    if (!root) root = stat;
    const trustedSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if ((stat.mode & 0o022) && !(trustedSticky && !(privateRoot && current === canonical))) {
      throw new Error("Antigravity assets have an unsafe ancestor with shared write access; closures require private write access");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!original.isSymbolicLink() && (root.dev !== original.dev || root.ino !== original.ino)) {
    throw new Error("Antigravity asset directory changed during ownership verification");
  }
  return { directory: canonical, stat: root };
}

function assertOwnedFile(stat, maximum) {
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Antigravity closure contains links or special files");
  assertTrustedOwner(stat);
  if (stat.mode & 0o7022) throw new Error("Antigravity closure contains unsafe file permissions");
  if (stat.size > maximum) throw new Error("Antigravity asset exceeds its file size limit");
}

async function openOwnedFile(path, maximum) {
  const parent = await ownedDirectory(dirname(path), { parentAlias: true });
  const canonical = join(parent.directory, basename(path));
  const before = await lstat(canonical);
  assertOwnedFile(before, maximum);
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    assertOwnedFile(stat, maximum);
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("Antigravity asset changed while opening");
    return { file, path: canonical, before: stat };
  } catch (error) { await file.close(); throw error; }
}

async function readOwnedFile(path, maximum) {
  const { file, before } = await openOwnedFile(path, maximum);
  try {
    const bytes = await file.readFile();
    const after = await file.stat();
    assertOwnedFile(after, maximum);
    if (bytes.length > maximum || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Antigravity asset changed while reading");
    }
    return bytes;
  } finally { await file.close(); }
}

/** Reject an unsafe existing ancestor before creating even a staging directory. */
async function ownedDestination(destination) {
  const missing = [];
  let ancestor = dirname(destination);
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  let { directory } = await ownedDirectory(ancestor, { parentAlias: true });
  for (const name of missing.reverse()) {
    directory = join(directory, name);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    directory = (await ownedDirectory(directory)).directory;
  }
  return join(directory, basename(destination));
}

/** Only the checked-in declaration selects downloads and runtime contents. */
export async function antigravityDistribution(platform = process.platform, architecture = process.arch) {
  const manifest = JSON.parse((await readOwnedFile(MANIFEST_PATH, 64 * 1024)).toString("utf8"));
  const item = manifest.platforms?.[`${platform}-${architecture}`];
  if (manifest.schema !== "paperclip.antigravity_distribution.v1" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Invalid Antigravity distribution declaration");
  if (!item) throw new Error(`Antigravity has no pinned distribution for ${platform}/${architecture}`);
  if (item.provisioning !== "verified-closure") throw new Error(`Antigravity ${platform}/${architecture} is inventory-only; its complete runtime closure is not verified`);
  const url = new URL(item.url);
  if (url.protocol !== "https:" || url.hostname !== "dl.google.com" || url.username || url.password || url.search || url.hash || !url.pathname.startsWith("/agy-extensions/releases/")) throw new Error("Antigravity requires an official pinned distribution URL");
  if (!SHA256.test(item.archiveSha256) || !SHA256.test(item.closureSha256) || item.executable !== RUNTIME_FILES[0] || !Array.isArray(item.args) || item.args.some(arg => typeof arg !== "string")) throw new Error("Invalid Antigravity distribution pins");
  for (const [entries, sha256] of [[item.entries, item.closureSha256], [item.vendorEntries, item.vendorClosureSha256]]) {
    if (!Array.isArray(entries) || entries.length !== RUNTIME_FILES.length || entries.some((entry, index) => entry.path !== RUNTIME_FILES[index] || !SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.executable !== true) || digest(JSON.stringify(entries)) !== sha256) throw new Error("Invalid Antigravity complete execution closure pins");
  }
  if (item.patchVersion !== ANTIGRAVITY_PATCH_VERSION || !SHA256.test(item.admissionSourceSha256)) throw new Error("Antigravity distribution must pin its owned native admission patch");
  if (digest(await readOwnedFile(ADMISSION_SOURCE_PATH, 64 * 1024)) !== item.admissionSourceSha256) throw new Error("Antigravity native admission patch source digest mismatch");
  return { ...item, version: manifest.version, platform, architecture };
}

/** Hash both native binaries; a cached local manifest never establishes trust. */
export async function antigravityDistributionClosure(directory) {
  const root = await ownedDirectory(directory, { privateRoot: true });
  directory = root.directory;
  const names = (await readdir(directory)).sort();
  const files = names.filter(name => name !== ANTIGRAVITY_TREE_MANIFEST);
  if (JSON.stringify(files) !== JSON.stringify(RUNTIME_FILES)) throw new Error("Antigravity closure must contain exactly both native binaries");
  let bytes = 0;
  const entries = [];
  for (const name of names) {
    const path = join(directory, name);
    const maximum = name === ANTIGRAVITY_TREE_MANIFEST ? 64 * 1024 : MAX_TREE_BYTES;
    const { file, before } = await openOwnedFile(path, maximum);
    try {
      if (name === ANTIGRAVITY_TREE_MANIFEST) continue;
      bytes += before.size;
      if (bytes > MAX_TREE_BYTES) throw new Error("Antigravity closure exceeds size limit");
      const hash = createHash("sha256");
      let length = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) { hash.update(chunk); length += chunk.length; }
      const after = await file.stat();
      const current = await lstat(path);
      assertOwnedFile(after, maximum);
      if (before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || length !== after.size) throw new Error("Antigravity closure changed while being hashed");
      entries.push({ path: name, sha256: hash.digest("hex"), size: length, executable: Boolean(after.mode & 0o111) });
    } finally { await file.close(); }
  }
  const current = await ownedDirectory(directory, { privateRoot: true });
  if (current.stat.dev !== root.stat.dev || current.stat.ino !== root.stat.ino) throw new Error("Antigravity closure directory changed while being hashed");
  return { entries, sha256: digest(JSON.stringify(entries)) };
}

export async function verifyAntigravityDistribution(directory, distribution) {
  directory = (await ownedDirectory(directory, { privateRoot: true })).directory;
  const pinned = await antigravityDistribution(distribution?.platform, distribution?.architecture);
  if (distribution && !isDeepStrictEqual(distribution, pinned)) throw new Error("Antigravity runtime verification requires the checked-in distribution pins");
  const closure = await antigravityDistributionClosure(directory);
  if (closure.sha256 !== pinned.closureSha256) throw new Error("Antigravity full execution closure digest mismatch");
  const record = JSON.parse((await readOwnedFile(join(directory, ANTIGRAVITY_TREE_MANIFEST), 64 * 1024)).toString("utf8"));
  if (!isDeepStrictEqual(record, closureRecord(pinned, closure))) throw new Error("Antigravity cached closure record does not match the checked-in pins");
  return closure;
}

function closureRecord(distribution, closure) {
  return { schema: "paperclip.antigravity_closure.v1", version: distribution.version, patchVersion: distribution.patchVersion, admissionSourceSha256: distribution.admissionSourceSha256,
    archiveSha256: distribution.archiveSha256, vendorClosureSha256: distribution.vendorClosureSha256, closureSha256: distribution.closureSha256, entries: closure.entries };
}

/** Strictly inspect the known two-file ZIP before writing any vendor content. */
export function antigravityArchiveEntries(archive) {
  const invalid = () => { throw new Error("Antigravity archive contains unsafe or unsupported ZIP entries"); };
  if (!Buffer.isBuffer(archive) || archive.length < 22 || archive.length > MAX_ARCHIVE_BYTES) invalid();
  // The pinned vendor archive has no comment, ZIP64, spanning, or data descriptors.
  const end = archive.length - 22;
  if (archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || archive.readUInt16LE(end + 20)) invalid();
  const count = archive.readUInt16LE(end + 10);
  const centralSize = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);
  if (count !== 2 || archive.readUInt16LE(end + 8) !== count || centralOffset + centralSize !== end) invalid();
  let cursor = centralOffset;
  const entries = [];
  const spans = [];
  let bytes = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const mode = archive.readUInt32LE(cursor + 38) >>> 16;
    const local = archive.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || (flags & ~0x800) || ![0, 8].includes(method) || archive.readUInt16LE(cursor + 34) || (mode & 0o170000) !== 0o100000 || !(mode & 0o111)) invalid();
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const path = nameBytes.toString("utf8");
    if (!RUNTIME_FILES.includes(path) || !Buffer.from(path).equals(nameBytes) || entries.some(entry => entry.path === path)) invalid();
    if (local + 30 > centralOffset || archive.readUInt32LE(local) !== 0x04034b50 || archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method || archive.readUInt32LE(local + 14) !== archive.readUInt32LE(cursor + 16) || archive.readUInt32LE(local + 18) !== compressedSize || archive.readUInt32LE(local + 22) !== size) invalid();
    const localNameLength = archive.readUInt16LE(local + 26);
    const start = local + 30 + localNameLength + archive.readUInt16LE(local + 28);
    const finish = start + compressedSize;
    if (finish > centralOffset || !archive.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes) || spans.some(([a, b]) => local < b && finish > a)) invalid();
    bytes += size;
    if (!size || bytes > MAX_TREE_BYTES || (method === 0 && size !== compressedSize)) invalid();
    entries.push({ path, method, size, start, finish });
    spans.push([local, finish]);
    cursor = next;
  }
  if (cursor !== end || RUNTIME_FILES.some(path => !entries.some(entry => entry.path === path))) invalid();
  return entries;
}

/** Explicit setup only: no vendor installer, ambient binary, or npm lifecycle. */
export async function materializePinnedAntigravityDistribution(options = {}) {
  const distribution = await antigravityDistribution(options.platform, options.architecture);
  if (!options.destination) throw new Error("Antigravity materialization requires an explicit destination");
  const destination = await ownedDestination(resolve(options.destination));
  const parent = await ownedDirectory(dirname(destination));
  try { await lstat(destination); throw new Error("Antigravity destination already exists; refusing to overwrite it"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = await mkdtemp(join(dirname(destination), ".antigravity-install-"));
  try {
    let archive;
    if (options.archivePath) {
      archive = await readOwnedFile(options.archivePath, MAX_ARCHIVE_BYTES);
    } else {
      const response = await fetch(distribution.url, { redirect: "error", signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`Antigravity archive download failed: ${response.status}`);
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > MAX_ARCHIVE_BYTES) throw new Error("Antigravity archive download exceeds size limit");
        chunks.push(chunk);
      }
      archive = Buffer.concat(chunks);
    }
    if (digest(archive) !== distribution.archiveSha256) throw new Error("Antigravity archive digest mismatch");
    const entries = antigravityArchiveEntries(archive);
    const unpacked = join(temporary, "vendor");
    await mkdir(unpacked, { mode: 0o700 });
    for (const entry of entries) {
      const compressed = archive.subarray(entry.start, entry.finish);
      const content = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: entry.size });
      if (content.length !== entry.size) throw new Error("Antigravity archive entry size mismatch");
      await writeFile(join(unpacked, entry.path), content, { mode: 0o500, flag: "wx" });
    }
    const vendorClosure = await antigravityDistributionClosure(unpacked);
    if (vendorClosure.sha256 !== distribution.vendorClosureSha256) throw new Error("Antigravity vendor execution closure digest mismatch");
    const patched = join(temporary, "runtime");
    const patch = await patchAntigravityRuntime({ source: unpacked, destination: patched });
    if (patch.version !== distribution.patchVersion || patch.admissionSourceSha256 !== distribution.admissionSourceSha256) throw new Error("Antigravity native admission patch identity mismatch");
    const closure = await antigravityDistributionClosure(patched);
    if (closure.sha256 !== distribution.closureSha256) throw new Error("Antigravity full execution closure digest mismatch");
    await writeFile(join(patched, ANTIGRAVITY_TREE_MANIFEST), `${JSON.stringify(closureRecord(distribution, closure))}\n`, { mode: 0o400, flag: "wx" });
    for (const entry of closure.entries) await chmod(join(patched, entry.path), 0o500);
    const currentParent = await ownedDirectory(dirname(destination));
    if (currentParent.stat.dev !== parent.stat.dev || currentParent.stat.ino !== parent.stat.ino) throw new Error("Antigravity cache parent changed before publication");
    await rename(patched, destination);
    return { ...distribution, destination, executable: join(destination, distribution.executable) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1]?.endsWith("/materialize-antigravity-distribution.mjs") && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [destination, platform, architecture, archivePath] = process.argv.slice(2);
  materializePinnedAntigravityDistribution({ destination, platform, architecture, archivePath }).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
