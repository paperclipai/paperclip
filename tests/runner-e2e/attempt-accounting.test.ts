import { describe, expect, it } from "vitest";
import { buildCampaignAccounting, isSelectedCarryForward, retainedCampaignAttempts } from "./attempt-accounting.js";
import { buildRunnerCampaign, campaignHistoryRecord } from "./history.js";
import type { RunnerE2EResult } from "./types.js";

function result(attempt: number, cost: number, overrides: Partial<RunnerE2EResult> = {}): RunnerE2EResult {
  return {
    schema: "paperclip.runner-e2e.result/v2",
    accountingIdentity: { campaignId: "campaign", attemptId: `attempt-${attempt}` },
    executionId: "core-compatibility.runner-codex.local.message-marker", suiteId: "core-compatibility",
    attempt, status: attempt === 1 ? "failed" : "passed", profileId: "runner-codex",
    environmentId: "local", caseId: "message-marker", provider: "codex", model: "fixture", runtimeMode: "native",
    startedAt: `2026-10-20T00:0${attempt}:00Z`, finishedAt: `2026-10-20T00:0${attempt}:01Z`, durationMs: 1000,
    runIds: [`run-${attempt}`], usage: { inputTokens: 100, outputTokens: 10, costUsd: cost }, cleanup: "passed",
    ...overrides,
  };
}

describe("retained attempt accounting", () => {
  it("adds failed and successful attempts exactly once without changing the chosen verdict", () => {
    const failed = result(1, 0.01);
    const passed = result(2, 0.02);
    const campaign = buildRunnerCampaign({ campaignId: "campaign", generatedAt: passed.finishedAt,
      expected: [passed.executionId], results: [passed], attempts: [failed, passed, structuredClone(passed)] });
    expect(campaign).toMatchObject({ passed: 1, failed: 0, selected: 1,
      accounting: { scope: "retained_attempts", missingAttempts: 0, attempts: [{ attempt: 1 }, { attempt: 2 }] },
      billing: { testCount: 1, testsWithCompleteBilling: 1, reportedLlmCostUsd: 0.03,
        llm: { runCount: 2, inputTokens: 200, outputTokens: 20 } } });
    expect(campaign.results[0]!.billing!.reportedCostUsd).toBe(0.02);
    expect(campaign.suites[0]!.billing.reportedLlmCostUsd).toBe(0.03);
    expect(campaignHistoryRecord(campaign, "https://example.test").billing.reportedLlmCostUsd).toBe(0.03);
  });

  it("retains known costs from interrupted attempts and marks missing attempts", () => {
    const interrupted = result(2, 0.02, { status: "failed", cleanup: "failed" });
    const campaign = buildRunnerCampaign({ campaignId: "campaign", generatedAt: interrupted.finishedAt,
      expected: [interrupted.executionId], results: [interrupted], attempts: [interrupted] });
    expect(campaign.accounting!.missingAttempts).toBe(1);
    expect(campaign.billing.reportedLlmCostUsd).toBe(0.02);
    expect(campaign.billing.testsWithCompleteBilling).toBe(0);
    const missing = result(0, 0, { runIds: [], usage: null });
    expect(buildCampaignAccounting({ results: [missing], attempts: [] })).toMatchObject({ missingAttempts: 1, attempts: [] });
  });

  it("labels legacy selected-only bundles without inventing receipts for retries", () => {
    const selected = result(2, 0.02, { accountingIdentity: undefined });
    expect(buildCampaignAccounting({ results: [selected] })).toMatchObject({
      scope: "selected_results", missingAttempts: 1, attempts: [{ attempt: 2 }],
    });
  });

  it("excludes other campaigns and ambiguous local artifacts", () => {
    const selected = result(2, 0.02);
    const other = result(1, 0.9, { accountingIdentity: { campaignId: "other", attemptId: "attempt-1" } });
    const first = result(1, 0.01);
    expect(retainedCampaignAttempts([selected], [first, selected, other])).toEqual({ attempts: [first, selected], excludedArtifacts: 1 });
    const legacy = { ...selected, accountingIdentity: undefined };
    expect(retainedCampaignAttempts([legacy], [legacy, { ...legacy }])).toEqual({ attempts: [legacy], excludedArtifacts: 1 });
  });

  it("uses the final supervisor receipt but rejects contradictory same-version costs", () => {
    const selected = result(1, 0.02);
    const early = { ...selected, finishedAt: selected.startedAt, usage: { inputTokens: 20, costUsd: 0.01 } };
    expect(buildCampaignAccounting({ results: [selected], attempts: [selected, early] }).attempts).toMatchObject([
      { billing: { reportedCostUsd: 0.02 } },
    ]);
    expect(() => buildCampaignAccounting({ results: [selected], attempts: [selected,
      { ...selected, usage: { inputTokens: 20, costUsd: 0.1 } }] })).toThrow("Conflicting accounting receipts");
  });
});

it("requires exact selector provenance before admitting a carried workflow result", () => {
  const retained = result(1, 0.01, { accountingIdentity: { campaignId: "gha-123-1", attemptId: "a" },
    source: { sha: "source", ref: "master", workflowRunUrl: "https://github.com/paperclipai/paperclip/actions/runs/123" } });
  const artifactName = `runner-e2e-123-1-${retained.executionId}`;
  const input = { requestedCampaignId: "gha-123-2", result: retained,
    relativeResultPath: `${artifactName}/gha-123-1-${retained.executionId}/attempt-1/result.json`,
    selection: { version: 1, workflowRunId: "123", workflowRunAttempt: 2, sourceSha: retained.source!.sha,
      sourceRef: retained.source!.ref, workflowRunUrl: retained.source!.workflowRunUrl,
      selections: [{ executionId: retained.executionId, workflowAttempt: 1, artifactName }] } };
  expect(isSelectedCarryForward(input)).toBe(true);
  expect(isSelectedCarryForward({ ...input, selection: undefined })).toBe(false);
  expect(isSelectedCarryForward({ ...input, requestedCampaignId: "gha-999-2" })).toBe(false);
  expect(isSelectedCarryForward({ ...input, relativeResultPath: `unselected/${input.relativeResultPath}` })).toBe(false);
  expect(isSelectedCarryForward({ ...input, result: { ...retained, source: { ...retained.source!, sha: "other" } } })).toBe(false);
  expect(isSelectedCarryForward({ ...input, result: { ...retained, accountingIdentity: { campaignId: "gha-123-3", attemptId: "a" } } })).toBe(false);
});
