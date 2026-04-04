import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { agents } from "@ironworksai/db";
import { and, eq, ne, inArray } from "drizzle-orm";
import { executiveAnalyticsService, budgetForecast, departmentSpendingSummary, modelHealthCheck } from "../services/executive-analytics.js";
import { computeDORAMetrics } from "../services/dora-metrics.js";
import { getMemoryHealth } from "../services/agent-memory.js";
import { logActivity } from "../services/activity-log.js";
import { heartbeatService } from "../services/heartbeat.js";
import { tokenAnalyticsService } from "../services/token-analytics.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { getPendingAlerts, resolveAlert, type AlertSeverity } from "../services/smart-alerts.js";
import { getRiskSettings, updateRiskSettings } from "../services/company-risk-settings.js";

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

  // -- Agent Security Profile --
  router.get("/companies/:companyId/agents/:agentId/security-profile", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    const data = await analytics.agentSecurityProfile(agentId);
    res.json(data);
  });

  // -- Compliance Export (JSON) --
  router.get("/companies/:companyId/compliance-export", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const fromStr = req.query.from as string | undefined;
    const toStr = req.query.to as string | undefined;
    const format = req.query.format as string | undefined;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = fromStr ? new Date(fromStr) : thirtyDaysAgo;
    const to = toStr ? new Date(toStr) : now;

    const data = await analytics.complianceExport(companyId, from, to);

    if (format === "csv") {
      // Convert to CSV: flatten all actions into rows
      const rows: string[] = [];
      rows.push("timestamp,actor_type,actor_id,action,entity_type,entity_id,agent_id,details");

      for (const entry of data.allActions) {
        const detailsStr = entry.details ? JSON.stringify(entry.details).replace(/"/g, '""') : "";
        rows.push([
          entry.createdAt instanceof Date ? entry.createdAt.toISOString() : String(entry.createdAt),
          entry.actorType,
          entry.actorId,
          entry.action,
          entry.entityType,
          entry.entityId,
          entry.agentId ?? "",
          `"${detailsStr}"`,
        ].join(","));
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="compliance-export-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv"`);
      res.send(rows.join("\n"));
      return;
    }

    res.json(data);
  });

  // -- Permission Matrix --
  router.get("/companies/:companyId/permission-matrix", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await analytics.permissionMatrix(companyId);
    res.json(data);
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

  // -- Smart Alerts: list pending --
  router.get("/companies/:companyId/alerts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const minSeverity = (req.query.severity as AlertSeverity | undefined) ?? "medium";
    const alerts = await getPendingAlerts(db, companyId, minSeverity);
    res.json(alerts);
  });

  // -- Smart Alerts: resolve --
  router.post("/companies/:companyId/alerts/:alertId/resolve", async (req, res) => {
    const companyId = req.params.companyId as string;
    const alertId = req.params.alertId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    await resolveAlert(db, companyId, alertId, actor.actorId);
    res.json({ ok: true });
  });

  // -- Department Spending --
  router.get("/companies/:companyId/department-spending", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await departmentSpendingSummary(db, companyId);
    res.json(data);
  });

  // -- Risk Settings: get --
  router.get("/companies/:companyId/risk-settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const settings = await getRiskSettings(db, companyId);
    res.json(settings);
  });

  // -- Risk Settings: update --
  router.patch("/companies/:companyId/risk-settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const updated = await updateRiskSettings(db, companyId, req.body as Record<string, unknown>, actor.actorId);
    res.json(updated);
  });

  // -- CTO: DORA Metrics --
  router.get("/companies/:companyId/dora-metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const days = req.query.days ? Number(req.query.days) : 30;
    const data = await computeDORAMetrics(db, companyId, days);
    res.json(data);
  });

  // -- Budget Forecast --
  router.get("/companies/:companyId/budget-forecast", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await budgetForecast(db, companyId);
    res.json(data);
  });

  // -- Memory Health --
  router.get("/companies/:companyId/agents/:agentId/memory-health", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    const data = await getMemoryHealth(db, agentId);
    res.json(data);
  });

  // -- Model Health --
  router.get("/companies/:companyId/executive/model-health", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await modelHealthCheck(db, companyId);
    res.json(data);
  });

  return router;
}
