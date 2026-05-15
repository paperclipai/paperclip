import { Router } from "express";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, type Db } from "@paperclipai/db";
import { createRunLifecycleAlertService } from "../services/run-lifecycle-alerts.js";
import { assertCompanyAccess } from "./authz.js";

export default function runMetricsRoutes(db: Db) {
  const router = Router();

  /**
   * GET /api/companies/:companyId/runs/metrics
   *
   * Get operational metrics for run lifecycle monitoring
   */
  router.get("/companies/:companyId/runs/metrics", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const timeRangeHours = Number(req.query.timeRangeHours) || 24;

      const since = new Date(Date.now() - timeRangeHours * 60 * 60 * 1000);

      // Active run count by agent
      const activeRunsByAgent = await db
        .select({
          agentId: heartbeatRuns.agentId,
          count: count(),
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, ["running", "queued"]),
          ),
        )
        .groupBy(heartbeatRuns.agentId);

      // Zombie runs by age bracket
      const zombieThreshold1h = new Date(Date.now() - 1 * 60 * 60 * 1000);
      const zombieThreshold4h = new Date(Date.now() - 4 * 60 * 60 * 1000);

      const zombieRuns = await db
        .select({
          ageBracket: sql<string>`
            case
              when ${heartbeatRuns.lastOutputAt} >= ${zombieThreshold1h} then 'active'
              when ${heartbeatRuns.lastOutputAt} >= ${zombieThreshold4h} then '1-4h'
              else '4h+'
            end
          `,
          count: count(),
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, ["running", "queued"]),
          ),
        )
        .groupBy(sql`
          case
            when ${heartbeatRuns.lastOutputAt} >= ${zombieThreshold1h} then 'active'
            when ${heartbeatRuns.lastOutputAt} >= ${zombieThreshold4h} then '1-4h'
            else '4h+'
          end
        `);

      // Failed cleanup attempts in time range
      const failedCleanups = await db
        .select({
          count: count(),
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "run.cleanup.failed"),
            gte(activityLog.createdAt, since),
          ),
        )
        .then((rows) => rows[0]?.count ?? 0);

      // Failed terminations in time range
      const failedTerminations = await db
        .select({
          count: count(),
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "run.process.termination_failed"),
            gte(activityLog.createdAt, since),
          ),
        )
        .then((rows: Array<{ count: number }>) => rows[0]?.count ?? 0);

      // Run duration percentiles (completed runs in time range)
      const completedRuns = await db
        .select({
          durationMs: sql<number>`
            extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000
          `,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out"]),
            gte(heartbeatRuns.finishedAt, since),
            sql`${heartbeatRuns.startedAt} is not null`,
            sql`${heartbeatRuns.finishedAt} is not null`,
          ),
        )
        .orderBy(sql`"durationMs"`);

      const durations = completedRuns.map((r: { durationMs: number | null }) => r.durationMs).filter((d: number | null): d is number => d != null && d > 0);
      const percentiles = {
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        p99: percentile(durations, 0.99),
      };

      res.json({
        timeRangeHours,
        activeRunsByAgent: activeRunsByAgent.map((r: { agentId: string; count: number }) => ({
          agentId: r.agentId,
          count: r.count,
        })),
        zombieRuns: {
          active: zombieRuns.find((r: { ageBracket: string; count: number }) => r.ageBracket === "active")?.count ?? 0,
          "1-4h": zombieRuns.find((r: { ageBracket: string; count: number }) => r.ageBracket === "1-4h")?.count ?? 0,
          "4h+": zombieRuns.find((r: { ageBracket: string; count: number }) => r.ageBracket === "4h+")?.count ?? 0,
        },
        failedCleanups,
        failedTerminations,
        runDurationPercentiles: percentiles,
        completedRunCount: durations.length,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/companies/:companyId/runs/alerts
   *
   * Get current run lifecycle alerts
   */
  router.get("/companies/:companyId/runs/alerts", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const alertService = createRunLifecycleAlertService(db);
      const alerts = await alertService.checkAll(companyId);

      res.json({
        alerts: companyAlerts,
        summary: {
          total: companyAlerts.length,
          critical: companyAlerts.filter((a) => a.severity === "critical").length,
          error: companyAlerts.filter((a) => a.severity === "error").length,
          warning: companyAlerts.filter((a) => a.severity === "warning").length,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/companies/:companyId/runs/lifecycle-events
   *
   * Get recent run lifecycle events (cleanup, termination) for debugging
   */
  router.get("/companies/:companyId/runs/lifecycle-events", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const limit = Math.min(Number(req.query.limit) || 100, 1000);
      const runId = req.query.runId as string | undefined;
      const eventTypes = req.query.eventTypes as string | undefined;

        const lifecycleActions = eventTypes
          ? eventTypes.split(",").map((t) => t.trim())
          : [
              "run.cleanup.triggered",
              "run.cleanup.completed",
              "run.cleanup.failed",
              "run.process.termination_triggered",
              "run.process.terminated",
              "run.process.termination_failed",
            ];

        const conditions = [
          eq(activityLog.companyId, companyId),
          inArray(activityLog.action, lifecycleActions),
        ];

        if (runId) {
          conditions.push(eq(activityLog.entityId, runId));
        }

      const events = await db
        .select()
        .from(activityLog)
        .where(and(...conditions))
        .orderBy(desc(activityLog.createdAt))
        .limit(limit);

      res.json({
        events: events.map((e: typeof activityLog.$inferSelect) => ({
          id: e.id,
          action: e.action,
          entityId: e.entityId,
          agentId: e.agentId,
          runId: e.runId,
          details: e.details,
          createdAt: e.createdAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Calculate percentile from sorted array
   */
  function percentile(sortedValues: number[], p: number): number | null {
    if (sortedValues.length === 0) return null;
    const index = Math.ceil(sortedValues.length * p) - 1;
    return sortedValues[Math.max(0, index)] ?? null;
  }

  return router;
}
