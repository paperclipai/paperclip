import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRunPreparationTiming } from "./execution-preparation-timing.js";

const handles = vi.hoisted(() => ({ getTracer: vi.fn(), startActiveSpan: vi.fn() }));
vi.mock("@opentelemetry/api", () => ({
  ROOT_CONTEXT: "root", SpanStatusCode: { ERROR: 2 },
  trace: { getTracer: handles.getTracer, getActiveSpan: () => undefined },
}));
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
  await expect(createRunPreparationTiming("run", "native.controller")("backend_setup", () => 42)).resolves.toBe(42);
  expect(handles.getTracer).not.toHaveBeenCalled();
});
