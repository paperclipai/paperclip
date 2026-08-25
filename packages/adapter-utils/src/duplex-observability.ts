/**
 * The fixed observability surface for the sandbox duplex transport.
 *
 * This module owns the one closed contract for every duplex telemetry sink: the
 * span names, the counter names, the one event name, the dimension keys, and the
 * enum values. Each name and value is a literal constant here, so the surface
 * never drifts and a test asserts the exact set.
 *
 * The module also owns the provider allowlist. The `provider` dimension carries
 * one approved public value, `daytona`. Any other plugin key maps to the constant
 * `other`. The map runs inside this module before every sink, so a raw plugin key
 * never reaches a span attribute, a counter label, or an event field.
 *
 * The module stays free of `@opentelemetry/api` and of the database. The host
 * injects a {@link DuplexObservabilityRecorder}; the default is a no-op recorder, so
 * the whole surface stays inert until the host binds a real recorder. Every
 * recorder call sits inside an error swallow, so a telemetry failure never breaks
 * the request path.
 */

/** The span for one duplex channel-open attempt. */
export const DUPLEX_SPAN_CHANNEL_OPEN = "sandbox.duplex.channel_open";
/** The span for one duplex request. It carries the request latency. */
export const DUPLEX_SPAN_REQUEST = "sandbox.duplex.request";

/** The one duplex transport event. The host emits it at each transport boundary. */
export const DUPLEX_TRANSPORT_EVENT = "sandbox.duplex.transport";

/** The guarded counter for one successful channel open. */
export const DUPLEX_COUNTER_CHANNEL_OPEN_TOTAL = "sandbox_duplex_channel_open_total";
/** The guarded counter for one fallback to the file bridge. */
export const DUPLEX_COUNTER_FALLBACK_TOTAL = "sandbox_duplex_fallback_total";
/** The guarded counter for one terminal channel loss. */
export const DUPLEX_COUNTER_LOSS_TOTAL = "sandbox_duplex_loss_total";
/** The guarded counter for one leaked provider session on teardown. */
export const DUPLEX_COUNTER_SESSION_LEAK_TOTAL = "sandbox_duplex_session_leak_total";

/**
 * The process-scoped gauge for the aggregate retained bytes across every live
 * duplex route. The host aggregate byte ledger sets it on each reserve and each
 * release. The record carries no dynamic dimension.
 */
export const DUPLEX_GAUGE_AGGREGATE_BYTES_IN_USE = "sandbox_duplex_aggregate_bytes_in_use";
/**
 * The counter for one rejected aggregate byte reservation. The host ledger
 * increments it when a reservation would pass the aggregate ceiling. The record
 * carries no dynamic dimension.
 */
export const DUPLEX_COUNTER_AGGREGATE_BYTE_RESERVATION_REJECTIONS_TOTAL =
  "sandbox_duplex_aggregate_byte_reservation_rejections_total";
/**
 * The counter for one aggregate byte accounting defect. The host ledger
 * increments it on a double release or a transfer of a token it does not hold.
 * The record carries no dynamic dimension.
 */
export const DUPLEX_COUNTER_AGGREGATE_BYTE_ACCOUNTING_UNDERFLOW_TOTAL =
  "sandbox_duplex_aggregate_byte_accounting_underflow_total";

/**
 * The closed set of aggregate byte ledger metric names. A test pins this exact
 * set, so a new ledger metric name needs an explicit review. Each record uses
 * only closed constant dimensions and no dynamic label. The Observability
 * contract documents these metrics under "Aggregate byte ledger metrics" in
 * `doc/observability.md`.
 */
export const DUPLEX_AGGREGATE_BYTE_LEDGER_METRIC_NAMES = [
  DUPLEX_GAUGE_AGGREGATE_BYTES_IN_USE,
  DUPLEX_COUNTER_AGGREGATE_BYTE_RESERVATION_REJECTIONS_TOTAL,
  DUPLEX_COUNTER_AGGREGATE_BYTE_ACCOUNTING_UNDERFLOW_TOTAL,
] as const;

/**
 * The closed dimension-key set. Every span attribute, counter label, and event
 * field uses only these keys. A test asserts the exact set, so a new key never
 * reaches a sink by accident.
 */
export const DUPLEX_DIMENSION_KEYS = [
  "provider",
  "transport",
  "outcome",
  "fallback_reason",
  "loss_class",
  "loss_reason",
] as const;

/** One dimension key from the closed set. */
export type DuplexDimensionKey = (typeof DUPLEX_DIMENSION_KEYS)[number];

/**
 * The transport a record is about. `duplex` names the retired bespoke frame
 * protocol; `http2` names the Node HTTP/2 session over the sandbox channel;
 * `file` names the queue-file bridge.
 */
export type DuplexTransportValue = "duplex" | "http2" | "file";

/** The outcome of a record. */
export type DuplexOutcomeValue = "ok" | "error";

/**
 * The reason the host selected the file bridge instead of the duplex transport.
 * The open-failure stage is split, so a reader groups a failed open by the exact
 * stage: the process-scoped route ceiling was full (`route_busy`), the entrypoint
 * sync failed (`entrypoint_sync_failed`), the broker construction failed
 * (`broker_construction_failed`), or the channel open failed (`channel_open_failed`).
 * The `aggregate_bytes_exceeded` reason names a readiness handshake, or an
 * `http2` post-preface pre-bind buffer, the host fell back because the
 * process aggregate byte ceiling had no room. The `preface_missing` reason
 * names a missing or an invalid HTTP/2 client connection preface inside the
 * bounded readiness buffer: the host found no valid preface after the
 * accepted READY line, aborted the HTTP/2 open, and moved the run to
 * `queue_v1` one time.
 */
export type DuplexFallbackReason =
  | "gate_off"
  | "capability_absent"
  | "route_busy"
  | "entrypoint_sync_failed"
  | "broker_construction_failed"
  | "channel_open_failed"
  | "ready_invalid"
  | "ready_nonce_mismatch"
  | "ready_timeout"
  | "contaminated"
  | "aggregate_bytes_exceeded"
  | "preface_missing";

/** The class of a terminal loss, relative to the first request dispatch. */
export type DuplexLossClass = "pre_dispatch" | "post_dispatch";

/**
 * The closed, typed reason for a terminal channel loss. The host maps every loss
 * cause to one of these values before any sink reads it. The set covers the
 * loss-detection modes the transport names: a gateway stdin end of file, a
 * provider process exit, a heartbeat timeout, and an RPC failure. It adds
 * `write_error` for a rejected host-to-sandbox write, `transport_closed` for a
 * reason-less provider transport close with no exit data, and `other` for an
 * unknown cause. The host maps an unknown cause or any caught provider text to
 * `other`, so no raw provider text reaches a sink.
 */
export const DUPLEX_LOSS_REASONS = [
  "stdin_eof",
  "provider_exit",
  "heartbeat_timeout",
  "rpc_failure",
  "write_error",
  "transport_closed",
  "other",
] as const;

/** One typed loss reason from the closed set. */
export type DuplexLossReason = (typeof DUPLEX_LOSS_REASONS)[number];

/** The host-owned closed loss-reason set. It backs {@link normalizeDuplexLossReason}. */
const LOSS_REASONS: ReadonlySet<string> = new Set<string>(DUPLEX_LOSS_REASONS);

/**
 * Map a raw loss-cause value to the closed {@link DuplexLossReason} set. Return
 * the value when the closed set holds it. Return `other` for any other value or a
 * missing value, so a raw provider string never reaches a sink.
 */
export function normalizeDuplexLossReason(value: string | null | undefined): DuplexLossReason {
  return typeof value === "string" && LOSS_REASONS.has(value)
    ? (value as DuplexLossReason)
    : "other";
}

/**
 * The closed set of HTTP/2 session and stream event names the host maps to a
 * loss reason. Each name spells one distinct signal the `http2_v1` transport
 * can observe: a session-level protocol fault, a peer GOAWAY, a stalled PING
 * watchdog, a rejected host-to-sandbox write, a reason-less transport close,
 * or the pseudo-terminal channel process exit.
 */
export const HTTP2_TELEMETRY_EVENT_NAMES = [
  "session_error",
  "session_goaway",
  "session_stall",
  "write_error",
  "transport_closed",
  "channel_exit",
] as const;

/** One event name from the closed HTTP/2 event set. */
export type Http2TelemetryEventName = (typeof HTTP2_TELEMETRY_EVENT_NAMES)[number];

/** The host-owned closed HTTP/2 event-name set. It backs {@link mapHttp2EventToDuplexLossReason}. */
const HTTP2_EVENT_NAMES: ReadonlySet<string> = new Set<string>(HTTP2_TELEMETRY_EVENT_NAMES);

/**
 * The map from one closed HTTP/2 event name to the existing, closed
 * {@link DuplexLossReason} taxonomy. The map reuses that one taxonomy instead
 * of a second, HTTP/2-only reason list, so the closed-set pattern stays one
 * set of values across every transport.
 */
const HTTP2_EVENT_TO_LOSS_REASON: Readonly<Record<Http2TelemetryEventName, DuplexLossReason>> = {
  session_error: "rpc_failure",
  session_goaway: "transport_closed",
  session_stall: "heartbeat_timeout",
  write_error: "write_error",
  transport_closed: "transport_closed",
  channel_exit: "provider_exit",
};

/**
 * Map one HTTP/2 session or stream event name to the closed
 * {@link DuplexLossReason} taxonomy (accepted security fix 7). Return the
 * mapped reason when the closed event-name set holds the value. Return
 * `other` for any other value or a missing value, so an unknown event name or
 * a raw provider string never reaches a sink.
 */
export function mapHttp2EventToDuplexLossReason(
  event: string | null | undefined,
): DuplexLossReason {
  return typeof event === "string" && HTTP2_EVENT_NAMES.has(event)
    ? HTTP2_EVENT_TO_LOSS_REASON[event as Http2TelemetryEventName]
    : "other";
}

/** The one approved public provider value. */
export const DUPLEX_APPROVED_PROVIDER = "daytona";
/** The constant for any provider key outside the allowlist. */
export const DUPLEX_PROVIDER_OTHER = "other";

/** The `provider` dimension value after the allowlist map. */
export type DuplexProviderValue = typeof DUPLEX_APPROVED_PROVIDER | typeof DUPLEX_PROVIDER_OTHER;

/** The host-owned closed provider allowlist. It holds one approved public value. */
const APPROVED_PROVIDERS: ReadonlySet<string> = new Set<string>([DUPLEX_APPROVED_PROVIDER]);

/**
 * Map a raw provider key to the closed `provider` dimension value. Return the key
 * when the allowlist holds it. Return `other` for any other value, so a raw
 * plugin key never reaches a sink. A missing key also maps to `other`.
 */
export function normalizeDuplexProvider(key: string | null | undefined): DuplexProviderValue {
  return typeof key === "string" && APPROVED_PROVIDERS.has(key)
    ? (key as DuplexProviderValue)
    : DUPLEX_PROVIDER_OTHER;
}

/**
 * The dimension bag a sink reads. Only the closed keys appear. The optional keys
 * are present only when the record defines them, so a span or a counter never
 * carries an empty dimension.
 */
export interface DuplexObservabilityDimensions {
  provider: DuplexProviderValue;
  transport: DuplexTransportValue;
  outcome?: DuplexOutcomeValue;
  fallback_reason?: DuplexFallbackReason;
  loss_class?: DuplexLossClass;
  loss_reason?: DuplexLossReason;
}

/** One span record the host records. The request span carries a latency. */
export interface DuplexObservabilitySpanRecord {
  name: string;
  dimensions: DuplexObservabilityDimensions;
  /** The request latency in milliseconds. Only the request span sets it. */
  latencyMs?: number;
}

/** One counter increment the host records. */
export interface DuplexObservabilityCounterRecord {
  metric: string;
  dimensions: DuplexObservabilityDimensions;
}

/** One event the host emits. */
export interface DuplexObservabilityEventRecord {
  name: string;
  dimensions: DuplexObservabilityDimensions;
}

/**
 * The injected low-level recorder. The host binds it to the existing telemetry
 * pipeline: the span to the OTel tracer, the counter to the guarded counter
 * store, and the event to the run-events bridge. The default is a no-op recorder.
 * The recorder receives only already-mapped dimensions, so the raw provider key
 * never reaches it.
 */
export interface DuplexObservabilityRecorder {
  recordSpan(record: DuplexObservabilitySpanRecord): void;
  incrementCounter(record: DuplexObservabilityCounterRecord): void;
  emitEvent(record: DuplexObservabilityEventRecord): void;
}

/** A no-op recorder. Every method does nothing, so the surface stays inert. */
export const NOOP_DUPLEX_OBSERVABILITY_RECORDER: DuplexObservabilityRecorder = {
  recordSpan() {},
  incrementCounter() {},
  emitEvent() {},
};

/** One channel-open attempt. The caller reports exactly one terminal. */
export interface DuplexChannelOpenAttempt {
  /**
   * The channel opened and readiness passed. Record the channel-open span with
   * the `ok` outcome, increment the channel-open counter, and emit the transport
   * event for the duplex transport.
   */
  ready(): void;
  /**
   * The channel did not open or readiness failed. Record the channel-open span
   * with the `error` outcome, increment the fallback counter, and emit the
   * transport event for the file bridge.
   */
  fallback(reason: DuplexFallbackReason): void;
}

/**
 * The bound telemetry facade the call sites use. It carries the normalized
 * provider, so a call site never passes a raw key. It maps each semantic event to
 * the fixed names and dimensions, then calls the recorder inside an error swallow.
 */
export interface DuplexObservability {
  /** Begin a channel-open attempt. The caller reports `ready` or `fallback`. */
  startChannelOpen(): DuplexChannelOpenAttempt;
  /**
   * Record a fallback to the file bridge with no channel-open attempt. Use it for
   * `gate_off` and `capability_absent`, where the host opens no channel.
   */
  recordFallback(reason: DuplexFallbackReason): void;
  /** Record one duplex request span with its latency and outcome. */
  recordRequest(record: { latencyMs: number; outcome: DuplexOutcomeValue }): void;
  /**
   * Record one terminal channel loss. The caller passes the loss class and the
   * typed, closed loss reason. The loss counter and the transport loss event carry
   * both dimensions. No raw provider text rides either sink.
   */
  recordLoss(lossClass: DuplexLossClass, lossReason: DuplexLossReason): void;
  /** Record one leaked provider session on teardown. */
  recordSessionLeak(): void;
}

/** The options for {@link createDuplexObservability}. */
export interface DuplexObservabilityOptions {
  /** The injected recorder. The default is the no-op recorder. */
  recorder?: DuplexObservabilityRecorder | null;
  /** The raw provider key. The facade maps it through the allowlist one time. */
  providerKey?: string | null;
  /**
   * The transport value the facade stamps on every non-file record (a channel
   * open, a request, a loss, a session leak). The default is `duplex`, so an
   * existing caller that names no transport sees no change. The host passes
   * `http2` for the `http2_v1` path.
   */
  transport?: DuplexTransportValue;
}

/**
 * Build the bound telemetry facade. The facade normalizes the provider key one
 * time, then reuses the mapped value for every record. Every recorder call sits
 * inside a `try/catch`, so a throwing recorder never breaks the request path. A
 * missing recorder yields a facade whose methods do nothing.
 */
export function createDuplexObservability(options: DuplexObservabilityOptions = {}): DuplexObservability {
  const recorder = options.recorder ?? NOOP_DUPLEX_OBSERVABILITY_RECORDER;
  const provider = normalizeDuplexProvider(options.providerKey);
  const transport: DuplexTransportValue = options.transport ?? "duplex";

  const safeSpan = (record: DuplexObservabilitySpanRecord): void => {
    try {
      recorder.recordSpan(record);
    } catch {
      // Observability must not break the request path.
    }
  };
  const safeCounter = (record: DuplexObservabilityCounterRecord): void => {
    try {
      recorder.incrementCounter(record);
    } catch {
      // Observability must not break the request path.
    }
  };
  const safeEvent = (record: DuplexObservabilityEventRecord): void => {
    try {
      recorder.emitEvent(record);
    } catch {
      // Observability must not break the request path.
    }
  };

  const recordFallback = (reason: DuplexFallbackReason): void => {
    const dimensions: DuplexObservabilityDimensions = {
      provider,
      transport: "file",
      outcome: "error",
      fallback_reason: reason,
    };
    safeCounter({ metric: DUPLEX_COUNTER_FALLBACK_TOTAL, dimensions });
    safeEvent({ name: DUPLEX_TRANSPORT_EVENT, dimensions });
  };

  return {
    startChannelOpen(): DuplexChannelOpenAttempt {
      let settled = false;
      return {
        ready(): void {
          if (settled) return;
          settled = true;
          const dimensions: DuplexObservabilityDimensions = {
            provider,
            transport,
            outcome: "ok",
          };
          safeSpan({ name: DUPLEX_SPAN_CHANNEL_OPEN, dimensions });
          safeCounter({ metric: DUPLEX_COUNTER_CHANNEL_OPEN_TOTAL, dimensions });
          safeEvent({ name: DUPLEX_TRANSPORT_EVENT, dimensions });
        },
        fallback(reason: DuplexFallbackReason): void {
          if (settled) return;
          settled = true;
          // The channel-open span records the failed attempt on the duplex
          // transport; the counter and the event record the file-bridge fallback.
          // The span carries `fallback_reason` on this fallback path only, so a
          // reader can group the failed opens by reason. `fallback_reason` is a
          // closed dimension key, so no new key reaches a sink.
          safeSpan({
            name: DUPLEX_SPAN_CHANNEL_OPEN,
            dimensions: { provider, transport, outcome: "error", fallback_reason: reason },
          });
          recordFallback(reason);
        },
      };
    },
    recordFallback,
    recordRequest(record: { latencyMs: number; outcome: DuplexOutcomeValue }): void {
      safeSpan({
        name: DUPLEX_SPAN_REQUEST,
        dimensions: { provider, transport, outcome: record.outcome },
        latencyMs: record.latencyMs,
      });
    },
    recordLoss(lossClass: DuplexLossClass, lossReason: DuplexLossReason): void {
      const dimensions: DuplexObservabilityDimensions = {
        provider,
        transport,
        outcome: "error",
        loss_class: lossClass,
        loss_reason: lossReason,
      };
      safeCounter({ metric: DUPLEX_COUNTER_LOSS_TOTAL, dimensions });
      safeEvent({ name: DUPLEX_TRANSPORT_EVENT, dimensions });
    },
    recordSessionLeak(): void {
      safeCounter({
        metric: DUPLEX_COUNTER_SESSION_LEAK_TOTAL,
        dimensions: { provider, transport, outcome: "error" },
      });
    },
  };
}
