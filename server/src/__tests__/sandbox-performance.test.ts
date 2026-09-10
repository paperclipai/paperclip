import { AsyncLocalStorage } from "node:async_hooks";
import { ROOT_CONTEXT, trace, type Context } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { getActiveStepContext, runWithRuntimeParent } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import type { StartupTraceContextHandle } from "../instrumentation.js";
import {
  captureSandboxPerformanceContext,
  hasSandboxPerformanceTrace,
  measureSandboxOperation,
  runWithSandboxPerformanceTrace,
  setSandboxPerformanceRunAttributes,
  type SandboxPerformanceRecord,
} from "../services/sandbox-performance.js";

function recordingContext() {
  const active = new AsyncLocalStorage<Context>();
  const spans: Array<{ name: string; id: string; parentId?: string; attributes: Record<string, unknown>; status?: unknown; ended: boolean; events: unknown[] }> = [];
  let next = 1;
  const tracing: StartupTraceContextHandle = {
    tracer: { startSpan(name, options, parent) {
      const id = (next++).toString(16).padStart(16, "0");
      const parentSpan = trace.getSpanContext(parent as Context ?? active.getStore() ?? ROOT_CONTEXT);
      const traceId = parentSpan?.traceId ?? "1234567890abcdef1234567890abcdef";
      const record = { name, id, parentId: parentSpan?.spanId,
        attributes: { ...(options as { attributes?: Record<string, unknown> })?.attributes },
        ended: false, status: undefined as unknown, events: [] as unknown[] };
      spans.push(record);
      return {
        ...trace.wrapSpanContext({ spanId: id, traceId, traceFlags: 1 }),
        spanContext: () => ({ spanId: id, traceId, traceFlags: 1 }),
        setAttribute(key: string, value: unknown) { record.attributes[key] = value; },
        setStatus(status: unknown) { record.status = status; },
        addEvent(name: string, attributes: unknown) { record.events.push({ name, attributes }); },
        end() { record.ended = true; },
      };
    } },
    contextWithSpan(span) { return trace.setSpan(active.getStore() ?? ROOT_CONTEXT, span as ReturnType<typeof trace.wrapSpanContext>); },
    withContext(context, work) { return active.run(context as Context, work); },
  };
  return { tracing, spans, active };
}

describe("sandbox performance trace", () => {
  it.each([false, true])("keeps a callback with a previous run's parent in the current trace (captured: %s)", async (captured) => {
    const { tracing, spans } = recordingContext();
    const records: SandboxPerformanceRecord[] = [];
    const staleParent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "abcdef1234567890abcdef1234567890", spanId: "abcdef1234567890", traceFlags: 1,
    });
    await runWithSandboxPerformanceTrace({ runId: "warm-run", enabled: true, traceContext: tracing,
      onBatch: async (batch) => { records.push(...batch.records); } }, async () => {
      await runWithRuntimeParent(staleParent, async () => {
        const within = captured ? captureSandboxPerformanceContext() : <T>(work: () => T) => work();
        await within(() => measureSandboxOperation("heartbeat.append_run_event", {}, async () => undefined));
      });
    });
    const root = records.find((record) => record.name === "sandbox.run")!;
    const callback = records.find((record) => record.name === "heartbeat.append_run_event")!;
    expect(callback.traceId).toBe(root.traceId);
    expect(callback.parentId).toBe(root.id);
    expect(spans.every((span) => span.ended)).toBe(true);
  });

  it("preserves a startup-step parent belonging to the current trace", async () => {
    const { tracing } = recordingContext();
    const records: SandboxPerformanceRecord[] = [];
    const step = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "1234567890abcdef1234567890abcdef", spanId: "abcdef1234567890", traceFlags: 1,
    });
    await runWithSandboxPerformanceTrace({ runId: "run", enabled: true, traceContext: tracing,
      onBatch: async (batch) => { records.push(...batch.records); } }, async () => {
      await runWithRuntimeParent(step, () => measureSandboxOperation("sandbox.child", {}, async () => undefined));
    });
    expect(records.find((record) => record.name === "sandbox.child")?.parentId).toBe("abcdef1234567890");
  });

  it("uses real contexts and keeps parallel branches separate across awaits", async () => {
    const { tracing, spans, active } = recordingContext();
    const records: SandboxPerformanceRecord[] = [];
    await runWithSandboxPerformanceTrace({ runId: "private-run-id", enabled: true, traceContext: tracing,
      onBatch: async (batch) => { records.push(...batch.records); } }, async () => {
      setSandboxPerformanceRunAttributes({ runtime: "legacy" });
      await Promise.all(["left", "right"].map((side) => measureSandboxOperation(`sandbox.${side}`, {}, async () => {
        const parent = trace.getSpanContext(active.getStore()!)!.spanId;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(trace.getSpanContext(active.getStore()!)?.spanId).toBe(parent);
        expect(trace.getSpanContext(getActiveStepContext()?.parentContext as Context)?.spanId).toBe(parent);
        await measureSandboxOperation(`sandbox.${side}.child`, {}, async () => undefined);
      })));
    });
    const root = spans.find((span) => span.name === "sandbox.run")!;
    for (const side of ["left", "right"]) {
      const parent = spans.find((span) => span.name === `sandbox.${side}`)!;
      expect(parent.parentId).toBe(root.id);
      expect(spans.find((span) => span.name === `sandbox.${side}.child`)?.parentId).toBe(parent.id);
    }
    expect(root.attributes["paperclip.sandbox.runtime"]).toBe("legacy");
    expect(root.attributes["paperclip.sandbox.recordCount"]).toBe(5);
    expect(root.attributes["paperclip.sandbox.dropped"]).toBe(0);
    expect(records.every((record) => record.traceId === "1234567890abcdef1234567890abcdef")).toBe(true);
    expect(new Set(records.map((record) => record.id)).size).toBe(5);
    expect(spans.every((span) => span.ended)).toBe(true);
    expect(hasSandboxPerformanceTrace()).toBe(false);
    expect(active.getStore()).toBeUndefined();
  });

  it("drops private attributes and error messages while preserving the original failure", async () => {
    const { tracing, spans } = recordingContext();
    const records: SandboxPerformanceRecord[] = [];
    const failure = new Error("private-secret-error");
    await expect(runWithSandboxPerformanceTrace({ runId: "private-run-id", enabled: true, traceContext: tracing,
      onBatch: async (batch) => { records.push(...batch.records); } }, async () => {
      await measureSandboxOperation("sandbox.read", { path: "/secret", credential: "private-token", scope: "task", bytes: 12, files: NaN,
        operation: "https://private.example", outcome: "bad\nvalue" }, async () => { throw failure; });
    })).rejects.toBe(failure);
    expect(records.map((record) => record.outcome)).toEqual(["failed", "failed"]);
    expect(records[0]?.attributes).toEqual({ scope: "task", bytes: 12 });
    expect(spans.every((span) => (span.status as { code: number }).code === 2)).toBe(true);
    expect(JSON.stringify({ spans, records })).not.toMatch(/private|secret|credential/);
  });

  it("bounds persistence, exposes lost records, and never writes batches during measured work", async () => {
    const { tracing, spans } = recordingContext();
    let finished = false;
    const batches: Array<{ records: SandboxPerformanceRecord[]; dropped: number }> = [];
    await runWithSandboxPerformanceTrace({ runId: "run", enabled: true, traceContext: tracing, maxRecords: 300,
      onBatch: async (batch) => { expect(finished).toBe(true); batches.push(batch); } }, async () => {
      for (let i = 0; i < 350; i++) await measureSandboxOperation("sandbox.read", { fileIndex: i }, async () => undefined);
      finished = true;
    });
    expect(batches.map((batch) => batch.records.length)).toEqual([50, 50, 50, 50, 50, 50]);
    expect(batches.every((batch) => batch.dropped === 51)).toBe(true);
    const root = spans.find((span) => span.name === "sandbox.run")!;
    expect(root.attributes["paperclip.sandbox.recordCount"]).toBe(300);
    expect(root.attributes["paperclip.sandbox.dropped"]).toBe(51);
    expect(spans).toHaveLength(351);
  });

  it("keeps remote timing relative instead of inventing a host timestamp", async () => {
    const { tracing, spans } = recordingContext();
    const records: SandboxPerformanceRecord[] = [];
    await runWithSandboxPerformanceTrace({ runId: "run", enabled: true, traceContext: tracing,
      onBatch: async (batch) => { records.push(...batch.records); } }, async () => {
      await measureSandboxOperation("sandbox.command", {}, async (span) => {
        span.recordRemotePhase("sandbox.remote.hash", 7, 11, { bytes: 20 });
        span.recordRemotePhase("sandbox.invalid", -1, 5);
      });
    });
    const remote = records.find((record) => record.clock === "remote_relative")!;
    expect(remote).toMatchObject({ startedAtMs: 7, durationMs: 11, attributes: { clock: "remote_relative", bytes: 20 } });
    expect(remote.parentId).toBe(records.find((record) => record.name === "sandbox.command")!.id);
    expect(spans.find((span) => span.name === "sandbox.command")!.events).toHaveLength(1);
    expect(spans.some((span) => span.name === "sandbox.remote.hash")).toBe(false);
  });

  it("reparents lazy work to an open ancestor and ignores callbacks after trace closure", async () => {
    const { tracing, spans } = recordingContext();
    let captured: ReturnType<typeof captureSandboxPerformanceContext> = (work) => work();
    await runWithSandboxPerformanceTrace({ runId: "run", enabled: true, traceContext: tracing }, async () => {
      await measureSandboxOperation("sandbox.response", {}, async () => { captured = captureSandboxPerformanceContext(); });
      await captured(() => measureSandboxOperation("sandbox.body", {}, async () => undefined));
    });
    const root = spans.find((span) => span.name === "sandbox.run")!;
    expect(spans.find((span) => span.name === "sandbox.body")?.parentId).toBe(root.id);
    await captured(() => measureSandboxOperation("sandbox.too_late", {}, async () => { expect(hasSandboxPerformanceTrace()).toBe(false); }));
    expect(spans).toHaveLength(3);
  });

  it("preserves disabled execution and fails open when tracing or persistence fails", async () => {
    const tracer = vi.fn(() => { throw new Error("sink failure"); });
    const onBatch = vi.fn(async () => { throw new Error("database failure"); });
    const tracing: StartupTraceContextHandle = { tracer: { startSpan: tracer }, contextWithSpan: () => undefined };
    await expect(runWithSandboxPerformanceTrace({ runId: "run", enabled: false, traceContext: tracing, onBatch }, async () => {
      expect(hasSandboxPerformanceTrace()).toBe(false);
      return measureSandboxOperation("sandbox.noop", {}, async () => 42);
    })).resolves.toBe(42);
    expect(tracer).not.toHaveBeenCalled();
    expect(onBatch).not.toHaveBeenCalled();
    await expect(runWithSandboxPerformanceTrace({ runId: "run", enabled: true, traceContext: tracing, onBatch }, async () => 42)).resolves.toBe(42);
    expect(onBatch).toHaveBeenCalledOnce();
  });
});
