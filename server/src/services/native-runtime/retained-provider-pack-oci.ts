import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import type { ProviderPackIdentity } from "./remote-provider-pack-verification.js";

const repository = "paperclipai/paperclip";
const registry = "https://ghcr.io";
export const MAX_RETAINED_PACK_BYTES = 4 * 1024 ** 3;
const maxMetadataBytes = 1024 * 1024;
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const validDigest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
function fail(): never { throw Error("runner_remote_provider_source_invalid"); }
type Blob = { digest: string; size: number; mediaType?: string };
type Manifest = { schemaVersion: number; config: Blob; layers: Blob[] };
export type RetainedPackProvenance = {
  schema: "paperclip.retained-provider-pack-source.v1";
  sourceRevision: string;
  providerPackDigest: string;
  imageIndexDigest: string;
  imageManifestDigest: string;
  imageConfigDigest: string;
  transportLayerDigest: string;
  transportLayerBytes: number;
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

async function unpackTransport(layer: string, target: string, signal: AbortSignal) {
  const archive = tar.extract();
  const names = new Set<string>();
  let bytes = 0;
  archive.on("entry", (header, body, next) => {
    body.on("error", () => undefined);
    void (async () => {
      signal.throwIfAborted();
      const normalized = header.name.replace(/^\.\//u, "");
      const name = header.type === "directory" ? normalized.replace(/\/$/u, "") : normalized;
      if (names.has(name) || names.size >= 10_010) fail();
      names.add(name);
      if (header.type === "directory") {
        if (!["opt", "opt/paperclip-runner", "opt/paperclip-runner/provider-pack.archives"].includes(name)) fail();
        body.resume();
        return;
      }
      if (header.type !== "file" || !/^opt\/paperclip-runner\/provider-pack(?:\.archive\.json|\.archives\/(?:overlay|[0-9]{1,4})\.tar\.zst)$/u.test(name)
        || !Number.isSafeInteger(header.size) || header.size! < 1 || (bytes += header.size!) > MAX_RETAINED_PACK_BYTES
        || name.endsWith(".json") && header.size! > maxMetadataBytes) fail();
      const relative = name.slice("opt/paperclip-runner/".length);
      if (relative.includes("/")) await mkdir(join(target, "provider-pack.archives"), { recursive: true, mode: 0o700 });
      await pipeline(body, createWriteStream(join(target, relative), { flags: "wx", mode: 0o600 }), { signal });
    })().then(() => next(), error => archive.destroy(error));
  });
  await pipeline(createReadStream(layer), createGunzip(), bounded(MAX_RETAINED_PACK_BYTES + 16 * 1024 ** 2), archive, { signal });
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
  const request = async (path: string, token?: string, allowRedirect = false) => {
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
      throw Error(`runner_remote_provider_source_unavailable: HTTP ${response.status}`);
    }
    return response;
  };
  const authentication = JSON.parse((await metadata(await request(`/token?service=ghcr.io&scope=repository:${repository}:pull`), signal)).toString()) as { token?: unknown };
  if (typeof authentication.token !== "string" || authentication.token.length < 1 || authentication.token.length > 32 * 1024) fail();
  const token = authentication.token;
  const indexBytes = await metadata(await request(`/v2/${repository}/manifests/sha-${revision}`, token), signal);
  const index = JSON.parse(indexBytes.toString()) as { schemaVersion: number; manifests: Array<Blob & { platform?: { os?: string; architecture?: string } }> };
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length > 32) fail();
  const candidates = index.manifests.filter(row => row.platform?.os === "linux" && row.platform.architecture === architecture);
  if (candidates.length !== 1) fail();
  const child = blob(candidates[0]!, maxMetadataBytes);
  const manifestBytes = await metadata(await request(`/v2/${repository}/manifests/${child.digest}`, token), signal, child);
  const image = JSON.parse(manifestBytes.toString()) as Manifest;
  if (image.schemaVersion !== 2 || !Array.isArray(image.layers) || image.layers.length > 128) fail();
  const configBlob = blob(image.config, maxMetadataBytes);
  const configBytes = await metadata(await request(`/v2/${repository}/blobs/${configBlob.digest}`, token, true), signal, configBlob);
  const config = JSON.parse(configBytes.toString()) as { architecture: string; os: string; config?: { Labels?: Record<string, string> }; history: Array<{ empty_layer?: boolean; created_by?: string }> };
  if (config.architecture !== architecture || config.os !== "linux" || config.config?.Labels?.["org.opencontainers.image.revision"] !== revision
    || config.config.Labels["org.opencontainers.image.source"] !== "https://github.com/paperclipai/paperclip"
    || !Array.isArray(config.history) || config.history.length > 1024) fail();
  const history = config.history.filter(row => !row.empty_layer);
  if (history.length !== image.layers.length) fail();
  const indices = history.flatMap((row, index) => /^COPY \/provider-pack-transport\/? \/opt\/paperclip-runner\/? # buildkit$/u.test(row.created_by ?? "") ? [index] : []);
  if (indices.length !== 1) fail();
  const transport = blob(image.layers[indices[0]!]!, MAX_RETAINED_PACK_BYTES);
  if (!["application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.docker.image.rootfs.diff.tar.gzip"].includes(transport.mediaType ?? "")) fail();
  const response = await request(`/v2/${repository}/blobs/${transport.digest}`, token, true);
  if (!response.body) fail();
  let bytes = 0;
  const hash = createHash("sha256");
  const meter = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    hash.update(chunk);
    done(bytes > transport.size ? Error("runner_remote_provider_source_size_limit") : null, chunk);
  } });
  const layer = join(directory, "transport.tar.gz");
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(layer, { flags: "wx", mode: 0o600 }), { signal });
  if (bytes !== transport.size || `sha256:${hash.digest("hex")}` !== transport.digest) fail();
  await unpackTransport(layer, directory, signal);
  return { schema: "paperclip.retained-provider-pack-source.v1", sourceRevision: revision, providerPackDigest: selected.digest,
    imageIndexDigest: digest(indexBytes), imageManifestDigest: child.digest, imageConfigDigest: configBlob.digest,
    transportLayerDigest: transport.digest, transportLayerBytes: transport.size };
}
