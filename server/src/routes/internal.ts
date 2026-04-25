import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { createCanaryService } from "../services/canary.js";
import { createModelEvaluationService } from "../services/model-evaluation.js";
import { logger } from "../middleware/logger.js";

const evaluationResultSchema = z.object({
  role: z.string(),
  model: z.string(),
  harness: z.string(),
  subscription: z.string(),
  taskIdentifier: z.string(),
  taskOutcome: z.enum(["success", "failure", "partial"]),
  qualityScore: z.number().optional(),
  tokenCost: z.number().optional(),
  latencyMs: z.number().optional(),
});

export function internalRoutes(db?: Db) {
  const router = Router();

  if (!db) {
    router.post("/evaluation-result", (_req, res) => {
      res.status(503).json({ error: "Database not available" });
    });
    return router;
  }

  const canaryService = createCanaryService(db);
  const evaluationService = createModelEvaluationService(db);

  router.post("/evaluation-result", async (req, res) => {
    try {
      const parsed = evaluationResultSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
          details: parsed.error.flatten(),
        });
        return;
      }

      const input = parsed.data;

      await canaryService.recordEvaluation(input);

      const posterior = await evaluationService.getPosteriorForRole(input.role);
      if (posterior && posterior.recommendation) {
        await evaluationService.updateRecommendation(input.role, posterior.recommendation);
        logger.info(
          { role: input.role, recommendation: posterior.recommendation, pBA: posterior.pBA },
          "Updated recommendation based on new evaluation"
        );
      }

      res.status(201).json({
        success: true,
        message: "Evaluation recorded",
        recommendation: posterior?.recommendation ?? null,
        pBA: posterior?.pBA ?? null,
      });
    } catch (err) {
      logger.error({ err }, "Failed to record evaluation result");
      res.status(500).json({
        error: "Failed to record evaluation result",
        code: "INTERNAL_ERROR",
      });
    }
  });

  return router;
}