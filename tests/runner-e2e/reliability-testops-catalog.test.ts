import { expect, it } from "vitest";
import { buildMatrixJobs, parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { runnerMatrix } from "./catalog.js";
import { scheduledSelection } from "./scheduled-operations.js";
import { RELIABILITY_PLAN_PROFILE_ID, everydayReliabilityCaseIds, reliabilityPlanCells, reliabilityPlanExecutionIds,
  everydayReliabilitySignatures } from "./everyday-reliability-cases.js";
import { productReportingMatcherKinds, productReportingModels, projectProductResults, testOpsPlans } from "./product-regression-testops.mjs";
import { reliabilityDefinitions, reliabilityModel, reliabilityProfile } from "./reliability-testops.mjs";
import { gradeLongSilentCommand, gradeQueuedAcrossRestart, gradeResumptionRule } from "./everyday-reliability.js";
import type { RunnerE2EResult } from "./types.js";

it("binds every TestOps Reliability case to its existing explicit-only cell", () => {
  expect(reliabilityProfile).toBe(RELIABILITY_PLAN_PROFILE_ID);
  expect(reliabilityDefinitions.map(row => row.name)).toEqual(everydayReliabilityCaseIds);
  expect(reliabilityDefinitions.map(row => row.executionId)).toEqual(reliabilityPlanExecutionIds("everyday-workflows"));
  const executions = selectRunnerExecutions(parseRunnerSelectors(reliabilityDefinitions.flatMap(row => ["--id", row.executionId])));
  expect(executions).toHaveLength(7);
  for (const row of reliabilityDefinitions) {
    const execution = executions.find(value => value.id === row.executionId)!;
    expect(execution.suite.id).toBe(row.suite);
    expect(execution.task.id).toBe(row.name);
    const cell = reliabilityPlanCells[row.name as keyof typeof reliabilityPlanCells];
    expect(execution.profile.id).toBe(row.profile);
    expect(row.profile).toBe(cell.profile);
    expect(execution.profile.model).toBe(row.model);
    expect(productReportingModels).toContain(execution.profile.model);
    expect(execution.environment.id).toBe(row.environment);
    expect(row.environment).toBe(cell.environment);
    // Six cells use DeepSeek 1017 on OpenCode; queue-steer needs a steering-capable driver (Codex app server).
    if (row.name === "queue-steer") expect([execution.profile.provider, execution.profile.id]).toEqual(["codex", "runner-codex"]);
    else expect([execution.profile.provider, execution.profile.model]).toEqual(["opencode", reliabilityModel]);
    expect(row.signature).toBe(everydayReliabilitySignatures[row.name as keyof typeof everydayReliabilitySignatures].signature);
    // OpenRouter (or the OpenAI key for the Codex steering cell), plus Daytona only for sandbox cells.
    const model = row.profile === reliabilityProfile ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
    expect(execution.requiredCredentials).toEqual(row.environment === "daytona" ? [model, "DAYTONA_API_KEY"] : [model]);
    expect(execution.task.automaticRetryPolicy).toBe("single_attempt");
  }
  // S49 ran on a per-turn lease; the other Daytona cells keep the suite's warm lease.
  expect(executions.find(value => value.task.id === "three-turn-revise")!.environment.configurationKey).toBeUndefined();
  expect(executions.find(value => value.task.id === "long-silent-command")!.environment.configurationKey).toBe("warm-reuse-v1");
  for (const job of buildMatrixJobs(executions)) expect(job.timeoutMinutes).toBeGreaterThan(20);
});

it("keeps the plan out of generic, scheduled and per-PR selections and adds no DeepSeek everyday cells", () => {
  const plan = new Set(reliabilityDefinitions.map(row => row.executionId));
  const select = (args: string[]) => {
    try { return selectRunnerExecutions(parseRunnerSelectors(args)); }
    catch (error) {
      if (error instanceof Error && error.message === "Runner E2E selectors matched zero executions") return [];
      throw error;
    }
  };
  for (const args of [["--all"], ["--suite", "everyday-workflows"], ["--profile", RELIABILITY_PLAN_PROFILE_ID], ["--environment", "daytona"]]) {
    expect(select(args).filter(execution => plan.has(execution.id)), args.join(" ")).toEqual([]);
  }
  for (const cadence of ["daily", "weekly"] as const) expect(scheduledSelection(cadence).filter(id => plan.has(id))).toEqual([]);
  expect(select(["--suite", "everyday-workflows", "--profile", "runner-codex"]).filter(execution => plan.has(execution.id))).toEqual([]);
  expect(runnerMatrix.filter(execution => execution.profile.id === RELIABILITY_PLAN_PROFILE_ID && execution.suite.id === "everyday-workflows")
    .map(execution => execution.id).sort()).toEqual([...plan].filter(id => id.includes(RELIABILITY_PLAN_PROFILE_ID)).sort());
  expect([...plan].filter(id => !id.includes(RELIABILITY_PLAN_PROFILE_ID))).toEqual(["everyday-workflows.runner-codex.daytona.queue-steer"]);
  // The chat-feature candidate cell is unchanged and stays local.
  expect(runnerMatrix.filter(execution => execution.profile.id === RELIABILITY_PLAN_PROFILE_ID && execution.suite.id !== "everyday-workflows")
    .map(execution => execution.id)).toEqual(["chat-features.runner-opencode-deepseek-1017.local.create-backlog"]);
});

it("reports the real reliability grader output through the standing projection without dropping failures", () => {
  const cases = testOpsPlans({ planId: 9001, caseIds: Object.fromEntries(reliabilityDefinitions.map((row, index) => [row.name, 9101 + index])) }).reliability!;
  const checks = [
    ...gradeResumptionRule({ observations: [], retryClicks: [] }),
    ...gradeLongSilentCommand({ iterations: 13, iterationSeconds: 60, stopSamples: [], nonce: "control" }),
    ...gradeQueuedAcrossRestart({ runs: [], commentId: "comment", restartStartedAt: 0, dispatchedBeforeRestart: false, waitObservations: [] }),
  ];
  expect(checks.some(check => !check.passed)).toBe(true);
  for (const row of cases) {
    const matcherResults = checks.map(check => ({ matcher: { kind: "json_path" as const, path: check.id, expected: true }, passed: check.passed, detail: "contract control" }));
    for (const result of matcherResults) expect(productReportingMatcherKinds).toContain(result.matcher.kind);
    const sourceSha = "b".repeat(40);
    const raw: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: row.executionId, suiteId: row.suite, caseId: row.name,
      profileId: row.profile, environmentId: row.environment, source: { sha: sourceSha, ref: null, workflowRunUrl: null },
      attempt: 1, status: "failed", failureClass: "candidate_failure", cleanup: "passed", model: row.model, provider: "opencode",
      runtimeMode: "native", startedAt: "2026-11-06T00:00:00Z", finishedAt: "2026-11-06T00:00:01Z", durationMs: 1000, matcherResults };
    const projected = projectProductResults({ schema: "paperclip.runner-e2e.campaign/v2", campaignId: "gha-123-1", source: { sha: sourceSha },
      expected: [row.executionId], results: [raw] }, { runId: "123", attempt: "1", workflowSha: "a".repeat(40), cases: [row] }, sourceSha);
    expect(projected.summary).toMatchObject({ selected: 1, passed: 0, failed: 1, plan: "reliability", fullPlan: false });
    expect(projected.records[1]!.value.checks?.map(check => check.passed)).toEqual(matcherResults.map(check => check.passed));
    expect(projected.records[1]!.value.environment).toBe(row.environment);
  }
});
