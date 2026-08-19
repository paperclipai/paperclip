import type { CapabilityLiveCodexMatrixResult } from "../conformance/capability-eval-suite.js";
import { assertBundleSecretFree, bundleId, describeBundle, type EvalBundle } from "./eval-bundle.js";
import {
  EVAL_DIMENSION_KEYS,
  observationFromLiveMatrix,
  scoreEval,
  type EvalDimensionKey,
  type EvalObservation,
  type EvalScorecard,
  type EvalScoringOptions,
  type LiveMatrixAugment,
} from "./eval-scoring.js";

/**
 * The runner eval vertical slice: bind a declared candidate {@link EvalBundle}
 * to a set of scored observations and emit one inspectable, secret-free report.
 *
 * The report is reproducible from the bundle declaration (its id is content
 * addressed) and carries per-case scorecards plus per-dimension aggregates, so a
 * candidate can be compared across runs and a red counterpart shows exactly
 * which dimension regressed.
 */
export const EVAL_SLICE_REPORT_SCHEMA = "paperclip.runner.eval-slice-report.v1" as const;

export interface EvalScoredCase {
  scorecard: EvalScorecard;
  /** The observation the scorecard was derived from — safe to persist. */
  observation: EvalObservation;
}

export interface EvalSliceReport {
  schema: typeof EVAL_SLICE_REPORT_SCHEMA;
  bundle: { id: string; summary: string; declaration: EvalBundle };
  /** True when the observations came from real model tool choice, not a fixture. */
  generatedFromLiveModel: boolean;
  cases: EvalScoredCase[];
  aggregate: {
    caseCount: number;
    passed: number;
    gateFailures: number;
    meanOverall: number;
    dimensionMeans: Record<EvalDimensionKey, number>;
  };
}

export interface BuildEvalSliceReportOptions {
  weights?: EvalScoringOptions["weights"];
  thresholds?: EvalScoringOptions["thresholds"];
  generatedFromLiveModel?: boolean;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Scores every observation against the bundle and aggregates the results. Throws
 * if the bundle carries a secret, so a report can be committed as evidence.
 */
export function buildEvalSliceReport(
  bundle: EvalBundle,
  observations: readonly EvalObservation[],
  options: BuildEvalSliceReportOptions = {},
): EvalSliceReport {
  assertBundleSecretFree(bundle);
  const id = bundleId(bundle);
  const scoringOptions: EvalScoringOptions = {
    bundleId: id,
    weights: options.weights,
    thresholds: options.thresholds,
  };

  const cases: EvalScoredCase[] = observations.map((observation) => ({
    observation,
    scorecard: scoreEval(observation, scoringOptions),
  }));

  const dimensionMeans = {} as Record<EvalDimensionKey, number>;
  for (const key of EVAL_DIMENSION_KEYS) {
    const total = cases.reduce((sum, entry) => sum + entry.scorecard.dimensions[key].score, 0);
    dimensionMeans[key] = cases.length === 0 ? 0 : round(total / cases.length);
  }
  const meanOverall =
    cases.length === 0
      ? 0
      : round(cases.reduce((sum, entry) => sum + entry.scorecard.overall.score, 0) / cases.length);

  return {
    schema: EVAL_SLICE_REPORT_SCHEMA,
    bundle: { id, summary: describeBundle(bundle).summary, declaration: bundle },
    generatedFromLiveModel: options.generatedFromLiveModel ?? false,
    cases,
    aggregate: {
      caseCount: cases.length,
      passed: cases.filter((entry) => entry.scorecard.overall.passed).length,
      gateFailures: cases.filter((entry) => !entry.scorecard.overall.gatePassed).length,
      meanOverall,
      dimensionMeans,
    },
  };
}

/** A compact, human-readable rendering of a slice report for inspection. */
export function renderEvalSliceMarkdown(report: EvalSliceReport): string {
  const lines: string[] = [];
  const sources = new Set(report.cases.map((entry) => entry.observation.provenance?.source));
  const sourceDescription = report.generatedFromLiveModel
    ? "real model tool choice"
    : sources.size === 1 && sources.has("deterministic_fault_harness")
      ? "deterministic fault harness"
      : "fixture observations";
  lines.push(`# Runner eval slice — ${report.bundle.id}`);
  lines.push("");
  lines.push(`- Bundle: \`${report.bundle.summary}\``);
  lines.push(`- Source: ${sourceDescription}`);
  lines.push(
    `- Cases: ${report.aggregate.caseCount} · passed ${report.aggregate.passed} · gate failures ${report.aggregate.gateFailures} · mean overall ${report.aggregate.meanOverall}`,
  );
  lines.push("");
  lines.push("## Dimension means");
  lines.push("");
  for (const key of EVAL_DIMENSION_KEYS) {
    lines.push(`- ${key}: ${report.aggregate.dimensionMeans[key]}`);
  }
  lines.push("");
  lines.push("## Cases");
  lines.push("");
  lines.push("| case | source | counterpart | fault | gate | overall | outcome | trajectory | trace | efficiency |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const { scorecard, observation } of report.cases) {
    const d = scorecard.dimensions;
    const provenance = observation.provenance;
    lines.push(
      `| ${scorecard.caseId} | ${provenance?.source ?? "unspecified"} | ${provenance?.counterpart ?? "—"} | ${provenance?.faultInjection?.class ?? "—"} | ${d.hard_invariants.passed ? "ok" : "FAIL"} | ${scorecard.overall.score} | ${d.semantic_outcome.score} | ${d.trajectory_restraint.score} | ${d.trace_completeness.score} | ${d.quality_efficiency.score} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export interface RunLiveEvalSliceParams {
  bundle: EvalBundle;
  /** Supplies trace/authorization/efficiency evidence per live-matrix result. */
  augmentFor: (result: CapabilityLiveCodexMatrixResult) => LiveMatrixAugment;
  workingDirectory?: string;
  weights?: EvalScoringOptions["weights"];
  thresholds?: EvalScoringOptions["thresholds"];
}

/**
 * Runs the bounded real-Codex matrix (one real model turn per eval group) and
 * scores every result against the declared bundle. This is the end-to-end
 * vertical slice: real model tool choice → controlled mock control plane →
 * normalized observation → multi-dimensional scorecard. The heavy live runtime
 * is dynamically imported so the pure scoring path stays dependency-light.
 */
export async function runLiveEvalSlice(params: RunLiveEvalSliceParams): Promise<EvalSliceReport> {
  const { runCapabilityLiveCodexMatrix } = await import("../conformance/capability-eval-suite.js");
  const results = await runCapabilityLiveCodexMatrix(params.workingDirectory);
  const observations = results.map((result) => observationFromLiveMatrix(result, params.augmentFor(result)));
  return buildEvalSliceReport(params.bundle, observations, {
    weights: params.weights,
    thresholds: params.thresholds,
    generatedFromLiveModel: true,
  });
}
