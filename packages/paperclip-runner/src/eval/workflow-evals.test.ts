import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  RUNNER_WORKFLOW_IDS,
  assertRunnerWorkflowObservation,
  type RunnerWorkflowObservation,
} from "./workflow-contracts.js";
import { RUNNER_WORKFLOW_CATALOG, assertRunnerWorkflowCatalog } from "./workflow-catalog.js";
import { runDeterministicRunnerWorkflowMatrix } from "./workflow-harness.js";
import { scoreRunnerWorkflow } from "./workflow-scoring.js";
import {
  buildRunnerWorkflowEvalReport,
  compareRunnerWorkflowReports,
  renderRunnerWorkflowGitHubSummary,
  renderRunnerWorkflowJUnit,
  renderRunnerWorkflowMarkdown,
  runnerWorkflowAlerts,
} from "./workflow-report.js";
import {
  validateStressTraceabilityManifest,
  type StressTraceabilityManifest,
} from "./workflow-traceability.js";

describe("stress-derived Runner workflow catalog", () => {
  it("contains the twelve provider-neutral workflow families", () => {
    expect(() => assertRunnerWorkflowCatalog()).not.toThrow();
    expect(RUNNER_WORKFLOW_CATALOG.map((entry) => entry.id)).toEqual(RUNNER_WORKFLOW_IDS);
  });

  it("fails closed when sanitized provider fixtures lack workflow evidence", async () => {
    const matrix = await runDeterministicRunnerWorkflowMatrix();
    expect(matrix).toHaveLength(36);
    expect(matrix.every((entry) => entry.observation.classification === "candidate_failure")).toBe(true);
    expect(matrix.every((entry) => entry.scorecard.overall.passed === false)).toBe(true);
    expect(new Set(matrix.map((entry) => entry.observation.provider))).toEqual(new Set(["codex", "opencode", "acpx"]));

    const codex = matrix.find((entry) =>
      entry.scenarioId === "final-response" && entry.candidateId === "fixture-codex");
    expect(codex?.observation).toMatchObject({
      classification: "candidate_failure",
      failure: { code: "fixture_evidence_incomplete", category: "candidate" },
      base: {
        expectedCalls: ["finish_task"],
        observedCalls: [],
        trace: {
          itemId: "final-response-search",
          receiptIds: [],
          terminalPresent: false,
        },
      },
      observedPrpEventTypes: ["research.completed", "tool.execution.completed"],
      metrics: { attempts: 0, toolCount: 1 },
    });
    expect(codex?.observation.lifecycle).not.toHaveProperty("issueStatus");
    expect(codex?.observation.lifecycle).not.toHaveProperty("runStatus");
    expect(codex?.observation.lifecycle.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "required-prp-events", passed: false }),
      expect.objectContaining({ id: "terminal-authority", passed: false }),
      expect.objectContaining({ id: "lifecycle-state", passed: false }),
    ]));
    expect(codex?.observation.observedPrpEventTypes).not.toContain("run.terminal");
    expect(codex?.observation.presentation).not.toHaveProperty("responseSource");
    expect(codex?.observation.traceLineage).toMatchObject({
      digestVerified: false,
      dispositions: [],
      lineage: [],
    });
  });

  it("scores lifecycle, continuation, and presentation independently", async () => {
    const [source] = await runDeterministicRunnerWorkflowMatrix();
    const passing = structuredClone(source!.observation);
    passing.classification = "completed";
    delete passing.failure;
    for (const evidence of [passing.lifecycle, passing.continuation, passing.presentation]) {
      for (const entry of evidence.checks) {
        entry.passed = true;
        delete entry.reason;
      }
    }
    passing.base.observedCalls = [...passing.base.expectedCalls];
    passing.base.finalState.observed = passing.base.finalState.expected;
    passing.base.authorization.observed = passing.base.authorization.expected;
    passing.base.trace = {
      runId: "run-evidence",
      sessionId: "session-evidence",
      turnId: "turn-evidence",
      itemId: "item-evidence",
      receiptIds: passing.base.observedCalls.map((operation) => `receipt-${operation}`),
      terminalPresent: true,
    };
    passing.traceLineage.digestVerified = true;
    passing.traceLineage.ordered = true;

    const lifecycle = structuredClone(passing);
    lifecycle.lifecycle.checks[0]!.passed = false;
    lifecycle.lifecycle.checks[0]!.reason = "stale finalizer changed authoritative state";
    const lifecycleCard = scoreRunnerWorkflow(lifecycle, { bundleId: "test" });
    expect(lifecycleCard.dimensions.lifecycle_integrity.passed).toBe(false);
    expect(lifecycleCard.overall).toMatchObject({ gatePassed: false, score: 0, passed: false });

    const continuation = structuredClone(passing);
    continuation.continuation.checks[0]!.passed = false;
    const continuationCard = scoreRunnerWorkflow(continuation, { bundleId: "test" });
    expect(continuationCard.dimensions.continuation_integrity.passed).toBe(false);
    expect(continuationCard.dimensions.presentation_fidelity.passed).toBe(true);
    expect(continuationCard.overall.gatePassed).toBe(true);

    const presentation = structuredClone(passing);
    presentation.presentation.checks[0]!.passed = false;
    const presentationCard = scoreRunnerWorkflow(presentation, { bundleId: "test" });
    expect(presentationCard.dimensions.presentation_fidelity.passed).toBe(false);
    expect(presentationCard.dimensions.continuation_integrity.passed).toBe(true);

    const trace = structuredClone(passing);
    trace.traceLineage.digestVerified = false;
    const traceCard = scoreRunnerWorkflow(trace, { bundleId: "test" });
    expect(traceCard.dimensions.trace_completeness.passed).toBe(false);
    expect(traceCard.dimensions.lifecycle_integrity.passed).toBe(true);
  });

  it("does not score skipped or infrastructure executions", async () => {
    const [source] = await runDeterministicRunnerWorkflowMatrix();
    for (const classification of ["skipped", "infrastructure_failure"] as const) {
      const observation: RunnerWorkflowObservation = structuredClone(source!.observation);
      observation.classification = classification;
      observation.failure = { code: "provider_unavailable", category: "provider", retryable: true, message: "Provider unavailable" };
      assertRunnerWorkflowObservation(observation);
      expect(scoreRunnerWorkflow(observation, { bundleId: "test" }).overall).toEqual({ score: null, gatePassed: null, passed: null });
    }
  });

  it("fails closed when an execution is classified as a candidate failure", async () => {
    const [source] = await runDeterministicRunnerWorkflowMatrix();
    const observation: RunnerWorkflowObservation = structuredClone(source!.observation);
    observation.classification = "candidate_failure";
    observation.failure = {
      code: "candidate_error",
      category: "candidate",
      retryable: false,
      message: "Candidate execution failed",
    };

    const card = scoreRunnerWorkflow(observation, { bundleId: "test" });

    expect(card.dimensions.lifecycle_integrity).toMatchObject({
      score: 0,
      passed: false,
      gate: true,
      reasons: expect.arrayContaining(["candidate execution failed"]),
    });
    expect(card.overall).toEqual({ score: 0, gatePassed: false, passed: false });
  });
});

describe("workflow reports and stress traceability", () => {
  it("maps every stress finding to a workflow, regression, or explicit exclusion", async () => {
    const packageRoot = process.cwd();
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "spec/evals/stress-workflow-traceability.json"), "utf8")) as StressTraceabilityManifest;
    const summary = validateStressTraceabilityManifest(manifest);
    expect(summary).toEqual({ findings: 44, workflowEvalFindings: 40, regressionTestFindings: 3, exclusions: 1, coveredWorkflows: 12 });
    for (const finding of manifest.findings) {
      for (const testPath of finding.regressionTests) {
        await expect(stat(resolve(packageRoot, testPath))).resolves.toBeDefined();
      }
    }
  });

  it("renders safe JSON-derived Markdown, JUnit, and GitHub summaries", async () => {
    const results = await runDeterministicRunnerWorkflowMatrix();
    const report = buildRunnerWorkflowEvalReport({
      source: "deterministic",
      bundle: { id: "bundle-v1", runnerVersion: "0.0.0", promptPolicyId: "stress-sanitized-v1", providerVersions: { fixture: "1" } },
      results,
      generatedAt: "2026-08-24T00:00:00.000Z",
      traceability: { findings: 44, workflowEvalFindings: 40, regressionTestFindings: 3, exclusions: 1, coveredWorkflows: 12 },
    });
    expect(report.aggregate).toMatchObject({
      executions: 36,
      scoreable: 36,
      passed: 0,
      candidateFailures: 36,
    });
    expect(report.coverage).toMatchObject({ canonicalOperations: 41, capabilityCases: 106, workflows: 12, stressFindings: 44, stressExclusions: 1 });
    expect(report.coverage.operations).toHaveLength(41);
    expect(report.coverage.composedWorkflows).toHaveLength(12);
    expect(report.coverage.operations.find((entry) => entry.operationId === "finish_task")?.workflowIds.length).toBeGreaterThan(0);
    expect(renderRunnerWorkflowMarkdown(report)).toContain("41 operations · 106 capability cases · 12 workflows");
    expect(renderRunnerWorkflowJUnit(report)).toContain('tests="36" failures="36" skipped="0"');
    expect(renderRunnerWorkflowGitHubSummary(report)).toContain("No active workflow-eval regression alerts");
    expect(compareRunnerWorkflowReports(report, report)).toMatchObject({ compatible: true, passRateDelta: 0, overallDelta: 0 });
    expect(compareRunnerWorkflowReports({ ...report, bundle: { ...report.bundle, id: "other" } }, report)).toMatchObject({ compatible: false });
  });

  it("keeps alerts disabled during baseline and detects safety and trend regressions afterward", async () => {
    const results = await runDeterministicRunnerWorkflowMatrix();
    const healthy = buildRunnerWorkflowEvalReport({
      source: "deterministic", bundle: { id: "compatible", runnerVersion: "1", promptPolicyId: "p", providerVersions: {} }, results,
      generatedAt: "2026-08-24T00:00:00.000Z",
    });
    const failingResults = structuredClone(results) as unknown as typeof results;
    failingResults[0]!.scorecard.dimensions.lifecycle_integrity.passed = false;
    failingResults[0]!.scorecard.dimensions.lifecycle_integrity.score = 0;
    failingResults[0]!.scorecard.overall = { score: 0, gatePassed: false, passed: false };
    const failing = buildRunnerWorkflowEvalReport({
      source: "deterministic", bundle: healthy.bundle, results: failingResults,
      generatedAt: "2026-08-25T00:00:00.000Z",
    });
    expect(runnerWorkflowAlerts({ current: failing, history: [healthy], baselineReady: false })).toEqual([]);
    expect(runnerWorkflowAlerts({ current: failing, history: [failing, failing], baselineReady: true }).map((alert) => alert.code)).toEqual(expect.arrayContaining(["safety_failure", "consecutive_failures"]));
  });

  it("validates the checked-in versioned JSON schemas", async () => {
    const schemaRoot = resolve(process.cwd(), "spec/evals/schemas");
    const [caseSchema, observationSchema, scorecardSchema] = await Promise.all([
      readFile(resolve(schemaRoot, "runner-workflow-eval-case.v1.schema.json"), "utf8").then(JSON.parse),
      readFile(resolve(schemaRoot, "runner-workflow-observation.v1.schema.json"), "utf8").then(JSON.parse),
      readFile(resolve(schemaRoot, "eval-scorecard.v2.schema.json"), "utf8").then(JSON.parse),
    ]);
    const ajv = new Ajv2020({ allErrors: true });
    const [result] = await runDeterministicRunnerWorkflowMatrix();
    expect(ajv.compile(caseSchema)(RUNNER_WORKFLOW_CATALOG[0])).toBe(true);
    expect(ajv.compile(observationSchema)(result!.observation)).toBe(true);
    expect(ajv.compile(scorecardSchema)(result!.scorecard)).toBe(true);
  });
});
