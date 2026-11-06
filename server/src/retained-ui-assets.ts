import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { RequestHandler } from "express";
import type { StorageProvider } from "./storage/types.js";
import { logger } from "./middleware/logger.js";

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

const VERIFY_READ_ATTEMPTS = 3;
const VERIFY_READ_BACKOFF_MS = [250, 1_000];
const TRANSIENT_READ_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "ERR_STREAM_PREMATURE_CLOSE"]);

/** A body cut off mid-download (socket reset after HTTP 200) says nothing
 * about the stored bytes; reading the object again is safe. */
function isTransientRead(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || !error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (typeof code === "string" && TRANSIENT_READ_CODES.has(code)) || message === "aborted";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Digest of the already-published object. A missing/unreadable object keeps
 * reporting the publication error; a body cut off mid-download is re-read. */
async function publishedDigest(provider: StorageProvider, objectKey: string, signal: AbortSignal, publishError: unknown): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const existing = await provider.getObject({ objectKey, signal }).catch(() => { throw publishError; });
    try {
      return await digest(existing.stream);
    } catch (error) {
      existing.stream.destroy();
      if (attempt >= VERIFY_READ_ATTEMPTS || !isTransientRead(error, signal)) throw error;
      logger.warn({ err: error, objectKey, attempt, maxAttempts: VERIFY_READ_ATTEMPTS },
        "Published UI asset download was cut off; reading it again");
      await delay(VERIFY_READ_BACKOFF_MS[attempt - 1] ?? 1_000, signal);
    }
  }
}

/** Public, immutable build assets only. Publishing before readiness lets an
 * older tab fetch its chunks after the last old container has disappeared.
 * Objects have no automatic expiry: retain them at least 30 days after the
 * last serving deployment, including rollback, before operator reclamation. */
export function retainedUiAssets(provider: StorageProvider): { publish(directory: string): Promise<void>; serve: RequestHandler } {
  if (provider.id !== "s3" || !provider.putObjectConditional) throw new Error("Retained UI assets require conditional shared object storage");
  async function publish(directory: string) {
    async function visit(relativeDirectory: string) {
      for (const entry of await fs.readdir(path.join(directory, relativeDirectory), { withFileTypes: true })) {
        const relative = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) { await visit(relative); continue; }
        if (relative.endsWith(".map")) continue;
        if (!entry.isFile() || !assetPath(relative)) throw new Error("Unsupported static build asset");
        const filename = path.join(directory, relative);
        const signal = AbortSignal.timeout(30_000);
        const contentLength = (await fs.stat(filename)).size;
        const expected = await digest(createReadStream(filename, { signal }));
        const objectKey = `${prefix}${relative}`;
        const body = createReadStream(filename, { signal });
        try {
          await provider.putObjectConditional!({ objectKey, body, contentLength, contentType: "application/octet-stream", ifNoneMatch: "*", signal });
        } catch (error) {
          // An existing key or uncertain upload may be accepted only if its
          // complete bytes match. Never overwrite a colliding build asset.
          if (await publishedDigest(provider, objectKey, signal, error) !== expected) throw new Error("Static build asset name collides with different published bytes");
        } finally { body.destroy(); }
      }
    }
    await visit("");
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
