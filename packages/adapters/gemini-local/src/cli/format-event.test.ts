import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printGeminiStreamEvent } from "./format-event.js";

// printGeminiStreamEvent parses Gemini JSON stream events and writes to console.log.
// Tests verify routing logic and content extraction by spying on console.log.

describe("printGeminiStreamEvent", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  it("does nothing for empty string", () => {
    printGeminiStreamEvent("", false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does nothing for whitespace-only string", () => {
    printGeminiStreamEvent("   \n\t  ", false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logs raw text when input is not valid JSON", () => {
    printGeminiStreamEvent("plain log line", false);
    expect(logSpy).toHaveBeenCalledWith("plain log line");
  });

  it("logs raw line for unknown event types", () => {
    const raw = JSON.stringify({ type: "unexpected_gemini_event" });
    printGeminiStreamEvent(raw, false);
    expect(logSpy).toHaveBeenCalledWith(raw);
  });

  // ── system events ─────────────────────────────────────────────────────────

  it("logs Gemini init for system/init with session and model", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-abc", model: "gemini-2.5-pro" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    const msg = logSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("Gemini init");
    expect(msg).toContain("session: s-abc");
    expect(msg).toContain("model: gemini-2.5-pro");
  });

  it("logs Gemini init without details when session_id and model are absent", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "system", subtype: "init" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("Gemini init");
    expect(logSpy.mock.calls[0]?.[0]).not.toContain("session:");
  });

  it("logs error for system/error event", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "system", subtype: "error", error: "auth failed" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("error: auth failed");
  });

  it("logs system event line for unknown system subtype", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "system", subtype: "checkpoint" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("system: checkpoint");
  });

  it("logs system event line without subtype", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "system" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("system: event");
  });

  // ── assistant messages ────────────────────────────────────────────────────

  it("logs assistant text for assistant event with string message", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "assistant", message: "Hello from Gemini!" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("assistant:");
    expect(logSpy.mock.calls[0]?.[0]).toContain("Hello from Gemini!");
  });

  it("logs assistant text from message.text field", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "assistant", message: { text: "Direct text response" } }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("Direct text response");
  });

  it("logs assistant text from output_text content part", () => {
    printGeminiStreamEvent(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "output_text", text: "From content part" }],
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("From content part");
  });

  it("logs thinking from thinking content part", () => {
    printGeminiStreamEvent(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "thinking", text: "Thinking hard..." }],
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("thinking: Thinking hard...");
  });

  it("logs tool_call from tool_call content part", () => {
    printGeminiStreamEvent(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_call", name: "bash", input: { command: "pwd" } }],
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_call: bash");
    expect(logSpy.mock.calls[1]?.[0]).toContain("pwd");
  });

  it("logs tool_result from tool_result content part", () => {
    printGeminiStreamEvent(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_result", output: "result text", is_error: false }],
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_result");
    expect(logSpy.mock.calls[1]?.[0]).toContain("result text");
  });

  it("logs error-style tool_result when is_error is true in content part", () => {
    printGeminiStreamEvent(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_result", output: "errored", is_error: true }],
        },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_result (error)");
  });

  // ── user messages ─────────────────────────────────────────────────────────

  it("logs user text for user event with string message", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "user", message: "User prompt here" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("user:");
    expect(logSpy.mock.calls[0]?.[0]).toContain("User prompt here");
  });

  // ── thinking ─────────────────────────────────────────────────────────────

  it("logs thinking from top-level thinking event", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "thinking", text: "Top-level reasoning" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("thinking: Top-level reasoning");
  });

  it("logs thinking from thinking event with delta", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "thinking", delta: { text: "Delta reasoning" } }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("thinking: Delta reasoning");
  });

  it("does not log for empty thinking text", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "thinking", text: "" }),
      false,
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  // ── tool_call ─────────────────────────────────────────────────────────────

  it("logs tool_call started with args for known tool", () => {
    printGeminiStreamEvent(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        tool_call: { bash: { args: { command: "echo hi" } } },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_call: bash");
    expect(logSpy.mock.calls[1]?.[0]).toContain("echo hi");
  });

  it("logs tool_result completed for completed tool_call", () => {
    printGeminiStreamEvent(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        tool_call: { read_file: { result: "file content" } },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_result");
    expect(logSpy.mock.calls[1]?.[0]).toContain("file content");
  });

  it("logs error-style for failed tool_call", () => {
    printGeminiStreamEvent(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        is_error: true,
        tool_call: { bash: { result: "command not found" } },
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_result (error)");
  });

  it("logs generic tool_call line when tool_call field is missing", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "tool_call", subtype: "started" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("tool_call");
    expect(logSpy.mock.calls[0]?.[0]).toContain("started");
  });

  // ── result ────────────────────────────────────────────────────────────────

  it("logs token usage for result event", () => {
    printGeminiStreamEvent(
      JSON.stringify({
        type: "result",
        usage: { input_tokens: 300, output_tokens: 120, cached_input_tokens: 80 },
        total_cost_usd: 0.003,
      }),
      false,
    );
    // printUsage logs line 1; subtype defaults to "result" so result line is always logged too
    expect(logSpy).toHaveBeenCalledTimes(2);
    const usageLine = logSpy.mock.calls[0]?.[0] as string;
    expect(usageLine).toContain("in=300");
    expect(usageLine).toContain("out=120");
    expect(usageLine).toContain("cached=80");
  });

  it("logs result subtype when is_error or subtype present", () => {
    printGeminiStreamEvent(
      JSON.stringify({
        type: "result",
        subtype: "max_tokens",
        is_error: false,
        usage: {},
      }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[1]?.[0]).toContain("subtype=max_tokens");
  });

  // ── error ─────────────────────────────────────────────────────────────────

  it("logs error message for top-level error event", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "error", error: "connection lost" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("error: connection lost");
  });

  it("logs error from message field when error is absent", () => {
    printGeminiStreamEvent(
      JSON.stringify({ type: "error", message: "request failed" }),
      false,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("error: request failed");
  });

  it("does not log for error event with no extractable message", () => {
    printGeminiStreamEvent(JSON.stringify({ type: "error" }), false);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
