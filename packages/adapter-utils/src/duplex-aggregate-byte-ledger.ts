/**
 * The process-owned aggregate byte ledger for the sandbox duplex channel.
 *
 * The route-count controller bounds how many concurrent duplex routes stay live.
 * It does not bound the aggregate bytes those routes retain. At the maximum route
 * count the per-route byte bounds multiply to many gigabytes of retained bytes.
 * This ledger closes that gap. One ledger per host server process owns a single
 * byte ceiling. Every host-side retention site reserves its exact retained bytes
 * against this ledger before it allocates, so the aggregate retained bytes across
 * all live routes never pass the ceiling.
 *
 * The ledger is fail-closed. A reservation that would pass the ceiling returns no
 * token. The caller retains nothing and reports the fixed rejection marker
 * {@link DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED}.
 *
 * Ownership is transfer-only. A token holds an immutable byte amount, an owner
 * label from a closed enum, and a one-way state: `held` then `released`. The
 * ledger moves a token from one representation to the next with
 * {@link DuplexAggregateByteLedger.transfer}, which changes only the owner label.
 * It never decrements and re-reserves, so no admission gap opens between two
 * representations of the same retained bytes.
 *
 * The ledger holds every live token in one owner registry. Registry removal and
 * the release of a token run in one synchronous critical section, before any
 * `await` or external callback. A second release of the same token is an
 * accounting defect. The ledger records the fixed underflow counter and does not
 * clamp the gauge down a second time, so a real defect stays visible.
 *
 * The ledger carries no payload data and no arbitrary labels. It exposes only the
 * byte gauge, the live-token count, and the closed owner enum.
 */

import {
  DUPLEX_COUNTER_AGGREGATE_BYTE_ACCOUNTING_UNDERFLOW_TOTAL,
  DUPLEX_COUNTER_AGGREGATE_BYTE_RESERVATION_REJECTIONS_TOTAL,
  DUPLEX_GAUGE_AGGREGATE_BYTES_IN_USE,
} from "./duplex-observability.js";

/**
 * The public rejection marker. A retention site that cannot reserve its bytes
 * reports this fixed string. It carries no payload, no route, and no raw value.
 */
export const DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED = "DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED";

/**
 * The default aggregate ceiling, in bytes: 256 MiB. This is one eighth of the
 * documented minimum host process memory allocation for the sandbox duplex
 * transport ({@link MIN_HOST_PROCESS_MEMORY_BYTES_FOR_DUPLEX}, 2 GiB). The
 * remaining seven eighths cover the Node runtime, ordinary server work, parser
 * and transient headroom, and allocator or garbage-collector variance.
 */
export const DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES = 256 * 1024 * 1024;

/**
 * The documented minimum host process memory allocation to enable the sandbox
 * duplex transport, in bytes: 2 GiB. An operator override of the aggregate
 * ceiling must not pass this value minus the documented reserve.
 */
export const MIN_HOST_PROCESS_MEMORY_BYTES_FOR_DUPLEX = 2 * 1024 * 1024 * 1024;

/**
 * The closed set of owner labels a reservation token can carry. Each label names
 * one host-side representation that retains bytes. The ledger accepts no label
 * outside this set, so no arbitrary label ever reaches a token.
 *
 *   - `pre_bind_event`: a held pre-bind duplex event, before route bind.
 *   - `buffered_chunk`: a buffered data chunk retained for a late listener.
 *   - `terminal_buffered`: a buffered chunk moved to the terminal registry at
 *     route terminalization, held for a late listener drain.
 *   - `request_frame`: a bounded raw request frame the broker retains at dispatch.
 *   - `request_payload`: a normalized request payload the broker retains at dispatch.
 *   - `response_body`: a response-body chunk or replacement buffer the reader retains.
 *   - `seen_request_id`: one entry of the broker no-replay request-id set.
 *   - `decoder_buffer`: the raw partial-frame bytes the host frame decoder retains
 *     between chunks, plus the peak replacement buffer it allocates on concat.
 *   - `readiness_buffer`: the raw untrusted bytes the readiness gate retains before
 *     the READY frame completes, before the broker binds and the decoder takes over.
 *   - `readiness_replay`: the post-READY suffix bytes the readiness gate holds in the
 *     pending replay buffer, from the READY accept until the broker binds and the
 *     frame decoder charges its own retention. This is a separate retention from
 *     `readiness_buffer`: the gate drops the whole pre-READY buffer on READY, then
 *     charges only the retained suffix and each later pre-bind chunk under this owner.
 *   - `pending_write`: the raw host-to-worker write payload a pending duplex write
 *     RPC retains, from the enqueue seam until the RPC settles.
 *   - `stdin_write`: the serialized host-to-worker frame the child-stdin transport
 *     buffer retains, from the write until the stream flushes the chunk, the stream
 *     errors, the stream closes, or the worker exits. This is a separate retention
 *     from `pending_write`: the RPC holds the raw payload while the transport buffer
 *     holds the larger serialized frame, so the two tokens cover the peak of both.
 */
export const DUPLEX_AGGREGATE_TOKEN_OWNERS = [
  "pre_bind_event",
  "buffered_chunk",
  "terminal_buffered",
  "request_frame",
  "request_payload",
  "response_body",
  "seen_request_id",
  "decoder_buffer",
  "readiness_buffer",
  "readiness_replay",
  "pending_write",
  "stdin_write",
] as const;

/** One owner label from the closed {@link DUPLEX_AGGREGATE_TOKEN_OWNERS} set. */
export type DuplexAggregateTokenOwner = (typeof DUPLEX_AGGREGATE_TOKEN_OWNERS)[number];

/** The one-way lifecycle state of a reservation token. */
export type DuplexReservationTokenState = "held" | "released";

/**
 * An opaque reservation token. The byte amount is immutable. The owner label
 * moves through the closed enum by transfer only. The state moves one way, from
 * `held` to `released`. A caller reads these fields but never mutates them; only
 * the owning ledger changes the owner and the state.
 */
export interface ReservationToken {
  /** The immutable exact byte amount this token reserves. */
  readonly bytes: number;
  /** The current owner label. The ledger changes it only through `transfer`. */
  readonly owner: DuplexAggregateTokenOwner;
  /** The one-way lifecycle state. The ledger sets it to `released` one time. */
  readonly state: DuplexReservationTokenState;
}

/**
 * The internal mutable token. The ledger owns it and returns it typed as the
 * read-only {@link ReservationToken}. Only code in this module changes the owner
 * or the state.
 */
class ReservationTokenImpl implements ReservationToken {
  readonly bytes: number;
  owner: DuplexAggregateTokenOwner;
  state: DuplexReservationTokenState = "held";

  constructor(bytes: number, owner: DuplexAggregateTokenOwner) {
    this.bytes = bytes;
    this.owner = owner;
  }
}

/**
 * The fixed telemetry surface for the aggregate byte ledger. The host binds it to
 * the closed duplex telemetry contract. Each record uses only fixed constant
 * dimensions. No company, agent, run, route, URL, header, request id, token, byte
 * payload, or raw provider value ever reaches a record. The default is a no-op.
 */
export interface DuplexAggregateByteLedgerTelemetry {
  /** Set the aggregate-bytes-in-use gauge to the current value. */
  setBytesInUse(bytes: number): void;
  /** Increment the reservation-rejection counter one time. */
  recordReservationRejection(): void;
  /** Increment the accounting-underflow counter one time. */
  recordAccountingUnderflow(): void;
}

/** A no-op telemetry surface. Every method does nothing, so the ledger stays inert. */
export const NOOP_DUPLEX_AGGREGATE_BYTE_LEDGER_TELEMETRY: DuplexAggregateByteLedgerTelemetry = {
  setBytesInUse() {},
  recordReservationRejection() {},
  recordAccountingUnderflow() {},
};

/**
 * The low-level process metric sink the host binds. It carries the fixed metric
 * name and the value only, so no dynamic dimension reaches a sink. The host maps
 * the gauge and the two counters to the process metric pipeline and to a warn log
 * for a defect.
 */
export interface DuplexAggregateByteLedgerMetricSink {
  /** Set a named process gauge to a value. */
  setGauge(name: string, value: number): void;
  /** Increment a named process counter one time. */
  incrementCounter(name: string): void;
}

/**
 * Build a {@link DuplexAggregateByteLedgerTelemetry} that maps each ledger event
 * to the fixed metric name on the process metric sink. The gauge uses
 * {@link DUPLEX_GAUGE_AGGREGATE_BYTES_IN_USE}. The rejection counter uses
 * {@link DUPLEX_COUNTER_AGGREGATE_BYTE_RESERVATION_REJECTIONS_TOTAL}. The defect
 * counter uses {@link DUPLEX_COUNTER_AGGREGATE_BYTE_ACCOUNTING_UNDERFLOW_TOTAL}.
 * Each call sits in an error swallow, so a sink failure never breaks the reserve
 * or the release path.
 */
export function createDuplexAggregateByteLedgerTelemetry(
  sink: DuplexAggregateByteLedgerMetricSink,
): DuplexAggregateByteLedgerTelemetry {
  return {
    setBytesInUse(bytes: number): void {
      try {
        sink.setGauge(DUPLEX_GAUGE_AGGREGATE_BYTES_IN_USE, bytes);
      } catch {
        // A telemetry failure never breaks the reserve or the release path.
      }
    },
    recordReservationRejection(): void {
      try {
        sink.incrementCounter(DUPLEX_COUNTER_AGGREGATE_BYTE_RESERVATION_REJECTIONS_TOTAL);
      } catch {
        // A telemetry failure never breaks the reserve path.
      }
    },
    recordAccountingUnderflow(): void {
      try {
        sink.incrementCounter(DUPLEX_COUNTER_AGGREGATE_BYTE_ACCOUNTING_UNDERFLOW_TOTAL);
      } catch {
        // A telemetry failure never breaks the release path.
      }
    },
  };
}

/** The options for {@link DuplexAggregateByteLedger}. */
export interface DuplexAggregateByteLedgerOptions {
  /** The aggregate ceiling, in bytes. It must be a positive safe integer. */
  ceilingBytes: number;
  /** The fixed telemetry surface. The default is the no-op surface. */
  telemetry?: DuplexAggregateByteLedgerTelemetry;
}

/**
 * Assert an aggregate ceiling byte value. The value must be a positive safe
 * integer that is no larger than the documented process allocation minus the
 * documented reserve. The function throws on any other value, so an invalid
 * ceiling fails startup instead of silently disabling the ledger.
 *
 * The reserve equals the documented process allocation minus the default
 * ceiling ({@link DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES}), so the maximum
 * accepted ceiling is exactly the documented process allocation minus that
 * reserve.
 */
export function assertDuplexAggregateCeilingBytes(value: number): void {
  const maxCeiling = maxDuplexAggregateCeilingBytes();
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `The duplex aggregate byte ceiling must be a positive safe integer; got ${String(value)}.`,
    );
  }
  if (value > maxCeiling) {
    throw new Error(
      `The duplex aggregate byte ceiling ${value} must not pass the documented process allocation minus the reserve (${maxCeiling}).`,
    );
  }
}

/**
 * The maximum accepted aggregate ceiling, in bytes: the documented process
 * allocation minus the documented reserve. Both {@link assertDuplexAggregateCeilingBytes}
 * and {@link isValidDuplexAggregateCeilingBytes} read this one bound.
 */
function maxDuplexAggregateCeilingBytes(): number {
  return MIN_HOST_PROCESS_MEMORY_BYTES_FOR_DUPLEX - DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES;
}

/**
 * Report whether `value` is a valid aggregate ceiling. A valid ceiling is a
 * positive safe integer that is no larger than {@link maxDuplexAggregateCeilingBytes}.
 * This is the non-throwing form of {@link assertDuplexAggregateCeilingBytes}. The
 * override resolver uses it to reject an invalid override without a throw.
 */
export function isValidDuplexAggregateCeilingBytes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maxDuplexAggregateCeilingBytes();
}

/**
 * A reporter the host binds to receive one invalid-override rejection signal.
 * {@link resolveDuplexAggregateCeilingBytes} calls it one time when it rejects a
 * present invalid override and falls back to the safe default. The signal carries
 * only the rejected numeric value. It carries no route, company, run, or payload
 * value.
 */
export type DuplexAggregateCeilingOverrideRejectionReporter = (rejectedValue: number) => void;

/**
 * Resolve an aggregate ceiling from an optional operator override. A missing or
 * `null` override uses {@link DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES}. A present
 * valid value passes through unchanged.
 *
 * A present invalid override does not fail host startup. The host process is
 * multi-tenant, so one invalid environment value must not brick the whole host.
 * The resolver rejects the invalid override, reports it through the optional
 * `onRejectedOverride` reporter, and returns the conservative safe default. This
 * fails loud without failing closed on availability.
 */
export function resolveDuplexAggregateCeilingBytes(
  override?: number | null,
  onRejectedOverride?: DuplexAggregateCeilingOverrideRejectionReporter,
): number {
  if (override === undefined || override === null) {
    return DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES;
  }
  if (!isValidDuplexAggregateCeilingBytes(override)) {
    onRejectedOverride?.(override);
    return DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES;
  }
  return override;
}

/**
 * The process-owned aggregate byte ledger. Create one per host server process.
 * Inject the same object into every host-side retention site, so one shared gauge
 * bounds the aggregate retained bytes across all live duplex routes.
 */
export class DuplexAggregateByteLedger {
  private readonly ceiling: number;
  private readonly telemetry: DuplexAggregateByteLedgerTelemetry;
  private used = 0;
  /** The owner registry. It holds every live token. */
  private readonly liveTokens = new Set<ReservationTokenImpl>();

  constructor(options: DuplexAggregateByteLedgerOptions) {
    assertDuplexAggregateCeilingBytes(options.ceilingBytes);
    this.ceiling = options.ceilingBytes;
    this.telemetry = options.telemetry ?? NOOP_DUPLEX_AGGREGATE_BYTE_LEDGER_TELEMETRY;
  }

  /** The configured aggregate ceiling, in bytes. */
  get ceilingBytes(): number {
    return this.ceiling;
  }

  /** The current aggregate bytes in use across every live token. */
  get bytesInUse(): number {
    return this.used;
  }

  /** The current number of live tokens in the owner registry. */
  get liveTokenCount(): number {
    return this.liveTokens.size;
  }

  /**
   * Reserve `bytes` for `owner`. Check and increment the gauge synchronously
   * before the caller allocates. Return a held token when the reservation fits
   * under the ceiling. Return `null` when `used + bytes` would pass the ceiling;
   * the caller retains nothing and reports
   * {@link DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED}.
   *
   * The byte amount must be a non-negative safe integer. A caller that passes any
   * other value made a programming error, so the ledger throws and fails loud.
   */
  reserve(owner: DuplexAggregateTokenOwner, bytes: number): ReservationToken | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(
        `A duplex byte reservation must be a non-negative safe integer; got ${String(bytes)}.`,
      );
    }
    if (this.used + bytes > this.ceiling) {
      this.telemetry.recordReservationRejection();
      return null;
    }
    this.used += bytes;
    const token = new ReservationTokenImpl(bytes, owner);
    this.liveTokens.add(token);
    this.telemetry.setBytesInUse(this.used);
    return token;
  }

  /**
   * Transfer a held token to a new owner label. Change only the owner. Never
   * decrement and never re-reserve. This is the atomic pre-bind handoff: it moves
   * the same reserved bytes from one representation to the next with no admission
   * gap.
   *
   * A transfer of a token the ledger does not hold, or of an already-released
   * token, is an accounting defect. The ledger records the fixed underflow
   * counter and leaves the gauge unchanged.
   */
  transfer(token: ReservationToken, owner: DuplexAggregateTokenOwner): void {
    const impl = token as ReservationTokenImpl;
    if (impl.state !== "held" || !this.liveTokens.has(impl)) {
      this.telemetry.recordAccountingUnderflow();
      return;
    }
    impl.owner = owner;
  }

  /**
   * Release a held token. Remove it from the owner registry, mark it `released`,
   * and decrement the gauge, all in one synchronous critical section before any
   * `await` or external callback. A token releases one time.
   *
   * A second release of the same token, or a release of a token the ledger does
   * not hold, is an accounting defect. The ledger records the fixed underflow
   * counter and does not clamp the gauge a second time, so a real defect stays
   * visible on the counter.
   */
  release(token: ReservationToken): void {
    const impl = token as ReservationTokenImpl;
    if (impl.state === "released" || !this.liveTokens.delete(impl)) {
      this.telemetry.recordAccountingUnderflow();
      return;
    }
    impl.state = "released";
    this.used -= impl.bytes;
    this.telemetry.setBytesInUse(this.used);
  }
}
