import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printCodexStreamEvent } from "./format-event.js";

// printCodexStreamEvent parses Codex JSON stream events and writes to console.log.
// Tests verify routing logic and content extraction by spying on console.log.

describe("printCodexStreamEvent", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  it("does nothing for empty string", () => {
    printCodexStreamEvent("", false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does nothing for whitespace-only string", () => {
    printCodexStreamEvent("   \t\n  ", false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logs raw text when input is not valid JSON", () => {
    printCodexStreamEvent("raw log output", false);
    expect(logSpy).toHaveBeenCalledWith("raw log output");
  });

  it("logs raw line for unknown event types", () => {
    const raw = JSON.stringify({ type: "unknown_codex_event" });
    printCodexStreamEvent(raw, false);
    expect(logSpy).toHaveBeenCalledWith(raw);
  });

  // ── thread.started ────────────────────────────────────────────────────────

  it("logs thread started without details when fields are missing", () => {
    printCodexStreamEvent(JSON.stringify({ type: "thread.started" }), false);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("Codex thread started");
  });

  it("logs thread started with thread_id and model when provided", () => {
    printCodexStreamEvent(
      JSON.stringify({ type: "thread.started", thread_id: "t-123", model: "codex-2" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    const msg = logSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("session: t-123");
    expect(msg).toContain("model: codex-2");
  });

  // ── turn.started ──────────────────────────────────────────────────────────

  it("logs turn started", () => {
    printCodexStreamEvent(JSON.stringify({ type: "turn.started" }), false);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("turn started");
  });

  // ── item.started ──────────────────────────────────────────────────────────

  it("logs command_execution item.started with command", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", command: "npm test" },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_call: command_execution");
    expect(logSpy.mock.calls[1]?.[0]).toContain("npm test");
  });

  it("logs command_execution item.started without extra line when command is empty", () => {
    printCodexStreamEvent(
      JSON.stringify({ type: "item.started", item: { type: "command_execution" } }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_call: command_execution");
  });

  it("logs tool_use item.started with name and input", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.started",
        item: { type: "tool_use", name: "read_file", input: { path: "/tmp/test.ts" } },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_call: read_file");
    expect(logSpy.mock.calls[1]?.[0]).toContain("/tmp/test.ts");
  });

  it("logs generic item.started for unrecognized item types", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.started",
        item: { type: "unknown_item", id: "i-1", status: "active" },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("item.started");
    expect(logSpy.mock.calls[0]?.[0]).toContain("unknown_item");
  });

  // ── item.completed ────────────────────────────────────────────────────────

  it("logs assistant message for agent_message item.completed", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Task complete!" },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("assistant:");
    expect(logSpy.mock.calls[0]?.[0]).toContain("Task complete!");
  });

  it("does not log assistant message when text is empty", () => {
    printCodexStreamEvent(
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "" } }),
      false,
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logs thinking text for reasoning item.completed", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "Let me analyze this..." },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("thinking:");
    expect(logSpy.mock.calls[0]?.[0]).toContain("Let me analyze this...");
  });

  it("logs successful command_execution item.completed with output", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "ls",
          status: "completed",
          exit_code: 0,
          aggregated_output: "file.ts\nindex.ts\n",
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_result: command_execution");
    expect(logSpy.mock.calls[0]?.[0]).toContain("command=\"ls\"");
    expect(logSpy.mock.calls[1]?.[0]).toContain("file.ts");
  });

  it("logs error-style command_execution when exit_code is non-zero", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "failing-cmd",
          status: "completed",
          exit_code: 1,
          aggregated_output: "error output",
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    // Both lines should be logged (error-styled)
    expect(logSpy.mock.calls[0]?.[0]).toContain("command_execution");
    expect(logSpy.mock.calls[1]?.[0]).toContain("error output");
  });

  it("logs file_change with preview for item.completed", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "file_change",
          changes: [
            { kind: "create", path: "src/new-file.ts" },
            { kind: "update", path: "src/index.ts" },
          ],
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    const msg = logSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("file_change:");
    expect(msg).toContain("src/new-file.ts");
  });

  it("logs file_change with 'none' when changes array is empty", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", changes: [] },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("none");
  });

  it("logs tool_result item.completed with content", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: { type: "tool_result", content: "tool output here", is_error: false },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_result");
    expect(logSpy.mock.calls[1]?.[0]).toContain("tool output here");
  });

  it("logs error-style tool_result when is_error is true", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: { type: "tool_result", content: "failed", is_error: true },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_result (error)");
  });

  it("logs error item.completed with string message", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: { type: "error", message: "Something broke" },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("error: Something broke");
  });

  // ── turn.completed ────────────────────────────────────────────────────────

  it("logs token usage for turn.completed", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 200, output_tokens: 80, cached_input_tokens: 50 },
        total_cost_usd: 0.0015,
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    const msg = logSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("in=200");
    expect(msg).toContain("out=80");
    expect(msg).toContain("cached=50");
    expect(msg).toContain("cost=$0.001500");
  });

  it("logs error info for turn.completed when is_error is true", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 50, output_tokens: 10 },
        total_cost_usd: 0,
        is_error: true,
        subtype: "max_tokens",
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[1]?.[0]).toContain("subtype=max_tokens");
    expect(logSpy.mock.calls[1]?.[0]).toContain("is_error=true");
  });

  it("logs errors array in turn.completed when present", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "turn.completed",
        usage: {},
        total_cost_usd: 0,
        is_error: true,
        subtype: "error",
        errors: ["rate limit exceeded"],
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(logSpy.mock.calls[2]?.[0]).toContain("rate limit exceeded");
  });

  // ── turn.failed ───────────────────────────────────────────────────────────

  it("logs turn failed with error message", () => {
    printCodexStreamEvent(
      JSON.stringify({
        type: "turn.failed",
        error: "Connection timeout",
        usage: { input_tokens: 30, output_tokens: 5, cached_input_tokens: 0 },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("turn failed: Connection timeout");
    expect(logSpy.mock.calls[1]?.[0]).toContain("in=30");
  });

  it("logs turn failed without message when error is absent", () => {
    printCodexStreamEvent(
      JSON.stringify({ type: "turn.failed", usage: {} }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("turn failed");
    expect(logSpy.mock.calls[0]?.[0]).not.toContain(": ");
  });

  // ── error ─────────────────────────────────────────────────────────────────

  it("logs error for error event with string message", () => {
    printCodexStreamEvent(
      JSON.stringify({ type: "error", message: "auth failed" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("error: auth failed");
  });

  it("logs error from object message.code when message and error are absent", () => {
    printCodexStreamEvent(
      JSON.stringify({ type: "error", message: { code: "ERR_AUTH" } }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("error: ERR_AUTH");
  });

  it("logs JSON fallback for error event with no explicit message fields", () => {
    // When message and error are absent, errorText falls back to JSON.stringify(parsed)
    printCodexStreamEvent(JSON.stringify({ type: "error" }), false);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("error:");
  });
});
