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
 *
 * HTTP/2 is the preferred transport. `queue_v1` is the soft-deprecated fallback.
 * The `http2_v1` host readiness gate imports {@link decodeDuplexLine} from this
 * file to read the one READY line every gateway sends, so this file's READY
 * frame path stays live for both transports. `duplex-bridge-broker.ts` and
 * `duplex-body-spool.ts` still import the request, response, and body-chunk
 * frame types from this file, so this phase keeps every frame type here.
 */

import {
  DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED,
  type DuplexAggregateByteLedger,
  type ReservationToken,
} from "./duplex-aggregate-byte-ledger.js";

/** The wire version this codec reads and writes. */
export const DUPLEX_FRAME_VERSION = 2;

/**
 * The fixed raw byte size of one body slice. The sender splits a body into
 * `body_chunk` frames of this raw size, except the final chunk, which holds the
 * remaining bytes. The base64 text of one full slice is about 349 KiB, so each
 * encoded `body_chunk` frame stays well under {@link DEFAULT_MAX_DUPLEX_FRAME_BYTES}.
 */
export const DUPLEX_BODY_CHUNK_RAW_BYTES = 256 * 1024;

/**
 * The default maximum size of one frame, in bytes. The decoder rejects a longer
 * frame with a `frame_too_large` protocol error. The value matches the per-chunk
 * character bound of the host duplex route.
 */
export const DEFAULT_MAX_DUPLEX_FRAME_BYTES = 1_000_000;

/**
 * The maximum size of the frame `id` field, in bytes. The decoder rejects a
 * request or a response frame that carries a longer id with an `id_too_large`
 * protocol error. The read path returns the error; it never throws.
 *
 * The generated gateway builds each request id with `randomUUID()`, so a real id
 * is 36 ASCII bytes. This bound of 256 bytes gives large headroom for that id and
 * for any short future id scheme. The bound also caps the bytes the host broker
 * retains per distinct request. The broker keeps one id per distinct dispatched
 * request for the no-replay guarantee, so the id bound sets the per-id ceiling of
 * that retained memory.
 */
export const DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES = 256;

const NEWLINE_BYTE = 0x0a;
const EMPTY = Buffer.alloc(0);

/** The frame type strings. One value goes in the `type` field of every frame. */
export const DUPLEX_FRAME_TYPES = {
  request: "request",
  response: "response",
  body_chunk: "body_chunk",
  ready: "ready",
  heartbeat: "heartbeat",
  close: "close",
  error: "error",
} as const;

/** The outcome of a response frame. A loss response carries a non-completed outcome. */
export type DuplexResponseOutcome = "completed" | "indeterminate" | "unavailable";

/**
 * A request envelope frame. The gateway forwards it to the host API path. The
 * envelope carries `bodyByteCount`, the raw byte length of the request body. The
 * body itself rides one or more `body_chunk` frames that share the same `id`. A
 * `bodyByteCount` of 0 means an empty body and no `body_chunk` frame follows.
 */
export interface DuplexRequestFrame {
  version: number;
  type: "request";
  id: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  bodyByteCount: number;
}

/**
 * A response envelope frame. The host returns it for one request id. The
 * envelope carries `bodyByteCount`, the raw byte length of the response body.
 * The body itself rides one or more `body_chunk` frames that share the same
 * `id`. A `bodyByteCount` of 0 means an empty body and no `body_chunk` frame
 * follows.
 */
export interface DuplexResponseFrame {
  version: number;
  type: "response";
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyByteCount: number;
  outcome: DuplexResponseOutcome;
}

/**
 * A body-chunk frame. One frame carries one raw body slice as base64 text in
 * `data`. The frames for one body share the `id` of the envelope. `seq` starts
 * at 0 and increases by one for each next chunk, with no gap and no repeat. Each
 * raw slice is {@link DUPLEX_BODY_CHUNK_RAW_BYTES} bytes, except the final slice,
 * which holds the remaining bytes. The receiver reassembles the slices in `seq`
 * order and stops when the total raw byte count equals the envelope
 * `bodyByteCount`.
 */
export interface DuplexBodyChunkFrame {
  version: number;
  type: "body_chunk";
  id: string;
  seq: number;
  data: string;
}

/**
 * The READY control frame. The gateway sends it one time after it binds the
 * host-assigned listener port. READY is a liveness signal, not an address
 * source. The frame carries exactly the frame version and the `nonce` string.
 * The gateway echoes the nonce the host passed through the launch environment,
 * so the host correlates the READY frame with this channel open. The frame
 * carries no address data; the host builds the endpoint from its own stored
 * port, never from the channel.
 */
export interface DuplexReadyFrame {
  version: number;
  type: "ready";
  nonce: string;
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
  | DuplexBodyChunkFrame
  | DuplexReadyFrame
  | DuplexHeartbeatFrame
  | DuplexCloseFrame
  | DuplexErrorFrame;

/** The reason the decoder rejected one line. */
export type DuplexProtocolErrorCode =
  | "malformed_frame"
  | "unknown_type"
  | "version_mismatch"
  | "frame_too_large"
  | "id_too_large"
  | "aggregate_bytes_exceeded";

/** A decode-time protocol error. The read path returns it; it never throws. */
export interface DuplexProtocolError {
  code: DuplexProtocolErrorCode;
  message: string;
}

/** One decode result: a valid frame, or a protocol error. */
export type DuplexDecodeResult =
  | { ok: true; frame: DuplexFrame }
  | { ok: false; error: DuplexProtocolError };

/**
 * One size-checked encode result: one line, or a `frame_too_large` error. The
 * shape mirrors {@link DuplexDecodeResult}, so the encode side reports the
 * over-limit case as a typed outcome, not an exception.
 */
export type DuplexEncodeResult =
  | { ok: true; line: string }
  | { ok: false; error: { code: "frame_too_large"; message: string } };

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

/** Return true when the id byte size is within {@link DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES}. */
function idWithinLimit(id: string): boolean {
  return Buffer.byteLength(id, "utf8") <= DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES;
}

/** Return true when the value is a safe integer that is zero or positive. */
function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
 * Encode one frame to a single line and enforce the maximum frame size. The
 * function measures the encoded JSON in bytes, without the trailing newline, so
 * it matches the decoder bound exactly: a line the decoder accepts encodes, and a
 * line the decoder rejects returns a `frame_too_large` result. The function never
 * throws; it reports the over-limit case as a typed outcome.
 *
 * The size bound follows request and response bodies the host does not control,
 * so an over-limit frame is an expected condition, not a programming error. Every
 * write path that can carry a large body uses this function, so no path emits a
 * frame the peer decoder rejects. The bound applies to every frame type; the
 * guard is a no-op for a small control frame.
 */
export function encodeDuplexFrameChecked(
  frame: DuplexFrame,
  maxFrameBytes: number = DEFAULT_MAX_DUPLEX_FRAME_BYTES,
): DuplexEncodeResult {
  const json = JSON.stringify(frame);
  if (Buffer.byteLength(json, "utf8") > maxFrameBytes) {
    return { ok: false, error: { code: "frame_too_large", message: "frame exceeds the maximum size" } };
  }
  return { ok: true, line: `${json}\n` };
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
    case "body_chunk":
      return validateBodyChunk(frame);
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
    !isSafeNonNegativeInteger(frame.bodyByteCount) ||
    !isStringRecord(frame.headers)
  ) {
    return fail("malformed_frame", "request frame has a missing or wrong-typed field");
  }
  // Bound the id byte size at the protocol level. The host broker retains one id
  // per distinct dispatched request, so an unbounded id is a memory-exhaustion
  // path. Reject an over-limit id as a protocol error; the read path never throws.
  if (!idWithinLimit(frame.id)) {
    return fail("id_too_large", "request frame id exceeds the maximum size");
  }
  return ok(frame as unknown as DuplexRequestFrame);
}

function validateResponse(frame: Record<string, unknown>): DuplexDecodeResult {
  if (
    typeof frame.id !== "string" ||
    typeof frame.status !== "number" ||
    !isSafeNonNegativeInteger(frame.bodyByteCount) ||
    !isStringRecord(frame.headers) ||
    typeof frame.outcome !== "string" ||
    !RESPONSE_OUTCOMES.has(frame.outcome)
  ) {
    return fail("malformed_frame", "response frame has a missing or wrong-typed field");
  }
  // Apply the same id byte bound to the response id. The host echoes the request
  // id on the response, so the same rule keeps both frame ids under one ceiling.
  if (!idWithinLimit(frame.id)) {
    return fail("id_too_large", "response frame id exceeds the maximum size");
  }
  return ok(frame as unknown as DuplexResponseFrame);
}

/**
 * Validate a `body_chunk` frame at the structural level. The codec is stateless,
 * so it checks only the per-frame shape here:
 *   - `id` is a string within {@link DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES}.
 *   - `seq` is a safe integer that is zero or positive.
 *   - `data` is a string.
 * The receive-side reassembler owns the stateful checks: the base64 canonical
 * form, the fixed slice size, the `seq` order, and the total against
 * `bodyByteCount`. The codec never decodes `data` here.
 */
function validateBodyChunk(frame: Record<string, unknown>): DuplexDecodeResult {
  if (typeof frame.id !== "string" || typeof frame.data !== "string") {
    return fail("malformed_frame", "body_chunk frame has a missing or wrong-typed field");
  }
  if (!isSafeNonNegativeInteger(frame.seq)) {
    return fail("malformed_frame", "body_chunk frame has a missing or wrong-typed seq");
  }
  if (!idWithinLimit(frame.id)) {
    return fail("id_too_large", "body_chunk frame id exceeds the maximum size");
  }
  return ok(frame as unknown as DuplexBodyChunkFrame);
}

function validateReady(frame: Record<string, unknown>): DuplexDecodeResult {
  // READY carries a liveness nonce, not an address. The schema is strict: a valid
  // READY frame holds exactly `version`, `type`, and `nonce`. The decoder rejects
  // an absent nonce, a wrong-typed nonce, or any extra field, so a READY frame
  // that smuggles an `address`, a `port`, a `host`, or a URL never decodes.
  if (typeof frame.nonce !== "string") {
    return fail("malformed_frame", "ready frame has a missing or wrong-typed nonce");
  }
  for (const key of Object.keys(frame)) {
    if (key !== "version" && key !== "type" && key !== "nonce") {
      return fail("malformed_frame", "ready frame has an unexpected field");
    }
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
  /**
   * The process-owned aggregate byte ledger. When present, the decoder reserves
   * the exact bytes of the raw partial frame it retains between chunks, and the
   * peak replacement buffer it allocates on concat, against this ledger under the
   * `decoder_buffer` owner. The host injects the same ledger object it injects at
   * every other retention site, so one gauge bounds the aggregate retained bytes.
   * When absent the decoder charges nothing and behaves as before.
   *
   * The generated sandbox decoder runs in a separate operating-system process. It
   * cannot share this host ledger. It receives its own separate cap instead.
   */
  aggregateByteLedger?: DuplexAggregateByteLedger;
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
  private readonly ledger: DuplexAggregateByteLedger | null;
  /**
   * The token for the bytes currently retained in `this.buffer`. Its byte amount
   * equals `this.buffer.length` at the end of every `push`. It is `null` when the
   * buffer is empty or the decoder has no ledger.
   */
  private retainedToken: ReservationToken | null = null;

  constructor(options: DuplexFrameDecoderOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_DUPLEX_FRAME_BYTES;
    this.ledger = options.aggregateByteLedger ?? null;
  }

  /** Feed one chunk. Return the frames and protocol errors that complete on it. */
  push(chunk: Buffer | Uint8Array | string): DuplexDecodeResult[] {
    const incoming =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);

    // Reserve the incoming bytes before the concat allocates the replacement
    // buffer. The retained token already covers the current buffer, so the two
    // tokens together cover the peak `old + incoming` allocation. A rejected
    // reservation fails closed: the decoder drops the incoming chunk, releases
    // the retained buffer, resynchronizes at the next newline, and reports the
    // fixed aggregate rejection marker. It retains nothing uncharged.
    let incomingToken: ReservationToken | null = null;
    if (this.ledger && incoming.length > 0) {
      incomingToken = this.ledger.reserve("decoder_buffer", incoming.length);
      if (incomingToken === null) {
        this.releaseRetained();
        this.buffer = EMPTY;
        this.discarding = true;
        return [fail("aggregate_bytes_exceeded", DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED)];
      }
    }

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

    // Reconcile the ledger to the bytes still retained in `this.buffer`. Release
    // the old retained token and the incoming token, then reserve one token for
    // the remainder. The remainder is a subset of the just-released
    // `old + incoming` bytes, so this reserve always fits.
    this.reconcileRetained(incomingToken);
    return results;
  }

  /**
   * Release the retained-buffer token and drop the buffer. The host calls this at
   * channel teardown, so the decoder never leaks a `decoder_buffer` token after
   * the channel ends. A second call is a no-op, because the field is already
   * `null`.
   */
  dispose(): void {
    this.releaseRetained();
    this.buffer = EMPTY;
    this.discarding = false;
  }

  /** Release the retained-buffer token one time and clear the field. */
  private releaseRetained(): void {
    if (this.ledger && this.retainedToken) {
      this.ledger.release(this.retainedToken);
    }
    this.retainedToken = null;
  }

  /**
   * Move the ledger charge to the bytes still in `this.buffer`. Release the old
   * retained token and the `incoming` token, then reserve one token for the
   * remaining bytes. A `null` reserve here is an accounting defect, because the
   * remainder never passes the just-released bytes; the decoder fails closed and
   * drops the buffer so it retains nothing uncharged.
   */
  private reconcileRetained(incomingToken: ReservationToken | null): void {
    if (!this.ledger) return;
    this.releaseRetained();
    if (incomingToken) {
      this.ledger.release(incomingToken);
    }
    if (this.buffer.length > 0) {
      this.retainedToken = this.ledger.reserve("decoder_buffer", this.buffer.length);
      if (this.retainedToken === null) {
        this.buffer = EMPTY;
        this.discarding = true;
      }
    }
  }
}
