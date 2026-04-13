import { describe, it, expect } from "vitest";
import { parseGeminiStdoutLine } from "../ui/parse-stdout.js";

const TS = "2026-04-03T00:00:00.000Z";

describe("parseGeminiStdoutLine", () => {
  it("handles tool_use content part inside assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "bash", input: { command: "ls" } },
        ],
      },
    });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toEqual([
      { kind: "tool_call", ts: TS, name: "bash", input: { command: "ls" } },
    ]);
  });

  it("handles function_call content part inside assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "function_call", name: "read_file", args: { path: "/tmp/foo" } },
        ],
      },
    });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toEqual([
      { kind: "tool_call", ts: TS, name: "read_file", input: { path: "/tmp/foo" } },
    ]);
  });

  it("handles function_response content part inside assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "function_response", id: "call_1", output: "file contents" },
        ],
      },
    });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toEqual([
      { kind: "tool_result", ts: TS, toolUseId: "call_1", content: "file contents", isError: false },
    ]);
  });

  it("handles top-level text event", () => {
    const line = JSON.stringify({ type: "text", text: "Hello from Gemini" });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toEqual([{ kind: "assistant", ts: TS, text: "Hello from Gemini" }]);
  });

  it("handles top-level step_finish event (no output)", () => {
    const line = JSON.stringify({ type: "step_finish", subtype: "turn_end" });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toEqual([]);
  });

  it("does not fall through to raw stdout for known event types", () => {
    const knownTypes = ["system", "assistant", "user", "thinking", "tool_call", "result", "error", "text", "step_finish"];
    for (const type of knownTypes) {
      const line = JSON.stringify({ type, message: "", text: "" });
      const result = parseGeminiStdoutLine(line, TS);
      for (const entry of result) {
        expect(entry.kind).not.toBe("stdout");
      }
    }
  });

  it("falls through to stdout for truly unknown event types", () => {
    const line = JSON.stringify({ type: "unknown_future_event", data: {} });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toEqual([{ kind: "stdout", ts: TS, text: line }]);
  });
});
