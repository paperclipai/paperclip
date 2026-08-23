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
  DEFAULT_MAX_DUPLEX_FRAME_BYTES,
  DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES,
  DUPLEX_FRAME_VERSION,
  DuplexFrameDecoder,
  encodeDuplexFrame,
  encodeDuplexFrameChecked,
  type DuplexFrame,
  type DuplexRequestFrame,
  type DuplexResponseFrame,
  type DuplexResponseOutcome,
} from "./duplex-frame-codec.js";
import type {
  DuplexLossReason,
  DuplexOutcomeValue,
  DuplexTelemetry,
} from "./duplex-telemetry.js";

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
 * API path. The broker aborts `options.signal` when the forward budget ends or a
 * loss happens, so a handler that threads the signal into its work stops early.
 */
export type DuplexBrokerForwardHandler = (
  request: DuplexRequestFrame,
  options: { signal: AbortSignal },
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
  telemetry?: DuplexTelemetry;
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
  forwardTimer: ReturnType<typeof setTimeout>;
  responseTimer: ReturnType<typeof setTimeout>;
  /** The point the broker started to dispatch the request. It sets the span latency. */
  dispatchStartMs: number;
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
 * Create the host duplex bridge broker. The factory asserts the budget order and
 * returns a handle. Call `start` to wire the channel and open the broker.
 */
export function createDuplexBridgeBroker(options: DuplexBrokerOptions): DuplexBridgeBroker {
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
  // forward. It counts the exact retained scalar and header bytes, so the charge
  // matches the retained bytes and never a parsed object graph.
  const requestPayloadBytes = (frame: DuplexRequestFrame): number => {
    let bytes =
      Buffer.byteLength(frame.id, "utf8") +
      Buffer.byteLength(frame.method, "utf8") +
      Buffer.byteLength(frame.path, "utf8") +
      Buffer.byteLength(frame.query, "utf8") +
      Buffer.byteLength(frame.body, "utf8");
    for (const [key, value] of Object.entries(frame.headers)) {
      bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    }
    return bytes;
  };

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
      clearTimeout(entry.forwardTimer);
      clearTimeout(entry.responseTimer);
      entry.controller.abort(new Error("Duplex broker stopped."));
      // A forward that has not settled still owns its request tokens. Transfer it
      // to the orphan registry, so its tokens stay charged until the forward
      // finally releases them. The abort only asks the forward to stop; it never
      // releases a token by itself.
      if (!entry.forwardSettled) {
        orphanedForwards.set(id, {
          controller: entry.controller,
          releaseForwardTokens: entry.releaseForwardTokens,
        });
      }
    }
    pending.clear();
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

  // The result of one bounded send. `sent` means the frame went out; `too_large`
  // means the encoded frame exceeds the bound and the broker wrote nothing;
  // `lost` means the write failed and the broker recorded the channel loss.
  type SendResult = "sent" | "too_large" | "lost";

  const trySendFrame = (frame: DuplexFrame): SendResult => {
    // Enforce the frame size bound on every broker write. Report a size rejection
    // as `too_large` without a channel loss; a broker-built frame over the bound
    // is a defect, not a transport failure. A caller decides how to answer the
    // request, so no size rejection ever drops the channel.
    const encoded = encodeDuplexFrameChecked(frame, maxFrameBytes);
    if (!encoded.ok) return "too_large";
    return writeLine(encoded.line) ? "sent" : "lost";
  };

  const writeFrame = (frame: DuplexFrame): boolean => {
    // A control frame and the bounded terminal responses are always small, so the
    // size guard is a no-op for them. Drop an oversized frame here without a
    // channel loss and report the drop to the caller.
    const result = trySendFrame(frame);
    if (result === "too_large") {
      options.logger?.(`Duplex broker dropped an oversized ${frame.type} frame.`);
      return false;
    }
    return result === "sent";
  };

  const sendTerminalIndeterminate = (id: string): void => {
    // Answer one request the broker cannot deliver with the real result. The
    // request reached the host and may have changed state, so the response is
    // non-retryable and carries the `indeterminate` outcome. The broker tries the
    // full replacement first. When the frame bound rejects even the full
    // replacement, the broker sends a minimal replacement that carries only the
    // `indeterminate` outcome, so the gateway still ends the request and never
    // waits for its full wait budget. When the bound rejects even the minimal
    // replacement, the broker logs a clear local error and keeps the channel
    // open; it records no channel loss.
    const fullReplacement: DuplexResponseFrame = {
      version: DUPLEX_FRAME_VERSION,
      type: "response",
      id,
      status: 502,
      headers: {
        "content-type": "application/json",
        "x-paperclip-bridge-outcome": "indeterminate",
      },
      body: JSON.stringify({
        error: "upstream response too large to deliver",
        outcome: "indeterminate",
        retryable: false,
      }),
      outcome: "indeterminate",
    };
    if (trySendFrame(fullReplacement) !== "too_large") return;
    // The bound rejects the full replacement. Send a minimal terminal response
    // with empty headers and an empty body. The `indeterminate` outcome still
    // rides the frame, so the gateway maps the request to a terminal 409.
    const minimalReplacement: DuplexResponseFrame = {
      version: DUPLEX_FRAME_VERSION,
      type: "response",
      id,
      status: 502,
      headers: {},
      body: "",
      outcome: "indeterminate",
    };
    if (trySendFrame(minimalReplacement) !== "too_large") return;
    // The bound rejects even the minimal terminal response. The broker cannot
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
    clearTimeout(entry.forwardTimer);
    clearTimeout(entry.responseTimer);
    pending.delete(id);
    // The response timer, an abort, or a broker loss can answer the gateway before
    // the forward promise settles. When the forward has not settled, transfer it to
    // the orphan registry so its request tokens stay charged until the forward
    // finally releases them. A settled forward already released or will release
    // through its finally owner, so it needs no orphan record.
    if (!entry.forwardSettled) {
      orphanedForwards.set(id, {
        controller: entry.controller,
        releaseForwardTokens: entry.releaseForwardTokens,
      });
    }
    // Do not write on a lost or closed channel. The gateway answers its own
    // outstanding request on loss, so a late write would go to a dead channel.
    if (state !== "open") return;
    const frame: DuplexResponseFrame = {
      version: DUPLEX_FRAME_VERSION,
      type: "response",
      id,
      status: result.status,
      headers: result.headers ?? {},
      body: result.body ?? "",
      outcome,
    };
    const encoded = encodeDuplexFrameChecked(frame, maxFrameBytes);
    if (!encoded.ok) {
      // The host produced a result, but the response frame exceeds the size
      // bound. Do not write the oversized frame and do not record a channel loss.
      // The request reached the host and may have changed state, so the caller
      // must not retry a possible mutation. Send a bounded, non-retryable terminal
      // response marked `indeterminate` in its place. Record the request outcome
      // as an error, never a loss. The channel stays open for every other request.
      options.telemetry?.recordRequest({
        latencyMs: now() - entry.dispatchStartMs,
        outcome: "error",
      });
      sendTerminalIndeterminate(id);
      return;
    }
    // Record the request span for the delivered request. The span carries the
    // latency and the outcome only; no route, query, body, or token rides it.
    options.telemetry?.recordRequest({
      latencyMs: now() - entry.dispatchStartMs,
      outcome: telemetryOutcome,
    });
    writeLine(encoded.line);
  };

  const respondSaturated = (id: string, retryable: boolean): void => {
    // Answer a refused request with a bounded terminal response. The broker made
    // no controller, no timer, and no forward for this id, so the host API stays
    // untouched. The response carries no route, no query, no body, and no token;
    // it holds only the fixed error shape. The `unavailable` outcome tells the
    // gateway this is not a delivered host response, so it never counts as one.
    if (state !== "open") return;
    const frame: DuplexResponseFrame = {
      version: DUPLEX_FRAME_VERSION,
      type: "response",
      id,
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-paperclip-bridge-outcome": "unavailable",
      },
      body: JSON.stringify({
        error: "Duplex broker capacity limit reached.",
        outcome: "unavailable",
        retryable,
      }),
      outcome: "unavailable",
    };
    writeFrame(frame);
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
    const frame: DuplexResponseFrame = {
      version: DUPLEX_FRAME_VERSION,
      type: "response",
      id,
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-paperclip-bridge-outcome": "unavailable",
      },
      body: JSON.stringify({
        error: DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED,
        outcome: "unavailable",
        retryable: true,
      }),
      outcome: "unavailable",
    };
    writeFrame(frame);
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
    // bound.
    if (Buffer.byteLength(frame.id, "utf8") > DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES) {
      respondSaturated(frame.id, false);
      return;
    }
    // Forward one id one time. A repeated id never reaches the API twice.
    if (seenRequestIds.has(frame.id)) return;
    // Bound the retained request-id memory. The broker keeps one id per distinct
    // dispatched request for the no-replay guarantee, so the set can only grow.
    // Once the broker reaches the lifetime limit, it refuses each new distinct id
    // and forwards nothing more. The refusal is not retryable, because a resend
    // never gets past the limit. This check runs before the id joins the set, so
    // the set never grows past the limit.
    if (seenRequestIds.size >= limits.maxLifetimeRequests) {
      respondSaturated(frame.id, false);
      return;
    }
    // Bound the in-flight request count. Once the broker holds the maximum number
    // of pending forwards, it refuses a further request and forwards nothing for
    // it. The broker does not add the id to the seen set, so the gateway can
    // resend the request after an in-flight request completes. The refusal is
    // retryable for that reason. This check bounds the controllers, the timers,
    // and the concurrent forwards a provider can force.
    if (pending.size >= limits.maxInFlightRequests) {
      respondSaturated(frame.id, true);
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
        return;
      }
      requestPayloadToken = ledger.reserve("request_payload", requestPayloadBytes(frame));
      if (!requestPayloadToken) {
        ledger.release(requestFrameToken);
        respondAggregateExceeded(frame.id);
        return;
      }
      const seenEntryBytes =
        Buffer.byteLength(frame.id, "utf8") + DUPLEX_SEEN_REQUEST_ID_SET_ENTRY_BYTES;
      seenRequestIdToken = ledger.reserve("seen_request_id", seenEntryBytes);
      if (!seenRequestIdToken) {
        ledger.release(requestFrameToken);
        ledger.release(requestPayloadToken);
        respondAggregateExceeded(frame.id);
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
    const forwardTimer = setTimeout(() => {
      controller.abort(new Error("Duplex broker forward budget exceeded."));
    }, budgets.forwardTimeoutMs);
    const responseTimer = setTimeout(() => {
      // Response-budget backstop. The forward rejection normally answers first,
      // well before this deadline. This backstop answers a request whose forward
      // rejection handling itself stalls, so the request never strands. One stall
      // path is a response whose headers arrive but whose body reader stays
      // pending through the budget, so the forward promise never settles.
      if (isSafeBridgeMethod(frame.method)) {
        // A safe method never changes host state, so a stalled body reader
        // cannot leave a mutation half-applied. Keep the request retryable:
        // return a 504 with the completed outcome and no indeterminate marker,
        // so the gateway passes it through as a retryable status and never maps
        // it to a terminal 409.
        respond(
          frame.id,
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
      // applied no mutation once the response budget passes. Return a
      // non-retryable 504 and mark the outcome indeterminate, so the gateway
      // maps it to a terminal 409 and no caller double-applies the mutation.
      respond(
        frame.id,
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
    }, budgets.responseBudgetMs);
    forwardTimer.unref?.();
    responseTimer.unref?.();
    pending.set(frame.id, {
      controller,
      responded: false,
      forwardTimer,
      responseTimer,
      dispatchStartMs: record.dispatchStartMs,
      forwardSettled: false,
      releaseForwardTokens,
    });

    // The forward promise has one cleanup owner. The two settle handlers mark the
    // forward settled and answer the gateway. The `finally` then releases the
    // request tokens exactly one time and removes the request from both the pending
    // map and the orphan map. The forward resolves only after the forward and its
    // response-body reader both settle, so this owner waits for both.
    const markForwardSettled = (): void => {
      // Mark the pending entry settled before `respond` runs, so `respond` never
      // moves a just-settled forward to the orphan registry. An already-orphaned
      // forward needs no flag; its finally owner releases and drains it.
      const entry = pending.get(frame.id);
      if (entry) entry.forwardSettled = true;
    };
    forwardRequest(frame, { signal: controller.signal })
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
          return handleForwardRejection(error);
        },
      )
      .finally(() => {
        pending.delete(frame.id);
        orphanedForwards.delete(frame.id);
        releaseForwardTokens();
      });

    // The forward rejection handler. It classifies the rejection by method safety
    // and answers the gateway. The `markForwardSettled` call above runs first, so
    // the response never re-orphans a settled forward.
    function handleForwardRejection(error: unknown): void {
        if (controller.signal.aborted) {
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
    }
  };

  const handleFrame = (frame: DuplexFrame): void => {
    switch (frame.type) {
      case "request":
        dispatch(frame);
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
