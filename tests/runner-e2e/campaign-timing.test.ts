import { describe, expect, it } from "vitest";
import { buildCampaignAccounting } from "./attempt-accounting.js";
import { campaignAttemptTimeLabel, summarizeCampaignTiming } from "./campaign-timing.js";
import type { RunnerE2EResult } from "./types.js";

function result(executionId: string, startMs: number, durationMs: number, attempt = 1): RunnerE2EResult {
  return {
    schema: "paperclip.runner-e2e.result/v2", executionId, suiteId: "timing-fixture",
    accountingIdentity: { campaignId: "timing-campaign", attemptId: `${executionId}-${attempt}` },
    attempt, status: "passed", profileId: "runner-codex", environmentId: "local",
    caseId: executionId, provider: "codex", model: "fixture-model", runtimeMode: "native",
    startedAt: new Date(startMs).toISOString(), finishedAt: new Date(startMs + durationMs).toISOString(),
    durationMs, cleanup: "passed",
  };
}

describe("campaign timing evidence", () => {
  it("separates overlapping attempt work from the observed window and retains a failed retry", () => {
    const failed = { ...result("a", 0, 30_000), status: "failed" as const };
    const selected = [result("a", 30_000, 120_000, 2), result("b", 60_000, 60_000)];
    const accounting = buildCampaignAccounting({ results: selected, attempts: [failed, ...selected] });
    expect(summarizeCampaignTiming(selected, accounting)).toEqual({
      retainedAttempts: 3, missingAttempts: 0, subtotalMs: 210_000, totalMs: 210_000, observedWindowMs: 150_000,
    });
  });

  it("keeps a missing retry unknown while exposing the retained subtotal", () => {
    const timing = summarizeCampaignTiming([result("a", 60_000, 30_000, 2)]);
    expect(timing).toEqual({ retainedAttempts: 1, missingAttempts: 1, subtotalMs: 30_000, totalMs: null, observedWindowMs: 30_000 });
    expect(campaignAttemptTimeLabel(timing)).toBe("Unknown (30s retained subtotal)");
    const missing = summarizeCampaignTiming([{ ...result("a", 0, 0, 0), status: "failed" }]);
    expect(missing.totalMs).toBeNull();
    expect(missing.observedWindowMs).toBeNull();
    expect(campaignAttemptTimeLabel(missing)).toBe("Unknown");
  });

  it("does not derive an observed window from reversed retained timestamps", () => {
    const timing = summarizeCampaignTiming([{ ...result("a", 1000, 1000), finishedAt: new Date(0).toISOString() }]);
    expect(timing.totalMs).toBe(1000);
    expect(timing.observedWindowMs).toBeNull();
  });
});
