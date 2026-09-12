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
