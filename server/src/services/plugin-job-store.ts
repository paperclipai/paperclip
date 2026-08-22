/**
 * Plugin Job Store — persistence layer for scheduled plugin jobs and their
 * execution history.
 *
 * This service manages the `plugin_jobs` and `plugin_job_runs` tables. It is
 * the server-side backing store for the `ctx.jobs` SDK surface exposed to
 * plugin workers.
 *
 * ## Responsibilities
 *
 * 1. **Sync job declarations** — When a plugin is installed or started, the
 *    host calls `syncJobDeclarations()` to upsert the manifest's declared jobs
 *    into the `plugin_jobs` table. Jobs removed from the manifest are marked
 *    `paused` (not deleted) to preserve history.
 *
 * 2. **Job CRUD** — List, get, pause, and resume jobs for a given plugin.
 *
 * 3. **Run lifecycle** — Create job run records, update their status, and
 *    record results (duration, errors, logs).
 *
 * 4. **Next-run calculation** — After a run completes the host should call
 *    `updateNextRunAt()` with the next cron tick so the scheduler knows when
 *    to fire next.
 *
 * 5. **Company fan-out set** — `listEnabledCompanyIds()` answers "which
 *    companies is this plugin enabled for", and `listFanOutCompanyIds()`
 *    orders that set least-recently-run-first for one job, so a fan-out wider
 *    than the scheduler's concurrency cap stays fair across occurrences.
 *
 * The capability check (`jobs.schedule`) is enforced upstream by the host
 * client factory and manifest validator — this store trusts that the caller
 * has already been authorised.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 * @see PLUGIN_SPEC.md §21.3 — `plugin_jobs` / `plugin_job_runs` tables
 */

import { and, asc, desc, eq, notExists, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  plugins,
  pluginCompanySettings,
  pluginJobs,
  pluginJobRuns,
} from "@paperclipai/db";
import type {
  PluginJobDeclaration,
  PluginJobRunStatus,
  PluginJobRunTrigger,
  PluginJobRecord,
  PluginJobScope,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

/**
 * The statuses used for job *definitions* in the `plugin_jobs` table.
 * Aliased from `PluginJobRecord` to keep the store API aligned with
 * the domain type (`"active" | "paused" | "failed"`).
 */
type JobDefinitionStatus = PluginJobRecord["status"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input for creating a job run record.
 */
export interface CreateJobRunInput {
  /** FK to the plugin_jobs row. */
  jobId: string;
  /** FK to the plugins row. */
  pluginId: string;
  /** What triggered this run. */
  trigger: PluginJobRunTrigger;
  /**
   * Company this run is scoped to, or `null`/omitted for an instance-scoped
   * run. `null` is the explicit instance marker — not "unknown".
   */
  companyId?: string | null;
}

/**
 * Input for completing (or failing) a job run.
 */
export interface CompleteJobRunInput {
  /** Final run status. */
  status: PluginJobRunStatus;
  /** Error message if the run failed. */
  error?: string | null;
  /** Run duration in milliseconds. */
  durationMs?: number | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Create a PluginJobStore backed by the given Drizzle database instance.
 *
 * @example
 * ```ts
 * const jobStore = pluginJobStore(db);
 *
 * // On plugin install/start — sync declared jobs into the DB
 * await jobStore.syncJobDeclarations(pluginId, manifest.jobs ?? []);
 *
 * // Before dispatching a runJob RPC — create a run record
 * const run = await jobStore.createRun({ jobId, pluginId, trigger: "schedule" });
 *
 * // After the RPC completes — record the result
 * await jobStore.completeRun(run.id, {
 *   status: "succeeded",
 *   durationMs: Date.now() - startedAt,
 * });
 * ```
 */
export function pluginJobStore(db: Db) {
  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * "Enabled for this company" per the opt-out semantic documented on
   * `plugin_company_settings`: no row means enabled, a row with
   * `enabled = false` means disabled. Non-`active` companies are excluded.
   */
  function enabledCompanyConditions(pluginId: string) {
    return [
      eq(companies.status, "active"),
      notExists(
        db
          .select({ one: pluginCompanySettings.id })
          .from(pluginCompanySettings)
          .where(
            and(
              eq(pluginCompanySettings.pluginId, pluginId),
              eq(pluginCompanySettings.companyId, companies.id),
              eq(pluginCompanySettings.enabled, false),
            ),
          ),
      ),
    ];
  }

  async function assertPluginExists(pluginId: string): Promise<void> {
    const rows = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(eq(plugins.id, pluginId));
    if (rows.length === 0) {
      throw notFound(`Plugin not found: ${pluginId}`);
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    // =====================================================================
    // Job declarations (plugin_jobs)
    // =====================================================================

    /**
     * Sync declared jobs from a plugin manifest into the `plugin_jobs` table.
     *
     * This is called at plugin install and on each worker startup so the DB
     * always reflects the manifest's declared jobs:
     *
     * - **New jobs** are inserted with status `active`.
     * - **Existing jobs** have their `schedule` updated if it changed.
     * - **Removed jobs** (present in DB but absent from the manifest) are
     *   set to `paused` so their history is preserved.
     *
     * The unique constraint `(pluginId, jobKey)` is used for conflict
     * resolution.
     *
     * @param pluginId - UUID of the owning plugin
     * @param declarations - Job declarations from the plugin manifest
     */
    async syncJobDeclarations(
      pluginId: string,
      declarations: PluginJobDeclaration[],
    ): Promise<void> {
      await assertPluginExists(pluginId);

      // Fetch existing jobs for this plugin
      const existingJobs = await db
        .select()
        .from(pluginJobs)
        .where(eq(pluginJobs.pluginId, pluginId));

      const existingByKey = new Map(
        existingJobs.map((j) => [j.jobKey, j]),
      );

      const declaredKeys = new Set<string>();

      // Upsert each declared job
      for (const decl of declarations) {
        declaredKeys.add(decl.jobKey);

        const existing = existingByKey.get(decl.jobKey);
        const schedule = decl.schedule ?? "";
        const scope: PluginJobScope = decl.scope ?? "instance";

        if (existing) {
          // Update schedule/scope if they changed; re-activate if it was paused
          const updates: Record<string, unknown> = {
            updatedAt: new Date(),
          };
          if (existing.schedule !== schedule) {
            updates.schedule = schedule;
          }
          if (existing.scope !== scope) {
            updates.scope = scope;
          }
          if (existing.status === "paused") {
            updates.status = "active";
          }

          await db
            .update(pluginJobs)
            .set(updates)
            .where(eq(pluginJobs.id, existing.id));
        } else {
          // Insert new job
          await db.insert(pluginJobs).values({
            pluginId,
            jobKey: decl.jobKey,
            schedule,
            scope,
            status: "active",
          });
        }
      }

      // Pause jobs that are no longer declared in the manifest
      for (const existing of existingJobs) {
        if (!declaredKeys.has(existing.jobKey) && existing.status !== "paused") {
          await db
            .update(pluginJobs)
            .set({ status: "paused", updatedAt: new Date() })
            .where(eq(pluginJobs.id, existing.id));
        }
      }
    },

    /**
     * List the companies a `scope: "company"` job should fan out to.
     *
     * Plugins are installed instance-wide, so "enabled for a company" is the
     * opt-out semantic documented on `plugin_company_settings`: a company is
     * in scope unless it has a row with `enabled = false`. Companies that are
     * not `active` (paused/suspended) are excluded — a paused company should
     * not have background work run against it.
     *
     * Ordered by id so membership checks are deterministic. For dispatch
     * ordering use {@link listFanOutCompanyIds}, which is fairness-ordered.
     *
     * @param pluginId - UUID of the plugin
     * @returns Company UUIDs, possibly empty
     */
    async listEnabledCompanyIds(pluginId: string): Promise<string[]> {
      const rows = await db
        .select({ id: companies.id })
        .from(companies)
        .where(and(...enabledCompanyConditions(pluginId)))
        .orderBy(asc(companies.id));

      return rows.map((row) => row.id);
    },

    /**
     * The same set as {@link listEnabledCompanyIds}, ordered
     * least-recently-run-first for one specific job.
     *
     * A job with more enabled companies than the scheduler's concurrency cap
     * cannot serve them all in one occurrence. That is capacity, not something
     * the scheduler can fix. What it *can* control is who gets left out and for
     * how long — and a stable ordering (by company id, say) is the worst
     * possible answer, because the same prefix wins every occurrence and the
     * tail never runs at all.
     *
     * Ordering by each company's most recent run **for this job**, with
     * never-run companies first, makes that fair without any in-process state:
     * serving a company moves it to the back. A company gets a second run only
     * after every company has had a first, new companies go straight to the
     * front, and — unlike a remembered cursor — this survives a restart,
     * because it is derived from `plugin_job_runs` rather than from memory.
     *
     * The ordering deliberately counts **attempts, not completions**: every run
     * row for the company, whatever its status, including one left `queued` or
     * `running` by a restart that killed the handler mid-occurrence. Counting
     * only terminal-successful runs would rank a company whose handler always
     * dies ahead of everyone else on every occurrence — it would take a slot
     * each time and never give it up, which is the starvation this ordering
     * exists to prevent. The cost is bounded and the opposite of a drop: an
     * interrupted company waits behind the companies queued ahead of it and is
     * reached on the following occurrence.
     *
     * @param pluginId - UUID of the plugin
     * @param jobId - UUID of the job whose run history orders the fan-out
     * @returns Company UUIDs, possibly empty
     */
    async listFanOutCompanyIds(pluginId: string, jobId: string): Promise<string[]> {
      const lastRunAt = sql<Date | null>`(
        select max(${pluginJobRuns.createdAt})
        from ${pluginJobRuns}
        where ${pluginJobRuns.jobId} = ${jobId}
          and ${pluginJobRuns.companyId} = ${companies.id}
      )`;

      const rows = await db
        .select({ id: companies.id })
        .from(companies)
        .where(and(...enabledCompanyConditions(pluginId)))
        .orderBy(sql`${lastRunAt} asc nulls first`, asc(companies.id));

      return rows.map((row) => row.id);
    },

    /**
     * List all jobs for a plugin, optionally filtered by status.
     *
     * @param pluginId - UUID of the owning plugin
     * @param status - Optional status filter
     */
    async listJobs(
      pluginId: string,
      status?: JobDefinitionStatus,
    ): Promise<(typeof pluginJobs.$inferSelect)[]> {
      const conditions = [eq(pluginJobs.pluginId, pluginId)];
      if (status) {
        conditions.push(eq(pluginJobs.status, status));
      }
      return db
        .select()
        .from(pluginJobs)
        .where(and(...conditions));
    },

    /**
     * Get a single job by its composite key `(pluginId, jobKey)`.
     *
     * @param pluginId - UUID of the owning plugin
     * @param jobKey - Stable job identifier from the manifest
     * @returns The job row, or `null` if not found
     */
    async getJobByKey(
      pluginId: string,
      jobKey: string,
    ): Promise<(typeof pluginJobs.$inferSelect) | null> {
      const rows = await db
        .select()
        .from(pluginJobs)
        .where(
          and(
            eq(pluginJobs.pluginId, pluginId),
            eq(pluginJobs.jobKey, jobKey),
          ),
        );
      return rows[0] ?? null;
    },

    /**
     * Get a single job by its primary key (UUID).
     *
     * @param jobId - UUID of the job row
     * @returns The job row, or `null` if not found
     */
    async getJobById(
      jobId: string,
    ): Promise<(typeof pluginJobs.$inferSelect) | null> {
      const rows = await db
        .select()
        .from(pluginJobs)
        .where(eq(pluginJobs.id, jobId));
      return rows[0] ?? null;
    },

    /**
     * Fetch a single job by ID, scoped to a specific plugin.
     *
     * Returns `null` if the job does not exist or does not belong to the
     * given plugin — callers should treat both cases as "not found".
     */
    async getJobByIdForPlugin(
      pluginId: string,
      jobId: string,
    ): Promise<(typeof pluginJobs.$inferSelect) | null> {
      const rows = await db
        .select()
        .from(pluginJobs)
        .where(and(eq(pluginJobs.id, jobId), eq(pluginJobs.pluginId, pluginId)));
      return rows[0] ?? null;
    },

    /**
     * Update a job's status.
     *
     * @param jobId - UUID of the job row
     * @param status - New status
     */
    async updateJobStatus(
      jobId: string,
      status: JobDefinitionStatus,
    ): Promise<void> {
      await db
        .update(pluginJobs)
        .set({ status, updatedAt: new Date() })
        .where(eq(pluginJobs.id, jobId));
    },

    /**
     * Update the `lastRunAt` and `nextRunAt` timestamps on a job.
     *
     * Called by the scheduler after a run completes to advance the
     * scheduling pointer.
     *
     * @param jobId - UUID of the job row
     * @param lastRunAt - When the last run started
     * @param nextRunAt - When the next run should fire
     */
    async updateRunTimestamps(
      jobId: string,
      lastRunAt: Date,
      nextRunAt: Date | null,
    ): Promise<void> {
      await db
        .update(pluginJobs)
        .set({
          lastRunAt,
          nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(pluginJobs.id, jobId));
    },

    /**
     * Delete all jobs (and cascaded runs) owned by a plugin.
     *
     * Called during plugin uninstall when `removeData = true`.
     *
     * @param pluginId - UUID of the owning plugin
     */
    async deleteAllJobs(pluginId: string): Promise<void> {
      await db
        .delete(pluginJobs)
        .where(eq(pluginJobs.pluginId, pluginId));
    },

    // =====================================================================
    // Job runs (plugin_job_runs)
    // =====================================================================

    /**
     * Create a new job run record with status `queued`.
     *
     * The caller should create the run record *before* dispatching the
     * `runJob` RPC to the worker, then update it to `running` once the
     * worker begins execution.
     *
     * @param input - Job run input (jobId, pluginId, trigger)
     * @returns The newly created run row
     */
    async createRun(
      input: CreateJobRunInput,
    ): Promise<typeof pluginJobRuns.$inferSelect> {
      const rows = await db
        .insert(pluginJobRuns)
        .values({
          jobId: input.jobId,
          pluginId: input.pluginId,
          companyId: input.companyId ?? null,
          trigger: input.trigger,
          status: "queued",
        })
        .returning();

      return rows[0]!;
    },

    /**
     * Mark a run as `running` and set its `startedAt` timestamp.
     *
     * @param runId - UUID of the run row
     */
    async markRunning(runId: string): Promise<void> {
      await db
        .update(pluginJobRuns)
        .set({
          status: "running" as PluginJobRunStatus,
          startedAt: new Date(),
        })
        .where(eq(pluginJobRuns.id, runId));
    },

    /**
     * Complete a run — set its final status, error, duration, and
     * `finishedAt` timestamp.
     *
     * @param runId - UUID of the run row
     * @param input - Completion details
     */
    async completeRun(
      runId: string,
      input: CompleteJobRunInput,
    ): Promise<void> {
      await db
        .update(pluginJobRuns)
        .set({
          status: input.status,
          error: input.error ?? null,
          durationMs: input.durationMs ?? null,
          finishedAt: new Date(),
        })
        .where(eq(pluginJobRuns.id, runId));
    },

    /**
     * Get a run by its primary key.
     *
     * @param runId - UUID of the run row
     * @returns The run row, or `null` if not found
     */
    async getRunById(
      runId: string,
    ): Promise<(typeof pluginJobRuns.$inferSelect) | null> {
      const rows = await db
        .select()
        .from(pluginJobRuns)
        .where(eq(pluginJobRuns.id, runId));
      return rows[0] ?? null;
    },

    /**
     * List runs for a specific job, ordered by creation time descending.
     *
     * @param jobId - UUID of the job
     * @param limit - Maximum number of rows to return (default: 50)
     */
    async listRunsByJob(
      jobId: string,
      limit = 50,
    ): Promise<(typeof pluginJobRuns.$inferSelect)[]> {
      return db
        .select()
        .from(pluginJobRuns)
        .where(eq(pluginJobRuns.jobId, jobId))
        .orderBy(desc(pluginJobRuns.createdAt))
        .limit(limit);
    },

    /**
     * List runs for a plugin, optionally filtered by status.
     *
     * @param pluginId - UUID of the owning plugin
     * @param status - Optional status filter
     * @param limit - Maximum number of rows to return (default: 50)
     */
    async listRunsByPlugin(
      pluginId: string,
      status?: PluginJobRunStatus,
      limit = 50,
    ): Promise<(typeof pluginJobRuns.$inferSelect)[]> {
      const conditions = [eq(pluginJobRuns.pluginId, pluginId)];
      if (status) {
        conditions.push(eq(pluginJobRuns.status, status));
      }
      return db
        .select()
        .from(pluginJobRuns)
        .where(and(...conditions))
        .orderBy(desc(pluginJobRuns.createdAt))
        .limit(limit);
    },
  };
}

/** Type alias for the return value of `pluginJobStore()`. */
export type PluginJobStore = ReturnType<typeof pluginJobStore>;
