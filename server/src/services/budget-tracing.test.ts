import { afterEach, expect, it, vi } from "vitest";
import { withBudgetSpan } from "./budget-tracing.js";

const start = vi.hoisted(() => vi.fn());
vi.mock("@opentelemetry/api", () => ({ trace: { getTracer: () => ({ startActiveSpan: start }) } }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it("leaves tracing unused without an operator endpoint", async () => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
  await expect(withBudgetSpan("budget.accounting.transaction", async () => 42)).resolves.toBe(42);
  expect(start).not.toHaveBeenCalled();
});

it.each(["before", "after", "end", "rejected", "missing"])("keeps accounting authoritative when tracing fails %s", async failure => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  start.mockImplementation((_name, _options, callback) => {
    if (failure === "before") throw new Error("before callback");
    if (failure === "rejected") return Promise.reject(new Error("tracer rejected"));
    if (failure === "missing") return undefined;
    const result = callback({ end: () => { if (failure === "end") throw new Error("end failed"); } });
    if (failure === "after") throw new Error("after callback");
    return result;
  });
  const work = vi.fn(async () => 42);
  await expect(withBudgetSpan("budget.accounting.transaction", work)).resolves.toBe(42);
  expect(work).toHaveBeenCalledOnce();
  const error = new Error("original accounting failure");
  const failed = vi.fn(async () => { throw error; });
  await expect(withBudgetSpan("budget.accounting.transaction", failed)).rejects.toBe(error);
  expect(failed).toHaveBeenCalledOnce();
});
