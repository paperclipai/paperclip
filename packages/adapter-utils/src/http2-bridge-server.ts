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
/** Open streams. This matches the current broker limit ({@link DEFAULT_DUPLEX_BROKER_MAX_IN_FLIGHT_REQUESTS} in `duplex-bridge-broker.ts`). */
export const HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS = 64;
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
 * anything to compare it against. */
export const DEFAULT_HTTP2_BRIDGE_MAX_BUFFERED_READ_BYTES = HTTP2_BRIDGE_MAX_SESSION_MEMORY * 1024 * 1024;
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
/** The default lifetime bound on a request body read, measured from the
 * start of the read or from the most recent chunk that carried real
 * progress, whichever is later. This bound is independent of
 * {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_TIMEOUT_MS}: the idle bound
 * resets on every chunk to catch a peer that stops sending; this bound
 * renews on every chunk too, but only up to the hard ceiling below, so it
 * catches a peer that never stops sending but also never finishes. See
 * {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_LIFETIME_CEILING_MS} for the
 * bound that keeps this renewal from running forever. */
export const DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_MAX_LIFETIME_MS = 120_000;
/** The default hard ceiling on a request body read's total lifetime: an
 * absolute bound armed once, at the start of the read, and never pushed out
 * past this point no matter how much progress a later chunk reports. A peer
 * cannot use a steady trickle of small chunks to keep renewing
 * {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_MAX_LIFETIME_MS} and hold a
 * {@link HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS} stream slot open forever,
 * because this ceiling still ends the read once the read's total age passes
 * it. Set well above {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_MAX_LIFETIME_MS}
 * so a legitimate upload that makes real but slow progress — a chunk every
 * few seconds, well inside the renewable bound above — still has room to
 * finish, while a peer that never finishes is still bounded to this ceiling
 * instead of running forever. This is an intentional design limit, not a
 * defect and not open for removal without a replacement bound. */
export const DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_LIFETIME_CEILING_MS =
  DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_MAX_LIFETIME_MS * 4;
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
  body?: Buffer | string;
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
  /** The lifetime bound a request body read gets, renewed on every chunk
   * that carries real progress, up to {@link requestBodyLifetimeCeilingMs}.
   * See {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_MAX_LIFETIME_MS} for why the
   * server enforces it. The default is
   * {@link DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_MAX_LIFETIME_MS}. */
  requestBodyMaxLifetimeMs?: number;
  /** The hard ceiling on a request body read's total lifetime, armed once
   * and never pushed out by progress. This bound caps worst-case
   * stream-slot occupancy even for a peer that keeps renewing
   * {@link requestBodyMaxLifetimeMs} with a steady trickle of chunks. See
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

/**
 * Read one request body, bounded on size and on two independent time
 * bounds.
 *
 * The idle bound resets on each received chunk, so a slow peer that keeps
 * making real progress completes, while a peer that stops sending
 * mid-stream — the same failure a stalled network path or a hung sandbox
 * process produces — still trips it.
 *
 * The lifetime bound also renews on each received chunk, by the same
 * amount, so a slow peer that keeps sending real progress gets more time
 * instead of losing the stream mid-upload. That renewal never pushes the
 * deadline past `startedAt + lifetimeCeilingMs`: the hard ceiling arms once,
 * when the read starts, and holds no matter how much progress a later chunk
 * reports. This is an intentional design limit, not a defect, and it is not
 * open for removal or relaxation without a replacement bound. It exists to
 * cap the worst-case time one read can occupy a
 * {@link HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS} stream slot — a cap the idle
 * bound cannot provide alone, because a peer that keeps every chunk gap
 * under the idle bound never trips it, no matter how long the read runs. A
 * peer cannot use a steady trickle of small chunks to hold the slot forever,
 * because the ceiling still ends the read once the read's total age passes
 * it, regardless of how the peer paces its chunks.
 *
 * The `close` listener is the settle-of-last-resort: it fires whenever the
 * stream ends for any reason at all — a normal end, an error, a timeout- or
 * shutdown-triggered `destroy()`, or a peer reset — so the promise always
 * settles and the caller never awaits a stream that already went away.
 */
function readHttp2StreamBody(
  stream: http2.ServerHttp2Stream,
  maxBodyBytes: number,
  idleTimeoutMs: number,
  maxLifetimeMs: number,
  lifetimeCeilingMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout>;
    let lifetimeTimer: ReturnType<typeof setTimeout>;
    const hardDeadline = Date.now() + lifetimeCeilingMs;
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(lifetimeTimer);
      run();
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        settle(() => reject(new Error("Bridge request body stalled before it completed.")));
        stream.destroy();
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    // Renews on every chunk that carries real progress, but the delay never
    // exceeds the time left before the hard ceiling armed below: see the
    // function's own doc comment for why the ceiling must stay independent
    // of progress.
    const armLifetimeTimer = () => {
      clearTimeout(lifetimeTimer);
      const delayMs = Math.max(0, Math.min(maxLifetimeMs, hardDeadline - Date.now()));
      lifetimeTimer = setTimeout(() => {
        settle(() => reject(new Error("Bridge request body exceeded the maximum lifetime bound.")));
        stream.destroy();
      }, delayMs);
      lifetimeTimer.unref?.();
    };
    armLifetimeTimer();
    armIdleTimer();
    stream.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBodyBytes) {
        settle(() => reject(new Error("Bridge request body exceeded the configured size limit.")));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
      // The chunk is real progress, so the peer is not stalled: reset the
      // idle bound and renew the lifetime bound, instead of letting either
      // expire under a slow but active upload. The lifetime renewal above is
      // still capped by the hard ceiling.
      armIdleTimer();
      armLifetimeTimer();
    });
    stream.once("end", () => settle(() => resolve(Buffer.concat(chunks))));
    stream.once("error", (error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
    stream.once("aborted", () => settle(() => reject(new Error("Bridge request stream aborted."))));
    stream.once("close", () => settle(() => reject(new Error("Bridge request stream closed before it completed."))));
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
 * the same idle and total lifetime bounds an authenticated request gets.
 * A denied request's body content never reaches the forward handler, but
 * the inbound half of the stream still needs a bound: without one, a peer
 * that leaves the body unfinished keeps the stream open, holding one of the
 * {@link HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS} slots for as long as it
 * chooses. Nothing awaits the discard; the caller has already answered the
 * request and moves on to the next stream.
 */
function denyRequest(
  stream: http2.ServerHttp2Stream,
  status: number,
  body: unknown,
  maxBodyBytes: number,
  idleTimeoutMs: number,
  maxLifetimeMs: number,
  lifetimeCeilingMs: number,
): void {
  respondJson(stream, status, body);
  if (stream.destroyed || stream.closed) return;
  readHttp2StreamBody(stream, maxBodyBytes, idleTimeoutMs, maxLifetimeMs, lifetimeCeilingMs).catch(() => {
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
  const requestBodyMaxLifetimeMs =
    options.requestBodyMaxLifetimeMs ?? DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_MAX_LIFETIME_MS;
  const requestBodyLifetimeCeilingMs =
    options.requestBodyLifetimeCeilingMs ?? DEFAULT_HTTP2_BRIDGE_REQUEST_BODY_LIFETIME_CEILING_MS;
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_HTTP2_BRIDGE_CLOSE_GRACE_MS;
  const maxBufferedReadBytes = options.maxBufferedReadBytes ?? DEFAULT_HTTP2_BRIDGE_MAX_BUFFERED_READ_BYTES;
  const readBackpressureStallMs =
    options.readBackpressureStallMs ?? DEFAULT_HTTP2_BRIDGE_READ_BACKPRESSURE_STALL_MS;

  const server = http2.createServer(HTTP2_BRIDGE_SERVER_OPTIONS);
  const activeSessions = new Set<http2.ServerHttp2Session>();

  async function handleStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): Promise<void> {
    // Accepted security fix 4: the constant-time bridge-token compare runs
    // before route processing and before header processing. This host check
    // is independent of the gateway's own token check on the sandbox side.
    if (!compareBridgeTokensConstantTime(options.bridgeToken, readBridgeTokenHeader(headers))) {
      denyRequest(
        stream,
        401,
        { error: "Invalid bridge token." },
        maxBodyBytes,
        requestBodyTimeoutMs,
        requestBodyMaxLifetimeMs,
        requestBodyLifetimeCeilingMs,
      );
      return;
    }

    // Accepted security fix 3: parse `:path` exactly one time; both the route
    // allowlist and the forward request below read this one result.
    const parsedPath = parseCanonicalBridgeRequestPath(headers);
    if (!parsedPath.ok) {
      denyRequest(
        stream,
        400,
        { error: `Invalid request path: ${parsedPath.reason}` },
        maxBodyBytes,
        requestBodyTimeoutMs,
        requestBodyMaxLifetimeMs,
        requestBodyLifetimeCeilingMs,
      );
      return;
    }
    const method = normalizeStreamMethod(headers[":method"]);

    const denialReason = authorizeSandboxCallbackBridgeRequestWithRoutes(
      { method, path: parsedPath.value.pathname },
      routes,
    );
    if (denialReason) {
      denyRequest(
        stream,
        403,
        { error: denialReason },
        maxBodyBytes,
        requestBodyTimeoutMs,
        requestBodyMaxLifetimeMs,
        requestBodyLifetimeCeilingMs,
      );
      return;
    }

    const sanitizedHeaders = sanitizeSandboxCallbackBridgeHeaders(
      toOutboundHeaderRecord(headers),
      headerAllowlist,
    );

    let body: Buffer;
    try {
      body = await readHttp2StreamBody(
        stream,
        maxBodyBytes,
        requestBodyTimeoutMs,
        requestBodyMaxLifetimeMs,
        requestBodyLifetimeCeilingMs,
      );
    } catch (error) {
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
    } catch {
      // The peer reset the stream (RST_STREAM) between dispatch and response.
      // One stream's write fault stays local to that stream.
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
