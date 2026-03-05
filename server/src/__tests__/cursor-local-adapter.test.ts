import { describe, expect, it, vi } from "vitest";
import { isCursorUnknownSessionError, parseCursorJsonl } from "@paperclipai/adapter-cursor-local/server";
import { parseCursorStdoutLine } from "@paperclipai/adapter-cursor-local/ui";
import { printCursorStreamEvent } from "@paperclipai/adapter-cursor-local/cli";

describe("cursor parser", () => {
  it("extracts session, summary, usage, cost, and terminal error message", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "chat_123", model: "gpt-5" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "output_text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "chat_123",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 25,
          output_tokens: 40,
        },
        total_cost_usd: 0.001,
        result: "Task complete",
      }),
      JSON.stringify({ type: "error", message: "model access denied" }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.sessionId).toBe("chat_123");
    expect(parsed.summary).toBe("hello");
    expect(parsed.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 40,
    });
    expect(parsed.costUsd).toBeCloseTo(0.001, 6);
    expect(parsed.errorMessage).toBe("model access denied");
  });

  it("parses multiplexed stdout-prefixed json lines", () => {
    const stdout = [
      'stdout{"type":"system","subtype":"init","session_id":"chat_prefixed","model":"gpt-5"}',
      'stdout{"type":"assistant","message":{"content":[{"type":"output_text","text":"prefixed hello"}]}}',
      'stdout{"type":"result","subtype":"success","usage":{"input_tokens":3,"output_tokens":2,"cached_input_tokens":1},"total_cost_usd":0.0001}',
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.sessionId).toBe("chat_prefixed");
    expect(parsed.summary).toBe("prefixed hello");
    expect(parsed.usage).toEqual({
      inputTokens: 3,
      cachedInputTokens: 1,
      outputTokens: 2,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0001, 6);
  });
});

describe("cursor stale session detection", () => {
  it("treats missing/unknown session messages as an unknown session error", () => {
    expect(isCursorUnknownSessionError("", "unknown session id chat_123")).toBe(true);
    expect(isCursorUnknownSessionError("", "chat abc not found")).toBe(true);
  });
});

describe("cursor ui stdout parser", () => {
  it("parses assistant, thinking, and tool lifecycle events", () => {
    const ts = "2026-03-05T00:00:00.000Z";

    expect(
      parseCursorStdoutLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "output_text", text: "I will run a command." },
              { type: "thinking", text: "Checking repository state" },
              { type: "tool_call", name: "bash", input: { command: "ls -1" } },
              { type: "tool_result", tool_use_id: "tool_1", output: "AGENTS.md\n", status: "ok" },
            ],
          },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "assistant", ts, text: "I will run a command." },
      { kind: "thinking", ts, text: "Checking repository state" },
      { kind: "tool_call", ts, name: "bash", input: { command: "ls -1" } },
      { kind: "tool_result", ts, toolUseId: "tool_1", content: "AGENTS.md\n", isError: false },
    ]);
  });

  it("parses result usage and errors", () => {
    const ts = "2026-03-05T00:00:00.000Z";
    expect(
      parseCursorStdoutLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Done",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cached_input_tokens: 2,
          },
          total_cost_usd: 0.00042,
          is_error: false,
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "result",
        ts,
        text: "Done",
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 2,
        costUsd: 0.00042,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("parses stdout-prefixed json lines", () => {
    const ts = "2026-03-05T00:00:00.000Z";
    expect(
      parseCursorStdoutLine(
        'stdout{"type":"assistant","message":{"content":[{"type":"thinking","text":"streamed"}]}}',
        ts,
      ),
    ).toEqual([{ kind: "thinking", ts, text: "streamed" }]);
  });

  it("compacts shellToolCall and shell tool result for run log", () => {
    const ts = "2026-03-05T00:00:00.000Z";
    const longCommand = "curl -s -X POST \"$PAPERCLIP_API_URL/api/issues/abc/checkout\" -H \"Authorization: Bearer $PAPERCLIP_API_KEY\"";

    expect(
      parseCursorStdoutLine(
        JSON.stringify({
          type: "tool_call",
          subtype: "started",
          call_id: "call_shell_1",
          tool_call: {
            shellToolCall: {
              command: longCommand,
              workingDirectory: "/tmp",
              timeout: 30000,
              toolCallId: "tool_xyz",
              simpleCommands: ["curl"],
              parsingResult: { parsingFailed: false, executableCommands: [] },
            },
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "shellToolCall",
        input: { command: longCommand },
      },
    ]);

    expect(
      parseCursorStdoutLine(
        JSON.stringify({
          type: "tool_call",
          subtype: "completed",
          call_id: "call_shell_1",
          tool_call: {
            shellToolCall: {
              result: {
                success: {
                  command: longCommand,
                  exitCode: 0,
                  stdout: '{"id":"abc","status":"in_progress"}',
                  stderr: "",
                  executionTime: 100,
                },
              },
            },
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "call_shell_1",
        content: "exit 0\n<stdout>\n{\"id\":\"abc\",\"status\":\"in_progress\"}",
        isError: false,
      },
    ]);
  });

  it("parses user, top-level thinking, and top-level tool_call events", () => {
    const ts = "2026-03-05T00:00:00.000Z";

    expect(
      parseCursorStdoutLine(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "Please inspect README.md" }],
          },
        }),
        ts,
      ),
    ).toEqual([{ kind: "user", ts, text: "Please inspect README.md" }]);

    expect(
      parseCursorStdoutLine(
        JSON.stringify({
          type: "thinking",
          subtype: "delta",
          text: "planning next command",
        }),
        ts,
      ),
    ).toEqual([{ kind: "thinking", ts, text: "planning next command", delta: true }]);

    expect(
      parseCursorStdoutLine(
        JSON.stringify({
          type: "thinking",
          subtype: "delta",
          text: " with preserved leading space",
        }),
        ts,
      ),
    ).toEqual([{ kind: "thinking", ts, text: " with preserved leading space", delta: true }]);

    expect(
      parseCursorStdoutLine(
        JSON.stringify({
          type: "tool_call",
          subtype: "started",
          call_id: "call_1",
          tool_call: {
            readToolCall: {
              args: { path: "README.md" },
            },
          },
        }),
        ts,
      ),
    ).toEqual([{ kind: "tool_call", ts, name: "readToolCall", input: { path: "README.md" } }]);

    expect(
      parseCursorStdoutLine(
        JSON.stringify({
          type: "tool_call",
          subtype: "completed",
          call_id: "call_1",
          tool_call: {
            readToolCall: {
              result: { success: { content: "README contents" } },
            },
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "call_1",
        content: '{\n  "success": {\n    "content": "README contents"\n  }\n}',
        isError: false,
      },
    ]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("cursor cli formatter", () => {
  it("prints init, user, assistant, tool, and result events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printCursorStreamEvent(
        JSON.stringify({ type: "system", subtype: "init", session_id: "chat_abc", model: "gpt-5" }),
        false,
      );
      printCursorStreamEvent(
        JSON.stringify({
          type: "user",
          message: {
            content: [{ type: "text", text: "run tests" }],
          },
        }),
        false,
      );
      printCursorStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "output_text", text: "hello" }],
          },
        }),
        false,
      );
      printCursorStreamEvent(
        JSON.stringify({
          type: "thinking",
          subtype: "delta",
          text: "looking at package.json",
        }),
        false,
      );
      printCursorStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_call", name: "bash", input: { command: "ls -1" } }],
          },
        }),
        false,
      );
      printCursorStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_result", output: "AGENTS.md", status: "ok" }],
          },
        }),
        false,
      );
      printCursorStreamEvent(
        JSON.stringify({
          type: "tool_call",
          subtype: "started",
          call_id: "call_1",
          tool_call: {
            readToolCall: {
              args: { path: "README.md" },
            },
          },
        }),
        false,
      );
      printCursorStreamEvent(
        JSON.stringify({
          type: "tool_call",
          subtype: "completed",
          call_id: "call_1",
          tool_call: {
            readToolCall: {
              result: { success: { content: "README contents" } },
            },
          },
        }),
        false,
      );
      printCursorStreamEvent(
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Done",
          usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 },
          total_cost_usd: 0.00042,
        }),
        false,
      );

      const lines = spy.mock.calls
        .map((call) => call.map((v) => String(v)).join(" "))
        .map(stripAnsi);

      expect(lines).toEqual(
        expect.arrayContaining([
          "Cursor init (session: chat_abc, model: gpt-5)",
          "user: run tests",
          "assistant: hello",
          "thinking: looking at package.json",
          "tool_call: bash",
          "tool_call: readToolCall (call_1)",
          "tool_result (call_1)",
          '{\n  "success": {\n    "content": "README contents"\n  }\n}',
          "tool_result",
          "AGENTS.md",
          "result: subtype=success",
          "tokens: in=10 out=5 cached=2 cost=$0.000420",
          "assistant: Done",
        ]),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
