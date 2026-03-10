import { and, eq, lte, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyCronJobs } from "@paperclipai/db";
import { CronExpressionParser } from "cron-parser";
import { logger } from "../middleware/logger.js";
import type { heartbeatService } from "./heartbeat.js";

type HeartbeatService = ReturnType<typeof heartbeatService>;

function computeNextRun(cronExpr: string, timezone: string, after: Date): Date {
  const interval = CronExpressionParser.parse(cronExpr, {
    currentDate: after,
    tz: timezone,
  });
  return interval.next().toDate();
}

export function cronSchedulerService(db: Db, heartbeat: HeartbeatService) {

  async function tickCronJobs(now = new Date()) {
    const dueJobs = await db
      .select()
      .from(companyCronJobs)
      .where(
        and(
          eq(companyCronJobs.enabled, true),
          isNotNull(companyCronJobs.nextRunAt),
          lte(companyCronJobs.nextRunAt, now),
        ),
      );

    let checked = dueJobs.length;
    let enqueued = 0;
    let skipped = 0;

    for (const job of dueJobs) {
      try {
        const stagger = job.staggerMs > 0 ? Math.floor(Math.random() * job.staggerMs) : 0;
        const nextRunAt = computeNextRun(job.cronExpr, job.timezone, now);
        // Apply stagger to next_run_at
        const staggeredNextRun = new Date(nextRunAt.getTime() + stagger);

        await heartbeat.wakeup(job.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: `cron_job:${job.id}`,
          payload: job.payload,
          requestedByActorType: "system",
          requestedByActorId: "cron_scheduler",
          contextSnapshot: {
            source: "cron_scheduler",
            cronJobId: job.id,
            cronJobName: job.name,
            message: (job.payload as Record<string, unknown>).message ?? undefined,
            ...job.payload,
          },
        });

        await db
          .update(companyCronJobs)
          .set({
            nextRunAt: staggeredNextRun,
            lastRunAt: now,
            updatedAt: now,
          })
          .where(eq(companyCronJobs.id, job.id));

        enqueued += 1;
      } catch (err) {
        logger.warn({ err, cronJobId: job.id, cronJobName: job.name }, "cron job wakeup failed");

        // Update consecutive errors
        await db
          .update(companyCronJobs)
          .set({
            consecutiveErrors: job.consecutiveErrors + 1,
            lastRunStatus: "error",
            updatedAt: now,
            // Still advance next_run_at to avoid tight retry loops
            nextRunAt: computeNextRun(job.cronExpr, job.timezone, now),
          })
          .where(eq(companyCronJobs.id, job.id));

        skipped += 1;
      }
    }

    return { checked, enqueued, skipped };
  }

  async function initializeJobSchedules() {
    const jobs = await db
      .select()
      .from(companyCronJobs)
      .where(and(eq(companyCronJobs.enabled, true)));

    const now = new Date();
    let initialized = 0;

    for (const job of jobs) {
      if (job.nextRunAt) continue;

      try {
        const nextRunAt = computeNextRun(job.cronExpr, job.timezone, now);
        await db
          .update(companyCronJobs)
          .set({ nextRunAt, updatedAt: now })
          .where(eq(companyCronJobs.id, job.id));
        initialized += 1;
      } catch (err) {
        logger.warn({ err, cronJobId: job.id }, "failed to initialize cron job schedule");
      }
    }

    if (initialized > 0) {
      logger.info({ initialized }, "initialized cron job schedules");
    }
  }

  async function onRunCompleted(runId: string, status: string, durationMs: number) {
    // Find cron jobs that reference this run
    const jobs = await db
      .select()
      .from(companyCronJobs)
      .where(eq(companyCronJobs.lastRunId, runId));

    for (const job of jobs) {
      const isError = status !== "succeeded";
      await db
        .update(companyCronJobs)
        .set({
          lastRunStatus: status,
          lastRunDurationMs: durationMs,
          consecutiveErrors: isError ? job.consecutiveErrors + 1 : 0,
          updatedAt: new Date(),
        })
        .where(eq(companyCronJobs.id, job.id));
    }
  }

  async function listJobs(companyId: string, filters?: { agentId?: string; enabled?: boolean }) {
    const conditions = [eq(companyCronJobs.companyId, companyId)];
    if (filters?.agentId) {
      conditions.push(eq(companyCronJobs.agentId, filters.agentId));
    }
    if (filters?.enabled !== undefined) {
      conditions.push(eq(companyCronJobs.enabled, filters.enabled));
    }
    return db.select().from(companyCronJobs).where(and(...conditions));
  }

  async function getJob(id: string) {
    const rows = await db.select().from(companyCronJobs).where(eq(companyCronJobs.id, id));
    return rows[0] ?? null;
  }

  async function createJob(
    companyId: string,
    input: {
      agentId: string;
      name: string;
      description?: string | null;
      enabled?: boolean;
      cronExpr: string;
      timezone?: string;
      staggerMs?: number;
      payload?: Record<string, unknown>;
      createdBy?: string | null;
    },
  ) {
    const now = new Date();
    const timezone = input.timezone ?? "UTC";
    const enabled = input.enabled ?? true;
    let nextRunAt: Date | null = null;

    if (enabled) {
      try {
        nextRunAt = computeNextRun(input.cronExpr, timezone, now);
      } catch {
        throw new Error(`Invalid cron expression: ${input.cronExpr}`);
      }
    }

    // Validate the cron expression even if disabled
    try {
      CronExpressionParser.parse(input.cronExpr);
    } catch {
      throw new Error(`Invalid cron expression: ${input.cronExpr}`);
    }

    const rows = await db
      .insert(companyCronJobs)
      .values({
        companyId,
        agentId: input.agentId,
        name: input.name,
        description: input.description ?? null,
        enabled,
        cronExpr: input.cronExpr,
        timezone,
        staggerMs: input.staggerMs ?? 0,
        payload: input.payload ?? {},
        nextRunAt,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return rows[0]!;
  }

  async function updateJob(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      enabled?: boolean;
      cronExpr?: string;
      timezone?: string;
      staggerMs?: number;
      payload?: Record<string, unknown>;
    },
  ) {
    const existing = await getJob(id);
    if (!existing) return null;

    const now = new Date();
    const cronExpr = input.cronExpr ?? existing.cronExpr;
    const timezone = input.timezone ?? existing.timezone;
    const enabled = input.enabled ?? existing.enabled;

    // Validate cron expression if changed
    if (input.cronExpr) {
      try {
        CronExpressionParser.parse(input.cronExpr);
      } catch {
        throw new Error(`Invalid cron expression: ${input.cronExpr}`);
      }
    }

    // Recompute next_run_at if schedule or enabled state changed
    let nextRunAt = existing.nextRunAt;
    if (input.cronExpr || input.timezone || input.enabled !== undefined) {
      if (enabled) {
        nextRunAt = computeNextRun(cronExpr, timezone, now);
      } else {
        nextRunAt = null;
      }
    }

    const rows = await db
      .update(companyCronJobs)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.cronExpr !== undefined && { cronExpr: input.cronExpr }),
        ...(input.timezone !== undefined && { timezone: input.timezone }),
        ...(input.staggerMs !== undefined && { staggerMs: input.staggerMs }),
        ...(input.payload !== undefined && { payload: input.payload }),
        nextRunAt,
        updatedAt: now,
      })
      .where(eq(companyCronJobs.id, id))
      .returning();

    return rows[0] ?? null;
  }

  async function deleteJob(id: string) {
    const rows = await db
      .delete(companyCronJobs)
      .where(eq(companyCronJobs.id, id))
      .returning();
    return rows[0] ?? null;
  }

  async function triggerJobNow(id: string) {
    const job = await getJob(id);
    if (!job) return null;

    const now = new Date();

    const run = await heartbeat.wakeup(job.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: `cron_job:${job.id}`,
      payload: job.payload,
      requestedByActorType: "system",
      requestedByActorId: "cron_scheduler",
      contextSnapshot: {
        source: "cron_scheduler",
        cronJobId: job.id,
        cronJobName: job.name,
        message: (job.payload as Record<string, unknown>).message ?? undefined,
        triggeredManually: true,
        ...job.payload,
      },
    });

    // Update last run tracking (but don't change next_run_at)
    if (run) {
      await db
        .update(companyCronJobs)
        .set({
          lastRunAt: now,
          lastRunId: run.id,
          updatedAt: now,
        })
        .where(eq(companyCronJobs.id, job.id));
    }

    return { job, run };
  }

  return {
    tickCronJobs,
    initializeJobSchedules,
    onRunCompleted,
    listJobs,
    getJob,
    createJob,
    updateJob,
    deleteJob,
    triggerJobNow,
  };
}
