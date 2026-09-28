import { createHash } from "node:crypto";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER_API_RESPONSE_MAX_BYTES, RUNNER_API_RESPONSE_DEADLINE_MS, RunnerApiResponseLimitError } from "./runner-api-response-limits.js";

export type RunnerApiResponseBody = Buffer | { path: string; byteSize: number; sha256: string };

/** Spill bounded responses to a private temporary file.
 * Only the inline prefix and one HTTP chunk are held in memory. The caller must
 * dispose the capture after saving it or reading its requested text window.
 */
export async function captureRunnerApiResponse(response: Response, inlineBytes: number, controller: AbortController, idleTimeoutMs: number, checkAuthority?: () => Promise<void>, options: {
  maxBytes?: number;
  deadlineMs?: number;
  beforeSpill?: () => Promise<void>;
} = {}) {
  const maxBytes = options.maxBytes ?? RUNNER_API_RESPONSE_MAX_BYTES;
  const deadline = Date.now() + (options.deadlineMs ?? RUNNER_API_RESPONSE_DEADLINE_MS);
  const reader = response.body?.getReader();
  let directory: string | undefined;
  let file: FileHandle | undefined;
  let path: string | undefined;
  let byteSize = 0;
  const prefix: Buffer[] = [];
  const hash = createHash("sha256");
  const dispose = async () => {
    try { await file?.close(); }
    finally {
      file = undefined;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    if (Number(response.headers.get("content-length")) > maxBytes) {
      throw new RunnerApiResponseLimitError("api_response_too_large", `API response exceeds the ${maxBytes}-byte capture limit. Narrow the query or use the endpoint's pagination.`);
    }
    let checkedAt = Date.now();
    let checkedBytes = 0;
    await checkAuthority?.();
    if (reader) {
      while (true) {
        controller.signal.throwIfAborted();
        if (Date.now() >= deadline) throw new RunnerApiResponseLimitError("api_response_timeout", "API response exceeded its capture deadline.");
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new RunnerApiResponseLimitError("api_response_timeout", "API response read timed out or exceeded its capture deadline."));
            }, Math.min(idleTimeoutMs, Math.max(0, deadline - Date.now())));
          }),
        ]).finally(() => clearTimeout(timeout));
        if (next.done) break;
        // Count decoded bytes before copying, hashing, or writing the chunk.
        // Content-Length can be missing, false, or describe compressed bytes.
        if (next.value.byteLength > maxBytes - byteSize) {
          throw new RunnerApiResponseLimitError("api_response_too_large", `API response exceeds the ${maxBytes}-byte capture limit. Narrow the query or use the endpoint's pagination.`);
        }
        const chunk = Buffer.from(next.value);
        if (!Number.isSafeInteger(byteSize + chunk.length)) throw new Error("API response byte offset exceeds numeric precision");
        hash.update(chunk);
        if (!file && byteSize + chunk.length > inlineBytes) {
          await options.beforeSpill?.();
          directory = await mkdtemp(join(tmpdir(), "paperclip-api-response-"));
          path = join(directory, "body");
          file = await open(path, "wx+", 0o600);
          for (const part of prefix) await file.writeFile(part);
          prefix.length = 0;
        }
        if (file) await file.writeFile(chunk);
        else prefix.push(chunk);
        byteSize += chunk.length;
        if (checkAuthority && (Date.now() - checkedAt >= 1000 || byteSize - checkedBytes >= 1024 * 1024)) {
          await checkAuthority();
          checkedAt = Date.now();
          checkedBytes = byteSize;
        }
      }
    }
    if (Date.now() >= deadline) throw new RunnerApiResponseLimitError("api_response_timeout", "API response exceeded its capture deadline.");
    await checkAuthority?.();
    const bytes = file ? undefined : Buffer.concat(prefix);
    const body: RunnerApiResponseBody = path ? { path, byteSize, sha256: hash.digest("hex") } : bytes!;
    return {
      body,
      byteSize,
      async read(offset: number, limit: number): Promise<Buffer> {
        const length = Math.min(limit, Math.max(0, byteSize - offset));
        if (!file) return bytes!.subarray(offset, offset + length);
        const result = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const next = await file.read(result, read, length - read, offset + read);
          if (!next.bytesRead) throw new Error("Saved API response was truncated");
          read += next.bytesRead;
        }
        return result;
      },
      dispose,
    };
  } catch (error) {
    controller.abort();
    await dispose();
    throw error;
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
