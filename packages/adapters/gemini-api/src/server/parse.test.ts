import { describe, expect, it } from "vitest";
import { parseGeminiApiJsonl, detectGeminiApiQuotaExhausted } from "./parse.js";

describe("parseGeminiApiJsonl", () => {
  it("collects assistant text from message events", () => {
    const stdout = [
      '{"type":"init","session_id":"sess-1"}',
      '{"type":"message","role":"assistant","content":"hello from gemini api","delta":true}',
      '{"type":"result","status":"success"}',
    ].join("\n");

    const parsed = parseGeminiApiJsonl(stdout);
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.summary).toBe("hello from gemini api");
    expect(parsed.errorMessage).toBeNull();
  });

  it("accumulates token usage from result event usageMetadata", () => {
    const stdout = [
      JSON.stringify({
        type: "result",
        status: "success",
        usage: {
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 50,
            cachedContentTokenCount: 10,
          },
        },
      }),
    ].join("\n");

    const parsed = parseGeminiApiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.outputTokens).toBe(50);
    expect(parsed.usage.cachedInputTokens).toBe(10);
  });

  it("captures cost from result event", () => {
    const stdout = JSON.stringify({ type: "result", status: "success", total_cost_usd: 0.0042 });
    const parsed = parseGeminiApiJsonl(stdout);
    expect(parsed.costUsd).toBeCloseTo(0.0042);
  });

  it("returns errorMessage for error type events", () => {
    const stdout = [
      '{"type":"error","error":"model not found"}',
      '{"type":"result","status":"error","is_error":true}',
    ].join("\n");

    const parsed = parseGeminiApiJsonl(stdout);
    expect(parsed.errorMessage).toBe("model not found");
  });

  it("returns null for empty stdout", () => {
    const parsed = parseGeminiApiJsonl("");
    expect(parsed.sessionId).toBeNull();
    expect(parsed.summary).toBe("");
    expect(parsed.errorMessage).toBeNull();
  });

  it("skips non-JSON lines gracefully", () => {
    const stdout = ["not json", '{"type":"message","role":"assistant","content":"ok"}', "also not json"].join("\n");
    const parsed = parseGeminiApiJsonl(stdout);
    expect(parsed.summary).toBe("ok");
  });
});

describe("detectGeminiApiQuotaExhausted", () => {
  it("detects 429 HTTP status", () => {
    expect(detectGeminiApiQuotaExhausted({ status: 429 })).toBe(true);
  });

  it("detects QUOTA_EXHAUSTED in body", () => {
    expect(detectGeminiApiQuotaExhausted({ body: "error: QUOTA_EXHAUSTED for this model" })).toBe(true);
  });

  it("detects RESOURCE_EXHAUSTED in body", () => {
    expect(detectGeminiApiQuotaExhausted({ body: "RESOURCE_EXHAUSTED" })).toBe(true);
  });

  it("detects capacity message in body", () => {
    expect(detectGeminiApiQuotaExhausted({ body: "no capacity on this model right now" })).toBe(true);
  });

  it("detects quota will reset in body", () => {
    expect(detectGeminiApiQuotaExhausted({ body: "your quota will reset at midnight" })).toBe(true);
  });

  it("detects rate-limit in body", () => {
    expect(detectGeminiApiQuotaExhausted({ body: "rate-limit exceeded" })).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(detectGeminiApiQuotaExhausted({ status: 400, body: "invalid request format" })).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(detectGeminiApiQuotaExhausted({})).toBe(false);
  });
});
