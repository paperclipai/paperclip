import { getActiveStepContext, runWithRuntimeParent } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRunPreparationTiming, measureRunPhase, recordRepositoryObjectCacheDetail, withRunExecutionTiming, withRunWorkspaceFinalizationTiming } from "./execution-preparation-timing.js";
import { ROOT_CONTEXT, trace, SpanStatusCode, type Context } from "@opentelemetry/api";
import { createHash } from "node:crypto";

const handles = vi.hoisted(() => ({ getTracer: vi.fn(), startActiveSpan: vi.fn() }));
vi.mock("@opentelemetry/api", async importOriginal => {
  const api = await importOriginal<typeof import("@opentelemetry/api")>();
  return { ...api, trace: { ...api.trace, getTracer: handles.getTracer, getActiveSpan: () => undefined } };
});
beforeEach(() => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  handles.getTracer.mockReturnValue({ startActiveSpan: handles.startActiveSpan });
});
afterEach(() => vi.unstubAllEnvs());

it.each(["lookup", "start", "after_callback", "missing_callback", "rejected", "end", "status"])("runs work once and preserves its result or error when tracing fails at %s", async failure => {
  const broken = () => { throw new Error("tracing failed"); };
  handles.getTracer.mockImplementation(failure === "lookup" ? broken : () => ({ startActiveSpan: handles.startActiveSpan }));
  handles.startActiveSpan.mockImplementation((_name, _options, _context, callback) => {
    if (failure === "start") throw new Error("tracer failed before callback");
    if (failure === "missing_callback") return undefined;
    if (failure === "rejected") return Promise.reject(new Error("tracer rejected"));
    const result = callback({ end: failure === "end" ? broken : vi.fn(), setStatus: failure === "status" ? broken : vi.fn() });
    if (failure === "after_callback") throw new Error("tracer failed after callback");
    return result;
  });
  const timing = createRunPreparationTiming("private-run", "native.controller");
  const result = {};
  const work = vi.fn(async () => result);
  await expect(timing("backend_setup", work)).resolves.toBe(result);
  expect(work).toHaveBeenCalledOnce();
  const error = new Error("original private failure");
  const failedWork = vi.fn(async () => { throw error; });
  await expect(timing("assigned_mcp", failedWork)).rejects.toBe(error);
  expect(failedWork).toHaveBeenCalledOnce();
});

it.each([undefined, "", "  "])("does not consult tracing for endpoint %s", async endpoint => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
  handles.getTracer.mockClear();
  const warn = vi.spyOn(console, "warn");
  const error = vi.spyOn(console, "error");
  try {
    await expect(createRunPreparationTiming("run", "native.controller")("backend_setup", () => 42)).resolves.toBe(42);
    await expect(withRunWorkspaceFinalizationTiming("run", () => 42)).resolves.toBe(42);
    for (const phase of ["execution.usage_startup", "execution.mcp_handoff", "execution.dispatch_admission", "execution.budget_reservation",
      "skills.inventory", "skills.inventory.wait", "skills.cache.acquire", "skills.version.materialize", "skills.consume",
      "workspace_sync.seed_read_copy", "workspace_sync.seed_read_hash", "workspace_sync.seed_read_touch"] as const) {
      const result = {};
      const work = vi.fn(() => {
        recordRepositoryObjectCacheDetail({ outcome: "hit", referenceSupplied: true });
        return result;
      });
      await expect(withRunExecutionTiming("run", () => measureRunPhase(phase, work))).resolves.toBe(result);
      expect(work).toHaveBeenCalledOnce();
      const original = new Error("original startup failure");
      const failed = vi.fn(() => { throw original; });
      await expect(withRunExecutionTiming("run", () => measureRunPhase(phase, failed))).rejects.toBe(original);
      expect(failed).toHaveBeenCalledOnce();
    }
    expect(handles.getTracer).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});

it("parents concurrent deferred copyback phases to their own finalization roots and preserves failure", async () => {
  const spans: Array<{ name: string; attributes: Record<string, unknown>; context: Context;
    span: { end: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> } }> = [];
  handles.startActiveSpan.mockImplementation((name, options, context, callback) => {
    const span = { end: vi.fn(), setStatus: vi.fn() };
    spans.push({ name, attributes: options.attributes, context, span });
    return callback(span);
  });
  await Promise.all(["first", "second"].map(runId => withRunWorkspaceFinalizationTiming(runId, async () => {
    await Promise.resolve();
    await measureRunPhase("workspace_sync.restore", async () => {});
  })));
  for (const runId of ["first", "second"]) {
    const hash = createHash("sha256").update(runId).digest("hex").slice(0, 12);
    const owned = spans.filter(span => span.attributes["paperclip.task.run.run_id"] === hash);
    expect(owned).toHaveLength(2);
    const root = owned.find(span => span.name === "task.workspace_finalization")!;
    const child = owned.find(span => span.name === "workspace_sync.restore")!;
    expect(root.context).toBe(ROOT_CONTEXT);
    expect(trace.getSpan(child.context)).toBe(root.span);
    expect(root.span.end).toHaveBeenCalledOnce();
    expect(Object.keys(root.attributes)).toEqual(["paperclip.task.run.run_id"]);
  }
  const original = new Error("private finalization failure");
  const work = vi.fn(() => { throw original; });
  await expect(withRunWorkspaceFinalizationTiming("failed", work)).rejects.toBe(original);
  expect(work).toHaveBeenCalledOnce();
  expect(spans.at(-1)!.span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  expect(spans.at(-1)!.span.end).toHaveBeenCalledOnce();
  expect(JSON.stringify(spans)).not.toContain(original.message);
});

it("keeps cache outcomes and clone references on their owning concurrent phases", async () => {
  const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
  handles.startActiveSpan.mockImplementation((name, options, _context, callback) => {
    const record = { name, attributes: { ...options.attributes } };
    spans.push(record);
    return callback({
      end: vi.fn(), setStatus: vi.fn(),
      setAttribute: (key: string, value: unknown) => { record.attributes[key] = value; },
    });
  });
  await Promise.all([
    withRunExecutionTiming("first", () => measureRunPhase("workspace.checkout.cache_lookup", async () => {
      await Promise.resolve();
      recordRepositoryObjectCacheDetail({ outcome: "hit" });
    })),
    withRunExecutionTiming("second", () => measureRunPhase("workspace.checkout.git_clone", async () => {
      await Promise.resolve();
      recordRepositoryObjectCacheDetail({ referenceSupplied: false });
    })),
  ]);
  expect(spans.find(span => span.name === "workspace.checkout.cache_lookup")?.attributes).toMatchObject({
    "paperclip.execution.repositoryCache.outcome": "hit",
  });
  expect(spans.find(span => span.name === "workspace.checkout.git_clone")?.attributes).toMatchObject({
    "paperclip.execution.repositoryCache.reference_supplied": false,
  });
  expect(spans.filter(span => span.name === "task.execution_attempt").every(span =>
    Object.keys(span.attributes).every(key => key === "paperclip.task.run.run_id"))).toBe(true);
});

it("does not let cache attribute failures replace the operation result", async () => {
  handles.startActiveSpan.mockImplementation((_name, _options, _context, callback) => callback({
    end: vi.fn(), setStatus: vi.fn(),
    setAttribute: () => { throw new Error("tracer failed"); },
  }));
  const work = vi.fn(() => {
    recordRepositoryObjectCacheDetail({ outcome: "published", referenceSupplied: true });
    return 42;
  });
  await expect(withRunExecutionTiming("run", () => measureRunPhase("workspace.checkout.cache_publish", work))).resolves.toBe(42);
  expect(work).toHaveBeenCalledOnce();
});

it("keeps plugin dispatch beneath its active startup step and gives the worker the dispatch parent", async () => {
  const parents = new Map<string, Context>();
  const spans = new Map<string, { end: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> }>();
  handles.startActiveSpan.mockImplementation((name, _options, parent, callback) => {
    parents.set(name, parent);
    const span = { end: vi.fn(), setStatus: vi.fn() };
    spans.set(name, span);
    return callback(span);
  });
  const step = trace.wrapSpanContext({ traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 });
  const stepContext = trace.setSpan(ROOT_CONTEXT, step);
  await withRunExecutionTiming("startup", () => runWithRuntimeParent(stepContext, async () => {
    await measureRunPhase("execution.plugin_dispatch", () => {
      expect(trace.getSpan(getActiveStepContext()!.parentContext as Context)).toBe(spans.get("execution.plugin_dispatch"));
    });
    expect(getActiveStepContext()!.parentContext).toBe(stepContext);
  }));
  expect(parents.get("execution.plugin_dispatch")).toBe(stepContext);
});
