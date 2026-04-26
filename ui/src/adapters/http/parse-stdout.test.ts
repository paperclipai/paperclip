import { describe, it, expect } from "vitest";
import { parseHttpStdoutLine } from "./parse-stdout.js";

describe("parseHttpStdoutLine", () => {
  it("returns a single stdout TranscriptEntry", () => {
    const result = parseHttpStdoutLine("hello world", "2024-01-01T00:00:00Z");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "stdout",
      ts: "2024-01-01T00:00:00Z",
      text: "hello world",
    });
  });

  it("preserves empty string as text", () => {
    const result = parseHttpStdoutLine("", "2024-01-01T00:00:00Z");
    expect(result[0]).toEqual({ kind: "stdout", ts: "2024-01-01T00:00:00Z", text: "" });
  });

  it("preserves the timestamp exactly", () => {
    const ts = "2026-04-17T21:00:00.123Z";
    const result = parseHttpStdoutLine("msg", ts);
    expect(result[0]).toEqual({ kind: "stdout", ts, text: "msg" });
  });

  it("preserves special characters in text", () => {
    const result = parseHttpStdoutLine('{"key": "value"}', "ts");
    expect(result[0]).toEqual({ kind: "stdout", ts: "ts", text: '{"key": "value"}' });
  });
});
