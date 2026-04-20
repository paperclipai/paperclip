import { describe, expect, it, vi } from "vitest";
import { isClaudeMaxTurnsResult } from "@paperclipai/adapter-claude-local/server";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
import { printClaudeStreamEvent } from "@paperclipai/adapter-claude-local/cli";

describe("claude_local max-turn detection", () => {
  it("detects max-turn exhaustion by subtype", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "error_max_turns",
        result: "Reached max turns",
      }),
    ).toBe(true);
  });

  it("detects max-turn exhaustion by stop_reason", () => {
    expect(
      isClaudeMaxTurnsResult({
        stop_reason: "max_turns",
      }),
    ).toBe(true);
  });

  it("returns false for non-max-turn results", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "success",
        stop_reason: "end_turn",
      }),
    ).toBe(false);
  });
});

describe("claude_local ui stdout parser", () => {
  it("maps assistant text, thinking, tool calls, and tool results into transcript entries", () => {
    const ts = "2026-03-29T00:00:00.000Z";

    expect(
      parseClaudeStdoutLine(
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4-6",
          session_id: "claude-session-1",
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "init",
        ts,
        model: "claude-sonnet-4-6",
        sessionId: "claude-session-1",
      },
    ]);

    expect(
      parseClaudeStdoutLine(
        JSON.stringify({
          type: "assistant",
          session_id: "claude-session-1",
          message: {
            content: [
              { type: "text", text: "I will inspect the repo." },
              { type: "thinking", thinking: "Checking the adapter wiring" },
              { type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls -1" } },
            ],
          },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "assistant", ts, text: "I will inspect the repo." },
      { kind: "thinking", ts, text: "Checking the adapter wiring" },
      { kind: "tool_call", ts, name: "bash", toolUseId: "tool_1", input: { command: "ls -1" } },
    ]);

    expect(
      parseClaudeStdoutLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: [{ type: "text", text: "AGENTS.md\nREADME.md" }],
                is_error: false,
              },
            ],
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tool_1",
        content: "AGENTS.md\nREADME.md",
        isError: false,
      },
    ]);
  });
});

function stripAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("claude_local cli formatter", () => {
  it("prints the user-visible and background transcript events from stream-json output", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printClaudeStreamEvent(
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4-6",
          session_id: "claude-session-1",
        }),
        false,
      );
      printClaudeStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "I will inspect the repo." },
              { type: "thinking", thinking: "Checking the adapter wiring" },
              { type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls -1" } },
            ],
          },
        }),
        false,
      );
      printClaudeStreamEvent(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: [{ type: "text", text: "AGENTS.md\nREADME.md" }],
                is_error: false,
              },
            ],
          },
        }),
        false,
      );
      printClaudeStreamEvent(
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Done",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
          total_cost_usd: 0.00042,
        }),
        false,
      );

      const lines = spy.mock.calls
        .map((call) => call.map((value) => String(value)).join(" "))
        .map(stripAnsi);

      expect(lines).toEqual(
        expect.arrayContaining([
          "Claude initialized (model: claude-sonnet-4-6, session: claude-session-1)",
          "assistant: I will inspect the repo.",
          "thinking: Checking the adapter wiring",
          "tool_call: bash",
          '{\n  "command": "ls -1"\n}',
          "tool_result",
          "AGENTS.md\nREADME.md",
          "result:",
          "Done",
          "tokens: in=10 out=5 cached=2 cost=$0.000420",
        ]),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
