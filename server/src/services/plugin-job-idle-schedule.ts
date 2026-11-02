import { plugins, pluginJobs, type Db } from "@paperclipai/db";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { validateCron } from "./cron.js";
import { idleDeadlineRowLimit, isFutureIdleDeadline, type IdleDeadlineSnapshot } from "./idle-deadline-types.js";

type Job = typeof pluginJobs.$inferSelect;
type Plugin = typeof plugins.$inferSelect;
export type IdlePluginJobRow = { job: Job; plugin: Plugin | null; unsettled: boolean };
export function projectIdlePluginJobSchedule(rows: IdlePluginJobRow[], quietPluginIds: readonly string[], now: number): IdleDeadlineSnapshot {
  const state = rows;
  const deadlines: number[] = [];
  const blocked = () => ({ blocked: true, state, deadlines: [] });
  if (rows.length > idleDeadlineRowLimit) return blocked();
  const quiet = new Set(quietPluginIds);
  for (const { job, plugin, unsettled } of rows) {
    if (!["active", "paused"].includes(job.status) || unsettled !== false) return blocked();
    if (job.status === "paused") continue;
    if (!plugin || plugin.id !== job.pluginId || plugin.status !== "ready" || !quiet.has(plugin.id)) return blocked();
    const declarations = plugin.manifestJson?.jobs;
    if (!Array.isArray(declarations) || declarations.filter(d => d.jobKey === job.jobKey).length !== 1) return blocked();
    const declaration = declarations.find(d => d.jobKey === job.jobKey)!;
    if ((declaration.schedule ?? "") !== job.schedule) return blocked();
    // An explicitly unscheduled declaration is manual-only, not a missing timer.
    if (!job.schedule && job.nextRunAt === null) continue;
    const at = job.nextRunAt?.getTime() ?? NaN;
    if (validateCron(job.schedule) || !isFutureIdleDeadline(at, now)) return blocked();
    deadlines.push(at);
  }
  return { blocked: false, state, deadlines };
}
export async function readIdlePluginJobSchedule(tx: Pick<Db, "select">, quietPluginIds: readonly string[], now: number) {
  const rows = await tx.select({ job: getTableColumns(pluginJobs), plugin: getTableColumns(plugins),
    unsettled: sql<boolean>`EXISTS (SELECT 1 FROM plugin_job_runs r WHERE r.job_id = ${pluginJobs.id}
      AND (r.plugin_id <> ${pluginJobs.pluginId} OR r.status NOT IN ('succeeded', 'failed', 'cancelled') OR r.finished_at IS NULL))`,
  }).from(pluginJobs).leftJoin(plugins, eq(plugins.id, pluginJobs.pluginId)).orderBy(pluginJobs.id).limit(idleDeadlineRowLimit + 1);
  return projectIdlePluginJobSchedule(rows, quietPluginIds, now);
}
