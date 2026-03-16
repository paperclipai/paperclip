import { describe, expect, it, vi } from "vitest";
import { isCodexUnknownSessionError, parseCodexJsonl } from "@paperclipai/adapter-codex-local/server";
import { parseCodexStdoutLine } from "@paperclipai/adapter-codex-local/ui";
import { printCodexStreamEvent } from "@paperclipai/adapter-codex-local/cli";

describe("codex_local parser", () => {
  it("extracts session, summary, usage, and terminal error message", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 } }),
      JSON.stringify({ type: "turn.failed", error: { message: "model access denied" } }),
    ].join("\n");

    const parsed = parseCodexJsonl(stdout);
    expect(parsed.sessionId).toBe("thread-123");
    expect(parsed.summary).toBe("hello");
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
    });
    expect(parsed.errorMessage).toBe("model access denied");
  });
});

describe("codex_local stale session detection", () => {
  it("treats missing rollout path as an unknown session error", () => {
    const stderr =
      "2026-02-19T19:58:53.281939Z ERROR codex_core::rollout::list: state db missing rollout path for thread 019c775d-967c-7ef1-acc7-e396dc2c87cc";

    expect(isCodexUnknownSessionError("", stderr)).toBe(true);
  });
});

describe("codex_local ui stdout parser", () => {
  it("parses turn and reasoning lifecycle events", () => {
    const ts = "2026-02-20T00:00:00.000Z";

    expect(parseCodexStdoutLine(JSON.stringify({ type: "turn.started" }), ts)).toEqual([
      { kind: "system", ts, text: "turn started" },
    ]);

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_1", type: "reasoning", text: "**Preparing to use paperclip skill**" },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "thinking", ts, text: "**Preparing to use paperclip skill**" },
    ]);
  });

  it("parses command execution and file changes", () => {
    const ts = "2026-02-20T00:00:00.000Z";

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "item.started",
          item: { id: "item_2", type: "command_execution", command: "/bin/zsh -lc ls", status: "in_progress" },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "command_execution",
        input: { id: "item_2", command: "/bin/zsh -lc ls" },
      },
    ]);

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_2",
            type: "command_execution",
            command: "/bin/zsh -lc ls",
            aggregated_output: "agents\n",
            exit_code: 0,
            status: "completed",
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "item_2",
        content: "command: /bin/zsh -lc ls\nstatus: completed\nexit_code: 0\n\nagents",
        isError: false,
      },
    ]);

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_52",
            type: "file_change",
            changes: [{ path: "/home/user/project/ui/src/pages/AgentDetail.tsx", kind: "update" }],
            status: "completed",
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "system",
        ts,
        text: "file changes: update /home/user/project/ui/src/pages/AgentDetail.tsx",
      },
    ]);
  });

  it("parses error items and failed turns", () => {
    const ts = "2026-02-20T00:00:00.000Z";

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_0",
            type: "error",
            message: "This session was recorded with model `gpt-5.2-pro` but is resuming with `gpt-5.2-codex`.",
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "stderr",
        ts,
        text: "This session was recorded with model `gpt-5.2-pro` but is resuming with `gpt-5.2-codex`.",
      },
    ]);

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "turn.failed",
          error: { message: "model access denied" },
          usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "result",
        ts,
        text: "",
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 2,
        costUsd: 0,
        subtype: "turn.failed",
        isError: true,
        errors: ["model access denied"],
      },
    ]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("codex_local cli formatter", () => {
  it("prints lifecycle, command execution, file change, and error events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printCodexStreamEvent(JSON.stringify({ type: "turn.started" }), false);
      printCodexStreamEvent(
        JSON.stringify({
          type: "item.started",
          item: { id: "item_2", type: "command_execution", command: "/bin/zsh -lc ls", status: "in_progress" },
        }),
        false,
      );
      printCodexStreamEvent(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_2",
            type: "command_execution",
            command: "/bin/zsh -lc ls",
            aggregated_output: "agents\n",
            exit_code: 0,
            status: "completed",
          },
        }),
        false,
      );
      printCodexStreamEvent(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_52",
            type: "file_change",
            changes: [{ path: "/home/user/project/ui/src/pages/AgentDetail.tsx", kind: "update" }],
            status: "completed",
          },
        }),
        false,
      );
      printCodexStreamEvent(
        JSON.stringify({
          type: "turn.failed",
          error: { message: "model access denied" },
          usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
        }),
        false,
      );
      printCodexStreamEvent(
        JSON.stringify({
          type: "item.completed",
          item: { type: "error", message: "resume model mismatch" },
        }),
        false,
      );

      const lines = spy.mock.calls
        .map((call) => call.map((v) => String(v)).join(" "))
        .map(stripAnsi);

      expect(lines).toEqual(expect.arrayContaining([
        "turn started",
        "tool_call: command_execution",
        "/bin/zsh -lc ls",
        "tool_result: command_execution command=\"/bin/zsh -lc ls\" status=completed exit_code=0",
        "agents",
        "file_change: update /home/user/project/ui/src/pages/AgentDetail.tsx",
        "turn failed: model access denied",
        "tokens: in=10 out=4 cached=2",
        "error: resume model mismatch",
      ]));
    } finally {
      spy.mockRestore();
    }
  });
});
