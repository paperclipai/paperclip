import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { shouldFireAt, validateCronExpression } from "./cron-match.js";

/**
 * Routine configuration — each entry maps a cron schedule to an agent prompt.
 */
interface Routine {
  name: string;
  cronExpression: string;
  agentId: string;
  companyId: string;
  prompt: string;
  enabled?: boolean;
}

/**
 * Agent Routines Plugin worker.
 *
 * Registers a single "routine-dispatcher" job handler. The host fires this
 * job every minute. On each tick, the handler reads the routines array from
 * the instance config, evaluates each enabled routine's cron expression
 * against the current time, and invokes matching agents with their prompt.
 *
 * Error isolation: individual routine failures are logged and counted but
 * never prevent other routines from firing in the same tick.
 */
const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("routine-dispatcher", async (job) => {
      const config = await ctx.config.get() as { routines?: Routine[] };
      const routines = config?.routines ?? [];
      const now = new Date(job.scheduledAt);

      let fired = 0;
      let skipped = 0;
      let errors = 0;

      for (const routine of routines) {
        if (routine.enabled === false) {
          skipped++;
          continue;
        }

        try {
          if (!shouldFireAt(routine.cronExpression, now)) continue;

          const result = await ctx.agents.invoke(routine.agentId, routine.companyId, {
            prompt: routine.prompt,
            reason: `Scheduled routine: ${routine.name}`,
          });

          await ctx.activity.log({
            companyId: routine.companyId,
            message: `Routine "${routine.name}" invoked agent ${routine.agentId} (run: ${result.runId})`,
            entityType: "agent",
            entityId: routine.agentId,
          });

          await ctx.metrics.write("routine_invocation_total", 1, {
            routine: routine.name,
            status: "success",
          });

          fired++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`Routine "${routine.name}" failed: ${message}`, {
            routine: routine.name,
            agentId: routine.agentId,
            error: message,
          });

          try {
            await ctx.activity.log({
              companyId: routine.companyId,
              message: `Routine "${routine.name}" failed to invoke agent ${routine.agentId}: ${message}`,
              entityType: "agent",
              entityId: routine.agentId,
            });

            await ctx.metrics.write("routine_invocation_total", 1, {
              routine: routine.name,
              status: "error",
            });
          } catch (telemetryErr) {
            ctx.logger.error(`Failed to write telemetry for routine "${routine.name}"`, {
              error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
            });
          }

          errors++;
        }
      }

      if (fired > 0 || errors > 0) {
        ctx.logger.info("Dispatcher tick complete", { fired, skipped, errors });
      }
    });
  },

  async onValidateConfig(config) {
    const routines = (config as { routines?: Routine[] })?.routines;
    if (!routines || !Array.isArray(routines)) return { ok: true };

    const errors: string[] = [];

    for (let i = 0; i < routines.length; i++) {
      const r = routines[i]!;
      const cronError = validateCronExpression(r.cronExpression);
      if (cronError) {
        errors.push(`Routine "${r.name ?? i}": invalid cron expression — ${cronError}`);
      }
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "Agent routines plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
