// Tests for Antigravity local adapter parser, error detection, UI parser, and CLI formatter
import { describe, expect, it, vi } from "vitest";
import {
  isAntigravitySessionUnrecoverableError,
  isAntigravityAuthError,
  parseAntigravityJsonl,
} from "@paperclipai/adapter-antigravity-local/server";
import { parseAntigravityStdoutLine } from "@paperclipai/adapter-antigravity-local/ui";
import { printAntigravityStreamEvent } from "@paperclipai/adapter-antigravity-local/cli";

describe("antigravity_local parser", () => {
  it("extracts session, summary, usage, and cost from stream-json output", () => {
    const stdout = [
      JSON.stringify({ event: "init", conversation_id: "agy-conv-123" }),
      JSON.stringify({
        event: "step_update",
        step: {
          index: 0,
          type: "PLANNER_RESPONSE",
          content: "Starting task analysis.",
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "Task completed successfully.",
          usage: {
            input_tokens: 150,
            output_tokens: 45,
          },
          cost_usd: 0.0025,
        },
      }),
    ].join("\n");

    const parsed = parseAntigravityJsonl(stdout);
    expect(parsed.sessionId).toBe("agy-conv-123");
    expect(parsed.summary).toBe("Task completed successfully.");
    expect(parsed.usage).toMatchObject({
      inputTokens: 150,
      outputTokens: 45,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
  });

  it("handles error events and extracts error message", () => {
    const stdout = [
      JSON.stringify({ event: "init", conversation_id: "agy-conv-err" }),
      JSON.stringify({
        event: "error",
        message: "Model quota exceeded",
      }),
    ].join("\n");

    const parsed = parseAntigravityJsonl(stdout);
    expect(parsed.sessionId).toBe("agy-conv-err");
    expect(parsed.errorMessage).toBe("Model quota exceeded");
  });

  it("handles non-JSON lines and warnings gracefully", () => {
    const stdout = [
      'warning: conversation "stale-1" not found, starting a new one',
      JSON.stringify({ event: "init", conversation_id: "fresh-conv-1" }),
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "All good.",
        },
      }),
    ].join("\n");

    const parsed = parseAntigravityJsonl(stdout);
    expect(parsed.sessionId).toBe("fresh-conv-1");
    expect(parsed.summary).toBe("All good.");
  });
});

describe("antigravity_local session recovery detection", () => {
  it("detects conversation not found in stdout and stderr", () => {
    expect(isAntigravitySessionUnrecoverableError('warning: conversation "c-123" not found', "")).toBe(true);
    expect(isAntigravitySessionUnrecoverableError("", "Error: conversation not found")).toBe(true);
    expect(isAntigravitySessionUnrecoverableError('failed to resume session: stale session id', "")).toBe(true);
    expect(isAntigravitySessionUnrecoverableError('{"event":"result"}', "")).toBe(false);
  });
});

describe("antigravity_local auth error detection", () => {
  it("detects authentication requirements in stdout and stderr", () => {
    expect(isAntigravityAuthError("", "Please run 'agy auth login' to authenticate")).toBe(true);
    expect(isAntigravityAuthError("Error: unauthorized access", "")).toBe(true);
    expect(isAntigravityAuthError("not authenticated with provider", "")).toBe(true);
    expect(isAntigravityAuthError("Regular message content", "")).toBe(false);
  });
});

describe("antigravity_local ui stdout parser", () => {
  it("parses init, step_update, result, and error events into TranscriptEntries", () => {
    const ts = "2026-03-08T00:00:00.000Z";

    const initEntries = parseAntigravityStdoutLine(
      JSON.stringify({ event: "init", conversation_id: "conv-ui-1" }),
      ts,
    );
    expect(initEntries[0]).toMatchObject({
      kind: "init",
      ts,
      sessionId: "conv-ui-1",
    });

    const stepEntries = parseAntigravityStdoutLine(
      JSON.stringify({
        event: "step_update",
        step: {
          index: 0,
          type: "PLANNER_RESPONSE",
          content: "Analyzing workspace.",
        },
      }),
      ts,
    );
    expect(stepEntries).toEqual([
      { kind: "assistant", ts, text: "Analyzing workspace." },
    ]);

    const resultEntries = parseAntigravityStdoutLine(
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "Work finished.",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
          cost_usd: 0.001,
        },
      }),
      ts,
    );
    expect(resultEntries[0]).toMatchObject({
      kind: "result",
      ts,
      text: "Work finished.",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
      subtype: "success",
      isError: false,
      errors: [],
    });
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("antigravity_local cli formatter", () => {
  it("prints init, assistant steps, results, and errors", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let joined = "";

    try {
      printAntigravityStreamEvent(
        JSON.stringify({ event: "init", conversation_id: "conv-cli-1" }),
        false,
      );
      printAntigravityStreamEvent(
        JSON.stringify({
          event: "step_update",
          step: {
            index: 0,
            type: "PLANNER_RESPONSE",
            content: "inspecting files",
          },
        }),
        false,
      );
      printAntigravityStreamEvent(
        JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "Done",
            usage: {
              input_tokens: 50,
              output_tokens: 10,
            },
            cost_usd: 0.0005,
          },
        }),
        false,
      );
      printAntigravityStreamEvent(
        JSON.stringify({ event: "error", message: "command error" }),
        false,
      );
      joined = spy.mock.calls.map((call) => stripAnsi(call.join(" "))).join("\n");
    } finally {
      spy.mockRestore();
    }

    expect(joined).toContain("Antigravity init (session: conv-cli-1)");
    expect(joined).toContain("inspecting files");
    expect(joined).toContain("tokens: in=50 out=10");
    expect(joined).toContain("error: command error");
  });
});
