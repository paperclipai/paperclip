import {
  DUPLEX_DIMENSION_KEYS,
  DUPLEX_SPAN_REQUEST,
  type DuplexTelemetryCounterRecord,
  type DuplexTelemetryDimensions,
  type DuplexTelemetryEventRecord,
  type DuplexTelemetryRecorder,
  type DuplexTelemetrySpanRecord,
} from "@paperclipai/adapter-utils/duplex-telemetry";

/**
 * The host binding for the fixed duplex telemetry surface. This module maps each
 * recorder call to a real host sink: the span to the OTel tracer, the counter to
 * the guarded counter store in `tool-runtime-metrics.ts`, and the transport event
 * to the run-event path. The mapping is the single boundary, so the closed
 * dimension keys and the counter folding stay in one place.
 *
 * The recorder never throws. The facade in `duplex-telemetry.ts` wraps each
 * synchronous call in a swallow, but an async sink can still reject after the
 * call returns. Each async sink here runs fire-and-forget with its own catch, so
 * a sink failure never breaks the request path.
 */

/** The minimal span the recorder opens. A real OTel span satisfies it; the
 * no-op tracer's span satisfies it too. */
export interface DuplexTelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): void;
  end(endTime?: number): void;
}

/** The minimal tracer surface the recorder calls. `getStartupTracer` returns a
 * real or a no-op implementation that satisfies it. The optional second argument
 * carries an explicit start time, so the request span duration equals the
 * measured latency. */
export interface DuplexTelemetryTracer {
  startSpan(name: string, options?: { startTime?: number }): DuplexTelemetrySpan;
}

export interface HostDuplexTelemetryRecorderInput {
  /** The OTel tracer for the two duplex spans. */
  tracer: DuplexTelemetryTracer;
  /**
   * Increment one guarded host counter by its metric name. The caller binds it
   * to `incrementToolRuntimeMetricCounter` with the company id, inside a swallow.
   */
  incrementCounter(metric: string): void;
  /**
   * Emit one transport event to the run-event path. The caller binds it to the
   * run-events bridge, inside a swallow.
   */
  emitTransportEvent(event: { name: string; dimensions: DuplexTelemetryDimensions }): void;
  /** The wall clock. The default is `Date.now`. Tests inject a fixed clock. */
  now?: () => number;
}

/**
 * Fold the discriminating dimension into the counter metric name. The guarded
 * counter store keys on `(companyId, metric)` with no label column, so the
 * fallback reason or the loss class rides the metric name to keep the analytic
 * breakdown. Both dimension sets are closed and low-cardinality, so the metric
 * cardinality stays bounded. A record with neither dimension uses the base name.
 */
export function foldDuplexCounterMetric(record: DuplexTelemetryCounterRecord): string {
  if (record.dimensions.fallback_reason) {
    return `${record.metric}.${record.dimensions.fallback_reason}`;
  }
  if (record.dimensions.loss_class) {
    return `${record.metric}.${record.dimensions.loss_class}`;
  }
  return record.metric;
}

/**
 * Build the host duplex telemetry recorder. The recorder receives only
 * already-mapped dimensions, so a raw provider key never reaches a sink. Every
 * span attribute uses only the closed dimension keys.
 */
export function createHostDuplexTelemetryRecorder(
  input: HostDuplexTelemetryRecorderInput,
): DuplexTelemetryRecorder {
  const now = input.now ?? Date.now;

  const setDimensionAttributes = (span: DuplexTelemetrySpan, dimensions: DuplexTelemetryDimensions): void => {
    for (const key of DUPLEX_DIMENSION_KEYS) {
      const value = dimensions[key];
      if (typeof value === "string") {
        span.setAttribute(key, value);
      }
    }
  };

  return {
    recordSpan(record: DuplexTelemetrySpanRecord): void {
      // The request span carries a latency, so start it in the past and end it
      // now, so the span duration equals the measured latency. The channel-open
      // span carries no latency, so it opens and ends at the same instant.
      const end = now();
      const latencyMs =
        record.name === DUPLEX_SPAN_REQUEST && typeof record.latencyMs === "number" && Number.isFinite(record.latencyMs)
          ? Math.max(0, record.latencyMs)
          : 0;
      const span = input.tracer.startSpan(record.name, { startTime: end - latencyMs });
      setDimensionAttributes(span, record.dimensions);
      span.end(end);
    },
    incrementCounter(record: DuplexTelemetryCounterRecord): void {
      input.incrementCounter(foldDuplexCounterMetric(record));
    },
    emitEvent(record: DuplexTelemetryEventRecord): void {
      input.emitTransportEvent({ name: record.name, dimensions: record.dimensions });
    },
  };
}
