import { describe, expect, it } from "vitest";
import { parseKimiStdoutLine } from "./parse-stdout.js";

describe("parseKimiStdoutLine", () => {
  const ts = "2026-05-15T00:00:00.000Z";

  it("maps assistant events into transcript entries", () => {
    expect(parseKimiStdoutLine(JSON.stringify({ role: "assistant", content: "hello" }), ts)).toEqual([
      { kind: "assistant", ts, text: "hello", delta: true },
    ]);
  });

  it("maps assistant array content into assistant and thinking entries", () => {
    const line = JSON.stringify({
      role: "assistant",
      content: [{ type: "think", think: "Planning..." }, { type: "text", text: "Hello" }],
    });
    expect(parseKimiStdoutLine(line, ts)).toEqual([
      { kind: "thinking", ts, text: "Planning...", delta: true },
      { kind: "assistant", ts, text: "Hello", delta: true },
    ]);
  });

  it("maps tool results into transcript entries", () => {
    expect(parseKimiStdoutLine(JSON.stringify({ role: "tool", tool_call_id: "tc_1", content: "output" }), ts)).toEqual([
      { kind: "tool_result", ts, toolUseId: "tc_1", content: "output", isError: false },
    ]);
  });

  it("maps tool results from array content", () => {
    expect(parseKimiStdoutLine(JSON.stringify({
      role: "tool",
      tool_call_id: "tc_1",
      content: [{ type: "text", text: "line1\n" }, { type: "text", text: "line2" }],
    }), ts)).toEqual([
      { kind: "tool_result", ts, toolUseId: "tc_1", content: "line1\nline2", isError: false },
    ]);
  });

  it("maps assistant with tool_calls into multiple entries", () => {
    const line = JSON.stringify({
      role: "assistant",
      content: "Calling tool.",
      tool_calls: [
        { type: "function", function: { name: "Shell", arguments: '{"command":"ls"}' } },
      ],
    });
    expect(parseKimiStdoutLine(line, ts)).toEqual([
      { kind: "assistant", ts, text: "Calling tool.", delta: true },
      { kind: "tool_call", ts, name: "Shell", input: '{"command":"ls"}' },
    ]);
  });

  it("surfaces structured error payload text", () => {
    expect(parseKimiStdoutLine(JSON.stringify({
      role: "error",
      message: "Authentication required",
    }), ts)).toEqual([
      { kind: "stderr", ts, text: "Authentication required" },
    ]);
  });

  it("falls back to stdout for unparseable lines", () => {
    expect(parseKimiStdoutLine("plain text", ts)).toEqual([
      { kind: "stdout", ts, text: "plain text" },
    ]);
  });
});
