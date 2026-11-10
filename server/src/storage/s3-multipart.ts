import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand, type S3Client } from "@aws-sdk/client-s3";
import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import type { PutObjectInput } from "./types.js";
import { withS3FailureDiagnostics } from "./s3-failure.js";
import { cleanupStorageFailure } from "./failure-cleanup.js";

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
  let uploadId: string | undefined;
  // Scale part sizes to the S3 part-count limit while retaining stream backpressure.
  const partSize = Math.max(8 * 1024 * 1024, Math.ceil(input.contentLength / 10_000));
  try {
    check();
    uploadId = (await withS3FailureDiagnostics("create_multipart_upload", () => client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: input.contentType }), { abortSignal: controller.signal }))).UploadId;
    if (!uploadId) throw new Error("S3 did not return a multipart upload id");
    const parts: { ETag: string; PartNumber: number }[] = [];
    let partNumber = 0;
    for (let offset = 0; offset < input.contentLength;) {
      while (active.size >= 4) { await Promise.race(active); check(); }
      check();
      const length = Math.min(partSize, input.contentLength - offset);
      const number = ++partNumber;
      let remaining = length;
      const body = new PassThrough({ highWaterMark: 64 * 1024 });
      bodies.add(body);
      const uploading = (async () => {
        const result = await withS3FailureDiagnostics("upload_part", () => client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: number, Body: body, ContentLength: length }), { abortSignal: controller.signal }));
        if (remaining || !body.readableEnded || !result.ETag) throw new Error("S3 upload part is incomplete");
        parts[number - 1] = { ETag: result.ETag, PartNumber: number };
      })().catch(stop).finally(() => { active.delete(uploading); bodies.delete(body); body.destroy(); });
      active.add(uploading);
      while (remaining > 0) {
        check();
        if (!pending.length) {
          const next = await readNext();
          check();
          if (next.done) throw new Error("S3 upload source was truncated");
          pending = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
          if (!pending.length) continue;
        }
        const count = Math.min(remaining, pending.length, 64 * 1024);
        const chunk = pending.subarray(0, count);
        pending = pending.subarray(count);
        remaining -= count;
        if (!body.write(chunk)) await once(body, "drain", { signal: controller.signal });
      }
      body.end();
      offset += length;
    }
    if (pending.length || !(await readNext()).done) throw new Error("S3 upload source exceeds its declared size");
    await Promise.all(active);
    check();
    await withS3FailureDiagnostics("complete_multipart_upload", () => client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }), { abortSignal: controller.signal }));
  } catch (error) {
    stop(error);
    await Promise.all(active);
    if (uploadId) await cleanupStorageFailure(signal => client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), { abortSignal: signal }));
    throw failure;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    source.destroy();
    await cleanupStorageFailure(async () => iterator.return?.());
  }
}
