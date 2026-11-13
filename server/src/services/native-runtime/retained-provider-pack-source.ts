import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import tar from "tar-stream";
import { canonicalProviderPackJson, type ProviderPackIdentity } from "./remote-provider-pack-verification.js";
import { readProviderPackArchive } from "./provider-pack-archive.js";
import { MAX_RETAINED_PACK_BYTES, receiveRetainedProviderPack, type RetainedPackProvenance } from "./retained-provider-pack-oci.js";

type Source = { root: string; archiveOnly: true };
type ImportJob = { operation: Promise<Source>; controller: AbortController; waiters: number };
const pending = new Map<string, ImportJob>();
const waiting = new Set<() => void>();
let activeImports = 0;
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function fail(): never { throw Error("runner_remote_provider_source_invalid"); }
const maximumMetadata = 1024 * 1024;
type Published = RetainedPackProvenance & { entry: string; receiptSha256: string; verifiedTarPaths: true };
const safeName = (value: string) => value.length > 0 && Buffer.byteLength(value) <= 4096 && !/[\\\u0000-\u001f\u007f]/u.test(value)
  && !value.startsWith("/") && value.split("/").every(part => part !== "" && part !== "." && part !== "..");

async function waitForSource<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stopped!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    stopped = () => reject(signal.reason);
    signal.addEventListener("abort", stopped, { once: true });
    if (signal.aborted) stopped();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", stopped); }
}

async function importSlot(signal: AbortSignal) {
  while (activeImports >= 2) {
    let resume!: () => void;
    const available = new Promise<void>(done => { resume = done; waiting.add(done); });
    try { await waitForSource(available, signal); }
    finally { waiting.delete(resume); }
  }
  signal.throwIfAborted();
  activeImports++;
  return () => { activeImports--; for (const resume of waiting) resume(); };
}

async function readStable(path: string, maximum = maximumMetadata) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maximum) fail();
    const bytes = await file.readFile();
    const after = await file.stat();
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
    return bytes;
  } finally { await file.close(); }
}

async function regularDigest(path: string, expected: { sha256: string; bytes: number }, signal: AbortSignal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== expected.bytes) fail();
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) { bytes += chunk.length; hash.update(chunk); }
    const after = await file.stat();
    if (bytes !== before.size || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || hash.digest("hex") !== expected.sha256) fail();
  } finally { await file.close(); }
}

async function selectedArchive(root: string, manifest: ProviderPackIdentity, signal: AbortSignal) {
  signal.throwIfAborted();
  const value = JSON.parse((await readStable(join(root, "provider-pack.json"))).toString()) as ProviderPackIdentity;
  if (canonicalProviderPackJson(value) !== canonicalProviderPackJson(manifest)) fail();
  const archive = await readProviderPackArchive(root, manifest.digest, signal);
  if (!archive || !("kind" in archive)) fail();
  const names = ["overlay.tar.zst", ...archive.files.map((_file, index) => `${index}.tar.zst`)];
  if (canonicalProviderPackJson((await readdir(archive.sourceRoot)).sort()) !== canonicalProviderPackJson(names.sort())) fail();
  let bytes = archive.overlay.bytes;
  for (const [index, file] of archive.files.entries()) {
    signal.throwIfAborted();
    bytes += file.archive.bytes;
    if (bytes > MAX_RETAINED_PACK_BYTES) fail();
    await regularDigest(join(archive.sourceRoot, `${index}.tar.zst`), file.archive, signal);
  }
  signal.throwIfAborted();
  return archive;
}

async function extractManifest(root: string, manifest: ProviderPackIdentity, signal: AbortSignal) {
  const source = await readProviderPackArchive(root, manifest.digest, signal);
  if (!source || !("kind" in source)) fail();
  const regular = new Set(source.files.map(file => file.path));
  const archive = tar.extract();
  const names = new Set<string>(), files = new Set<string>(), links = new Map<string, string>();
  let bytes = 0, count = 0;
  let found: Buffer | undefined;
  archive.on("entry", (header, body, next) => {
    body.on("error", () => undefined);
    void (async () => {
      signal.throwIfAborted();
      if (++count > 100_000) fail();
      const normalized = header.name.replace(/^\.\//u, "");
      const name = header.type === "directory" ? normalized.replace(/\/$/u, "") : normalized;
      if (!safeName(name) || names.has(name) || !["file", "directory", "symlink", "link"].includes(header.type ?? "")
        || !Number.isSafeInteger(header.size ?? 0) || (header.size ?? 0) < 0 || ((header.mode ?? 0) & ~0o777) !== 0) fail();
      names.add(name);
      if (header.type !== "directory") files.add(name);
      if (header.type === "link") {
        const target = header.linkname?.replace(/^\.\//u, "");
        if (!target || !safeName(target) || !regular.has(target)) fail();
        regular.add(name);
      } else if (header.type === "file") regular.add(name);
      if (header.type === "symlink") {
        if (!header.linkname || header.linkname.startsWith("/") || /[\\\u0000-\u001f\u007f]/u.test(header.linkname) || Buffer.byteLength(header.linkname) > 4096) fail();
        links.set(name, header.linkname);
      }
      if (name !== "provider-pack.json") { body.resume(); return; }
      if (found || header.type !== "file" || !Number.isSafeInteger(header.size) || header.size! > maximumMetadata) fail();
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        bytes += chunk.length;
        if (bytes > maximumMetadata) fail();
        chunks.push(Buffer.from(chunk));
      }
      found = Buffer.concat(chunks);
    })().then(() => next(), error => archive.destroy(error));
  });
  let expanded = 0;
  const bound = new Transform({ transform(chunk, _encoding, done) {
    expanded += chunk.length;
    done(expanded > MAX_RETAINED_PACK_BYTES ? Error("runner_remote_provider_source_size_limit") : null, chunk);
  } });
  await pipeline(createReadStream(root + ".archives/overlay.tar.zst"), createZstdDecompress(), bound, archive, { signal });
  for (const name of names) {
    let parent = name;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (files.has(parent)) fail();
    }
  }
  for (const [name, target] of links) {
    let parts = [...name.split("/").slice(0, -1), ...target.split("/")];
    for (let followed = 0; ; followed++) {
      if (followed > 32) fail();
      const resolved: string[] = [];
      let changed = false;
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        if (part === "" || part === ".") continue;
        if (part === "..") { if (!resolved.length) fail(); resolved.pop(); continue; }
        resolved.push(part);
        const link = links.get(resolved.join("/"));
        if (link !== undefined) { parts = [...resolved.slice(0, -1), ...link.split("/"), ...parts.slice(index + 1)]; changed = true; break; }
      }
      if (!changed) break;
    }
  }
  if (!found || canonicalProviderPackJson(JSON.parse(found.toString())) !== canonicalProviderPackJson(manifest)) fail();
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "provider-pack.json"), found, { flag: "wx", mode: 0o600 });
  return { expanded, files };
}

async function verifyFileContents(archivePath: string, file: { path: string; bytes: number; sha256: string; mode: number }, signal: AbortSignal) {
  const archive = tar.extract();
  let found = false, count = 0;
  archive.on("entry", (header, body, next) => {
    body.on("error", () => undefined);
    void (async () => {
      signal.throwIfAborted();
      const normalized = header.name.replace(/^\.\//u, "");
      const name = header.type === "directory" ? normalized.replace(/\/$/u, "") : normalized;
      if (++count > 128 || !safeName(name)) fail();
      if (header.type === "directory" && file.path.startsWith(name + "/")) { body.resume(); return; }
      if (found || header.type !== "file" || name !== file.path || header.size !== file.bytes || header.mode !== file.mode) fail();
      found = true;
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of body) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > file.bytes) fail();
        hash.update(chunk);
      }
      if (bytes !== file.bytes || hash.digest("hex") !== file.sha256) fail();
    })().then(() => next(), error => archive.destroy(error));
  });
  let expanded = 0;
  const bound = new Transform({ transform(chunk, _encoding, done) {
    expanded += chunk.length;
    done(expanded > file.bytes + 2 * 1024 * 1024 ? Error("runner_remote_provider_source_size_limit") : null, chunk);
  } });
  await pipeline(createReadStream(archivePath), createZstdDecompress(), bound, archive, { signal });
  if (!found) fail();
}

async function privateDirectory(root: string) {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) fail();
}

async function cached(cache: string, pointer: string, manifest: ProviderPackIdentity, signal: AbortSignal) {
  let bytes: Buffer;
  try { bytes = await readStable(pointer); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const publication = JSON.parse(bytes.toString()) as Published;
  if (publication.schema !== "paperclip.retained-provider-pack-source.v1" || publication.verifiedTarPaths !== true || publication.providerPackDigest !== manifest.digest
    || publication.sourceRevision !== manifest.payload.runnerSourceRevision || !new RegExp(`^${manifest.digest.slice(7)}-[A-Za-z0-9]{6}$`).test(publication.entry)
    || !/^[a-f0-9]{64}$/.test(publication.receiptSha256)
    || [publication.imageIndexDigest, publication.imageManifestDigest, publication.imageConfigDigest, publication.transportLayerDigest].some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) fail();
  const directory = join(cache, publication.entry);
  await privateDirectory(directory);
  const root = join(directory, "provider-pack");
  await privateDirectory(root);
  if (digest(await readStable(root + ".archive.json")) !== publication.receiptSha256) fail();
  await selectedArchive(root, manifest, signal);
  return { root, archiveOnly: true as const };
}

async function importSource(cache: string, pointer: string, manifest: ProviderPackIdentity, signal: AbortSignal) {
  const space = await statfs(cache, { bigint: true });
  if (space.bavail * space.bsize < BigInt(2 * MAX_RETAINED_PACK_BYTES + 1024 ** 3)) throw Error("runner_remote_provider_source_disk_headroom_required");
  const directory = await mkdtemp(join(cache, manifest.digest.slice(7) + "-"));
  const temporaryPointer = join(cache, `.${randomUUID()}.pending`);
  let published = false;
  try {
    const provenance = await receiveRetainedProviderPack({ manifest, directory, signal });
    const root = join(directory, "provider-pack");
    const overlay = await extractManifest(root, manifest, signal);
    const archive = await selectedArchive(root, manifest, signal);
    let expanded = overlay.expanded;
    for (const [index, file] of archive.files.entries()) {
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || (expanded += file.bytes) > MAX_RETAINED_PACK_BYTES || overlay.files.has(file.path)) fail();
      let parent = file.path;
      while (parent.includes("/")) { parent = parent.slice(0, parent.lastIndexOf("/")); if (overlay.files.has(parent)) fail(); }
      await verifyFileContents(join(archive.sourceRoot, `${index}.tar.zst`), file, signal);
    }
    signal.throwIfAborted();
    const publication: Published = { ...provenance, entry: basename(directory), receiptSha256: digest(await readStable(root + ".archive.json")), verifiedTarPaths: true };
    await writeFile(temporaryPointer, JSON.stringify(publication), { flag: "wx", mode: 0o600 });
    signal.throwIfAborted();
    try {
      await link(temporaryPointer, pointer);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = await cached(cache, pointer, manifest, signal);
      if (!winner) fail();
      return winner;
    }
    return { root, archiveOnly: true as const };
  } finally {
    await rm(temporaryPointer, { force: true });
    if (!published) await rm(directory, { recursive: true, force: true });
  }
}

export async function resolveProviderPackUploadSource(input: {
  root: string;
  sourceDigest?: string;
  manifest: ProviderPackIdentity;
  signal?: AbortSignal;
}): Promise<{ root: string; archiveOnly: boolean }> {
  const manifest = input.manifest;
  if (manifest?.schema !== "paperclip-runner/remote-provider-pack/v1" || manifest.digest !== `sha256:${digest(canonicalProviderPackJson(manifest.payload))}`) fail();
  input.signal?.throwIfAborted();
  const configured = JSON.parse((await readStable(join(input.root, "provider-pack.json"))).toString()) as ProviderPackIdentity;
  if (configured?.schema !== manifest.schema || configured.digest !== `sha256:${digest(canonicalProviderPackJson(configured.payload))}`
    || input.sourceDigest !== undefined && input.sourceDigest !== configured.digest) fail();
  if (configured.digest === manifest.digest) return { root: input.root, archiveOnly: false };
  const cache = join(await realpath(tmpdir()), `paperclip-provider-pack-sources-${process.getuid?.()}`);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await privateDirectory(cache);
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
  const pointer = join(cache, manifest.digest.slice(7) + ".json");
  const key = `${cache}:${manifest.digest}`;
  let job = pending.get(key);
  if (!job || job.controller.signal.aborted) {
    if (pending.size >= 32) throw Error("runner_remote_provider_source_import_busy");
    const controller = new AbortController();
    const sharedSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    let created!: ImportJob;
    const operation = (async () => {
      const release = await importSlot(sharedSignal);
      try { return await cached(cache, pointer, manifest, sharedSignal) ?? await importSource(cache, pointer, manifest, sharedSignal); }
      finally { release(); }
    })().finally(() => { if (pending.get(key) === created) pending.delete(key); });
    job = created = { operation, controller, waiters: 0 };
    pending.set(key, job);
  }
  job.waiters++;
  try {
    const source = await waitForSource(job.operation, signal);
    signal.throwIfAborted();
    return source;
  } finally {
    job.waiters--;
    if (job.waiters === 0 && pending.get(key) === job) job.controller.abort(new DOMException("provider source no longer requested", "AbortError"));
  }
}
