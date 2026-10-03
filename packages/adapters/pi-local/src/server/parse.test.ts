import { describe, expect, it } from "vitest";
import { parsePiJsonl, isPiUnknownSessionError } from "./parse.js";

describe("parsePiJsonl", () => {
  it("parses agent lifecycle and messages", () => {
    const stdout = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from Pi" }],
        },
      }),
      JSON.stringify({ type: "agent_end", messages: [] }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.messages).toContain("Hello from Pi");
    expect(parsed.finalMessage).toBe("Hello from Pi");
  });

  it("parses streaming text deltas", () => {
    const stdout = [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "World" },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Hello World",
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.messages).toContain("Hello World");
  });

  it("parses tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/tmp/test.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "file contents",
        isError: false,
      }),
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "Done" },
        toolResults: [
          {
            toolCallId: "tool_1",
            content: "file contents",
            isError: false,
          },
        ],
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].toolName).toBe("read");
    expect(parsed.toolCalls[0].result).toBe("file contents");
    expect(parsed.toolCalls[0].isError).toBe(false);
  });

  it("handles errors in tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/missing.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "File not found",
        isError: true,
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].isError).toBe(true);
    expect(parsed.toolCalls[0].result).toBe("File not found");
  });

  it("extracts usage and cost from turn_end events", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Response with usage",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 20,
            totalTokens: 170,
            cost: {
              input: 0.001,
              output: 0.0015,
              cacheRead: 0.0001,
              cacheWrite: 0,
              total: 0.0026,
            },
          },
        },
        toolResults: [],
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.outputTokens).toBe(50);
    expect(parsed.usage.cachedInputTokens).toBe(20);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0026, 4);
  });

  it("accumulates usage from multiple turns", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "First response",
          usage: {
            input: 50,
            output: 25,
            cacheRead: 0,
            cost: { total: 0.001 },
          },
        },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Second response",
          usage: {
            input: 30,
            output: 20,
            cacheRead: 10,
            cost: { total: 0.0015 },
          },
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(80);
    expect(parsed.usage.outputTokens).toBe(45);
    expect(parsed.usage.cachedInputTokens).toBe(10);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0025, 4);
  });

  it("handles standalone usage events with Pi format", () => {
    const stdout = [
      JSON.stringify({
        type: "usage",
        usage: {
          input: 200,
          output: 100,
          cacheRead: 50,
          cost: { total: 0.005 },
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(200);
    expect(parsed.usage.outputTokens).toBe(100);
    expect(parsed.usage.cachedInputTokens).toBe(50);
    expect(parsed.usage.costUsd).toBe(0.005);
  });

  it("handles standalone usage events with generic format", () => {
    const stdout = [
      JSON.stringify({
        type: "usage",
        usage: {
          inputTokens: 150,
          outputTokens: 75,
          cachedInputTokens: 25,
          costUsd: 0.003,
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(150);
    expect(parsed.usage.outputTokens).toBe(75);
    expect(parsed.usage.cachedInputTokens).toBe(25);
    expect(parsed.usage.costUsd).toBe(0.003);
  });

  it("surfaces failed auto-retry exhaustion as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "Cloud Code Assist API error (429): RESOURCE_EXHAUSTED",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual(["Cloud Code Assist API error (429): RESOURCE_EXHAUSTED"]);
  });

  it("does not treat successful auto-retry as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: true,
        attempt: 2,
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual([]);
  });

  it("surfaces standalone error events", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "Connection to model provider lost",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual(["Connection to model provider lost"]);
  });

  it("ignores error events with empty messages", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual([]);
  });
});

describe("isPiUnknownSessionError", () => {
  it("detects unknown session errors", () => {
    expect(isPiUnknownSessionError("session not found: s_123", "")).toBe(true);
    expect(isPiUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isPiUnknownSessionError("", "no session available")).toBe(true);
    expect(isPiUnknownSessionError("all good", "")).toBe(false);
    expect(isPiUnknownSessionError("working fine", "no errors")).toBe(false);
  });
});


describe("terminal provider failures", () => {
  it("surfaces and deduplicates errors from Pi assistant messages", () => {
    const message = { role: "assistant", content: [], stopReason: "error", errorMessage: "400 Context limit exceeded" };
    const parsed = parsePiJsonl([
      { type: "message_end", message },
      { type: "turn_end", message },
      { type: "agent_end", messages: [message] },
    ].map(event => JSON.stringify(event)).join("\n"));
    expect(parsed.errors).toEqual(["400 Context limit exceeded"]);
  });
  it("reports an error even when the provider omitted its message", () => {
    expect(parsePiJsonl(JSON.stringify({ type: "turn_end", message: { role: "assistant", stopReason: "error" } })).errors)
      .toEqual(["Pi provider request failed."]);
  });

  it("does not fail a run whose failed attempt a model fallback recovered", () => {
    const failed = {
      role: "assistant",
      provider: "cliproxy",
      model: "opus",
      content: [],
      stopReason: "error",
      errorMessage: "400 unknown provider for model opus",
    };
    const answered = {
      role: "assistant",
      provider: "cursor",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    };
    const parsed = parsePiJsonl([
      { type: "message_end", message: failed },
      { type: "turn_end", message: failed },
      { type: "retry_fallback_applied", from: "cliproxy/opus", to: "cursor/claude-opus-5-5" },
      { type: "auto_retry_start", attempt: 1, errorMessage: failed.errorMessage },
      { type: "message_end", message: answered },
      { type: "retry_fallback_succeeded", model: "cursor/claude-opus-5-5" },
      { type: "turn_end", message: answered },
      { type: "agent_end", messages: [failed, answered] },
    ].map(event => JSON.stringify(event)).join("\n"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.finalMessage).toBe("done");
    expect({ provider: parsed.provider, model: parsed.model }).toEqual({ provider: "cursor", model: "claude-opus-5-5" });
  });

  it("still fails when every fallback attempt failed", () => {
    const first = { role: "assistant", provider: "cliproxy", model: "opus", stopReason: "error", errorMessage: "timed out" };
    const second = { role: "assistant", provider: "cursor", model: "opus", stopReason: "error", errorMessage: "ERROR_NOT_LOGGED_IN" };
    const parsed = parsePiJsonl([
      { type: "turn_end", message: first },
      { type: "retry_fallback_applied", from: "cliproxy/opus", to: "cursor/opus" },
      { type: "turn_end", message: second },
      { type: "auto_retry_end", success: false, finalError: "ERROR_NOT_LOGGED_IN" },
      { type: "agent_end", messages: [second] },
    ].map(event => JSON.stringify(event)).join("\n"));
    expect([...parsed.errors].sort()).toEqual(["ERROR_NOT_LOGGED_IN", "timed out"]);
    expect(parsed.provider).toBeNull();
  });

  it("fails on an error that follows a recovered fallback", () => {
    const failed = { role: "assistant", provider: "cliproxy", model: "opus", stopReason: "error", errorMessage: "timed out" };
    const answered = { role: "assistant", provider: "cursor", model: "opus", content: "ok", stopReason: "stop" };
    const later = { role: "assistant", provider: "cursor", model: "opus", stopReason: "error", errorMessage: "context limit" };
    const parsed = parsePiJsonl([
      { type: "turn_end", message: failed },
      { type: "retry_fallback_succeeded", model: "cursor/opus" },
      { type: "turn_end", message: answered },
      { type: "turn_end", message: later },
      { type: "agent_end", messages: [failed, answered, later] },
    ].map(event => JSON.stringify(event)).join("\n"));
    expect(parsed.errors).toEqual(["context limit"]);
    expect({ provider: parsed.provider, model: parsed.model }).toEqual({ provider: "cursor", model: "opus" });
  });
});
