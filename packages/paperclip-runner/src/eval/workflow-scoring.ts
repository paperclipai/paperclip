import { scoreEval } from "./eval-scoring.js";
import {
  RUNNER_WORKFLOW_DIMENSION_KEYS,
  RUNNER_WORKFLOW_SCORECARD_SCHEMA,
  assertRunnerWorkflowObservation,
  type RunnerWorkflowCheck,
  type RunnerWorkflowDimensionKey,
  type RunnerWorkflowDimensionScore,
  type RunnerWorkflowEvalScorecard,
  type RunnerWorkflowObservation,
} from "./workflow-contracts.js";
import { runnerWorkflowCase } from "./workflow-catalog.js";

export interface RunnerWorkflowScoringOptions {
  bundleId: string;
  weights?: Partial<Record<RunnerWorkflowDimensionKey, number>>;
  thresholds?: Partial<Record<RunnerWorkflowDimensionKey, number>>;
}

const DEFAULT_WEIGHTS: Record<RunnerWorkflowDimensionKey, number> = {
  hard_invariants: 0,
  lifecycle_integrity: 0,
  semantic_outcome: 0.20,
  trajectory_restraint: 0.15,
  trace_completeness: 0.10,
  quality_efficiency: 0.10,
  continuation_integrity: 0.20,
  presentation_fidelity: 0.25,
};

function checksScore(checks: readonly RunnerWorkflowCheck[]): { score: number; reasons: string[] } {
  const failed = checks.filter((check) => !check.passed);
  return {
    score: checks.filter((check) => check.passed).length / checks.length,
    reasons: failed.map((check) => check.reason ?? `check failed: ${check.id}`),
  };
}

function unscoredDimensions(): Record<RunnerWorkflowDimensionKey, RunnerWorkflowDimensionScore> {
  return Object.fromEntries(RUNNER_WORKFLOW_DIMENSION_KEYS.map((dimension) => [dimension, {
    dimension,
    score: null,
    passed: null,
    gate: dimension === "hard_invariants" || dimension === "lifecycle_integrity",
    weight: DEFAULT_WEIGHTS[dimension],
    reasons: ["execution was not scoreable"],
  }])) as Record<RunnerWorkflowDimensionKey, RunnerWorkflowDimensionScore>;
}

function traceLineageScore(observation: RunnerWorkflowObservation): { score: number; reasons: string[] } {
  const expected = runnerWorkflowCase(observation.caseId).assertions.trace;
  const checks: RunnerWorkflowCheck[] = [];
  const captureExpectation = expected?.capture ?? "either";
  if (captureExpectation === "off") {
    checks.push({
      id: "capture-off-isolation",
      passed: observation.traceLineage.capture === "off"
        && observation.traceLineage.frameCount === 0
        && observation.traceLineage.byteCount === 0
        && observation.traceLineage.traceRef === undefined,
      reason: "capture-off execution retained provider trace data",
    });
  } else if (captureExpectation === "on" || observation.traceLineage.capture === "on") {
    checks.push(
      { id: "capture-present", passed: observation.traceLineage.capture === "on" && observation.traceLineage.frameCount > 0 && observation.traceLineage.byteCount > 0, reason: "provider trace capture is empty" },
      { id: "frame-digests", passed: observation.traceLineage.digestVerified, reason: "provider trace frame digest or byte length did not verify" },
      { id: "frame-order", passed: observation.traceLineage.ordered, reason: "provider trace frame or debug sequence is not strictly ordered" },
    );
  } else {
    checks.push({ id: "capture-optional", passed: true });
  }
  for (const disposition of expected?.dispositions ?? []) {
    checks.push({
      id: `disposition-${disposition}`,
      passed: observation.traceLineage.dispositions.includes(disposition),
      reason: `provider trace did not exercise ${disposition} mapping`,
    });
  }
  for (const lineage of expected?.lineage ?? []) {
    checks.push({
      id: `lineage-${lineage}`,
      passed: observation.traceLineage.lineage.includes(lineage),
      reason: `provider trace did not exercise ${lineage} lineage`,
    });
  }
  return checksScore(checks);
}

/** Scores the complete Runner workflow while preserving the v1 capability dimensions. */
export function scoreRunnerWorkflow(
  observation: RunnerWorkflowObservation,
  options: RunnerWorkflowScoringOptions,
): RunnerWorkflowEvalScorecard {
  assertRunnerWorkflowObservation(observation);
  if (observation.classification === "infrastructure_failure" || observation.classification === "skipped") {
    return {
      schema: RUNNER_WORKFLOW_SCORECARD_SCHEMA,
      bundleId: options.bundleId,
      caseId: observation.caseId,
      candidateId: observation.candidateId,
      classification: observation.classification,
      dimensions: unscoredDimensions(),
      overall: { score: null, gatePassed: null, passed: null },
    };
  }

  const v1 = scoreEval(observation.base, { bundleId: options.bundleId });
  const lineageTrace = traceLineageScore(observation);
  const workflowScores = {
    lifecycle_integrity: checksScore(observation.lifecycle.checks),
    continuation_integrity: checksScore(observation.continuation.checks),
    presentation_fidelity: checksScore(observation.presentation.checks),
  };
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const dimensions = {} as Record<RunnerWorkflowDimensionKey, RunnerWorkflowDimensionScore>;

  for (const dimension of RUNNER_WORKFLOW_DIMENSION_KEYS) {
    const legacy = dimension in v1.dimensions
      ? v1.dimensions[dimension as keyof typeof v1.dimensions]
      : undefined;
    const workflow = dimension in workflowScores
      ? workflowScores[dimension as keyof typeof workflowScores]
      : undefined;
    const score = dimension === "trace_completeness" && legacy !== undefined
      ? Math.min(legacy.score, lineageTrace.score)
      : legacy?.score ?? workflow?.score ?? 0;
    const gate = dimension === "hard_invariants" || dimension === "lifecycle_integrity";
    const threshold = options.thresholds?.[dimension] ?? 1;
    dimensions[dimension] = {
      dimension,
      score,
      passed: score >= threshold,
      gate,
      weight: gate ? 0 : weights[dimension],
      reasons: dimension === "trace_completeness" && legacy !== undefined
        ? [...legacy.reasons, ...lineageTrace.reasons]
        : legacy?.reasons ?? workflow?.reasons ?? [],
    };
  }

  const gatePassed = dimensions.hard_invariants.passed === true
    && dimensions.lifecycle_integrity.passed === true;
  const weighted = RUNNER_WORKFLOW_DIMENSION_KEYS.filter((dimension) => !dimensions[dimension].gate);
  const totalWeight = weighted.reduce((sum, dimension) => sum + dimensions[dimension].weight, 0);
  const weightedScore = totalWeight === 0 ? 0 : weighted.reduce(
    (sum, dimension) => sum + (dimensions[dimension].score ?? 0) * dimensions[dimension].weight,
    0,
  ) / totalWeight;
  const passed = gatePassed && RUNNER_WORKFLOW_DIMENSION_KEYS.every(
    (dimension) => dimensions[dimension].passed === true,
  );

  return {
    schema: RUNNER_WORKFLOW_SCORECARD_SCHEMA,
    bundleId: options.bundleId,
    caseId: observation.caseId,
    candidateId: observation.candidateId,
    classification: observation.classification,
    dimensions,
    overall: { score: gatePassed ? weightedScore : 0, gatePassed, passed },
  };
}
