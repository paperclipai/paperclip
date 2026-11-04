import { expect, it } from "vitest";
import { selectRunnerExecutions, parseRunnerSelectors } from "./selectors.js";
import { productRegressionCases, productReportingModels, productReportingMatcherKinds, projectProductResults } from "./product-regression-testops.mjs";
import { gradeFirstTask } from "./first-task-scoring.js";
import { gradeContinuation } from "./continuation-scoring.js";
import type { ContinuationCase } from "./continuation-cases.js";
import { gradeTaskWorkspaces } from "./task-workspaces-scoring.js";
import { gradeRepositoryProof } from "./repository-verification.js";
import type { Matcher } from "./types.js";

it("runs every standing Product regression case through its existing full-stack fixture", () => {
  const executions = selectRunnerExecutions(parseRunnerSelectors(
    productRegressionCases.flatMap(row => ["--id", row.executionId]),
  ));
  expect(executions).toHaveLength(20);
  for (const row of productRegressionCases) {
    const execution = executions.find(value => value.id === row.executionId)!;
    expect(execution.suite.id).toBe(row.suite);
    expect(execution.task.id).toBe(row.name);
    expect(execution.profile.id).toBe(row.profile);
    expect(execution.environment.id).toBe("local");
    expect(execution.requiredCredentials).not.toContain("CODEX_AUTH_JSON");
    expect(productReportingModels).toContain(execution.profile.model);
    for (const matcher of execution.task.buildMatchers("report-contract-control", execution)) {
      expect(productReportingMatcherKinds).toContain(matcher.kind);
    }
    // Incomplete synthetic observations exercise the actual pure graders' output
    // contracts. Their failures must survive reporting; these are not live runs.
    let checks: Array<{ id: string; passed: boolean }> = [];
    if (row.suite === "first-task") checks = gradeFirstTask({
      caseId: row.name, nonce: "report-control", onboardingIssueId: "issue", agentId: "agent", initialTaskIds: ["issue"],
      instructions: [], configuredModel: execution.profile.model ?? null, observedModels: [], checks: [],
      checkpoints: [{ id: "opening", at: "2026-11-04T00:00:00Z", phase: "opening", issueId: "issue",
        tasks: [], agents: [], comments: [], interactions: [], documents: [], runs: [] }],
    });
    if (row.suite === "continuation") checks = gradeContinuation({ id: row.name as ContinuationCase,
      fact: "fact", marker: "marker", old: "old", injected: "injected", childTitle: "child", checkpoints: [], runtimeMode: "native" });
    if (row.suite === "task-workspaces") checks = gradeTaskWorkspaces({ nonce: "control", native: true, daytona: false,
      initial: null, checkpoints: [], projectCount: 0, runCount: 0, restarted: false, pendingInteractions: 0,
      activeOperations: 0, activeRecovery: false, artifact: null, remoteLeaseRunIds: [] });
    if (row.suite === "configured-repository") checks = gradeRepositoryProof({
      conversion: false, expectedLegacyAdapter: "codex_local", originalAdapter: "paperclip_runner", finalAdapter: "paperclip_runner",
      configurationBefore: "", configurationAfter: "", instructionsBefore: "", instructionsAfter: "", permissionsPreserved: false,
      expectedModel: execution.profile.model!, actualModel: null, actualProvider: null, expectedProvider: "codex", environmentRetained: false,
      issueDone: false, runCount: 0, committedRuns: 0, sourceBytes: "", currentSourceBytes: null, expectedCommit: "",
      downloaded: null, downloadVerified: false, visibleDelivery: false, pendingInteractions: 0,
    });
    const matcherResults = [
      ...execution.task.buildMatchers("report-contract-control", execution).map(matcher => ({ matcher, passed: false })),
      ...checks.map(check => ({ matcher: { kind: "json_path", path: check.id, expected: true } satisfies Matcher, passed: check.passed })),
    ];
    expect(matcherResults.length).toBeGreaterThan(0);
    const sourceSha = "b".repeat(40);
    const projected = projectProductResults({ schema: "paperclip.runner-e2e.campaign/v2", campaignId: "gha-123-1",
      source: { sha: sourceSha }, expected: [row.executionId], results: [{ executionId: row.executionId,
        suiteId: row.suite, caseId: row.name, profileId: row.profile, environmentId: "local", source: { sha: sourceSha },
        attempt: 1, status: "failed", failureClass: "candidate_failure", cleanup: "passed", model: execution.profile.model, matcherResults }] },
    { runId: "123", attempt: "1", workflowSha: "a".repeat(40), cases: [row] }, sourceSha);
    expect(projected.summary).toMatchObject({ selected: 1, passed: 0, failed: 1 });
    expect(projected.records[1]!.value.checks).toHaveLength(matcherResults.length);
    expect(projected.records[1]!.value.checks?.map(check => check.passed)).toEqual(matcherResults.map(check => check.passed));
  }
});
