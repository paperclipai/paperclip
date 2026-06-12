import { describe, expect, it } from "vitest";
import {
  parseOpenCodeJsonl,
  isOpenCodeUnknownSessionError,
  detectOpenCodeQuotaExhaustion,
} from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("detectOpenCodeQuotaExhaustion", () => {
  it("lifts provider/code/message from the proxy's structured 402 body", () => {
    const errorEvent = JSON.stringify({
      type: "error",
      error: {
        message:
          'Provider error 402: {"error":{"type":"quota_exhausted","provider":"openrouter","code":"402","message":"Insufficient credits"},"blocked":true}',
      },
    });
    const quota = detectOpenCodeQuotaExhaustion(errorEvent, "");
    expect(quota).toEqual({ provider: "openrouter", code: "402", message: "Insufficient credits" });
  });

  it("detects a bare structured quota_exhausted body on stderr", () => {
    const body =
      '{"error":{"type":"quota_exhausted","provider":"minimax","code":"2056","message":"Token Plan usage limit reached"},"blocked":true}';
    const quota = detectOpenCodeQuotaExhaustion("", body);
    expect(quota).toEqual({
      provider: "minimax",
      code: "2056",
      message: "Token Plan usage limit reached",
    });
  });

  it("detects MiniMax code 2056 even without the structured wrapper", () => {
    const quota = detectOpenCodeQuotaExhaustion('{"status_code":2056,"message":"limit reached"}', "");
    expect(quota).not.toBeNull();
    expect(quota?.code).toBe("2056");
  });

  it("detects a 402 payment-required credit exhaustion", () => {
    const quota = detectOpenCodeQuotaExhaustion("HTTP 402 Payment Required: credit exhausted", "");
    expect(quota).not.toBeNull();
    expect(quota?.code).toBe("402");
  });

  it("does not flag a transient 429 rate limit as quota exhaustion", () => {
    expect(detectOpenCodeQuotaExhaustion("HTTP 429 Too Many Requests; please retry", "")).toBeNull();
  });

  it("returns null for a clean run", () => {
    expect(detectOpenCodeQuotaExhaustion("all good, finished the task", "")).toBeNull();
  });
});
