import { describe, expect, it } from "vitest";
import { parseGrokStdoutLine } from "./parse-stdout.js";

describe("parseGrokStdoutLine", () => {
  const ts = "2026-05-15T00:00:00.000Z";

  it("maps thought/text/end events into transcript entries", () => {
    expect(parseGrokStdoutLine(JSON.stringify({ type: "thought", data: "Plan first." }), ts)).toEqual([
      { kind: "thinking", ts, text: "Plan first.", delta: true },
    ]);
    expect(parseGrokStdoutLine(JSON.stringify({ type: "text", data: "hello" }), ts)).toEqual([
      { kind: "assistant", ts, text: "hello", delta: true },
    ]);
    expect(parseGrokStdoutLine(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1" }), ts)).toEqual([
      { kind: "system", ts, text: "stop_reason=EndTurn session=sess-1" },
    ]);
  });

  it("surfaces structured Grok error payload text", () => {
    expect(parseGrokStdoutLine(JSON.stringify({
      type: "error",
      error: { message: "Authentication required" },
    }), ts)).toEqual([
      { kind: "stderr", ts, text: "Authentication required" },
    ]);
  });
});
