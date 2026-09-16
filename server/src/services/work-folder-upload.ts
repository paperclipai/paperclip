import { measureSandboxOperation } from "./sandbox-performance.js";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { StorageProvider } from "../storage/types.js";

function transientUploadFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  const failure = error as Error & { code?: string; $metadata?: { httpStatusCode?: number } };
  // Authentication, validation and ownership failures must never be retried.
  const status = failure.$metadata?.httpStatusCode;
  if (status !== undefined) return [408, 429, 500, 502, 503, 504].includes(status);
  return ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"].includes(failure.code ?? "");
}

/** Retry an uncertain object PUT with a fresh, fully verified stream and the same key. */
export async function uploadWorkFolderObject(storage: Pick<StorageProvider, "putObject">, input: {
  objectKey: string;
  contentType: string;
  contentLength: number;
  sha256: string;
  createSource: () => Readable;
}) {
  return measureSandboxOperation("work_folder.object.upload", { bytes: input.contentLength }, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const source = input.createSource();
      const hash = createHash("sha256");
      let bytes = 0;
      let validationError: Error | undefined;
      const changed = () => validationError ??= new Error("Work file changed during upload; retry the checkpoint");
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > input.contentLength) return callback(changed());
          hash.update(chunk);
          callback(null, chunk);
        },
        flush(callback) {
          callback(bytes === input.contentLength && hash.digest("hex") === input.sha256 ? undefined : changed());
        },
      });
      const transferred = measureSandboxOperation("work_folder.upload.consume", { attempt: attempt + 1, bytes: input.contentLength }, async (span) => {
        try { await pipeline(source, verify); } finally { span.set({ bytes }); }
      });
      const uploaded = Promise.resolve().then(() => measureSandboxOperation("work_folder.object.put", { attempt: attempt + 1, bytes: input.contentLength, requestCount: 1 }, async () => storage.putObject({
        objectKey: input.objectKey, contentType: input.contentType,
        contentLength: input.contentLength, body: verify,
      })));
      let failure: unknown;
      try {
        // Observe both promises immediately. An early HTTP success cannot publish
        // unvalidated content, and a failed request must release its source reader.
        await Promise.all([transferred, uploaded]);
        return;
      } catch (error) {
        failure = validationError ?? error;
      } finally {
        source.destroy();
        verify.destroy();
        await Promise.allSettled([transferred, uploaded]);
      }
      if (validationError || attempt === 2 || !transientUploadFailure(failure)) throw failure;
      await measureSandboxOperation("work_folder.upload.retry_wait", { attempt: attempt + 1 }, async () => delay(250 * (attempt + 1)));
    }
  });
}
