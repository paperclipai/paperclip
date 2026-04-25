import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { eq, and, count, avg, sql } from "drizzle-orm";
import { modelEvaluations, agentCanaryPairings } from "@paperclipai/db";
import { createModelEvaluationService } from "../services/model-evaluation.js";
import { logger } from "../middleware/logger.js";

interface RoleSummary {
  role: string;
  primaryModel: string | null;
  challengerModel: string | null;
  primaryStats: ModelStats | null;
  challengerStats: ModelStats | null;
  pairingStatus: string | null;
  recommendation: string | null;
  trialsStartedAt: Date | null;
  trialsCompletedAt: Date | null;
}

interface ModelStats {
  model: string;
  evaluations: number;
  successRate: number;
  avgQuality: number | null;
  avgLatencyMs: number | null;
  avgTokenCost: number | null;
}

export function evaluationsRoutes(db?: Db) {
  const router = Router();

  if (!db) {
    router.get("/summary", (_req, res) => {
      res.status(503).json({ error: "Database not available" });
    });
    router.get("/posterior/:role", (_req, res) => {
      res.status(503).json({ error: "Database not available" });
    });
    return router;
  }

  const evaluationService = createModelEvaluationService(db);

  router.get("/summary", async (_req, res) => {
    try {
      const evaluations = await db
        .select({
          role: modelEvaluations.role,
          model: modelEvaluations.model,
          outcome: modelEvaluations.taskOutcome,
          qualityScore: modelEvaluations.qualityScore,
          latencyMs: modelEvaluations.latencyMs,
          tokenCost: modelEvaluations.tokenCost,
        })
        .from(modelEvaluations);

      const pairings = await db
        .select()
        .from(agentCanaryPairings);

      const pairingMap = new Map(pairings.map((p) => [p.role, p]));

      const roleStats = new Map<string, Map<string, ModelStats>>();

      for (const row of evaluations) {
        if (!roleStats.has(row.role)) {
          roleStats.set(row.role, new Map());
        }
        const modelMap = roleStats.get(row.role)!;

        if (!modelMap.has(row.model)) {
          modelMap.set(row.model, {
            model: row.model,
            evaluations: 0,
            successRate: 0,
            avgQuality: null,
            avgLatencyMs: null,
            avgTokenCost: null,
          });
        }

        const stats = modelMap.get(row.model)!;
        stats.evaluations++;
        if (row.outcome === "success") {
          stats.successRate = (stats.successRate * (stats.evaluations - 1) + 1) / stats.evaluations;
        } else {
          stats.successRate = stats.successRate * (stats.evaluations - 1) / stats.evaluations;
        }

        if (row.qualityScore !== null) {
          const prevQualitySum = (stats.avgQuality ?? 0) * (stats.evaluations - 1);
          stats.avgQuality = (prevQualitySum + row.qualityScore) / stats.evaluations;
        }

        if (row.latencyMs !== null) {
          const prevLatencySum = (stats.avgLatencyMs ?? 0) * (stats.evaluations - 1);
          stats.avgLatencyMs = Math.round((prevLatencySum + row.latencyMs) / stats.evaluations);
        }

        if (row.tokenCost !== null) {
          const prevCostSum = (stats.avgTokenCost ?? 0) * (stats.evaluations - 1);
          stats.avgTokenCost = Math.round((prevCostSum + row.tokenCost) / stats.evaluations);
        }
      }

      const summary: RoleSummary[] = [];

      for (const [role, modelMap] of roleStats) {
        const pairing = pairingMap.get(role);
        const models = Array.from(modelMap.values());

        const primaryStats = pairing
          ? models.find((m) => m.model === pairing.primaryModel) ?? null
          : models[0] ?? null;
        const challengerStats = pairing
          ? models.find((m) => m.model === pairing.challengerModel) ?? null
          : models[1] ?? null;

        summary.push({
          role,
          primaryModel: pairing?.primaryModel ?? primaryStats?.model ?? null,
          challengerModel: pairing?.challengerModel ?? challengerStats?.model ?? null,
          primaryStats,
          challengerStats,
          pairingStatus: pairing?.status ?? null,
          recommendation: pairing?.recommendation ?? null,
          trialsStartedAt: pairing?.trialsStartedAt ?? null,
          trialsCompletedAt: pairing?.trialsCompletedAt ?? null,
        });
      }

      summary.sort((a, b) => a.role.localeCompare(b.role));

      res.json({
        success: true,
        data: summary,
      });
    } catch (err) {
      logger.error({ err }, "Failed to get evaluations summary");
      res.status(500).json({
        error: "Failed to retrieve evaluations summary",
        code: "INTERNAL_ERROR",
      });
    }
  });

  router.get("/posterior/:role", async (req, res) => {
    try {
      const { role } = req.params;

      const posterior = await evaluationService.getPosteriorForRole(role);

      if (!posterior) {
        res.status(404).json({
          error: `No active canary pairing found for role: ${role}`,
          code: "NOT_FOUND",
        });
        return;
      }

      res.json({
        success: true,
        data: posterior,
      });
    } catch (err) {
      logger.error({ err, role: req.params.role }, "Failed to get posterior");
      res.status(500).json({
        error: "Failed to compute posterior",
        code: "INTERNAL_ERROR",
      });
    }
  });

  return router;
}