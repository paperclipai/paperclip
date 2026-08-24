/**
 * Host broker for the sandbox duplex channel.
 *
 * The broker owns the host end of one persistent duplex channel to the sandbox
 * gateway. It reads request frames from the channel, forwards each one on the
 * existing Paperclip API path, and writes one response frame back. It sends a
 * heartbeat frame on an interval to prove liveness.
 *
 * The broker does not hold the route allowlist, the token replacement, or the
 * run attribution. The caller passes a forward handler, and the broker calls it
 * for each request. The handler applies the real token and the signed run
 * identifier, so those rules stay in one place on the existing forward path.
 *
 * The broker runs a set of nested timeout budgets:
 *   - forward budget: the deadline for one forward call.
 *   - response budget: the deadline for the broker to send one response frame.
 *   - gateway wait budget: the deadline the in-sandbox gateway waits for the
 *     response frame.
 * Each inner budget is smaller than its outer budget, so the broker aborts and
 * answers before the gateway gives up. The broker asserts this order at
 * construction and fails a configuration that breaks it.
 *
 * The provider controls the duplex transport directly, so the broker treats each
 * request frame as untrusted. The broker bounds the work one channel can force:
 *   - in-flight limit: the maximum number of pending forwards at one time. It
 *     bounds the controllers, the timers, and the concurrent authenticated
 *     forwards.
 *   - lifetime limit: the maximum number of distinct requests over the channel
 *     lifetime. It bounds the retained request-id memory, because the broker keeps
 *     one id per distinct dispatched request for the no-replay guarantee.
 * The broker checks each limit before it adds the id to the seen set, allocates
 * the pending record, or calls the forward handler. On a limit it answers the
 * refused request with one bounded terminal response and forwards nothing. The
 * refusal preserves the no-replay and no-double-dispatch rules.
 *
 * Loss is terminal. The broker detects loss through channel exit, a stream
 * write failure, a protocol failure, a heartbeat write failure, and a close
 * timeout. On loss the broker stops the heartbeat, aborts every in-flight
 * forward, records the loss, and dispatches nothing more. The broker never
 * reconnects and never replays a request. The broker records the loss for
 * metrics only and sends nothing about the loss to the sandbox.
 */

import type { CommandManagedDuplexChannel } from "./command-managed-runtime.js";
import {
  DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED,
  type DuplexAggregateByteLedger,
  type ReservationToken,
} from "./duplex-aggregate-byte-ledger.js";
import {
  DUPLEX_BODY_CHUNK_RAW_BYTES,
  DEFAULT_MAX_DUPLEX_FRAME_BYTES,
  DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES,
  DUPLEX_FRAME_VERSION,
  DuplexFrameDecoder,
  encodeDuplexFrame,
  encodeDuplexFrameChecked,
  type DuplexBodyChunkFrame,
  type DuplexFrame,
  type DuplexRequestFrame,
  type DuplexResponseFrame,
  type DuplexResponseOutcome,
} from "./duplex-frame-codec.js";
import {
  DuplexBodyError,
  DuplexBodyReceiver,
  splitBodyIntoChunkFrames,
  type DuplexBodyReceiverConfig,
  type ReassembledBody,
} from "./duplex-body-spool.js";
import type {
  DuplexLossReason,
  DuplexOutcomeValue,
  DuplexObservability,
} from "./duplex-observability.js";

/** The lifecycle states of the broker. The broker moves through them in order. */
export type DuplexBrokerState = "opening" | "open" | "lost" | "closing" | "closed";

/** The reason the broker classified a loss. The broker records it for metrics only. */
export type DuplexBrokerLossReason =
  | "channel_exit"
  | "transport_closed"
  | "stream_failure"
  | "protocol_failure"
  | "heartbeat_write_failure"
  | "close_timeout";

/**
 * Map one broker loss reason to the closed, typed telemetry loss reason. The
 * broker records the internal reason for its own metrics; the telemetry boundary
 * carries only the closed enum value. The map is total over the internal reasons,
 * so no raw text ever reaches the typed reason.
 *   - `channel_exit` -> `provider_exit`: the provider channel process exited.
 *   - `transport_closed` -> `transport_closed`: the provider transport closed with
 *     no exit data, so the loss is a transport close, not a process exit.
 *   - `stream_failure` -> `write_error`: a write to the channel failed.
 *   - `protocol_failure` -> `rpc_failure`: a malformed or mismatched frame.
 *   - `heartbeat_write_failure` -> `heartbeat_timeout`: the liveness write failed.
 *   - `close_timeout` -> `other`: an orderly close did not complete in the budget.
 */
const BROKER_LOSS_REASON_TO_TYPED: Readonly<Record<DuplexBrokerLossReason, DuplexLossReason>> = {
  channel_exit: "provider_exit",
  transport_closed: "transport_closed",
  stream_failure: "write_error",
  protocol_failure: "rpc_failure",
  heartbeat_write_failure: "heartbeat_timeout",
  close_timeout: "other",
};

/**
 * Map one broker loss reason to the closed, typed telemetry loss reason. The host
 * uses it to name the typed reason on a log line without the raw provider text.
 */
export function typedDuplexLossReason(reason: DuplexBrokerLossReason): DuplexLossReason {
  return BROKER_LOSS_REASON_TO_TYPED[reason] ?? "other";
}

/**
 * The typed error code the host reports when the duplex control channel died
 * before an orderly completion. Both the ACP lane and the CLI lane report this
 * one code, so the run disposition is identical across the two lanes.
 */
export const DUPLEX_CHANNEL_LOST_ERROR_CODE = "duplex_channel_lost";

/**
 * The terminal run disposition the broker computes from its ordered lifecycle. A
 * `failed` disposition means a terminal loss ordered before an orderly completion,
 * so the run must not report success. The typed loss reason names the cause; it is
 * `null` for a success.
 */
export interface DuplexBrokerRunDisposition {
  /** True when a terminal loss ordered before an orderly completion. */
  failed: boolean;
  /** The typed, closed loss reason on a failure; `null` on a success. */
  lossReason: DuplexLossReason | null;
}

/** The nested timeout budgets. Each inner budget is smaller than its outer budget. */
export interface DuplexBrokerBudgets {
  /** The deadline for one forward call, in milliseconds. */
  forwardTimeoutMs: number;
  /** The deadline for the broker to send one response frame, in milliseconds. */
  responseBudgetMs: number;
  /** The deadline the in-sandbox gateway waits for the response frame, in milliseconds. */
  gatewayWaitMs: number;
}

/** The default nested budgets: forward 30 s, response 32 s, gateway wait 35 s. */
export const DEFAULT_DUPLEX_BROKER_BUDGETS: DuplexBrokerBudgets = {
  forwardTimeoutMs: 30_000,
  responseBudgetMs: 32_000,
  gatewayWaitMs: 35_000,
};

/** The default interval between two heartbeat frames, in milliseconds. */
export const DEFAULT_DUPLEX_BROKER_HEARTBEAT_INTERVAL_MS = 5_000;

/** The default deadline for an orderly channel close, in milliseconds. */
export const DEFAULT_DUPLEX_BROKER_CLOSE_TIMEOUT_MS = 2_000;

/**
 * The default maximum number of in-flight requests. The broker holds this many
 * pending forwards at one time. It refuses a further request until an in-flight
 * request completes. The provider controls the transport, so this finite limit
 * bounds the controllers, the timers, and the concurrent authenticated forwards
 * a provider can force on the host.
 */
export const DEFAULT_DUPLEX_BROKER_MAX_IN_FLIGHT_REQUESTS = 64;

/**
 * The default maximum number of distinct requests over the channel lifetime. The
 * broker forwards this many distinct request ids, then refuses each new distinct
 * id and forwards nothing more. This limit bounds the retained request-id memory,
 * because the broker keeps one id per distinct dispatched request for the no-replay
 * guarantee.
 *
 * The retained id memory has a hard ceiling. The codec bounds each id at
 * `DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES` (256 bytes), so the worst-case retained id
 * bytes are this count multiplied by that bound: 50,000 * 256 = 12,800,000 bytes
 * (about 12.8 MB), plus the fixed per-entry overhead of the Set. This count is
 * sized against that id bound to keep the ceiling small.
 */
export const DEFAULT_DUPLEX_BROKER_MAX_LIFETIME_REQUESTS = 50_000;

/**
 * The fixed, documented per-entry allocation the broker charges the aggregate byte
 * ledger for one no-replay request-id set entry. The type and the cardinality of
 * `seenRequestIds` are bounded: the codec caps each id at
 * {@link DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES}, and the lifetime limit caps the
 * entry count. The broker charges the exact raw id bytes plus this fixed entry
 * overhead, so the retained set never grows uncharged. This constant models the
 * fixed per-entry cost of the string key and the Set slot, not the id bytes.
 */
export const DUPLEX_SEEN_REQUEST_ID_SET_ENTRY_BYTES = 64;

/** The result of one forward call. The broker turns it into one response frame. */
export interface DuplexBrokerForwardResult {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * The forward handler the broker calls for each request. The handler applies the
 * real token and the run attribution, then forwards the request on the existing
 * API path. The broker reassembles the request body from the `body_chunk` frames
 * before it calls the handler, so the handler streams the body from
 * `options.body`. The broker aborts `options.signal` when the forward budget ends
 * or a loss happens, so a handler that threads the signal into its work stops
 * early.
 */
export type DuplexBrokerForwardHandler = (
  request: DuplexRequestFrame,
  options: { signal: AbortSignal; body: ReassembledBody },
) => Promise<DuplexBrokerForwardResult>;

/** One request record. The broker captures the dispatch-start point for metrics only. */
export interface DuplexBrokerRequestRecord {
  id: string;
  method: string;
  path: string;
  /** The point the broker started to dispatch the request, in milliseconds. */
  dispatchStartMs: number;
}

/** One loss record. The broker reports it for metrics only. */
export interface DuplexBrokerLossRecord {
  reason: DuplexBrokerLossReason;
  message: string;
  /** The point the broker recorded the loss, in milliseconds. */
  atMs: number;
}

/** The options for {@link createDuplexBridgeBroker}. */
export interface DuplexBrokerOptions {
  /** The duplex channel to the sandbox gateway. */
  channel: CommandManagedDuplexChannel;
  /** The forward handler the broker calls for each request. */
  forwardRequest: DuplexBrokerForwardHandler;
  /** The nested timeout budgets. The default is {@link DEFAULT_DUPLEX_BROKER_BUDGETS}. */
  budgets?: Partial<DuplexBrokerBudgets>;
  /** The interval between two heartbeat frames, in milliseconds. */
  heartbeatIntervalMs?: number;
  /** The deadline for an orderly channel close, in milliseconds. */
  closeTimeoutMs?: number;
  /** The maximum size of one inbound frame, in bytes. Forwarded to the decoder. */
  maxFrameBytes?: number;
  /**
   * The maximum number of in-flight requests the broker holds at one time. The
   * broker refuses a further request past this limit with a bounded terminal
   * response and forwards nothing for it. The default is
   * {@link DEFAULT_DUPLEX_BROKER_MAX_IN_FLIGHT_REQUESTS}.
   */
  maxInFlightRequests?: number;
  /**
   * The maximum number of distinct requests the broker dispatches over the
   * channel lifetime. The broker refuses each new distinct request past this
   * limit with a bounded terminal response and forwards nothing more. This limit
   * bounds the retained request-id memory. The default is
   * {@link DEFAULT_DUPLEX_BROKER_MAX_LIFETIME_REQUESTS}.
   */
  maxLifetimeRequests?: number;
  /**
   * The config for the receive-side request-body reassembler. It sets the spill
   * threshold, the fixed raw chunk size, and the per-channel spill caps. The
   * broker creates one reassembler for the channel. The config stays injectable,
   * so a test lowers the spill threshold and the caps to exercise the spill path
   * and the fail-closed cap behavior without a large body.
   */
  bodyReceiverConfig?: DuplexBodyReceiverConfig;
  /** The clock the broker reads for the metric timestamps. The default is `Date.now`. */
  now?: () => number;
  /** The metrics sink for the per-request dispatch record. */
  onRequestRecord?: (record: DuplexBrokerRequestRecord) => void;
  /** The metrics sink for the terminal loss record. */
  onLoss?: (record: DuplexBrokerLossRecord) => void;
  /** The sink for a state change. The broker reports every transition. */
  onStateChange?: (state: DuplexBrokerState) => void;
  /** The sink for a diagnostic message. The broker never writes diagnostics to the channel. */
  logger?: (message: string) => void;
  /**
   * The fixed observability facade. The broker records one request span per
   * delivered request and one loss record per terminal loss. The facade maps each
   * record to the fixed names and dimensions, so no route, query, body, token, or
   * raw error rides a span or a counter. The default records nothing.
   */
  telemetry?: DuplexObservability;
  /**
   * The process-owned aggregate byte ledger. The broker reserves the exact retained
   * bytes of each dispatched request against it before it retains the frame: the
   * raw request frame, the normalized request payload, and the no-replay set entry.
   * A reservation that would pass the ceiling makes the broker retain nothing and
   * refuse the request with the fixed marker
   * {@link DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED}. When the ledger is absent the
   * broker charges nothing and behaves as before, so a non-duplex or a legacy path
   * stays unchanged.
   */
  duplexAggregateByteLedger?: DuplexAggregateByteLedger | null;
}

/** The broker handle the factory returns. */
export interface DuplexBridgeBroker {
  /** The current state of the broker. */
  readonly state: DuplexBrokerState;
  /** The loss record, or `null` when the broker never lost the channel. */
  readonly lossRecord: DuplexBrokerLossRecord | null;
  /**
   * The terminal run disposition from the ordered lifecycle. It reports a failure
   * when a terminal loss ordered before an orderly completion, and names the typed
   * loss reason. It reports a success for a healthy channel or a normal-teardown
   * loss. The host reads it at the run-disposition seam.
   */
  readonly runDisposition: DuplexBrokerRunDisposition;
  /**
   * Mark the host-observed orderly completion of the agent turn on the ordered
   * lifecycle. A loss ordered before this mark latches a failure; a loss ordered
   * after it stays a success. The broker also marks it on a gateway close frame
   * and on a host-initiated orderly close. Safe to call more than one time.
   */
  markOrderlyCompletion(): void;
  /**
   * Atomically read the run disposition and mark the host-observed orderly
   * completion in one synchronous step. The host calls it at the run-disposition
   * seam for a success-eligible terminal. The broker marks the orderly completion
   * only while no loss ordered, then returns the disposition, so no caller can
   * insert an `await` between the read and the mark. A loss that already latched
   * keeps the failure, because the mark no-ops after a latched loss.
   */
  settleRunDisposition(): DuplexBrokerRunDisposition;
  /** Start the broker. It wires the channel listeners and moves to `open`. */
  start(): void;
  /** Close the channel cleanly. It moves through `closing` to `closed`. */
  close(): Promise<void>;
  /** Stop the sandbox child process. Safe to call more than one time. */
  stop(): void;
}

/**
 * Assert the nested budget order. Each inner budget must be smaller than its
 * outer budget, so the broker answers before the gateway gives up. The function
 * throws when the order breaks.
 */
export function assertNestedDuplexBrokerBudgets(budgets: DuplexBrokerBudgets): void {
  if (!(budgets.forwardTimeoutMs < budgets.responseBudgetMs)) {
    throw new Error(
      `Duplex broker forward budget ${budgets.forwardTimeoutMs}ms must be smaller than the response budget ${budgets.responseBudgetMs}ms.`,
    );
  }
  if (!(budgets.responseBudgetMs < budgets.gatewayWaitMs)) {
    throw new Error(
      `Duplex broker response budget ${budgets.responseBudgetMs}ms must be smaller than the gateway wait budget ${budgets.gatewayWaitMs}ms.`,
    );
  }
}

/** The resolved request limits the broker enforces. */
export interface DuplexBrokerLimits {
  /** The maximum number of in-flight requests the broker holds at one time. */
  maxInFlightRequests: number;
  /** The maximum number of distinct requests the broker dispatches over the channel lifetime. */
  maxLifetimeRequests: number;
}

/**
 * Assert the request limits. Each limit must be a finite positive integer, so the
 * broker fails closed on a broken configuration instead of running with an
 * unbounded or a zero limit. The function throws when a limit breaks the rule.
 */
export function assertDuplexBrokerLimits(limits: DuplexBrokerLimits): void {
  const entries: ReadonlyArray<readonly [string, number]> = [
    ["maxInFlightRequests", limits.maxInFlightRequests],
    ["maxLifetimeRequests", limits.maxLifetimeRequests],
  ];
  for (const [name, value] of entries) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(
        `Duplex broker ${name} must be a finite positive integer; got ${String(value)}.`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The safe HTTP methods. RFC 7231 section 4.2.1 defines this set. A safe method
 * does not change host state, so the host applies no mutation for it. A caller
 * can retry a safe method after a forward failure without a double-apply risk.
 */
const SAFE_BRIDGE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

/** Report whether the method is safe, so a forward failure stays retryable. */
export function isSafeBridgeMethod(method: string): boolean {
  return SAFE_BRIDGE_METHODS.has(method.trim().toUpperCase());
}

/** The internal bookkeeping for one in-flight request. */
interface PendingRequest {
  controller: AbortController;
  responded: boolean;
  /**
   * The forward-budget timer. It is `null` while the broker reassembles the
   * request body, and the broker sets it when it starts the forward. So the
   * forward budget bounds the forward call, not the reassembly.
   */
  forwardTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The response-budget backstop timer. The broker starts it at the request
   * envelope, so it bounds the whole request: the body reassembly plus the
   * forward. It answers a request that never completes its reassembly or forward.
   */
  responseTimer: ReturnType<typeof setTimeout>;
  /** The point the broker started to dispatch the request. It sets the span latency. */
  dispatchStartMs: number;
  /** The request method. The response backstop reads it to classify the safe-method retry. */
  method: string;
  /** The reassembled request body, set once reassembly completes. The broker disposes it on settle. */
  reassembled: ReassembledBody | null;
  /** True once the forward promise settled. The finally owner sets it one time. */
  forwardSettled: boolean;
  /**
   * Release the request-frame token and the request-payload token exactly one time.
   * The single forward-promise finally owner calls it after the forward settles.
   * A second call is a no-op, so no token releases twice.
   */
  releaseForwardTokens: () => void;
}

/**
 * One orphaned forward. The broker answered the gateway and removed the request
 * from `pending`, but the forward promise or its response-body reader had not
 * settled. The orphan keeps the request tokens charged and the controller live
 * until the forward finally releases them, so the ledger reports nonzero ownership
 * until the async work settles.
 */
interface OrphanedForward {
  controller: AbortController;
  /** Release the request-frame and request-payload tokens exactly one time. */
  releaseForwardTokens: () => void;
}

/**
 * Create the host duplex bridge broker. The factory asserts the budget order,
 * creates the receive-side request-body reassembler, and returns a handle. It is
 * asynchronous because the reassembler owns a spill directory it creates with
 * `mkdtemp`. Call `start` to wire the channel and open the broker.
 */
export async function createDuplexBridgeBroker(
  options: DuplexBrokerOptions,
): Promise<DuplexBridgeBroker> {
  const budgets: DuplexBrokerBudgets = {
    ...DEFAULT_DUPLEX_BROKER_BUDGETS,
    ...options.budgets,
  };
  assertNestedDuplexBrokerBudgets(budgets);

  const limits: DuplexBrokerLimits = {
    maxInFlightRequests: options.maxInFlightRequests ?? DEFAULT_DUPLEX_BROKER_MAX_IN_FLIGHT_REQUESTS,
    maxLifetimeRequests: options.maxLifetimeRequests ?? DEFAULT_DUPLEX_BROKER_MAX_LIFETIME_REQUESTS,
  };
  assertDuplexBrokerLimits(limits);

  const channel = options.channel;
  const forwardRequest = options.forwardRequest;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_DUPLEX_BROKER_HEARTBEAT_INTERVAL_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_DUPLEX_BROKER_CLOSE_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  // The process-owned aggregate byte ledger, or `null` when the caller injected
  // none. When `null` the broker charges nothing and behaves as before.
  const ledger = options.duplexAggregateByteLedger ?? null;
  // The one frame size bound the broker enforces on both sides. The decoder
  // rejects an inbound frame over this bound, and the encode guard refuses to
  // write an outbound frame over it. Encode and decode share one value, so a
  // frame the broker writes always decodes on the peer.
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_DUPLEX_FRAME_BYTES;
  // The decoder charges its retained partial-frame bytes against the same host
  // ledger. It receives the ledger object directly, so one gauge bounds the
  // decoder buffer with every other host retention site.
  const decoder = new DuplexFrameDecoder({
    maxFrameBytes,
    ...(ledger ? { aggregateByteLedger: ledger } : {}),
  });
  // Release one token exactly one time. A `null` token or an absent ledger is a
  // no-op, so the broker never records a false accounting defect.
  const releaseToken = (token: ReservationToken | null): void => {
    if (ledger && token) ledger.release(token);
  };
  // The byte size of the normalized request payload the broker retains across the
  // forward. It counts the exact retained scalar and header bytes plus the raw body
  // byte count, so the charge matches the reassembled body the broker holds and
  // never a parsed object graph. The body rides `body_chunk` frames, so the
  // envelope carries only `bodyByteCount`; that count is the retained body size.
  const requestPayloadBytes = (frame: DuplexRequestFrame): number => {
    let bytes =
      Buffer.byteLength(frame.id, "utf8") +
      Buffer.byteLength(frame.method, "utf8") +
      Buffer.byteLength(frame.path, "utf8") +
      Buffer.byteLength(frame.query, "utf8") +
      frame.bodyByteCount;
    for (const [key, value] of Object.entries(frame.headers)) {
      bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    }
    return bytes;
  };

  // The receive-side request-body reassembler. It reassembles each request body
  // from the `body_chunk` frames, on the memory path at or below the spill
  // threshold and on the spill path above it, so the broker never holds a whole
  // large request body in memory. It owns a per-channel spill directory and the
  // spill caps.
  const receiver = await DuplexBodyReceiver.create(options.bodyReceiverConfig ?? {});
  let receiverFinalized = false;
  const finalizeReceiver = (): Promise<void> => {
    // Remove the spill directory and every in-flight body once. The broker calls
    // it on every terminal path: a loss, a normal teardown, and an orderly close.
    if (receiverFinalized) return Promise.resolve();
    receiverFinalized = true;
    return receiver.destroy().catch(() => undefined);
  };
  // The fixed raw slice size for the response `body_chunk` frames. It matches the
  // reassembler config, so a test that lowers the slice size splits both a request
  // body and a response body the same way.
  const rawChunkBytes = options.bodyReceiverConfig?.rawChunkBytes ?? DUPLEX_BODY_CHUNK_RAW_BYTES;
  // The ids the broker is reassembling right now. A `body_chunk` for an id in this
  // set routes to the reassembler. The broker removes an id when the body settles.
  const reassembling = new Set<string>();
  // The ids the broker refused at the envelope, with the raw bytes it still must
  // drain. The sender emits the `body_chunk` frames for a refused request before
  // it learns of the refusal, so the broker drains and drops those chunks instead
  // of treating them as a body_chunk with no envelope.
  const draining = new Map<string, number>();

  let state: DuplexBrokerState = "opening";
  let stopped = false;
  let started = false;
  let closePromise: Promise<void> | null = null;
  let lossRecord: DuplexBrokerLossRecord | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // The host-owned lifecycle sequence. The broker assigns each terminal lifecycle
  // event a strictly increasing sequence number at ingress, before any
  // asynchronous logging. The order of these numbers, not a wall-clock or a
  // provider timestamp, decides the run disposition.
  let lifecycleSeq = 0;
  // The sequence number of the terminal loss, or `null` when no loss ordered. The
  // broker sets it one time. A later event never clears it, so the loss latches.
  let lossSeq: number | null = null;
  // The typed, closed loss reason for the latched loss, or `null` on a success.
  let typedLossReason: DuplexLossReason | null = null;
  // The sequence number of the host-observed orderly completion, or `null` when
  // none ordered. The broker sets it one time, only while the channel is healthy.
  let orderlyCompletionSeq: number | null = null;
  const nextLifecycleSeq = (): number => {
    lifecycleSeq += 1;
    return lifecycleSeq;
  };

  // Mark the host-observed orderly completion of the agent turn. The broker sets
  // the sequence one time, and only while no loss has ordered. A loss that already
  // latched keeps the failure, so a late completion never clears the latch.
  const markOrderlyCompletion = (): void => {
    if (orderlyCompletionSeq !== null || lossSeq !== null) return;
    orderlyCompletionSeq = nextLifecycleSeq();
  };
  // Atomically read the run disposition and mark the host-observed orderly
  // completion. The mark and the read run in one synchronous step, so no caller
  // can insert an `await` between them and no teardown loss can slip in. The mark
  // no-ops once a loss latched, so a real mid-run loss keeps the failure.
  const settleRunDisposition = (): DuplexBrokerRunDisposition => {
    markOrderlyCompletion();
    return { failed: lossSeq !== null, lossReason: typedLossReason };
  };
  // The ids the broker already dispatched. The broker forwards one id one time,
  // so a repeated frame never reaches the API twice.
  const seenRequestIds = new Set<string>();
  // The aggregate-ledger tokens for the no-replay set entries. The broker holds
  // one token per live set entry and releases every token one time at terminal
  // teardown, so the retained set never leaves bytes charged after the channel
  // ends.
  const seenRequestIdTokens = new Set<ReservationToken>();
  const pending = new Map<string, PendingRequest>();
  // The forwards that answered the gateway but whose async work has not settled.
  // The broker keeps their tokens charged and their controller live until each
  // forward finally releases its tokens, so the ledger reports the real ownership.
  const orphanedForwards = new Map<string, OrphanedForward>();

  // Release every no-replay set-entry token one time and clear the set. The
  // ledger release is one way, and the cleared set stops any second release, so
  // this helper is safe to call more than one time at terminal teardown.
  const releaseSeenRequestIdTokens = (): void => {
    for (const token of seenRequestIdTokens) releaseToken(token);
    seenRequestIdTokens.clear();
  };

  const setState = (next: DuplexBrokerState): void => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const clearPending = (): void => {
    for (const [id, entry] of pending) {
      if (entry.forwardTimer !== null) clearTimeout(entry.forwardTimer);
      clearTimeout(entry.responseTimer);
      entry.controller.abort(new Error("Duplex broker stopped."));
      if (entry.reassembled !== null) {
        void entry.reassembled.dispose();
        entry.reassembled = null;
      }
      if (entry.forwardSettled) continue;
      if (entry.forwardTimer !== null) {
        // A live forward promise still owns its request tokens. Transfer it to the
        // orphan registry, so its tokens stay charged until the forward finally
        // releases them. The abort only asks the forward to stop; it never releases
        // a token by itself.
        orphanedForwards.set(id, {
          controller: entry.controller,
          releaseForwardTokens: entry.releaseForwardTokens,
        });
      } else {
        // The request is still reassembling, so no forward promise will settle and
        // release its tokens. Release the request tokens now. The reassembler
        // teardown below rejects the in-flight body and unlinks any spill file.
        entry.releaseForwardTokens();
      }
    }
    pending.clear();
    reassembling.clear();
    draining.clear();
    // Ask every already-orphaned forward to stop as well. The forward-promise
    // finally owner releases each orphan token when the forward settles.
    for (const orphan of orphanedForwards.values()) {
      orphan.controller.abort(new Error("Duplex broker stopped."));
    }
  };

  const recordLoss = (reason: DuplexBrokerLossReason, message: string): void => {
    // Loss is terminal. Record it one time and stop every activity.
    if (stopped) return;
    const afterOrderlyCompletion = orderlyCompletionSeq !== null;
    // A clean channel end that orders after a host-observed orderly completion is
    // a normal teardown, not a loss. A process exit and a reason-less transport
    // close both end the channel, so both count as the normal teardown here. Stop
    // cleanly, emit no loss event, and leave the run a success. This keeps the
    // closed telemetry contract: an orderly close is not a loss and emits no loss
    // event.
    if (afterOrderlyCompletion && (reason === "channel_exit" || reason === "transport_closed")) {
      stopped = true;
      clearHeartbeat();
      clearPending();
      releaseSeenRequestIdTokens();
      decoder.dispose();
      void finalizeReceiver();
      if (state !== "closing") setState("closed");
      return;
    }
    stopped = true;
    // Classify the loss relative to the first dispatch. A loss after the broker
    // dispatched a request is `post_dispatch`; a loss before any dispatch is
    // `pre_dispatch`. The class rides the fixed loss counter, never the raw
    // message.
    const lossClass = seenRequestIds.size > 0 ? "post_dispatch" : "pre_dispatch";
    // Assign the loss its lifecycle sequence at ingress, before any logging. The
    // loss latches the run as a failure only when no orderly completion ordered
    // before it. A loss ordered after an orderly completion (for example a failed
    // close) is a real channel loss for the telemetry and the leak metric, but it
    // does not fail the run, because the run already completed. Once set, `lossSeq`
    // never clears, so a later completion, exit, or activity callback cannot flip
    // the latch.
    const seq = nextLifecycleSeq();
    if (!afterOrderlyCompletion) {
      lossSeq = seq;
      typedLossReason = BROKER_LOSS_REASON_TO_TYPED[reason] ?? "other";
    }
    clearHeartbeat();
    clearPending();
    releaseSeenRequestIdTokens();
    decoder.dispose();
    void finalizeReceiver();
    lossRecord = { reason, message, atMs: now() };
    setState("lost");
    // Log the internal reason only. The broker never writes the raw provider
    // message to a log line, so no raw provider text rides a sink here.
    options.logger?.(`Duplex broker lost the channel (${reason}).`);
    options.onLoss?.(lossRecord);
    options.telemetry?.recordLoss(lossClass, BROKER_LOSS_REASON_TO_TYPED[reason] ?? "other");
  };

  const writeLine = (line: string): boolean => {
    try {
      channel.write(line);
      return true;
    } catch (error) {
      recordLoss("stream_failure", errorMessage(error));
      return false;
    }
  };

  // The result of one bounded send. `sent` means every frame went out; `too_large`
  // means the response envelope exceeds the bound and the broker wrote nothing;
  // `lost` means a write failed and the broker recorded the channel loss.
  type SendResult = "sent" | "too_large" | "lost";

  // Send one full response as a sequence of frames: one envelope frame that
  // carries `bodyByteCount`, then the `body_chunk` frames that carry the body. The
  // envelope is always small. Each `body_chunk` carries one fixed raw slice, so
  // each encoded chunk stays under the frame bound by construction. The result
  // reports `too_large` when the envelope itself exceeds the bound and the broker
  // wrote nothing, `lost` when a write failed and the broker recorded the channel
  // loss, and `sent` when every frame went out.
  const sendResponseFrames = (
    id: string,
    status: number,
    headers: Record<string, string>,
    bodyText: string,
    outcome: DuplexResponseOutcome,
  ): SendResult => {
    const bodyBuffer = Buffer.from(bodyText, "utf8");
    const envelope: DuplexResponseFrame = {
      version: DUPLEX_FRAME_VERSION,
      type: "response",
      id,
      status,
      headers,
      bodyByteCount: bodyBuffer.length,
      outcome,
    };
    // Guard the envelope against the frame bound. The envelope holds no body, so a
    // real bound rejects it only under an extreme small test bound. Report the
    // rejection without a channel loss, so the caller decides how to answer.
    const encodedEnvelope = encodeDuplexFrameChecked(envelope, maxFrameBytes);
    if (!encodedEnvelope.ok) return "too_large";
    const chunkFrames = splitBodyIntoChunkFrames(id, bodyBuffer, DUPLEX_FRAME_VERSION, rawChunkBytes);
    if (!writeLine(encodedEnvelope.line)) return "lost";
    for (const chunk of chunkFrames) {
      const encodedChunk = encodeDuplexFrameChecked(chunk, maxFrameBytes);
      if (!encodedChunk.ok) {
        // A single fixed-size slice never exceeds the bound in a real configuration.
        // A test bound below one chunk can reject it. The envelope already went out
        // with the true `bodyByteCount`, so the broker cannot complete the body
        // within the bound. Log the drop and stop; the gateway ends the request on
        // its wait budget. Report `sent`, because the broker already committed the
        // envelope, so no caller resends a bounded replacement over the same id.
        options.logger?.("Duplex broker dropped an oversized body_chunk frame.");
        return "sent";
      }
      if (!writeLine(encodedChunk.line)) return "lost";
    }
    return "sent";
  };

  const sendTerminalIndeterminate = (id: string): void => {
    // Answer one request the broker cannot deliver with the real result. The
    // request reached the host and may have changed state, so the response is
    // non-retryable and carries the `indeterminate` outcome. The broker tries the
    // full replacement first. When the frame bound rejects even the full
    // replacement envelope, the broker sends a minimal replacement that carries
    // only the `indeterminate` outcome, so the gateway still ends the request and
    // never waits for its full wait budget. When the bound rejects even the
    // minimal replacement envelope, the broker logs a clear local error and keeps
    // the channel open; it records no channel loss.
    const fullBody = JSON.stringify({
      error: "upstream response too large to deliver",
      outcome: "indeterminate",
      retryable: false,
    });
    if (
      sendResponseFrames(
        id,
        502,
        { "content-type": "application/json", "x-paperclip-bridge-outcome": "indeterminate" },
        fullBody,
        "indeterminate",
      ) !== "too_large"
    ) {
      return;
    }
    // The bound rejects the full replacement envelope. Send a minimal terminal
    // response with empty headers and an empty body. The `indeterminate` outcome
    // still rides the envelope, so the gateway maps the request to a terminal 409.
    if (sendResponseFrames(id, 502, {}, "", "indeterminate") !== "too_large") return;
    // The bound rejects even the minimal terminal envelope. The broker cannot
    // deliver any frame for this request within the bound. Log a clear local
    // error and keep the channel open for every other request. The gateway ends
    // its own outstanding request on its wait budget.
    options.logger?.(
      `Duplex broker could not deliver a terminal response within the ${maxFrameBytes}-byte frame bound.`,
    );
  };

  const respond = (
    id: string,
    result: DuplexBrokerForwardResult,
    outcome: DuplexResponseOutcome,
    telemetryOutcome: DuplexOutcomeValue,
  ): void => {
    const entry = pending.get(id);
    if (!entry || entry.responded) return;
    entry.responded = true;
    settlePendingBookkeeping(id, entry);
    // Do not write on a lost or closed channel. The gateway answers its own
    // outstanding request on loss, so a late write would go to a dead channel.
    if (state !== "open") return;
    const bodyText = result.body ?? "";
    const bodyByteCount = Buffer.byteLength(bodyText, "utf8");
    // The response body rides `body_chunk` frames, so a large body no longer makes
    // one frame too large. The gateway reassembles a response body in memory,
    // though, so a body over the frame bound would force the gateway to hold an
    // oversized body in memory. Treat a response body over the frame bound like the
    // former oversized case: send a bounded, non-retryable indeterminate terminal
    // response, and record the request outcome as an error, never a loss.
    if (bodyByteCount > maxFrameBytes) {
      options.telemetry?.recordRequest({
        latencyMs: now() - entry.dispatchStartMs,
        outcome: "error",
      });
      sendTerminalIndeterminate(id);
      return;
    }
    // Record the request span for the delivered request. The span carries the
    // latency and the outcome only; no route, query, body, or token rides it. The
    // broker records the span before the writes, so the outcome is recorded even if
    // a later chunk write records a channel loss.
    options.telemetry?.recordRequest({
      latencyMs: now() - entry.dispatchStartMs,
      outcome: telemetryOutcome,
    });
    sendResponseFrames(id, result.status, result.headers ?? {}, bodyText, outcome);
  };

  const respondSaturated = (id: string, retryable: boolean): void => {
    // Answer a refused request with a bounded terminal response. The broker made
    // no controller, no timer, and no forward for this id, so the host API stays
    // untouched. The response carries no route, no query, no body, and no token;
    // it holds only the fixed error shape. The `unavailable` outcome tells the
    // gateway this is not a delivered host response, so it never counts as one.
    if (state !== "open") return;
    sendResponseFrames(
      id,
      503,
      { "content-type": "application/json", "x-paperclip-bridge-outcome": "unavailable" },
      JSON.stringify({
        error: "Duplex broker capacity limit reached.",
        outcome: "unavailable",
        retryable,
      }),
      "unavailable",
    );
  };

  // Release the timers and route the reassembly and ledger resources for one
  // request the broker just answered. The broker calls it exactly once per
  // request, from the response path. It clears both timers and drops the pending
  // record, then it settles the resources by the request phase:
  //   - A live forward promise (the response backstop answered while the forward
  //     ran) keeps its request tokens and its reassembled body until its finally
  //     owner releases and disposes them, so the orphan registry holds it.
  //   - A request still reassembling (the backstop answered before the forward
  //     started) has no forward promise to settle, so the broker releases its
  //     tokens and disposes the in-flight body now.
  //   - A settled forward already released and disposed through its finally owner.
  const settlePendingBookkeeping = (id: string, entry: PendingRequest): void => {
    if (entry.forwardTimer !== null) clearTimeout(entry.forwardTimer);
    clearTimeout(entry.responseTimer);
    pending.delete(id);
    if (entry.forwardSettled) return;
    if (entry.forwardTimer !== null) {
      // A live forward still owns its request tokens and streams the reassembled
      // body. Keep both charged until the forward finally owner settles them.
      orphanedForwards.set(id, {
        controller: entry.controller,
        releaseForwardTokens: entry.releaseForwardTokens,
      });
      return;
    }
    // The request is still reassembling, so no forward promise will settle. Release
    // the request tokens and dispose the in-flight body, so no spill file, arena
    // reservation, or ledger token lingers.
    entry.releaseForwardTokens();
    if (reassembling.delete(id)) void receiver.disposeBody(id);
    if (entry.reassembled !== null) {
      void entry.reassembled.dispose();
      entry.reassembled = null;
    }
  };

  // Mark a refused or duplicate request id for chunk draining. The sender emits
  // the `body_chunk` frames for the request before it learns of the refusal, so
  // the broker records the raw byte count it must drain and drop. A request with
  // no body needs no draining, so the broker records only a non-zero count.
  const markDrain = (frame: DuplexRequestFrame): void => {
    if (frame.bodyByteCount > 0) draining.set(frame.id, frame.bodyByteCount);
  };

  const respondAggregateExceeded = (id: string): void => {
    // Answer a request the aggregate byte ledger refused with a bounded terminal
    // response. The broker reserved nothing, added no id to the seen set, and made
    // no controller, timer, or forward, so the host API stays untouched. The
    // response carries the fixed marker only; it holds no route, query, body, or
    // token. The `unavailable` outcome tells the gateway this is not a delivered
    // host response. The refusal is retryable, because the broker did not retain
    // the id: the aggregate pressure can ease, and a resend can then get through.
    if (state !== "open") return;
    sendResponseFrames(
      id,
      503,
      { "content-type": "application/json", "x-paperclip-bridge-outcome": "unavailable" },
      JSON.stringify({
        error: DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED,
        outcome: "unavailable",
        retryable: true,
      }),
      "unavailable",
    );
  };

  const dispatch = (frame: DuplexRequestFrame): void => {
    // Dispatch only while open. After loss or close the broker forwards nothing.
    if (state !== "open") return;
    // Bound the id byte size before any retention or work. The codec already
    // rejects an over-limit id on the read path, so this guard is defense in depth
    // for a frame that reaches dispatch by another path. The broker never adds the
    // id to the seen set, never allocates a controller or a timer, and never
    // forwards. It answers with the bounded terminal refusal, which carries no
    // route, query, body, or token, and records no telemetry. The refusal is not
    // retryable, because a resend of the same over-limit id never gets past this
    // bound. It drains the following chunks of the refused body.
    if (Buffer.byteLength(frame.id, "utf8") > DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES) {
      respondSaturated(frame.id, false);
      markDrain(frame);
      return;
    }
    // Forward one id one time. A repeated id never reaches the API twice. The
    // broker already answered the first request, so it answers no second time; it
    // drains the resent body chunks and drops them.
    if (seenRequestIds.has(frame.id)) {
      markDrain(frame);
      return;
    }
    // Bound the retained request-id memory. The broker keeps one id per distinct
    // dispatched request for the no-replay guarantee, so the set can only grow.
    // Once the broker reaches the lifetime limit, it refuses each new distinct id
    // and forwards nothing more. The refusal is not retryable, because a resend
    // never gets past the limit. This check runs before the id joins the set, so
    // the set never grows past the limit.
    if (seenRequestIds.size >= limits.maxLifetimeRequests) {
      respondSaturated(frame.id, false);
      markDrain(frame);
      return;
    }
    // Bound the in-flight request count. Once the broker holds the maximum number
    // of pending forwards, it refuses a further request and forwards nothing for
    // it. The broker does not add the id to the seen set, so the gateway can
    // resend the request after an in-flight request completes. The refusal is
    // retryable for that reason. This check bounds the controllers, the timers,
    // the concurrent reassemblies, and the concurrent forwards a provider can
    // force.
    if (pending.size >= limits.maxInFlightRequests) {
      respondSaturated(frame.id, true);
      markDrain(frame);
      return;
    }
    // Reserve the exact retained bytes against the aggregate ledger before the
    // broker retains anything. It reserves three tokens in order: the raw request
    // frame, the normalized request payload, and the no-replay set entry. A
    // reservation that would pass the ceiling makes the broker retain nothing,
    // release the tokens it already took, and refuse the request with the fixed
    // marker. The broker adds no id to the seen set and makes no controller, timer,
    // or forward, so the host API stays untouched. When the ledger is absent all
    // tokens stay `null` and the broker behaves as before.
    let requestFrameToken: ReservationToken | null = null;
    let requestPayloadToken: ReservationToken | null = null;
    let seenRequestIdToken: ReservationToken | null = null;
    if (ledger) {
      const rawFrameBytes = Buffer.byteLength(encodeDuplexFrame(frame), "utf8");
      requestFrameToken = ledger.reserve("request_frame", rawFrameBytes);
      if (!requestFrameToken) {
        respondAggregateExceeded(frame.id);
        markDrain(frame);
        return;
      }
      requestPayloadToken = ledger.reserve("request_payload", requestPayloadBytes(frame));
      if (!requestPayloadToken) {
        ledger.release(requestFrameToken);
        respondAggregateExceeded(frame.id);
        markDrain(frame);
        return;
      }
      const seenEntryBytes =
        Buffer.byteLength(frame.id, "utf8") + DUPLEX_SEEN_REQUEST_ID_SET_ENTRY_BYTES;
      seenRequestIdToken = ledger.reserve("seen_request_id", seenEntryBytes);
      if (!seenRequestIdToken) {
        ledger.release(requestFrameToken);
        ledger.release(requestPayloadToken);
        respondAggregateExceeded(frame.id);
        markDrain(frame);
        return;
      }
    }
    seenRequestIds.add(frame.id);
    if (seenRequestIdToken) seenRequestIdTokens.add(seenRequestIdToken);

    // Release the request-frame and the request-payload tokens exactly one time.
    // The single forward-promise finally owner calls it after the forward settles.
    // The seen-id token stays charged for the channel lifetime, so it is not part
    // of this release; the terminal teardown releases it.
    let forwardTokensReleased = false;
    const releaseForwardTokens = (): void => {
      if (forwardTokensReleased) return;
      forwardTokensReleased = true;
      releaseToken(requestFrameToken);
      releaseToken(requestPayloadToken);
    };

    const record: DuplexBrokerRequestRecord = {
      id: frame.id,
      method: frame.method,
      path: frame.path,
      dispatchStartMs: now(),
    };
    options.onRequestRecord?.(record);

    const controller = new AbortController();
    // Start the response-budget backstop at the request envelope, so it bounds the
    // whole request: the body reassembly plus the forward. The forward-budget timer
    // starts later, when the broker starts the forward, so it bounds the forward
    // call alone.
    const responseTimer = setTimeout(() => respondBackstop(frame.id), budgets.responseBudgetMs);
    responseTimer.unref?.();
    const entry: PendingRequest = {
      controller,
      responded: false,
      forwardTimer: null,
      responseTimer,
      dispatchStartMs: record.dispatchStartMs,
      method: frame.method,
      reassembled: null,
      forwardSettled: false,
      releaseForwardTokens,
    };
    pending.set(frame.id, entry);
    // Route the following `body_chunk` frames for this id to the reassembler.
    reassembling.add(frame.id);
    // Reassemble the request body from the `body_chunk` frames, then forward it.
    // The reassembler chooses the memory path or the spill path from the envelope
    // `bodyByteCount`, so the broker never holds a whole large request body in
    // memory. A reassembly error is a terminal protocol failure.
    receiver.begin(frame.id, frame.bodyByteCount).then(
      (body) => onBodyReady(frame, entry, body),
      (error) => onBodyError(frame.id, entry, error),
    );
  };

  const respondBackstop = (id: string): void => {
    // Response-budget backstop. The forward rejection normally answers first, well
    // before this deadline. This backstop answers a request whose body never
    // completes its reassembly, or whose forward rejection handling itself stalls,
    // so the request never strands. One stall path is a response whose headers
    // arrive but whose body reader stays pending through the budget, so the forward
    // promise never settles.
    const entry = pending.get(id);
    if (!entry || entry.responded) return;
    if (isSafeBridgeMethod(entry.method)) {
      // A safe method never changes host state, so a stalled body reader cannot
      // leave a mutation half-applied. Keep the request retryable: return a 504
      // with the completed outcome and no indeterminate marker, so the gateway
      // passes it through as a retryable status and never maps it to a terminal 409.
      respond(
        id,
        {
          status: 504,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            error: "Duplex broker response budget exceeded.",
            retryable: true,
          }),
        },
        "completed",
        "error",
      );
      return;
    }
    // The method may mutate host state, and the broker cannot prove the host
    // applied no mutation once the response budget passes. Return a non-retryable
    // 504 and mark the outcome indeterminate, so the gateway maps it to a terminal
    // 409 and no caller double-applies the mutation.
    respond(
      id,
      {
        status: 504,
        headers: {
          "content-type": "application/json",
          "x-paperclip-bridge-outcome": "indeterminate",
        },
        body: JSON.stringify({
          error: "Duplex broker response budget exceeded.",
          outcome: "indeterminate",
          retryable: false,
        }),
      },
      "indeterminate",
      "error",
    );
  };

  // The request body reassembled. Start the forward now, so the forward budget
  // bounds the forward call alone. The broker passes the reassembled body to the
  // forward handler, so the handler streams it to the host API path.
  const onBodyReady = (
    frame: DuplexRequestFrame,
    entry: PendingRequest,
    body: ReassembledBody,
  ): void => {
    reassembling.delete(frame.id);
    if (stopped || state !== "open" || entry.responded) {
      // The channel died, or the response backstop already answered, so no forward
      // runs. Dispose the body and release the request tokens, so no spill file,
      // arena reservation, or ledger token lingers, and drop the request from the
      // pending and orphan maps.
      void body.dispose();
      pending.delete(frame.id);
      orphanedForwards.delete(frame.id);
      entry.releaseForwardTokens();
      return;
    }
    entry.reassembled = body;
    const forwardTimer = setTimeout(() => {
      entry.controller.abort(new Error("Duplex broker forward budget exceeded."));
    }, budgets.forwardTimeoutMs);
    forwardTimer.unref?.();
    entry.forwardTimer = forwardTimer;

    // The forward promise has one cleanup owner. Both settle handlers mark the
    // forward settled and answer the gateway. The `finally` then releases the
    // request tokens exactly one time, disposes the reassembled body, and removes
    // the request from the pending map and the orphan map.
    const markForwardSettled = (): void => {
      entry.forwardSettled = true;
    };
    forwardRequest(frame, { signal: entry.controller.signal, body })
      .then(
        (result) => {
          markForwardSettled();
          // Keep the outcome classification consistent with the file path. A
          // possibly-committed mutation carries the indeterminate marker header, so
          // map it to the indeterminate outcome. Any other result is completed.
          const outcome: DuplexResponseOutcome =
            result.headers?.["x-paperclip-bridge-outcome"] === "indeterminate"
              ? "indeterminate"
              : "completed";
          // The host delivered a real response, so the request span outcome is `ok`.
          // A host application status (200, a 4xx, a 5xx) is still a delivered
          // response; only a broker-synthesized failure below is `error`.
          respond(frame.id, result, outcome, "ok");
        },
        (error) => {
          markForwardSettled();
          if (entry.controller.signal.aborted) {
          // The forward budget aborted the call. A safe method never changes
          // host state, so a forward timeout stays retryable for it. Return a
          // 504 with the completed outcome and no indeterminate marker, so the
          // gateway passes it through as a retryable status.
          if (isSafeBridgeMethod(frame.method)) {
            respond(
              frame.id,
              {
                status: 504,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  error: errorMessage(error),
                  retryable: true,
                }),
              },
              "completed",
              "error",
            );
            return;
          }
          // The method may mutate host state, and the forward budget aborted the
          // call after the request may have committed. Return a non-retryable 504
          // and mark the outcome indeterminate, so a caller does not retry a
          // committed mutation.
          respond(
            frame.id,
            {
              status: 504,
              headers: {
                "content-type": "application/json",
                "x-paperclip-bridge-outcome": "indeterminate",
              },
              body: JSON.stringify({
                error: errorMessage(error),
                outcome: "indeterminate",
                retryable: false,
              }),
            },
            "indeterminate",
            "error",
          );
          return;
        }
        // The forward rejected before the host delivered a response. This
        // rejection does not prove that the host applied no mutation. A fetch
        // can reject after the request bytes reach the host and the host
        // commits, but before the response headers arrive. A safe method never
        // changes host state, so a retry stays safe for it. For any other
        // method the host may have committed, so the outcome is indeterminate.
        if (isSafeBridgeMethod(frame.method)) {
          // The method is safe, so a retry cannot double-apply a mutation.
          // Return a 502 with the completed outcome, so the gateway passes it
          // through as a retryable status.
          respond(
            frame.id,
            {
              status: 502,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ error: errorMessage(error) }),
            },
            "completed",
            "error",
          );
          return;
        }
        // The method may mutate host state, so a retry with a new request id
        // could apply the mutation twice. Return a non-retryable 504 and mark
        // the outcome indeterminate, so the gateway maps it to a terminal 409.
        respond(
          frame.id,
          {
            status: 504,
            headers: {
              "content-type": "application/json",
              "x-paperclip-bridge-outcome": "indeterminate",
            },
            body: JSON.stringify({
              error: errorMessage(error),
              outcome: "indeterminate",
              retryable: false,
            }),
          },
          "indeterminate",
          "error",
        );
        },
      )
      .finally(() => {
        // The single forward cleanup owner. Release the request tokens, dispose the
        // reassembled body, and drop the request from the pending and orphan maps,
        // each exactly one time.
        pending.delete(frame.id);
        orphanedForwards.delete(frame.id);
        entry.releaseForwardTokens();
        if (entry.reassembled !== null) {
          void entry.reassembled.dispose();
          entry.reassembled = null;
        }
      });
  };

  // The request body reassembly failed. A malformed chunk, a size mismatch, an
  // overrun, or a truncation is a terminal protocol failure, so the broker fails
  // the channel closed. A `channel_closed` error is the broker's own teardown of an
  // in-flight body, so it is not a fresh loss.
  const onBodyError = (id: string, entry: PendingRequest, error: unknown): void => {
    reassembling.delete(id);
    // The forward never ran, so release its request tokens and drop the request
    // from the pending and orphan maps. The release is idempotent, so a teardown
    // that already released the tokens keeps the count correct.
    pending.delete(id);
    orphanedForwards.delete(id);
    entry.releaseForwardTokens();
    if (stopped) return;
    if (error instanceof DuplexBodyError && error.code === "channel_closed") return;
    recordLoss("protocol_failure", errorMessage(error));
  };

  // Route one `body_chunk` frame. A chunk for an id under reassembly goes to the
  // reassembler, which validates it and appends it. A chunk for a refused or
  // duplicate id drains against its recorded byte count and drops. A chunk with no
  // matching envelope is a terminal protocol failure.
  const handleBodyChunk = (frame: DuplexBodyChunkFrame): void => {
    if (reassembling.has(frame.id)) {
      const result = receiver.pushChunk(frame);
      if (!result.ok) recordLoss("protocol_failure", result.error.message);
      return;
    }
    const remaining = draining.get(frame.id);
    if (remaining !== undefined) {
      // Drain and drop a chunk of a refused body. The broker does not validate a
      // drained chunk; it only tracks the byte progress, so it stops draining once
      // the refused body ends. A further chunk after that is a chunk with no
      // envelope.
      const next = remaining - Buffer.byteLength(frame.data, "base64");
      if (next > 0) draining.set(frame.id, next);
      else draining.delete(frame.id);
      return;
    }
    recordLoss("protocol_failure", "body_chunk arrived with no matching envelope");
  };

  const handleFrame = (frame: DuplexFrame): void => {
    switch (frame.type) {
      case "request":
        dispatch(frame);
        return;
      case "body_chunk":
        handleBodyChunk(frame);
        return;
      case "close":
        // The gateway asked for an orderly close. The gateway sends this frame on
        // the agent's orderly completion, so mark the completion on the ordered
        // lifecycle before the close, then close the channel.
        markOrderlyCompletion();
        void close();
        return;
      case "ready":
      case "heartbeat":
        // Liveness frames. The broker reads them and dispatches nothing.
        return;
      case "response":
      case "error":
        // The host never expects these on the read path. Ignore them.
        return;
      default:
        return;
    }
  };

  const onData = (chunk: string): void => {
    if (stopped) return;
    const results = decoder.push(chunk);
    for (const result of results) {
      if (stopped) return;
      if (!result.ok) {
        recordLoss("protocol_failure", result.error.message);
        return;
      }
      handleFrame(result.frame);
    }
  };

  const onExit = (exit: { exitCode: number | null; transportClosed?: boolean }): void => {
    // A reason-less transport close is not a process exit. Record it as a distinct
    // loss, so a transport close stays legible in the loss taxonomy. A real process
    // exit stays `channel_exit` -> `provider_exit`.
    if (exit.transportClosed === true) {
      recordLoss("transport_closed", "The sandbox channel transport closed with no exit.");
      return;
    }
    recordLoss("channel_exit", "The sandbox channel process exited.");
  };

  const sendHeartbeat = (): void => {
    if (state !== "open") return;
    try {
      channel.write(encodeDuplexFrame({ version: DUPLEX_FRAME_VERSION, type: "heartbeat" }));
    } catch (error) {
      recordLoss("heartbeat_write_failure", errorMessage(error));
    }
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    if (stopped) return Promise.resolve();
    // A host-initiated orderly close is a host-observed orderly completion. The
    // host tears the channel down on its own terms, so a channel end during the
    // close is a normal teardown, not a mid-run loss. `markOrderlyCompletion`
    // no-ops when a loss already latched, so a lost channel stays a failure.
    markOrderlyCompletion();
    closePromise = (async () => {
      setState("closing");
      clearHeartbeat();
      clearPending();
      releaseSeenRequestIdTokens();
      decoder.dispose();
      // Send an orderly close frame. Ignore a write failure here; the broker is
      // already closing, so a dead channel needs no loss record.
      try {
        channel.write(encodeDuplexFrame({ version: DUPLEX_FRAME_VERSION, type: "close" }));
      } catch (error) {
        options.logger?.(`Duplex broker could not send the close frame: ${errorMessage(error)}`);
      }
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        closeTimer = setTimeout(() => {
          reject(new Error("Duplex broker channel close timed out."));
        }, closeTimeoutMs);
        closeTimer.unref?.();
      });
      try {
        await Promise.race([channel.close(), timeout]);
        if (closeTimer !== undefined) clearTimeout(closeTimer);
        stopped = true;
        setState("closed");
      } catch (error) {
        if (closeTimer !== undefined) clearTimeout(closeTimer);
        recordLoss("close_timeout", errorMessage(error));
      }
      // Remove the spill directory and every in-flight body. The broker owns the
      // reassembler, so the orderly close cleans it up.
      await finalizeReceiver();
    })();
    return closePromise;
  };

  const start = (): void => {
    if (started) return;
    started = true;
    channel.onData(onData);
    channel.onExit(onExit);
    heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    setState("open");
  };

  const stop = (): void => {
    try {
      channel.stop();
    } catch (error) {
      options.logger?.(`Duplex broker could not stop the channel: ${errorMessage(error)}`);
    }
  };

  return {
    get state() {
      return state;
    },
    get lossRecord() {
      return lossRecord;
    },
    get runDisposition(): DuplexBrokerRunDisposition {
      // A latched loss ordered before any orderly completion is a failure. Every
      // other state — a healthy channel, or a loss ordered after an orderly
      // completion — is a success.
      return { failed: lossSeq !== null, lossReason: typedLossReason };
    },
    markOrderlyCompletion,
    settleRunDisposition,
    start,
    close,
    stop,
  };
}
