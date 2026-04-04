import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { agents } from "@ironworksai/db";
import { and, eq, ne, inArray } from "drizzle-orm";
import { executiveAnalyticsService } from "../services/executive-analytics.js";
import { logActivity } from "../services/activity-log.js";
import { heartbeatService } from "../services/heartbeat.js";
import { tokenAnalyticsService } from "../services/token-analytics.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function executiveRoutes(db: Db) {
  const router = Router();
  const analytics = executiveAnalyticsService(db);
  const heartbeat = heartbeatService(db);
  const tokenAnalytics = tokenAnalyticsService(db);

  // -- CFO: Unit Economics --
  router.get("/companies/:companyId/executive/unit-economics", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await analytics.unitEconomics(companyId);
    res.json(data);
  });

  // -- CFO: Burn Rate --
  router.get("/companies/:companyId/executive/burn-rate", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await analytics.burnRate(companyId);
    res.json(data);
  });

  // -- CFO: Cost Allocation --
  router.get("/companies/:companyId/executive/cost-allocation", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await analytics.costAllocation(companyId);
    res.json(data);
  });

  // -- SLA Compliance --
  router.get("/companies/:companyId/executive/sla-compliance", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await analytics.slaCompliance(companyId);
    res.json(data);
  });

  // -- CTO: Tech Debt --
  router.get("/companies/:companyId/executive/tech-debt", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await analytics.techDebtCount(companyId);
    res.json(data);
  });

  // -- Risk Register --
  router.get("/companies/:companyId/executive/risk-register", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await analytics.riskRegister(companyId);
    res.json(data);
  });

  // -- Company Health Score --
  router.get("/companies/:companyId/executive/health-score", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await analytics.companyHealthScore(companyId);
    res.json(data);
  });

  // -- CFO Kill Switch: Emergency Pause All Agents --
  router.post("/companies/:companyId/agents/emergency-pause-all", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const now = new Date();

    // Find all non-paused, non-terminated agents
    const activeAgents = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          ne(agents.status, "paused"),
          ne(agents.status, "terminated"),
        ),
      );

    if (activeAgents.length === 0) {
      res.json({ paused: 0, message: "No active agents to pause." });
      return;
    }

    // Pause all at once
    await db
      .update(agents)
      .set({
        status: "paused",
        pauseReason: "manual",
        pausedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agents.companyId, companyId),
          ne(agents.status, "paused"),
          ne(agents.status, "terminated"),
        ),
      );

    // Cancel all running work
    for (const agent of activeAgents) {
      try {
        await heartbeat.cancelActiveForAgent(agent.id);
      } catch {
        // best-effort cancellation
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "company.emergency_pause_all",
      entityType: "company",
      entityId: companyId,
      details: { pausedCount: activeAgents.length },
    });

    res.json({
      paused: activeAgents.length,
      message: `Emergency pause: ${activeAgents.length} agent(s) paused immediately.`,
    });
  });

  // -- Token Analytics: Company-wide --
  router.get("/companies/:companyId/token-analytics", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const periodDays = req.query.periodDays ? Number(req.query.periodDays) : 30;
    const data = await tokenAnalytics.getCompanyTokenSummary(companyId, periodDays);
    res.json(data);
  });

  // -- Token Analytics: Per-agent summary + waste analysis --
  router.get("/companies/:companyId/token-analytics/:agentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    const periodDays = req.query.periodDays ? Number(req.query.periodDays) : 30;
    const [summary, waste] = await Promise.all([
      tokenAnalytics.getAgentTokenSummary(agentId, periodDays),
      tokenAnalytics.analyzeTokenWaste(agentId, companyId, periodDays),
    ]);
    res.json({ summary, waste });
  });

  return router;
}
