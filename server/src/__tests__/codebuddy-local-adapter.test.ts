import { describe, expect, it, vi } from "vitest";
import {
  isCodeBuddyUnknownSessionError,
  parseCodeBuddyJsonl,
} from "@penclipai/adapter-codebuddy-local/server";
import { parseCodeBuddyStdoutLine } from "@penclipai/adapter-codebuddy-local/ui";
import { printCodeBuddyStreamEvent } from "@penclipai/adapter-codebuddy-local/cli";

describe("codebuddy parser", () => {
  it("extracts session, summary, usage, cost, and terminal error message", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "cb_123", model: "glm-5.0" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "output_text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "cb_123",
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

    const parsed = parseCodeBuddyJsonl(stdout);
    expect(parsed.sessionId).toBe("cb_123");
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
      'stdout{"type":"system","subtype":"init","session_id":"cb_prefixed","model":"glm-5.0"}',
      'stdout{"type":"assistant","message":{"content":[{"type":"output_text","text":"prefixed hello"}]}}',
      'stdout{"type":"result","subtype":"success","usage":{"input_tokens":3,"output_tokens":2,"cached_input_tokens":1},"total_cost_usd":0.0001}',
    ].join("\n");

    const parsed = parseCodeBuddyJsonl(stdout);
    expect(parsed.sessionId).toBe("cb_prefixed");
    expect(parsed.summary).toBe("prefixed hello");
    expect(parsed.usage).toEqual({
      inputTokens: 3,
      cachedInputTokens: 1,
      outputTokens: 2,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0001, 6);
  });
});

describe("codebuddy stale session detection", () => {
  it("treats missing/unknown session messages as an unknown session error", () => {
    expect(
      isCodeBuddyUnknownSessionError(
        "",
        "No conversation found with session ID: cb_123",
      ),
    ).toBe(true);
    expect(
      isCodeBuddyUnknownSessionError(
        "",
        "resume session not found",
      ),
    ).toBe(true);
  });
});

describe("codebuddy ui stdout parser", () => {
  it("parses assistant, thinking, and tool lifecycle events", () => {
    const ts = "2026-04-02T00:00:00.000Z";

    expect(
      parseCodeBuddyStdoutLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "output_text", text: "I will run a command." },
              { type: "thinking", text: "Checking repository state" },
              { type: "tool_call", name: "shellToolCall", input: { command: "ls -1" } },
              { type: "tool_result", tool_use_id: "tool_1", output: "AGENTS.md\n", status: "ok" },
            ],
          },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "assistant", ts, text: "I will run a command." },
      { kind: "thinking", ts, text: "Checking repository state" },
      { kind: "tool_call", ts, name: "shellToolCall", input: { command: "ls -1" } },
      { kind: "tool_result", ts, toolUseId: "tool_1", content: "AGENTS.md\n", isError: false },
    ]);
  });

  it("parses result usage and shell tool compaction", () => {
    const ts = "2026-04-02T00:00:00.000Z";

    expect(
      parseCodeBuddyStdoutLine(
        JSON.stringify({
          type: "tool_call",
          subtype: "started",
          call_id: "call_shell_1",
          tool_call: {
            shellToolCall: {
              command: "curl -s https://example.com",
              workingDirectory: "/tmp",
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
        toolUseId: "call_shell_1",
        input: { command: "curl -s https://example.com" },
      },
    ]);

    expect(
      parseCodeBuddyStdoutLine(
        JSON.stringify({
          type: "tool_call",
          subtype: "completed",
          call_id: "call_shell_1",
          tool_call: {
            shellToolCall: {
              result: {
                success: {
                  exitCode: 0,
                  stdout: "ok",
                  stderr: "",
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
        content: "exit 0\n<stdout>\nok",
        isError: false,
      },
    ]);

    expect(
      parseCodeBuddyStdoutLine(
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
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("codebuddy cli formatter", () => {
  it("prints init, user, assistant, tool, and result events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printCodeBuddyStreamEvent(
        JSON.stringify({ type: "system", subtype: "init", session_id: "cb_abc", model: "glm-5.0" }),
        false,
      );
      printCodeBuddyStreamEvent(
        JSON.stringify({
          type: "user",
          message: {
            content: [{ type: "text", text: "run tests" }],
          },
        }),
        false,
      );
      printCodeBuddyStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "output_text", text: "hello" }],
          },
        }),
        false,
      );
      printCodeBuddyStreamEvent(
        JSON.stringify({
          type: "thinking",
          subtype: "delta",
          text: "looking at package.json",
        }),
        false,
      );
      printCodeBuddyStreamEvent(
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
      printCodeBuddyStreamEvent(
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
      printCodeBuddyStreamEvent(
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
        .map((call) => call.map((value) => String(value)).join(" "))
        .map(stripAnsi);

      expect(lines).toEqual(
        expect.arrayContaining([
          "CodeBuddy init (session: cb_abc, model: glm-5.0)",
          "user: run tests",
          "assistant: hello",
          "thinking: looking at package.json",
          "tool_call: readToolCall (call_1)",
          "tool_result (call_1)",
          '{\n  "success": {\n    "content": "README contents"\n  }\n}',
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
