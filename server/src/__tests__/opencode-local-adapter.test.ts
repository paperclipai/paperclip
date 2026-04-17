import { describe, expect, it, vi } from "vitest";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl } from "@paperclipai/adapter-opencode-local/server";
import { parseOpenCodeStdoutLine } from "@paperclipai/adapter-opencode-local/ui";
import { printOpenCodeStreamEvent } from "@paperclipai/adapter-opencode-local/cli";

describe("opencode_local parser", () => {
  it("extracts session, summary, usage, cost, and terminal error message", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_123" }),
      JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }),
      JSON.stringify({
        type: "step_finish",
        part: {
          reason: "tool-calls",
          cost: 0.001,
          tokens: {
            input: 100,
            output: 40,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        part: {
          reason: "stop",
          cost: 0.002,
          tokens: {
            input: 50,
            output: 25,
            cache: { read: 10, write: 0 },
          },
        },
      }),
      JSON.stringify({ type: "error", message: "model access denied" }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("ses_123");
    expect(parsed.summary).toBe("hello");
    expect(parsed.usage).toEqual({
      inputTokens: 150,
      cachedInputTokens: 30,
      outputTokens: 65,
    });
    expect(parsed.costUsd).toBeCloseTo(0.003, 6);
    expect(parsed.errorMessage).toBe("model access denied");
    expect(parsed.toolErrorMessages).toEqual([]);
  });

  it("does not treat tool_use failures as terminal adapter errors", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_123" }),
      JSON.stringify({
        type: "tool_use",
        part: {
          type: "tool_use",
          tool: "read",
          state: {
            status: "error",
            error: "missing file",
          },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        part: {
          reason: "stop",
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            cache: { read: 0, write: 0 },
          },
        },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrorMessages).toEqual(["missing file"]);
  });
});

describe("opencode_local stale session detection", () => {
  it("treats missing persisted session file as an unknown session error", () => {
    const stderr =
      "NotFoundError: Resource not found: /Users/test/.local/share/opencode/storage/session/project/ses_missing.json";

    expect(isOpenCodeUnknownSessionError("", stderr)).toBe(true);
  });
});

describe("opencode_local ui stdout parser", () => {
  it("parses assistant and tool lifecycle events", () => {
    const ts = "2026-03-04T00:00:00.000Z";

    expect(
      parseOpenCodeStdoutLine(
        JSON.stringify({
          type: "text",
          part: {
            type: "text",
            text: "I will run a command.",
          },
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
      parseOpenCodeStdoutLine(
        JSON.stringify({
          type: "tool_use",
          part: {
            id: "prt_tool_1",
            callID: "call_1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls -1" },
              output: "AGENTS.md\nDockerfile\n",
              metadata: { exit: 0 },
            },
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "bash",
        toolUseId: "call_1",
        input: { command: "ls -1" },
      },
      {
        kind: "tool_result",
        ts,
        toolUseId: "call_1",
        content: "status: completed\nexit: 0\n\nAGENTS.md\nDockerfile",
        isError: false,
      },
    ]);
  });

  it("parses finished steps into usage-aware results", () => {
    const ts = "2026-03-04T00:00:00.000Z";
    expect(
      parseOpenCodeStdoutLine(
        JSON.stringify({
          type: "step_finish",
          part: {
            reason: "stop",
            cost: 0.00042,
            tokens: {
              input: 10,
              output: 5,
              cache: { read: 2, write: 0 },
            },
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
        subtype: "stop",
        isError: false,
        errors: [],
      },
    ]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("opencode_local cli formatter", () => {
  it("prints step, assistant, tool, and result events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printOpenCodeStreamEvent(
        JSON.stringify({ type: "step_start", sessionID: "ses_abc" }),
        false,
      );
      printOpenCodeStreamEvent(
        JSON.stringify({
          type: "text",
          part: { type: "text", text: "hello" },
        }),
        false,
      );
      printOpenCodeStreamEvent(
        JSON.stringify({
          type: "tool_use",
          part: {
            callID: "call_1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls -1" },
              output: "AGENTS.md\n",
              metadata: { exit: 0 },
            },
          },
        }),
        false,
      );
      printOpenCodeStreamEvent(
        JSON.stringify({
          type: "step_finish",
          part: {
            reason: "stop",
            cost: 0.00042,
            tokens: {
              input: 10,
              output: 5,
              cache: { read: 2, write: 0 },
            },
          },
        }),
        false,
      );

      const lines = spy.mock.calls
        .map((call) => call.map((v) => String(v)).join(" "))
        .map(stripAnsi);

      expect(lines).toEqual(
        expect.arrayContaining([
          "step started (session: ses_abc)",
          "assistant: hello",
          "tool_call: bash (call_1)",
          "tool_result status=completed exit=0",
          "AGENTS.md",
          "step finished: reason=stop",
          "tokens: in=10 out=5 cached=2 cost=$0.000420",
        ]),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
