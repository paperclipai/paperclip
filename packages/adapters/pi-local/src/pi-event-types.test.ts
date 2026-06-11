import { describe, expect, it } from "vitest";
import {
  PI_DELTA,
  PI_DELTA_EVENT_TYPES,
  isDroppableDeltaLine,
  rewriteToolResultLine,
} from "./pi-event-types.js";
import { parsePiJsonl } from "./server/parse.js";

// These tests duplicate part of `server/parse.test.ts` intentionally — the
// constants now live in this UI-safe module and consumers can import either
// directly. Keeping the unit coverage colocated with the definition prevents
// regressions if the server-side re-export is ever moved.

describe("PI_DELTA constants (UI-safe module)", () => {
  it("matches the three known accumulated-state delta event types", () => {
    expect([...PI_DELTA_EVENT_TYPES].sort()).toEqual(
      ["text_delta", "thinking_delta", "toolcall_delta"].sort(),
    );
  });

  it("exposes per-name accessors via PI_DELTA", () => {
    expect(PI_DELTA.thinking).toBe("thinking_delta");
    expect(PI_DELTA.text).toBe("text_delta");
    expect(PI_DELTA.toolcall).toBe("toolcall_delta");
  });
});

describe("isDroppableDeltaLine (UI-safe module)", () => {
  it("drops message_update events for each delta type", () => {
    for (const deltaType of PI_DELTA_EVENT_TYPES) {
      const line = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: deltaType, delta: "x" },
      });
      expect(isDroppableDeltaLine(line)).toBe(true);
    }
  });

  it("keeps message_update events for *_end variants", () => {
    for (const endType of ["thinking_end", "text_end", "message_end"]) {
      const line = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: endType, content: "consolidated" },
      });
      expect(isDroppableDeltaLine(line)).toBe(false);
    }
  });

  it("passes through non-JSON lines and unrelated _delta substrings", () => {
    expect(isDroppableDeltaLine("not json")).toBe(false);
    expect(isDroppableDeltaLine("")).toBe(false);
    const line = JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: "discussing thinking_delta" }],
    });
    expect(isDroppableDeltaLine(line)).toBe(false);
  });
});

describe("rewriteToolResultLine", () => {
  const HEAD = 64 * 1024;
  const TAIL = 16 * 1024;
  const THRESHOLD = HEAD + TAIL; // 80 KiB

  const toolEndLine = (result: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "tc_1",
      toolName: "Bash",
      result,
      isError: false,
      ...extra,
    });

  it("passes a small tool_execution_end line through unchanged", () => {
    const line = toolEndLine("hello world");
    expect(rewriteToolResultLine(line)).toBe(line);
  });

  it("truncates an oversize tool_execution_end result with a marker", () => {
    const original = "A".repeat(HEAD) + "M".repeat(2_000_000) + "B".repeat(TAIL);
    const line = toolEndLine(original);
    const rewritten = rewriteToolResultLine(line);
    expect(rewritten).not.toBe(line);

    const parsed = JSON.parse(rewritten) as Record<string, unknown>;
    expect(parsed.type).toBe("tool_execution_end");
    expect(parsed.toolCallId).toBe("tc_1");
    expect(parsed.toolName).toBe("Bash");
    expect(parsed.isError).toBe(false);

    const result = parsed.result as string;
    expect(result.startsWith("A".repeat(HEAD))).toBe(true);
    expect(result.endsWith("B".repeat(TAIL))).toBe(true);
    expect(result).toContain("[paperclip] dropped 2000000 bytes from tool result");
    // Total length: head + tail + the marker line. Well under 1MiB.
    expect(result.length).toBeLessThan(THRESHOLD + 1024);
  });

  it("respects the threshold boundary", () => {
    const atThreshold = toolEndLine("x".repeat(THRESHOLD));
    expect(rewriteToolResultLine(atThreshold)).toBe(atThreshold);

    const overThreshold = toolEndLine("x".repeat(THRESHOLD + 1));
    expect(rewriteToolResultLine(overThreshold)).not.toBe(overThreshold);
  });

  it("passes through tool_execution_end when result is not a string", () => {
    const objectResult = toolEndLine({ stdout: "x".repeat(THRESHOLD + 1) });
    expect(rewriteToolResultLine(objectResult)).toBe(objectResult);

    const nullResult = toolEndLine(null);
    expect(rewriteToolResultLine(nullResult)).toBe(nullResult);
  });

  it("strips a non-empty turn_end.toolResults array", () => {
    const big = "y".repeat(THRESHOLD + 1);
    const line = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 2, cacheRead: 0, cost: { total: 0.5 } },
      },
      toolResults: [{ toolCallId: "tc_1", content: big, isError: false }],
    });

    const rewritten = rewriteToolResultLine(line);
    const parsed = JSON.parse(rewritten) as Record<string, unknown>;
    expect(parsed.toolResults).toEqual([]);
    // Other fields are preserved.
    expect((parsed.message as Record<string, unknown>).role).toBe("assistant");
    expect(rewritten.length).toBeLessThan(line.length);
  });

  it("passes through turn_end with an empty toolResults array", () => {
    const line = JSON.stringify({
      type: "turn_end",
      message: { role: "assistant", content: [] },
      toolResults: [],
    });
    expect(rewriteToolResultLine(line)).toBe(line);
  });

  it("passes through unrelated event types", () => {
    const lines = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "tc_1", toolName: "Bash", args: {} }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "x" },
      }),
    ];
    for (const line of lines) {
      expect(rewriteToolResultLine(line)).toBe(line);
    }
  });

  it("passes through invalid JSON that contains the trigger substring", () => {
    expect(rewriteToolResultLine('{"type":"tool_execution_end"')).toBe(
      '{"type":"tool_execution_end"',
    );
    expect(rewriteToolResultLine('not json with "turn_end" inside')).toBe(
      'not json with "turn_end" inside',
    );
  });

  it("round-trips through parsePiJsonl with the truncation marker intact", () => {
    const original = "A".repeat(HEAD) + "M".repeat(1_000_000) + "B".repeat(TAIL);
    const startLine = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "tc_1",
      toolName: "Bash",
      args: { command: "noop" },
    });
    const endLine = toolEndLine(original);
    const rewritten = rewriteToolResultLine(endLine);

    const parsed = parsePiJsonl(`${startLine}\n${rewritten}\n`);
    expect(parsed.toolCalls).toHaveLength(1);
    const call = parsed.toolCalls[0]!;
    expect(call.toolCallId).toBe("tc_1");
    expect(call.toolName).toBe("Bash");
    expect(call.isError).toBe(false);
    expect(call.result).not.toBeNull();
    expect(call.result!).toContain("[paperclip] dropped 1000000 bytes from tool result");
    expect(call.result!.length).toBeLessThan(THRESHOLD + 1024);
  });
});
