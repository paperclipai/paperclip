/**
 * Extracts the two controller inputs that must match a Daytona runner image
 * exactly, without Docker:
 *
 * - `/usr/local/bin/paperclip-runnerd` → PAPERCLIP_RUNNER_REMOTE_BINARY_PATH
 * - `/opt/paperclip-runner/provider-pack/` → PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH
 *
 * `skopeo copy` writes the linux/amd64 manifest, config and layer blobs to a
 * directory (no daemon). The layers are then walked from top to bottom,
 * honouring OCI whiteouts, and only those two paths are written out. The
 * result is cached by image digest and the layer blobs are deleted.
 *
 *   node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/daytona-image.ts <image@sha256:…>
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createGunzip, createZstdDecompress } from "node:zlib";
import type { Readable } from "node:stream";

const execFileAsync = promisify(execFile);

export const RUNNERD_PATH = "usr/local/bin/paperclip-runnerd";
export const PROVIDER_PACK_PATH = "opt/paperclip-runner/provider-pack";
export const CONTENT_ID_LABEL = "io.paperclip.runner.content-id";
export const REVISION_LABEL = "org.opencontainers.image.revision";
const RECEIPT_SCHEMA = "paperclip-restart-chaos/daytona-image-artifacts/v1";
const IMMUTABLE_IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:([0-9a-f]{64})$/;

// ---------------------------------------------------------------- tar reader

export type TarEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";
export interface TarEntry { path: string; type: TarEntryType; mode: number; size: number; linkTarget: string }

/** Buffered reader over an async byte stream. */
class ByteReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private ended = false;
  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(bytes: number) {
    while (this.length < bytes && !this.ended) {
      const next = await this.source.next();
      if (next.done) this.ended = true;
      else if (next.value.length) { this.chunks.push(next.value); this.length += next.value.length; }
    }
  }

  /** Exactly `bytes` bytes, or null at a clean end of stream. */
  async read(bytes: number): Promise<Buffer | null> {
    await this.fill(bytes);
    if (this.length === 0) return null;
    if (this.length < bytes) throw new Error("Truncated tar stream");
    const parts: Buffer[] = [];
    let needed = bytes;
    while (needed > 0) {
      const head = this.chunks[0]!;
      if (head.length <= needed) { parts.push(head); this.chunks.shift(); needed -= head.length; }
      else { parts.push(head.subarray(0, needed)); this.chunks[0] = head.subarray(needed); needed = 0; }
    }
    this.length -= bytes;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  /** Passes the next `bytes` bytes to `sink` without holding them all in memory. */
  async forward(bytes: number, sink: (chunk: Buffer) => Promise<void> | void): Promise<void> {
    let remaining = bytes;
    while (remaining > 0) {
      if (this.length === 0) await this.fill(1);
      if (this.length === 0) throw new Error("Truncated tar entry");
      const head = this.chunks[0]!;
      const take = Math.min(head.length, remaining);
      const part = take === head.length ? head : head.subarray(0, take);
      if (take === head.length) this.chunks.shift(); else this.chunks[0] = head.subarray(take);
      this.length -= take;
      remaining -= take;
      await sink(part);
    }
  }
}

const cString = (block: Buffer, start: number, end: number) => {
  const field = block.subarray(start, end);
  const nul = field.indexOf(0);
  return (nul === -1 ? field : field.subarray(0, nul)).toString("utf8");
};

function numeric(block: Buffer, start: number, end: number): number {
  const field = block.subarray(start, end);
  if (field[0]! & 0x80) {
    // GNU base-256: big-endian, high bit set on the first byte.
    let value = field[0]! & 0x7f;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + field[index]!;
    return value;
  }
  const text = cString(block, start, end).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(body.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("Malformed pax header");
    const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return out;
}

/** Normalized layer path: no leading `./` or `/`, no trailing `/`, no `..`. */
export function normalizeLayerPath(raw: string): string {
  const parts = raw.split("/").filter(part => part !== "" && part !== ".");
  if (parts.some(part => part === "..")) throw new Error(`Refusing layer path with "..": ${raw}`);
  return parts.join("/");
}

/**
 * Streams a tar archive. `onEntry` must either call `body.forward` once or
 * leave the body unread (it is skipped).
 */
export async function walkTar(source: AsyncIterable<Buffer>,
  onEntry: (entry: TarEntry, body: { forward(sink: (chunk: Buffer) => Promise<void> | void): Promise<void> }) => Promise<void>): Promise<void> {
  const reader = new ByteReader(source[Symbol.asyncIterator]());
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let longLink: string | null = null;
  for (;;) {
    const header = await reader.read(512);
    if (!header || header.every(byte => byte === 0)) return;
    const stored = numeric(header, 148, 156);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    if (sum !== stored) throw new Error("Tar header checksum mismatch");
    const typeflag = String.fromCharCode(header[156]!);
    const size = pax.size !== undefined ? Number(pax.size) : numeric(header, 124, 136);
    const padded = Math.ceil(size / 512) * 512;
    if (typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K") {
      const body = (await reader.read(padded)) ?? Buffer.alloc(0);
      const content = body.subarray(0, size);
      if (typeflag === "x") pax = { ...pax, ...parsePax(content) };
      else if (typeflag === "L") longName = cString(content, 0, content.length);
      else if (typeflag === "K") longLink = cString(content, 0, content.length);
      continue;
    }
    const magic = header.subarray(257, 262).toString("latin1");
    const prefix = magic === "ustar" ? cString(header, 345, 500) : "";
    const name = cString(header, 0, 100);
    const rawPath = pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    const linkTarget = pax.linkpath ?? longLink ?? cString(header, 157, 257);
    pax = {}; longName = null; longLink = null;
    const type: TarEntryType = typeflag === "0" || typeflag === "\0" || typeflag === "7" ? "file"
      : typeflag === "5" ? "directory" : typeflag === "2" ? "symlink" : typeflag === "1" ? "hardlink" : "other";
    const entry: TarEntry = { path: normalizeLayerPath(rawPath), type, mode: numeric(header, 100, 108) & 0o7777, size: type === "file" ? size : 0, linkTarget };
    let consumed = false;
    await onEntry(entry, { async forward(sink) {
      if (consumed) throw new Error("Tar entry body already read");
      consumed = true;
      await reader.forward(size, sink);
    } });
    if (!consumed) await reader.forward(size, () => undefined);
    if (padded > size) await reader.forward(padded - size, () => undefined);
  }
}

// ---------------------------------------------------------------- layer walk

export interface LayerSource { digest: string; open(): AsyncIterable<Buffer> }
export interface ExtractionReport { extracted: Record<string, TarEntryType>; layersWithMatches: string[] }

const within = (candidate: string, root: string) => candidate === root || candidate.startsWith(`${root}/`);
const ancestors = (value: string) => value.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));

/**
 * Resolves `roots` (files or directory trees) through an ordered layer stack,
 * walking from the top layer down, and writes the effective result to `outDir`.
 *
 * Whiteouts follow the OCI image spec: `.wh.<name>` deletes `<name>` (and its
 * subtree) in lower layers, `.wh..wh..opq` hides every lower-layer child of its
 * directory. A higher-layer non-directory at a path also hides lower content
 * under that path. Whiteouts affect only lower layers, never their own layer.
 */
export async function extractFromLayers(layersBottomToTop: readonly LayerSource[], roots: readonly string[], outDir: string): Promise<ExtractionReport> {
  const normalizedRoots = roots.map(normalizeLayerPath);
  const rootAncestors = new Set(normalizedRoots.flatMap(ancestors));
  const deleted = new Set<string>();
  const opaque = new Set<string>();
  const resolved = new Map<string, TarEntryType>();
  const symlinks: Array<{ path: string; target: string }> = [];
  const directoryModes = new Map<string, number>();
  const layersWithMatches: string[] = [];

  const hidden = (candidate: string) => {
    if (deleted.has(candidate)) return true;
    for (const ancestor of ancestors(candidate)) if (deleted.has(ancestor) || opaque.has(ancestor)) return true;
    return false;
  };

  await mkdir(outDir, { recursive: true });
  for (const layer of [...layersBottomToTop].reverse()) {
    const pendingDeleted = new Set<string>();
    const pendingOpaque = new Set<string>();
    const stagedFiles = new Map<string, string>();
    let matched = false;
    await walkTar(layer.open(), async (entry, body) => {
      const base = path.posix.basename(entry.path);
      const directory = path.posix.dirname(entry.path);
      const parent = directory === "." ? "" : directory;
      if (base === ".wh..wh..opq") { pendingOpaque.add(parent); return; }
      if (base.startsWith(".wh.")) { pendingDeleted.add(parent ? `${parent}/${base.slice(4)}` : base.slice(4)); return; }
      if (!entry.path || hidden(entry.path) || resolved.has(entry.path)) return;
      const relevant = normalizedRoots.some(root => within(entry.path, root));
      if (!relevant) {
        // A file or symlink replacing a parent of a root would redirect the root.
        if (rootAncestors.has(entry.path) && entry.type !== "directory") {
          throw new Error(`Layer ${layer.digest} replaces parent directory /${entry.path} with a ${entry.type}; extraction is unsupported`);
        }
        if (rootAncestors.has(entry.path)) resolved.set(entry.path, entry.type);
        return;
      }
      matched = true;
      resolved.set(entry.path, entry.type);
      if (entry.type !== "directory") pendingDeleted.add(entry.path);
      const target = path.join(outDir, ...entry.path.split("/"));
      if (entry.type === "directory") {
        await mkdir(target, { recursive: true });
        directoryModes.set(target, entry.mode);
      } else if (entry.type === "file") {
        await mkdir(path.dirname(target), { recursive: true });
        const handle = await open(target, "wx", 0o600);
        try { await body.forward(async chunk => { await handle.write(chunk); }); } finally { await handle.close(); }
        await chmod(target, entry.mode & 0o755);
        stagedFiles.set(entry.path, target);
      } else if (entry.type === "hardlink") {
        const source = stagedFiles.get(normalizeLayerPath(entry.linkTarget));
        if (!source) throw new Error(`Hard link /${entry.path} → /${entry.linkTarget} points outside the extracted paths of layer ${layer.digest}`);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
        await chmod(target, (await stat(source)).mode & 0o755);
        resolved.set(entry.path, "file");
        stagedFiles.set(entry.path, target);
      } else if (entry.type === "symlink") {
        symlinks.push({ path: target, target: entry.linkTarget });
      } else {
        throw new Error(`Unsupported tar entry type at /${entry.path} in layer ${layer.digest}`);
      }
    });
    for (const value of pendingDeleted) deleted.add(value);
    for (const value of pendingOpaque) opaque.add(value);
    if (matched) layersWithMatches.push(layer.digest);
  }
  // Symlinks last, so no file is ever written through one.
  for (const link of symlinks) {
    await mkdir(path.dirname(link.path), { recursive: true });
    await symlink(link.target, link.path);
  }
  for (const [directory, mode] of directoryModes) await chmod(directory, (mode & 0o755) | 0o700);
  for (const root of normalizedRoots) if (![...resolved.keys()].some(key => within(key, root))) throw new Error(`/${root} was not found in the image layers`);
  const extracted = Object.fromEntries([...resolved].filter(([key]) => normalizedRoots.some(root => within(key, root))));
  return { extracted, layersWithMatches };
}

// ---------------------------------------------------------------- image

export interface DaytonaImageArtifacts {
  schema: typeof RECEIPT_SCHEMA;
  image: string;
  platformManifestDigest: string;
  contentId: string;
  sourceRevision: string;
  runnerdPath: string;
  runnerdSha256: string;
  providerPackPath: string;
  providerPackManifestSha256: string;
  providerPackDigest: string;
  providerPackRunnerSourceRevision: string;
  extractedAt: string;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Decompresses a layer blob. skopeo verified the blob digests when it copied them. */
function layerStream(file: string, mediaType: string): AsyncIterable<Buffer> {
  if (!/tar/.test(mediaType)) throw new Error(`Unsupported layer media type ${mediaType}`);
  const raw = createReadStream(file);
  const decoder: Readable = /zstd/.test(mediaType) ? raw.pipe(createZstdDecompress())
    : /gzip/.test(mediaType) ? raw.pipe(createGunzip()) : raw;
  return decoder as AsyncIterable<Buffer>;
}

/** ELF64, little-endian, x86-64 executable or shared object. */
export async function assertLinuxAmd64Executable(file: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(20);
    await handle.read(header, 0, 20, 0);
    if (header.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${file} is not an ELF binary`);
    if (header[4] !== 2 || header[5] !== 1) throw new Error(`${file} is not a 64-bit little-endian ELF binary`);
    if (header.readUInt16LE(18) !== 62) throw new Error(`${file} is not an x86-64 binary`);
  } finally { await handle.close(); }
  if (((await stat(file)).mode & 0o111) === 0) throw new Error(`${file} is not executable`);
}

async function readReceipt(directory: string): Promise<DaytonaImageArtifacts | null> {
  const receipt = await readFile(path.join(directory, "receipt.json"), "utf8").then(text => JSON.parse(text) as DaytonaImageArtifacts).catch(() => null);
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) return null;
  // A cache hit must still be the exact bytes that were verified.
  if (await fileSha256(receipt.runnerdPath).catch(() => null) !== receipt.runnerdSha256) return null;
  const pack = await readFile(path.join(receipt.providerPackPath, "provider-pack.json")).catch(() => null);
  if (!pack || sha256(pack) !== receipt.providerPackManifestSha256) return null;
  return receipt;
}

export function defaultDaytonaImageCacheRoot(): string {
  return path.resolve(process.env.RESTART_CHAOS_IMAGE_CACHE ?? path.join(import.meta.dirname, "results", "daytona-images"));
}

export const SKOPEO_ATTEMPT_TIMEOUT_MS = 20 * 60_000;

export async function copyImageToDir(input: { skopeo: string; image: string; blobs: string; attempts?: number;
  attemptTimeoutMs?: number; log?: (line: string) => void }): Promise<void> {
  const attempts = input.attempts ?? 3;
  const timeout = input.attemptTimeoutMs
    ?? (Number(process.env.RESTART_CHAOS_SKOPEO_ATTEMPT_TIMEOUT_MS) || SKOPEO_ATTEMPT_TIMEOUT_MS);
  const log = input.log ?? (() => undefined);
  for (let attempt = 1; ; attempt += 1) {
    await rm(input.blobs, { recursive: true, force: true });
    await mkdir(input.blobs, { recursive: true, mode: 0o700 });
    log(`skopeo copy ${input.image} (linux/amd64) → ${input.blobs} (attempt ${attempt}/${attempts})`);
    try {
      await execFileAsync(input.skopeo, ["copy", "--retry-times", "3", "--override-os", "linux", "--override-arch", "amd64",
        `docker://${input.image}`, `dir:${input.blobs}`], { maxBuffer: 16 * 1024 * 1024, timeout, killSignal: "SIGKILL" });
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      log(`skopeo copy failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); retrying into an empty directory`);
    }
  }
}

/**
 * Returns the verified runnerd and provider pack of `image`, extracting them
 * once per image digest into `cacheRoot/<digest>/`.
 */
export async function prepareDaytonaImageArtifacts(input: { image: string; cacheRoot: string; skopeo?: string; log?: (line: string) => void }): Promise<DaytonaImageArtifacts> {
  const match = IMMUTABLE_IMAGE.exec(input.image);
  if (!match) throw new Error(`Daytona image must be an immutable registry/repository@sha256:<digest> reference, got "${input.image}"`);
  const log = input.log ?? (() => undefined);
  const finalDir = path.join(path.resolve(input.cacheRoot), match[1]!);
  const cached = await readReceipt(finalDir);
  if (cached) { log(`Daytona image artifacts cached at ${finalDir}`); return cached; }

  const staging = path.join(path.resolve(input.cacheRoot), `.staging-${match[1]!.slice(0, 12)}-${randomBytes(4).toString("hex")}`);
  const blobs = path.join(staging, "blobs");
  const rootfs = path.join(staging, "rootfs");
  try {
    await copyImageToDir({ skopeo: input.skopeo ?? process.env.SKOPEO ?? "skopeo", image: input.image, blobs, log });
    const manifestBytes = await readFile(path.join(blobs, "manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { config: { digest: string }; layers: Array<{ digest: string; mediaType: string }> };
    if (!manifest.config?.digest || !Array.isArray(manifest.layers)) throw new Error("skopeo did not produce a single-platform image manifest");
    const blobPath = (digest: string) => {
      if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`Unexpected blob digest ${digest}`);
      return path.join(blobs, digest.slice("sha256:".length));
    };
    for (const layer of manifest.layers) {
      if (`sha256:${await fileSha256(blobPath(layer.digest))}` !== layer.digest) throw new Error(`Layer blob digest mismatch for ${layer.digest}`);
    }
    const configBytes = await readFile(blobPath(manifest.config.digest));
    if (`sha256:${sha256(configBytes)}` !== manifest.config.digest) throw new Error("Image config digest mismatch");
    const config = JSON.parse(configBytes.toString("utf8")) as { os?: string; architecture?: string; config?: { Labels?: Record<string, string> } };
    if (config.os !== "linux" || config.architecture !== "amd64") throw new Error(`Image platform is ${config.os}/${config.architecture}, expected linux/amd64`);
    const contentId = config.config?.Labels?.[CONTENT_ID_LABEL] ?? "";
    const sourceRevision = config.config?.Labels?.[REVISION_LABEL] ?? "";
    if (!/^[0-9a-f]{64}$/.test(contentId)) throw new Error(`Image has no ${CONTENT_ID_LABEL} label`);
    if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error(`Image has no ${REVISION_LABEL} label`);

    log(`Walking ${manifest.layers.length} layers for /${RUNNERD_PATH} and /${PROVIDER_PACK_PATH}`);
    await extractFromLayers(manifest.layers.map(layer => ({ digest: layer.digest, open: () => layerStream(blobPath(layer.digest), layer.mediaType) })),
      [RUNNERD_PATH, PROVIDER_PACK_PATH], rootfs);
    await rm(blobs, { recursive: true, force: true });

    const runnerd = path.join(rootfs, ...RUNNERD_PATH.split("/"));
    await assertLinuxAmd64Executable(runnerd);
    const packDir = path.join(rootfs, ...PROVIDER_PACK_PATH.split("/"));
    const packBytes = await readFile(path.join(packDir, "provider-pack.json"));
    const pack = JSON.parse(packBytes.toString("utf8")) as { schema?: string; digest?: string; payload?: { runnerSourceRevision?: string } };
    if (pack.schema !== "paperclip-runner/remote-provider-pack/v1" || !/^sha256:[0-9a-f]{64}$/.test(pack.digest ?? "")) {
      throw new Error("Image provider-pack.json is not a paperclip-runner/remote-provider-pack/v1 manifest");
    }
    if (pack.payload?.runnerSourceRevision !== sourceRevision) {
      throw new Error(`Provider pack was built from ${pack.payload?.runnerSourceRevision ?? "an unknown revision"}, but the image revision label is ${sourceRevision}`);
    }
    const receiptFor = (root: string): DaytonaImageArtifacts => ({
      schema: RECEIPT_SCHEMA, image: input.image, platformManifestDigest: `sha256:${sha256(manifestBytes)}`, contentId, sourceRevision,
      runnerdPath: path.join(root, "rootfs", ...RUNNERD_PATH.split("/")), runnerdSha256: "",
      providerPackPath: path.join(root, "rootfs", ...PROVIDER_PACK_PATH.split("/")), providerPackManifestSha256: sha256(packBytes),
      providerPackDigest: pack.digest!, providerPackRunnerSourceRevision: sourceRevision, extractedAt: new Date().toISOString(),
    });
    const runnerdSha256 = await fileSha256(runnerd);
    const publishTo = async (root: string) => {
      const receipt = { ...receiptFor(root), runnerdSha256 };
      await writeFile(path.join(staging, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      await rename(staging, root);
      log(`Daytona image artifacts ready at ${root}`);
      return receipt;
    };
    try {
      return await publishTo(finalDir);
    } catch (error) {
      const concurrent = await readReceipt(finalDir);
      if (concurrent) {
        await rm(staging, { recursive: true, force: true });
        log(`Daytona image artifacts extracted concurrently at ${finalDir}`);
        return concurrent;
      }
      if (!(await stat(finalDir).then(() => true, () => false))) throw error;
      log(`Invalid cache entry at ${finalDir} left in place; publishing this extraction beside it`);
      return await publishTo(`${finalDir}.${randomBytes(4).toString("hex")}`);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The controller and the image must come from the same runner source: the
 * image's content-ID label must equal the content ID of this checkout, which
 * hashes every runner input (Rust crates, runner src, provider-pack scripts,
 * lockfile, Dockerfile).
 */
export async function assertControllerMatchesImage(artifacts: Pick<DaytonaImageArtifacts, "image" | "contentId" | "sourceRevision">,
  repositoryRoot: string, localContentId?: string): Promise<{ localContentId: string }> {
  const computed = localContentId ?? await (await import("../runner-e2e/daytona-image-content.js")).computeDaytonaImageContentId({ repositoryRoot });
  if (computed !== artifacts.contentId) {
    throw new Error([
      "Controller runner source does not match the Daytona image.",
      `  image ${artifacts.image}`,
      `  image content ID ${artifacts.contentId} (source revision ${artifacts.sourceRevision})`,
      `  this checkout's content ID ${computed}`,
      "Check out the image's source revision, or build a new image for this checkout",
      "(gh workflow run runner-full-stack-e2e.yml, see tests/restart-chaos/README.md).",
    ].join("\n"));
  }
  return { localContentId: computed };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  const image = process.argv[2];
  if (!image) { console.error("Usage: daytona-image.ts <registry/repository@sha256:digest>"); process.exit(2); }
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const cacheRoot = defaultDaytonaImageCacheRoot();
  try {
    const artifacts = await prepareDaytonaImageArtifacts({ image, cacheRoot, log: line => console.error(line) });
    const check = await assertControllerMatchesImage(artifacts, repositoryRoot).then(() => "match", (error: Error) => error.message);
    console.info(JSON.stringify({ ...artifacts, controllerMatch: check }, null, 2));
    process.exit(check === "match" ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
