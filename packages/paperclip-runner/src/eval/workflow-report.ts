import { CAPABILITY_CANONICAL_OPERATIONS } from "../catalog/canonical-operations.js";
import { capabilityInventoryCounts } from "../generated/capability-contract.js";
import { RUNNER_WORKFLOW_DIMENSION_KEYS, type RunnerWorkflowDimensionKey } from "./workflow-contracts.js";
import { RUNNER_WORKFLOW_CATALOG } from "./workflow-catalog.js";
import type { RunnerWorkflowMatrixEntry } from "./workflow-harness.js";
import type { StressTraceabilitySummary } from "./workflow-traceability.js";

export const RUNNER_WORKFLOW_REPORT_SCHEMA = "paperclip.runner.workflow-eval-report.v1" as const;

export interface RunnerWorkflowReportBundle {
  id: string;
  runnerVersion: string;
  runnerBuild?: string;
  promptPolicyId: string;
  providerVersions: Record<string, string>;
}

export interface RunnerWorkflowEvalReport {
  schema: typeof RUNNER_WORKFLOW_REPORT_SCHEMA;
  generatedAt: string;
  source: "deterministic";
  bundle: RunnerWorkflowReportBundle;
  results: RunnerWorkflowMatrixEntry[];
  aggregate: {
    executions: number;
    scoreable: number;
    passed: number;
    candidateFailures: number;
    infrastructureFailures: number;
    skipped: number;
    meanOverall: number | null;
    dimensionMeans: Record<RunnerWorkflowDimensionKey, number | null>;
  };
  coverage: {
    canonicalOperations: number;
    capabilityCases: number;
    workflows: number;
    stressFindings?: number;
    stressExclusions?: number;
    operations: Array<{ operationId: string; capabilityCovered: true; workflowIds: string[] }>;
    composedWorkflows: Array<{ workflowId: string; providerCount: number; operationIds: string[] }>;
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function buildRunnerWorkflowEvalReport(input: {
  source: RunnerWorkflowEvalReport["source"];
  bundle: RunnerWorkflowReportBundle;
  results: readonly RunnerWorkflowMatrixEntry[];
  generatedAt?: string;
  traceability?: StressTraceabilitySummary;
}): RunnerWorkflowEvalReport {
  const results = [...input.results];
  const scoreable = results.filter((entry) => entry.scorecard.overall.score !== null);
  const dimensionMeans = {} as Record<RunnerWorkflowDimensionKey, number | null>;
  for (const dimension of RUNNER_WORKFLOW_DIMENSION_KEYS) {
    const values = scoreable.flatMap((entry) => {
      const value = entry.scorecard.dimensions[dimension].score;
      return value === null ? [] : [value];
    });
    dimensionMeans[dimension] = values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  const overallValues = scoreable.flatMap((entry) => entry.scorecard.overall.score === null ? [] : [entry.scorecard.overall.score]);
  return {
    schema: RUNNER_WORKFLOW_REPORT_SCHEMA,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: input.source,
    bundle: input.bundle,
    results,
    aggregate: {
      executions: results.length,
      scoreable: scoreable.length,
      passed: scoreable.filter((entry) => entry.scorecard.overall.passed).length,
      candidateFailures: results.filter((entry) => entry.observation.classification === "candidate_failure").length,
      infrastructureFailures: results.filter((entry) => entry.observation.classification === "infrastructure_failure").length,
      skipped: results.filter((entry) => entry.observation.classification === "skipped").length,
      meanOverall: overallValues.length === 0 ? null : round(overallValues.reduce((sum, value) => sum + value, 0) / overallValues.length),
      dimensionMeans,
    },
    coverage: {
      canonicalOperations: CAPABILITY_CANONICAL_OPERATIONS.length,
      capabilityCases: capabilityInventoryCounts.evalCases,
      workflows: new Set(results.map((entry) => entry.scenarioId)).size,
      operations: CAPABILITY_CANONICAL_OPERATIONS.map((operation) => ({
        operationId: operation.operationId,
        capabilityCovered: true as const,
        workflowIds: RUNNER_WORKFLOW_CATALOG.filter((evalCase) =>
          evalCase.assertions.requiredOperationIds?.includes(operation.operationId))
          .map((evalCase) => evalCase.id),
      })),
      composedWorkflows: RUNNER_WORKFLOW_CATALOG.map((evalCase) => ({
        workflowId: evalCase.id,
        providerCount: evalCase.providers.length,
        operationIds: evalCase.assertions.requiredOperationIds ?? [],
      })),
      ...(input.traceability === undefined ? {} : {
        stressFindings: input.traceability.findings,
        stressExclusions: input.traceability.exclusions,
      }),
    },
  };
}

export function renderRunnerWorkflowMarkdown(report: RunnerWorkflowEvalReport): string {
  const lines = [
    `# Runner workflow evals — ${report.bundle.id}`,
    "",
    `- Source: ${report.source}`,
    `- Executions: ${report.aggregate.executions} · scoreable ${report.aggregate.scoreable} · passed ${report.aggregate.passed}`,
    `- Candidate failures: ${report.aggregate.candidateFailures} · infrastructure failures ${report.aggregate.infrastructureFailures} · skipped ${report.aggregate.skipped}`,
    `- Coverage: ${report.coverage.canonicalOperations} operations · ${report.coverage.capabilityCases} capability cases · ${report.coverage.workflows} workflows${report.coverage.stressFindings === undefined ? "" : ` · ${report.coverage.stressFindings} stress findings`}`,
    "",
    "## Dimension means",
    "",
    ...RUNNER_WORKFLOW_DIMENSION_KEYS.map((dimension) => `- ${dimension}: ${report.aggregate.dimensionMeans[dimension] ?? "not scored"}`),
    "",
    "## Combined operation and workflow coverage",
    "",
    "| operation | capability cases | composed workflows |",
    "| --- | --- | --- |",
    ...report.coverage.operations.map((operation) => `| ${operation.operationId} | covered | ${operation.workflowIds.join(", ") || "—"} |`),
    "",
    "## Executions",
    "",
    "| workflow | candidate | classification | gate | score | result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.results.map((entry) => {
      const overall = entry.scorecard.overall;
      const result = overall.passed === null ? "not scored" : overall.passed ? "PASS" : "FAIL";
      return `| ${entry.scenarioId} | ${entry.candidateId} | ${entry.observation.classification} | ${overall.gatePassed ?? "—"} | ${overall.score === null ? "—" : round(overall.score)} | ${result} |`;
    }),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderRunnerWorkflowJUnit(report: RunnerWorkflowEvalReport): string {
  const failures = report.results.filter((entry) => entry.scorecard.overall.passed === false).length;
  const skipped = report.results.filter((entry) => entry.scorecard.overall.passed === null).length;
  const cases = report.results.map((entry) => {
    const name = `${entry.scenarioId}/${entry.candidateId}`;
    if (entry.scorecard.overall.passed === null) {
      return `  <testcase classname="runner.workflow" name="${xml(name)}"><skipped message="${xml(entry.observation.failure?.message ?? "not scoreable")}" /></testcase>`;
    }
    if (entry.scorecard.overall.passed === false) {
      const reasons = RUNNER_WORKFLOW_DIMENSION_KEYS.flatMap((dimension) => entry.scorecard.dimensions[dimension].reasons).join("; ");
      return `  <testcase classname="runner.workflow" name="${xml(name)}"><failure message="workflow eval failed">${xml(reasons)}</failure></testcase>`;
    }
    return `  <testcase classname="runner.workflow" name="${xml(name)}" />`;
  });
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    `<testsuite name="paperclip-runner-workflows" tests="${report.results.length}" failures="${failures}" skipped="${skipped}">`,
    ...cases,
    "</testsuite>",
    "",
  ].join("\n");
}

export interface RunnerWorkflowReportComparison {
  compatible: boolean;
  reason?: string;
  currentBundleId: string;
  previousBundleId: string;
  passRateDelta?: number;
  overallDelta?: number;
}

export function compareRunnerWorkflowReports(
  current: RunnerWorkflowEvalReport,
  previous: RunnerWorkflowEvalReport,
): RunnerWorkflowReportComparison {
  if (current.bundle.id !== previous.bundle.id) {
    return {
      compatible: false,
      reason: "bundle ids differ; provider fixture, runner, or prompt-policy inputs changed",
      currentBundleId: current.bundle.id,
      previousBundleId: previous.bundle.id,
    };
  }
  const rate = (report: RunnerWorkflowEvalReport): number => report.aggregate.scoreable === 0 ? 0 : report.aggregate.passed / report.aggregate.scoreable;
  return {
    compatible: true,
    currentBundleId: current.bundle.id,
    previousBundleId: previous.bundle.id,
    passRateDelta: round(rate(current) - rate(previous)),
    overallDelta: round((current.aggregate.meanOverall ?? 0) - (previous.aggregate.meanOverall ?? 0)),
  };
}

export interface RunnerWorkflowAlert {
  severity: "warning" | "critical";
  code: "safety_failure" | "consecutive_failures" | "success_rate_regression" | "latency_regression" | "cost_regression";
  message: string;
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

export function runnerWorkflowAlerts(input: {
  current: RunnerWorkflowEvalReport;
  history: readonly RunnerWorkflowEvalReport[];
  baselineReady: boolean;
}): RunnerWorkflowAlert[] {
  if (!input.baselineReady) return [];
  const compatible = input.history.filter((report) => report.bundle.id === input.current.bundle.id).slice(-7);
  const alerts: RunnerWorkflowAlert[] = [];
  const safetyFailures = input.current.results.filter((entry) =>
    entry.scorecard.dimensions.hard_invariants.passed === false
    || entry.scorecard.dimensions.lifecycle_integrity.passed === false);
  if (safetyFailures.length > 0) {
    alerts.push({ severity: "critical", code: "safety_failure", message: `${safetyFailures.length} execution(s) failed a hard or lifecycle invariant` });
  }
  for (const result of input.current.results) {
    if (result.scorecard.overall.passed !== false) continue;
    const priorFailures = compatible.slice(-2).every((report) => report.results.some((entry) =>
      entry.scenarioId === result.scenarioId
      && entry.candidateId === result.candidateId
      && entry.scorecard.overall.passed === false));
    if (compatible.length >= 2 && priorFailures) {
      alerts.push({ severity: "warning", code: "consecutive_failures", message: `${result.scenarioId}/${result.candidateId} failed three consecutive reports` });
    }
  }
  const baselineScoreable = compatible.reduce((sum, report) => sum + report.aggregate.scoreable, 0);
  const baselinePassed = compatible.reduce((sum, report) => sum + report.aggregate.passed, 0);
  if (baselineScoreable > 0 && input.current.aggregate.scoreable > 0) {
    const baselineRate = baselinePassed / baselineScoreable;
    const currentRate = input.current.aggregate.passed / input.current.aggregate.scoreable;
    if (baselineRate - currentRate >= 0.20) {
      alerts.push({ severity: "warning", code: "success_rate_regression", message: `success rate dropped ${Math.round((baselineRate - currentRate) * 100)} percentage points` });
    }
  }
  const metric = (reports: readonly RunnerWorkflowEvalReport[], key: "settlementMs" | "costUsd"): number[] => reports.flatMap((report) =>
    report.results.flatMap((entry) => {
      const value = key === "settlementMs" ? entry.observation.metrics.settlementMs : entry.observation.metrics.costUsd;
      return value === undefined ? [] : [value];
    }));
  const currentLatency = percentile95(metric([input.current], "settlementMs"));
  const baselineLatency = percentile95(metric(compatible, "settlementMs"));
  if (currentLatency !== null && baselineLatency !== null && currentLatency > baselineLatency * 1.25) {
    alerts.push({ severity: "warning", code: "latency_regression", message: `p95 settlement latency rose more than 25% (${baselineLatency}ms → ${currentLatency}ms)` });
  }
  const currentCost = percentile95(metric([input.current], "costUsd"));
  const baselineCost = percentile95(metric(compatible, "costUsd"));
  if (currentCost !== null && baselineCost !== null && baselineCost > 0 && currentCost > baselineCost * 1.25) {
    alerts.push({ severity: "warning", code: "cost_regression", message: `p95 cost rose more than 25% ($${baselineCost} → $${currentCost})` });
  }
  return alerts;
}

export function renderRunnerWorkflowGitHubSummary(
  report: RunnerWorkflowEvalReport,
  alerts: readonly RunnerWorkflowAlert[] = [],
): string {
  const alertLines = alerts.length === 0
    ? ["No active workflow-eval regression alerts."]
    : alerts.map((alert) => `- ${alert.severity.toUpperCase()} ${alert.code}: ${alert.message}`);
  return `${renderRunnerWorkflowMarkdown(report)}\n## Alerts\n\n${alertLines.join("\n")}\n`;
}
