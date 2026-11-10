import { pluginIdleManifestGeneration, type IdlePluginCatalogEntry } from "./plugin-idle-catalog.js";
import type { PluginJobDeclaration } from "@paperclipai/shared";
import { plugins, pluginJobs, type Db } from "@paperclipai/db";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { validateCron } from "./cron.js";
import { idleDeadlineRowLimit, isFutureIdleDeadline, type IdleDeadlineSnapshot } from "./idle-deadline-types.js";

type Job = typeof pluginJobs.$inferSelect;
type Plugin = typeof plugins.$inferSelect;
export type IdlePluginJobRow = { job: Job; plugin: Plugin | null; unsettled: boolean };
export function projectIdlePluginJobSchedule(rows: IdlePluginJobRow[], quietPluginIds: readonly string[], now: number, catalog: readonly IdlePluginCatalogEntry[] = []): IdleDeadlineSnapshot {
  const state: unknown[] = [];
  const deadlines: number[] = [];
  const blocked = () => ({ blocked: true, state, deadlines: [] });
  if (rows.length > idleDeadlineRowLimit) return blocked();
  const quiet = new Set(quietPluginIds);
  const catalogByPlugin = new Map(catalog.map(entry => [entry.pluginId, entry.manifestGeneration]));
  const manifests = new Map<string, string>();
  const declarationsByPlugin = new Map<string, Map<string, PluginJobDeclaration>>();
  if (catalogByPlugin.size !== catalog.length) return blocked();
  for (const { job, plugin, unsettled } of rows) {
    if (!["active", "paused"].includes(job.status) || unsettled !== false) return blocked();
    if (job.status === "paused") { state.push([job, unsettled]); continue; }
    if (!plugin || plugin.id !== job.pluginId || plugin.status !== "ready" || !quiet.has(plugin.id)) return blocked();
    let manifestGeneration = manifests.get(plugin.id);
    if (!manifestGeneration) {
      manifestGeneration = pluginIdleManifestGeneration(plugin.manifestJson);
      manifests.set(plugin.id, manifestGeneration);
    }
    if (plugin.manifestJson?.id !== plugin.pluginKey || plugin.manifestJson?.version !== plugin.version || plugin.manifestJson?.apiVersion !== plugin.apiVersion
      || catalogByPlugin.get(plugin.id) !== manifestGeneration) return blocked();
    state.push([job, [plugin.id, plugin.pluginKey, plugin.version, plugin.apiVersion, plugin.status, plugin.updatedAt, manifestGeneration], unsettled]);
    let declarations = declarationsByPlugin.get(plugin.id);
    if (!declarations) {
      const jobs = plugin.manifestJson?.jobs;
      if (!Array.isArray(jobs) || jobs.some(d => !d || typeof d.jobKey !== "string")) return blocked();
      declarations = new Map(jobs.map(d => [d.jobKey, d]));
      if (declarations.size !== jobs.length) return blocked();
      declarationsByPlugin.set(plugin.id, declarations);
    }
    const declaration = declarations.get(job.jobKey);
    if (!declaration) return blocked();
    if ((declaration.schedule ?? "") !== job.schedule) return blocked();
    if (!job.schedule && job.nextRunAt === null) continue;
    const at = job.nextRunAt?.getTime() ?? NaN;
    if (validateCron(job.schedule) || !isFutureIdleDeadline(at, now)) return blocked();
    deadlines.push(at);
  }
  return { blocked: false, state, deadlines };
}
export async function readIdlePluginJobSchedule(tx: Pick<Db, "select">, quietPluginIds: readonly string[], now: number, catalog: readonly IdlePluginCatalogEntry[] = []) {
  const rows = await tx.select({ job: getTableColumns(pluginJobs), plugin: getTableColumns(plugins),
    unsettled: sql<boolean>`EXISTS (SELECT 1 FROM plugin_job_runs r WHERE r.job_id = ${pluginJobs.id}
      AND (r.plugin_id <> ${pluginJobs.pluginId} OR r.status NOT IN ('succeeded', 'failed', 'cancelled') OR r.finished_at IS NULL))`,
  }).from(pluginJobs).leftJoin(plugins, eq(plugins.id, pluginJobs.pluginId)).orderBy(pluginJobs.id).limit(idleDeadlineRowLimit + 1);
  return projectIdlePluginJobSchedule(rows, quietPluginIds, now, catalog);
}
