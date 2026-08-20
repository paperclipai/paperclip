/**
 * Versioned frame codec for the sandbox duplex channel.
 *
 * The channel carries newline-delimited JSON frames. One frame is one line. The
 * host and the generated gateway each hold a copy of this codec. A shared
 * fixture file (`duplex-frame-vectors.json`) proves the two copies stay wire
 * compatible: both copies decode the same bytes to the same frames.
 *
 * The codec has two sides:
 *   - encode: turn a frame object into one line of JSON with a trailing newline.
 *   - decode: turn a byte stream into frames. The streaming decoder keeps partial
 *     bytes between chunks, so a frame split across chunks and a multi-byte UTF-8
 *     sequence split across chunks both decode correctly.
 *
 * The decoder never throws on the read path. A malformed, oversized, or
 * version-mismatch frame becomes a protocol-error result, not an exception. This
 * keeps one bad frame from crashing the read loop.
 */

/** The wire version this codec reads and writes. */
export const DUPLEX_FRAME_VERSION = 1;

/**
 * The default maximum size of one frame, in bytes. The decoder rejects a longer
 * frame with a `frame_too_large` protocol error. The value matches the per-chunk
 * character bound of the host duplex route.
 */
export const DEFAULT_MAX_DUPLEX_FRAME_BYTES = 1_000_000;

const NEWLINE_BYTE = 0x0a;
const EMPTY = Buffer.alloc(0);

/** The frame type strings. One value goes in the `type` field of every frame. */
export const DUPLEX_FRAME_TYPES = {
  request: "request",
  response: "response",
  ready: "ready",
  heartbeat: "heartbeat",
  close: "close",
  error: "error",
} as const;

/** The outcome of a response frame. A loss response carries a non-completed outcome. */
export type DuplexResponseOutcome = "completed" | "indeterminate" | "unavailable";

/** A request frame. The gateway forwards it to the host API path. */
export interface DuplexRequestFrame {
  version: number;
  type: "request";
  id: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}

/** A response frame. The host returns it for one request id. */
export interface DuplexResponseFrame {
  version: number;
  type: "response";
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  outcome: DuplexResponseOutcome;
}

/**
 * The READY control frame. The gateway sends it one time after it validates its
 * local listener address. The `address` field carries that validated address.
 */
export interface DuplexReadyFrame {
  version: number;
  type: "ready";
  address: string;
}

/** The heartbeat control frame. Each side sends it on an interval to prove liveness. */
export interface DuplexHeartbeatFrame {
  version: number;
  type: "heartbeat";
}

/** The orderly close control frame. A side sends it to end the channel cleanly. */
export interface DuplexCloseFrame {
  version: number;
  type: "close";
}

/**
 * The protocol-error control frame. A peer sends it to report a bad frame. This
 * frame is distinct from a decode-time protocol error: the decoder produces a
 * {@link DuplexProtocolError} result, while a peer sends this frame on the wire.
 */
export interface DuplexErrorFrame {
  version: number;
  type: "error";
  code: string;
  message?: string;
}

/** Any frame the codec reads or writes. */
export type DuplexFrame =
  | DuplexRequestFrame
  | DuplexResponseFrame
  | DuplexReadyFrame
  | DuplexHeartbeatFrame
  | DuplexCloseFrame
  | DuplexErrorFrame;

/** The reason the decoder rejected one line. */
export type DuplexProtocolErrorCode =
  | "malformed_frame"
  | "unknown_type"
  | "version_mismatch"
  | "frame_too_large";

/** A decode-time protocol error. The read path returns it; it never throws. */
export interface DuplexProtocolError {
  code: DuplexProtocolErrorCode;
  message: string;
}

/** One decode result: a valid frame, or a protocol error. */
export type DuplexDecodeResult =
  | { ok: true; frame: DuplexFrame }
  | { ok: false; error: DuplexProtocolError };

const RESPONSE_OUTCOMES: ReadonlySet<string> = new Set<DuplexResponseOutcome>([
  "completed",
  "indeterminate",
  "unavailable",
]);

function ok(frame: DuplexFrame): DuplexDecodeResult {
  return { ok: true, frame };
}

function fail(code: DuplexProtocolErrorCode, message: string): DuplexDecodeResult {
  return { ok: false, error: { code, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isPlainObject(value)) return false;
  for (const entry of Object.values(value)) {
    if (typeof entry !== "string") return false;
  }
  return true;
}

/**
 * Encode one frame to a single line of JSON with a trailing newline. `JSON.stringify`
 * escapes any newline inside a string value, so the returned line holds no
 * interior newline. This keeps one frame on one line.
 */
export function encodeDuplexFrame(frame: DuplexFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Decode one line (no trailing newline) to a frame or a protocol error. The
 * streaming decoder calls this for each complete line. It is exported so a
 * caller with its own line splitter can reuse the same validation.
 *
 * The check order matters. A parseable frame with the wrong version becomes a
 * `version_mismatch`, so the version check runs before the type check.
 */
export function decodeDuplexLine(line: string | Buffer): DuplexDecodeResult {
  const text = typeof line === "string" ? line : line.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("malformed_frame", "frame is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    return fail("malformed_frame", "frame is not a JSON object");
  }
  if (parsed.version !== DUPLEX_FRAME_VERSION) {
    return fail(
      "version_mismatch",
      `frame version ${String(parsed.version)} is not ${DUPLEX_FRAME_VERSION}`,
    );
  }
  return validateFrame(parsed);
}

function validateFrame(frame: Record<string, unknown>): DuplexDecodeResult {
  switch (frame.type) {
    case "request":
      return validateRequest(frame);
    case "response":
      return validateResponse(frame);
    case "ready":
      return validateReady(frame);
    case "heartbeat":
      return validateHeartbeat(frame);
    case "close":
      return validateClose(frame);
    case "error":
      return validateError(frame);
    default:
      return fail("unknown_type", `unknown frame type ${JSON.stringify(frame.type)}`);
  }
}

function validateRequest(frame: Record<string, unknown>): DuplexDecodeResult {
  if (
    typeof frame.id !== "string" ||
    typeof frame.method !== "string" ||
    typeof frame.path !== "string" ||
    typeof frame.query !== "string" ||
    typeof frame.body !== "string" ||
    !isStringRecord(frame.headers)
  ) {
    return fail("malformed_frame", "request frame has a missing or wrong-typed field");
  }
  return ok(frame as unknown as DuplexRequestFrame);
}

function validateResponse(frame: Record<string, unknown>): DuplexDecodeResult {
  if (
    typeof frame.id !== "string" ||
    typeof frame.status !== "number" ||
    typeof frame.body !== "string" ||
    !isStringRecord(frame.headers) ||
    typeof frame.outcome !== "string" ||
    !RESPONSE_OUTCOMES.has(frame.outcome)
  ) {
    return fail("malformed_frame", "response frame has a missing or wrong-typed field");
  }
  return ok(frame as unknown as DuplexResponseFrame);
}

function validateReady(frame: Record<string, unknown>): DuplexDecodeResult {
  if (typeof frame.address !== "string") {
    return fail("malformed_frame", "ready frame has a missing or wrong-typed address");
  }
  return ok(frame as unknown as DuplexReadyFrame);
}

function validateHeartbeat(frame: Record<string, unknown>): DuplexDecodeResult {
  return ok(frame as unknown as DuplexHeartbeatFrame);
}

function validateClose(frame: Record<string, unknown>): DuplexDecodeResult {
  return ok(frame as unknown as DuplexCloseFrame);
}

function validateError(frame: Record<string, unknown>): DuplexDecodeResult {
  if (typeof frame.code !== "string") {
    return fail("malformed_frame", "error frame has a missing or wrong-typed code");
  }
  if (frame.message !== undefined && typeof frame.message !== "string") {
    return fail("malformed_frame", "error frame has a wrong-typed message");
  }
  return ok(frame as unknown as DuplexErrorFrame);
}

/** Options for a {@link DuplexFrameDecoder}. */
export interface DuplexFrameDecoderOptions {
  /** The maximum size of one frame, in bytes. Defaults to {@link DEFAULT_MAX_DUPLEX_FRAME_BYTES}. */
  maxFrameBytes?: number;
}

/**
 * A streaming decoder for a byte stream of newline-delimited JSON frames.
 *
 * Call `push` with each chunk. The decoder keeps the bytes of an incomplete
 * frame between calls, so a frame that spans two chunks decodes on the chunk
 * that completes it. The decoder buffers raw bytes and decodes UTF-8 only on a
 * complete line, so a multi-byte sequence split across chunks stays valid. The
 * newline byte `0x0A` never appears inside a multi-byte UTF-8 sequence, so a
 * split on that byte is always safe.
 *
 * The decoder enforces the maximum frame size. It rejects an oversized frame
 * with a `frame_too_large` protocol error, then discards bytes up to the next
 * newline to resynchronize. It never throws on the read path.
 */
export class DuplexFrameDecoder {
  private buffer: Buffer = EMPTY;
  private discarding = false;
  private readonly maxFrameBytes: number;

  constructor(options: DuplexFrameDecoderOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_DUPLEX_FRAME_BYTES;
  }

  /** Feed one chunk. Return the frames and protocol errors that complete on it. */
  push(chunk: Buffer | Uint8Array | string): DuplexDecodeResult[] {
    const incoming =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.buffer =
      this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);

    const results: DuplexDecodeResult[] = [];
    for (;;) {
      if (this.discarding) {
        // Drop the tail of an oversized frame until the next newline.
        const newlineIndex = this.buffer.indexOf(NEWLINE_BYTE);
        if (newlineIndex === -1) {
          this.buffer = EMPTY;
          break;
        }
        this.buffer = this.buffer.subarray(newlineIndex + 1);
        this.discarding = false;
        continue;
      }

      const newlineIndex = this.buffer.indexOf(NEWLINE_BYTE);
      if (newlineIndex === -1) {
        // No complete line yet. Reject an incomplete frame that already passed
        // the size bound, then resynchronize at the next newline.
        if (this.buffer.length > this.maxFrameBytes) {
          results.push(fail("frame_too_large", "frame exceeds the maximum size"));
          this.discarding = true;
          this.buffer = EMPTY;
        }
        break;
      }

      const line = this.buffer.subarray(0, newlineIndex);
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (line.length === 0) continue; // Skip a blank line.
      if (line.length > this.maxFrameBytes) {
        results.push(fail("frame_too_large", "frame exceeds the maximum size"));
        continue;
      }
      results.push(decodeDuplexLine(line));
    }
    return results;
  }
}
