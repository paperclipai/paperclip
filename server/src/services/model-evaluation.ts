import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { agentCanaryPairings, modelEvaluations } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export interface BetaParams {
  alpha: number;
  beta: number;
  successes: number;
  failures: number;
  total: number;
}

export interface ModelBetaStats extends BetaParams {
  model: string;
}

export interface PosteriorResult {
  role: string;
  modelA: string;
  modelB: string;
  pBA: number;
  alphaA: number;
  betaA: number;
  alphaB: number;
  betaB: number;
  evaluationsA: number;
  evaluationsB: number;
  recommendation: "swap_to_challenger" | "keep_primary" | null;
}

function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

function logGamma(x: number): number {
  if (x <= 0) return Infinity;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];

  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }

  x -= 1;
  let a = c[0]!;
  for (let i = 1; i < g + 2; i++) {
    a += c[i]! / (x + i);
  }

  const t = x + g + 1.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x === 0) return 0;
  if (x === 1) return 1;

  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(1 - x, b, a);
  }

  const lnBeta = logBeta(a, b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  let f = 1;
  let c = 1;
  let d = 0;

  for (let i = 0; i <= 200; i++) {
    const m = i / 2;
    let numerator;

    if (i === 0) {
      numerator = 1;
    } else if (i % 2 === 0) {
      numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    } else {
      numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    }

    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;

    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;

    const cd = c * d;
    f *= cd;

    if (Math.abs(cd - 1) < 1e-10) break;
  }

  return front * (f - 1);
}

function computePBGreaterThanA(alphaA: number, betaA: number, alphaB: number, betaB: number): number {
  return regularizedIncompleteBeta(
    alphaB / (alphaB + betaB),
    alphaB,
    betaB
  ) * regularizedIncompleteBeta(
    alphaA / (alphaA + betaA),
    alphaA,
    betaB
  );
}

function normalApproximationPBGreaterThanA(
  successesA: number,
  totalA: number,
  successesB: number,
  totalB: number
): number {
  if (totalA === 0 || totalB === 0) return 0.5;

  const rateA = successesA / totalA;
  const rateB = successesB / totalB;

  const n = totalA + totalB;
  const pooledRate = (successesA + successesB) / n;
  const se = Math.sqrt(pooledRate * (1 - pooledRate) * (1 / totalA + 1 / totalB));

  if (se === 0) {
    return rateB > rateA ? 0.75 : rateA > rateB ? 0.25 : 0.5;
  }

  const z = (rateB - rateA) / se;
  return 1 / (1 + Math.exp(-z));
}

export function createModelEvaluationService(db: Db) {
  async function getModelBetaParams(
    role: string,
    model: string
  ): Promise<BetaParams | null> {
    const results = await db
      .select({
        outcome: modelEvaluations.taskOutcome,
      })
      .from(modelEvaluations)
      .where(
        and(
          eq(modelEvaluations.role, role),
          eq(modelEvaluations.model, model)
        )
      );

    if (results.length === 0) {
      return null;
    }

    let successes = 0;
    let failures = 0;

    for (const row of results) {
      if (row.outcome === "success") {
        successes++;
      } else if (row.outcome === "failure") {
        failures++;
      }
    }

    const alpha = 1 + successes;
    const beta = 1 + failures;

    return {
      alpha,
      beta,
      successes,
      failures,
      total: results.length,
    };
  }

  async function getPosteriorForRole(role: string): Promise<PosteriorResult | null> {
    const pairingRows = await db
      .select()
      .from(agentCanaryPairings)
      .where(and(
        eq(agentCanaryPairings.role, role),
        eq(agentCanaryPairings.status, "active")
      ))
      .limit(1);

    if (pairingRows.length === 0) {
      return null;
    }

    const pairing = pairingRows[0]!;
    const { primaryModel, challengerModel } = pairing;

    const statsA = await getModelBetaParams(role, primaryModel);
    const statsB = await getModelBetaParams(role, challengerModel);

    if (!statsA || !statsB) {
      return {
        role,
        modelA: primaryModel,
        modelB: challengerModel,
        pBA: 0.5,
        alphaA: statsA?.alpha ?? 1,
        betaA: statsA?.beta ?? 1,
        alphaB: statsB?.alpha ?? 1,
        betaB: statsB?.beta ?? 1,
        evaluationsA: statsA?.total ?? 0,
        evaluationsB: statsB?.total ?? 0,
        recommendation: null,
      };
    }

    let pBA: number;

    if (statsA.total >= 5 && statsB.total >= 5) {
      pBA = computePBGreaterThanA(
        statsA.alpha,
        statsA.beta,
        statsB.alpha,
        statsB.beta
      );
    } else {
      pBA = normalApproximationPBGreaterThanA(
        statsA.successes,
        statsA.total,
        statsB.successes,
        statsB.total
      );
    }

    let recommendation: "swap_to_challenger" | "keep_primary" | null = null;
    if (pBA > 0.8) {
      recommendation = "swap_to_challenger";
    } else if (pBA < 0.2) {
      recommendation = "keep_primary";
    }

    logger.info(
      { role, pBA, recommendation, statsA, statsB },
      "Computed posterior for role"
    );

    return {
      role,
      modelA: primaryModel,
      modelB: challengerModel,
      pBA,
      alphaA: statsA.alpha,
      betaA: statsA.beta,
      alphaB: statsB.alpha,
      betaB: statsB.beta,
      evaluationsA: statsA.total,
      evaluationsB: statsB.total,
      recommendation,
    };
  }

  async function updateRecommendation(
    role: string,
    recommendation: "swap_to_challenger" | "keep_primary" | null
  ): Promise<void> {
    await db
      .update(agentCanaryPairings)
      .set({
        recommendation,
        updatedAt: new Date(),
      })
      .where(eq(agentCanaryPairings.role, role));
  }

  async function recordAndCompute(input: {
    role: string;
    model: string;
    harness: string;
    subscription: string;
    taskIdentifier: string;
    taskOutcome: "success" | "failure" | "partial";
    qualityScore?: number;
    tokenCost?: number;
    latencyMs?: number;
  }): Promise<PosteriorResult | null> {
    await db
      .insert(modelEvaluations)
      .values({
        role: input.role,
        model: input.model,
        harness: input.harness,
        subscription: input.subscription,
        benchmarkType: "internal_pr",
        taskIdentifier: input.taskIdentifier,
        taskOutcome: input.taskOutcome,
        qualityScore: input.qualityScore,
        tokenCost: input.tokenCost,
        latencyMs: input.latencyMs,
        evaluatedAt: new Date(),
      });

    logger.info(
      { role: input.role, model: input.model, taskIdentifier: input.taskIdentifier, taskOutcome: input.taskOutcome },
      "Recorded model evaluation"
    );

    const posterior = await getPosteriorForRole(input.role);
    if (posterior) {
      await updateRecommendation(input.role, posterior.recommendation);
    }

    return posterior;
  }

  return {
    getModelBetaParams,
    getPosteriorForRole,
    updateRecommendation,
    recordAndCompute,
  };
}

export type ModelEvaluationService = ReturnType<typeof createModelEvaluationService>;