import { reserveCompletionQuality } from "./completion-quality.js";
import { describe, expect, it } from "vitest";
import {
  aggregateCampaignBilling,
  buildRuntimeUsage,
  summarizeExecutionBilling,
} from "./billing.js";
import type { RunnerE2EResult } from "./types.js";
import { durationLabel, llmCostLabel } from "./report-format.js";
import { validateRetainedRunnerResult } from "./result-validation.js";

function result(overrides: Partial<RunnerE2EResult> = {}): RunnerE2EResult {
  return {
    schema: "paperclip.runner-e2e.result/v1",
    executionId: "legacy-claude.local.message-marker",
    attempt: 1,
    status: "passed",
    profileId: "legacy-claude",
    environmentId: "local",
    caseId: "message-marker",
    provider: "anthropic",
    model: "fixture-model",
    runtimeMode: "legacy",
    runIds: ["run-1"],
    startedAt: "2026-08-27T00:00:00.000Z",
    finishedAt: "2026-08-27T00:00:02.000Z",
    durationMs: 2_000,
    cleanup: "passed",
    ...overrides,
  };
}

describe("runner E2E billing summaries", () => {
  it("preserves captured token totals when a retained result has only a billing summary", () => {
    const billing = summarizeExecutionBilling(result({ usage: {
      inputTokens: 59_989, outputTokens: 4_974, cachedInputTokens: 488_798, costStatus: "unpriced",
    } }));
    const retained = result({ billing });
    expect(summarizeExecutionBilling(retained)).toEqual(billing);
    expect(aggregateCampaignBilling([retained])).toMatchObject({ llm: {
      inputTokens: 59_989, outputTokens: 4_974, cachedInputTokens: 488_798,
      runsWithTokenUsage: 1, runsWithReportedCost: 0,
    }, testsWithCompleteBilling: 0 });
  });

  it("uses newly captured usage instead of a stale retained billing summary", () => {
    const billing = summarizeExecutionBilling(result({ usage: { inputTokens: 100, outputTokens: 10, costStatus: "unpriced" } }));
    const fresh = summarizeExecutionBilling(result({ billing, usage: { inputTokens: 200, outputTokens: 20, costStatus: "unpriced" } }));
    expect(fresh.llm).toMatchObject({ inputTokens: 200, outputTokens: 20, runsWithReportedCost: 0 });
    expect(fresh.complete).toBe(false);
  });

  it("keeps missing agent time separate from attempt duration and measured zero", () => {
    const interrupted = result({ status: "failed", durationMs: 108_850 });
    expect(summarizeExecutionBilling(interrupted).runtime.agentRunDurationMs).toBeNull();
    const noCapturedRuns = result({ ...interrupted, runIds: [],
      runtimeUsage: buildRuntimeUsage({ environmentId: "local", runs: [] }) });
    expect(noCapturedRuns.runtimeUsage?.agentRunDurationMs).toBeNull();
    expect(() => validateRetainedRunnerResult(noCapturedRuns)).not.toThrow();
    const measured = result({ runtimeUsage: buildRuntimeUsage({ environmentId: "local", runs: [
      { startedAt: "2026-10-21T00:00:00Z", finishedAt: "2026-10-21T00:00:04Z" },
      { startedAt: "2026-10-21T00:00:01Z", finishedAt: "2026-10-21T00:00:05Z" },
    ] }) });
    expect(aggregateCampaignBilling([measured]).agentRunDurationMs).toBe(8000);
    expect(aggregateCampaignBilling([measured, interrupted]).agentRunDurationMs).toBeNull();
    expect(aggregateCampaignBilling([measured, noCapturedRuns]).agentRunDurationMs).toBeNull();
    expect(durationLabel(aggregateCampaignBilling([measured, interrupted]).agentRunDurationMs)).toBe("Unknown");
    const zero = buildRuntimeUsage({ environmentId: "local", runs: [
      { startedAt: "2026-10-21T00:00:00Z", finishedAt: "2026-10-21T00:00:00Z" },
    ] });
    expect(zero.agentRunDurationMs).toBe(0);
    expect(durationLabel(zero.agentRunDurationMs)).toBe("0ms");
  });

  it.each([undefined, "not-a-date", "2026-10-20T23:59:59Z"])("retains unknown time for a missing or invalid end timestamp: %s", finishedAt => {
    const runtimeUsage = buildRuntimeUsage({ environmentId: "daytona", runs: [
      { startedAt: "2026-10-21T00:00:00Z", finishedAt: "2026-10-21T00:00:04Z" },
      { startedAt: "2026-10-21T00:00:00Z", finishedAt },
    ], leases: [{ acquiredAt: "2026-10-21T00:00:00Z", releasedAt: finishedAt,
      metadata: { cpu: 4, memory: 4, disk: 10 } }] });
    expect(runtimeUsage).toMatchObject({ agentRunDurationMs: null, leaseDurationMs: null, costStatus: "unavailable" });
    expect(runtimeUsage.estimatedListCostUsd).toBeUndefined();
    const retained = result({ environmentId: "daytona", runtimeUsage });
    expect(() => validateRetainedRunnerResult(retained)).not.toThrow();
    expect(aggregateCampaignBilling([retained, result()]).leaseDurationMs).toBeNull();
    expect(aggregateCampaignBilling([result()]).leaseDurationMs).toBe(0);
  });

  it("reads precise provider amounts without relabeling estimates or unpriced usage", () => {
    const precise = summarizeExecutionBilling(result({ usage: {
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 5,
      costUsdExact: "0.000000123", costStatus: "reported", accountingReceiptReady: true,
    } }));
    expect(precise.llm).toMatchObject({ reportedCostUsd: 0.000000123, runsWithReportedCost: 1, runsWithTokenUsage: 1 });
    const estimated = summarizeExecutionBilling(result({ usage: {
      inputTokens: 100, outputTokens: 10, costUsdExact: "0.012345678", costStatus: "estimated",
    } }));
    expect(estimated.llm).toMatchObject({ reportedCostUsd: 0, estimatedCostUsd: 0.012345678,
      runsWithReportedCost: 0, runsWithEstimatedCost: 1, costStatus: "estimated" });
    expect(estimated.observedAndEstimatedCostUsd).toBe(0.012345678);
    const unpriced = summarizeExecutionBilling(result({ usage: {
      inputTokens: 100, outputTokens: 10, costUsd: 0, costStatus: "unpriced",
    } }));
    expect(unpriced.llm).toMatchObject({ runsWithReportedCost: 0, costStatus: "unpriced" });
  });

  it("distinguishes explicit zero usage from a partial or missing receipt", () => {
    const zero = summarizeExecutionBilling(result({ usage: { inputTokens: 0, outputTokens: 0, costUsdExact: "0", accountingReceiptReady: true } }));
    expect(zero.complete).toBe(true);
    const partial = summarizeExecutionBilling(result({ usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01, accountingReceiptReady: false } }));
    expect(partial.reportedCostUsd).toBe(0.01);
    expect(partial.complete).toBe(false);
    expect(summarizeExecutionBilling(result({ usage: null })).complete).toBe(false);
  });
  it("retains a known OpenCode retry subtotal while the missing turn price stays incomplete", () => {
    const partial = result({ usage: { inputTokens: 30, outputTokens: 6, costUsd: 0.5, costStatus: "unpriced", accountingReceiptReady: true } });
    const billing = summarizeExecutionBilling(partial);
    expect(billing.llm).toMatchObject({ reportedCostUsd: 0.5, runsWithReportedCost: 1, runsWithPartialReportedCost: 1, costStatus: "partial" });
    expect(billing.observedAndEstimatedCostUsd).toBe(0.5);
    expect(billing.complete).toBe(false);
    expect(llmCostLabel(billing.reportedCostUsd, billing.llm)).toBe("$0.5000 (partial amount)");
    const campaign = aggregateCampaignBilling([partial, result({ executionId: "other", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.2 } })]);
    expect(campaign).toMatchObject({ reportedLlmCostUsd: 0.7, observedAndEstimatedCostUsd: 0.7, testsWithCompleteBilling: 1,
      llm: { runsWithReportedCost: 2, runsWithPartialReportedCost: 1, costStatus: "partial" } });
    expect(llmCostLabel(campaign.reportedLlmCostUsd, campaign.llm)).toBe("$0.7000 (partial amount)");
  });
  it("counts completion judge reservations and preserves unknown spend after interruption", () => {
    const pending = { ...reserveCompletionQuality({ sourceId: "chat", marker: "x", worker: { id: "task", status: "done", completedAt: "2026-09-01" }, documents: [{ id: "doc", issueId: "task", body: "result" }], comments: [{ id: "reply", issueId: "chat", authorAgentId: "agent", createdAt: "2026-09-02", body: "ready" }], runs: [] }, 0.5), name: "completion", expectedPass: true };
    const unknown = summarizeExecutionBilling(result({ completionQuality: [pending] }));
    expect(unknown.judge?.reservedCostUsd).toBe(pending.reservedCostUsd);
    expect(unknown.observedAndEstimatedCostUsd).toBeNull();
    expect(unknown.complete).toBe(false);
    const known = summarizeExecutionBilling(result({ completionQuality: [{ ...pending, status: "completed", inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 }] }));
    expect(known.judge).toMatchObject({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 });
  });
  it("summarizes provider-reported token usage and cost", () => {
    const billing = summarizeExecutionBilling(
      result({
        usage: {
          inputTokens: 12_000,
          outputTokens: 420,
          cachedInputTokens: 5_000,
          cacheAdjustedCostUsd: 0.08125,
          costStatus: "reported",
        },
      }),
    );
    expect(billing.llm).toMatchObject({
      runCount: 1,
      runsWithTokenUsage: 1,
      runsWithReportedCost: 1,
      inputTokens: 12_000,
      outputTokens: 420,
      cachedInputTokens: 5_000,
      totalTokens: 17_420,
      reportedCostUsd: 0.08125,
      costStatus: "reported",
    });
    expect(billing.runtime.costStatus).toBe("not_metered");
    expect(billing.complete).toBe(true);
  });

  it("labels missing and unpriced runs instead of treating them as free", () => {
    const billing = summarizeExecutionBilling(
      result({
        runIds: ["run-1", "run-2", "run-3"],
        usage: {
          runs: [
            {
              runId: "run-1",
              usage: {
                inputTokens: 1_000,
                outputTokens: 100,
                costUsd: 0.01,
              },
            },
            {
              runId: "run-2",
              usage: {
                inputTokens: 2_000,
                outputTokens: 200,
                costStatus: "unpriced",
              },
            },
            { runId: "run-3", usage: null },
          ],
        },
      }),
    );
    expect(billing.llm).toMatchObject({
      runCount: 3,
      runsWithTokenUsage: 2,
      runsWithReportedCost: 1,
      reportedCostUsd: 0.01,
      costStatus: "partial",
    });
    expect(billing.complete).toBe(false);
  });

  it("estimates Daytona list price from captured lease seconds and resources", () => {
    const runtime = buildRuntimeUsage({
      environmentId: "daytona",
      runs: [
        {
          startedAt: "2026-08-27T00:00:05.000Z",
          finishedAt: "2026-08-27T00:30:05.000Z",
        },
      ],
      leases: [
        {
          acquiredAt: "2026-08-27T00:00:00.000Z",
          releasedAt: "2026-08-27T01:00:00.000Z",
          metadata: { cpu: 4, memory: 4, disk: 10 },
        },
      ],
    });
    expect(runtime).toMatchObject({
      provider: "daytona",
      agentRunDurationMs: 1_800_000,
      leaseDurationMs: 3_600_000,
      leaseCount: 1,
      cpuCores: 4,
      memoryGiB: 4,
      diskGiB: 10,
      costStatus: "estimated",
      estimatedListCostUsd: 0.26748,
    });
  });

  it("aggregates tokens, reported spend, runtime estimates, and coverage", () => {
    const local = result({
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.004 },
    });
    const daytona = result({
      executionId: "runner-acpx-claude.daytona.message-marker",
      profileId: "runner-acpx-claude",
      environmentId: "daytona",
      runtimeMode: "native",
      usage: { inputTokens: 200, outputTokens: 30 },
      runtimeUsage: {
        provider: "daytona",
        agentRunDurationMs: 30_000,
        leaseDurationMs: 40_000,
        leaseCount: 1,
        cpuCores: 4,
        memoryGiB: 4,
        diskGiB: 10,
        estimatedListCostUsd: 0.002972,
        costStatus: "estimated",
        costSource: "daytona_public_list_price",
      },
    });
    expect(aggregateCampaignBilling([local, daytona])).toMatchObject({
      testCount: 2,
      reportedLlmCostUsd: 0.004,
      estimatedRuntimeCostUsd: 0.002972,
      llm: {
        runCount: 2,
        runsWithTokenUsage: 2,
        runsWithReportedCost: 1,
        inputTokens: 300,
        outputTokens: 50,
        costStatus: "partial",
      },
    });
  });
});
