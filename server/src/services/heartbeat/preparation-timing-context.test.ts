import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { AlwaysOffSampler, ParentBasedSampler, TracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHeartbeatPreparationTiming } from "./preparation-timing.js";
import { createRunPreparationTiming } from "../execution-preparation-timing.js";

beforeEach(() => vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test"));
afterEach(() => vi.unstubAllEnvs());

it.each(["heartbeat.prepare", "native.controller"] as const)("keeps %s disabled without an endpoint when another library registers tracing", async scope => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", undefined);
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  expect(trace.setGlobalTracerProvider(provider)).toBe(true);
  const lookup = vi.spyOn(trace, "getTracer");
  try {
    await expect(createRunPreparationTiming("unconfigured-run", scope)("workspace", () => 42)).resolves.toBe(42);
    expect(lookup).not.toHaveBeenCalled();
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()).toEqual([]);
  } finally {
    lookup.mockRestore();
    trace.disable();
    await provider.shutdown();
  }
});

it.each([["heartbeat.prepare", TraceFlags.NONE], ["heartbeat.prepare", TraceFlags.SAMPLED], ["native.controller", TraceFlags.NONE], ["native.controller", TraceFlags.SAMPLED]] as const)("records %s independently of trigger flags %i and links back to it", async (scope, traceFlags) => {
  const phaseName = scope === "heartbeat.prepare" ? "workspace" : "backend_setup";
  const manager = new AsyncLocalStorageContextManager().enable();
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  expect(context.setGlobalContextManager(manager)).toBe(true);
  expect(trace.setGlobalTracerProvider(provider)).toBe(true);
  const trigger = {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    traceFlags,
    isRemote: true,
  };
  try {
    const result = {};
    await context.with(trace.setSpanContext(context.active(), trigger), async () => {
      await expect(createRunPreparationTiming("background-run", scope)(phaseName, async () => {
        await setImmediate();
        const child = trace.getTracer("preparation-context-test").startSpan("background.child");
        expect(child.isRecording()).toBe(true);
        child.end();
        return result;
      })).resolves.toBe(result);
      expect(trace.getActiveSpan()?.spanContext()).toEqual(trigger);
    });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const phase = spans.find(span => span.name === `${scope}.${phaseName}`)!;
    const child = spans.find(span => span.name === "background.child")!;
    expect(phase.parentSpanContext).toBeUndefined();
    expect(phase.links).toHaveLength(1);
    expect(phase.links[0].context).toEqual(trigger);
    expect(phase.spanContext().traceId).not.toBe(trigger.traceId);
    expect(child.parentSpanContext?.spanId).toBe(phase.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(phase.spanContext().traceId);
  } finally {
    trace.disable();
    context.disable();
    manager.disable();
    await provider.shutdown();
  }
});

it("honors an operator sampler that disables root traces even when the trigger is sampled", async () => {
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
      traceId: "11111111111111111111111111111111", spanId: "2222222222222222",
      traceFlags: TraceFlags.SAMPLED, isRemote: true,
    }), async () => {
      await createHeartbeatPreparationTiming("disabled-run")("instructions", async () => {
        expect(trace.getActiveSpan()?.isRecording()).toBe(false);
      });
    });
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()).toEqual([]);
  } finally {
    trace.disable();
    context.disable();
    manager.disable();
    await provider.shutdown();
  }
});

it.each(["workspace", "configuration_ai_runtime", "configuration_skills", "configuration_agent_identity", "workspace_source_resolution", "workspace_provision_policy", "workspace_base_validation", "workspace_source_authorization", "workspace_provision", "workspace_source_retention", "workspace_binding", "workspace_record_update", "workspace_record_create", "workspace_operation_binding", "workspace_config_recording", "workspace_repository_admission", "workspace_project_repositories", "workspace_recovery_root", "backend_setup", "assigned_mcp", "github_access", "wake_binding", "connector_assignments", "tool_authority", "companion_selection", "runner_binary", "github_stop", "coordinator_release", "instruction_checkpoint", "instruction_changes", "warm_release", "instruction_collection"] as const)("stays silent and preserves values and errors without a tracer provider for %s", async phase => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", undefined);
  trace.disable();
  context.disable();
  const messages = ["log", "info", "warn", "error", "debug"] as const;
  const spies = messages.map(method => vi.spyOn(console, method));
  try {
    const time = createHeartbeatPreparationTiming("unconfigured-run");
    const result = {};
    await expect(time(phase, async () => {
      expect(trace.getActiveSpan()?.isRecording()).not.toBe(true);
      return result;
    })).resolves.toBe(result);
    const error = new Error("original failure");
    await expect(time(phase, async () => { throw error; })).rejects.toBe(error);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

it("parents child spans to their own preparation phase across overlapping awaited runs", async () => {
  const manager = new AsyncLocalStorageContextManager().enable();
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  expect(context.setGlobalContextManager(manager)).toBe(true);
  expect(trace.setGlobalTracerProvider(provider)).toBe(true);
  try {
    const gates = [0, 1].map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>(release => { resolve = release; });
      return { promise, resolve };
    });
    const runs = ["first-run", "second-run"];
    const pending = runs.map((run, index) => createHeartbeatPreparationTiming(run)("workspace", async () => {
      await gates[index].promise;
      await setImmediate();
      const child = trace.getTracer("preparation-context-test").startSpan(`child.${run}`);
      await setImmediate();
      child.end();
    }));
    expect(trace.getActiveSpan()).toBeUndefined();
    gates[1].resolve();
    gates[0].resolve();
    await Promise.all(pending);
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);
    const phases = runs.map(run => spans.find(span => span.name === "heartbeat.prepare.workspace"
      && span.attributes["paperclip.task.run.run_id"] === createHash("sha256").update(run).digest("hex").slice(0, 12))!);
    expect(phases.every(Boolean)).toBe(true);
    expect(phases[0].spanContext().traceId).not.toBe(phases[1].spanContext().traceId);
    for (const [index, run] of runs.entries()) {
      const child = spans.find(span => span.name === `child.${run}`)!;
      expect(child.parentSpanContext?.spanId).toBe(phases[index].spanContext().spanId);
      expect(child.spanContext().traceId).toBe(phases[index].spanContext().traceId);
      expect(phases[index].parentSpanContext).toBeUndefined();
    }
    expect(trace.getActiveSpan()).toBeUndefined();
  } finally {
    trace.disable();
    context.disable();
    manager.disable();
    await provider.shutdown();
  }
});
