import { describe, expect, it, vi } from "vitest";
import { parseQwenStreamJson } from "@paperclipai/adapter-qwen-local/server";
import { parseQwenStdoutLine } from "@paperclipai/adapter-qwen-local/ui";
import { printQwenStreamEvent } from "@paperclipai/adapter-qwen-local/cli";

describe("qwen_local parser", () => {
  it("extracts session, summary, usage, cost, and terminal error message", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "session_start",
        sessionId: "ses_123",
        model: "qwen3-coder-plus",
      }),
      JSON.stringify({ type: "assistant", message: { content: "hello" } }),
      JSON.stringify({
        type: "result",
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          cachedInputTokens: 20,
          costUsd: 0.003,
        },
      }),
      JSON.stringify({ type: "error", message: "model access denied" }),
    ].join("\n");

    const parsed = parseQwenStreamJson(stdout);
    expect(parsed.sessionId).toBe("ses_123");
    expect(parsed.model).toBe("qwen3-coder-plus");
    expect(parsed.summary).toBe("hello");
    expect(parsed.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 40,
    });
    expect(parsed.costUsd).toBeCloseTo(0.003, 6);
    expect(parsed.errorMessage).toBe("model access denied");
  });
});

describe("qwen_local ui stdout parser", () => {
  it("parses assistant, tool, and result events", () => {
    const ts = "2026-03-11T00:00:00.000Z";
    expect(
      parseQwenStdoutLine(
        JSON.stringify({
          type: "assistant",
          message: { content: "I will run a command." },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "assistant",
        ts,
        text: "I will run a command.",
      },
    ]);

    expect(
      parseQwenStdoutLine(
        JSON.stringify({
          type: "tool_call",
          name: "bash",
          input: { command: "ls -1" },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "bash",
        input: { command: "ls -1" },
      },
    ]);

    expect(
      parseQwenStdoutLine(
        JSON.stringify({
          type: "result",
          summary: "stop",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 2,
            costUsd: 0.00042,
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "result",
        ts,
        text: "stop",
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 2,
        costUsd: 0.00042,
        subtype: "result",
        isError: false,
        errors: [],
      },
    ]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("qwen_local cli formatter", () => {
  it("prints session, assistant, and result events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printQwenStreamEvent(
        JSON.stringify({
          type: "system",
          sessionId: "ses_abc",
          model: "qwen3-coder-plus",
        }),
        false,
      );
      printQwenStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: { content: "hello" },
        }),
        false,
      );
      printQwenStreamEvent(
        JSON.stringify({
          type: "result",
          summary: "completed",
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.00042 },
        }),
        false,
      );

      const lines = spy.mock.calls
        .map((call) => call.map((v) => String(v)).join(" "))
        .map(stripAnsi);

      expect(lines).toEqual(
        expect.arrayContaining([
          "session started (ses_abc) model=qwen3-coder-plus",
          "assistant: hello",
          "result: completed",
          "tokens: in=10 out=5 cost=$0.000420",
        ]),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
