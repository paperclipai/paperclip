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
 * The capability check (`jobs.schedule`) is enforced upstream by the host
 * client factory and manifest validator — this store trusts that the caller
 * has already been authorised.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 * @see PLUGIN_SPEC.md §21.3 — `plugin_jobs` / `plugin_job_runs` tables
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai_dld/db";
import { plugins, pluginJobs, pluginJobRuns } from "@paperclipai_dld/db";
import type {
  PluginJobDeclaration,
  PluginJobRunStatus,
  PluginJobRunTrigger,
  PluginJobRecord,
} from "@paperclipai_dld/shared";
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

        if (existing) {
          // Update schedule if it changed; re-activate if it was paused
          const updates: Record<string, unknown> = {
            updatedAt: new Date(),
          };
          if (existing.schedule !== schedule) {
            updates.schedule = schedule;
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
