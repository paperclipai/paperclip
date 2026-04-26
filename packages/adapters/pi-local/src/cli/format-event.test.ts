import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { printPiStreamEvent } from "./format-event.js";

// printPiStreamEvent parses Pi JSON stream events and writes to console.log.
// Tests verify routing logic and content extraction by spying on console.log.

describe("printPiStreamEvent", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  it("does nothing for empty string", () => {
    printPiStreamEvent("", false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does nothing for whitespace-only string", () => {
    printPiStreamEvent("   \n\t  ", false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logs raw text when input is not valid JSON", () => {
    printPiStreamEvent("not json at all", false);
    expect(logSpy).toHaveBeenCalledWith("not json at all");
  });

  it("logs raw line when JSON parses to an array", () => {
    const raw = JSON.stringify(["a", "b"]);
    printPiStreamEvent(raw, false);
    expect(logSpy).toHaveBeenCalledWith(raw);
  });

  it("logs raw line for unknown event type", () => {
    const raw = JSON.stringify({ type: "some_unknown_type", data: 42 });
    printPiStreamEvent(raw, false);
    expect(logSpy).toHaveBeenCalledWith(raw);
  });

  // ── agent lifecycle ───────────────────────────────────────────────────────

  it("logs Pi agent started for agent_start", () => {
    printPiStreamEvent(JSON.stringify({ type: "agent_start" }), false);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("Pi agent started");
  });

  it("logs Pi agent finished for agent_end", () => {
    printPiStreamEvent(JSON.stringify({ type: "agent_end" }), false);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("Pi agent finished");
  });

  it("logs Turn started for turn_start", () => {
    printPiStreamEvent(JSON.stringify({ type: "turn_start" }), false);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("Turn started");
  });

  // ── turn_end ──────────────────────────────────────────────────────────────

  it("logs assistant content for turn_end with string content", () => {
    printPiStreamEvent(
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "Hello from Pi!" },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("assistant:");
    expect(logSpy.mock.calls[0]?.[0]).toContain("Hello from Pi!");
  });

  it("logs assistant content for turn_end with array content (text parts)", () => {
    printPiStreamEvent(
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "First part. " },
            { type: "text", text: "Second part." },
          ],
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("First part.");
    expect(logSpy.mock.calls[0]?.[0]).toContain("Second part.");
  });

  it("skips non-text parts in array content for turn_end", () => {
    printPiStreamEvent(
      JSON.stringify({
        type: "turn_end",
        message: {
          content: [
            { type: "tool_use", name: "bash" },
            { type: "text", text: "Done." },
          ],
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    const msg = logSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("Done.");
    expect(msg).not.toContain("bash");
  });

  it("does not log for turn_end when message is missing", () => {
    printPiStreamEvent(JSON.stringify({ type: "turn_end" }), false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not log for turn_end when content extracts to empty string", () => {
    printPiStreamEvent(
      JSON.stringify({
        type: "turn_end",
        message: { content: [{ type: "tool_use", name: "bash" }] },
      }),
      false,
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  // ── message_update ────────────────────────────────────────────────────────

  it("logs delta text for message_update with text_delta type", () => {
    printPiStreamEvent(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "partial output" },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("partial output");
  });

  it("does not log for message_update with non-text_delta type", () => {
    printPiStreamEvent(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "input_json_delta", delta: "{" },
      }),
      false,
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not log for message_update when assistantMessageEvent is missing", () => {
    printPiStreamEvent(JSON.stringify({ type: "message_update" }), false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not log for message_update with empty delta", () => {
    printPiStreamEvent(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "" },
      }),
      false,
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  // ── tool_execution_start ──────────────────────────────────────────────────

  it("logs tool_start with args for tool_execution_start", () => {
    printPiStreamEvent(
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: "ls -la" },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_start: bash");
    expect(logSpy.mock.calls[1]?.[0]).toContain("ls -la");
  });

  it("logs only tool_start header when args are undefined", () => {
    printPiStreamEvent(
      JSON.stringify({ type: "tool_execution_start", toolName: "read_file" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_start: read_file");
  });

  it("logs tool_start with null args as null string", () => {
    printPiStreamEvent(
      JSON.stringify({ type: "tool_execution_start", toolName: "search", args: null }),
      false,
    );
    // null is a valid JSON value, so it will be JSON.stringify'd to "null"
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_start: search");
  });

  it("uses empty string for missing toolName in tool_execution_start", () => {
    printPiStreamEvent(
      JSON.stringify({ type: "tool_execution_start" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_start: ");
  });

  // ── tool_execution_end ────────────────────────────────────────────────────

  it("logs successful tool result for tool_execution_end with string result", () => {
    printPiStreamEvent(
      JSON.stringify({
        type: "tool_execution_end",
        result: "file contents here",
        isError: false,
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("file contents here");
  });

  it("logs error-style output for tool_execution_end with isError=true", () => {
    printPiStreamEvent(
      JSON.stringify({
        type: "tool_execution_end",
        result: "permission denied",
        isError: true,
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("permission denied");
  });

  it("logs JSON-stringified result for non-string result", () => {
    printPiStreamEvent(
      JSON.stringify({
        type: "tool_execution_end",
        result: { output: "data", count: 3 },
        isError: false,
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = logSpy.mock.calls[0]?.[0] as string;
    expect(logged).toContain("output");
    expect(logged).toContain("data");
  });

  it("does not log for tool_execution_end with no result", () => {
    printPiStreamEvent(
      JSON.stringify({ type: "tool_execution_end" }),
      false,
    );
    expect(logSpy).not.toHaveBeenCalled();
  });
});
