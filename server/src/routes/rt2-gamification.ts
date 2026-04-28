import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2GamificationService } from "../services/rt2-gamification.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2GamificationRoutes(db: Db) {
  const router = Router();
  const gamificationSvc = rt2GamificationService(db);

  // GET /companies/:companyId/rt2/gamification/leaderboard
  router.get("/companies/:companyId/rt2/gamification/leaderboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = String(req.query.projectId ?? "").trim() || undefined;

    assertCompanyAccess(req, companyId);

    const leaderboard = await gamificationSvc.getLeaderboard(companyId, projectId);
    res.json(leaderboard);
  });

  // GET /companies/:companyId/rt2/gamification/agents/:agentId/score
  router.get("/companies/:companyId/rt2/gamification/agents/:agentId/score", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;

    assertCompanyAccess(req, companyId);

    const score = await gamificationSvc.getAgentScore(companyId, agentId);
    res.json(score);
  });

  // GET /companies/:companyId/rt2/gamification/agents/:agentId/achievements
  router.get("/companies/:companyId/rt2/gamification/agents/:agentId/achievements", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;

    assertCompanyAccess(req, companyId);

    const achievements = await gamificationSvc.getAchievements(companyId, agentId);
    res.json(achievements);
  });

  // GET /companies/:companyId/rt2/gamification/agents/:agentId/xp-history
  router.get("/companies/:companyId/rt2/gamification/agents/:agentId/xp-history", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 100);

    assertCompanyAccess(req, companyId);

    const history = await gamificationSvc.getXpHistory(companyId, agentId, limit);
    res.json(history);
  });

  // GET /companies/:companyId/rt2/gamification/agents/:agentId/level-history
  router.get("/companies/:companyId/rt2/gamification/agents/:agentId/level-history", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;

    assertCompanyAccess(req, companyId);

    const history = await gamificationSvc.getLevelHistory(companyId, agentId);
    res.json(history);
  });

  // GET /companies/:companyId/rt2/gamification/agents/:agentId/balance
  router.get("/companies/:companyId/rt2/gamification/agents/:agentId/balance", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;

    assertCompanyAccess(req, companyId);

    const balance = await gamificationSvc.getAgentBalance(companyId, agentId);
    res.json(balance);
  });

  // POST /companies/:companyId/rt2/gamification/award-xp
  router.post("/companies/:companyId/rt2/gamification/award-xp", async (req, res) => {
    const companyId = req.params.companyId as string;
    const { agentId, activityType, issueId, description } = req.body as {
      agentId: string;
      activityType: string;
      issueId?: string;
      description?: string;
    };

    assertCompanyAccess(req, companyId);

    const result = await gamificationSvc.awardXp(
      companyId,
      agentId,
      activityType as import("@paperclipai/shared").Rt2XpActivityType,
      issueId,
      description,
    );

    res.json(result);
  });

  // POST /companies/:companyId/rt2/gamification/award-gold
  router.post("/companies/:companyId/rt2/gamification/award-gold", async (req, res) => {
    const companyId = req.params.companyId as string;
    const { agentId, amount, description } = req.body as {
      agentId: string;
      amount: number;
      description?: string;
    };

    assertCompanyAccess(req, companyId);

    const balance = await gamificationSvc.awardGold(companyId, agentId, amount, description);
    res.json(balance);
  });

  // GET /companies/:companyId/rt2/economy/balance
  router.get("/companies/:companyId/rt2/economy/balance", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const balance = await gamificationSvc.getTokenBalance(companyId);
    res.json(balance);
  });

  // GET /companies/:companyId/rt2/economy/transactions
  router.get("/companies/:companyId/rt2/economy/transactions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 100);

    assertCompanyAccess(req, companyId);

    const transactions = await gamificationSvc.getTransactionHistory(companyId, limit);
    res.json(transactions);
  });

  // GET /companies/:companyId/rt2/economy/costs
  router.get("/companies/:companyId/rt2/economy/costs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const costs = await gamificationSvc.getCostBreakdown(companyId);
    res.json(costs);
  });

  return router;
}
