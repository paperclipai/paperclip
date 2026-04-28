import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2ReputationExpansionService } from "../services/rt2-reputation-expansion.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2ReputationExpansionRoutes(db: Db) {
  const router = Router();
  const reputationService = rt2ReputationExpansionService(db);

  // ===== Promotion Triggers =====

  /**
   * GET /companies/:companyId/rt2/promotion-triggers
   * List pending promotion triggers
   */
  router.get("/companies/:companyId/rt2/promotion-triggers", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const pending = await reputationService.getPendingPromotions(companyId);
      return res.json(pending);
    } catch (error) {
      console.error("Error getting promotion triggers:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/promotion-triggers/check/:agentId
   * Check if agent is eligible for promotion
   */
  router.post("/companies/:companyId/rt2/promotion-triggers/check/:agentId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId;

      const eligibility = await reputationService.checkPromotionEligibility(companyId, agentId);
      return res.json(eligibility);
    } catch (error) {
      console.error("Error checking promotion eligibility:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * PUT /companies/:companyId/rt2/promotion-triggers/:id/resolve
   * Resolve a promotion trigger
   */
  router.put("/companies/:companyId/rt2/promotion-triggers/:id/resolve", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const triggerId = req.params.id;
      const { decision, resolvedBy } = req.body;

      if (!decision || !["approved", "rejected", "auto_promoted"].includes(decision)) {
        return res.status(400).json({
          error: "decision must be 'approved', 'rejected', or 'auto_promoted'",
        });
      }

      if (!resolvedBy) {
        return res.status(400).json({ error: "resolvedBy is required" });
      }

      const resolved = await reputationService.resolvePromotion(
        triggerId,
        companyId,
        decision,
        resolvedBy,
      );
      return res.json(resolved);
    } catch (error) {
      console.error("Error resolving promotion trigger:", error);
      if ((error as any).message?.includes("not found")) {
        return res.status(404).json({ error: "Promotion trigger not found" });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== Performance Reviews =====

  /**
   * GET /companies/:companyId/rt2/performance-reviews
   * List performance reviews
   */
  router.get("/companies/:companyId/rt2/performance-reviews", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { agentId, reviewPeriod, status, limit } = req.query;

      const reviews = await reputationService.getPerformanceReviews(companyId, {
        agentId: agentId as string | undefined,
        reviewPeriod: reviewPeriod as string | undefined,
        status: status as string | undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
      });
      return res.json(reviews);
    } catch (error) {
      console.error("Error getting performance reviews:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/performance-reviews
   * Create a performance review draft
   */
  router.post("/companies/:companyId/rt2/performance-reviews", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { agentId, reviewPeriod, periodStart, periodEnd } = req.body;

      if (!agentId || !reviewPeriod || !periodStart || !periodEnd) {
        return res.status(400).json({
          error: "agentId, reviewPeriod, periodStart, and periodEnd are required",
        });
      }

      if (!["quarterly", "halfyearly", "yearly"].includes(reviewPeriod)) {
        return res.status(400).json({
          error: "reviewPeriod must be 'quarterly', 'halfyearly', or 'yearly'",
        });
      }

      const review = await reputationService.createPerformanceReview(
        companyId,
        agentId,
        reviewPeriod,
        new Date(periodStart),
        new Date(periodEnd),
      );
      return res.status(201).json(review);
    } catch (error) {
      console.error("Error creating performance review:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/performance-reviews/:id
   * Get a specific performance review
   */
  router.get("/companies/:companyId/rt2/performance-reviews/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const reviewId = req.params.id;

      const review = await reputationService.getPerformanceReview(reviewId, companyId);

      if (!review) {
        return res.status(404).json({ error: "Performance review not found" });
      }
      return res.json(review);
    } catch (error) {
      console.error("Error getting performance review:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * PUT /companies/:companyId/rt2/performance-reviews/:id
   * Update/submit a performance review
   */
  router.put("/companies/:companyId/rt2/performance-reviews/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const reviewId = req.params.id;
      const { feedback, grade, status } = req.body;

      if (grade && !["S", "A", "B", "C", "D"].includes(grade)) {
        return res.status(400).json({ error: "grade must be S, A, B, C, or D" });
      }

      if (status && !["draft", "submitted", "acknowledged"].includes(status)) {
        return res.status(400).json({ error: "status must be draft, submitted, or acknowledged" });
      }

      const updated = await reputationService.submitPerformanceReview(reviewId, companyId, {
        feedback,
        grade,
        status,
      });
      return res.json(updated);
    } catch (error) {
      console.error("Error updating performance review:", error);
      if ((error as any).message?.includes("not found")) {
        return res.status(404).json({ error: "Performance review not found" });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== Credit Conversion =====

  /**
   * GET /companies/:companyId/rt2/credit-balance/:actorId
   * Get credit balance for an actor
   */
  router.get("/companies/:companyId/rt2/credit-balance/:actorId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actorId = req.params.actorId;
      const actorType = (req.query.actorType as string) || "agent";

      if (!["user", "agent"].includes(actorType)) {
        return res.status(400).json({ error: "actorType must be 'user' or 'agent'" });
      }

      const balance = await reputationService.getCreditBalance(
        companyId,
        actorId,
        actorType as "user" | "agent",
      );
      return res.json(balance);
    } catch (error) {
      console.error("Error getting credit balance:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/convert-credits
   * Convert credits to gold
   */
  router.post("/companies/:companyId/rt2/convert-credits", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { actorId, actorType, credits } = req.body;

      if (!actorId) {
        return res.status(400).json({ error: "actorId is required" });
      }

      if (!["user", "agent"].includes(actorType)) {
        return res.status(400).json({ error: "actorType must be 'user' or 'agent'" });
      }

      const result = await reputationService.convertCreditsToGold(
        companyId,
        actorId,
        actorType as "user" | "agent",
        credits,
      );
      return res.json(result);
    } catch (error) {
      console.error("Error converting credits:", error);
      const errorMessage = (error as Error).message;
      if (errorMessage.includes("Insufficient credits")) {
        return res.status(400).json({ error: errorMessage });
      }
      if (errorMessage.includes("need at least")) {
        return res.status(400).json({ error: errorMessage });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/credit-history
   * Get credit conversion history
   */
  router.get("/companies/:companyId/rt2/credit-history", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { actorId, limit } = req.query;

      const history = await reputationService.getConversionHistory(
        companyId,
        actorId as string | undefined,
        limit ? parseInt(limit as string, 10) : undefined,
      );
      return res.json(history);
    } catch (error) {
      console.error("Error getting credit history:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
