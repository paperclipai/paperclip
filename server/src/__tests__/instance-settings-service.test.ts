import { describe, expect, it } from "vitest";
import { normalizeExperimentalSettings, normalizeGuardsConfig } from "../services/instance-settings.js";

describe("instance guards config normalization", () => {
  it("fills wake defaults for a legacy row that predates the wake section", () => {
    // A guards row written before W1/W2 has no `wake` key; the schema default
    // must backfill it so getGuards never returns guards.wake === undefined
    // (no DB migration required).
    const normalized = normalizeGuardsConfig({
      enabled: true,
      budget: {
        metric: "total_tokens",
        windowKind: "calendar_month_utc",
        companyMonthlyTokens: 40_000_000,
        agentMonthlyTokens: 8_000_000,
        warnPercent: 80,
        hardStop: true,
      },
      perRun: { maxTurnsPerRun: 120, maxTokensPerRun: 1_000_000 },
      breaker: { maxRunsPerAgentPerHour: 15, maxConsecutiveSameIssueRuns: 6 },
    });
    expect(normalized.wake).toEqual({
      skipIdleTimerWakes: true,
      pauseOnEmptyInstructions: true,
    });
  });

  it("preserves explicit wake overrides", () => {
    const normalized = normalizeGuardsConfig({
      wake: { skipIdleTimerWakes: false, pauseOnEmptyInstructions: true },
    });
    expect(normalized.wake.skipIdleTimerWakes).toBe(false);
    expect(normalized.wake.pauseOnEmptyInstructions).toBe(true);
  });
});

describe("instance settings service", () => {
  it("ignores retired experimental flags without resetting current settings", () => {
    expect(normalizeExperimentalSettings({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableIssuePlanDecompositions: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      enableNewestFirstIssueThread: true,
    })).toEqual({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableStreamlinedLeftNavigation: false,
      enableIssuePlanDecompositions: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      soloMode: false,
      strictBoardTransitions: false,
    });
  });
});
