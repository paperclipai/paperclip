import { describe, expect, it } from "vitest";
import {
  decideHighInputTokenRunGuard,
  decideIssueGenerationAdmission,
  HIGH_INPUT_TOKEN_RUN_THRESHOLD,
  ISSUE_GENERATION_RUN_CEILING,
  MIN_USEFUL_RUN_INPUT_TOKENS,
  resolveIssueScopedRunTokenCap,
  totalInputTokensIncludingCache,
} from "../services/heartbeat.js";

describe("high input-token run guard", () => {
  it("does not intervene below the per-task threshold", () => {
    expect(decideHighInputTokenRunGuard({
      inputTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD - 1,
      highRunCount: 0,
    })).toBe("none");
  });

  it("hard-blocks the first oversized raw-input run", () => {
    expect(decideHighInputTokenRunGuard({
      inputTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD,
      highRunCount: 1,
    })).toBe("block");
  });

  it("continues to block later oversized runs on the same task", () => {
    expect(decideHighInputTokenRunGuard({
      inputTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD + 25_000,
      highRunCount: 2,
    })).toBe("block");
  });

  it("keeps cache reads in total accounting but does not use them for the raw-input hard ceiling", () => {
    const totalInputTokens = totalInputTokensIncludingCache({
      inputTokens: 105_209,
      cachedInputTokens: 3_294_208,
    });

    expect(totalInputTokens).toBe(3_399_417);
    expect(decideHighInputTokenRunGuard({
      inputTokens: 105_209,
      highRunCount: 1,
    })).toBe("none");
  });
});

describe("per-issue generation admission", () => {
  it("allows at most three generation runs", () => {
    expect(decideIssueGenerationAdmission({
      aggregateInputTokens: 100_000,
      priorGenerationRuns: ISSUE_GENERATION_RUN_CEILING - 1,
    }).decision).toBe("allow");
    expect(decideIssueGenerationAdmission({
      aggregateInputTokens: 100_000,
      priorGenerationRuns: ISSUE_GENERATION_RUN_CEILING,
    })).toMatchObject({ decision: "deny", reason: "generation_run_ceiling" });
  });

  it("denies another generation once aggregate input including cache reaches 1M", () => {
    expect(decideIssueGenerationAdmission({
      aggregateInputTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD,
      priorGenerationRuns: 1,
    })).toEqual({
      decision: "deny",
      reason: "aggregate_input_ceiling",
      remainingInputTokens: 0,
    });
  });

  it("denies a run whose residual budget is too small to complete a model turn", () => {
    // 2026-08-22: residual clamps of 12,016 tokens started runs that exhausted
    // on the first turn (39 claude runs in a day). Below the floor the issue is
    // at the ceiling for admission purposes.
    const nearCeiling = HIGH_INPUT_TOKEN_RUN_THRESHOLD - (MIN_USEFUL_RUN_INPUT_TOKENS - 1);
    expect(decideIssueGenerationAdmission({
      aggregateInputTokens: nearCeiling,
      priorGenerationRuns: 1,
    })).toMatchObject({ decision: "deny", reason: "aggregate_input_ceiling" });
    expect(decideIssueGenerationAdmission({
      aggregateInputTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD - MIN_USEFUL_RUN_INPUT_TOKENS,
      priorGenerationRuns: 1,
    }).decision).toBe("allow");
  });

  it("shrinks an enforceable adapter cap to the remaining issue budget without loosening its default", () => {
    expect(resolveIssueScopedRunTokenCap({
      adapterType: "codex_local",
      configuredMaxTokensPerRun: undefined,
      remainingIssueInputTokens: 75_000,
    })).toBe(75_000);
    expect(resolveIssueScopedRunTokenCap({
      adapterType: "antigravity_local",
      configuredMaxTokensPerRun: undefined,
      remainingIssueInputTokens: 900_000,
    })).toBe(100_000);
    expect(resolveIssueScopedRunTokenCap({
      adapterType: "paperclip_shell_handler",
      configuredMaxTokensPerRun: undefined,
      remainingIssueInputTokens: 10_000,
    })).toBeNull();
  });
});
