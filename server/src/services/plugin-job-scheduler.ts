/**
 * PluginJobScheduler — tick-based scheduler for plugin scheduled jobs.
 *
 * The scheduler is the central coordinator for all plugin cron jobs. It
 * periodically ticks (default every 30 seconds), queries the `plugin_jobs`
 * table for jobs whose `nextRunAt` has passed, dispatches `runJob` RPC calls
 * to the appropriate worker processes, records each execution in the
 * `plugin_job_runs` table, and advances the scheduling pointer.
 *
 * ## Responsibilities
 *
 * 1. **Tick loop** — A `setInterval`-based loop fires every `tickIntervalMs`
 *    (default 30s). Each tick scans for due jobs and dispatches them.
 *
 * 2. **Cron parsing & next-run calculation** — Uses the lightweight built-in
 *    cron parser ({@link parseCron}, {@link nextCronTick}) to compute the
 *    `nextRunAt` timestamp after each run or when a new job is registered.
 *
 * 3. **Overlap prevention** — Before dispatching a job, the scheduler checks
 *    for an existing `running` run for the same job *and target*. If one
 *    exists, that target is skipped for the tick. For a company-scoped job the
 *    target is a company, so a slow run for one company does not hold up the
 *    others.
 *
 * 4. **Job run recording** — Every execution creates a `plugin_job_runs` row:
 *    `queued` → `running` → `succeeded` | `failed`. Duration and error are
 *    captured.
 *
 * 5. **Lifecycle integration** — The scheduler exposes `registerPlugin()` and
 *    `unregisterPlugin()` so the host lifecycle manager can wire up job
 *    scheduling when plugins start/stop. On registration, the scheduler
 *    computes `nextRunAt` for all active jobs that don't already have one.
 *
 * ## Company scope
 *
 * A job declared `scope: "company"` in the manifest fans out to one run per
 * company the plugin is enabled for, and each `runJob` call carries that
 * company's id. The worker manager turns that id into a host-minted invocation
 * scope, which is the *only* thing that authorizes company-scoped host calls
 * (`config.get`, `secrets.resolve`, `issues.*`, company `state.*`).
 *
 * A job left at the default `scope: "instance"` gets no company id and
 * therefore no invocation scope — every company-scoped host call it attempts
 * is refused with "company context is required". That is the intended
 * behavior, not a bug: an instance job has no tenant to act for.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 * @see ./plugin-job-store.ts — Persistence layer
 * @see ./cron.ts — Cron parsing utilities
 */

import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginJobs, pluginJobRuns } from "@paperclipai/db";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { parseCron, nextCronTick, validateCron } from "./cron.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default interval between scheduler ticks (30 seconds). */
const DEFAULT_TICK_INTERVAL_MS = 30_000;

/** Default timeout for a runJob RPC call (5 minutes). */
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1_000;

/** Maximum number of concurrent job executions across all plugins. */
const DEFAULT_MAX_CONCURRENT_JOBS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for creating a PluginJobScheduler.
 */
export interface PluginJobSchedulerOptions {
  /** Drizzle database instance. */
  db: Db;
  /** Persistence layer for jobs and runs. */
  jobStore: PluginJobStore;
  /** Worker process manager for RPC calls. */
  workerManager: PluginWorkerManager;
  /** Interval between scheduler ticks in ms (default: 30s). */
  tickIntervalMs?: number;
  /** Timeout for individual job RPC calls in ms (default: 5min). */
  jobTimeoutMs?: number;
  /** Maximum number of concurrent job executions (default: 10). */
  maxConcurrentJobs?: number;
}

/**
 * Result of a manual job trigger.
 */
export interface TriggerJobResult {
  /** The created run ID. */
  runId: string;
  /** The job ID that was triggered. */
  jobId: string;
  /** Company the run is scoped to, or `null` for an instance-scoped job. */
  companyId: string | null;
}

/**
 * Diagnostic information about the scheduler.
 */
export interface SchedulerDiagnostics {
  /** Whether the tick loop is running. */
  running: boolean;
  /**
   * Number of job *runs* currently executing. A company-scoped job with a
   * fan-out in flight contributes one per company.
   */
  activeJobCount: number;
  /** Distinct job IDs with at least one run in-flight. */
  activeJobIds: string[];
  /** Total number of ticks executed since start. */
  tickCount: number;
  /** Timestamp of the last tick (ISO 8601). */
  lastTickAt: string | null;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * The public interface of the job scheduler.
 */
export interface PluginJobScheduler {
  /**
   * Start the scheduler tick loop.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void;

  /**
   * Stop the scheduler tick loop.
   *
   * In-flight job runs are NOT cancelled — they are allowed to finish
   * naturally. The tick loop simply stops firing.
   */
  stop(): void;

  /**
   * Register a plugin with the scheduler.
   *
   * Computes `nextRunAt` for all active jobs that are missing it. This is
   * typically called after a plugin's worker process starts and
   * `syncJobDeclarations()` has been called.
   *
   * @param pluginId - UUID of the plugin
   */
  registerPlugin(pluginId: string): Promise<void>;

  /**
   * Unregister a plugin from the scheduler.
   *
   * Cancels any in-flight runs for the plugin and removes tracking state.
   *
   * @param pluginId - UUID of the plugin
   */
  unregisterPlugin(pluginId: string): Promise<void>;

  /**
   * Manually trigger a specific job (outside of the cron schedule).
   *
   * Creates a run with `trigger: "manual"` and dispatches immediately,
   * respecting the overlap prevention check.
   *
   * A company-scoped job must be triggered for exactly one company, and that
   * company must be one the plugin is enabled for — a manual trigger is not a
   * way to mint a scope the scheduler would never mint. An instance-scoped job
   * must be triggered with no company at all.
   *
   * @param jobId - UUID of the job to trigger
   * @param trigger - What triggered this run (default: "manual")
   * @param companyId - Company to run for; required iff the job is
   *   `scope: "company"`
   * @returns The created run info
   * @throws {Error} if the job is not found, not active, already running, or
   *   the company argument does not match the job's declared scope
   */
  triggerJob(
    jobId: string,
    trigger?: "manual" | "retry",
    companyId?: string | null,
  ): Promise<TriggerJobResult>;

  /**
   * Run a single scheduler tick immediately (for testing).
   *
   * @internal
   */
  tick(): Promise<void>;

  /**
   * Get diagnostic information about the scheduler state.
   */
  diagnostics(): SchedulerDiagnostics;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a new PluginJobScheduler.
 *
 * @example
 * ```ts
 * const scheduler = createPluginJobScheduler({
 *   db,
 *   jobStore,
 *   workerManager,
 * });
 *
 * // Start the tick loop
 * scheduler.start();
 *
 * // When a plugin comes online, register it
 * await scheduler.registerPlugin(pluginId);
 *
 * // Manually trigger a job
 * const { runId } = await scheduler.triggerJob(jobId);
 *
 * // On server shutdown
 * scheduler.stop();
 * ```
 */
export function createPluginJobScheduler(
  options: PluginJobSchedulerOptions,
): PluginJobScheduler {
  const {
    db,
    jobStore,
    workerManager,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS,
  } = options;

  const log = logger.child({ service: "plugin-job-scheduler" });

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  /** Timer handle for the tick loop. */
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the scheduler is running. */
  let running = false;

  /**
   * Keys of the job *runs* currently being executed, for overlap prevention.
   *
   * One entry per (job, target) — the target being a company for a
   * company-scoped job, or the instance for everything else. Keyed rather than
   * job-id'd so one slow company cannot stall the rest of the fan-out.
   */
  const activeRuns = new Set<string>();

  /** Overlap-prevention key for one (job, target) pair. */
  function runKey(jobId: string, companyId: string | null): string {
    return `${jobId}::${companyId ?? "instance"}`;
  }

  /** The in-flight run keys belonging to a job. */
  function activeRunKeysForJob(jobId: string): string[] {
    const prefix = `${jobId}::`;
    return [...activeRuns].filter((key) => key.startsWith(prefix));
  }


  /** Total number of ticks since start. */
  let tickCount = 0;

  /** Timestamp of the last tick. */
  let lastTickAt: Date | null = null;

  /** Guard against concurrent tick execution. */
  let tickInProgress = false;

  // -----------------------------------------------------------------------
  // Core: tick
  // -----------------------------------------------------------------------

  /**
   * A single scheduler tick. Queries for due jobs and dispatches them.
   */
  async function tick(): Promise<void> {
    // Prevent overlapping ticks (in case a tick takes longer than the interval)
    if (tickInProgress) {
      log.debug("skipping tick — previous tick still in progress");
      return;
    }

    tickInProgress = true;
    tickCount++;
    lastTickAt = new Date();

    try {
      const now = new Date();

      // Query for jobs whose nextRunAt has passed and are active.
      // We include jobs with null nextRunAt since they may have just been
      // registered and need their first run calculated.
      const dueJobs = await db
        .select()
        .from(pluginJobs)
        .where(
          and(
            eq(pluginJobs.status, "active"),
            lte(pluginJobs.nextRunAt, now),
          ),
        );

      if (dueJobs.length === 0) {
        return;
      }

      log.debug({ count: dueJobs.length }, "found due jobs");

      // Dispatch each due job (respecting concurrency limits)
      const dispatches: Promise<void>[] = [];

      for (const job of dueJobs) {
        // Concurrency limit
        if (activeRuns.size >= maxConcurrentJobs) {
          log.warn(
            { maxConcurrentJobs, activeJobCount: activeRuns.size },
            "max concurrent jobs reached, deferring remaining jobs",
          );
          break;
        }

        // Check if the worker is available
        if (!workerManager.isRunning(job.pluginId)) {
          log.debug(
            { jobId: job.id, pluginId: job.pluginId },
            "skipping job — worker not running",
          );
          continue;
        }

        // Validate cron expression before dispatching
        if (!job.schedule) {
          log.warn(
            { jobId: job.id, jobKey: job.jobKey },
            "skipping job — no schedule defined",
          );
          continue;
        }

        dispatches.push(dispatchJob(job));
      }

      if (dispatches.length > 0) {
        await Promise.allSettled(dispatches);
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "scheduler tick error",
      );
    } finally {
      tickInProgress = false;
    }
  }

  // -----------------------------------------------------------------------
  // Core: dispatch a single job
  // -----------------------------------------------------------------------

  /**
   * Resolve the companies one due job fires for on this tick, in the order
   * they should be admitted.
   *
   * An instance-scoped job has exactly one target: `null`, the instance.
   * A company-scoped job has one target per company the plugin is enabled
   * for — possibly none, on an instance with no companies — ordered
   * least-recently-run first so that a fan-out wider than
   * `maxConcurrentJobs` still reaches everyone. See
   * `plugin-job-store.listFanOutCompanyIds`.
   */
  async function resolveJobTargets(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<(string | null)[]> {
    if (job.scope !== "company") return [null];
    return jobStore.listFanOutCompanyIds(job.pluginId, job.id);
  }

  /**
   * Dispatch every run one due job produces this tick, then advance the
   * schedule pointer exactly once — the pointer belongs to the job row, not
   * to any individual company's run.
   */
  async function dispatchJob(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey, scope: job.scope });

    try {
      // Least-recently-run first, so the companies the cap turned away last
      // occurrence are at the front of this one.
      const targets = await resolveJobTargets(job);

      if (targets.length === 0) {
        jobLog.info(
          {},
          "company-scoped job has no enabled companies — nothing to dispatch",
        );
        return;
      }

      // Admit targets synchronously so a concurrent tick or manual trigger
      // cannot slip past the overlap check while we await below.
      const admitted: { companyId: string | null; key: string }[] = [];

      for (const [index, companyId] of targets.entries()) {
        const key = runKey(jobId, companyId);

        if (activeRuns.has(key)) {
          jobLog.debug(
            { companyId },
            "skipping run — already running (overlap prevention)",
          );
          continue;
        }

        if (activeRuns.size >= maxConcurrentJobs) {
          jobLog.warn(
            {
              maxConcurrentJobs,
              activeJobCount: activeRuns.size,
              deferredCount: targets.length - index,
              deferredFromCompanyId: companyId,
            },
            "max concurrent jobs reached — deferring the rest of the fan-out; "
              + "least-recently-run ordering puts these first next occurrence",
          );
          break;
        }

        activeRuns.add(key);
        admitted.push({ companyId, key });
      }

      if (admitted.length > 0) {
        await Promise.allSettled(
          admitted.map((target) =>
            dispatchScheduledRun(job, target.companyId, target.key),
          ),
        );
      }
    } catch (err) {
      jobLog.error(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to dispatch job",
      );
    } finally {
      // Always advance the schedule pointer (even on failure)
      try {
        await advanceSchedulePointer(job);
      } catch (err) {
        jobLog.error(
          { err: err instanceof Error ? err.message : String(err) },
          "failed to advance schedule pointer",
        );
      }
    }
  }

  /**
   * Dispatch one scheduled run — create the run record, call the worker, and
   * record the result. The caller has already reserved `key` in
   * {@link activeRuns}; this function releases it.
   */
  async function dispatchScheduledRun(
    job: typeof pluginJobs.$inferSelect,
    companyId: string | null,
    key: string,
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey, companyId });

    let runId: string | undefined;
    const startedAt = Date.now();

    try {
      // 1. Create run record
      const run = await jobStore.createRun({
        jobId,
        pluginId,
        companyId,
        trigger: "schedule",
      });
      runId = run.id;

      jobLog.info({ runId }, "dispatching scheduled job");

      // 2. Mark run as running
      await jobStore.markRunning(runId);

      // 3. Call worker via RPC. `companyId` is what the worker manager turns
      //    into the host-minted invocation scope for this run.
      await workerManager.call(
        pluginId,
        "runJob",
        {
          job: {
            jobKey,
            runId,
            trigger: "schedule" as const,
            scheduledAt: (job.nextRunAt ?? new Date()).toISOString(),
            companyId,
          },
        },
        jobTimeoutMs,
      );

      // 4. Mark run as succeeded
      const durationMs = Date.now() - startedAt;
      await jobStore.completeRun(runId, {
        status: "succeeded",
        durationMs,
      });

      jobLog.info({ runId, durationMs }, "job completed successfully");
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);

      jobLog.error(
        { runId, durationMs, err: errorMessage },
        "job execution failed",
      );

      // Record the failure
      if (runId) {
        try {
          await jobStore.completeRun(runId, {
            status: "failed",
            error: errorMessage,
            durationMs,
          });
        } catch (completeErr) {
          jobLog.error(
            {
              runId,
              err: completeErr instanceof Error ? completeErr.message : String(completeErr),
            },
            "failed to record job failure",
          );
        }
      }
    } finally {
      activeRuns.delete(key);
    }
  }

  // -----------------------------------------------------------------------
  // Core: manual trigger
  // -----------------------------------------------------------------------

  /**
   * Validate the caller's company argument against the job's declared scope
   * and return the company the run should be scoped to.
   *
   * A manual trigger must not be able to mint a scope the scheduler itself
   * would never mint, so a company-scoped job can only be triggered for a
   * company the plugin is actually enabled for.
   */
  async function resolveTriggerCompanyId(
    job: typeof pluginJobs.$inferSelect,
    companyId: string | null | undefined,
  ): Promise<string | null> {
    if (job.scope !== "company") {
      if (companyId) {
        throw new Error(
          `Job "${job.jobKey}" is instance-scoped — it cannot be triggered for a company`,
        );
      }
      return null;
    }

    if (!companyId) {
      throw new Error(
        `Job "${job.jobKey}" is company-scoped — a companyId is required to trigger it`,
      );
    }

    const enabled = await jobStore.listEnabledCompanyIds(job.pluginId);
    if (!enabled.includes(companyId)) {
      throw new Error(
        `Plugin "${job.pluginId}" is not enabled for company "${companyId}" — cannot trigger job "${job.jobKey}"`,
      );
    }

    return companyId;
  }

  async function triggerJob(
    jobId: string,
    trigger: "manual" | "retry" = "manual",
    companyId?: string | null,
  ): Promise<TriggerJobResult> {
    const job = await jobStore.getJobById(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== "active") {
      throw new Error(
        `Job "${job.jobKey}" is not active (status: ${job.status})`,
      );
    }

    const targetCompanyId = await resolveTriggerCompanyId(job, companyId);
    const key = runKey(jobId, targetCompanyId);

    // Overlap prevention
    if (activeRuns.has(key)) {
      throw new Error(
        `Job "${job.jobKey}" is already running — cannot trigger while in progress`,
      );
    }

    // Also check DB for running runs (defensive — covers multi-instance)
    const existingRuns = await db
      .select()
      .from(pluginJobRuns)
      .where(
        and(
          eq(pluginJobRuns.jobId, jobId),
          eq(pluginJobRuns.status, "running"),
          targetCompanyId
            ? eq(pluginJobRuns.companyId, targetCompanyId)
            : isNull(pluginJobRuns.companyId),
        ),
      );

    if (existingRuns.length > 0) {
      throw new Error(
        `Job "${job.jobKey}" already has a running execution — cannot trigger while in progress`,
      );
    }

    // Check worker availability
    if (!workerManager.isRunning(job.pluginId)) {
      throw new Error(
        `Worker for plugin "${job.pluginId}" is not running — cannot trigger job`,
      );
    }

    // Create the run and dispatch (non-blocking)
    const run = await jobStore.createRun({
      jobId,
      pluginId: job.pluginId,
      companyId: targetCompanyId,
      trigger,
    });

    // Reserve before returning — the background dispatch releases it.
    activeRuns.add(key);

    // Dispatch in background — don't block the caller
    void dispatchManualRun(job, run.id, trigger, targetCompanyId, key);

    return { runId: run.id, jobId, companyId: targetCompanyId };
  }

  /**
   * Dispatch a manually triggered job run. The caller has already reserved
   * `key` in {@link activeRuns}; this function releases it.
   */
  async function dispatchManualRun(
    job: typeof pluginJobs.$inferSelect,
    runId: string,
    trigger: "manual" | "retry",
    companyId: string | null,
    key: string,
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey, runId, trigger, companyId });

    const startedAt = Date.now();

    try {
      await jobStore.markRunning(runId);

      await workerManager.call(
        pluginId,
        "runJob",
        {
          job: {
            jobKey,
            runId,
            trigger,
            scheduledAt: new Date().toISOString(),
            companyId,
          },
        },
        jobTimeoutMs,
      );

      const durationMs = Date.now() - startedAt;
      await jobStore.completeRun(runId, {
        status: "succeeded",
        durationMs,
      });

      jobLog.info({ durationMs }, "manual job completed successfully");
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);
      jobLog.error({ durationMs, err: errorMessage }, "manual job failed");

      try {
        await jobStore.completeRun(runId, {
          status: "failed",
          error: errorMessage,
          durationMs,
        });
      } catch (completeErr) {
        jobLog.error(
          {
            err: completeErr instanceof Error ? completeErr.message : String(completeErr),
          },
          "failed to record manual job failure",
        );
      }
    } finally {
      activeRuns.delete(key);
    }
  }

  // -----------------------------------------------------------------------
  // Schedule pointer management
  // -----------------------------------------------------------------------

  /**
   * Advance the `lastRunAt` and `nextRunAt` timestamps on a job after a run.
   */
  async function advanceSchedulePointer(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<void> {
    const now = new Date();
    let nextRunAt: Date | null = null;

    if (job.schedule) {
      const validationError = validateCron(job.schedule);
      if (validationError) {
        log.warn(
          { jobId: job.id, schedule: job.schedule, error: validationError },
          "invalid cron schedule — cannot compute next run",
        );
      } else {
        const cron = parseCron(job.schedule);
        nextRunAt = nextCronTick(cron, now);
      }
    }

    await jobStore.updateRunTimestamps(job.id, now, nextRunAt);
  }

  /**
   * Ensure all active jobs for a plugin have a `nextRunAt` value.
   * Called when a plugin is registered with the scheduler.
   */
  async function ensureNextRunTimestamps(pluginId: string): Promise<void> {
    const jobs = await jobStore.listJobs(pluginId, "active");

    for (const job of jobs) {
      // Skip jobs that already have a valid nextRunAt in the future
      if (job.nextRunAt && job.nextRunAt.getTime() > Date.now()) {
        continue;
      }

      // Skip jobs without a schedule
      if (!job.schedule) {
        continue;
      }

      const validationError = validateCron(job.schedule);
      if (validationError) {
        log.warn(
          { jobId: job.id, jobKey: job.jobKey, schedule: job.schedule, error: validationError },
          "skipping job with invalid cron schedule",
        );
        continue;
      }

      const cron = parseCron(job.schedule);
      const nextRunAt = nextCronTick(cron, new Date());

      if (nextRunAt) {
        await jobStore.updateRunTimestamps(
          job.id,
          job.lastRunAt ?? new Date(0),
          nextRunAt,
        );
        log.debug(
          { jobId: job.id, jobKey: job.jobKey, nextRunAt: nextRunAt.toISOString() },
          "computed nextRunAt for job",
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Plugin registration
  // -----------------------------------------------------------------------

  async function registerPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "registering plugin with job scheduler");
    await ensureNextRunTimestamps(pluginId);
  }

  async function unregisterPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "unregistering plugin from job scheduler");

    // Cancel any in-flight run records for this plugin that are still
    // queued or running. Active jobs in-memory will finish naturally.
    try {
      const runningRuns = await db
        .select()
        .from(pluginJobRuns)
        .where(
          and(
            eq(pluginJobRuns.pluginId, pluginId),
            or(
              eq(pluginJobRuns.status, "running"),
              eq(pluginJobRuns.status, "queued"),
            ),
          ),
        );

      for (const run of runningRuns) {
        await jobStore.completeRun(run.id, {
          status: "cancelled",
          error: "Plugin unregistered",
          durationMs: run.startedAt
            ? Date.now() - run.startedAt.getTime()
            : null,
        });
      }
    } catch (err) {
      log.error(
        {
          pluginId,
          err: err instanceof Error ? err.message : String(err),
        },
        "error cancelling in-flight runs during unregister",
      );
    }

    // Remove any active tracking for jobs owned by this plugin
    const jobs = await jobStore.listJobs(pluginId);
    for (const job of jobs) {
      for (const key of activeRunKeysForJob(job.id)) {
        activeRuns.delete(key);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle: start / stop
  // -----------------------------------------------------------------------

  function start(): void {
    if (running) {
      log.debug("scheduler already running");
      return;
    }

    running = true;
    tickTimer = setInterval(() => {
      void tick();
    }, tickIntervalMs);

    log.info(
      { tickIntervalMs, maxConcurrentJobs },
      "plugin job scheduler started",
    );
  }

  function stop(): void {
    // Always clear the timer defensively, even if `running` is already false,
    // to prevent leaked interval timers.
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }

    if (!running) return;
    running = false;

    log.info(
      { activeJobCount: activeRuns.size },
      "plugin job scheduler stopped",
    );
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  function diagnostics(): SchedulerDiagnostics {
    return {
      running,
      activeJobCount: activeRuns.size,
      activeJobIds: [...new Set([...activeRuns].map((key) => key.slice(0, key.indexOf("::"))))],
      tickCount,
      lastTickAt: lastTickAt?.toISOString() ?? null,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    start,
    stop,
    registerPlugin,
    unregisterPlugin,
    triggerJob,
    tick,
    diagnostics,
  };
}
