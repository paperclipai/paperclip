import { getActiveStepContext } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import { createHash } from "node:crypto";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStartupTraceContext, getStartupTracer } from "../instrumentation.js";
import { prepareVerifiedRemoteProviderPack } from "./native-runtime/remote-provider-pack.js";
import { createNativeRunTrace } from "./native-runtime/native-run-trace.js";
import { beginRunPhase, createRunPreparationTiming, getRunExecutionTraceContext, measureRunPhase, measureToolDiscovery, withRunExecutionTiming } from "./execution-preparation-timing.js";
import { createToolDiscoveryScheduler } from "./tool-discovery-scheduler.js";

let exporter: InMemorySpanExporter;
let provider: TracerProvider;
let manager: AsyncLocalStorageContextManager;
beforeEach(() => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  exporter = new InMemorySpanExporter();
  provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  manager = new AsyncLocalStorageContextManager().enable();
  expect(context.setGlobalContextManager(manager)).toBe(true);
  expect(trace.setGlobalTracerProvider(provider)).toBe(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  trace.disable();
  context.disable();
  manager.disable();
  await provider.shutdown();
});

it("parents overlapping preparation and response work to their own execution attempts independently of ingress sampling", async () => {
  const trigger = { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: TraceFlags.NONE, isRemote: true };
  const overlappingSpanIds = new Map<string, { source: string | undefined; readers: string | undefined }>();
  await context.with(trace.setSpanContext(context.active(), trigger), () => Promise.all(["one", "two"].map(runId =>
    withRunExecutionTiming(runId, async () => {
      let sourceSpan: ReturnType<typeof trace.getActiveSpan>, readersSpan: ReturnType<typeof trace.getActiveSpan>;
      let started!: () => void, checked!: () => void;
      const bothStarted = new Promise<void>(resolve => { started = resolve; });
      const bothChecked = new Promise<void>(resolve => { checked = resolve; });
      let arrivals = 0, observations = 0;
      const assertOverlap = async () => {
        if (++arrivals === 2) started();
        await bothStarted;
        try {
          expect(sourceSpan?.isRecording()).toBe(true);
          expect(readersSpan?.isRecording()).toBe(true);
        } finally {
          if (++observations === 2) checked();
        }
        await bothChecked;
      };
      await createRunPreparationTiming(runId)("workspace", () => Promise.all([
        measureRunPhase("workspace.sources", async () => {
          sourceSpan = trace.getActiveSpan();
          await assertOverlap();
          await measureRunPhase("workspace.sources.alias_scan", () => {
            const parent = getActiveStepContext()?.parentContext;
            expect(parent).toBeDefined();
            expect(trace.getSpan(parent as import("@opentelemetry/api").Context)?.spanContext()).toEqual(trace.getActiveSpan()?.spanContext());
            expect(getRunExecutionTraceContext(runId === "one" ? "two" : "one")).toBeUndefined();
          });
        }),
        measureRunPhase("workspace.readers", async () => {
          readersSpan = trace.getActiveSpan();
          await assertOverlap();
        }),
      ]));
      overlappingSpanIds.set(runId, { source: sourceSpan?.spanContext().spanId, readers: readersSpan?.spanContext().spanId });
      await measureRunPhase("response.add_comment", () => undefined);
    }),
  )));
  const spans = exporter.getFinishedSpans();
  const attempts = spans.filter(span => span.name === "task.execution_attempt");
  expect(attempts).toHaveLength(2);
  expect(new Set(attempts.map(span => span.spanContext().traceId)).size).toBe(2);
  for (const runId of ["one", "two"]) {
    const attempt = attempts.find(span => span.attributes["paperclip.task.run.run_id"] === createHash("sha256").update(runId).digest("hex").slice(0, 12))!;
    expect(attempt.parentSpanContext).toBeUndefined();
    expect(attempt.links[0].context).toEqual(trigger);
    const owned = spans.filter(span => span.spanContext().traceId === attempt.spanContext().traceId);
    const phase = owned.find(span => span.name === "heartbeat.prepare.workspace")!;
    const source = owned.find(span => span.name === "workspace.sources")!;
    const aliases = owned.find(span => span.name === "workspace.sources.alias_scan")!;
    const readers = owned.find(span => span.name === "workspace.readers")!;
    const reply = owned.find(span => span.name === "response.add_comment")!;
    expect(phase.parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
    expect(source.parentSpanContext?.spanId).toBe(phase.spanContext().spanId);
    expect(readers.parentSpanContext?.spanId).toBe(phase.spanContext().spanId);
    expect(aliases.parentSpanContext?.spanId).toBe(source.spanContext().spanId);
    expect(reply.parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
    expect(overlappingSpanIds.get(runId)).toEqual({ source: source.spanContext().spanId, readers: readers.spanContext().spanId });
    expect(owned).toHaveLength(6);
  }
  expect(getRunExecutionTraceContext("one")).toBeUndefined();
});

it("uses a link for a native session whose queue history predates the current attempt", async () => {
  await withRunExecutionTiming("native", async () => {
    const native = createNativeRunTrace({ runId: "native", startedAtMs: Date.now() - 10_000 });
    await native.measure("agent.turn", async () => {});
    await native.finish("ok");
    await measureRunPhase("response.add_comment", () => undefined);
  });
  const spans = exporter.getFinishedSpans();
  const attempt = spans.find(span => span.name === "task.execution_attempt")!;
  const session = spans.find(span => span.name === "task.provider_session")!;
  const response = spans.find(span => span.name === "response.add_comment")!;
  expect(session.parentSpanContext).toBeUndefined();
  expect(session.links.map(link => link.context.spanId)).toContain(attempt.spanContext().spanId);
  expect(response.parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
  expect(session.startTime[0]).toBeLessThan(attempt.startTime[0]);
});

it("keeps queued discovery under its initiating run when another run releases the slot", async () => {
  const scheduler = createToolDiscoveryScheduler(1, 1);
  let release!: () => void, started!: () => void, enqueued!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { enqueued = resolve; });
  const first = withRunExecutionTiming("discovery-owner", () => measureToolDiscovery(
    work => scheduler.run(work), async () => { started(); await gate; },
  ));
  await ready;
  const runHash = createHash("sha256").update("discovery-waiter").digest("hex").slice(0, 12);
  const value = {};
  const work = vi.fn(async () => {
    expect(getRunExecutionTraceContext("discovery-owner")).toBeUndefined();
    expect(getRunExecutionTraceContext("discovery-waiter")).toBeDefined();
    expect(exporter.getFinishedSpans().filter(span => span.name === "connectors.discovery.queue"
      && span.attributes["paperclip.task.run.run_id"] === runHash)).toHaveLength(1);
    await measureRunPhase("connectors.discovery.policy", () => undefined);
    return value;
  });
  const second = withRunExecutionTiming("discovery-waiter", () => measureToolDiscovery(
    work => { const pending = scheduler.run(work); enqueued(); return pending; }, work,
  ));
  await waiting;
  try {
    expect(work).not.toHaveBeenCalled();
    expect(exporter.getFinishedSpans().some(span => span.attributes["paperclip.task.run.run_id"] === runHash)).toBe(false);
  } finally {
    release();
    await first;
  }
  await expect(second).resolves.toBe(value);
  expect(work).toHaveBeenCalledOnce();
  const spans = exporter.getFinishedSpans();
  const owned = spans.filter(span => span.attributes["paperclip.task.run.run_id"] === runHash);
  const attempt = owned.find(span => span.name === "task.execution_attempt")!;
  const scheduled = owned.find(span => span.name === "connectors.discovery.scheduled")!;
  const build = owned.find(span => span.name === "connectors.discovery.build")!;
  const queue = owned.filter(span => span.name === "connectors.discovery.queue");
  expect(queue).toHaveLength(1);
  expect(owned).toHaveLength(5);
  expect(owned.every(span => span.spanContext().traceId === attempt.spanContext().traceId)).toBe(true);
  expect(scheduled.parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
  expect(build.parentSpanContext?.spanId).toBe(scheduled.spanContext().spanId);
  expect(queue[0].parentSpanContext?.spanId).toBe(scheduled.spanContext().spanId);
  expect(owned.find(span => span.name === "connectors.discovery.policy")?.parentSpanContext?.spanId).toBe(build.spanContext().spanId);
});

it("caps repeated detail spans and ends failed scopes without content or exception text", async () => {
  const failure = new Error("private path and credential");
  const work = vi.fn(() => undefined);
  await expect(withRunExecutionTiming("bounded", async () => {
    for (let index = 0; index < 100; index++) await measureRunPhase("workspace.readers.identity", work);
    for (let index = 0; index < 100; index++) beginRunPhase("workspace.transaction.entry")();
    await measureRunPhase("workspace.readers.trust", () => { throw failure; });
  })).rejects.toBe(failure);
  expect(work).toHaveBeenCalledTimes(100);
  const spans = exporter.getFinishedSpans();
  expect(spans.filter(span => span.name === "workspace.readers.identity")).toHaveLength(16);
  expect(spans.filter(span => span.name === "workspace.transaction.entry")).toHaveLength(16);
  for (const span of spans) expect(Object.keys(span.attributes)).toEqual(["paperclip.task.run.run_id"]);
  expect(spans.filter(span => span.status.code === 2).map(span => span.name).sort()).toEqual(["task.execution_attempt", "workspace.readers.trust"]);
  expect(JSON.stringify(spans.map(span => ({ attributes: span.attributes, events: span.events, status: span.status })))).not.toContain(failure.message);
  expect(getRunExecutionTraceContext("bounded")).toBeUndefined();
});

it.each([undefined, "", "  "])("does not consult tracers or warn without endpoint %s even with a registered provider", async endpoint => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
  const lookup = vi.spyOn(trace, "getTracer");
  const warnings = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
  await expect(withRunExecutionTiming("off", () => measureRunPhase("response.add_comment", () => 42))).resolves.toBe(42);
  getStartupTracer().startSpan("disabled").end();
  getStartupTraceContext().tracer.startSpan("disabled").end();
  const native = createNativeRunTrace({ runId: "off" });
  await native.measure("agent.turn", async () => undefined);
  await native.finish("ok");
  expect(lookup).not.toHaveBeenCalled();
  expect(exporter.getFinishedSpans()).toEqual([]);
  for (const warning of warnings) expect(warning).not.toHaveBeenCalled();
});

it.each(["staged", "preinstalled", "uploaded", "failed"] as const)("records provider-pack selection %s with closed source and fallback reasons", async source => {
  const failure = new Error("private manifest path and hash");
  const native = createNativeRunTrace({ runId: "pack" });
  const select = prepareVerifiedRemoteProviderPack({
    trace: native,
    verifyStaged: async () => { if (source !== "staged") throw failure; },
    usePreinstalled: async () => source === "preinstalled",
    stageAndVerify: async () => { if (source === "failed") throw failure; },
  });
  if (source === "failed") await expect(select).rejects.toBe(failure);
  else await expect(select).resolves.toBe(source);
  await native.finish(source === "failed" ? "failed" : "ok");
  const span = exporter.getFinishedSpans().find(span => span.name === "provider_pack.select")!;
  expect(span.status.code).toBe(source === "failed" ? 2 : 0);
  if (source !== "failed") expect(span.attributes["paperclip.native.span.stateSource"]).toBe(source);
  expect(JSON.stringify({ attributes: span.attributes, events: span.events })).not.toContain(failure.message);
});

it("exports only the declared count attributes and rejects unsafe numbers or extra fields", async () => {
  await withRunExecutionTiming("counts", async () => {
    await measureRunPhase("runtime_context.asset_materialize", () => undefined,
      { fileCount: 3, bytes: 99, privatePath: "/private/fixture" } as { fileCount: number; bytes: number });
    await measureRunPhase("runtime_context.asset_verify", () => undefined, { fileCount: -1, bytes: Infinity });
  });
  const spans = exporter.getFinishedSpans();
  const materialize = spans.find(span => span.name === "runtime_context.asset_materialize")!;
  expect(materialize.attributes).toEqual({
    "paperclip.task.run.run_id": createHash("sha256").update("counts").digest("hex").slice(0, 12),
    "paperclip.execution.fileCount": 3,
    "paperclip.execution.bytes": 99,
  });
  const verify = spans.find(span => span.name === "runtime_context.asset_verify")!;
  expect(Object.keys(verify.attributes)).toEqual(["paperclip.task.run.run_id"]);
});

it("does not inherit another run when a new attempt's tracer lookup fails", async () => {
  await withRunExecutionTiming("outer", async () => {
    const lookup = vi.spyOn(trace, "getTracer").mockImplementationOnce(() => { throw new Error("tracer unavailable"); });
    try {
      await withRunExecutionTiming("inner", () => measureRunPhase("workspace.sources", () => 42));
    } finally { lookup.mockRestore(); }
  });
  const spans = exporter.getFinishedSpans();
  const outer = spans.find(span => span.name === "task.execution_attempt")!;
  const inner = spans.find(span => span.name === "workspace.sources")!;
  expect(inner.parentSpanContext).toBeUndefined();
  expect(inner.spanContext().traceId).not.toBe(outer.spanContext().traceId);
  expect(inner.attributes["paperclip.task.run.run_id"]).toBe(createHash("sha256").update("inner").digest("hex").slice(0, 12));
});

it("does not attach native children to an ambient run when native context construction fails", async () => {
  await withRunExecutionTiming("ambient", async () => {
    const native = createNativeRunTrace({ runId: "native-context-failure", traceContext: {
      tracer: getStartupTracer("broken-native-context"),
      contextWithSpan() { throw new Error("context unavailable"); },
    } });
    await native.measure("agent.turn", async () => undefined);
    await native.finish("ok");
  });
  const spans = exporter.getFinishedSpans();
  const ambient = spans.find(span => span.name === "task.execution_attempt")!;
  const child = spans.find(span => span.name === "agent.turn")!;
  expect(child.parentSpanContext).toBeUndefined();
  expect(child.spanContext().traceId).not.toBe(ambient.spanContext().traceId);
});
