/**
 * Host HTTP/2 server for the sandbox callback bridge transport.
 *
 * The server wraps one {@link CommandManagedDuplexChannel} as a Node `Duplex`
 * and runs one plaintext HTTP/2 session on it. It maps every stream on that
 * session to one call of the caller-supplied `forwardRequest` handler, then
 * writes the result back as the stream response. The handler applies the real
 * host token and the run attribution, so those rules stay in one place, next
 * to the existing file-bridge and duplex-bridge forward path.
 *
 * This file does not select the transport for a run. It builds and tests the
 * host half of the pair in isolation; a later phase wires the pair into the
 * transport-selection path.
 *
 * Requests flow from the sandbox to the host only: the host never opens a
 * stream to the sandbox. The server enforces three checks, in this order, for
 * every stream:
 *   1. a constant-time compare of the bridge token against the per-run token
 *      (accepted security fix 4), before any other processing;
 *   2. one canonical parse of the `:path` pseudo-header (accepted security fix
 *      3), whose result feeds both the route allowlist and the forward URL;
 *   3. the route allowlist and the header allowlist, reused unchanged from
 *      `sandbox-callback-bridge.ts`.
 * The server also bounds ten `http2.createServer` options (accepted security
 * fix 1), so Node enforces the session, header, and stream-reset limits on
 * every connection with no new component.
 */

import { Duplex } from "node:stream";
import http2 from "node:http2";

import type { CommandManagedDuplexChannel } from "./command-managed-runtime.js";
import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  compareBridgeTokensConstantTime,
  sanitizeSandboxCallbackBridgeHeaders,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
  type SandboxCallbackBridgeRouteRule,
} from "./sandbox-callback-bridge.js";

// ---------------------------------------------------------------------------
// Bounded server options (accepted security fix 1). Node enforces each value,
// so naming them adds configuration and no new component. Every value and
// every name below matches the board-approved table exactly.
// ---------------------------------------------------------------------------

/** Server push. The transport never needs it. */
export const HTTP2_BRIDGE_ENABLE_PUSH = false;
/**
 * Open streams. The host keeps one forward, its request body, and its
 * response body alive for the life of a stream, and — before this file binds
 * each forward to its own stream's abort signal — a forward can outlive its
 * stream's own HTTP/2 slot until the forward's own timeout runs out. The
 * forward path carries a request body and a response body as raw `Buffer`
 * values with no string copy. Counting every retained `Buffer` copy of one
 * stream's request and response body against the
 * {@link DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES} body limit
 * (`sandbox-callback-bridge.ts`) gives an accounting peak of four times that
 * limit for one live forward. This bound is the per-route in-flight-body
 * budget: `HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS * 4 *
 * DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES` bytes = 4 * 4 * 10,551,296
 * bytes = 168,820,736 bytes (161 MiB) for one route. {@link
 * HTTP2_BRIDGE_MAX_ROUTE_BODY_BYTES} enforces this figure as a real, live
 * cap on every reservation, so one busy route cannot pass it, no matter how
 * much of the process-wide ceiling below still sits free.
 *
 * Aggregate behavior: the host process admits up to
 * `DEFAULT_MAX_CONCURRENT_DUPLEX_ROUTES` (128, in `plugin-worker-manager.ts`)
 * routes at the same time. The aggregate across every route is bounded too:
 * every stream's {@link BridgeBodyReservation} owner also reserves against
 * the shared {@link HTTP2_BRIDGE_MAX_PROCESS_BODY_BYTES} total
 * (1,073,741,824 bytes, 1 GiB), so the process retains no more than that
 * many live body bytes no matter how many routes or streams run at once. One
 * full-size stream's four retained copies cost `4 * 10,551,296` =
 * 42,205,184 bytes of that total, so the process admits at least 25
 * concurrent full-size streams, spread across at least six routes each at
 * their own per-route ceiling, before it starts denying the rest with a 503
 * response.
 */
export const HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS = 4;
/** One decompressed header list. The Node default is 65535. */
export const HTTP2_BRIDGE_MAX_HEADER_LIST_SIZE = 16384;
/** The header-compression table. This keeps the Node default. */
export const HTTP2_BRIDGE_HEADER_TABLE_SIZE = 4096;
/** Session memory in mebibytes. The Node default is 10. */
export const HTTP2_BRIDGE_MAX_SESSION_MEMORY = 16;
/** Header pairs per request. This names the Node default. */
export const HTTP2_BRIDGE_MAX_HEADER_LIST_PAIRS = 128;
/** The outbound compression table. */
export const HTTP2_BRIDGE_MAX_DEFLATE_DYNAMIC_TABLE_SIZE = 4096;
/** Invalid frames before Node closes the session. */
export const HTTP2_BRIDGE_MAX_SESSION_INVALID_FRAMES = 100;
/** Rejected streams before Node closes the session. */
export const HTTP2_BRIDGE_MAX_SESSION_REJECTED_STREAMS = 100;
/** The stream-reset budget (frames per interval). Node sends GOAWAY past the budget. */
export const HTTP2_BRIDGE_STREAM_RESET_RATE = 10;
/** The stream-reset budget (burst allowance). Node sends GOAWAY past the budget. */
export const HTTP2_BRIDGE_STREAM_RESET_BURST = 100;

/**
 * The full bounded options object. The server passes this object, unchanged,
 * to `http2.createServer`. A test asserts every value on this object, so it
 * proves the running server actually carries the bound, not only that the
 * named constant exists.
 */
export const HTTP2_BRIDGE_SERVER_OPTIONS: http2.ServerOptions = {
  settings: {
    enablePush: HTTP2_BRIDGE_ENABLE_PUSH,
    maxConcurrentStreams: HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS,
    maxHeaderListSize: HTTP2_BRIDGE_MAX_HEADER_LIST_SIZE,
    headerTableSize: HTTP2_BRIDGE_HEADER_TABLE_SIZE,
  },
  maxSessionMemory: HTTP2_BRIDGE_MAX_SESSION_MEMORY,
  maxHeaderListPairs: HTTP2_BRIDGE_MAX_HEADER_LIST_PAIRS,
  maxDeflateDynamicTableSize: HTTP2_BRIDGE_MAX_DEFLATE_DYNAMIC_TABLE_SIZE,
  maxSessionInvalidFrames: HTTP2_BRIDGE_MAX_SESSION_INVALID_FRAMES,
  maxSessionRejectedStreams: HTTP2_BRIDGE_MAX_SESSION_REJECTED_STREAMS,
  streamResetRate: HTTP2_BRIDGE_STREAM_RESET_RATE,
  streamResetBurst: HTTP2_BRIDGE_STREAM_RESET_BURST,
};

// ---------------------------------------------------------------------------
// Process-wide body byte reservation
// ---------------------------------------------------------------------------

/**
 * The most process memory, in bytes, this file lets every route hold in live
 * request and response body buffers at the same time. Every
 * {@link BridgeBodyReservation} owner reserves against this one shared
 * total, so no combination of concurrent streams, across every route, can
 * retain more than this many bytes at once. This value keeps the accepted
 * process ceiling at 1,073,741,824 bytes (1 GiB) — the same ceiling
 * `doc/observability.md` already accepted before the per-body limit rose to
 * 10 MiB — now enforced by this reservation instead of left as an unenforced
 * document note. See the per-route budget comment above for the full
 * accounting.
 */
export const HTTP2_BRIDGE_MAX_PROCESS_BODY_BYTES = 1024 * 1024 * 1024;

/**
 * The most memory, in bytes, one route (one {@link createHttp2BridgeServer}
 * call, one sandbox run's bridge session) may hold in live request and
 * response body buffers at the same time, on top of the shared process-wide
 * ceiling above. This is the same per-route figure the budget comment above
 * already derives from stream concurrency: naming it here and checking it on
 * every reservation stops one busy route from spending the whole
 * process-wide ceiling and denying every sibling route admission. See that
 * comment for the full accounting.
 */
export const HTTP2_BRIDGE_MAX_ROUTE_BODY_BYTES =
  HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS * 4 * DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES;

// The process-wide running total, in bytes, every `BridgeBodyReservation`
// owner reserves against. Module-scope state is correct here: one host
// process runs one bridge, and every route and every stream in that process
// must share the same ceiling.
let reservedProcessBodyBytes = 0;

/**
 * One route's own running total, in bytes, against
 * {@link HTTP2_BRIDGE_MAX_ROUTE_BODY_BYTES}. `createHttp2BridgeServer`
 * creates exactly one ledger per route and every stream that route ever
 * handles reserves against it, so one route's own activity can never pass
 * its own ceiling, regardless of how much of the process-wide total remains
 * free for other routes.
 */
export interface BridgeRouteBodyLedger {
  /**
   * Reserve `byteCount` more bytes against this route's own ceiling. Returns
   * `false`, and reserves nothing, when the new route total would pass
   * {@link HTTP2_BRIDGE_MAX_ROUTE_BODY_BYTES}.
   */
  reserve(byteCount: number): boolean;
  /** Release `byteCount` bytes this route previously reserved. */
  release(byteCount: number): void;
  /** The bytes this route currently holds. */
  readonly reservedBytes: number;
}

/** Create one fresh {@link BridgeRouteBodyLedger}, holding zero bytes. One
 * `createHttp2BridgeServer` call creates exactly one, before its first
 * stream, and every stream that route ever handles shares it. */
export function createBridgeRouteBodyLedger(): BridgeRouteBodyLedger {
  let reservedBytes = 0;
  return {
    reserve(byteCount: number): boolean {
      if (reservedBytes + byteCount > HTTP2_BRIDGE_MAX_ROUTE_BODY_BYTES) {
        return false;
      }
      reservedBytes += byteCount;
      return true;
    },
    release(byteCount: number): void {
      reservedBytes -= byteCount;
    },
    get reservedBytes(): number {
      return reservedBytes;
    },
  };
}

/**
 * One HTTP/2 stream's reservation owner. `handleStream` creates exactly one
 * owner per stream and releases it in its existing `finally` block, so every
 * live request or response body buffer that stream produces reserves
 * against the same owner, and the process reclaims those bytes exactly one
 * time when the stream ends.
 */
export interface BridgeBodyReservation {
  /**
   * Reserve `byteCount` more bytes against the process-wide total, and
   * against this owner's route ledger when it has one. Returns `false` and
   * reserves nothing against either total when either check fails. A failed
   * reservation allocates nothing: the caller must not copy the bytes it
   * asked to reserve.
   */
  reserve(byteCount: number): boolean;
  /**
   * Release every byte this owner currently holds. Safe to call more than
   * one time: a second call releases nothing.
   */
  release(): void;
  /** The bytes this owner currently holds. */
  readonly heldBytes: number;
}

/**
 * Create one fresh {@link BridgeBodyReservation} owner, holding zero bytes.
 * A caller that passes `routeLedger` also checks and reserves against that
 * route's own ceiling on every call, isolating this owner's route from every
 * other route sharing the process-wide total. A caller with no route to
 * isolate (a test filling only the process-wide total, for example) omits
 * it, and this owner checks the process-wide ceiling alone.
 */
export function createBridgeBodyReservation(routeLedger?: BridgeRouteBodyLedger): BridgeBodyReservation {
  let heldBytes = 0;
  let released = false;
  return {
    reserve(byteCount: number): boolean {
      if (released) return false;
      if (reservedProcessBodyBytes + byteCount > HTTP2_BRIDGE_MAX_PROCESS_BODY_BYTES) {
        return false;
      }
      if (routeLedger && !routeLedger.reserve(byteCount)) {
        return false;
      }
      reservedProcessBodyBytes += byteCount;
      heldBytes += byteCount;
      return true;
    },
    release(): void {
      if (released) return;
      released = true;
      reservedProcessBodyBytes -= heldBytes;
      routeLedger?.release(heldBytes);
      heldBytes = 0;
    },
    get heldBytes(): number {
      return heldBytes;
    },
  };
}

/**
 * A reservation owner denied a request or response body copy because the
 * process-wide ceiling would otherwise be passed. The stream handler answers
 * 503 for this error, not 413: a 413 tells a caller its own body is too
 * large; a 503 tells a caller the host is busy and to retry later.
 */
export class BridgeProcessCapacityError extends Error {
  constructor() {
    super("The bridge host reached its reserved process body byte ceiling. Retry later.");
    this.name = "BridgeProcessCapacityError";
  }
}

/**
 * Test-only. Reset the process-wide reservation total to zero. A test file
 * that exercises {@link createBridgeBodyReservation} must call this between
 * tests, so a reservation one test left unreleased cannot lower the ceiling
 * for a later test.
 */
export function resetBridgeBodyReservationsForTest(): void {
  reservedProcessBodyBytes = 0;
}

/** Test-only. Read the current process-wide reservation total. */
export function getBridgeBodyReservedBytesForTest(): number {
  return reservedProcessBodyBytes;
}

// ---------------------------------------------------------------------------
// Duplex channel adapter
// ---------------------------------------------------------------------------

/** The default cap, in bytes, on the read-side queue {@link wrapDuplexChannelAsNodeDuplex}
 * holds once `Duplex.push()` reports the readable side is full (a `false`
 * return). A sandbox-controlled channel has no upstream pause: `onData` below
 * keeps delivering bytes whether or not the HTTP/2 session keeps up with
 * them. Past this cap the wrapper treats the channel as stuck, not merely
 * slow, and fails closed: it stops the channel and destroys the `Duplex`, so
 * a producer that keeps outpacing its reader cannot grow host memory without
 * bound. This cap also bounds one single chunk: the wrapper checks a chunk's
 * own size against it before `push()` ever runs, so one oversized chunk
 * cannot cross the cap on its first delivery, before the queue holds
 * anything to compare it against. This is a fixed share of the fixed
 * per-route byte budget the host bounds every duplex retention site
 * against; it no longer derives from {@link HTTP2_BRIDGE_MAX_SESSION_MEMORY},
 * which bounds the underlying `Http2Session`'s own memory, not this
 * read-side queue. */
export const DEFAULT_HTTP2_BRIDGE_MAX_BUFFERED_READ_BYTES = 524_288;
/** The default bound, in milliseconds, on how long the read-side queue
 * {@link wrapDuplexChannelAsNodeDuplex} holds can stay non-empty with no
 * chunk draining from it. The byte cap above bounds how much memory a stuck
 * reader can hold; it does not bound how long the reader can stay stuck. A
 * consumer that never resumes reading would otherwise hold the channel open,
 * backpressured, for as long as the queue stays under the byte cap. Each
 * drained chunk renews this bound, so a consumer that keeps making real
 * progress never trips it; only a consumer that stops resuming entirely
 * does. */
export const DEFAULT_HTTP2_BRIDGE_READ_BACKPRESSURE_STALL_MS = 30_000;

/**
 * Wrap a {@link CommandManagedDuplexChannel} as a Node `Duplex`, so an
 * `Http2Server` can run one session directly on it (`server.emit("connection",
 * duplex)`). The wrapper never buffers more than one write in flight: it calls
 * the stream write callback only after the channel's own write call settles
 * (the backpressure constraint), never as a delivery signal. The provider
 * accepts many megabytes in milliseconds and holds them in its own buffer, so
 * this direction stays governed by the channel's own write-settle timing.
 *
 * The read direction needs its own bound. The channel exposes no pause: once
 * `onData` below is registered, the channel keeps calling it for every byte
 * the sandbox sends, with no way for this wrapper to slow it down. Node's
 * `Duplex.push()` reports back-pressure through its boolean return, not by
 * refusing the call, so a caller that ignores a `false` return and keeps
 * pushing grows the readable side's internal buffer with no limit. This
 * wrapper honors that signal instead: while `push()` reports room, it pushes
 * directly; once `push()` reports the readable side is full, it queues each
 * later chunk instead of pushing past that signal, and drains the queue from
 * `read()`, which Node calls again only once the consumer wants more. Every
 * chunk, on either path, first checks against
 * {@link DEFAULT_HTTP2_BRIDGE_MAX_BUFFERED_READ_BYTES} (or the caller's
 * `maxBufferedReadBytes`) on its own size, and the queue checks against the
 * same cap on its cumulative size: past either check the wrapper fails
 * closed instead of buffering further, because the channel has no pause to
 * fall back on. A second, independent bound —
 * {@link DEFAULT_HTTP2_BRIDGE_READ_BACKPRESSURE_STALL_MS} (or the caller's
 * `readBackpressureStallMs`) — covers the case the byte cap does not: a
 * consumer that stops reading entirely, so the queue never grows past the
 * byte cap but also never drains. This bound renews on every chunk the
 * queue drains, so a consumer that keeps making real progress never trips
 * it.
 */
export function wrapDuplexChannelAsNodeDuplex(
  channel: CommandManagedDuplexChannel,
  options: { maxBufferedReadBytes?: number; readBackpressureStallMs?: number } = {},
): Duplex {
  const maxBufferedReadBytes = options.maxBufferedReadBytes ?? DEFAULT_HTTP2_BRIDGE_MAX_BUFFERED_READ_BYTES;
  const readBackpressureStallMs =
    options.readBackpressureStallMs ?? DEFAULT_HTTP2_BRIDGE_READ_BACKPRESSURE_STALL_MS;
  // Chunks `onData` already delivered that `push()` has not yet accepted,
  // in arrival order. `read()` drains this queue before it lets Node pull
  // any new bytes, so the delivery order the channel used stays intact.
  const pendingReads: Buffer[] = [];
  let pendingReadBytes = 0;
  // True once `push()` last reported room for more, or before the first
  // push call. `onData` pushes directly while this holds; once a `push()`
  // call reports no room, later chunks queue in `pendingReads` instead.
  let canPushMore = true;
  // True once the channel exited. `endReadableIfDrained` pushes `null` only
  // after the queue this wrapper still holds fully drains, so a chunk that
  // arrived before the exit is never dropped.
  let channelExited = false;
  // Arms while the queue holds at least one chunk; clears once it fully
  // drains. Fires `readBackpressureStallMs` after the queue's last drain (or
  // its first chunk, if it never drained at all) with no further drain, so a
  // consumer that stops resuming does not hold the channel open forever
  // under the byte cap.
  let backpressureStallTimer: ReturnType<typeof setTimeout> | undefined;

  function clearBackpressureStallTimer(): void {
    if (backpressureStallTimer === undefined) return;
    clearTimeout(backpressureStallTimer);
    backpressureStallTimer = undefined;
  }

  function armBackpressureStallTimer(): void {
    clearBackpressureStallTimer();
    backpressureStallTimer = setTimeout(() => {
      failClosed(
        "Sandbox HTTP/2 channel's read backpressure queue did not drain within the stall bound; the reader appears stuck.",
      );
    }, readBackpressureStallMs);
    backpressureStallTimer.unref?.();
  }

  function failClosed(message: string): void {
    clearBackpressureStallTimer();
    channel.stop();
    duplex.destroy(new Error(message));
  }

  function endReadableIfDrained(): void {
    if (!channelExited || pendingReads.length > 0 || duplex.destroyed) return;
    duplex.push(null);
  }

  const duplex: Duplex = new Duplex({
    read() {
      canPushMore = true;
      let drainedAChunk = false;
      while (canPushMore && pendingReads.length > 0) {
        const next = pendingReads.shift();
        if (next === undefined) break;
        pendingReadBytes -= next.byteLength;
        drainedAChunk = true;
        canPushMore = duplex.push(next);
      }
      if (pendingReads.length === 0) {
        clearBackpressureStallTimer();
      } else if (drainedAChunk) {
        // The queue still holds chunks, but at least one drained just now:
        // real progress, so the stall bound renews instead of expiring under
        // a consumer that is still reading, only slowly.
        armBackpressureStallTimer();
      }
      endReadableIfDrained();
    },
    write(chunk: unknown, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
      let settleResult: unknown;
      try {
        settleResult = channel.write(bytes);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (
        settleResult != null &&
        typeof (settleResult as Promise<void>).then === "function"
      ) {
        (settleResult as Promise<void>).then(
          () => callback(),
          (error) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      } else {
        callback();
      }
    },
    final(callback) {
      channel
        .close()
        .then(() => callback(), (error) => callback(error instanceof Error ? error : new Error(String(error))));
    },
  });
  channel.onData((chunk) => {
    if (duplex.destroyed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Check one chunk's own size against the cap before either path below
    // runs. `push()` never refuses a call on its size, so a single chunk
    // larger than the whole cap would otherwise reach Node's internal
    // buffer unbounded on the direct-push path, before the queue this
    // wrapper owns ever holds anything to compare a later chunk against.
    if (bytes.byteLength > maxBufferedReadBytes) {
      failClosed(
        "Sandbox HTTP/2 channel delivered one chunk larger than the bounded read backpressure buffer.",
      );
      return;
    }
    if (canPushMore && pendingReads.length === 0) {
      canPushMore = duplex.push(bytes);
      return;
    }
    // The readable side already reported it is full, and the channel has no
    // pause to slow the sandbox side down: queue this chunk instead of
    // pushing past that signal. Bound the queue, so a producer that keeps
    // outpacing its reader cannot grow it without limit.
    if (pendingReads.length === 0) {
      // The queue was empty until this chunk: arm the stall bound, so a
      // consumer that never resumes reading still ends the channel, even
      // though this chunk alone stays under the byte cap.
      armBackpressureStallTimer();
    }
    pendingReadBytes += bytes.byteLength;
    if (pendingReadBytes > maxBufferedReadBytes) {
      failClosed(
        "Sandbox HTTP/2 channel exceeded the bounded read backpressure buffer; the reader could not keep up.",
      );
      return;
    }
    pendingReads.push(bytes);
  });
  channel.onExit(() => {
    channelExited = true;
    endReadableIfDrained();
  });
  // The channel exited, or `read()`/`onData` above failed the `Duplex`
  // closed: either way, no further chunk will ever drain, so the stall
  // timer serves no purpose and only holds a stray handle open.
  duplex.once("close", clearBackpressureStallTimer);
  return duplex;
}

// ---------------------------------------------------------------------------
// Canonical `:path` parsing (accepted security fix 3)
// ---------------------------------------------------------------------------

/** The reason {@link parseCanonicalBridgeRequestPath} rejected one request. */
export type CanonicalBridgeRequestPathRejection =
  | "missing_path"
  | "duplicate_pseudo_header"
  | "non_origin_form"
  | "encoded_slash"
  | "backslash"
  | "nul_byte"
  | "dot_segment";

/** The one parsed pathname and query. Both the route allowlist and the forward
 * URL builder read this same value; the host never parses `:path` twice. */
export interface CanonicalBridgeRequestPath {
  pathname: string;
  /** The query string, in `URL.search` form: empty, or a leading `?`. */
  query: string;
}

export type CanonicalBridgeRequestPathResult =
  | { ok: true; value: CanonicalBridgeRequestPath }
  | { ok: false; reason: CanonicalBridgeRequestPathRejection };

/** The request pseudo-headers HTTP/2 allows exactly one of, per request. */
const REQUEST_PSEUDO_HEADER_NAMES = [":method", ":scheme", ":authority", ":path"] as const;

/**
 * Parse the `:path` pseudo-header exactly one time. The caller passes the
 * returned pathname and query to both the route allowlist and the forward URL
 * builder — never a second, independent parse of the raw header.
 *
 * The parser rejects a request that carries any of: a duplicate pseudo-header,
 * a missing or empty `:path`, a non-origin-form path, an encoded slash, a
 * backslash, a NUL byte, or a dot segment (checked before URL normalization
 * would silently remove it, and after percent-decoding each segment, so an
 * encoded dot segment cannot slip through).
 */
export function parseCanonicalBridgeRequestPath(
  headers: http2.IncomingHttpHeaders,
): CanonicalBridgeRequestPathResult {
  for (const name of REQUEST_PSEUDO_HEADER_NAMES) {
    if (Array.isArray((headers as Record<string, unknown>)[name])) {
      return { ok: false, reason: "duplicate_pseudo_header" };
    }
  }
  const rawPath = headers[":path"];
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, reason: "missing_path" };
  }
  // Origin-form only: a single leading "/", never "//" (network-path form) and
  // never an absolute-form URI ("scheme://...").
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("://")) {
    return { ok: false, reason: "non_origin_form" };
  }
  if (/%2f/i.test(rawPath)) {
    return { ok: false, reason: "encoded_slash" };
  }
  if (rawPath.includes("\\")) {
    return { ok: false, reason: "backslash" };
  }
  if (rawPath.includes("\0") || /%00/i.test(rawPath)) {
    return { ok: false, reason: "nul_byte" };
  }
  const queryIndex = rawPath.indexOf("?");
  const rawPathname = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
  for (const segment of rawPathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return { ok: false, reason: "non_origin_form" };
    }
    if (decoded === "." || decoded === "..") {
      return { ok: false, reason: "dot_segment" };
    }
  }
  // Every raw-string check above passed, and the path carries no dot segment,
  // so `URL` normalization here changes nothing but percent-encoding; it stays
  // safe to build the canonical pathname and query from it.
  let url: URL;
  try {
    url = new URL(rawPath, "http://bridge.internal");
  } catch {
    return { ok: false, reason: "non_origin_form" };
  }
  return { ok: true, value: { pathname: url.pathname, query: url.search } };
}

/**
 * Build the forward URL from the one canonical parse. This mirrors
 * `buildBridgeForwardUrl` in `execution-target.ts`, which the file bridge and
 * the duplex bridge use today; a later phase wires the HTTP/2 host handler to
 * that same forward path and can consolidate the two into one export.
 */
export function buildHttp2BridgeForwardUrl(
  baseUrl: string,
  request: CanonicalBridgeRequestPath,
): URL {
  const url = new URL(request.pathname, baseUrl);
  const query = request.query.trim();
  url.search = query.startsWith("?") ? query.slice(1) : query;
  return url;
}

// ---------------------------------------------------------------------------
// PING stall detection
// ---------------------------------------------------------------------------

/** The default interval between two liveness PING frames, in milliseconds. */
export const DEFAULT_HTTP2_BRIDGE_PING_INTERVAL_MS = 5_000;
/** The default bound a sent PING waits for its ack before the session counts as stalled. */
export const DEFAULT_HTTP2_BRIDGE_PING_STALL_MS = 20_000;
/** The default idle bound on a request body read: the maximum gap between
 * two received chunks (or between the token check and the first chunk)
 * before the server treats the stream as stalled. Each received chunk resets
 * this bound, so a slow peer that keeps making real progress completes; only
 * a peer that stops sending trips it. */
export const DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_TIMEOUT_MS = 30_000;
/** The default hard ceiling on a request body read's total lifetime: an
 * absolute bound armed once, at the start of the read, and never renewed by
 * later progress. This bound is independent of
 * {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_TIMEOUT_MS}: the idle bound
 * resets on every chunk to catch a peer that stops sending; this ceiling
 * catches a peer that never stops sending but also never finishes, so a
 * peer cannot use a steady trickle of small chunks to hold a
 * {@link HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS} stream slot open forever. Set
 * well above {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_TIMEOUT_MS} so a
 * legitimate upload that makes real but slow progress — a chunk every few
 * seconds, well inside the idle bound — still has room to finish. */
export const DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_LIFETIME_CEILING_MS = 480_000;
/** The default bound {@link Http2BridgeServerHandle.close} waits for an
 * active session to close on its own before it force-destroys the session. A
 * session that carries a stalled stream would otherwise hold `close()` open
 * forever, because `session.close()` waits for every open stream to end. */
export const DEFAULT_HTTP2_BRIDGE_CLOSE_GRACE_MS = 5_000;

function startHttp2BridgePingWatchdog(
  session: http2.ServerHttp2Session,
  input: { intervalMs: number; stallMs: number; onStall: (error: Error) => void },
): () => void {
  let stopped = false;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  function sendOnePing(): void {
    if (stopped) return;
    stallTimer = setTimeout(() => {
      if (stopped) return;
      stopped = true;
      input.onStall(new Error("HTTP/2 bridge session stalled: no PING ack within the stall bound."));
    }, input.stallMs);
    stallTimer.unref?.();
    try {
      session.ping((error) => {
        if (stopped) return;
        if (stallTimer) clearTimeout(stallTimer);
        if (error) {
          stopped = true;
          input.onStall(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        pingTimer = setTimeout(sendOnePing, input.intervalMs);
        pingTimer.unref?.();
      });
    } catch (error) {
      if (stallTimer) clearTimeout(stallTimer);
      stopped = true;
      input.onStall(error instanceof Error ? error : new Error(String(error)));
    }
  }

  pingTimer = setTimeout(sendOnePing, input.intervalMs);
  pingTimer.unref?.();

  return () => {
    stopped = true;
    if (pingTimer) clearTimeout(pingTimer);
    if (stallTimer) clearTimeout(stallTimer);
  };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** The result of one forward call. The server turns it into one stream response. */
export interface Http2BridgeForwardResult {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer;
}

/**
 * The one canonically-parsed, route-authorized, header-sanitized request the
 * server hands to the forward handler.
 */
export interface Http2BridgeForwardRequest {
  method: string;
  pathname: string;
  query: string;
  headers: Record<string, string>;
  body: Buffer;
  /**
   * The abort signal for this one HTTP/2 stream. `handleStream` aborts it
   * when the stream closes, aborts, or errors, so a caller that passes it
   * through to its own outbound call (a `fetch`, for example) ends that call
   * at once instead of leaving it to run until its own timeout. The signal
   * never fires for any other stream or for the session.
   */
  signal: AbortSignal;
  /**
   * This stream's one {@link BridgeBodyReservation} owner. A forward handler
   * that itself retains a full response body buffer — `execution-target.ts`
   * does, through `forwardBridgeRequest`'s optional `reservation` option —
   * reserves against this same owner, so the request body and the response
   * body of one stream share one ceiling. `handleStream` releases this owner
   * exactly one time, after the forward call settles; the forward handler
   * must never release it.
   */
  reservation: BridgeBodyReservation;
}

export type Http2BridgeForwardHandler = (
  request: Http2BridgeForwardRequest,
) => Promise<Http2BridgeForwardResult>;

/** The GOAWAY the server observed, naming the last stream ID the peer processed. */
export interface Http2BridgeGoawayRecord {
  lastStreamId: number;
  errorCode: number;
}

/** Classify one stream ID against an observed GOAWAY's last processed stream ID. */
export function classifyStreamAgainstGoaway(
  streamId: number,
  lastStreamId: number,
): "accepted" | "not_accepted" {
  return streamId <= lastStreamId ? "accepted" : "not_accepted";
}

export interface CreateHttp2BridgeServerOptions {
  /** The per-run bridge token. The server compares it, constant-time, against
   * the token on every stream before route or header processing. */
  bridgeToken: string;
  /** The forward handler the server calls for each authorized request. */
  forwardRequest: Http2BridgeForwardHandler;
  /** The route allowlist. The default is {@link DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST}. */
  routes?: readonly SandboxCallbackBridgeRouteRule[];
  /** The header allowlist. The default is {@link DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST}. */
  headerAllowlist?: readonly string[];
  /** The maximum request body size, in bytes. The default is {@link DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
  /** The interval between two liveness PING frames, in milliseconds. */
  pingIntervalMs?: number;
  /** The bound a sent PING waits for its ack before the server closes the session. */
  pingStallMs?: number;
  /** The idle bound on a request body read: the maximum gap between two
   * received chunks. The default is
   * {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_TIMEOUT_MS}. */
  requestBodyTimeoutMs?: number;
  /** The hard ceiling on a request body read's total lifetime, armed once
   * and never renewed by progress. See
   * {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_LIFETIME_CEILING_MS} for the
   * default and the reasoning behind it. */
  requestBodyLifetimeCeilingMs?: number;
  /** The bound {@link Http2BridgeServerHandle.close} waits for an active
   * session to close on its own before it force-destroys the session. The
   * default is {@link DEFAULT_HTTP2_BRIDGE_CLOSE_GRACE_MS}. */
  closeGraceMs?: number;
  /** The cap, in bytes, on data this server holds once a bound `Duplex`
   * reports its readable side is full (`push()` returns `false`). Past this
   * cap the server treats the channel as stuck, not merely slow: see
   * {@link wrapDuplexChannelAsNodeDuplex}. The default is
   * {@link DEFAULT_HTTP2_BRIDGE_MAX_BUFFERED_READ_BYTES}. */
  maxBufferedReadBytes?: number;
  /** The bound, in milliseconds, on how long the read backpressure queue
   * {@link wrapDuplexChannelAsNodeDuplex} holds can stay non-empty with no
   * chunk draining from it. The default is
   * {@link DEFAULT_HTTP2_BRIDGE_READ_BACKPRESSURE_STALL_MS}. */
  readBackpressureStallMs?: number;
  /** The sink for a GOAWAY the server observed on a session (one the sandbox
   * side sent to the host). */
  onGoaway?: (record: Http2BridgeGoawayRecord) => void;
  /** The sink for a session-level fault (a stall, a protocol fault). */
  onSessionError?: (error: Error) => void;
  /**
   * Fires once for each new session. A caller uses the live
   * `ServerHttp2Session` to send its own GOAWAY (accepted security fix's
   * GOAWAY-classification behavior is meaningful only from the side that
   * names the last stream it processed — the host, since every stream
   * originates from the sandbox). A test uses this hook to drive the
   * GOAWAY test deterministically.
   */
  onSession?: (session: http2.ServerHttp2Session) => void;
}

/** The handle {@link createHttp2BridgeServer} returns. */
export interface Http2BridgeServerHandle {
  /** The underlying `Http2Server`. It is never `listen()`-ed; every session
   * binds through {@link Http2BridgeServerHandle.bindChannel}. */
  readonly server: http2.Http2Server;
  /** Wrap the channel as a `Duplex` and run one HTTP/2 session on it. Returns
   * the wrapped `Duplex`, so a caller can also drive it directly (a test uses
   * this to bind one side of a paired in-memory `Duplex`). */
  bindChannel(channel: CommandManagedDuplexChannel): Duplex;
  /** Close every active session. Safe to call more than one time. */
  close(): Promise<void>;
}

function normalizeStreamMethod(value: string | string[] | undefined): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toUpperCase() : "GET";
}

function readBridgeTokenHeader(headers: http2.IncomingHttpHeaders): string | undefined {
  const raw = headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return undefined;
  return raw.slice("Bearer ".length);
}

function toOutboundHeaderRecord(headers: http2.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith(":") || value == null) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/** The size and time bounds a request body read enforces. */
export interface Http2BridgeBodyBounds {
  /** The maximum request body size, in bytes. */
  maxBodyBytes: number;
  /** The idle bound: see {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_TIMEOUT_MS}. */
  idleTimeoutMs: number;
  /** The lifetime ceiling: see {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_LIFETIME_CEILING_MS}. */
  lifetimeCeilingMs: number;
}

/**
 * Read one request body, bounded on size and on two independent time
 * bounds: an idle bound and a total-lifetime ceiling. See
 * {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_TIMEOUT_MS} and
 * {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_LIFETIME_CEILING_MS} for why the
 * server enforces each one.
 *
 * The `close` listener is the settle-of-last-resort: it fires whenever the
 * stream ends for any reason at all — a normal end, an error, a timeout- or
 * shutdown-triggered `destroy()`, or a peer reset — so the promise always
 * settles and the caller never awaits a stream that already went away.
 *
 * `onChunk` and `onEnd` decide what the read retains, if anything:
 * {@link readHttp2StreamBody} accumulates chunks and reserves against a
 * {@link BridgeBodyReservation}; {@link drainHttp2StreamBody} discards every
 * chunk and reserves nothing. Either callback may throw to reject the read
 * (a denied reservation, for example) — the throw destroys the stream the
 * same way a size, idle, or lifetime fault does.
 */
function readOrDrainHttp2StreamBody<T>(
  stream: http2.ServerHttp2Stream,
  bounds: Http2BridgeBodyBounds,
  onChunk: (chunk: Buffer, totalBytes: number) => void,
  onEnd: () => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout>;
    let lifetimeCeilingTimer: ReturnType<typeof setTimeout>;
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(lifetimeCeilingTimer);
      run();
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        settle(() => reject(new Error("Bridge request body stalled before it completed.")));
        stream.destroy();
      }, bounds.idleTimeoutMs);
      idleTimer.unref?.();
    };
    // Arms one time, when the read starts, and never rearms on a chunk: see
    // DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_LIFETIME_CEILING_MS for why the
    // ceiling must stay independent of progress.
    lifetimeCeilingTimer = setTimeout(() => {
      settle(() => reject(new Error("Bridge request body passed the total lifetime ceiling.")));
      stream.destroy();
    }, bounds.lifetimeCeilingMs);
    lifetimeCeilingTimer.unref?.();
    armIdleTimer();
    stream.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > bounds.maxBodyBytes) {
        settle(() => reject(new Error("Bridge request body exceeded the configured size limit.")));
        stream.destroy();
        return;
      }
      try {
        onChunk(chunk, totalBytes);
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
        // A denied reservation answers 503 through the caller's own
        // `respondJson` call, after this promise rejects — destroying the
        // stream here, before that call runs, would make it a no-op (a
        // destroyed stream refuses `.respond()`). The caller destroys the
        // stream itself, once its response is actually on the wire. Every
        // other body-read fault has no such response to protect, so it
        // destroys the stream immediately, exactly as before.
        if (!(error instanceof BridgeProcessCapacityError)) {
          stream.destroy();
        }
        return;
      }
      // The chunk is real progress, so the peer is not stalled: reset the
      // idle bound. The lifetime ceiling timer above does not reset here.
      armIdleTimer();
    });
    stream.once("end", () => {
      let result: T;
      try {
        result = onEnd();
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      settle(() => resolve(result));
    });
    stream.once("error", (error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
    stream.once("aborted", () => settle(() => reject(new Error("Bridge request stream aborted."))));
    stream.once("close", () => settle(() => reject(new Error("Bridge request stream closed before it completed."))));
  });
}

/**
 * Read one request body into a `Buffer`. When the caller passes a
 * `reservation`, this reserves each chunk's bytes against it before the
 * chunk joins the retained array, and reserves the concatenated buffer's own
 * byte count before `Buffer.concat` allocates it — the chunk array and the
 * concatenated buffer are two separate live copies, so both reserve. A
 * denied reservation rejects with {@link BridgeProcessCapacityError} and
 * destroys the stream, retaining no further chunk.
 */
function readHttp2StreamBody(
  stream: http2.ServerHttp2Stream,
  bounds: Http2BridgeBodyBounds,
  reservation?: BridgeBodyReservation,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  return readOrDrainHttp2StreamBody(
    stream,
    bounds,
    (chunk, totalBytes) => {
      if (reservation && !reservation.reserve(chunk.byteLength)) {
        throw new BridgeProcessCapacityError();
      }
      chunks.push(chunk);
      retainedBytes = totalBytes;
    },
    () => {
      if (reservation && !reservation.reserve(retainedBytes)) {
        throw new BridgeProcessCapacityError();
      }
      return Buffer.concat(chunks);
    },
  );
}

/**
 * Drain and discard one denied stream's request body, under the same size,
 * idle, and lifetime bounds an authenticated request gets, but retaining no
 * chunk and reserving no bytes. `denyRequest` calls this instead of
 * {@link readHttp2StreamBody}, so a stream that never carries a valid bridge
 * token cannot retain a full body buffer merely by sending one.
 */
function drainHttp2StreamBody(stream: http2.ServerHttp2Stream, bounds: Http2BridgeBodyBounds): Promise<void> {
  return readOrDrainHttp2StreamBody(
    stream,
    bounds,
    () => {
      // No `chunks.push`: a denied stream's body content never reaches the
      // forward handler, so this reader retains no chunk and reserves
      // nothing against the process ceiling.
    },
    () => undefined,
  );
}

/**
 * Wait until a stream's queued write actually leaves process memory, or
 * until the stream closes for any other reason. `stream.end(body)` only
 * queues `body` for asynchronous transmission: Node keeps the bytes in
 * memory until HTTP/2 flow control lets them flow, which a slow or
 * backpressured peer can delay well past the moment `end()` returns. A
 * caller that reserves the response body's bytes must hold that reservation
 * across this whole wait, not merely across the call to `end()`, or a
 * backpressured response keeps bytes in memory the ledger already believes
 * it reclaimed.
 *
 * `finish` is the normal settle: every queued byte reached the session. A
 * `close` or an `error` settle the wait the same way, so a peer reset or a
 * destroyed stream cannot leave a caller waiting forever for a `finish`
 * that will never come.
 */
function waitForHttp2StreamWriteToSettle(stream: http2.ServerHttp2Stream): Promise<void> {
  if (stream.writableFinished || stream.destroyed || stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    const onSettle = (): void => {
      stream.removeListener("finish", onSettle);
      stream.removeListener("close", onSettle);
      stream.removeListener("error", onSettle);
      resolve();
    };
    stream.once("finish", onSettle);
    stream.once("close", onSettle);
    stream.once("error", onSettle);
  });
}

function respondJson(stream: http2.ServerHttp2Stream, status: number, body: unknown): void {
  if (stream.destroyed || stream.closed) return;
  try {
    stream.respond({ ":status": status, "content-type": "application/json" });
    stream.end(JSON.stringify(body));
  } catch {
    // The peer reset the stream (RST_STREAM) before the server could answer.
    // That fault stays local to this one stream; every other stream and the
    // session itself stay unaffected.
  }
}

/**
 * Answer a denied stream, then consume and discard its request body under
 * the same bounds ({@link Http2BridgeBodyBounds}) an authenticated request
 * gets. A denied request's body content never reaches the forward handler,
 * but the inbound half of the stream still needs a bound: without one, a
 * peer that leaves the body unfinished keeps the stream open, holding one
 * of the {@link HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS} slots for as long as
 * it chooses. Nothing awaits the discard; the caller has already answered
 * the request and moves on to the next stream. The discard retains no
 * chunk and reserves no process byte budget: a stream that fails the bridge
 * token check gets no reservation, so it cannot retain a full body buffer
 * merely by sending one.
 */
function denyRequest(
  stream: http2.ServerHttp2Stream,
  status: number,
  body: unknown,
  bounds: Http2BridgeBodyBounds,
): void {
  respondJson(stream, status, body);
  if (stream.destroyed || stream.closed) return;
  drainHttp2StreamBody(stream, bounds).catch(() => {
    // The idle or lifetime bound above already destroyed the stream, or the
    // peer reset it first. Either way the slot is free; the discarded body
    // content is irrelevant to a denial.
  });
}

/**
 * Create the host HTTP/2 bridge server. The server runs no listener of its
 * own: a caller wraps one duplex channel through {@link Http2BridgeServerHandle.bindChannel}
 * per sandbox session.
 */
export function createHttp2BridgeServer(options: CreateHttp2BridgeServerOptions): Http2BridgeServerHandle {
  const routes = options.routes ?? DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST;
  const headerAllowlist = options.headerAllowlist ?? DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES;
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_HTTP2_BRIDGE_PING_INTERVAL_MS;
  const pingStallMs = options.pingStallMs ?? DEFAULT_HTTP2_BRIDGE_PING_STALL_MS;
  const requestBodyTimeoutMs = options.requestBodyTimeoutMs ?? DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_TIMEOUT_MS;
  const requestBodyLifetimeCeilingMs =
    options.requestBodyLifetimeCeilingMs ?? DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_LIFETIME_CEILING_MS;
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_HTTP2_BRIDGE_CLOSE_GRACE_MS;
  const maxBufferedReadBytes = options.maxBufferedReadBytes ?? DEFAULT_HTTP2_BRIDGE_MAX_BUFFERED_READ_BYTES;
  const readBackpressureStallMs =
    options.readBackpressureStallMs ?? DEFAULT_HTTP2_BRIDGE_READ_BACKPRESSURE_STALL_MS;
  // Built one time and passed to every readHttp2StreamBody() and
  // denyRequest() call below, so every stream on this server enforces the
  // same bounds.
  const bodyBounds: Http2BridgeBodyBounds = {
    maxBodyBytes,
    idleTimeoutMs: requestBodyTimeoutMs,
    lifetimeCeilingMs: requestBodyLifetimeCeilingMs,
  };

  const server = http2.createServer(HTTP2_BRIDGE_SERVER_OPTIONS);
  const activeSessions = new Set<http2.ServerHttp2Session>();
  // One route ledger for this one `createHttp2BridgeServer` call. Every
  // stream this route ever handles reserves against it, so this route's own
  // activity can never pass its own share of the process-wide ceiling and
  // deny a sibling route admission.
  const routeLedger = createBridgeRouteBodyLedger();

  async function handleStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): Promise<void> {
    // One `AbortController` for this one stream. `forwardRequest` below
    // receives its signal, so a stream that closes, aborts, or errors ends
    // its own forward at once instead of leaving the forward to run until its
    // own timeout. The abort stays local to this one stream: it never
    // touches the session or any other stream's controller.
    const controller = new AbortController();
    const abortForThisStream = (): void => {
      if (!controller.signal.aborted) controller.abort();
    };
    stream.once("close", abortForThisStream);
    stream.once("aborted", abortForThisStream);
    stream.once("error", abortForThisStream);
    // One reservation owner for this one stream's entire life. Every live
    // request or response body buffer this stream produces reserves against
    // this same owner; the `finally` block below releases it exactly one
    // time, on every exit path (a deny, a body-read fault, a forward fault,
    // or a completed response), including a peer reset or a timeout, both of
    // which route through the abort listeners above into the forward call's
    // combined signal, so the owner keeps its bytes reserved until that
    // forward call actually settles. It reserves against this route's own
    // ledger too, so it can never spend more than this route's own share of
    // the process-wide ceiling.
    const reservation = createBridgeBodyReservation(routeLedger);
    try {
      // Accepted security fix 4: the constant-time bridge-token compare runs
      // before route processing and before header processing. This host check
      // is independent of the gateway's own token check on the sandbox side.
      if (!compareBridgeTokensConstantTime(options.bridgeToken, readBridgeTokenHeader(headers))) {
        denyRequest(stream, 401, { error: "Invalid bridge token." }, bodyBounds);
        return;
      }

      // Accepted security fix 3: parse `:path` exactly one time; both the route
      // allowlist and the forward request below read this one result.
      const parsedPath = parseCanonicalBridgeRequestPath(headers);
      if (!parsedPath.ok) {
        denyRequest(stream, 400, { error: `Invalid request path: ${parsedPath.reason}` }, bodyBounds);
        return;
      }
      const method = normalizeStreamMethod(headers[":method"]);

      const denialReason = authorizeSandboxCallbackBridgeRequestWithRoutes(
        { method, path: parsedPath.value.pathname },
        routes,
      );
      if (denialReason) {
        denyRequest(stream, 403, { error: denialReason }, bodyBounds);
        return;
      }

      const sanitizedHeaders = sanitizeSandboxCallbackBridgeHeaders(
        toOutboundHeaderRecord(headers),
        headerAllowlist,
      );

      let body: Buffer;
      try {
        body = await readHttp2StreamBody(stream, bodyBounds, reservation);
      } catch (error) {
        if (error instanceof BridgeProcessCapacityError) {
          // The reader above left this stream open (undestroyed) exactly so
          // this response could reach the wire. `respondJson` only queues
          // the 503 write; destroying the stream right after queues a
          // RST_STREAM before a backpressured peer drains it, so the client
          // can see a reset instead of the 503. Wait for the write to
          // settle first, then destroy to free this stream's
          // concurrent-stream slot.
          respondJson(stream, 503, { error: error.message });
          await waitForHttp2StreamWriteToSettle(stream);
          if (!stream.destroyed) stream.destroy();
          return;
        }
        respondJson(stream, 413, { error: error instanceof Error ? error.message : String(error) });
        return;
      }

      let result: Http2BridgeForwardResult;
      try {
        result = await options.forwardRequest({
          method,
          pathname: parsedPath.value.pathname,
          query: parsedPath.value.query,
          headers: sanitizedHeaders,
          body,
          signal: controller.signal,
          reservation,
        });
      } catch (error) {
        respondJson(stream, 502, { error: error instanceof Error ? error.message : String(error) });
        return;
      }

      if (stream.destroyed || stream.closed) return;
      const responseHeaders: http2.OutgoingHttpHeaders = { ":status": result.status };
      for (const [key, value] of Object.entries(result.headers ?? {})) {
        if (key.toLowerCase() === "content-length") continue;
        responseHeaders[key] = value;
      }
      try {
        stream.respond(responseHeaders);
        stream.end(result.body);
        // `end()` only queues `result.body`; a slow or backpressured peer
        // can hold those bytes in process memory well after this call
        // returns. Wait for the write to actually settle before the
        // `finally` block below releases the reservation those bytes hold.
        await waitForHttp2StreamWriteToSettle(stream);
      } catch {
        // The peer reset the stream (RST_STREAM) between dispatch and response.
        // One stream's write fault stays local to that stream.
      }
    } finally {
      // Every path above reaches this exactly once: a deny, a body-read
      // fault, a forward fault, or a completed response. A completed stream
      // must leak no listener; the session, not this one stream, outlives
      // the handler. The reservation release is idempotent, but this is
      // still the one place this stream's owner ever releases: releasing
      // here, after the response write above has actually settled, keeps
      // the owner's bytes reserved for the whole time Node still holds a
      // live copy of them, not merely until the write call returns.
      reservation.release();
      stream.removeListener("close", abortForThisStream);
      stream.removeListener("aborted", abortForThisStream);
      stream.removeListener("error", abortForThisStream);
    }
  }

  server.on("session", (session) => {
    activeSessions.add(session);
    options.onSession?.(session);
    const stopWatchdog = startHttp2BridgePingWatchdog(session, {
      intervalMs: pingIntervalMs,
      stallMs: pingStallMs,
      // Destroying the session with an error routes back through this same
      // session's own `error` listener below, which reports it exactly once.
      onStall: (error) => {
        if (!session.destroyed) session.destroy(error);
      },
    });
    session.on("goaway", (errorCode: number, lastStreamId: number) => {
      options.onGoaway?.({ lastStreamId, errorCode });
    });
    session.on("close", () => {
      stopWatchdog();
      activeSessions.delete(session);
    });
    session.on("error", (error) => {
      stopWatchdog();
      options.onSessionError?.(error instanceof Error ? error : new Error(String(error)));
    });
  });

  server.on("stream", (stream, headers) => {
    void handleStream(stream, headers).catch((error) => {
      // A fault inside `handleStream` itself (not a forward-handler or
      // stream-body rejection, both already caught above) is a defensive
      // last resort. Destroy only this stream; the session stays open.
      if (!stream.destroyed) {
        stream.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  return {
    server,
    bindChannel(channel: CommandManagedDuplexChannel): Duplex {
      const duplex = wrapDuplexChannelAsNodeDuplex(channel, { maxBufferedReadBytes, readBackpressureStallMs });
      server.emit("connection", duplex);
      return duplex;
    },
    async close(): Promise<void> {
      // `session.close()` sends GOAWAY and waits for every open stream to end
      // on its own; a stalled stream (its body never completes, and its own
      // timeout has not yet fired) would hold this wait open forever. The
      // grace timer bounds it: past `closeGraceMs`, the server force-destroys
      // the session, which ends its streams at once and settles their body
      // reads through the `close` backstop in `readHttp2StreamBody`.
      await Promise.all(
        [...activeSessions].map(
          (session) =>
            new Promise<void>((resolve) => {
              if (session.closed || session.destroyed) {
                resolve();
                return;
              }
              const forceDestroyTimer = setTimeout(() => {
                if (!session.destroyed) session.destroy();
              }, closeGraceMs);
              forceDestroyTimer.unref?.();
              session.close(() => {
                clearTimeout(forceDestroyTimer);
                resolve();
              });
            }),
        ),
      );
    },
  };
}
