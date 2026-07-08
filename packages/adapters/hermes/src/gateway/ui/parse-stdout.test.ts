import { describe, expect, it } from "vitest";
import { parseHermesGatewayStdoutLine } from "./parse-stdout.js";

const TS = "2026-07-08T12:00:00.000Z";

function eventLine(eventName: string, data: unknown): string {
  return `[hermes-gateway:event] run=run-123 event=${eventName} data=${JSON.stringify(data)}`;
}

describe("parseHermesGatewayStdoutLine — reasoning.available payload extraction", () => {
  // This is the assertion that FAILS on the old hardcoded-placeholder code
  // and PASSES once the real reasoning text is extracted from `data`.
  it("uses the real reasoning text from data.text instead of the hardcoded placeholder", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { text: "Considering three approaches to the cache invalidation bug." }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Considering three approaches to the cache invalidation bug.",
    });
    expect(result[0]).not.toHaveProperty("text", "Hermes reasoning available");
  });

  it("uses the real reasoning text from data.summary", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { summary: "Weighing tradeoffs between two refactor strategies." }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Weighing tradeoffs between two refactor strategies.",
    });
  });

  it("recurses one level into a nested data.data record to find the reasoning text", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { data: { text: "Nested reasoning payload from gateway wrapper." } }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Nested reasoning payload from gateway wrapper.",
    });
  });

  it("recurses one level into a nested data.payload record to find the reasoning text", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { payload: { reasoning: "Nested via payload wrapper instead of data." } }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Nested via payload wrapper instead of data.",
    });
  });

  it("falls back to the placeholder when data has no recognizable text field (preserves bare-signal behavior)", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { unrelatedField: 42 }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "thinking", ts: TS, text: "Hermes reasoning available" });
  });

  it("falls back to the placeholder when data is entirely absent/unparseable", () => {
    const result = parseHermesGatewayStdoutLine(
      "[hermes-gateway:event] run=run-123 event=reasoning.available data=not-json",
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "thinking", ts: TS, text: "Hermes reasoning available" });
  });
});

describe("parseHermesGatewayStdoutLine — regression guards for unrelated handlers", () => {
  it("still yields an assistant delta part for message.delta", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("message.delta", { delta: "Hello there" }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "assistant", ts: TS, text: "Hello there", delta: true });
  });

  it("still yields a stdout part for a plain non-event line", () => {
    const result = parseHermesGatewayStdoutLine("just a plain line of output", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "stdout", ts: TS, text: "just a plain line of output" });
  });
});
