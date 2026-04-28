import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2CollaborationRewardsService } from "../services/rt2-collaboration-rewards.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

export function rt2CollaborationRewardsRoutes(db: Db) {
  const router = Router();
  const svc = rt2CollaborationRewardsService(db);

  // M2.6: Get rewards leaderboard
  router.get("/companies/:companyId/rt2/collaboration/leaderboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const leaderboard = await svc.getRewardsLeaderboard(companyId, limit);
    res.json(leaderboard);
  });

  // M2.6: Get all company rewards
  router.get("/companies/:companyId/rt2/collaboration/rewards", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rewards = await svc.getCompanyRewards(companyId);
    res.json(rewards);
  });

  // M2.6: Get reputation statistics
  router.get("/companies/:companyId/rt2/collaboration/stats", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const stats = await svc.getReputationStats(companyId);
    res.json(stats);
  });

  router.post("/companies/:companyId/rt2/collaboration/derive-rewards", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const result = await svc.deriveCollaborationRewardsFromEvidence(companyId);
    res.json(result);
  });

  // M2.6: Record collaboration event
  router.post("/companies/:companyId/rt2/collaboration/events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { actorId, actorType, collaborationType, description, workProductId } = req.body;

    if (!actorId || !actorType || !collaborationType) {
      throw badRequest("actorId, actorType, and collaborationType are required");
    }

    if (!["user", "agent"].includes(actorType)) {
      throw badRequest("actorType must be 'user' or 'agent'");
    }

    if (!["peer_review", "pair_work", "knowledge_sharing", "help_provided"].includes(collaborationType)) {
      throw badRequest("Invalid collaborationType");
    }

    const result = await svc.recordCollaborationEvent(
      companyId,
      actorId,
      actorType,
      collaborationType,
      description || "",
      workProductId,
    );

    res.json(result);
  });

  // M2.6: Confirm collaboration (mark as successful/failed)
  router.post("/companies/:companyId/rt2/collaboration/events/:eventId/confirm", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { eventId } = req.params;
    const { successful } = req.body;

    if (typeof successful !== "boolean") {
      throw badRequest("successful must be a boolean");
    }

    const updatedReward = await svc.confirmCollaboration(companyId, eventId, successful);
    res.json(updatedReward);
  });

  // M2.6: Update AI contribution score
  router.post("/companies/:companyId/rt2/collaboration/ai-contribution", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { agentId, contributionType } = req.body;

    if (!agentId || !contributionType) {
      throw badRequest("agentId and contributionType are required");
    }

    if (!["completed", "helped", "reviewed"].includes(contributionType)) {
      throw badRequest("Invalid contributionType");
    }

    const updatedReward = await svc.updateAiContributionScore(
      companyId,
      agentId,
      contributionType as "completed" | "helped" | "reviewed",
    );

    res.json(updatedReward);
  });

  // M2.6: Get actor collaboration history
  router.get("/companies/:companyId/rt2/collaboration/history/:actorId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { actorId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;

    const history = await svc.getActorCollaborationHistory(companyId, actorId, limit);
    res.json(history);
  });

  return router;
}
