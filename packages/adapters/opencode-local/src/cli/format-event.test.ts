import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printOpenCodeStreamEvent } from "./format-event.js";

// printOpenCodeStreamEvent parses JSON stream events and writes to console.log.
// Tests verify routing logic and content extraction by spying on console.log.

describe("printOpenCodeStreamEvent", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  it("does nothing for empty string", () => {
    printOpenCodeStreamEvent("", false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does nothing for whitespace-only string", () => {
    printOpenCodeStreamEvent("   \n\t  ", false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logs raw text when input is not JSON", () => {
    printOpenCodeStreamEvent("plain text output", false);
    expect(logSpy).toHaveBeenCalledWith("plain text output");
  });

  it("logs raw text when JSON is an array (not a record)", () => {
    printOpenCodeStreamEvent(JSON.stringify([1, 2, 3]), false);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify([1, 2, 3]));
  });

  it("logs raw line for unknown event types", () => {
    const raw = JSON.stringify({ type: "unknown_event", data: "test" });
    printOpenCodeStreamEvent(raw, false);
    // Falls through to console.log(line)
    expect(logSpy).toHaveBeenCalledWith(raw);
  });

  // ── step_start ────────────────────────────────────────────────────────────

  it("logs step started without sessionID when not provided", () => {
    printOpenCodeStreamEvent(JSON.stringify({ type: "step_start" }), false);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("step started");
    expect(logSpy.mock.calls[0]?.[0]).not.toContain("session:");
  });

  it("logs step started with sessionID when provided", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "step_start", sessionID: "sess-abc" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("step started");
    expect(logSpy.mock.calls[0]?.[0]).toContain("session: sess-abc");
  });

  // ── text ─────────────────────────────────────────────────────────────────

  it("logs assistant message for text event with content", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "text", part: { text: "Hello, world!" } }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("assistant:");
    expect(logSpy.mock.calls[0]?.[0]).toContain("Hello, world!");
  });

  it("does not log for text event with empty text", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "text", part: { text: "   " } }),
      false,
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not log for text event with missing part", () => {
    printOpenCodeStreamEvent(JSON.stringify({ type: "text" }), false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  // ── reasoning ────────────────────────────────────────────────────────────

  it("logs thinking for reasoning event with content", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "reasoning", part: { text: "Let me think..." } }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("thinking:");
    expect(logSpy.mock.calls[0]?.[0]).toContain("Let me think...");
  });

  it("does not log for reasoning event with empty text", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "reasoning", part: { text: "" } }),
      false,
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  // ── tool_use ─────────────────────────────────────────────────────────────

  it("logs tool_call header for tool_use without status", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "tool_use", part: { tool: "read_file", callID: "call-1" } }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_call: read_file");
    expect(logSpy.mock.calls[0]?.[0]).toContain("call-1");
  });

  it("logs tool_call without callID when not provided", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "tool_use", part: { tool: "bash" } }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_call: bash");
    expect(logSpy.mock.calls[0]?.[0]).not.toContain("(");
  });

  it("logs tool_result with status when state is present", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "write_file",
          state: { status: "done", output: "file written" },
        },
      }),
      false,
    );
    // Should log tool_call line + tool_result line + output line
    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(logSpy.mock.calls[1]?.[0]).toContain("tool_result");
    expect(logSpy.mock.calls[1]?.[0]).toContain("status=done");
    expect(logSpy.mock.calls[2]?.[0]).toContain("file written");
  });

  it("logs error-style tool_result when status is error", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "bash",
          state: { status: "error", error: "command not found" },
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(logSpy.mock.calls[1]?.[0]).toContain("tool_result");
    expect(logSpy.mock.calls[1]?.[0]).toContain("status=error");
    expect(logSpy.mock.calls[2]?.[0]).toContain("command not found");
  });

  it("includes metadata fields in tool_result output", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "search",
          state: {
            status: "done",
            metadata: { exitCode: 0, duration: 150 },
          },
        },
      }),
      false,
    );
    const resultLine = logSpy.mock.calls[1]?.[0] as string;
    expect(resultLine).toContain("exitCode=0");
    expect(resultLine).toContain("duration=150");
  });

  // ── step_finish ───────────────────────────────────────────────────────────

  it("logs step finished with reason and token counts", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({
        type: "step_finish",
        part: {
          reason: "end_turn",
          tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20 } },
          cost: 0.0025,
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("step finished");
    expect(logSpy.mock.calls[0]?.[0]).toContain("reason=end_turn");
    expect(logSpy.mock.calls[1]?.[0]).toContain("in=100");
    expect(logSpy.mock.calls[1]?.[0]).toContain("out=60"); // output + reasoning
    expect(logSpy.mock.calls[1]?.[0]).toContain("cached=20");
  });

  it("logs step finished with zero values when tokens are missing", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({
        type: "step_finish",
        part: { reason: "stop" },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("reason=stop");
    expect(logSpy.mock.calls[1]?.[0]).toContain("in=0");
    expect(logSpy.mock.calls[1]?.[0]).toContain("out=0");
  });

  it("logs step finished with fallback reason when part is missing", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "step_finish" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("reason=step");
  });

  // ── error ─────────────────────────────────────────────────────────────────

  it("logs error message for error event with string error", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "error", error: "something went wrong" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("error: something went wrong");
  });

  it("logs error message for error event with message field", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "error", message: "timeout reached" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("error: timeout reached");
  });

  it("logs error from object error.message field", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "error", error: { message: "network error", code: "ERR_NET" } }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("error: network error");
  });

  it("logs error from object data.message field when message is absent", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "error", error: { data: { message: "inner error" } } }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("error: inner error");
  });

  it("does not log when error event has no extractable message", () => {
    printOpenCodeStreamEvent(
      JSON.stringify({ type: "error" }),
      false,
    );
    expect(logSpy).not.toHaveBeenCalled();
  });
});
