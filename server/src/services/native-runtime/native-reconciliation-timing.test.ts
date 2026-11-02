import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handles = vi.hoisted(() => ({
  startSpan: vi.fn(),
  getTracer: vi.fn(),
  setSpan: vi.fn((_context: unknown, span: unknown) => ({ parent: span })),
}));
vi.mock("@opentelemetry/api", () => ({
  ROOT_CONTEXT: "root",
  SpanStatusCode: { ERROR: 2 },
  trace: { getTracer: handles.getTracer, setSpan: handles.setSpan },
}));

const { createNativeReconciliationPassTiming } = await import("./native-reconciliation-timing.js");

function clock() {
  let at = 10_000;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

function spanStub(name: string) {
  return { name, end: vi.fn(), setStatus: vi.fn() };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  handles.getTracer.mockReturnValue({ startSpan: handles.startSpan });
  handles.startSpan.mockImplementation((name: string) => spanStub(name));
});
afterEach(() => vi.unstubAllEnvs());

describe("native reconciliation pass timing", () => {
  it("records nothing for a fast pass", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const c = clock();
    const timing = createNativeReconciliationPassTiming({ now: c.now });
    timing.phase("candidate_scan");
    c.advance(999);
    timing.finish({ outcome: "ok", scoped: false });
    expect(handles.getTracer).not.toHaveBeenCalled();
  });

  it("records nothing without an OTLP endpoint", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    const c = clock();
    const timing = createNativeReconciliationPassTiming({ now: c.now });
    timing.phase("candidate_scan");
    c.advance(5_000);
    timing.finish({ outcome: "ok", scoped: false });
    expect(handles.getTracer).not.toHaveBeenCalled();
  });

  it("emits a pass span with one child span per phase for a slow pass", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const c = clock();
    const timing = createNativeReconciliationPassTiming({ now: c.now });
    timing.phase("legacy_workspace_exports");
    c.advance(100);
    timing.phase("candidate_scan");
    c.advance(300);
    timing.candidates(187);
    timing.phase("candidates");
    c.advance(2_000);
    timing.finish({ outcome: "ok", scoped: false });

    const calls = handles.startSpan.mock.calls;
    expect(calls[0]).toEqual([
      "controller.native_reconciliation",
      { startTime: 10_000, attributes: { "paperclip.native_reconciliation.scoped": false, "paperclip.native_reconciliation.candidates": 187 } },
      "root",
    ]);
    const pass = handles.startSpan.mock.results[0]!.value;
    expect(calls.slice(1).map(([name, options, context]) => [name, options.startTime, context])).toEqual([
      ["controller.native_reconciliation.legacy_workspace_exports", 10_000, { parent: pass }],
      ["controller.native_reconciliation.candidate_scan", 10_100, { parent: pass }],
      ["controller.native_reconciliation.candidates", 10_400, { parent: pass }],
    ]);
    const children = handles.startSpan.mock.results.slice(1).map(result => result.value);
    expect(children.map(span => span.end.mock.calls[0]?.[0])).toEqual([10_100, 10_400, 12_400]);
    expect(pass.end).toHaveBeenCalledWith(12_400);
    expect(pass.setStatus).not.toHaveBeenCalled();
  });

  it("marks the failed phase and the pass when a slow pass fails", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const c = clock();
    const timing = createNativeReconciliationPassTiming({ now: c.now });
    timing.phase("obsolete_policy_reviews");
    c.advance(10);
    timing.phase("automatic_completion_reviews");
    c.advance(2_000);
    timing.finish({ outcome: "failed", scoped: true });

    const [pass, reviews, completion] = handles.startSpan.mock.results.map(result => result.value);
    expect(pass.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(reviews.setStatus).not.toHaveBeenCalled();
    expect(completion.name).toBe("controller.native_reconciliation.automatic_completion_reviews");
    expect(completion.setStatus).toHaveBeenCalledWith({ code: 2 });
  });

  it("never throws when tracing fails", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    handles.getTracer.mockImplementation(() => { throw new Error("tracer unavailable"); });
    const c = clock();
    const timing = createNativeReconciliationPassTiming({ now: c.now });
    timing.phase("candidates");
    c.advance(5_000);
    expect(() => timing.finish({ outcome: "ok", scoped: false })).not.toThrow();
  });
});
