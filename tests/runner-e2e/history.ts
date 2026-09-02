import { runnerMatrix, runnerSuites } from "./catalog.js";
import {
  aggregateCampaignBilling,
  summarizeExecutionBilling,
} from "./billing.js";
import type {
  RunnerE2ECampaign,
  RunnerE2EHistoryCampaign,
  RunnerE2EHistoryIndex,
  RunnerE2EResult,
} from "./types.js";

export function canonicalExecutionId(id: string) {
  if (runnerMatrix.some((execution) => execution.id === id)) return id;
  const coreId = `core-compatibility.${id}`;
  return runnerMatrix.some((execution) => execution.id === coreId)
    ? coreId
    : id;
}

export function upgradeRunnerResult(result: RunnerE2EResult): RunnerE2EResult {
  const executionId = canonicalExecutionId(result.executionId);
  const execution = runnerMatrix.find(
    (candidate) => candidate.id === executionId,
  );
  if (!execution) return result;
  return {
    ...result,
    executionId,
    suiteId: result.suiteId ?? execution.suite.id,
    suiteDefinitionHash:
      result.suiteDefinitionHash ?? execution.suiteDefinitionHash,
    ...(result.schema === "paperclip.runner-e2e.result/v1"
      ? {
          source: result.source ?? {
            sha: null,
            ref: null,
            workflowRunUrl: null,
          },
        }
      : {}),
  };
}

export function buildRunnerCampaign(input: {
  campaignId: string;
  generatedAt: string;
  expected: readonly string[];
  results: readonly RunnerE2EResult[];
  eventName?: string | null;
}): RunnerE2ECampaign {
  const expected = input.expected.map(canonicalExecutionId);
  const results = input.results.map((result) => ({
    ...upgradeRunnerResult(result),
    billing: result.billing ?? summarizeExecutionBilling(result),
  }));
  const resultSource = results.find((result) => result.source)?.source;
  const source = {
    sha: resultSource?.sha ?? process.env.GITHUB_SHA ?? null,
    ref: resultSource?.ref ?? process.env.GITHUB_REF ?? null,
    workflowRunUrl:
      resultSource?.workflowRunUrl ??
      (process.env.GITHUB_SERVER_URL &&
      process.env.GITHUB_REPOSITORY &&
      process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null),
    eventName: input.eventName ?? process.env.GITHUB_EVENT_NAME ?? null,
  };
  const suites = runnerSuites
    .map((suite) => {
      const suiteExpected = expected.filter((id) =>
        id.startsWith(`${suite.id}.`),
      );
      if (suiteExpected.length === 0) return null;
      const suiteResults = results.filter(
        (result) => result.suiteId === suite.id,
      );
      const passed = suiteResults.filter(
        (result) => result.status === "passed" && result.cleanup === "passed",
      ).length;
      const executed = suiteResults.filter(
        (result) => result.attempt > 0,
      ).length;
      return {
        suiteId: suite.id,
        suiteDefinitionHash:
          suiteResults[0]?.suiteDefinitionHash ??
          runnerMatrix.find((execution) => execution.suite.id === suite.id)!
            .suiteDefinitionHash,
        expected: suite.expectedMatrixSize,
        selected: suiteExpected.length,
        executed,
        passed,
        failed: suiteExpected.length - passed,
        retries: suiteResults.reduce(
          (total, result) => total + Math.max(0, result.attempt - 1),
          0,
        ),
        cleanupPassed: suiteResults.every(
          (result) => result.cleanup === "passed",
        ),
        complete: suiteExpected.length === suite.expectedMatrixSize,
        durationMs: suiteResults.reduce(
          (total, result) => total + result.durationMs,
          0,
        ),
        billing: aggregateCampaignBilling(suiteResults),
      };
    })
    .filter((suite): suite is NonNullable<typeof suite> => Boolean(suite));
  const passed = results.filter(
    (result) => result.status === "passed" && result.cleanup === "passed",
  ).length;
  const rankingSnapshots = [
    ...new Map(
      results.flatMap((result) =>
        result.rankingSnapshot
          ? [
              [
                result.rankingSnapshot.snapshotId,
                {
                  snapshotId: result.rankingSnapshot.snapshotId,
                  capturedAt: result.rankingSnapshot.capturedAt,
                  sourceUrl: result.rankingSnapshot.sourceUrl,
                },
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  return {
    schema: "paperclip.runner-e2e.campaign/v2",
    campaignId: input.campaignId,
    generatedAt: input.generatedAt,
    source,
    expected,
    complete:
      suites.length === runnerSuites.length &&
      suites.every((suite) => suite.complete),
    selected: expected.length,
    executed: results.filter((result) => result.attempt > 0).length,
    passed,
    failed: expected.length - passed,
    retries: results.reduce(
      (total, result) => total + Math.max(0, result.attempt - 1),
      0,
    ),
    cleanupPassed: results.every((result) => result.cleanup === "passed"),
    rankingSnapshots,
    billing: aggregateCampaignBilling(results),
    suites,
    results,
  };
}

export function campaignHistoryRecord(
  campaign: RunnerE2ECampaign,
  publicBaseUrl: string,
): RunnerE2EHistoryCampaign {
  const publicUrl = `${publicBaseUrl.replace(/\/$/, "")}/campaigns/${encodeURIComponent(campaign.campaignId)}/`;
  return {
    campaignId: campaign.campaignId,
    generatedAt: campaign.generatedAt,
    source: campaign.source,
    complete: campaign.complete,
    selected: campaign.selected,
    executed: campaign.executed,
    passed: campaign.passed,
    failed: campaign.failed,
    retries: campaign.retries,
    cleanupPassed: campaign.cleanupPassed,
    publicUrl,
    billing: campaign.billing,
    suites: campaign.suites,
    executions: campaign.results.map((result) => ({
      executionId: result.executionId,
      suiteId: result.suiteId ?? "core-compatibility",
      profileId: result.profileId,
      environmentId: result.environmentId,
      caseId: result.caseId,
      provider: result.provider,
      model: result.model,
      status: result.status,
      durationMs: result.durationMs,
      attempt: result.attempt,
      cleanup: result.cleanup,
      billing: result.billing ?? summarizeExecutionBilling(result),
    })),
  };
}

export function emptyRunnerHistory(): RunnerE2EHistoryIndex {
  return {
    schema: "paperclip.runner-e2e.history/v1",
    updatedAt: new Date(0).toISOString(),
    latestCampaignId: null,
    latestGreenCampaignId: null,
    latestBySuite: {},
    latestGreenBySuite: {},
    campaigns: [],
  };
}

export function mergeRunnerHistory(
  current: RunnerE2EHistoryIndex | null | undefined,
  campaign: RunnerE2EHistoryCampaign,
): RunnerE2EHistoryIndex {
  const base =
    current?.schema === "paperclip.runner-e2e.history/v1"
      ? current
      : emptyRunnerHistory();
  const campaigns = [
    campaign,
    ...base.campaigns.filter(
      (candidate) => candidate.campaignId !== campaign.campaignId,
    ),
  ].sort(
    (left, right) =>
      Date.parse(right.generatedAt) - Date.parse(left.generatedAt),
  );
  const latestBySuite: Record<string, string> = {};
  const latestGreenBySuite: Record<string, string> = {};
  for (const candidate of campaigns) {
    for (const suite of candidate.suites) {
      latestBySuite[suite.suiteId] ??= candidate.campaignId;
      if (suite.complete && suite.failed === 0) {
        latestGreenBySuite[suite.suiteId] ??= candidate.campaignId;
      }
    }
  }
  return {
    schema: "paperclip.runner-e2e.history/v1",
    updatedAt: new Date().toISOString(),
    latestCampaignId: campaigns[0]?.campaignId ?? null,
    latestGreenCampaignId:
      campaigns.find(
        (candidate) => candidate.complete && candidate.failed === 0,
      )?.campaignId ?? null,
    latestBySuite,
    latestGreenBySuite,
    campaigns,
  };
}
