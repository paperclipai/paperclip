import { reserveCompletionQuality } from "./completion-quality.js";
import { describe, expect, it } from "vitest";
import {
  aggregateCampaignBilling,
  buildRuntimeUsage,
  summarizeExecutionBilling,
} from "./billing.js";
import type { RunnerE2EResult } from "./types.js";

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
  const readyEstimate = {
    inputTokens: 40019, outputTokens: 1787, cachedInputTokens: 198725,
    costUsd: null, cacheAdjustedCostUsd: null, costUsdExact: "0.275306000",
    accountingReceiptReady: true, costStatus: "estimated",
    pricingProvenance: { source: "rate_card", version: "fixture-rate-card-2026-09-30" },
  };
  it("counts a ready exact rate-card receipt separately from provider-reported spend", () => {
    const usage = structuredClone(readyEstimate);
    const billing = summarizeExecutionBilling(result({ usage }));
    expect(billing).toMatchObject({ reportedCostUsd: 0, estimatedLlmCostUsd: 0.275306,
      observedAndEstimatedCostUsd: 0.275306, complete: true,
      llm: { runsWithReportedCost: 0, runsWithEstimatedCost: 1, costStatus: "estimated",
        estimatedCostUsd: 0.275306, estimateProvenance: [readyEstimate.pricingProvenance] } });
    expect(usage).toEqual(readyEstimate);
  });
  it.each(["", " ", " 0.1", "0.1\n", "-1", "+1", "1e-3", "0x10", "NaN", "Infinity", "01.5", "1.", ".5", "0.123456789012345678901", "9007199254740992", `0.${"0".repeat(325)}1`])("rejects malformed or lossy exact USD: %j", (costUsdExact) => {
    const billing = summarizeExecutionBilling(result({ usage: { ...readyEstimate, costUsdExact, costUsd: 0.5 } }));
    expect(billing.llm).toMatchObject({ runsWithReportedCost: 0, runsWithEstimatedCost: 0, costStatus: "unpriced" });
    expect(billing.complete).toBe(false);
  });
  it.each(["0.000000001", "0.00000000000000000001", "1.000000000", "0.000000000"])("accepts lossless decimal receipts including zero with recorded token usage: %s", costUsdExact => {
    const billing = summarizeExecutionBilling(result({ usage: { ...readyEstimate, costUsdExact } }));
    expect(billing.estimatedLlmCostUsd).toBe(Number(costUsdExact));
    expect(billing.llm.runsWithEstimatedCost).toBe(1);
  });
  it.each([
    { accountingReceiptReady: false }, { accountingReceiptReady: undefined },
    { runDeltaComplete: false }, { complete: false }, { costStatus: "unpriced" },
    { costStatus: "unavailable" }, { pricingProvenance: undefined },
    { pricingProvenance: { source: "provider_reported", version: "fixture" } },
    { pricingProvenance: { source: "rate_card", version: "" } },
  ])("does not price an incomplete or unqualified receipt: %j", overrides => {
    const billing = summarizeExecutionBilling(result({ usage: { ...readyEstimate, ...overrides } }));
    expect(billing.llm.runsWithEstimatedCost).toBe(0);
    expect(billing.reportedCostUsd).toBe(0);
    expect(billing.complete).toBe(false);
  });
  it("preserves explicit unpriced zero and false readiness even with numeric cost", () => {
    for (const flags of [{ costStatus: "unpriced" }, { accountingReceiptReady: false }]) {
      const billing = summarizeExecutionBilling(result({ usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, ...flags } }));
      expect(billing.llm).toMatchObject({ runsWithReportedCost: 0, runsWithEstimatedCost: 0, costStatus: "unavailable" });
      expect(billing.complete).toBe(false);
    }
  });
  it("counts estimates once across mixed receipts and excludes fixture forecasts", () => {
    const mixed = result({ runIds: ["reported", "estimated", "unknown"], usage: { estimatedCostUsd: 10, runs: [
      { usage: { inputTokens: 1, costUsd: 0.1 } }, { usage: { ...readyEstimate, estimatedCostUsd: 20 } },
      { usage: { inputTokens: 1, estimatedCostUsd: 30 } },
    ] } });
    const billing = summarizeExecutionBilling(mixed);
    expect(billing.llm).toMatchObject({ runsWithReportedCost: 1, runsWithEstimatedCost: 1, costStatus: "partial" });
    expect(billing.observedAndEstimatedCostUsd).toBeCloseTo(0.375306);
    expect(billing.complete).toBe(false);
    const aggregate = aggregateCampaignBilling([mixed, result({ usage: readyEstimate })]);
    expect(aggregate).toMatchObject({ reportedLlmCostUsd: 0.1, estimatedLlmCostUsd: 0.550612,
      llm: { runsWithReportedCost: 1, runsWithEstimatedCost: 2, estimateProvenance: [readyEstimate.pricingProvenance] } });
    expect(aggregate.observedAndEstimatedCostUsd).toBeCloseTo(0.650612);
  });
  it("supports exact-only provider-reported receipts without reclassifying them", () => {
    const billing = summarizeExecutionBilling(result({ usage: { ...readyEstimate, costStatus: "reported", pricingProvenance: undefined } }));
    expect(billing).toMatchObject({ reportedCostUsd: 0.275306, estimatedLlmCostUsd: 0,
      llm: { runsWithReportedCost: 1, runsWithEstimatedCost: 0, costStatus: "reported" } });
  });
  it("retains sanitized billing when raw usage is absent and never closes unknown probe coverage", () => {
    const billing = { ...summarizeExecutionBilling(result({ usage: readyEstimate })), complete: false };
    const aggregate = aggregateCampaignBilling([result({ billing })]);
    expect(aggregate).toMatchObject({ reportedLlmCostUsd: 0, estimatedLlmCostUsd: 0.275306, observedAndEstimatedCostUsd: 0.275306, testsWithCompleteBilling: 0,
      llm: { runsWithReportedCost: 0, runsWithEstimatedCost: 1 } });
    // Available recorded usage must win over a previously incomplete summary.
    expect(aggregateCampaignBilling([result({ usage: readyEstimate, billing: summarizeExecutionBilling(result()) })]).estimatedLlmCostUsd).toBe(0.275306);
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
