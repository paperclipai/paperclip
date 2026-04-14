import type { Db } from "@paperclipai/db";
import { evolutionFitnessScores } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskResult {
  variantId: string;
  outcome: "success" | "failure" | "timeout" | "error";
  qualityScore: number | null;
  durationMs: number | null;
  costCents: number | null;
  tokenCount: number | null;
  toolCallCount: number | null;
  errorCount: number | null;
}

export interface VariantObjectives {
  quality: number;
  throughput: number;
  costRate: number;
  errorRate: number;
}

export interface VariantFitness {
  variantId: string;
  quality: number; // 0-100
  speedScore: number; // 0-100
  costScore: number; // 0-100
  successRate: number; // 0-100
  compositeScore: number; // 0-100 weighted
  isParetoOptimal: boolean;
  objectives: VariantObjectives;
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB, fully testable)
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Neutral scores returned when there are no results to evaluate. */
function neutralScores(variantId: string): Omit<VariantFitness, "isParetoOptimal"> {
  return {
    variantId,
    quality: 50,
    speedScore: 50,
    costScore: 50,
    successRate: 50,
    compositeScore: 50,
    objectives: { quality: 50, throughput: 0, costRate: 0, errorRate: 0.5 },
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Score a batch of task results for a single variant.
 *
 * Scoring logic (ported from tp-evolve training-evaluator.ts):
 *  - successRate  = (successes / total) * 100
 *  - quality      = avg qualityScore of successful results (default 50 if null)
 *  - speedScore   = 100 - clamp(avgDurationMs / 300_000 * 100, 0, 100)
 *  - costScore    = 100 - clamp(avgCostCents / 500 * 100, 0, 100)
 *  - composite    = quality*0.4 + successRate*0.3 + speedScore*0.15 + costScore*0.15
 */
function scoreVariant(results: TaskResult[]): Omit<VariantFitness, "isParetoOptimal"> {
  if (results.length === 0) {
    // All results share the same variantId in a well-formed call, but with
    // zero results we have no variantId to return — use empty string as sentinel.
    return neutralScores("");
  }

  const variantId = results[0].variantId;
  const total = results.length;
  const successes = results.filter((r) => r.outcome === "success");
  const successRate = (successes.length / total) * 100;

  // Quality: average qualityScore among successes, defaulting nulls to 50
  const qualityValues = successes.map((r) => r.qualityScore ?? 50);
  const quality = qualityValues.length > 0 ? mean(qualityValues) : 50;

  // Speed: higher = faster. 5 minutes (300 000 ms) maps to score 0.
  const durations = results.map((r) => r.durationMs).filter((d): d is number => d != null);
  const avgDurationMs = durations.length > 0 ? mean(durations) : 0;
  const speedScore = 100 - clamp((avgDurationMs / 300_000) * 100, 0, 100);

  // Cost: higher = cheaper. 500 cents ($5) maps to score 0.
  const costs = results.map((r) => r.costCents).filter((c): c is number => c != null);
  const avgCostCents = costs.length > 0 ? mean(costs) : 0;
  const costScore = 100 - clamp((avgCostCents / 500) * 100, 0, 100);

  const compositeScore =
    quality * 0.4 + successRate * 0.3 + speedScore * 0.15 + costScore * 0.15;

  // Objectives for Pareto comparison
  const throughput = avgDurationMs > 0 ? 1 / avgDurationMs : 0;
  const costRate = avgCostCents;
  const errorRate = 1 - successRate / 100;

  return {
    variantId,
    quality,
    speedScore,
    costScore,
    successRate,
    compositeScore,
    objectives: { quality, throughput, costRate, errorRate },
  };
}

/**
 * Pareto dominance check (ported from tp-evolve horizon-evolution.ts).
 *
 * 4 objectives:
 *   maximize: quality, throughput
 *   minimize: costRate, errorRate
 *
 * A dominates B iff A >= B on all maximize objectives, A <= B on all minimize
 * objectives, AND at least one strict inequality.
 */
function dominates(a: VariantObjectives, b: VariantObjectives): boolean {
  const atLeastAsGood =
    a.quality >= b.quality &&
    a.throughput >= b.throughput &&
    a.costRate <= b.costRate &&
    a.errorRate <= b.errorRate;

  if (!atLeastAsGood) return false;

  // Require at least one strict improvement
  return (
    a.quality > b.quality ||
    a.throughput > b.throughput ||
    a.costRate < b.costRate ||
    a.errorRate < b.errorRate
  );
}

/**
 * Compare multiple variants and mark which are Pareto-optimal.
 * A variant is Pareto-optimal iff no other variant dominates it.
 * Returns a new array with `isParetoOptimal` set.
 */
function compareVariants(variantScores: VariantFitness[]): VariantFitness[] {
  return variantScores.map((v) => {
    const dominated = variantScores.some(
      (other) => other.variantId !== v.variantId && dominates(other.objectives, v.objectives),
    );
    return { ...v, isParetoOptimal: !dominated };
  });
}

/**
 * Select the winner: highest composite score among Pareto-optimal variants.
 * Returns null if no variants are provided.
 */
function selectWinner(variantScores: VariantFitness[]): string | null {
  const paretoOptimal = variantScores.filter((v) => v.isParetoOptimal);
  if (paretoOptimal.length === 0) return null;

  let best = paretoOptimal[0];
  for (let i = 1; i < paretoOptimal.length; i++) {
    if (paretoOptimal[i].compositeScore > best.compositeScore) {
      best = paretoOptimal[i];
    }
  }
  return best.variantId;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function fitnessEvaluatorService(db: Db) {
  return {
    scoreVariant,
    compareVariants,
    selectWinner,

    /** Persist fitness scores to the evolution_fitness_scores table. */
    async saveFitnessScores(runId: string, scores: VariantFitness[]): Promise<void> {
      if (scores.length === 0) return;

      await db.insert(evolutionFitnessScores).values(
        scores.map((s) => ({
          runId,
          variantId: s.variantId,
          quality: Math.round(s.quality),
          speedScore: Math.round(s.speedScore),
          costScore: Math.round(s.costScore),
          successRate: Math.round(s.successRate),
          compositeScore: Math.round(s.compositeScore),
          isParetoOptimal: s.isParetoOptimal ? "true" : "false",
          objectives: s.objectives as unknown as Record<string, unknown>,
        })),
      );
    },
  };
}
