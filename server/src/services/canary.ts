import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentCanaryPairings, modelEvaluations, type AgentCanaryPairing } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export type CanaryStatus = "active" | "paused" | "promoted" | "rejected";

export interface CanaryPairingInfo {
  role: string;
  primaryModel: string;
  challengerModel: string;
  primaryHarness: string;
  challengerHarness: string;
  canaryPercent: number;
  status: CanaryStatus;
  trialsStartedAt: Date | null;
  trialsCompletedAt: Date | null;
  recommendation: string | null;
}

export interface CanaryDecision {
  useChallenger: boolean;
  pairing: CanaryPairingInfo | null;
}

function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

export function shouldRouteToChallenger(issueId: string, role: string, canaryPercent: number): boolean {
  const combined = `${role}:${issueId}`;
  const hash = hashStringToNumber(combined);
  const bucket = hash % 100;
  return bucket < canaryPercent;
}

export function createCanaryService(db: Db) {
  async function getCanaryPairingForRole(role: string): Promise<CanaryPairingInfo | null> {
    const rows = await db
      .select()
      .from(agentCanaryPairings)
      .where(and(
        eq(agentCanaryPairings.role, role),
        eq(agentCanaryPairings.status, "active"),
      ))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const pairing = rows[0]!;
    return {
      role: pairing.role,
      primaryModel: pairing.primaryModel,
      challengerModel: pairing.challengerModel,
      primaryHarness: pairing.primaryHarness,
      challengerHarness: pairing.challengerHarness,
      canaryPercent: pairing.canaryPercent,
      status: pairing.status as CanaryStatus,
      trialsStartedAt: pairing.trialsStartedAt,
      trialsCompletedAt: pairing.trialsCompletedAt,
      recommendation: pairing.recommendation,
    };
  }

  async function getAllCanaryPairings(): Promise<CanaryPairingInfo[]> {
    const rows = await db
      .select()
      .from(agentCanaryPairings);

    return rows.map((pairing) => ({
      role: pairing.role,
      primaryModel: pairing.primaryModel,
      challengerModel: pairing.challengerModel,
      primaryHarness: pairing.primaryHarness,
      challengerHarness: pairing.challengerHarness,
      canaryPercent: pairing.canaryPercent,
      status: pairing.status as CanaryStatus,
      trialsStartedAt: pairing.trialsStartedAt,
      trialsCompletedAt: pairing.trialsCompletedAt,
      recommendation: pairing.recommendation,
    }));
  }

  async function decideCanaryRoute(issueId: string, role: string): Promise<CanaryDecision> {
    const pairing = await getCanaryPairingForRole(role);

    if (!pairing) {
      return { useChallenger: false, pairing: null };
    }

    const useChallenger = shouldRouteToChallenger(issueId, role, pairing.canaryPercent);

    logger.info(
      { issueId, role, useChallenger, canaryPercent: pairing.canaryPercent },
      "Canary routing decision",
    );

    return { useChallenger, pairing };
  }

  async function recordEvaluation(input: {
    role: string;
    model: string;
    harness: string;
    subscription: string;
    taskIdentifier: string;
    taskOutcome: "success" | "failure" | "partial";
    qualityScore?: number;
    tokenCost?: number;
    latencyMs?: number;
    benchmarkType?: "internal_pr" | "public_benchmark";
  }): Promise<void> {
    try {
      await db
        .insert(modelEvaluations)
        .values({
          role: input.role,
          model: input.model,
          harness: input.harness,
          subscription: input.subscription,
          benchmarkType: input.benchmarkType ?? "internal_pr",
          taskIdentifier: input.taskIdentifier,
          taskOutcome: input.taskOutcome,
          qualityScore: input.qualityScore,
          tokenCost: input.tokenCost,
          latencyMs: input.latencyMs,
          evaluatedAt: new Date(),
        });

      logger.info(
        { role: input.role, model: input.model, taskIdentifier: input.taskIdentifier, taskOutcome: input.taskOutcome },
        "Recorded model evaluation",
      );
    } catch (err) {
      logger.error({ err, input }, "Failed to record model evaluation");
      throw err;
    }
  }

  async function updateCanaryStatus(
    role: string,
    status: CanaryStatus,
  ): Promise<void> {
    try {
      await db
        .update(agentCanaryPairings)
        .set({
          status,
          updatedAt: new Date(),
        })
        .where(eq(agentCanaryPairings.role, role));

      logger.info({ role, status }, "Updated canary pairing status");
    } catch (err) {
      logger.error({ err, role, status }, "Failed to update canary pairing status");
      throw err;
    }
  }

  async function upsertCanaryPairing(input: {
    role: string;
    primaryModel: string;
    challengerModel: string;
    primaryHarness: string;
    challengerHarness: string;
    canaryPercent?: number;
  }): Promise<void> {
    const { role, primaryModel, challengerModel, primaryHarness, challengerHarness, canaryPercent = 20 } = input;

    await db
      .insert(agentCanaryPairings)
      .values({
        role,
        primaryModel,
        challengerModel,
        primaryHarness,
        challengerHarness,
        canaryPercent,
        status: "active",
        trialsStartedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [agentCanaryPairings.role],
        set: {
          primaryModel,
          challengerModel,
          primaryHarness,
          challengerHarness,
          canaryPercent,
          status: "active",
          updatedAt: new Date(),
        },
      });
  }

  return {
    getCanaryPairingForRole,
    getAllCanaryPairings,
    decideCanaryRoute,
    recordEvaluation,
    updateCanaryStatus,
    upsertCanaryPairing,
  };
}

export type CanaryService = ReturnType<typeof createCanaryService>;