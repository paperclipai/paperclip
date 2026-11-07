import { afterEach, describe, expect, it, vi } from "vitest";

const tracer = vi.hoisted(() => ({ startSpan: vi.fn() }));
vi.mock("@opentelemetry/api", () => ({ trace: { getTracer: () => tracer } }));
import { beginSlackReceiptTiming } from "./receipt-timing.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const input = { operation: "add" as const, queuedAt: new Date(100), receivedAt: new Date(50) };

describe("Slack receipt timing", () => {
  it("does no tracing without the operator endpoint", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    beginSlackReceiptTiming(input)("confirmed");
    expect(tracer.startSpan).not.toHaveBeenCalled();
  });

  it("records queue wait and delivery age without content or identifiers", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://collector.example");
    const span = { setAttribute: vi.fn(), end: vi.fn() };
    tracer.startSpan.mockReturnValue(span);
    vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValueOnce(300);
    const finish = beginSlackReceiptTiming(input);
    finish("confirmed");
    expect(tracer.startSpan).toHaveBeenCalledWith("chat.slack.receipt", {
      attributes: { "paperclip.chat.receipt.operation": "add", "paperclip.chat.receipt.queue_ms": 100 },
    });
    expect(span.setAttribute.mock.calls).toEqual([
      ["paperclip.chat.receipt.outcome", "confirmed"],
      ["paperclip.chat.receipt.delivery_age_ms", 250],
    ]);
    expect(span.end).toHaveBeenCalledOnce();
  });

  it("contains tracer failures at creation and completion", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://collector.example");
    tracer.startSpan.mockImplementationOnce(() => { throw new Error("tracer unavailable"); });
    expect(() => beginSlackReceiptTiming(input)("failed")).not.toThrow();
    tracer.startSpan.mockReturnValue({ setAttribute() { throw new Error("sink unavailable"); } });
    expect(() => beginSlackReceiptTiming(input)("confirmed")).not.toThrow();
  });
});
