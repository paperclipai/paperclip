import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { RequestHandler } from "express";
import type { StorageProvider } from "./storage/types.js";

const prefix = "ui-assets/v1/";
function assetPath(value: string): string | null {
  const relative = value.replace(/^\//, "");
  return relative.length <= 512 && relative.split("/").every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== "..")
    && !relative.endsWith(".map") ? relative : null;
}
async function digest(stream: Readable) {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

const transientStatuses = new Set([429, 500, 502, 503, 504]);
const transientNames = new Set(["SlowDown", "Throttling", "ThrottlingException", "RequestTimeout", "ServiceUnavailable", "InternalError",
  // The 30-second deadline on one asset, and a connection that never completed.
  "TimeoutError", "AbortError"]);
const transientNetworkCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const publishRetryDelaysMs = [500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000];

/** Storage asked us to slow down or failed on its side; the same request can succeed later. */
export function isTransientStorageError(error: unknown): boolean {
  // The storage client wraps a socket failure; the reason is on the cause.
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 4; depth++) {
    const value = current as { name?: unknown; Code?: unknown; code?: unknown; status?: unknown; cause?: unknown; $metadata?: { httpStatusCode?: unknown } };
    if ([value.name, value.Code].some(name => typeof name === "string" && transientNames.has(name))
      || (typeof value.code === "string" && transientNetworkCodes.has(value.code))
      || [value.status, value.$metadata?.httpStatusCode].some(status => typeof status === "number" && transientStatuses.has(status))) return true;
    current = value.cause;
  }
  return false;
}

/** Publish at startup. Returns false, after saying so, when storage itself is
 * unavailable: this container still serves its build from disk, so a storage
 * outage costs an older tab its retained chunks, not everyone the server. A
 * build that cannot be published for any other reason still rejects. */
export async function publishRetainedUiAssetsAtStartup(
  retained: { publish(directory: string): Promise<void> },
  directory: string,
  report: (error: unknown) => void,
): Promise<boolean> {
  try {
    await retained.publish(directory);
    return true;
  } catch (error) {
    if (!isTransientStorageError(error)) throw error;
    report(error);
    return false;
  }
}

/** Assets published at once: enough to hide per-request latency, small enough
 * that a throttling bucket sees a steady stream rather than a burst. */
export const RETAINED_UI_ASSET_PUBLISH_CONCURRENCY = 8;

/** Public, immutable build assets only. Publishing before readiness lets an
 * older tab fetch its chunks after the last old container has disappeared.
 * Objects have no automatic expiry: retain them at least 30 days after the
 * last serving deployment, including rollback, before operator reclamation. */
export function retainedUiAssets(provider: StorageProvider, options: { sleep?: (ms: number) => Promise<void>; concurrency?: number } = {}): { publish(directory: string): Promise<void>; serve: RequestHandler } {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? RETAINED_UI_ASSET_PUBLISH_CONCURRENCY));
  if (provider.id !== "s3" || !provider.putObjectConditional) throw new Error("Retained UI assets require conditional shared object storage");
  async function publishAsset(filename: string, objectKey: string) {
    // Build assets are small: read each once into a Buffer. The storage client
    // can replay a Buffer body; it cannot replay a stream, and every refused
    // stream upload, including the 412 each already-published asset answers
    // on a restart, logged a "non-retryable streaming request" warning.
    const bytes = await fs.readFile(filename);
    const expected = createHash("sha256").update(bytes).digest("hex");
    // Storage throttles a burst: retry the whole asset instead of failing startup.
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.timeout(30_000);
      try {
        try {
          await provider.putObjectConditional!({ objectKey, body: bytes, contentLength: bytes.length, contentType: "application/octet-stream", ifNoneMatch: "*", signal });
        } catch (error) {
          // An existing key or uncertain upload may be accepted only if its
          // complete bytes match. Never overwrite a colliding build asset.
          // A read that storage could not serve proves nothing either way:
          // keep it, so the asset is tried again instead of being judged.
          const existing = await provider.getObject({ objectKey, signal })
            .catch(readError => { throw isTransientStorageError(readError) ? readError : error; });
          if (await digest(existing.stream) !== expected) throw new Error("Static build asset name collides with different published bytes");
        }
        return;
      } catch (error) {
        if (!isTransientStorageError(error) || attempt >= publishRetryDelaysMs.length) throw error;
        await sleep(publishRetryDelaysMs[attempt]!);
      }
    }
  }
  async function publish(directory: string) {
    const assets: Array<{ filename: string; objectKey: string }> = [];
    async function visit(relativeDirectory: string) {
      for (const entry of await fs.readdir(path.join(directory, relativeDirectory), { withFileTypes: true })) {
        const relative = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) { await visit(relative); continue; }
        if (relative.endsWith(".map")) continue;
        if (!entry.isFile() || !assetPath(relative)) throw new Error("Unsupported static build asset");
        assets.push({ filename: path.join(directory, relative), objectKey: `${prefix}${relative}` });
      }
    }
    await visit("");
    // Each asset is an independent conditional write. A build has hundreds, so
    // a bounded pool replaces hundreds of serial round trips with a few dozen.
    // The first failure stops new assets from starting; ones in flight finish,
    // and a collision among them outranks an outage.
    let next = 0;
    const failure: { found: boolean; error: unknown } = { found: false, error: null };
    const worker = async () => {
      while (!failure.found && next < assets.length) {
        const asset = assets[next++]!;
        try { await publishAsset(asset.filename, asset.objectKey); }
        // A collision refuses the build; an outage only lets it start on local
        // files. A storage outage on one asset must never hide a collision
        // found on another.
        catch (error) {
          if (!failure.found || (isTransientStorageError(failure.error) && !isTransientStorageError(error))) {
            failure.found = true;
            failure.error = error;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, assets.length) }, worker));
    if (failure.found) throw failure.error;
  }
  const serve: RequestHandler = async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { next(); return; }
    let relative: string | null;
    try { relative = assetPath(decodeURIComponent(req.path)); }
    catch { relative = null; }
    if (!relative) { res.status(404).end(); return; }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const cancel = () => controller.abort();
    res.once("close", cancel);
    try {
      const object = await provider.getObject({ objectKey: `${prefix}${relative}`, signal });
      res.type(relative).set("Cache-Control", "public, max-age=31536000, immutable");
      if (object.etag) res.set("ETag", object.etag);
      if (object.contentLength !== undefined) res.set("Content-Length", String(object.contentLength));
      if (req.method === "HEAD") { object.stream.destroy(); res.end(); return; }
      await pipeline(object.stream, res, { signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      if ((error as { status?: number }).status === 404) { res.status(404).end(); return; }
      next(error);
    } finally { res.off("close", cancel); }
  };
  return { publish, serve };
}
