/**
 * The process-wide admission gate for the host HTTP/2 sandbox bridge.
 *
 * The host holds sandbox request bytes and host response bytes in host
 * memory for every admitted stream and every live bridge session. No
 * per-request bound stops the host from holding an unbounded number of
 * streams or sessions at once. This module owns two process-wide caps: a cap
 * on parallel admitted streams, and a cap on live bridge sessions. Each cap
 * bounds a known per-unit byte cost, so the pair of caps bounds the host's
 * worst-case retained bytes for the bridge.
 *
 * A per-field cap is not a bound on the pair. The joint budget rule in
 * {@link resolveHttp2BridgeAdmissionCaps} is the required security control:
 * it validates the resolved pair as one policy, not as two independent
 * fields, and it fails closed to both defaults when the pair does not fit.
 *
 * This module imports no other bridge module. It owns the byte budget
 * constants so the joint rule has one home for the numbers it checks.
 */

/** The target host memory budget for the bridge admission gate. */
export const HTTP2_BRIDGE_ADMISSION_MEMORY_TARGET_BYTES = 256 * 1024 * 1024;

/**
 * The reserved budget the joint rule checks against. The gate holds back 25
 * percent of {@link HTTP2_BRIDGE_ADMISSION_MEMORY_TARGET_BYTES} for
 * JavaScript object overhead and allocator behavior, so a resolved cap pair
 * that spends the full reserved budget still leaves headroom under the
 * target.
 */
export const HTTP2_BRIDGE_ADMISSION_RESERVED_BUDGET_BYTES = Math.floor(
  HTTP2_BRIDGE_ADMISSION_MEMORY_TARGET_BYTES * 0.75,
);

/**
 * The worst-case bytes one admitted stream holds in host memory at once: the
 * request body buffer the handler holds during the forward call
 * (262,144 bytes), the response read chunks (262,144 bytes), the response
 * concatenation buffer or the queued response after the read (262,144
 * bytes), the in-flight DATA bytes on the HTTP/2 stream window (65,535
 * bytes, the protocol default), and one decompressed header list (16,384
 * bytes, the host's header-size limit). The three body terms each match
 * `DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES` in
 * `sandbox-callback-bridge.ts`.
 */
export const HTTP2_BRIDGE_ADMITTED_STREAM_BUDGET_BYTES = 262_144 + 262_144 + 262_144 + 65_535 + 16_384;

/**
 * The worst-case bytes one live bridge session holds in host memory at once.
 * This matches `DEFAULT_HTTP2_BRIDGE_MAX_BUFFERED_READ_BYTES` in
 * `http2-bridge-server.ts`. That file imports this constant so the wrapper
 * cap and this reservation cannot drift apart.
 */
export const HTTP2_BRIDGE_LIVE_SESSION_BUDGET_BYTES = 16 * 1024 * 1024;

/**
 * The default cap on parallel admitted streams. Paired with
 * {@link DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS} this spends
 * {@link HTTP2_BRIDGE_ADMITTED_STREAM_BUDGET_BYTES} times this many bytes of
 * the reserved budget.
 */
export const DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS = 64;

/**
 * The default cap on live bridge sessions. Paired with
 * {@link DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS} this spends
 * {@link HTTP2_BRIDGE_LIVE_SESSION_BUDGET_BYTES} times this many bytes of the
 * reserved budget.
 */
export const DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS = 8;

/**
 * The hard upper bound on either cap override, on its own. This keeps a
 * mistyped or malicious override from removing the bound entirely. A value
 * inside this range can still fail the joint rule below.
 */
export const MAX_HTTP2_BRIDGE_ADMISSION_CAP = 64;

/**
 * Report whether `value` is a valid cap override: a safe integer from 1 to
 * {@link MAX_HTTP2_BRIDGE_ADMISSION_CAP}. Every other value is invalid,
 * including a non-number, a non-integer, a non-finite number, zero, a
 * negative number, and a number over the range.
 */
export function isValidHttp2BridgeAdmissionCap(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_HTTP2_BRIDGE_ADMISSION_CAP
  );
}

/**
 * A reporter the host binds to receive one invalid cap override rejection.
 * The signal carries only the rejected value.
 */
export type Http2BridgeAdmissionCapOverrideRejectionReporter = (rejectedValue: unknown) => void;

function resolveHttp2BridgeAdmissionCap(
  override: number | null | undefined,
  defaultValue: number,
  onRejectedOverride?: Http2BridgeAdmissionCapOverrideRejectionReporter,
): number {
  if (override === undefined || override === null) {
    return defaultValue;
  }
  if (!isValidHttp2BridgeAdmissionCap(override)) {
    onRejectedOverride?.(override);
    return defaultValue;
  }
  return override;
}

/**
 * Resolve the parallel-stream cap from an optional operator override. A
 * missing or `null` override uses
 * {@link DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS}. A present invalid
 * override does not fail host startup: the resolver rejects it, reports it
 * through the optional `onRejectedOverride` reporter, and returns the
 * default.
 */
export function resolveMaxParallelHttp2BridgeRequests(
  override?: number | null,
  onRejectedOverride?: Http2BridgeAdmissionCapOverrideRejectionReporter,
): number {
  return resolveHttp2BridgeAdmissionCap(
    override,
    DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
    onRejectedOverride,
  );
}

/**
 * Resolve the live-session cap from an optional operator override. Same
 * fallback behavior as {@link resolveMaxParallelHttp2BridgeRequests}, with
 * {@link DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS} as the default.
 */
export function resolveMaxLiveHttp2BridgeSessions(
  override?: number | null,
  onRejectedOverride?: Http2BridgeAdmissionCapOverrideRejectionReporter,
): number {
  return resolveHttp2BridgeAdmissionCap(
    override,
    DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS,
    onRejectedOverride,
  );
}

/**
 * Compute the worst-case retained bytes for one resolved cap pair, from the
 * byte budget constants at call time. The caller never stores this total; it
 * always recomputes it from the current caps and the current constants.
 */
export function http2BridgeAdmissionBudgetBytes(maxParallel: number, maxSessions: number): number {
  return (
    maxParallel * HTTP2_BRIDGE_ADMITTED_STREAM_BUDGET_BYTES +
    maxSessions * HTTP2_BRIDGE_LIVE_SESSION_BUDGET_BYTES
  );
}

export interface Http2BridgeAdmissionCapOverrides {
  maxParallel?: number | null;
  maxSessions?: number | null;
}

export interface Http2BridgeAdmissionCaps {
  maxParallel: number;
  maxSessions: number;
}

/** One rejected cap pair, reported when the joint budget rule fails it. */
export interface Http2BridgeAdmissionPairRejection extends Http2BridgeAdmissionCaps {
  /** The worst-case retained bytes the rejected pair would have spent. */
  totalBytes: number;
}

/**
 * A reporter the host binds to receive one joint-rule rejection at error
 * level. A warning is not a safety control: the pair this reporter carries
 * already failed a required security condition, so the host must log it
 * loud enough for an operator to act on it.
 */
export type Http2BridgeAdmissionPairRejectionReporter = (rejection: Http2BridgeAdmissionPairRejection) => void;

/**
 * Resolve one admission cap pair from optional operator overrides.
 *
 * The resolver runs each per-field check first, through
 * {@link resolveMaxParallelHttp2BridgeRequests} and
 * {@link resolveMaxLiveHttp2BridgeSessions}. A per-field range is not a bound
 * on the pair: each cap alone can pass its own range and the pair can still
 * spend far more than the reserved budget. The resolver then runs the joint
 * rule on the resolved pair:
 *
 * ```text
 * (maxParallel * HTTP2_BRIDGE_ADMITTED_STREAM_BUDGET_BYTES)
 *   + (maxSessions * HTTP2_BRIDGE_LIVE_SESSION_BUDGET_BYTES)
 *   <= HTTP2_BRIDGE_ADMISSION_RESERVED_BUDGET_BYTES
 * ```
 *
 * A pair that fails the joint rule returns both defaults. The resolver never
 * keeps one override and one default: a partly-applied pair would keep an
 * operator value the host just refused. The resolver reports a failed pair
 * through `onRejectedPair` at error level.
 */
export function resolveHttp2BridgeAdmissionCaps(
  overrides: Http2BridgeAdmissionCapOverrides,
  onRejectedPair?: Http2BridgeAdmissionPairRejectionReporter,
): Http2BridgeAdmissionCaps {
  const maxParallel = resolveMaxParallelHttp2BridgeRequests(overrides.maxParallel);
  const maxSessions = resolveMaxLiveHttp2BridgeSessions(overrides.maxSessions);
  const totalBytes = http2BridgeAdmissionBudgetBytes(maxParallel, maxSessions);
  if (totalBytes > HTTP2_BRIDGE_ADMISSION_RESERVED_BUDGET_BYTES) {
    onRejectedPair?.({ maxParallel, maxSessions, totalBytes });
    return {
      maxParallel: DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
      maxSessions: DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS,
    };
  }
  return { maxParallel, maxSessions };
}

/** A queued stream waiter. `settle` resolves or rejects exactly once. */
interface Http2BridgeAdmissionStreamWaiter {
  settle(outcome: { release: () => void } | { error: Error }): void;
  detachAbortListener(): void;
}

function abortErrorFor(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "The HTTP/2 bridge stream admission wait was aborted.",
  );
}

/**
 * The process-owned admission gate for the host HTTP/2 sandbox bridge.
 *
 * The stream gate is a first-in-first-out queue. `acquire` admits a caller
 * at once while the active count is under `maxParallel`, and otherwise
 * queues the caller. A released slot always goes to the oldest queued
 * waiter. A queued waiter can cancel through an `AbortSignal`; a cancelled
 * waiter leaves the queue and never takes a later slot.
 *
 * The session counter never queues. `tryAcquireSession` returns a release
 * function or `null` at once. A caller that waited for a session slot would
 * hold a partly-open channel open for an unbounded time, so the session
 * bound fails fast instead.
 *
 * Every release function this gate returns is idempotent: a second call
 * frees no second slot.
 */
export class Http2BridgeAdmissionGate {
  readonly maxParallel: number;
  readonly maxSessions: number;

  private activeStreamCount = 0;
  private activeSessions = 0;
  private readonly queue: Http2BridgeAdmissionStreamWaiter[] = [];

  constructor(options: Http2BridgeAdmissionCaps) {
    this.maxParallel = options.maxParallel;
    this.maxSessions = options.maxSessions;
  }

  get activeCount(): number {
    return this.activeStreamCount;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get activeSessionCount(): number {
    return this.activeSessions;
  }

  /**
   * Wait for one admitted stream slot. Resolves at once when a slot is free.
   * Otherwise queues the caller in arrival order and resolves when an
   * earlier holder releases its slot. Rejects if `signal` aborts while the
   * caller is still queued; an already-aborted signal rejects at once
   * without queuing.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(abortErrorFor(signal));
    }
    if (this.activeStreamCount < this.maxParallel) {
      this.activeStreamCount += 1;
      return Promise.resolve(this.createStreamRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      const waiter: Http2BridgeAdmissionStreamWaiter = {
        settle: (outcome) => {
          waiter.detachAbortListener();
          if ("release" in outcome) {
            resolve(outcome.release);
          } else {
            reject(outcome.error);
          }
        },
        detachAbortListener: () => {
          if (onAbort) {
            signal?.removeEventListener("abort", onAbort);
            onAbort = null;
          }
        },
      };
      if (signal) {
        onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }
          waiter.settle({ error: abortErrorFor(signal) });
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private createStreamRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeStreamCount -= 1;
      this.admitNextWaiter();
    };
  }

  private admitNextWaiter(): void {
    while (this.queue.length > 0 && this.activeStreamCount < this.maxParallel) {
      const waiter = this.queue.shift();
      if (!waiter) break;
      this.activeStreamCount += 1;
      waiter.settle({ release: this.createStreamRelease() });
    }
  }

  /**
   * Take one live-session slot if the cap allows it. Returns an idempotent
   * release function on success, or `null` at once when the cap is already
   * spent. Never queues.
   */
  tryAcquireSession(): (() => void) | null {
    if (this.activeSessions >= this.maxSessions) {
      return null;
    }
    this.activeSessions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeSessions -= 1;
    };
  }
}

let processHttp2BridgeAdmissionGate: Http2BridgeAdmissionGate | null = null;

/**
 * Read the process-wide admission gate, creating it on first use from the
 * default cap pair. Every host call site shares this one instance, so one
 * pair of caps bounds the bridge's worst-case retained bytes across the
 * whole process.
 */
export function getHttp2BridgeAdmissionGate(): Http2BridgeAdmissionGate {
  if (!processHttp2BridgeAdmissionGate) {
    processHttp2BridgeAdmissionGate = new Http2BridgeAdmissionGate(resolveHttp2BridgeAdmissionCaps({}));
  }
  return processHttp2BridgeAdmissionGate;
}

/**
 * Replace the process-wide admission gate with one built from the given cap
 * overrides. Routes the overrides through {@link resolveHttp2BridgeAdmissionCaps},
 * so this call site and every other caller resolve a cap pair through the
 * same per-field checks and the same joint budget rule.
 */
export function configureHttp2BridgeAdmissionGate(
  overrides: Http2BridgeAdmissionCapOverrides,
  onRejectedPair?: Http2BridgeAdmissionPairRejectionReporter,
): Http2BridgeAdmissionGate {
  processHttp2BridgeAdmissionGate = new Http2BridgeAdmissionGate(
    resolveHttp2BridgeAdmissionCaps(overrides, onRejectedPair),
  );
  return processHttp2BridgeAdmissionGate;
}
