import { context, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { AlwaysOffSampler, ParentBasedSampler, TracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNativeRunTrace } from "./native-run-trace.js";

beforeEach(() => vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test"));
afterEach(() => vi.unstubAllEnvs());

it.each([TraceFlags.NONE, TraceFlags.SAMPLED])("exports a complete native run independently of trigger flags %i", async traceFlags => {
  const manager = new AsyncLocalStorageContextManager().enable();
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  expect(context.setGlobalContextManager(manager)).toBe(true);
  expect(trace.setGlobalTracerProvider(provider)).toBe(true);
  const trigger = {
    traceId: "11111111111111111111111111111111", spanId: "2222222222222222", traceFlags, isRemote: true,
  };
  try {
    await context.with(trace.setSpanContext(context.active(), trigger), async () => {
      const native = createNativeRunTrace({ runId: "diagnostic-native-run" });
      await native.measure("native.session.execute", async () => undefined);
      await native.finish("ok");
      expect(trace.getActiveSpan()?.spanContext()).toEqual(trigger);
    });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.map(span => span.name).sort()).toEqual(["native.session.execute", "task.provider_session"]);
    const root = spans.find(span => span.name === "task.provider_session")!;
    const child = spans.find(span => span.name === "native.session.execute")!;
    expect(root.parentSpanContext).toBeUndefined();
    expect(root.links.map(link => link.context)).toEqual([trigger]);
    expect(root.spanContext().traceId).not.toBe(trigger.traceId);
    expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
  } finally {
    trace.disable(); context.disable(); manager.disable(); await provider.shutdown();
  }
});

it("honors an operator who disables root sampling despite a sampled trigger", async () => {
  const manager = new AsyncLocalStorageContextManager().enable();
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    sampler: new ParentBasedSampler({ root: new AlwaysOffSampler() }),
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  expect(context.setGlobalContextManager(manager)).toBe(true);
  expect(trace.setGlobalTracerProvider(provider)).toBe(true);
  try {
    await context.with(trace.setSpanContext(context.active(), {
      traceId: "11111111111111111111111111111111", spanId: "2222222222222222", traceFlags: TraceFlags.SAMPLED, isRemote: true,
    }), async () => {
      const native = createNativeRunTrace({ runId: "disabled-native-run" });
      await native.measure("native.session.execute", async () => undefined);
      await native.finish("ok");
    });
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()).toEqual([]);
  } finally {
    trace.disable(); context.disable(); manager.disable(); await provider.shutdown();
  }
});

it("stays silent without a tracer provider", async () => {
  trace.disable(); context.disable();
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const spies = methods.map(method => vi.spyOn(console, method));
  try {
    const native = createNativeRunTrace({ runId: "unconfigured-native-run" });
    const value = {};
    await expect(native.measure("native.session.execute", async () => value)).resolves.toBe(value);
    const error = new Error("original failure");
    await expect(native.measure("native.session.execute", async () => { throw error; })).rejects.toBe(error);
    await native.finish("ok");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { for (const spy of spies) spy.mockRestore(); }
});
