import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { timeStartupRecovery } from "./startup-recovery-timing.js";

const handles = vi.hoisted(() => ({
  startSpan: vi.fn(),
  getTracer: vi.fn(),
}));
vi.mock("@opentelemetry/api", () => ({
  ROOT_CONTEXT: "root",
  SpanStatusCode: { ERROR: 2 },
  trace: { getTracer: handles.getTracer },
}));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  handles.getTracer.mockReturnValue({ startSpan: handles.startSpan });
});
afterEach(() => vi.unstubAllEnvs());

it.each([undefined, "", "  "])("runs silently without tracing for endpoint %s", async endpoint => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
  const spies = ["log", "info", "warn", "error", "debug"].map(name => vi.spyOn(console, name as "log"));
  try {
    const value = {};
    const error = new Error("private failure");
    await expect(timeStartupRecovery("accounting", async () => value)).resolves.toBe(value);
    await expect(timeStartupRecovery("native_recovery", async () => { throw error; })).rejects.toBe(error);
    expect(handles.getTracer).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { for (const spy of spies) spy.mockRestore(); }
});

it("keeps the phase open until recovery settles and records no results or error text", async () => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  const span = { end: vi.fn(), setStatus: vi.fn() };
  handles.startSpan.mockReturnValue(span);
  let reject!: (error: Error) => void;
  const work = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const pending = timeStartupRecovery("native_recovery", work);
  expect(handles.startSpan).toHaveBeenCalledExactlyOnceWith("controller.startup.native_recovery", undefined, "root");
  expect(span.end).not.toHaveBeenCalled();
  const error = new Error("private database detail");
  const assertion = expect(pending).rejects.toBe(error);
  reject(error);
  await assertion;
  expect(work).toHaveBeenCalledOnce();
  expect(span.setStatus).toHaveBeenCalledExactlyOnceWith({ code: 2 });
  expect(span.end).toHaveBeenCalledOnce();
});

it.each(["lookup", "start", "end", "status"])("preserves one execution when tracing fails during %s", async failure => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  const broken = () => { throw new Error("tracing unavailable"); };
  handles.getTracer.mockImplementation(failure === "lookup" ? broken : () => ({ startSpan: handles.startSpan }));
  handles.startSpan.mockImplementation(failure === "start" ? broken : () => ({
    end: failure === "end" ? broken : vi.fn(),
    setStatus: failure === "status" ? broken : vi.fn(),
  }));
  const value = {};
  const work = vi.fn(async () => value);
  await expect(timeStartupRecovery("orphan_reaping", work)).resolves.toBe(value);
  expect(work).toHaveBeenCalledOnce();
  const error = new Error("original failure");
  const failedWork = vi.fn(async () => { throw error; });
  await expect(timeStartupRecovery("queued_runs", failedWork)).rejects.toBe(error);
  expect(failedWork).toHaveBeenCalledOnce();
});
