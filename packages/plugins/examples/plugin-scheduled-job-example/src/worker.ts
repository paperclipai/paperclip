import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const METRIC_HEARTBEAT = "scheduled_job_heartbeat_total";
const METRIC_DAILY_SUMMARY = "scheduled_job_daily_summary_total";
const STATE_LAST_HEARTBEAT = "last-heartbeat";
const STATE_LAST_DAILY_SUMMARY = "last-daily-summary";

/**
 * Scheduled Job Example Plugin worker.
 *
 * Registers handlers for the jobs declared in the manifest:
 * - heartbeat: every 5 minutes
 * - daily-summary: daily at 2:00
 *
 * Each run can be triggered by schedule, manual (UI/API), or retry.
 * Re-throwing marks the run as failed so the host can record and optionally retry.
 */
const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("heartbeat", async (job) => {
      ctx.logger.info("Heartbeat job run", {
        runId: job.runId,
        trigger: job.trigger,
        scheduledAt: job.scheduledAt,
      });

      try {
        const now = new Date().toISOString();
        await ctx.state.set(
          { scopeKind: "instance", stateKey: STATE_LAST_HEARTBEAT },
          now,
        );
        await ctx.metrics.write(METRIC_HEARTBEAT, 1);
      } catch (err) {
        ctx.logger.error("Heartbeat job failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });

    ctx.jobs.register("daily-summary", async (job) => {
      ctx.logger.info("Daily summary job run", {
        runId: job.runId,
        trigger: job.trigger,
        scheduledAt: job.scheduledAt,
      });

      try {
        const now = new Date().toISOString();
        await ctx.state.set(
          { scopeKind: "instance", stateKey: STATE_LAST_DAILY_SUMMARY },
          now,
        );
        await ctx.metrics.write(METRIC_DAILY_SUMMARY, 1);
      } catch (err) {
        ctx.logger.error("Daily summary job failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
  },

  async onHealth() {
    return { status: "ok", message: "Scheduled job example plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
