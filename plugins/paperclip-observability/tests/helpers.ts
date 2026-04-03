/**
 * Shared test helpers — mock OTel instruments and TelemetryContext factory.
 */
import { vi } from "vitest";
import type { Meter, Tracer, Span, SpanContext } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "../src/telemetry/router.js";

// ---------------------------------------------------------------------------
// Mock OTel instruments
// ---------------------------------------------------------------------------

export interface MockCounter {
  add: ReturnType<typeof vi.fn>;
}

export interface MockHistogram {
  record: ReturnType<typeof vi.fn>;
}

export function createMockCounter(): MockCounter {
  return { add: vi.fn() };
}

export function createMockHistogram(): MockHistogram {
  return { record: vi.fn() };
}

export function createMockMeter(): Meter & {
  _counters: Map<string, MockCounter>;
  _histograms: Map<string, MockHistogram>;
} {
  const counters = new Map<string, MockCounter>();
  const histograms = new Map<string, MockHistogram>();

  return {
    _counters: counters,
    _histograms: histograms,
    createCounter(name: string, _options?: unknown) {
      let c = counters.get(name);
      if (!c) {
        c = createMockCounter();
        counters.set(name, c);
      }
      return c as unknown as ReturnType<Meter["createCounter"]>;
    },
    createHistogram(name: string, _options?: unknown) {
      let h = histograms.get(name);
      if (!h) {
        h = createMockHistogram();
        histograms.set(name, h);
      }
      return h as unknown as ReturnType<Meter["createHistogram"]>;
    },
    createUpDownCounter: vi.fn() as unknown as Meter["createUpDownCounter"],
    createObservableGauge: vi.fn() as unknown as Meter["createObservableGauge"],
    createObservableCounter: vi.fn() as unknown as Meter["createObservableCounter"],
    createObservableUpDownCounter: vi.fn() as unknown as Meter["createObservableUpDownCounter"],
    createGauge: vi.fn() as unknown as Meter["createGauge"],
    addBatchObservableCallback: vi.fn() as unknown as Meter["addBatchObservableCallback"],
    removeBatchObservableCallback: vi.fn() as unknown as Meter["removeBatchObservableCallback"],
  } as unknown as Meter & {
    _counters: Map<string, MockCounter>;
    _histograms: Map<string, MockHistogram>;
  };
}

// ---------------------------------------------------------------------------
// Mock Span
// ---------------------------------------------------------------------------

export interface MockSpan extends Span {
  _attributes: Record<string, unknown>;
  _status: { code: number; message?: string };
  _ended: boolean;
  _events: Array<{ name: string; attributes?: Record<string, unknown> }>;
}

export function createMockSpan(traceId = "abc123", spanId = "def456"): MockSpan {
  const span: MockSpan = {
    _attributes: {},
    _status: { code: SpanStatusCode.UNSET },
    _ended: false,
    _events: [],
    spanContext() {
      return {
        traceId,
        spanId,
        traceFlags: 1,
        isRemote: false,
      } as SpanContext;
    },
    setAttribute(key: string, value: unknown) {
      span._attributes[key] = value;
      return span;
    },
    setAttributes(attrs: Record<string, unknown>) {
      Object.assign(span._attributes, attrs);
      return span;
    },
    setStatus(status: { code: number; message?: string }) {
      span._status = status;
      return span;
    },
    updateName(_name: string) {
      return span;
    },
    end() {
      span._ended = true;
    },
    isRecording() {
      return !span._ended;
    },
    recordException(exception: unknown) {
      span._events.push({
        name: "exception",
        attributes: {
          "exception.message":
            exception instanceof Error ? exception.message : String(exception),
        },
      });
      return span;
    },
    addEvent(name: string, attributes?: Record<string, unknown>) {
      span._events.push({ name, attributes });
      return span;
    },
    addLink() {
      return span;
    },
    addLinks() {
      return span;
    },
  } as unknown as MockSpan;
  return span;
}

// ---------------------------------------------------------------------------
// Mock Tracer
// ---------------------------------------------------------------------------

export function createMockTracer(): Tracer & { _lastSpan: MockSpan | null } {
  const tracer = {
    _lastSpan: null as MockSpan | null,
    startSpan(name: string, options?: unknown, _context?: unknown) {
      const span = createMockSpan();
      if (options && typeof options === "object" && "attributes" in options) {
        Object.assign(span._attributes, (options as { attributes: Record<string, unknown> }).attributes);
      }
      tracer._lastSpan = span;
      return span as unknown as Span;
    },
    startActiveSpan: vi.fn() as unknown as Tracer["startActiveSpan"],
  };
  return tracer as unknown as Tracer & { _lastSpan: MockSpan | null };
}

// ---------------------------------------------------------------------------
// Mock state client
// ---------------------------------------------------------------------------

export function createMockState() {
  const store = new Map<string, unknown>();

  function keyFor(input: { scopeKind: string; scopeId?: string; stateKey: string }) {
    return `${input.scopeKind}:${input.scopeId ?? ""}:${input.stateKey}`;
  }

  return {
    _store: store,
    get: vi.fn(async (input: { scopeKind: string; scopeId?: string; stateKey: string }) => {
      return store.get(keyFor(input)) ?? null;
    }),
    set: vi.fn(async (input: { scopeKind: string; scopeId?: string; stateKey: string }, value: unknown) => {
      store.set(keyFor(input), value);
    }),
    delete: vi.fn(async (input: { scopeKind: string; scopeId?: string; stateKey: string }) => {
      store.delete(keyFor(input));
    }),
  };
}

// ---------------------------------------------------------------------------
// TelemetryContext factory
// ---------------------------------------------------------------------------

export function createMockOtelLogger() {
  return {
    emit: vi.fn(),
  };
}

export function createTestTelemetryCtx(overrides: Partial<TelemetryContext> = {}) {
  const meter = createMockMeter();
  const tracer = createMockTracer();
  const state = createMockState();
  const otelLogger = createMockOtelLogger();

  return {
    ctx: {
      meter: meter as unknown as TelemetryContext["meter"],
      tracer: tracer as unknown as TelemetryContext["tracer"],
      state: state as unknown as TelemetryContext["state"],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as TelemetryContext["logger"],
      otelLogger: otelLogger as unknown as TelemetryContext["otelLogger"],
      activeRunSpans: new Map(),
      activeIssueSpans: new Map(),
      activeApprovalSpans: new Map(),
      activeSessionSpans: new Map(),
      getTracerForAgent(_agentId: string, _agentName: string) {
        return tracer as unknown as TelemetryContext["tracer"];
      },
      ...overrides,
    } as TelemetryContext,
    meter,
    tracer,
    state,
    otelLogger,
  };
}

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

export function makeEvent(
  eventType: string,
  payload: Record<string, unknown> = {},
  base: Partial<PluginEvent> = {},
): PluginEvent {
  return {
    eventId: `evt-${Date.now()}`,
    eventType: eventType as PluginEvent["eventType"],
    occurredAt: new Date().toISOString(),
    companyId: "company-test",
    payload,
    ...base,
  };
}
