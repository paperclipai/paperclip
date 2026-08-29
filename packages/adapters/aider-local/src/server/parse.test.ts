import { describe, expect, it } from "vitest";
import { isAiderQuotaError, parseAiderOutput, parseTokenCount, stripAnsi } from "./parse.js";

const ESC = String.fromCharCode(27);

describe("parseTokenCount", () => {
  it("expands k/M suffixes and plain counts", () => {
    expect(parseTokenCount("3.4k")).toBe(3400);
    expect(parseTokenCount("1.2M")).toBe(1_200_000);
    expect(parseTokenCount("156")).toBe(156);
    expect(parseTokenCount("12,500")).toBe(12500);
    expect(parseTokenCount("not-a-number")).toBe(0);
  });
});

describe("stripAnsi", () => {
  it("removes color escapes without touching bracketed text", () => {
    expect(stripAnsi(`${ESC}[32mdone${ESC}[0m`)).toBe("done");
    expect(stripAnsi("[paperclip] kept")).toBe("[paperclip] kept");
  });
});

describe("parseAiderOutput", () => {
  it("reads the tokens and cost footer and keeps only the reply in the summary", () => {
    const stdout = [
      "Aider v0.86.1",
      "Main model: claude-sonnet-4-5 with diff edit format",
      "Git repo: .git with 128 files",
      "Added src/app.ts to the chat.",
      "I updated the retry helper to back off exponentially.",
      "",
      "Applied edit to src/app.ts",
      "Commit 9f2c1ab feat: exponential backoff",
      "Tokens: 3.4k sent, 156 received. Cost: $0.0123 message, $0.0456 session.",
    ].join("\n");

    const parsed = parseAiderOutput(stdout);

    expect(parsed.inputTokens).toBe(3400);
    expect(parsed.outputTokens).toBe(156);
    expect(parsed.messageCostUsd).toBeCloseTo(0.0123);
    expect(parsed.sessionCostUsd).toBeCloseTo(0.0456);
    expect(parsed.editedFiles).toEqual(["src/app.ts"]);
    expect(parsed.commits).toEqual(["9f2c1ab feat: exponential backoff"]);
    expect(parsed.summary).toBe("I updated the retry helper to back off exponentially.");
    expect(parsed.errorMessage).toBeNull();
  });

  it("splits tokens and cost reported on separate lines", () => {
    const parsed = parseAiderOutput(
      ["Tokens: 812 sent, 44 received.", "Cost: $0.0009 message, $0.0009 session."].join("\n"),
    );
    expect(parsed.inputTokens).toBe(812);
    expect(parsed.outputTokens).toBe(44);
    expect(parsed.messageCostUsd).toBeCloseTo(0.0009);
  });

  it("surfaces a provider error from stderr", () => {
    const parsed = parseAiderOutput(
      "",
      "litellm.AuthenticationError: AnthropicException - invalid x-api-key",
    );
    expect(parsed.errorMessage).toContain("litellm.AuthenticationError");
  });

  it("returns empty usage when Aider prints no footer", () => {
    const parsed = parseAiderOutput("No changes needed.\n");
    expect(parsed.inputTokens).toBe(0);
    expect(parsed.outputTokens).toBe(0);
    expect(parsed.messageCostUsd).toBeNull();
    expect(parsed.summary).toBe("No changes needed.");
  });
});

describe("isAiderQuotaError", () => {
  it("detects rate limit and quota exhaustion", () => {
    expect(isAiderQuotaError("", "litellm.RateLimitError: 429 Too Many Requests")).toBe(true);
    expect(isAiderQuotaError("You exceeded your current quota", "")).toBe(true);
    expect(isAiderQuotaError("Applied edit to src/app.ts", "")).toBe(false);
  });
});
