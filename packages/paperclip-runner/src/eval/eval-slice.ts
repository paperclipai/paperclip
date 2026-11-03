import {
  assertBundleSecretFree,
  assertEvalArtifactSecretFree,
  bundleEvidenceDeclaration,
  bundleId,
  describeBundle,
  type EvalBundle,
  type EvalBundleEvidenceDeclaration,
} from "./eval-bundle.js";
import {
  EVAL_DIMENSION_KEYS,
  scoreEval,
  type EvalDimensionKey,
  type EvalObservation,
  type EvalScorecard,
  type EvalScoringOptions,
} from "./eval-scoring.js";

/**
 * The runner eval vertical slice: bind a declared candidate {@link EvalBundle}
 * to a set of scored observations and emit one inspectable, secret-free report.
 *
 * The report binds its scorecards to a content-addressed, digested bundle
 * declaration. The caller retains the secret-free source bundle for replay;
 * persisted reports carry no free-form bundle content. Per-dimension aggregates
 * show whether a regression came from outcome, restraint, trace, or efficiency.
 */
export const EVAL_SLICE_REPORT_SCHEMA = "paperclip.runner.eval-slice-report.v1" as const;

export interface EvalScoredCase {
  scorecard: EvalScorecard;
  /** The observation the scorecard was derived from — safe to persist. */
  observation: EvalObservation;
}

export interface EvalSliceReport {
  schema: typeof EVAL_SLICE_REPORT_SCHEMA;
  bundle: { id: string; summary: string; declaration: EvalBundleEvidenceDeclaration };
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

  const report: EvalSliceReport = {
    schema: EVAL_SLICE_REPORT_SCHEMA,
    bundle: {
      id,
      summary: describeBundle(bundle).summary,
      declaration: bundleEvidenceDeclaration(bundle),
    },
    cases,
    aggregate: {
      caseCount: cases.length,
      passed: cases.filter((entry) => entry.scorecard.overall.passed).length,
      gateFailures: cases.filter((entry) => !entry.scorecard.overall.gatePassed).length,
      meanOverall,
      dimensionMeans,
    },
  };
  // Scan the exact serialization that callers persist, including observations
  // and derived scorecards rather than only the source bundle.
  assertEvalArtifactSecretFree(JSON.stringify(report), "serialized eval report");
  return report;
}

/** A compact, human-readable rendering of a slice report for inspection. */
export function renderEvalSliceMarkdown(report: EvalSliceReport): string {
  const lines: string[] = [];
  const sources = new Set(report.cases.map((entry) => entry.observation.provenance?.source));
  const sourceDescription = sources.size === 1 && sources.has("deterministic_fault_harness")
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
