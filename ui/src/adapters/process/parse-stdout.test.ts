import { describe, it, expect } from "vitest";
import { parseProcessStdoutLine } from "./parse-stdout.js";

describe("parseProcessStdoutLine", () => {
  it("returns a single stdout TranscriptEntry", () => {
    const result = parseProcessStdoutLine("process output", "2024-01-01T00:00:00Z");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "stdout",
      ts: "2024-01-01T00:00:00Z",
      text: "process output",
    });
  });

  it("preserves empty string as text", () => {
    const result = parseProcessStdoutLine("", "ts");
    expect(result[0]).toEqual({ kind: "stdout", ts: "ts", text: "" });
  });

  it("preserves the timestamp exactly", () => {
    const ts = "2026-04-17T21:00:00.000Z";
    const result = parseProcessStdoutLine("line", ts);
    expect(result[0]).toEqual({ kind: "stdout", ts, text: "line" });
  });

  it("handles multiline text as a single entry (no splitting)", () => {
    const text = "line one\nline two";
    const result = parseProcessStdoutLine(text, "ts");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "stdout", ts: "ts", text });
  });
});
