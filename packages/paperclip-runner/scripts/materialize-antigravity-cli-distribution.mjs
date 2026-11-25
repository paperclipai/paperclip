import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { openOwnedFile, ownedDestination, ownedDirectory, readOwnedFile } from "./materialize-antigravity-distribution.mjs";

// Google's Antigravity CLI (`agy`): one signed Go executable in a versioned tar.gz.
// It has no patch point, so integrity is the pinned archive plus the pinned
// executable. It is fetched from Google at setup time and never redistributed.
const MANIFEST_PATH = fileURLToPath(new URL("../antigravity-cli-distributions.json", import.meta.url));
const MAX_ARCHIVE_BYTES = 192 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
export const ANTIGRAVITY_CLI_CLOSURE_MANIFEST = ".paperclip-antigravity-cli-closure.json";
const EXECUTABLE = "agy";
const ARCHIVE_MEMBER = "antigravity";
const SHA256 = /^[a-f0-9]{64}$/;
const SHA512 = /^[a-f0-9]{128}$/;
const NOTHING_INSTALLED = "Nothing was installed.";
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");

const invalidDeclaration = () => { throw new Error("Antigravity CLI distribution declaration is invalid"); };

/** Only the checked-in declaration selects the download and the executable bytes. */
export async function antigravityCliDistribution(platform = process.platform, architecture = process.arch) {
  const manifest = JSON.parse((await readOwnedFile(MANIFEST_PATH, 64 * 1024)).toString("utf8"));
  if (manifest.schema !== "paperclip.antigravity_cli_distribution.v1" || manifest.route !== "antigravity-cli"
    || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || typeof manifest.build !== "string" || !manifest.build.startsWith(`${manifest.version}-`) || !/^\d+\.\d+\.\d+-\d+$/.test(manifest.build)
    || !Array.isArray(manifest.args) || manifest.args.some(arg => typeof arg !== "string" || !/^[a-z][a-z0-9-]*$/.test(arg))
    || !isDeepStrictEqual(manifest.environment, { AGY_CLI_DISABLE_AUTO_UPDATE: "1" })) invalidDeclaration();
  const key = `${platform}-${architecture}`;
  const item = Object.hasOwn(manifest.platforms ?? {}, key) ? manifest.platforms[key] : undefined;
  if (!item) throw new Error(`The Antigravity CLI has no pinned distribution for ${platform}/${architecture}. Supported hosts: ${Object.keys(manifest.platforms ?? {}).join(", ")}.`);
  let url;
  try { url = new URL(item.url); } catch { invalidDeclaration(); }
  if (url.protocol !== "https:" || url.hostname !== "storage.googleapis.com" || url.port || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith(`/antigravity-public/antigravity-cli/${manifest.build}/`) || url.pathname.includes("..")) invalidDeclaration();
  const entries = item.entries;
  if (item.archiveFormat !== "tar.gz" || !Number.isSafeInteger(item.archiveSize) || item.archiveSize < 1 || item.archiveSize > MAX_ARCHIVE_BYTES
    || !SHA512.test(item.archiveSha512 ?? "") || !SHA256.test(item.archiveSha256 ?? "") || item.archiveMember !== ARCHIVE_MEMBER
    || item.executable !== EXECUTABLE || !SHA512.test(item.executableSha512 ?? "") || !SHA256.test(item.closureSha256 ?? "")
    || !Array.isArray(entries) || entries.length !== 1 || !isDeepStrictEqual(Object.keys(entries[0] ?? {}), ["path", "sha256", "size", "executable"])
    || entries[0].path !== EXECUTABLE || !SHA256.test(entries[0].sha256) || !Number.isSafeInteger(entries[0].size)
    || entries[0].size < 1 || entries[0].size > MAX_EXECUTABLE_BYTES || entries[0].executable !== true
    || hash("sha256", JSON.stringify(entries)) !== item.closureSha256) invalidDeclaration();
  return { ...item, version: manifest.version, build: manifest.build, args: [...manifest.args], environment: { ...manifest.environment }, platform, architecture };
}

function octal(field) {
  const text = field.toString("latin1").replace(/[\0 ]+$/, "").replace(/^ +/, "");
  if (!/^[0-7]{1,12}$/.test(text)) return -1;
  return Number.parseInt(text, 8);
}

/**
 * Strictly read Google's single-member tar: one regular executable named
 * `antigravity`, no links, no other members, and only zero blocks after it.
 */
export function antigravityCliArchiveExecutable(archive, distribution) {
  const invalid = () => { throw new Error(`The Antigravity CLI archive has unexpected contents. ${NOTHING_INSTALLED}`); };
  if (!Buffer.isBuffer(archive) || archive.length < 512 + 1024 || archive.length % 512) invalid();
  const header = archive.subarray(0, 512);
  const nameEnd = header.indexOf(0);
  if (nameEnd < 1 || nameEnd > 100 || header.subarray(0, nameEnd).toString("utf8") !== distribution.archiveMember || header.subarray(nameEnd, 100).some(byte => byte !== 0)) invalid();
  let sum = 0;
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : header[index];
  const mode = octal(header.subarray(100, 108));
  const magic = header.subarray(257, 265).toString("latin1");
  if (octal(header.subarray(148, 156)) !== sum || ![0x30, 0].includes(header[156]) || header.subarray(157, 257).some(byte => byte !== 0)
    || (magic !== "ustar  \0" && magic !== "ustar\x0000") || mode < 0 || (mode & 0o7000) || (mode & 0o111) !== 0o111) invalid();
  // The size is checked against the pin by the caller's digest comparison.
  const size = octal(header.subarray(124, 136));
  if (size < 1 || size > MAX_EXECUTABLE_BYTES) invalid();
  const end = 512 + Math.ceil(size / 512) * 512;
  if (archive.length < end + 1024 || archive.subarray(512 + size).some(byte => byte !== 0)) invalid();
  return archive.subarray(512, 512 + size);
}

async function readArchive(distribution, options) {
  const mismatch = received => new Error(`The Antigravity CLI download is not the pinned ${distribution.build} archive for ${distribution.platform}-${distribution.architecture} (expected ${distribution.archiveSize} bytes, received ${received}). ${NOTHING_INSTALLED}`);
  if (options.archivePath) {
    const archive = await readOwnedFile(options.archivePath, MAX_ARCHIVE_BYTES).catch(error => {
      if (/size limit/.test(error.message)) throw mismatch("more");
      throw error;
    });
    if (archive.length !== distribution.archiveSize) throw mismatch(archive.length);
    return archive;
  }
  const response = await (options.fetch ?? fetch)(distribution.url, { redirect: "error", signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`The Antigravity CLI download failed (HTTP ${response.status}). ${NOTHING_INSTALLED}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    // Stop as soon as the body exceeds the pinned size; never buffer more.
    if (length > distribution.archiveSize) throw mismatch(`more than ${distribution.archiveSize}`);
    chunks.push(chunk);
  }
  if (length !== distribution.archiveSize) throw mismatch(length);
  return Buffer.concat(chunks);
}

function closureRecord(distribution, entries) {
  return { schema: "paperclip.antigravity_cli_closure.v1", version: distribution.version, build: distribution.build,
    archiveSha512: distribution.archiveSha512, closureSha256: distribution.closureSha256, entries };
}

/** Hash the installed executable; the cached record never establishes trust. */
export async function verifyAntigravityCliDistribution(directory, distribution) {
  distribution ??= await antigravityCliDistribution();
  const pinned = await antigravityCliDistribution(distribution.platform, distribution.architecture);
  if (!isDeepStrictEqual(distribution, pinned)) throw new Error("Antigravity CLI verification requires the checked-in distribution pins");
  directory = (await ownedDirectory(directory, { privateRoot: true })).directory;
  const names = (await readdir(directory)).sort();
  if (!isDeepStrictEqual(names, [ANTIGRAVITY_CLI_CLOSURE_MANIFEST, EXECUTABLE])) throw new Error("The Antigravity CLI installation must contain exactly its executable and closure record");
  const { file, before } = await openOwnedFile(join(directory, EXECUTABLE), MAX_EXECUTABLE_BYTES);
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) { sha256.update(chunk); sha512.update(chunk); size += chunk.length; }
    const after = await file.stat();
    if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || size !== after.size) throw new Error("The Antigravity CLI executable changed while it was verified");
    if ((after.mode & 0o777) !== 0o500) throw new Error("The Antigravity CLI executable has unexpected permissions");
  } finally { await file.close(); }
  const entries = [{ path: EXECUTABLE, sha256: sha256.digest("hex"), size, executable: true }];
  if (!isDeepStrictEqual(entries, pinned.entries) || sha512.digest("hex") !== pinned.executableSha512) throw new Error(`The installed Antigravity CLI does not match the pinned executable for ${pinned.build}`);
  const record = JSON.parse((await readOwnedFile(join(directory, ANTIGRAVITY_CLI_CLOSURE_MANIFEST), 64 * 1024)).toString("utf8"));
  if (!isDeepStrictEqual(record, closureRecord(pinned, entries))) throw new Error("The Antigravity CLI closure record does not match the checked-in pins");
  return { entries, sha256: pinned.closureSha256 };
}

/** Explicit setup only: download (or read) the pinned archive, verify, extract, verify, publish. */
export async function materializePinnedAntigravityCliDistribution(options = {}) {
  const distribution = await antigravityCliDistribution(options.platform, options.architecture);
  if (!options.destination) throw new Error("Antigravity CLI materialization requires an explicit destination");
  const destination = await ownedDestination(resolve(options.destination));
  const parent = await ownedDirectory(dirname(destination));
  try { await lstat(destination); throw new Error("Antigravity CLI destination already exists; refusing to overwrite it"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let archive = await readArchive(distribution, options);
  if (hash("sha512", archive) !== distribution.archiveSha512 || hash("sha256", archive) !== distribution.archiveSha256) {
    throw new Error(`The Antigravity CLI download does not match its pinned SHA-512 digest for ${distribution.build} (${distribution.platform}-${distribution.architecture}). ${NOTHING_INSTALLED}`);
  }
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: distribution.entries[0].size + 64 * 1024 }); }
  catch { throw new Error(`The Antigravity CLI archive has unexpected contents. ${NOTHING_INSTALLED}`); }
  archive = undefined;
  const content = antigravityCliArchiveExecutable(tar, distribution);
  const entries = [{ path: EXECUTABLE, sha256: hash("sha256", content), size: content.length, executable: true }];
  if (!isDeepStrictEqual(entries, distribution.entries) || hash("sha512", content) !== distribution.executableSha512) {
    throw new Error(`The Antigravity CLI executable does not match its pinned digest for ${distribution.build}. ${NOTHING_INSTALLED}`);
  }
  const temporary = await mkdtemp(join(dirname(destination), ".antigravity-cli-install-"));
  try {
    const staged = join(temporary, "runtime");
    await mkdir(staged, { mode: 0o700 });
    await writeFile(join(staged, EXECUTABLE), content, { mode: 0o500, flag: "wx" });
    await writeFile(join(staged, ANTIGRAVITY_CLI_CLOSURE_MANIFEST), `${JSON.stringify(closureRecord(distribution, entries))}\n`, { mode: 0o400, flag: "wx" });
    await chmod(join(staged, EXECUTABLE), 0o500);
    await verifyAntigravityCliDistribution(staged, distribution);
    const currentParent = await ownedDirectory(dirname(destination));
    if (currentParent.stat.dev !== parent.stat.dev || currentParent.stat.ino !== parent.stat.ino) throw new Error("Antigravity CLI cache parent changed before publication");
    await rename(staged, destination);
    return { ...distribution, destination, executable: join(destination, EXECUTABLE) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1]?.endsWith("/materialize-antigravity-cli-distribution.mjs") && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [destination, platform, architecture, archivePath] = process.argv.slice(2);
  materializePinnedAntigravityCliDistribution({ destination, platform, architecture, archivePath }).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
