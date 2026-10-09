import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand, type S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import type { PutObjectInput } from "./types.js";

/** Each part is streamed too: multipart must not become another whole-file
 * buffer or a fixed part-count ceiling below the storage provider's limits. */
export async function putS3Multipart(client: S3Client, bucket: string, key: string, input: PutObjectInput) {
  const source = input.body instanceof Readable ? input.body : Readable.from([input.body]);
  const iterator = source[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let uploadId: string | undefined;
  // Scale part sizes to the S3 part-count limit while retaining stream backpressure.
  const partSize = Math.max(8 * 1024 * 1024, Math.ceil(input.contentLength / 10_000));
  try {
    uploadId = (await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: input.contentType }))).UploadId;
    if (!uploadId) throw new Error("S3 did not return a multipart upload id");
    const parts: { ETag: string; PartNumber: number }[] = [];
    for (let offset = 0; offset < input.contentLength;) {
      const length = Math.min(partSize, input.contentLength - offset);
      let remaining = length;
      const body = Readable.from((async function* () {
        while (remaining > 0) {
          if (!pending.length) {
            const next = await iterator.next();
            if (next.done) throw new Error("S3 upload source was truncated");
            pending = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
            if (!pending.length) continue;
          }
          const count = Math.min(remaining, pending.length);
          const chunk = pending.subarray(0, count);
          pending = pending.subarray(count);
          remaining -= count;
          yield chunk;
        }
      })());
      try {
        const result = await client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: parts.length + 1, Body: body, ContentLength: length }));
        if (remaining || !result.ETag) throw new Error("S3 upload part is incomplete");
        parts.push({ ETag: result.ETag, PartNumber: parts.length + 1 });
      } finally { body.destroy(); }
      offset += length;
    }
    if (pending.length || !(await iterator.next()).done) throw new Error("S3 upload source exceeds its declared size");
    await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
  } catch (error) {
    if (uploadId) await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => {});
    throw error;
  } finally {
    source.destroy();
    await iterator.return?.();
  }
}
