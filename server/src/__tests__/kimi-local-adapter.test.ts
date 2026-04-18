import { describe, expect, it, vi } from "vitest";
import {
  isKimiUnknownSessionError,
  isKimiMaxStepsError,
} from "@paperclipai/adapter-kimi-local/server";
import { parseKimiStdoutLine } from "@paperclipai/adapter-kimi-local/ui";
import { formatKimiStreamEvent } from "@paperclipai/adapter-kimi-local/cli";

describe("kimi_local session error detection", () => {
  it("detects session not found errors", () => {
    expect(
      isKimiUnknownSessionError({
        result: "Session not found",
      }),
    ).toBe(true);
  });

  it("detects unknown session id errors", () => {
    expect(
      isKimiUnknownSessionError({
        error: "Unknown session id",
      }),
    ).toBe(true);
  });

  it("detects invalid session errors", () => {
    expect(
      isKimiUnknownSessionError({
        errors: [{ message: "Invalid session" }],
      }),
    ).toBe(true);
  });

  it("detects Chinese session not found errors", () => {
    expect(
      isKimiUnknownSessionError({
        result: "会话不存在",
      }),
    ).toBe(true);
  });

  it("returns false for non-session errors", () => {
    expect(
      isKimiUnknownSessionError({
        result: "Some other error",
        error: "API rate limit exceeded",
      }),
    ).toBe(false);
  });
});

describe("kimi_local max steps detection", () => {
  it("detects max steps in result text", () => {
    expect(
      isKimiMaxStepsError({
        result: "Reached max steps",
      }),
    ).toBe(true);
  });

  it("detects maximum steps exceeded", () => {
    expect(
      isKimiMaxStepsError({
        result: "Maximum steps exceeded",
      }),
    ).toBe(true);
  });

  it("detects max steps in error array", () => {
    expect(
      isKimiMaxStepsError({
        errors: [{ message: "Max steps reached" }],
      }),
    ).toBe(true);
  });

  it("returns false for non-max-steps errors", () => {
    expect(
      isKimiMaxStepsError({
        result: "Authentication failed",
      }),
    ).toBe(false);
  });
});

describe("kimi_local ui stdout parser", () => {
  it("maps assistant text, thinking, tool calls, and tool results into transcript entries", () => {
    const ts = "2026-04-18T00:00:00.000Z";

    expect(
      parseKimiStdoutLine(
        JSON.stringify({
          role: "system",
          type: "init",
          model: "kimi-k2-0713",
          session_id: "kimi-session-1",
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "init",
        ts,
        model: "kimi-k2-0713",
        sessionId: "kimi-session-1",
      },
    ]);

    expect(
      parseKimiStdoutLine(
        JSON.stringify({
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect the repo." },
            { type: "think", think: "Checking the adapter wiring" },
            { type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls -1" } },
          ],
        }),
        ts,
      ),
    ).toEqual([
      { kind: "assistant", ts, text: "I will inspect the repo." },
      { kind: "thinking", ts, text: "Checking the adapter wiring" },
      { kind: "tool_call", ts, name: "bash", toolUseId: "tool_1", input: { command: "ls -1" } },
    ]);

    expect(
      parseKimiStdoutLine(
        JSON.stringify({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "AGENTS.md\nREADME.md",
              is_error: false,
            },
          ],
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

  it("parses result with usage and cost", () => {
    const ts = "2026-04-18T00:00:00.000Z";

    const result = parseKimiStdoutLine(
      JSON.stringify({
        type: "result",
        done: true,
        result: "Task completed",
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
        text: "Task completed",
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
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("kimi_local cli formatter", () => {
  it("prints the user-visible and background transcript events from stream-json output", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      formatKimiStreamEvent(
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "I will inspect the repo." }],
        }),
        false,
      );

      formatKimiStreamEvent(
        JSON.stringify({
          role: "assistant",
          content: [{ type: "think", think: "Checking the adapter wiring" }],
        }),
        false,
      );

      formatKimiStreamEvent(
        JSON.stringify({
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls -1" } }],
        }),
        false,
      );

      formatKimiStreamEvent(
        JSON.stringify({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "AGENTS.md\nREADME.md",
              is_error: false,
            },
          ],
        }),
        false,
      );

      formatKimiStreamEvent(
        JSON.stringify({
          type: "result",
          done: true,
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
          "I will inspect the repo.",
          "[thinking] Checking the adapter wiring",
          expect.stringContaining("[tool: bash]"),
          expect.stringContaining("AGENTS.md"),
          expect.stringContaining("README.md"),
          expect.stringContaining("Tokens: 10 in / 5 out"),
          expect.stringContaining("Cost: $0.0004"),
        ]),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
