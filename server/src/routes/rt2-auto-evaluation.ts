import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2AutoEvaluationService } from "../services/rt2-auto-evaluation.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2AutoEvaluationRoutes(db: Db) {
  const router = Router();
  const autoEvalService = rt2AutoEvaluationService(db);

  // ===== Base Price Management =====

  /**
   * GET /companies/:companyId/rt2/base-prices
   * List all base prices for the company
   */
  router.get("/companies/:companyId/rt2/base-prices", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const basePrices = await autoEvalService.listBasePrices(companyId);
      return res.json(basePrices);
    } catch (error) {
      console.error("Error listing base prices:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/base-prices
   * Create or update a base price
   */
  router.post("/companies/:companyId/rt2/base-prices", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { deliverableType, basePrice, threshold } = req.body;

      if (!deliverableType || typeof basePrice !== "number") {
        return res.status(400).json({
          error: "deliverableType and basePrice are required",
        });
      }

      if (basePrice < 0) {
        return res.status(400).json({ error: "basePrice must be non-negative" });
      }

      if (threshold !== undefined && (threshold < 0 || threshold > 1)) {
        return res.status(400).json({
          error: "threshold must be between 0 and 1",
        });
      }

      const result = await autoEvalService.setBasePrice(
        companyId,
        deliverableType,
        basePrice,
        threshold,
      );
      return res.json(result);
    } catch (error) {
      console.error("Error creating base price:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * PUT /companies/:companyId/rt2/base-prices/:type
   * Update a specific base price
   */
  router.put("/companies/:companyId/rt2/base-prices/:type", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const deliverableType = req.params.type;
      const { basePrice, threshold } = req.body;

      if (basePrice !== undefined && basePrice < 0) {
        return res.status(400).json({ error: "basePrice must be non-negative" });
      }

      if (threshold !== undefined && (threshold < 0 || threshold > 1)) {
        return res.status(400).json({
          error: "threshold must be between 0 and 1",
        });
      }

      // Get current to merge updates
      const current = await autoEvalService.getBasePrice(companyId, deliverableType);

      const updated = await autoEvalService.setBasePrice(
        companyId,
        deliverableType,
        basePrice ?? current.basePrice,
        threshold ?? current.threshold,
      );
      return res.json(updated);
    } catch (error) {
      console.error("Error updating base price:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * DELETE /companies/:companyId/rt2/base-prices/:type
   * Delete (deactivate) a base price
   */
  router.delete("/companies/:companyId/rt2/base-prices/:type", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const deliverableType = req.params.type;

      await autoEvalService.deleteBasePrice(companyId, deliverableType);
      return res.json({ success: true });
    } catch (error) {
      console.error("Error deleting base price:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== Auto Evaluation =====

  /**
   * POST /companies/:companyId/rt2/auto-evaluate
   * Create an auto-evaluation for a deliverable
   */
  router.post("/companies/:companyId/rt2/auto-evaluate", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { taskIssueId, aiScore, deliverableType, evaluator, rationale, mode } = req.body;

      if (!taskIssueId || typeof aiScore !== "number") {
        return res.status(400).json({
          error: "taskIssueId and aiScore (0-100) are required",
        });
      }

      if (aiScore < 0 || aiScore > 100) {
        return res.status(400).json({ error: "aiScore must be between 0 and 100" });
      }
      if (mode !== undefined && !["shadow", "copilot", "auto"].includes(mode)) {
        return res.status(400).json({ error: "mode must be one of shadow, copilot, auto" });
      }

      const result = await autoEvalService.evaluateDeliverable(
        companyId,
        taskIssueId,
        aiScore,
        deliverableType || "default",
        evaluator,
        rationale,
        mode,
      );
      return res.json(result);
    } catch (error) {
      console.error("Error creating auto-evaluation:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/companies/:companyId/rt2/jarvis/quality-reviews", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const queue = await autoEvalService.getManagerReviewQueue(companyId);
      return res.json(queue);
    } catch (error) {
      console.error("Error listing Jarvis quality reviews:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/companies/:companyId/rt2/jarvis/quality-reviews/:evaluationId/approve", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const evaluationId = req.params.evaluationId as string;
      const managerId = String(req.body.managerId ?? req.actor.userId ?? "").trim();
      const feedback = typeof req.body.feedback === "string" ? req.body.feedback : undefined;

      if (!managerId) {
        return res.status(400).json({ error: "managerId is required" });
      }

      const evaluation = await autoEvalService.decideEvaluation(companyId, evaluationId, "approved", managerId, feedback);
      return res.json(evaluation);
    } catch (error) {
      console.error("Error approving Jarvis quality review:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/companies/:companyId/rt2/jarvis/quality-reviews/:evaluationId/reject", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const evaluationId = req.params.evaluationId as string;
      const managerId = String(req.body.managerId ?? req.actor.userId ?? "").trim();
      const feedback = typeof req.body.feedback === "string" ? req.body.feedback : undefined;

      if (!managerId) {
        return res.status(400).json({ error: "managerId is required" });
      }
      if (!feedback?.trim()) {
        return res.status(400).json({ error: "feedback is required when rejecting" });
      }

      const evaluation = await autoEvalService.decideEvaluation(companyId, evaluationId, "rejected", managerId, feedback);
      return res.json(evaluation);
    } catch (error) {
      console.error("Error rejecting Jarvis quality review:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/companies/:companyId/rt2/jarvis/auto-policy", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const aiScore = Number(req.query.aiScore);
      const deliverableType = String(req.query.deliverableType ?? "default");
      const mode = String(req.query.mode ?? "auto");

      if (!Number.isFinite(aiScore) || aiScore < 0 || aiScore > 100) {
        return res.status(400).json({ error: "aiScore must be between 0 and 100" });
      }
      if (!["shadow", "copilot", "auto"].includes(mode)) {
        return res.status(400).json({ error: "mode must be one of shadow, copilot, auto" });
      }

      const decision = await autoEvalService.decideAutoPolicy(
        companyId,
        aiScore,
        deliverableType,
        mode as "shadow" | "copilot" | "auto",
      );
      return res.json(decision);
    } catch (error) {
      console.error("Error deciding Jarvis auto policy:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/auto-evaluations
   * List auto evaluations with optional mode filter
   */
  router.get("/companies/:companyId/rt2/auto-evaluations", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { mode, limit, offset } = req.query;

      const evaluations = await autoEvalService.getEvaluations(companyId, {
        mode: mode as "shadow" | "auto" | "copilot" | undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });
      return res.json(evaluations);
    } catch (error) {
      console.error("Error listing auto evaluations:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/auto-evaluation/stats
   * Get auto evaluation statistics
   */
  router.get("/companies/:companyId/rt2/auto-evaluation/stats", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const stats = await autoEvalService.getStats(companyId);
      return res.json(stats);
    } catch (error) {
      console.error("Error getting auto evaluation stats:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/auto-eval/threshold/:type
   * Get threshold for a specific deliverable type
   */
  router.get("/companies/:companyId/rt2/auto-eval/threshold/:type", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const deliverableType = req.params.type;

      const { threshold, source } = await autoEvalService.getBasePrice(
        companyId,
        deliverableType,
      );
      return res.json({ deliverableType, threshold, source });
    } catch (error) {
      console.error("Error getting threshold:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * PUT /companies/:companyId/rt2/auto-eval/threshold/:type
   * Update threshold for a specific deliverable type
   */
  router.put("/companies/:companyId/rt2/auto-eval/threshold/:type", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const deliverableType = req.params.type;
      const { threshold } = req.body;

      if (threshold === undefined || threshold < 0 || threshold > 1) {
        return res.status(400).json({
          error: "threshold is required and must be between 0 and 1",
        });
      }

      const updated = await autoEvalService.updateThreshold(
        companyId,
        deliverableType,
        threshold,
      );
      return res.json(updated);
    } catch (error) {
      console.error("Error updating threshold:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
