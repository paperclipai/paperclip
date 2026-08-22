/**
 * Eval suite runner + threshold gate.
 *
 * A {@link EvalSuite} bundles a corpus + cases. `runSuite` executes each case
 * through a supplied `run` callback (the engagement wires in its own agent), then
 * aggregates per-scorer means. `withinThreshold` enforces the quality gate that
 * CI / the pre-handoff checklist calls — fail the build if quality drops.
 */

import type { EvalCaseInput, EvalOutput, ScorerName } from './scorers.js';
import { scorers as allScorers } from './scorers.js';

export interface EvalCase {
  id: string;
  input: EvalCaseInput;
  /** Scorers to apply (defaults to all four). */
  scorers?: ScorerName[];
}

export interface EvalSuite {
  id: string;
  description: string;
  cases: EvalCase[];
}

export interface CaseResult {
  caseId: string;
  output: EvalOutput;
  scores: Partial<Record<ScorerName, number>>;
}

export interface SuiteResult {
  suiteId: string;
  description: string;
  caseResults: CaseResult[];
  /** Mean score per scorer across all cases. */
  aggregate: Partial<Record<ScorerName, number>>;
  caseCount: number;
}

export type EvalRun = (input: EvalCaseInput) => Promise<EvalOutput>;

export async function runSuite(suite: EvalSuite, run: EvalRun): Promise<SuiteResult> {
  const caseResults: CaseResult[] = [];
  const sums: Partial<Record<ScorerName, number>> = {};
  const counts: Partial<Record<ScorerName, number>> = {};

  for (const c of suite.cases) {
    const output = await run(c.input);
    const names = c.scorers ?? (Object.keys(allScorers) as ScorerName[]);
    const scores: Partial<Record<ScorerName, number>> = {};
    for (const name of names) {
      const s = allScorers[name](c.input, output);
      scores[name] = s;
      sums[name] = (sums[name] ?? 0) + s;
      counts[name] = (counts[name] ?? 0) + 1;
    }
    caseResults.push({ caseId: c.id, output, scores });
  }

  const aggregate: Partial<Record<ScorerName, number>> = {};
  for (const name of Object.keys(sums) as ScorerName[]) {
    aggregate[name] = (sums[name] ?? 0) / (counts[name] ?? 1);
  }

  return {
    suiteId: suite.id,
    description: suite.description,
    caseResults,
    aggregate,
    caseCount: suite.cases.length,
  };
}

export interface GateThresholds {
  /** Per-scorer minimum mean score to pass (0..1). */
  [scoreName: string]: number;
}

/**
 * The lightweight quality gate. Returns failing scorers; empty array == PASS.
 * Throws only when `throwOnFail` is set (used by the CI eval test).
 */
export function withinThreshold(
  result: SuiteResult,
  thresholds: GateThresholds,
  throwOnFail = false,
): { passed: boolean; failures: { name: ScorerName; got: number; min: number }[] } {
  const failures: { name: ScorerName; got: number; min: number }[] = [];
  for (const name of Object.keys(thresholds) as ScorerName[]) {
    const got = result.aggregate[name] ?? 0;
    const min = thresholds[name];
    if (got < min) failures.push({ name, got, min });
  }
  const passed = failures.length === 0;
  if (!passed && throwOnFail) {
    const detail = failures.map((f) => `${f.name}: ${f.got.toFixed(3)} < ${f.min}`).join(', ');
    throw new Error(`Eval gate FAILED (${result.suiteId}): ${detail}`);
  }
  return { passed, failures };
}
