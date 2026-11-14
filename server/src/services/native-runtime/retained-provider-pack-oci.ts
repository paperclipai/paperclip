import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import type { ProviderPackIdentity } from "./remote-provider-pack-verification.js";

const applicationRepository = "paperclipai/paperclip";
const runnerRepository = "paperclipai/paperclip-runner";
const registry = "https://ghcr.io";
const unavailable = "runner_remote_provider_source_unavailable";
export const MAX_RETAINED_PACK_BYTES = 4 * 1024 ** 3;
const maxMetadataBytes = 1024 * 1024;
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const validDigest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
function fail(): never { throw Error("runner_remote_provider_source_invalid"); }
type Blob = { digest: string; size: number; mediaType?: string };
type Manifest = { schemaVersion: number; config: Blob; layers: Blob[] };
type Index = { schemaVersion: number; annotations?: Record<string, string>; manifests: Array<Blob & { platform?: { os?: string; architecture?: string } }> };
type Unpacked = { files: Set<string>; bytes: number };
export type RetainedPackProvenance = {
  schema: "paperclip.retained-provider-pack-source.v1";
  sourceRevision: string;
  providerPackDigest: string;
  imageIndexDigest: string;
  imageManifestDigest: string;
  imageConfigDigest: string;
  transportLayerDigest: string;
  transportLayerBytes: number;
  runnerImage?: { inputsDigest: string; transportLayerDigests: string[] };
};

function blob(value: Blob, maximum: number): Blob {
  if (!value || !validDigest(value.digest) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > maximum) fail();
  return value;
}

async function metadata(response: Response, signal: AbortSignal, expected?: Blob): Promise<Buffer> {
  if (!response.body) fail();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > maxMetadataBytes) fail();
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }
  const result = Buffer.concat(chunks);
  if (expected && (result.length !== expected.size || digest(result) !== expected.digest)) fail();
  return result;
}

function bounded(limit: number) {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    done(bytes > limit ? Error("runner_remote_provider_source_size_limit") : null, chunk);
  } });
}

async function unpackTransport(layer: string, target: string, signal: AbortSignal, prefix: string, unpacked: Unpacked) {
  const archive = tar.extract();
  const directories = new Set<string>();
  const parents = prefix.split("/").filter(Boolean).map((_part, index, parts) => parts.slice(0, index + 1).join("/"));
  const allowed = [...parents, `${prefix}provider-pack.archives`];
  archive.on("entry", (header, body, next) => {
    body.on("error", () => undefined);
    void (async () => {
      signal.throwIfAborted();
      const normalized = header.name.replace(/^\.\//u, "");
      const name = header.type === "directory" ? normalized.replace(/\/$/u, "") : normalized;
      if (directories.has(name) || unpacked.files.has(name) || directories.size + unpacked.files.size >= 10_010) fail();
      if (header.type === "directory") {
        if (!allowed.includes(name)) fail();
        directories.add(name);
        body.resume();
        return;
      }
      const relative = name.startsWith(prefix) ? name.slice(prefix.length) : "";
      if (header.type !== "file" || !/^provider-pack(?:\.archive\.json|\.archives\/(?:overlay|[0-9]{1,4})\.tar\.zst)$/u.test(relative)
        || !Number.isSafeInteger(header.size) || header.size! < 1 || (unpacked.bytes += header.size!) > MAX_RETAINED_PACK_BYTES
        || relative.endsWith(".json") && header.size! > maxMetadataBytes) fail();
      unpacked.files.add(name);
      if (relative.includes("/")) await mkdir(join(target, "provider-pack.archives"), { recursive: true, mode: 0o700 });
      await pipeline(body, createWriteStream(join(target, relative), { flags: "wx", mode: 0o600 }), { signal });
    })().then(() => next(), error => archive.destroy(error));
  });
  await pipeline(createReadStream(layer), createGunzip(), bounded(MAX_RETAINED_PACK_BYTES + 16 * 1024 ** 2), archive, { signal });
}

async function request(signal: AbortSignal, path: string, token?: string, allowRedirect = false) {
  signal.throwIfAborted();
  let response = await fetch(`${registry}${path}`, { redirect: "manual", signal, headers: {
    Accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  } });
  if ([302, 307].includes(response.status) && allowRedirect) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || location.length > 8192) fail();
    const url = new URL(location, registry);
    if (url.protocol !== "https:" || url.username || url.password || !["ghcr.io", "pkg-containers.githubusercontent.com"].includes(url.hostname)) fail();
    response = await fetch(url, { redirect: "error", signal });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`${unavailable}: HTTP ${response.status}`);
  }
  return response;
}

async function pullToken(repository: string, signal: AbortSignal) {
  const authentication = JSON.parse((await metadata(await request(signal, `/token?service=ghcr.io&scope=repository:${repository}:pull`), signal)).toString()) as { token?: unknown };
  if (typeof authentication.token !== "string" || authentication.token.length < 1 || authentication.token.length > 32 * 1024) fail();
  return authentication.token;
}

async function platformImage(repository: string, token: string, reference: string, architecture: string, signal: AbortSignal) {
  const indexBytes = await metadata(await request(signal, `/v2/${repository}/manifests/${reference}`, token), signal);
  if (validDigest(reference) && digest(indexBytes) !== reference) fail();
  const index = JSON.parse(indexBytes.toString()) as Index;
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length > 32) fail();
  const candidates = index.manifests.filter(row => row.platform?.os === "linux" && row.platform.architecture === architecture);
  if (candidates.length !== 1) fail();
  const child = blob(candidates[0]!, maxMetadataBytes);
  const manifestBytes = await metadata(await request(signal, `/v2/${repository}/manifests/${child.digest}`, token), signal, child);
  const image = JSON.parse(manifestBytes.toString()) as Manifest;
  if (image.schemaVersion !== 2 || !Array.isArray(image.layers) || image.layers.length > 128) fail();
  return { repository, token, index, indexDigest: digest(indexBytes), child, image, config: blob(image.config, maxMetadataBytes) };
}

async function receiveTransportLayer(source: { repository: string; token: string }, layer: Blob, prefix: string, directory: string, unpacked: Unpacked, signal: AbortSignal) {
  const transport = blob(layer, MAX_RETAINED_PACK_BYTES);
  if (!["application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.docker.image.rootfs.diff.tar.gzip"].includes(transport.mediaType ?? "")) fail();
  const response = await request(signal, `/v2/${source.repository}/blobs/${transport.digest}`, source.token, true);
  if (!response.body) fail();
  let bytes = 0;
  const hash = createHash("sha256");
  const meter = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    hash.update(chunk);
    done(bytes > transport.size ? Error("runner_remote_provider_source_size_limit") : null, chunk);
  } });
  const file = join(directory, "transport.tar.gz");
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal });
  if (bytes !== transport.size || `sha256:${hash.digest("hex")}` !== transport.digest) fail();
  await unpackTransport(file, directory, signal, prefix, unpacked);
  await unlink(file);
  return transport;
}

export async function receiveRetainedProviderPack(input: {
  manifest: ProviderPackIdentity;
  directory: string;
  signal: AbortSignal;
}): Promise<RetainedPackProvenance> {
  const { manifest: selected, directory, signal } = input;
  const revision = selected.payload.runnerSourceRevision;
  const architecture = selected.payload.target.architecture === "x64" ? "amd64" : selected.payload.target.architecture === "arm64" ? "arm64" : null;
  if (!/^[a-f0-9]{40}$/.test(revision) || selected.payload.target.platform !== "linux" || !architecture) fail();
  const unpacked: Unpacked = { files: new Set(), bytes: 0 };
  const provenance = { schema: "paperclip.retained-provider-pack-source.v1" as const, sourceRevision: revision, providerPackDigest: selected.digest };

  const inputsDigest = selected.payload.runnerInputsDigest;
  if (typeof inputsDigest === "string" && /^[a-f0-9]{64}$/.test(inputsDigest)) {
    const runner = await (async () => {
      const token = await pullToken(runnerRepository, signal);
      const full = await platformImage(runnerRepository, token, `inputs-${inputsDigest}`, architecture, signal);
      const slimDigest = full.index.annotations?.["io.paperclip.runner.slim-digest"];
      if (full.index.annotations?.["io.paperclip.runner.inputs-digest"] !== inputsDigest
        || full.index.annotations["org.opencontainers.image.revision"] !== revision || !validDigest(slimDigest)) fail();
      return { full, slim: await platformImage(runnerRepository, token, slimDigest, architecture, signal) };
    })().catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith(unavailable)) return null;
      throw error;
    });
    if (runner) {
      const { full, slim } = runner;
      const shared = slim.image.layers.length;
      const transport = full.image.layers.slice(shared).map(layer => blob(layer, MAX_RETAINED_PACK_BYTES));
      if (slim.image.layers.some((layer, index) => !validDigest(layer?.digest) || layer.digest !== full.image.layers[index]?.digest)
        || transport.length < 1 || transport.length > 8 || transport.reduce((bytes, layer) => bytes + layer.size, 0) > MAX_RETAINED_PACK_BYTES) fail();
      for (const layer of transport) await receiveTransportLayer(full, layer, "", directory, unpacked, signal);
      return { ...provenance, imageIndexDigest: full.indexDigest, imageManifestDigest: full.child.digest, imageConfigDigest: full.config.digest,
        transportLayerDigest: transport.at(-1)!.digest, transportLayerBytes: transport.reduce((bytes, layer) => bytes + layer.size, 0),
        runnerImage: { inputsDigest, transportLayerDigests: transport.map(layer => layer.digest) } };
    }
  }

  const source = await platformImage(applicationRepository, await pullToken(applicationRepository, signal), `sha-${revision}`, architecture, signal);
  const configBytes = await metadata(await request(signal, `/v2/${applicationRepository}/blobs/${source.config.digest}`, source.token, true), signal, source.config);
  const config = JSON.parse(configBytes.toString()) as { architecture: string; os: string; config?: { Labels?: Record<string, string> }; history: Array<{ empty_layer?: boolean; created_by?: string }> };
  if (config.architecture !== architecture || config.os !== "linux" || config.config?.Labels?.["org.opencontainers.image.revision"] !== revision
    || config.config.Labels["org.opencontainers.image.source"] !== "https://github.com/paperclipai/paperclip"
    || !Array.isArray(config.history) || config.history.length > 1024) fail();
  const history = config.history.filter(row => !row.empty_layer);
  if (history.length !== source.image.layers.length) fail();
  const indices = history.flatMap((row, index) => /^COPY \/provider-pack-transport\/? \/opt\/paperclip-runner\/? # buildkit$/u.test(row.created_by ?? "") ? [index] : []);
  if (indices.length !== 1) fail();
  const transport = await receiveTransportLayer(source, source.image.layers[indices[0]!]!, "opt/paperclip-runner/", directory, unpacked, signal);
  return { ...provenance, imageIndexDigest: source.indexDigest, imageManifestDigest: source.child.digest, imageConfigDigest: source.config.digest,
    transportLayerDigest: transport.digest, transportLayerBytes: transport.size };
}
