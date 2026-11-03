import { and, eq, inArray, sql } from "drizzle-orm";
import { pluginJobs, pluginJobRuns, type Db } from "@paperclipai/db";
import { pluginJobStore, type PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { parseCron, nextCronTick, validateCron } from "./cron.js";
import { trackIdleWork } from "./task-admission.js";
import { logger } from "../middleware/logger.js";

type Job = typeof pluginJobs.$inferSelect;
type Trigger = "schedule" | "manual" | "retry";
type Coordinator = ReturnType<typeof createDeliveryWorkCoordinator>;

export interface PluginJobSchedulerOptions {
  isBackgroundWorkEnabled?: () => boolean;
  db: Db;
  jobStore: PluginJobStore;
  workerManager: PluginWorkerManager;
  tickIntervalMs?: number;
  jobTimeoutMs?: number;
  settlementTimeoutMs?: number;
  maxConcurrentJobs?: number;
}
export interface TriggerJobResult { runId: string; jobId: string }
export interface SchedulerDiagnostics {
  running: boolean;
  activeJobCount: number;
  activeJobIds: string[];
  tickCount: number;
  lastTickAt: string | null;
}
export interface PluginJobScheduler {
  start(coordinator: Coordinator): Promise<void>;
  stop(): Promise<void>;
  registerPlugin(pluginId: string): Promise<void>;
  unregisterPlugin(pluginId: string): Promise<void>;
  triggerJob(jobId: string, trigger?: "manual" | "retry"): Promise<TriggerJobResult>;
  tick(signal?: AbortSignal): Promise<void>;
  diagnostics(): SchedulerDiagnostics;
}

function nextCron(schedule: string, now: Date): Date | null {
  return schedule && !validateCron(schedule) ? nextCronTick(parseCron(schedule), now) : null;
}

export function createPluginJobScheduler(options: PluginJobSchedulerOptions): PluginJobScheduler {
  const { db, jobStore, workerManager, tickIntervalMs = 30_000,
    jobTimeoutMs = 5 * 60_000, settlementTimeoutMs = 30_000, maxConcurrentJobs = 10 } = options;
  const log = logger.child({ service: "plugin-job-scheduler" });
  const activeJobs = new Set<string>();
  const pendingSettlements = new Map<string, { persist: () => Promise<void>; running?: Promise<void> }>();
  const inFlight = new Set<Promise<unknown>>();
  const subscriptions = new Map<string, () => void>();
  const unregistered = new Set<string>();
  let worker: ReturnType<typeof registerDeadlineWork> | undefined;
  let running = false;
  let next: number | null = null;
  let tickCount = 0;
  let lastTickAt: Date | null = null;
  let ticking: Promise<void> | undefined;
  const canRun = () => running && options.isBackgroundWorkEnabled?.() !== false;

  function track<T>(promise: Promise<T>): Promise<T> {
    const tracked = trackIdleWork(promise);
    inFlight.add(tracked);
    void tracked.then(() => inFlight.delete(tracked), () => inFlight.delete(tracked));
    return tracked;
  }

  async function settle(jobId: string) {
    const entry = pendingSettlements.get(jobId);
    if (!entry) return;
    entry.running ??= entry.persist().finally(() => { entry.running = undefined; });
    await entry.running;
    if (pendingSettlements.get(jobId) === entry) pendingSettlements.delete(jobId);
  }

  async function execute(job: Job, runId: string, trigger: Trigger) {
    const startedAt = Date.now();
    let error: string | undefined;
    try {
      await jobStore.markRunning(runId);
      await workerManager.call(job.pluginId, "runJob", {
        job: { jobKey: job.jobKey, runId, trigger,
          scheduledAt: (trigger === "schedule" ? job.nextRunAt! : new Date()).toISOString() },
      }, jobTimeoutMs);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.error({ jobId: job.id, runId, err }, "plugin job failed");
    }
    const finishedAt = new Date();
    pendingSettlements.set(job.id, { persist: () => db.transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout', ${String(settlementTimeoutMs)}, true)`);
      const store = pluginJobStore(tx);
      await store.completeRun(runId, {
        status: error === undefined ? "succeeded" : "failed", error,
        durationMs: finishedAt.getTime() - startedAt,
      });
      if (trigger === "schedule") {
        const [current] = await tx.select().from(pluginJobs).where(eq(pluginJobs.id, job.id)).for("update");
        if (current && current.schedule === job.schedule && current.nextRunAt?.getTime() === job.nextRunAt?.getTime()) {
          await store.updateRunTimestamps(job.id, finishedAt, nextCron(current.schedule, finishedAt));
        }
      }
    }) });
    try { await settle(job.id); }
    finally { activeJobs.delete(job.id); worker?.wake(); }
  }

  async function dispatch(job: Job, trigger: Trigger, signal?: AbortSignal): Promise<TriggerJobResult | null> {
    // Reserve synchronously at the one dispatch boundary. A refresh may have
    // yielded since filtering its snapshot; it cannot borrow a manual run's slot.
    if (activeJobs.has(job.id) || pendingSettlements.has(job.id)) {
      if (trigger !== "schedule") throw new Error(`Job "${job.jobKey}" is already running`);
      return null;
    }
    if (trigger === "schedule" && activeJobs.size >= maxConcurrentJobs) return null;
    activeJobs.add(job.id);
    try {
      const run = await db.transaction(async tx => {
        const [current] = await tx.select().from(pluginJobs).where(eq(pluginJobs.id, job.id)).for("update");
        if (!current || current.status !== "active" || signal?.aborted || !canRun() || unregistered.has(job.pluginId)
          || !workerManager.isRunning(job.pluginId)) return null;
        if (trigger === "schedule" && (current.schedule !== job.schedule
          || current.nextRunAt?.getTime() !== job.nextRunAt?.getTime())) return null;
        const [outstanding] = await tx.select({ id: pluginJobRuns.id }).from(pluginJobRuns).where(and(
          eq(pluginJobRuns.jobId, job.id), inArray(pluginJobRuns.status, ["pending", "queued", "running"]),
        )).limit(1);
        if (outstanding) return null;
        return pluginJobStore(tx).createRun({ jobId: job.id, pluginId: job.pluginId, trigger });
      });
      if (!run) {
        activeJobs.delete(job.id);
        worker?.wake();
        if (trigger !== "schedule") throw new Error(`Job "${job.jobKey}" is no longer available`);
        return null;
      }
      const completion = track(execute(job, run.id, trigger));
      void completion.catch(err => { log.error({ err, jobId: job.id }, "plugin job settlement deferred"); worker?.wake(); });
      return { runId: run.id, jobId: job.id };
    } catch (err) { activeJobs.delete(job.id); throw err; }
  }

  async function refresh(signal?: AbortSignal) {
    const settlements = await Promise.allSettled([...pendingSettlements.keys()].map(settle));
    const jobs = await db.select().from(pluginJobs).where(eq(pluginJobs.status, "active"));
    const runnable = jobs.filter(job => !unregistered.has(job.pluginId) && workerManager.isRunning(job.pluginId)
      && !activeJobs.has(job.id) && !pendingSettlements.has(job.id) && job.schedule && !validateCron(job.schedule));
    const outstanding = runnable.length === 0 ? [] : await db.select({ jobId: pluginJobRuns.jobId })
      .from(pluginJobRuns).where(and(inArray(pluginJobRuns.jobId, runnable.map(job => job.id)),
        inArray(pluginJobRuns.status, ["pending", "queued", "running"])));
    const blocked = new Set(outstanding.map(run => run.jobId));
    const now = new Date();
    const dispatches: Promise<unknown>[] = [];
    next = null;
    for (const job of runnable) {
      if (!canRun() || signal?.aborted) break;
      if (blocked.has(job.id) || activeJobs.has(job.id) || pendingSettlements.has(job.id)) continue;
      if (!job.nextRunAt) {
        const deadline = nextCron(job.schedule, now);
        if (!deadline) continue;
        await db.transaction(async tx => {
          const [current] = await tx.select().from(pluginJobs).where(eq(pluginJobs.id, job.id)).for("update");
          if (current && current.nextRunAt === null && current.schedule === job.schedule && current.status === "active") {
            await pluginJobStore(tx).updateRunTimestamps(job.id, current.lastRunAt ?? new Date(0), deadline);
          }
        });
        job.nextRunAt = deadline;
      }
      const at = job.nextRunAt.getTime();
      if (at <= now.getTime() && activeJobs.size < maxConcurrentJobs) {
        dispatches.push(dispatch(job, "schedule", signal));
      } else if (activeJobs.size < maxConcurrentJobs) {
        next = next === null ? at : Math.min(next, at);
      }
    }
    const results = await Promise.allSettled(dispatches);
    const failed = [...settlements, ...results].find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  function tick(signal?: AbortSignal): Promise<void> {
    if (!canRun()) return Promise.resolve();
    if (ticking) return ticking;
    tickCount++; lastTickAt = new Date();
    ticking = refresh(signal).finally(() => { ticking = undefined; });
    return ticking;
  }

  return {
    async start(coordinator) {
      if (worker) { await worker.ready; return; }
      running = true;
      worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.pluginSchedules, {
        run: tick, next: async () => next, canRun, retryMs: tickIntervalMs,
        notificationCoalesceMs: tickIntervalMs,
      });
      await worker.ready;
    },
    async stop() {
      running = false;
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      await Promise.allSettled([ticking]);
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      const results = await track(Promise.allSettled([...pendingSettlements.keys()].map(settle)));
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Plugin job completion persistence failed during shutdown");
    },
    async registerPlugin(pluginId) {
      unregistered.delete(pluginId);
      subscriptions.get(pluginId)?.();
      const handle = workerManager.getWorker(pluginId);
      if (handle) {
        const wake = () => worker?.wake();
        handle.on("status", wake);
        subscriptions.set(pluginId, () => handle.off("status", wake));
      }
      worker?.wake();
    },
    async unregisterPlugin(pluginId) {
      unregistered.add(pluginId);
      subscriptions.get(pluginId)?.(); subscriptions.delete(pluginId);
      worker?.wake();
      const runs = await db.select().from(pluginJobRuns).where(and(
        eq(pluginJobRuns.pluginId, pluginId), inArray(pluginJobRuns.status, ["pending", "queued", "running"]),
      ));
      for (const run of runs) {
        if (activeJobs.has(run.jobId) || pendingSettlements.has(run.jobId)) continue;
        await db.transaction(async tx => {
          const [current] = await tx.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, run.id)).for("update");
          // A completion may have committed after the discovery read. Never
          // overwrite its result, or the result still retained for persistence.
          if (!current || !["running", "queued", "pending"].includes(current.status)
            || activeJobs.has(current.jobId) || pendingSettlements.has(current.jobId)) return;
          await pluginJobStore(tx).completeRun(current.id, { status: "cancelled", error: "Plugin unregistered",
            durationMs: current.startedAt ? Date.now() - current.startedAt.getTime() : null });
        });
      }
    },
    triggerJob(jobId, trigger = "manual") {
      return track((async () => {
        if (!canRun()) throw new Error("Plugin job scheduler is not accepting work");
        const job = await jobStore.getJobById(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);
        if (job.status !== "active") throw new Error(`Job "${job.jobKey}" is not active (status: ${job.status})`);
        if (activeJobs.has(jobId) || pendingSettlements.has(jobId)) throw new Error(`Job "${job.jobKey}" is already running`);
        const runs = await db.select({ id: pluginJobRuns.id }).from(pluginJobRuns).where(and(
          eq(pluginJobRuns.jobId, jobId), inArray(pluginJobRuns.status, ["pending", "queued", "running"]),
        )).limit(1);
        if (runs.length) throw new Error(`Job "${job.jobKey}" already has a running execution`);
        if (unregistered.has(job.pluginId) || !workerManager.isRunning(job.pluginId)) throw new Error(`Worker for plugin "${job.pluginId}" is not running`);
        const result = await dispatch(job, trigger);
        if (!result) throw new Error(`Job "${job.jobKey}" is no longer available`);
        return result;
      })());
    },
    tick,
    diagnostics: () => ({ running, activeJobCount: activeJobs.size, activeJobIds: [...activeJobs], tickCount,
      lastTickAt: lastTickAt?.toISOString() ?? null }),
  };
}
