import { eq, and } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import type { Db } from "@paperclipai/db";
import { pluginJobs, pluginJobRuns } from "@paperclipai/db";
import type { ProcessManager } from "./process-manager.js";

/**
 * Calculate the next run time for a cron expression from a given base time.
 */
export function calculateNextRunAt(cronExpr: string, fromDate: Date): Date {
  const interval = CronExpressionParser.parse(cronExpr, { currentDate: fromDate });
  return interval.next().toDate();
}

/**
 * Determine whether a job should fire.
 */
export function shouldFireJob(
  now: Date,
  nextRunAt: Date | null,
  lastRunStatus: string | null,
): boolean {
  if (!nextRunAt) return false;
  if (now < nextRunAt) return false;
  if (lastRunStatus === "running") return false;
  return true;
}

/**
 * Job Scheduler — ticks periodically and fires due plugin jobs.
 */
export class JobScheduler {
  constructor(
    private db: Db,
    private processManager: ProcessManager,
  ) {}

  /**
   * Initialize all job next_run_at times from the current time.
   * Called on server startup.
   */
  async initializeJobTimes(): Promise<void> {
    const jobs = await this.db
      .select()
      .from(pluginJobs)
      .where(eq(pluginJobs.enabled, true));

    const now = new Date();
    for (const job of jobs) {
      const nextRunAt = calculateNextRunAt(job.cron, now);
      await this.db
        .update(pluginJobs)
        .set({ nextRunAt })
        .where(eq(pluginJobs.id, job.id));
    }
  }

  /**
   * Tick — check all enabled jobs and fire any that are due.
   * Called every 15 seconds from the server's interval loop.
   */
  async tick(): Promise<{ fired: number }> {
    const now = new Date();
    const jobs = await this.db
      .select()
      .from(pluginJobs)
      .where(eq(pluginJobs.enabled, true));

    let fired = 0;

    for (const job of jobs) {
      // Check if the previous run is still running
      const lastRun = await this.db
        .select({ status: pluginJobRuns.status })
        .from(pluginJobRuns)
        .where(
          and(
            eq(pluginJobRuns.jobId, job.id),
            eq(pluginJobRuns.status, "running"),
          ),
        )
        .limit(1);

      const lastRunStatus = lastRun[0]?.status ?? null;

      if (!shouldFireJob(now, job.nextRunAt, lastRunStatus)) continue;

      // Don't fire if worker is not ready
      if (!this.processManager.isReady(job.pluginId)) {
        console.warn(`[plugins:job-scheduler] skipping job ${job.jobKey} — worker not ready`);
        continue;
      }

      // Create run record
      const [run] = await this.db
        .insert(pluginJobRuns)
        .values({
          jobId: job.id,
          pluginId: job.pluginId,
          status: "running",
        })
        .returning({ id: pluginJobRuns.id });

      // Fire the job asynchronously
      this.fireJob(job.pluginId, job.id, job.jobKey, run.id, job.cron).catch((err) => {
        console.error(`[plugins:job-scheduler] error firing job ${job.jobKey}:`, err);
      });

      fired++;
    }

    return { fired };
  }

  private async fireJob(
    pluginId: string,
    jobId: string,
    jobKey: string,
    runId: string,
    cron: string,
  ): Promise<void> {
    try {
      await this.processManager.call(pluginId, "runJob", {
        jobKey,
        triggerSource: "schedule",
        runId,
      });

      // Mark completed
      const now = new Date();
      await this.db
        .update(pluginJobRuns)
        .set({ status: "completed", completedAt: now })
        .where(eq(pluginJobRuns.id, runId));

      // Update job timing
      await this.db
        .update(pluginJobs)
        .set({
          lastRunAt: now,
          nextRunAt: calculateNextRunAt(cron, now),
        })
        .where(eq(pluginJobs.id, jobId));
    } catch (err) {
      // Mark failed
      await this.db
        .update(pluginJobRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          error: err instanceof Error ? err.message : String(err),
        })
        .where(eq(pluginJobRuns.id, runId));

      // Still update next_run_at so we don't retry immediately
      await this.db
        .update(pluginJobs)
        .set({
          nextRunAt: calculateNextRunAt(cron, new Date()),
        })
        .where(eq(pluginJobs.id, jobId));
    }
  }
}
