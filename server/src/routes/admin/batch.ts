import { Router, Request, Response } from "express";
import { eq, and, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { batchQueueEntries, batchJobs } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

export function createBatchAdminRoutes(db: Db): Router {
  const router = Router();

  /**
   * GET /api/admin/batch/queue
   * Get batch queue status and recent entries
   *
   * Query params:
   * - status: filter by entry status (pending, submitted, completed, failed, expired, cancelled)
   * - agentId: filter by agent ID
   * - companyId: filter by company ID
   * - limit: max entries to return (default: 20)
   */
  router.get("/queue", async (req: Request, res: Response) => {
    try {
      const { status, agentId, companyId, limit = "20" } = req.query;
      const limitNum = Math.min(Math.max(parseInt(String(limit)) || 20, 1), 100);

      const conditions = [];
      if (status && typeof status === "string") {
        conditions.push(eq(batchQueueEntries.status, status));
      }
      if (agentId && typeof agentId === "string") {
        conditions.push(eq(batchQueueEntries.agentId, agentId));
      }
      if (companyId && typeof companyId === "string") {
        conditions.push(eq(batchQueueEntries.companyId, companyId));
      }

      // Get summary counts by status
      const summaryResult = await db
        .select({
          status: batchQueueEntries.status,
          count: sql`COUNT(*) as count`,
        })
        .from(batchQueueEntries)
        .groupBy(batchQueueEntries.status);

      const summary = {
        total: 0,
        pending: 0,
        submitted: 0,
        completed: 0,
        failed: 0,
        expired: 0,
        cancelled: 0,
      };

      for (const row of summaryResult) {
        const statusKey = (row.status || "pending") as keyof typeof summary;
        const count = Number(row.count);
        summary[statusKey] = count;
        summary.total += count;
      }

      // Get recent entries with optional filters
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      const entries = await db
        .select({
          id: batchQueueEntries.id,
          customId: batchQueueEntries.customId,
          agentId: batchQueueEntries.agentId,
          companyId: batchQueueEntries.companyId,
          status: batchQueueEntries.status,
          createdAt: batchQueueEntries.createdAt,
          updatedAt: batchQueueEntries.updatedAt,
          batchJobId: batchQueueEntries.batchJobId,
          errorMessage: batchQueueEntries.errorMessage,
        })
        .from(batchQueueEntries)
        .where(whereClause)
        .orderBy((t) => sql`${t.createdAt} DESC`)
        .limit(limitNum);

      // Get in-progress batch jobs
      const jobs = await db
        .select({
          id: batchJobs.id,
          anthropicBatchId: batchJobs.anthropicBatchId,
          status: batchJobs.status,
          entryCount: batchJobs.entryCount,
          submittedAt: batchJobs.submittedAt,
          lastPolledAt: batchJobs.lastPolledAt,
          endedAt: batchJobs.endedAt,
          errorMessage: batchJobs.errorMessage,
        })
        .from(batchJobs)
        .where(eq(batchJobs.status, "in_progress"))
        .orderBy((t) => sql`${t.submittedAt} DESC`)
        .limit(10);

      res.json({
        summary,
        entries: entries.map((e) => ({
          ...e,
          createdAt: (e.createdAt as Date).toISOString(),
          updatedAt: (e.updatedAt as Date).toISOString(),
        })),
        jobs: jobs.map((j) => ({
          ...j,
          submittedAt: (j.submittedAt as Date).toISOString(),
          lastPolledAt: j.lastPolledAt ? (j.lastPolledAt as Date).toISOString() : null,
          endedAt: j.endedAt ? (j.endedAt as Date).toISOString() : null,
        })),
      });
    } catch (err) {
      logger.error({ err }, "failed to fetch batch queue status");
      res.status(500).json({
        error: "Failed to fetch batch queue status",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  /**
   * GET /api/admin/batch/stats
   * Get batch API usage statistics
   */
  router.get("/stats", async (req: Request, res: Response) => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Entries created today
      const todayEntries = await db
        .select({
          status: batchQueueEntries.status,
          count: sql`COUNT(*) as count`,
        })
        .from(batchQueueEntries)
        .where(sql`DATE(${batchQueueEntries.createdAt}) = CURRENT_DATE`)
        .groupBy(batchQueueEntries.status);

      // Total batches submitted this month
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const totalBatches = await db
        .select({ count: sql`COUNT(*) as count` })
        .from(batchJobs)
        .where(sql`${batchJobs.submittedAt} >= ${monthStart}`);

      res.json({
        today: Object.fromEntries(
          todayEntries.map((r) => [r.status || "pending", Number(r.count)])
        ),
        thisMonth: {
          totalBatchesSubmitted: Number(totalBatches[0]?.count ?? 0),
        },
      });
    } catch (err) {
      logger.error({ err }, "failed to fetch batch stats");
      res.status(500).json({
        error: "Failed to fetch batch stats",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  return router;
}
