import { describe, expect, it } from "vitest";

import {
  DUPLEX_COUNTER_CHANNEL_OPEN_TOTAL,
  DUPLEX_COUNTER_FALLBACK_TOTAL,
  DUPLEX_COUNTER_LOSS_TOTAL,
  DUPLEX_SPAN_CHANNEL_OPEN,
  DUPLEX_SPAN_REQUEST,
  DUPLEX_TRANSPORT_EVENT,
} from "@paperclipai/adapter-utils/duplex-telemetry";
import {
  createHostDuplexTelemetryRecorder,
  foldDuplexCounterMetric,
  type DuplexTelemetrySpan,
  type DuplexTelemetryTracer,
} from "../services/duplex-telemetry-recorder.js";

// A recording tracer that captures each span's name, attributes, and end time.
function createRecordingTracer(): {
  tracer: DuplexTelemetryTracer;
  spans: Array<{ name: string; startTime?: number; attributes: Record<string, string | number | boolean>; endTime?: number }>;
} {
  const spans: Array<{ name: string; startTime?: number; attributes: Record<string, string | number | boolean>; endTime?: number }> = [];
  const tracer: DuplexTelemetryTracer = {
    startSpan(name, options) {
      const record = { name, startTime: options?.startTime, attributes: {} as Record<string, string | number | boolean>, endTime: undefined as number | undefined };
      spans.push(record);
      const span: DuplexTelemetrySpan = {
        setAttribute(key, value) {
          record.attributes[key] = value;
        },
        end(endTime) {
          record.endTime = endTime;
        },
      };
      return span;
    },
  };
  return { tracer, spans };
}

describe("createHostDuplexTelemetryRecorder", () => {
  it("records the channel-open span with only the closed dimension keys", () => {
    const { tracer, spans } = createRecordingTracer();
    const recorder = createHostDuplexTelemetryRecorder({
      tracer,
      incrementCounter: () => {},
      emitTransportEvent: () => {},
      now: () => 1_000,
    });

    recorder.recordSpan({
      name: DUPLEX_SPAN_CHANNEL_OPEN,
      dimensions: { provider: "daytona", transport: "duplex", outcome: "ok" },
    });

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe(DUPLEX_SPAN_CHANNEL_OPEN);
    expect(spans[0].attributes).toEqual({ provider: "daytona", transport: "duplex", outcome: "ok" });
    // The channel-open span carries no latency, so it opens and ends at the same instant.
    expect(spans[0].startTime).toBe(1_000);
    expect(spans[0].endTime).toBe(1_000);
  });

  it("makes the request span duration equal the measured latency", () => {
    const { tracer, spans } = createRecordingTracer();
    const recorder = createHostDuplexTelemetryRecorder({
      tracer,
      incrementCounter: () => {},
      emitTransportEvent: () => {},
      now: () => 5_000,
    });

    recorder.recordSpan({
      name: DUPLEX_SPAN_REQUEST,
      dimensions: { provider: "other", transport: "duplex", outcome: "error" },
      latencyMs: 250,
    });

    expect(spans[0].startTime).toBe(4_750);
    expect(spans[0].endTime).toBe(5_000);
  });

  it("folds the discriminating dimension into the counter metric name", () => {
    expect(
      foldDuplexCounterMetric({
        metric: DUPLEX_COUNTER_CHANNEL_OPEN_TOTAL,
        dimensions: { provider: "daytona", transport: "duplex", outcome: "ok" },
      }),
    ).toBe(DUPLEX_COUNTER_CHANNEL_OPEN_TOTAL);
    expect(
      foldDuplexCounterMetric({
        metric: DUPLEX_COUNTER_FALLBACK_TOTAL,
        dimensions: { provider: "daytona", transport: "file", outcome: "error", fallback_reason: "gate_off" },
      }),
    ).toBe(`${DUPLEX_COUNTER_FALLBACK_TOTAL}.gate_off`);
    expect(
      foldDuplexCounterMetric({
        metric: DUPLEX_COUNTER_LOSS_TOTAL,
        dimensions: { provider: "daytona", transport: "duplex", outcome: "error", loss_class: "post_dispatch" },
      }),
    ).toBe(`${DUPLEX_COUNTER_LOSS_TOTAL}.post_dispatch`);
  });

  it("forwards the counter through the guarded sink with the folded metric", () => {
    const metrics: string[] = [];
    const recorder = createHostDuplexTelemetryRecorder({
      tracer: createRecordingTracer().tracer,
      incrementCounter: (metric) => metrics.push(metric),
      emitTransportEvent: () => {},
    });

    recorder.incrementCounter({
      metric: DUPLEX_COUNTER_FALLBACK_TOTAL,
      dimensions: { provider: "daytona", transport: "file", outcome: "error", fallback_reason: "ready_timeout" },
    });

    expect(metrics).toEqual([`${DUPLEX_COUNTER_FALLBACK_TOTAL}.ready_timeout`]);
  });

  it("forwards the transport event with its name and dimensions", () => {
    const events: Array<{ name: string; dimensions: Record<string, unknown> }> = [];
    const recorder = createHostDuplexTelemetryRecorder({
      tracer: createRecordingTracer().tracer,
      incrementCounter: () => {},
      emitTransportEvent: (event) => events.push(event),
    });

    recorder.emitEvent({
      name: DUPLEX_TRANSPORT_EVENT,
      dimensions: { provider: "daytona", transport: "duplex", outcome: "ok" },
    });

    expect(events).toEqual([
      { name: DUPLEX_TRANSPORT_EVENT, dimensions: { provider: "daytona", transport: "duplex", outcome: "ok" } },
    ]);
  });
});
