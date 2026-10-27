import { isIncompleteFirstTaskResult } from "./case-outcome.js";
import { buildCampaignAccounting } from "./attempt-accounting.js";
import { validateEvalOperationsReport } from "./operations-report.js";
import { validateCampaignFeedbackReview } from "./feedback-dispositions.js";
import { validateBraintrustExperimentReceipt } from "./braintrust-experiment.js";
import { classifyLatency } from "./latency-timing.js";
import { summarizeStartupReuse } from "../../packages/adapter-utils/src/startup-reuse.js";
import { validateCampaignAccounting, validateRetainedRunnerResult } from "./result-validation.js";
import {
  discoverReportCatalog,
  parseReportExecutionId,
  type ReportExecution,
} from "./report-catalog.js";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import {
  aggregateBillingSummaries,
  summarizeExecutionBilling,
} from "./billing.js";
import { resolveRunnerE2ESource } from "./source.js";
import type {
  RunnerE2ECampaign,
  RunnerE2ECampaignAccounting,
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
  validateRetainedRunnerResult(result);
  if (result.latencyProbes) result = { ...result, latencyProbes: result.latencyProbes.map(probe => {
    const corrected = classifyLatency(probe, probe.target);
    return probe.verdict === corrected.verdict ? corrected
      : { ...corrected, recordedVerdict: probe.recordedVerdict ?? probe.verdict };
  }) };
  result = { ...result, startupReuse: result.startupReuse ?? (result.runIds ?? []).map(runId => ({
    runId, ...summarizeStartupReuse([]),
  })) };
  const executionId = canonicalExecutionId(result.executionId);
  const execution = runnerMatrix.find(
    (candidate) => candidate.id === executionId,
  );
  if (!execution)
    return {
      ...result,
      executionId,
      suiteId: result.suiteId ?? parseReportExecutionId(executionId).suiteId,
    };
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
  attempts?: readonly RunnerE2EResult[];
  accounting?: RunnerE2ECampaignAccounting;
  operations?: RunnerE2ECampaign["operations"];
  feedbackReview?: RunnerE2ECampaign["feedbackReview"];
  braintrustExperiment?: RunnerE2ECampaign["braintrustExperiment"];
  excludedArtifacts?: number;
  eventName?: string | null;
  catalog?: readonly ReportExecution[];
}): RunnerE2ECampaign {
  const expected = input.expected.map(canonicalExecutionId);
  const results = input.results.map((result) => ({
    ...upgradeRunnerResult(result),
    billing: result.billing ?? summarizeExecutionBilling(result),
  }));
  const accounting = input.accounting ?? buildCampaignAccounting({
    results,
    attempts: input.attempts?.map(upgradeRunnerResult),
    excludedArtifacts: input.excludedArtifacts,
  });
  validateCampaignAccounting(accounting);
  if (input.operations) validateEvalOperationsReport(input.operations);
  const billingFor = (selectedResults: readonly RunnerE2EResult[]) => {
    const ids = new Set(selectedResults.map(result => result.executionId));
    const receipts = accounting.attempts.filter(attempt => ids.has(attempt.executionId));
    const billing = aggregateBillingSummaries([
      ...receipts,
      ...selectedResults.filter(result => !receipts.some(attempt => attempt.executionId === result.executionId))
        .map(result => ({ executionId: result.executionId, billing: summarizeExecutionBilling(result) })),
    ]);
    billing.testsWithCompleteBilling = selectedResults.filter(result => {
      const retained = receipts.filter(attempt => attempt.executionId === result.executionId);
      return retained.length > 0 && retained.every(attempt => attempt.billing.complete) &&
        new Set(retained.map(attempt => attempt.attempt)).size >= Math.max(result.attempt, ...retained.map(attempt => attempt.attempt));
    }).length;
    return billing;
  };
  const knownCatalog = input.catalog ?? runnerMatrix;
  const catalog = discoverReportCatalog({
    catalog: knownCatalog,
    expected,
    results,
  });
  const discoveredSuites = [
    ...new Map(
      catalog.map((execution) => [execution.suite.id, execution.suite]),
    ).values(),
  ];
  const resultSource = results.find((result) => result.source)?.source;
  const source = {
    ...resolveRunnerE2ESource(resultSource),
    eventName: input.eventName ?? process.env.GITHUB_EVENT_NAME ?? null,
  };
  const suites = discoveredSuites
    .map((suite) => {
      const suiteExpected = expected.filter((id) =>
        id.startsWith(`${suite.id}.`),
      );
      if (suiteExpected.length === 0) return null;
      const suiteResults = results.filter(
        (result) =>
          expected.includes(result.executionId) &&
          result.executionId.startsWith(`${suite.id}.`),
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
          catalog.find((execution) => execution.suite.id === suite.id)!
            .suiteDefinitionHash,
        expected: suite.expectedMatrixSize,
        selected: suiteExpected.length,
        executed,
        passed,
        failed: suiteExpected.length - passed - suiteResults.filter(r => isIncompleteFirstTaskResult(r)).length,
        incomplete: suiteResults.filter(r => isIncompleteFirstTaskResult(r)).length,
        retries: suiteResults.reduce(
          (total, result) => total + Math.max(0, result.attempt - 1),
          0,
        ),
        cleanupPassed: suiteResults.every(
          (result) => result.cleanup === "passed",
        ),
        complete:
          suiteExpected.length === suite.expectedMatrixSize &&
          knownCatalog.filter((execution) => execution.suite.id === suite.id)
            .length === suiteExpected.length &&
          knownCatalog
            .filter((execution) => execution.suite.id === suite.id)
            .every(
              (execution) =>
                suiteExpected.includes(execution.id) &&
                suiteResults.every(
                  (result) =>
                    result.suiteDefinitionHash ===
                    execution.suiteDefinitionHash,
                ),
            ),
        durationMs: suiteResults.reduce(
          (total, result) => total + result.durationMs,
          0,
        ),
        billing: billingFor(suiteResults),
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
  const campaign: RunnerE2ECampaign = {
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
    failed: expected.length - passed - results.filter(r => isIncompleteFirstTaskResult(r)).length,
    incomplete: results.filter(r => isIncompleteFirstTaskResult(r)).length,
    retries: results.reduce(
      (total, result) => total + Math.max(0, result.attempt - 1),
      0,
    ),
    cleanupPassed: results.every((result) => result.cleanup === "passed"),
    rankingSnapshots,
    billing: billingFor(results),
    accounting,
    ...(input.operations ? { operations: input.operations } : {}),
    ...(input.feedbackReview ? { feedbackReview: input.feedbackReview } : {}),
    ...(input.braintrustExperiment ? { braintrustExperiment: input.braintrustExperiment } : {}),
    suites,
    results,
  };
  if (campaign.feedbackReview) validateCampaignFeedbackReview(campaign, campaign.feedbackReview);
  if (campaign.braintrustExperiment) validateBraintrustExperimentReceipt(campaign, campaign.braintrustExperiment);
  return campaign;
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
    incomplete: campaign.incomplete ?? 0,
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
      status: isIncompleteFirstTaskResult(result) ? "incomplete" : result.status,
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
  retention?: { now: number; maxAgeMs: number; maxCampaigns: number },
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
  ].filter(candidate => !retention || (
    Number.isFinite(Date.parse(candidate.generatedAt)) &&
    Date.parse(candidate.generatedAt) > retention.now - retention.maxAgeMs &&
    Date.parse(candidate.generatedAt) <= retention.now + 60_000
  )).sort(
    (left, right) =>
      Date.parse(right.generatedAt) - Date.parse(left.generatedAt),
  ).slice(0, retention?.maxCampaigns);
  const latestBySuite: Record<string, string> = {};
  const latestGreenBySuite: Record<string, string> = {};
  for (const candidate of campaigns) {
    for (const suite of candidate.suites) {
      latestBySuite[suite.suiteId] ??= candidate.campaignId;
      if (suite.complete && suite.failed === 0 && (suite.incomplete ?? 0) === 0) {
        latestGreenBySuite[suite.suiteId] ??= candidate.campaignId;
      }
    }
  }
  return {
    schema: "paperclip.runner-e2e.history/v1",
    updatedAt: new Date(retention?.now ?? Date.now()).toISOString(),
    latestCampaignId: campaigns[0]?.campaignId ?? null,
    latestGreenCampaignId:
      campaigns.find(
        (candidate) => candidate.complete && candidate.failed === 0 && (candidate.incomplete ?? 0) === 0,
      )?.campaignId ?? null,
    latestBySuite,
    latestGreenBySuite,
    campaigns,
  };
}
