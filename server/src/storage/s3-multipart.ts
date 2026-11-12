import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand, type S3Client } from "@aws-sdk/client-s3";
import { sendThroughStorageOutage } from "./storage-unavailable.js";
import { recordStorageBackoff, recordStoragePart, recordStorageThrottle, withStorageRequestStats } from "./request-stats.js";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { PutObjectInput, PutObjectReceipt } from "./types.js";
import { withS3FailureDiagnostics } from "./s3-failure.js";
import { cleanupStorageFailure, STORAGE_FAILURE_CLEANUP_MS } from "./failure-cleanup.js";
import { digestFileOffThread } from "./file-crypto-pool.js";

const bufferedPartSize = 8 * 1024 * 1024;
const bufferedPayloadLimit = 4 * bufferedPartSize;
let bufferedPayloadBytes = 0;
const inFlightUploads = new Set<{ abort: (reason: unknown) => void; settled: Promise<void> }>();

function trackUpload(abort: (reason: unknown) => void) {
  let settle!: () => void;
  const entry = { abort, settled: new Promise<void>(resolve => { settle = resolve; }) };
  inFlightUploads.add(entry);
  return () => { inFlightUploads.delete(entry); settle(); };
}

function settledWithin(entries: Array<{ settled: Promise<void> }>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([Promise.all(entries.map(entry => entry.settled)).then(() => undefined),
    new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}

export async function abortInFlightMultipartUploads(reason: unknown, options: { graceMs?: number; timeoutMs?: number } = {}) {
  if (options.graceMs && inFlightUploads.size) await settledWithin([...inFlightUploads], options.graceMs);
  const entries = [...inFlightUploads];
  if (!entries.length) return 0;
  for (const entry of entries) entry.abort(reason);
  await settledWithin(entries, options.timeoutMs ?? 2 * STORAGE_FAILURE_CLEANUP_MS);
  return entries.length;
}

/** Each part is streamed too: multipart must not become another whole-file
 * buffer or a fixed part-count ceiling below the storage provider's limits. */
export async function putS3Multipart(client: S3Client, bucket: string, key: string, input: PutObjectInput) {
  const source = input.body instanceof Readable ? input.body : Readable.from([input.body]);
  const iterator = source[Symbol.asyncIterator]();
  const controller = new AbortController();
  const active = new Set<Promise<void>>();
  const bodies = new Set<PassThrough>();
  let failed = false;
  let failure: unknown;
  const stop = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
    controller.abort(error);
    source.destroy();
    for (const body of bodies) body.destroy();
  };
  const check = () => { if (failed) throw failure; };
  const onAbort = () => stop(input.signal!.reason);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const untrack = trackUpload(stop);
  const readNext = async () => {
    controller.signal.throwIfAborted();
    let abort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([iterator.next(), interrupted]); }
    finally { controller.signal.removeEventListener("abort", abort); }
  };
  let pending = Buffer.alloc(0);
  const readPart = async (length: number, write: (chunk: Buffer) => Promise<void>) => {
    while (length > 0) {
      check();
      if (!pending.length) {
        const next = await readNext();
        check();
        if (next.done) throw new Error("S3 upload source was truncated");
        pending = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        if (!pending.length) continue;
      }
      const count = Math.min(length, pending.length, 64 * 1024), chunk = pending.subarray(0, count);
      pending = pending.subarray(count); length -= count;
      await write(chunk);
    }
  };
  let uploadId: string | undefined;
  // Scale part sizes to the S3 part-count limit while retaining stream backpressure.
  const partSize = Math.max(bufferedPartSize, Math.ceil(input.contentLength / 10_000));
  try {
    check();
    uploadId = (await withS3FailureDiagnostics("create_multipart_upload", () => client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: input.contentType }), { abortSignal: controller.signal }), controller.signal)).UploadId;
    if (!uploadId) throw new Error("S3 did not return a multipart upload id");
    const parts: { ETag: string; PartNumber: number }[] = [];
    let partNumber = 0;
    for (let offset = 0; offset < input.contentLength;) {
      while (active.size >= 4) { await Promise.race(active); check(); }
      check();
      const length = Math.min(partSize, input.contentLength - offset);
      const number = ++partNumber;
      let buffered: Buffer | null = null;
      if (partSize <= bufferedPartSize && bufferedPayloadBytes + length <= bufferedPayloadLimit) {
        bufferedPayloadBytes += length;
        try {
          const payload = Buffer.allocUnsafe(length);
          let position = 0;
          await readPart(length, async chunk => { chunk.copy(payload, position); position += chunk.length; });
          buffered = payload;
        } catch (error) { bufferedPayloadBytes -= length; throw error; }
      }
      let remaining = length;
      const body = new PassThrough({ highWaterMark: 64 * 1024 });
      bodies.add(body);
      const write = async (chunk: Buffer) => {
        check(); remaining -= chunk.length;
        if (!body.write(chunk)) await once(body, "drain", { signal: controller.signal });
      };
      const sending = (async () => {
        const result = await withS3FailureDiagnostics("upload_part", () => client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: number, Body: body, ContentLength: length }), { abortSignal: controller.signal }), controller.signal);
        if (remaining || !body.readableEnded || !result.ETag) throw new Error("S3 upload part is incomplete");
        parts[number - 1] = { ETag: result.ETag, PartNumber: number };
      })().catch(stop);
      const producing = buffered ? (async () => {
        for (let position = 0; position < buffered.length; position += 64 * 1024)
          await write(buffered.subarray(position, Math.min(position + 64 * 1024, buffered.length)));
        body.end();
      })().catch(stop) : Promise.resolve();
      const uploading = Promise.all([sending, producing]).then(() => undefined)
        .finally(() => { if (buffered) bufferedPayloadBytes -= length; active.delete(uploading); bodies.delete(body); body.destroy(); });
      active.add(uploading);
      if (!buffered) {
        await readPart(length, write);
        body.end();
      }
      offset += length;
    }
    if (pending.length || !(await readNext()).done) throw new Error("S3 upload source exceeds its declared size");
    await Promise.all(active);
    check();
    await withS3FailureDiagnostics("complete_multipart_upload", () => client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }), { abortSignal: controller.signal }), controller.signal);
  } catch (error) {
    stop(error);
    await Promise.all(active);
    if (uploadId) await cleanupStorageFailure(signal => withStorageRequestStats(() => client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), { abortSignal: signal })));
    throw failure;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    source.destroy();
    await cleanupStorageFailure(async () => iterator.return?.());
    untrack();
  }
}

export const FILE_PART_CONCURRENCY = 8;
const FILE_PART_ATTEMPTS = 3;
/** A provider that asks for a lower request rate gets more, longer-spaced attempts. */
export const THROTTLED_PART_ATTEMPTS = 8;
const THROTTLE_BACKOFF_BASE_MS = 1_000;
const THROTTLE_BACKOFF_MAX_MS = 20_000;

/**
 * S3 answers a request-rate limit with 503 SlowDown; compatible gateways also
 * use 429. The SDK never retries a part because its body is a stream, so the
 * upload must slow down itself.
 */
function isRequestRateLimited(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const { name, $metadata } = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return name === "SlowDown" || $metadata?.httpStatusCode === 503 || $metadata?.httpStatusCode === 429;
}

const TRANSIENT_FILE_REQUEST_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_FILE_REQUEST_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN",
  "ENOTFOUND", "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_SOCKET"]);
const TRANSIENT_FILE_REQUEST_NAMES = new Set(["RequestTimeout", "TimeoutError", "NetworkingError", "InternalError", "ServiceUnavailable"]);

function isTransientFileRequestFailure(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const { name, code, $metadata } = error as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const status = $metadata?.httpStatusCode;
  if (typeof status === "number") return TRANSIENT_FILE_REQUEST_STATUS.has(status);
  return (typeof code === "string" && TRANSIENT_FILE_REQUEST_CODES.has(code))
    || (typeof name === "string" && TRANSIENT_FILE_REQUEST_NAMES.has(name));
}

export async function sendFileRequestWithRetry<T>(signal: AbortSignal | undefined, send: () => Promise<T>): Promise<T> {
  for (let failures = 0, throttles = 0; ;) {
    signal?.throwIfAborted();
    try {
      return await send();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isRequestRateLimited(error)) {
        recordStorageThrottle();
        if (++throttles >= THROTTLED_PART_ATTEMPTS) throw error;
        const ceiling = Math.min(THROTTLE_BACKOFF_MAX_MS, THROTTLE_BACKOFF_BASE_MS * 2 ** (throttles - 1));
        const wait = Math.floor(Math.random() * ceiling);
        recordStorageBackoff(wait);
        await delay(wait, undefined, { signal });
        continue;
      }
      if (!isTransientFileRequestFailure(error) || ++failures >= FILE_PART_ATTEMPTS) throw error;
      recordStorageBackoff(failures * 500);
      await delay(failures * 500, undefined, { signal });
    }
  }
}

/** Base64 MD5 of an inclusive byte range, as the Content-MD5 header expects. Hashed off the server's thread. */
export async function fileRangeMd5(file: string, start: number, end: number, signal?: AbortSignal) {
  const digest = await digestFileOffThread({ file, start, end, algorithm: "md5" }, signal);
  return Buffer.from(digest.hex, "hex").toString("base64");
}

export async function assertSourceFileSize(file: string, contentLength: number) {
  const stats = await stat(file);
  if (!stats.isFile() || stats.size !== contentLength) throw new Error("S3 upload source file does not match its declared size");
}

/** A file source is read per part instead of through one stream. Parts upload
 * in parallel without the shared memory window, each carries Content-MD5 so
 * the backend rejects bytes it did not receive intact, and a failed part is
 * resent from disk instead of failing the whole upload. When the backend
 * limits the request rate, the part backs off with jitter and the upload
 * halves its parts in flight, once per round of throttled requests. */
export async function putS3MultipartFile(
  client: S3Client, bucket: string, key: string, input: PutObjectInput & { sourceFile: string },
): Promise<PutObjectReceipt> {
  const file = input.sourceFile;
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal!.reason);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const untrack = trackUpload(reason => { if (!controller.signal.aborted) controller.abort(reason); });
  // This path never reads the stream body; release its file descriptor now.
  if (input.body instanceof Readable) input.body.destroy();
  let uploadId: string | undefined;
  try {
    await assertSourceFileSize(file, input.contentLength);
    controller.signal.throwIfAborted();
    const partSize = Math.max(bufferedPartSize, Math.ceil(input.contentLength / 10_000));
    const count = Math.ceil(input.contentLength / partSize);
    uploadId = (await sendThroughStorageOutage(() => withS3FailureDiagnostics("create_multipart_upload", () => client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: input.contentType }), { abortSignal: controller.signal }), controller.signal), controller.signal)).UploadId;
    if (!uploadId) throw new Error("S3 did not return a multipart upload id");
    const id = uploadId;
    const parts: { ETag: string; PartNumber: number }[] = new Array(count);
    // Workers at or above this slot stop taking new parts. A reduction counts
    // only for requests sent after the previous one, so a burst of parallel
    // throttled parts halves the rate once rather than once per part.
    let concurrency = FILE_PART_CONCURRENCY, reductions = 0;
    const partMd5 = (index: number) => fileRangeMd5(file, index * partSize, Math.min((index + 1) * partSize, input.contentLength) - 1, controller.signal);
    // The first round of parts is digested before any of them is sent. They
    // leave together, as they did when this thread digested them side by side,
    // so a rate limit still answers one burst rather than a trickle of requests.
    // Every digest of the round has ended, also a failed or cancelled one,
    // before a part goes on: none still reads the file when the upload settles.
    const firstRound = Array.from({ length: Math.min(FILE_PART_CONCURRENCY, count) }, (_, index) => partMd5(index));
    const firstRoundEnded = Promise.allSettled(firstRound);
    const sendPart = async (index: number) => {
      const start = index * partSize, length = Math.min(partSize, input.contentLength - start), end = start + length - 1;
      if (index < firstRound.length) await firstRoundEnded;
      const contentMd5 = await (firstRound[index] ?? partMd5(index));
      for (let failures = 0, throttles = 0; ;) {
        controller.signal.throwIfAborted();
        const body = createReadStream(file, { start, end, highWaterMark: 64 * 1024 });
        const sentAfter = reductions;
        try {
          const result = await withS3FailureDiagnostics("upload_part", () => client.send(new UploadPartCommand({
            Bucket: bucket, Key: key, UploadId: id, PartNumber: index + 1, Body: body, ContentLength: length, ContentMD5: contentMd5,
          }), { abortSignal: controller.signal }), controller.signal);
          if (!result.ETag) throw new Error("S3 upload part is incomplete");
          parts[index] = { ETag: result.ETag, PartNumber: index + 1 };
          recordStoragePart();
          return;
        } catch (error) {
          // A part read from disk can be resent; the stream path cannot.
          if (controller.signal.aborted) throw error;
          if (isRequestRateLimited(error)) {
            recordStorageThrottle();
            if (++throttles >= THROTTLED_PART_ATTEMPTS) throw error;
            if (sentAfter === reductions) { concurrency = Math.max(1, Math.floor(concurrency / 2)); reductions++; }
            const ceiling = Math.min(THROTTLE_BACKOFF_MAX_MS, THROTTLE_BACKOFF_BASE_MS * 2 ** (throttles - 1));
            const wait = Math.floor(Math.random() * ceiling);
            recordStorageBackoff(wait);
            await delay(wait, undefined, { signal: controller.signal });
            continue;
          }
          if (++failures >= FILE_PART_ATTEMPTS) throw error;
          recordStorageBackoff(failures * 500);
          await delay(failures * 500, undefined, { signal: controller.signal });
        } finally { body.destroy(); }
      }
    };
    let next = 0;
    const worker = async (slot: number) => {
      while (next < count && slot < concurrency) {
        const index = next++;
        try { await sendThroughStorageOutage(() => sendPart(index), controller.signal); }
        catch (error) { if (!controller.signal.aborted) controller.abort(error); throw error; }
      }
    };
    // Wait for every sibling to settle before the multipart upload is aborted.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(FILE_PART_CONCURRENCY, count) }, (_, slot) => worker(slot)));
    const rejected = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (rejected) throw controller.signal.aborted && controller.signal.reason !== undefined ? controller.signal.reason : rejected.reason;
    controller.signal.throwIfAborted();
    await sendThroughStorageOutage(() => withS3FailureDiagnostics("complete_multipart_upload", () => client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: id, MultipartUpload: { Parts: parts } }), { abortSignal: controller.signal }), controller.signal), controller.signal);
    uploadId = undefined;
    return { integrity: "server_verified_md5" };
  } catch (error) {
    const failedUpload = uploadId;
    if (failedUpload) await cleanupStorageFailure(signal => withStorageRequestStats(() => client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: failedUpload }), { abortSignal: signal })));
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    untrack();
  }
}
