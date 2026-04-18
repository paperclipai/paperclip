import { describe, expect, it } from "vitest";
import { parseKimiStdoutLine } from "./parse-stdout.js";

describe("parseKimiStdoutLine", () => {
  const ts = "2026-04-18T12:00:00.000Z";

  it("parses assistant text messages", () => {
    const result = parseKimiStdoutLine(
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "I'll help you with that." }],
      }),
      ts,
    );

    expect(result).toEqual([{ kind: "assistant", ts, text: "I'll help you with that." }]);
  });

  it("parses assistant thinking messages", () => {
    const result = parseKimiStdoutLine(
      JSON.stringify({
        role: "assistant",
        content: [{ type: "think", think: "Analyzing the problem..." }],
      }),
      ts,
    );

    expect(result).toEqual([{ kind: "thinking", ts, text: "Analyzing the problem..." }]);
  });

  it("parses assistant tool_use as tool_call", () => {
    const result = parseKimiStdoutLine(
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "tool_use", name: "bash", id: "tool_1", input: { command: "ls -la" } },
        ],
      }),
      ts,
    );

    expect(result).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "bash",
        toolUseId: "tool_1",
        input: { command: "ls -la" },
      },
    ]);
  });

  it("parses user text messages", () => {
    const result = parseKimiStdoutLine(
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "Please continue." }],
      }),
      ts,
    );

    expect(result).toEqual([{ kind: "user", ts, text: "Please continue." }]);
  });

  it("parses user tool_result", () => {
    const result = parseKimiStdoutLine(
      JSON.stringify({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "file.txt\nREADME.md",
            is_error: false,
          },
        ],
      }),
      ts,
    );

    expect(result).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tool_1",
        content: "file.txt\nREADME.md",
        isError: false,
      },
    ]);
  });

  it("parses tool_result with array content", () => {
    const result = parseKimiStdoutLine(
      JSON.stringify({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_2",
            content: [{ text: "Line 1" }, { text: "Line 2" }],
            is_error: true,
          },
        ],
      }),
      ts,
    );

    expect(result).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tool_2",
        content: "Line 1\nLine 2",
        isError: true,
      },
    ]);
  });

  it("parses system init message", () => {
    const result = parseKimiStdoutLine(
      JSON.stringify({
        role: "system",
        type: "init",
        model: "kimi-k2-0713",
        session_id: "sess_123",
      }),
      ts,
    );

    expect(result).toEqual([
      { kind: "init", ts, model: "kimi-k2-0713", sessionId: "sess_123" },
    ]);
  });

  it("parses result message", () => {
    const result = parseKimiStdoutLine(
      JSON.stringify({
        type: "result",
        done: true,
        result: "Task completed successfully",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
        total_cost_usd: 0.0025,
        subtype: "success",
        is_error: false,
      }),
      ts,
    );

    expect(result).toEqual([
      {
        kind: "result",
        ts,
        text: "Task completed successfully",
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 10,
        costUsd: 0.0025,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("parses result with errors array", () => {
    const result = parseKimiStdoutLine(
      JSON.stringify({
        type: "result",
        done: true,
        result: "",
        is_error: true,
        errors: [{ message: "API error" }, { code: "RATE_LIMIT" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      ts,
    );

    expect(result[0].kind).toBe("result");
    expect(result[0].isError).toBe(true);
    expect(result[0].errors).toContain("API error");
    expect(result[0].errors).toContain("RATE_LIMIT");
  });

  it("returns stdout fallback for non-JSON input", () => {
    const result = parseKimiStdoutLine("Plain text output", ts);

    expect(result).toEqual([{ kind: "stdout", ts, text: "Plain text output" }]);
  });

  it("returns stdout fallback for unrecognized JSON", () => {
    const result = parseKimiStdoutLine(JSON.stringify({ unknown: "data" }), ts);

    expect(result).toEqual([{ kind: "stdout", ts, text: '{"unknown":"data"}' }]);
  });

  it("handles multiple content blocks in a single message", () => {
    const result = parseKimiStdoutLine(
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "text", text: "First message." },
          { type: "think", think: "Thinking..." },
          { type: "text", text: "Second message." },
        ],
      }),
      ts,
    );

    expect(result).toEqual([
      { kind: "assistant", ts, text: "First message." },
      { kind: "thinking", ts, text: "Thinking..." },
      { kind: "assistant", ts, text: "Second message." },
    ]);
  });
});
