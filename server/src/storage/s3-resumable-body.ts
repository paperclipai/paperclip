import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

/** Reconnects allowed for one object read after its body was cut off. */
export const MAX_S3_BODY_RESUMES = 3;
const RESUME_BACKOFF_MS = 250;

// Socket failures after the response headers arrived. The object itself is
// intact; anything else (abort, local destroy, size or hash checks, provider
// errors) is final.
const RESUMABLE_BODY_ERROR_CODES = new Set(["ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT"]);

function resumableBodyError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && RESUMABLE_BODY_ERROR_CODES.has(code);
}

export interface ResumedBody {
  stream: Readable;
  response: unknown;
  contentLength: number | undefined;
  etag: string | undefined;
}

export interface ResumableBodyState {
  /** The response whose body is being read, for failure diagnostics. */
  response: unknown;
  /** Body reads so far, including the first. */
  reads: number;
}

/**
 * Stream one GetObject body, continuing from the delivered offset when its
 * socket fails. Each continuation is pinned to the first response's ETag, so
 * S3 refuses it if the key now names different bytes. Without an ETag and an
 * exact length there is no safe continuation and the failure is passed on.
 */
export function resumableS3Body(input: {
  first: ResumedBody;
  /** Absolute offset of the first response's first byte. */
  start: number;
  signal?: AbortSignal;
  reopen: (range: { start: number; end: number }, etag: string) => Promise<ResumedBody>;
}): { stream: Readable; state: ResumableBodyState } {
  const { etag, contentLength: total } = input.first;
  const state: ResumableBodyState = { response: input.first.response, reads: 1 };
  const released = new AbortController();
  const stopped = input.signal ? AbortSignal.any([input.signal, released.signal]) : released.signal;
  let current = input.first.stream, delivered = 0;
  // Destroying this stream releases the response being read at once, so a
  // consumer that stops early never leaves a socket open or a resume pending.
  const stream = new Readable({
    read() { current.resume(); },
    destroy(error, callback) { released.abort(); current.destroy(); callback(error); },
  });
  const recover = async (error: unknown) => {
    try {
      if (stopped.aborted) {
        if (!stream.destroyed) stream.destroy(error as Error);
        return;
      }
      if (!resumableBodyError(error) || !etag || total === undefined
        || delivered >= total || state.reads > MAX_S3_BODY_RESUMES) throw error;
      current.destroy();
      await delay(RESUME_BACKOFF_MS * state.reads, undefined, { signal: stopped });
      const next = await input.reopen({ start: input.start + delivered, end: input.start + total - 1 }, etag);
      current = next.stream;
      state.response = next.response;
      state.reads += 1;
      if (stopped.aborted) { current.destroy(); return; }
      if (next.contentLength !== total - delivered || next.etag !== etag) throw new Error("s3_object_body_resume_mismatch");
      attach(current);
    } catch (failure) {
      if (!stream.destroyed) stream.destroy(failure as Error);
    }
  };
  const attach = (source: Readable) => {
    source.on("data", (chunk: Buffer) => {
      delivered += chunk.length;
      if (!stream.push(chunk)) source.pause();
    });
    source.once("end", () => stream.push(null));
    // Keep listening after the first failure: a released response can still
    // emit, and an unhandled stream error would end the process.
    let failed = false;
    source.on("error", (error) => {
      if (failed) return;
      failed = true;
      void recover(error);
    });
  };
  attach(current);
  return { stream, state };
}
