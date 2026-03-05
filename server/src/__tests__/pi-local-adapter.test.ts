import { describe, expect, it, vi } from "vitest";
import { parsePiJsonl } from "@paperclipai/adapter-pi-local/server";
import { parsePiStdoutLine } from "@paperclipai/adapter-pi-local/ui";
import { printPiStreamEvent } from "@paperclipai/adapter-pi-local/cli";

describe("pi_local parser", () => {
  it("extracts session, summary, usage, provider/model, and cost", () => {
    const stdout = [
      JSON.stringify({ type: "session", id: "pi-session-123" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.3-codex",
          content: [{ type: "text", text: "hello from pi" }],
          usage: {
            input: 120,
            output: 8,
            cacheRead: 32,
            cost: { total: 0.00123 },
          },
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed).toEqual({
      sessionId: "pi-session-123",
      summary: "hello from pi",
      usage: {
        inputTokens: 120,
        cachedInputTokens: 32,
        outputTokens: 8,
      },
      errorMessage: null,
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      costUsd: 0.00123,
    });
  });
});

describe("pi_local ui stdout parser", () => {
  it("parses session, assistant messages, and turn summary", () => {
    const ts = "2026-03-01T00:00:00.000Z";

    expect(
      parsePiStdoutLine(JSON.stringify({ type: "session", id: "pi-session-1" }), ts),
    ).toEqual([
      {
        kind: "init",
        ts,
        model: "pi",
        sessionId: "pi-session-1",
      },
    ]);

    expect(
      parsePiStdoutLine(
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "**Plan**" },
              { type: "text", text: "hello" },
            ],
          },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "thinking", ts, text: "**Plan**" },
      { kind: "assistant", ts, text: "hello" },
    ]);

    expect(
      parsePiStdoutLine(
        JSON.stringify({
          type: "turn_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "done" }],
            usage: {
              input: 10,
              output: 2,
              cacheRead: 1,
              cost: { total: 0.0003 },
            },
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "result",
        ts,
        text: "done",
        inputTokens: 10,
        outputTokens: 2,
        cachedTokens: 1,
        costUsd: 0.0003,
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

describe("pi_local cli formatter", () => {
  it("prints session, assistant output, usage, and errors", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printPiStreamEvent(JSON.stringify({ type: "session", id: "pi-session-1" }), false);
      printPiStreamEvent(
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
        }),
        false,
      );
      printPiStreamEvent(
        JSON.stringify({
          type: "turn_end",
          message: {
            usage: { input: 10, output: 3, cacheRead: 1, cost: { total: 0.00042 } },
          },
        }),
        false,
      );
      printPiStreamEvent(JSON.stringify({ type: "error", message: "auth required" }), false);

      const lines = spy.mock.calls
        .map((call) => call.map((value) => String(value)).join(" "))
        .map(stripAnsi);

      expect(lines).toEqual(
        expect.arrayContaining([
          "pi session started (pi-session-1)",
          "assistant: hello",
          "tokens: in=10 out=3 cached=1 cost=$0.000420",
          "error: auth required",
        ]),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
