import { describe, expect, it } from "vitest";
import {
  isHermesUnknownSessionError,
  parseHermesQuietStdout,
  parseHermesSessionExport,
} from "./parse.js";

describe("parseHermesQuietStdout", () => {
  it("captures session id from stderr (current Hermes behavior)", () => {
    const stdout = "Hi! How can I help you today?\n";
    const stderr = "\nsession_id: 20260501_114703_29fcae\n";
    const out = parseHermesQuietStdout(stdout, stderr);
    expect(out.sessionId).toBe("20260501_114703_29fcae");
    expect(out.summary).toBe("Hi! How can I help you today?");
  });

  it("falls back to legacy session_id-on-stdout shape", () => {
    const stdout = "session_id: 20260501_113041_b9f19e\nHello there, friend!\n";
    const out = parseHermesQuietStdout(stdout);
    expect(out.sessionId).toBe("20260501_113041_b9f19e");
    expect(out.summary).toBe("Hello there, friend!");
  });

  it("handles output with no session line at all", () => {
    const stdout = "just the answer\n";
    const out = parseHermesQuietStdout(stdout);
    expect(out.sessionId).toBeNull();
    expect(out.summary).toBe("just the answer");
  });

  it("handles multi-line bodies with session id on stderr", () => {
    const stdout = "line 1\nline 2\nline 3";
    const stderr = "session_id: abc\n";
    const out = parseHermesQuietStdout(stdout, stderr);
    expect(out.sessionId).toBe("abc");
    expect(out.summary).toBe("line 1\nline 2\nline 3");
  });

  it("returns empty result on empty input", () => {
    const out = parseHermesQuietStdout("", "");
    expect(out.sessionId).toBeNull();
    expect(out.summary).toBe("");
  });

  it("tolerates a leading blank line before session id (legacy stdout shape)", () => {
    const stdout = "\nsession_id: x9\nthe answer\n";
    const out = parseHermesQuietStdout(stdout);
    expect(out.sessionId).toBe("x9");
    expect(out.summary).toBe("the answer");
  });
});

describe("parseHermesSessionExport", () => {
  it("extracts usage and cost from a session export", () => {
    const record = {
      id: "20260501_113118_b86354",
      input_tokens: 3,
      output_tokens: 8,
      cache_read_tokens: 0,
      cache_write_tokens: 17850,
      reasoning_tokens: 0,
      estimated_cost_usd: 0.0670665,
      actual_cost_usd: null,
      billing_provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
    };
    const stdout = JSON.stringify(record) + "\n";
    const parsed = parseHermesSessionExport(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed!.inputTokens).toBe(3);
    expect(parsed!.outputTokens).toBe(8);
    expect(parsed!.cachedInputTokens).toBe(0);
    expect(parsed!.costUsd).toBeCloseTo(0.0670665);
    expect(parsed!.billingProvider).toBe("openrouter");
    expect(parsed!.model).toBe("anthropic/claude-sonnet-4.6");
  });

  it("prefers actual_cost_usd over estimated when present", () => {
    const stdout =
      JSON.stringify({
        id: "abc",
        input_tokens: 1,
        output_tokens: 1,
        actual_cost_usd: 0.5,
        estimated_cost_usd: 0.25,
      }) + "\n";
    const parsed = parseHermesSessionExport(stdout);
    expect(parsed!.costUsd).toBeCloseTo(0.5);
  });

  it("returns null on garbage", () => {
    expect(parseHermesSessionExport("")).toBeNull();
    expect(parseHermesSessionExport("not json\n")).toBeNull();
  });

  it("adds reasoning tokens into outputTokens", () => {
    const stdout =
      JSON.stringify({
        id: "abc",
        input_tokens: 10,
        output_tokens: 20,
        reasoning_tokens: 5,
      }) + "\n";
    const parsed = parseHermesSessionExport(stdout);
    expect(parsed!.outputTokens).toBe(25);
  });
});

describe("isHermesUnknownSessionError", () => {
  it("matches typical not-found phrasings", () => {
    expect(isHermesUnknownSessionError("", "Session not found: abc")).toBe(true);
    expect(isHermesUnknownSessionError("Unknown session abc", "")).toBe(true);
    expect(isHermesUnknownSessionError("Session does not exist", "")).toBe(true);
  });

  it("ignores unrelated stderr", () => {
    expect(isHermesUnknownSessionError("", "openrouter rate limit")).toBe(false);
  });
});
