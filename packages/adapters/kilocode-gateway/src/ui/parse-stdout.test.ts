import { describe, expect, it } from "vitest";
import { parseKilocodeGatewayStdoutLine } from "./parse-stdout.js";

const TS = "2026-05-13T12:00:00Z";

describe("parseKilocodeGatewayStdoutLine", () => {
  it("parses a text delta chunk", () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}';
    const result = parseKilocodeGatewayStdoutLine(line, TS);
    expect(result).toEqual([{ kind: "assistant", ts: TS, text: "Hello", delta: true }]);
  });

  it("parses a tool-call chunk as raw stdout", () => {
    const line = 'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1"}]},"finish_reason":null}]}';
    const result = parseKilocodeGatewayStdoutLine(line, TS);
    expect(result).toEqual([{ kind: "stdout", ts: TS, text: line }]);
  });

  it("parses a done event and returns empty", () => {
    const result = parseKilocodeGatewayStdoutLine("data: [DONE]", TS);
    expect(result).toEqual([]);
  });

  it("passes non-SSE lines through as stdout", () => {
    const result = parseKilocodeGatewayStdoutLine("some plain text", TS);
    expect(result).toEqual([{ kind: "stdout", ts: TS, text: "some plain text" }]);
  });

  it("returns empty array for blank lines", () => {
    const result = parseKilocodeGatewayStdoutLine("   ", TS);
    expect(result).toEqual([]);
  });

  it("returns empty array for finish_reason stop with no content", () => {
    const line = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}';
    const result = parseKilocodeGatewayStdoutLine(line, TS);
    expect(result).toEqual([]);
  });
});
