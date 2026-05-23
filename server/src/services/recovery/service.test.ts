import { describe, expect, it } from "vitest";
import { isQuotaLimitExhaustionRun } from "./run-error-guards.js";

describe("isQuotaLimitExhaustionRun", () => {
  const base = {
    id: "run-1",
    agentId: "agent-1",
    status: "failed" as const,
    error: null,
    errorCode: null,
    contextSnapshot: null,
    livenessState: null,
  };

  it("returns false for null run", () => {
    expect(isQuotaLimitExhaustionRun(null)).toBe(false);
  });

  it("returns true for claude_transient_upstream with monthly usage limit message", () => {
    expect(
      isQuotaLimitExhaustionRun({
        ...base,
        errorCode: "claude_transient_upstream",
        error: "You've hit your org's monthly usage limit",
      }),
    ).toBe(true);
  });

  it("is case-insensitive on the error message", () => {
    expect(
      isQuotaLimitExhaustionRun({
        ...base,
        errorCode: "claude_transient_upstream",
        error: "You've hit your org's Monthly Usage Limit",
      }),
    ).toBe(true);
  });

  it("returns false when errorCode is not claude_transient_upstream", () => {
    expect(
      isQuotaLimitExhaustionRun({
        ...base,
        errorCode: "adapter_failed",
        error: "monthly usage limit exceeded",
      }),
    ).toBe(false);
  });

  it("returns false when error message does not contain monthly usage limit", () => {
    expect(
      isQuotaLimitExhaustionRun({
        ...base,
        errorCode: "claude_transient_upstream",
        error: "Claude API rate limit exceeded, retry after 60s",
      }),
    ).toBe(false);
  });

  it("returns false when error is null even with matching errorCode", () => {
    expect(
      isQuotaLimitExhaustionRun({
        ...base,
        errorCode: "claude_transient_upstream",
        error: null,
      }),
    ).toBe(false);
  });

  it("returns false for genuine transient upstream without quota message", () => {
    expect(
      isQuotaLimitExhaustionRun({
        ...base,
        errorCode: "claude_transient_upstream",
        error: "overloaded_error: The API is temporarily overloaded",
      }),
    ).toBe(false);
  });
});
