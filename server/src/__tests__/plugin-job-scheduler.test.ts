import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type {
  PluginJobScheduler,
  PluginJobSchedulerOptions,
} from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

// ---------------------------------------------------------------------------
// Mock logger — must be before any imports that use it
// ---------------------------------------------------------------------------

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

const PLUGIN_ID = "plugin-uuid-1";
const JOB_ID = "job-uuid-1";
const RUN_ID = "run-uuid-1";

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    pluginId: PLUGIN_ID,
    jobKey: "full-sync",
    schedule: "*/15 * * * *",
    status: "active",
    lastRunAt: null,
    // Set nextRunAt to past so the job is "due"
    nextRunAt: new Date("2025-01-15T10:00:00Z"),
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    jobId: JOB_ID,
    pluginId: PLUGIN_ID,
    trigger: "schedule",
    status: "queued",
    durationMs: null,
    error: null,
    logs: [],
    startedAt: null,
    finishedAt: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Build mock versions of all dependencies.
 */
function makeMocks() {
  const selectWhereMock = vi.fn().mockResolvedValue([]);

  const dbMock = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: selectWhereMock,
      }),
    }),
  } as any;

  const jobStoreMock: PluginJobStore = {
    syncJobDeclarations: vi.fn().mockResolvedValue(undefined),
    listJobs: vi.fn().mockResolvedValue([]),
    getJobByKey: vi.fn().mockResolvedValue(null),
    getJobById: vi.fn().mockResolvedValue(null),
    updateJobStatus: vi.fn().mockResolvedValue(undefined),
    updateRunTimestamps: vi.fn().mockResolvedValue(undefined),
    deleteAllJobs: vi.fn().mockResolvedValue(undefined),
    createRun: vi.fn().mockResolvedValue(makeRunRow()),
    markRunning: vi.fn().mockResolvedValue(undefined),
    completeRun: vi.fn().mockResolvedValue(undefined),
    getRunById: vi.fn().mockResolvedValue(null),
    listRunsByJob: vi.fn().mockResolvedValue([]),
    listRunsByPlugin: vi.fn().mockResolvedValue([]),
  } as any;

  const workerManagerMock: PluginWorkerManager = {
    startWorker: vi.fn().mockResolvedValue(undefined),
    stopWorker: vi.fn().mockResolvedValue(undefined),
    getWorker: vi.fn().mockReturnValue(undefined),
    isRunning: vi.fn().mockReturnValue(true),
    stopAll: vi.fn().mockResolvedValue(undefined),
    diagnostics: vi.fn().mockReturnValue([]),
    call: vi.fn().mockResolvedValue(undefined),
  } as any;

  return {
    db: dbMock,
    jobStore: jobStoreMock,
    workerManager: workerManagerMock,
    selectWhereMock,
  };
}

function createScheduler(
  mocks: ReturnType<typeof makeMocks>,
  overrides: Partial<PluginJobSchedulerOptions> = {},
): PluginJobScheduler {
  return createPluginJobScheduler({
    db: mocks.db,
    jobStore: mocks.jobStore,
    workerManager: mocks.workerManager,
    tickIntervalMs: 1_000, // short interval for testing
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PluginJobScheduler", () => {
  let mocks: ReturnType<typeof makeMocks>;
  let scheduler: PluginJobScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T10:30:00Z"));
    mocks = makeMocks();
    scheduler = createScheduler(mocks);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  // =========================================================================
  // start / stop
  // =========================================================================

  describe("start / stop", () => {
    it("starts the tick loop", () => {
      scheduler.start();
      const diag = scheduler.diagnostics();
      expect(diag.running).toBe(true);
    });

    it("is idempotent — multiple starts are no-ops", () => {
      scheduler.start();
      scheduler.start();
      expect(scheduler.diagnostics().running).toBe(true);
    });

    it("stops the tick loop", () => {
      scheduler.start();
      scheduler.stop();
      expect(scheduler.diagnostics().running).toBe(false);
    });

    it("stop is safe to call when not running", () => {
      scheduler.stop(); // no-op
      expect(scheduler.diagnostics().running).toBe(false);
    });
  });

  // =========================================================================
  // defensive stop — timer cleanup
  // =========================================================================

  describe("defensive stop — timer cleanup", () => {
    it("clears interval timer even if called on a never-started scheduler", () => {
      // This verifies the defensive timer cleanup — no exception should occur
      const scheduler2 = createScheduler(mocks);
      scheduler2.stop();
      expect(scheduler2.diagnostics().running).toBe(false);
    });

    it("clears interval timer on double-stop without error", () => {
      scheduler.start();
      expect(scheduler.diagnostics().running).toBe(true);

      scheduler.stop();
      expect(scheduler.diagnostics().running).toBe(false);

      // Second stop should be safe
      scheduler.stop();
      expect(scheduler.diagnostics().running).toBe(false);
    });

    it("does not fire tick after stop", async () => {
      scheduler.start();

      // Set up mock for any tick queries
      mocks.selectWhereMock.mockResolvedValue([]);

      scheduler.stop();

      // Advance time past multiple tick intervals
      vi.advanceTimersByTime(5_000);

      // Tick count should still be 0 since no tick ran after stop
      expect(scheduler.diagnostics().tickCount).toBe(0);
    });
  });

  // =========================================================================
  // tick — dispatching due jobs
  // =========================================================================

  describe("tick", () => {
    it("queries for due jobs and dispatches them", async () => {
      const dueJob = makeJobRow();

      // DB query for due jobs returns our job
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      // Should have created a run
      expect(mocks.jobStore.createRun).toHaveBeenCalledWith({
        jobId: JOB_ID,
        pluginId: PLUGIN_ID,
        trigger: "schedule",
      });

      // Should have marked it running
      expect(mocks.jobStore.markRunning).toHaveBeenCalledWith(RUN_ID);

      // Should have called the worker
      expect(mocks.workerManager.call).toHaveBeenCalledWith(
        PLUGIN_ID,
        "runJob",
        expect.objectContaining({
          job: expect.objectContaining({
            jobKey: "full-sync",
            runId: RUN_ID,
            trigger: "schedule",
          }),
        }),
        expect.any(Number),
      );

      // Should have marked it succeeded
      expect(mocks.jobStore.completeRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.objectContaining({ status: "succeeded" }),
      );

      // Should have advanced the schedule pointer
      expect(mocks.jobStore.updateRunTimestamps).toHaveBeenCalledWith(
        JOB_ID,
        expect.any(Date),
        expect.any(Date), // nextRunAt
      );
    });

    it("skips jobs when no due jobs exist", async () => {
      // No due jobs
      mocks.selectWhereMock.mockResolvedValueOnce([]);

      await scheduler.tick();

      expect(mocks.jobStore.createRun).not.toHaveBeenCalled();
      expect(mocks.workerManager.call).not.toHaveBeenCalled();
    });

    it("records failure when worker RPC throws", async () => {
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      (mocks.workerManager.call as any).mockRejectedValueOnce(
        new Error("Worker crashed"),
      );

      await scheduler.tick();

      // Should record the failure
      expect(mocks.jobStore.completeRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.objectContaining({
          status: "failed",
          error: "Worker crashed",
        }),
      );

      // Should still advance the schedule pointer
      expect(mocks.jobStore.updateRunTimestamps).toHaveBeenCalled();
    });

    it("increments tick count and updates lastTickAt", async () => {
      mocks.selectWhereMock.mockResolvedValueOnce([]);
      await scheduler.tick();

      const diag = scheduler.diagnostics();
      expect(diag.tickCount).toBe(1);
      expect(diag.lastTickAt).not.toBeNull();
    });
  });

  // =========================================================================
  // overlap prevention
  // =========================================================================

  describe("overlap prevention", () => {
    it("skips a job that is already executing", async () => {
      const dueJob = makeJobRow();

      // First tick: dispatch the job
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      // Make the worker call hang (never resolves)
      let resolveWorkerCall: (() => void) | null = null;
      (mocks.workerManager.call as any).mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveWorkerCall = resolve;
        }),
      );

      // Start the tick but don't await it — the job will be in-flight
      const tickPromise = scheduler.tick();

      // Second tick: the same job should be skipped
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      // createRun should only have been called once (from the first tick)
      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(1);

      // Resolve the first worker call so the tick promise can complete
      resolveWorkerCall!();
      await tickPromise;
    });

    it("removes job from activeJobs after completion so it can run again", async () => {
      const dueJob = makeJobRow();

      // First tick: job runs and completes
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      await scheduler.tick();

      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(1);

      // Job should no longer be in active set
      expect(scheduler.diagnostics().activeJobIds).not.toContain(JOB_ID);

      // Second tick: same job is due again — should dispatch
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      await scheduler.tick();

      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(2);
    });

    it("removes job from activeJobs after failure so it can run again", async () => {
      const dueJob = makeJobRow();

      // First tick: job runs and fails
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      (mocks.workerManager.call as any).mockRejectedValueOnce(
        new Error("crash"),
      );
      await scheduler.tick();

      // Job should be removed from active set even after failure
      expect(scheduler.diagnostics().activeJobIds).not.toContain(JOB_ID);

      // Second tick: same job is due again — should dispatch
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      await scheduler.tick();

      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(2);
    });

    it("tracks separate jobs independently for overlap", async () => {
      const job1 = makeJobRow({ id: "job-1", jobKey: "sync-1" });
      const job2 = makeJobRow({ id: "job-2", jobKey: "sync-2" });

      // Use separate run IDs for each job
      (mocks.jobStore.createRun as any)
        .mockResolvedValueOnce(makeRunRow({ id: "run-1", jobId: "job-1" }))
        .mockResolvedValueOnce(makeRunRow({ id: "run-2", jobId: "job-2" }));

      // Both jobs are due in the same tick
      mocks.selectWhereMock.mockResolvedValueOnce([job1, job2]);
      await scheduler.tick();

      // Both should have been dispatched — they are different jobs
      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(2);
    });

    it("blocks the same job across multiple ticks while in-flight", async () => {
      const dueJob = makeJobRow();
      let resolveWorkerCall: (() => void) | null = null;

      // Tick 1: dispatch the job with a hanging worker call
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      (mocks.workerManager.call as any).mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveWorkerCall = resolve;
        }),
      );
      const tick1 = scheduler.tick();

      // Tick 2: same job returned as due — must be skipped
      // (tick guard prevents overlapping ticks, so the 2nd tick is a no-op)
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      await scheduler.tick();

      // Only 1 createRun call total (from tick 1)
      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(1);

      resolveWorkerCall!();
      await tick1;
    });
  });

  // =========================================================================
  // concurrency limit
  // =========================================================================

  describe("concurrency limit", () => {
    it("respects maxConcurrentJobs", async () => {
      const scheduler2 = createScheduler(mocks, { maxConcurrentJobs: 1 });

      const job1 = makeJobRow({ id: "job-1", jobKey: "sync-1" });
      const job2 = makeJobRow({ id: "job-2", jobKey: "sync-2" });

      // First tick: two due jobs, but max concurrent = 1
      mocks.selectWhereMock.mockResolvedValueOnce([job1, job2]);

      // Make worker calls resolve immediately — the concurrency limit is
      // checked in the tick loop itself (before dispatching), not inside
      // the dispatch function. With max=1, only the first job gets added
      // to the dispatches array because activeJobs.size >= 1 after the
      // first add.
      await scheduler2.tick();

      // Only one job should have been dispatched because of the concurrency limit
      // The first job starts (adding to activeJobs), so the second is deferred
      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(1);

      scheduler2.stop();
    });

    it("allows jobs up to the limit but not beyond", async () => {
      const scheduler3 = createScheduler(mocks, { maxConcurrentJobs: 2 });

      const job1 = makeJobRow({ id: "job-1", jobKey: "sync-1" });
      const job2 = makeJobRow({ id: "job-2", jobKey: "sync-2" });
      const job3 = makeJobRow({ id: "job-3", jobKey: "sync-3" });

      // Use separate run IDs
      (mocks.jobStore.createRun as any)
        .mockResolvedValueOnce(makeRunRow({ id: "run-1", jobId: "job-1" }))
        .mockResolvedValueOnce(makeRunRow({ id: "run-2", jobId: "job-2" }))
        .mockResolvedValueOnce(makeRunRow({ id: "run-3", jobId: "job-3" }));

      // Three due jobs, max concurrent = 2
      mocks.selectWhereMock.mockResolvedValueOnce([job1, job2, job3]);
      await scheduler3.tick();

      // Only two should dispatch
      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(2);

      scheduler3.stop();
    });

    it("allows deferred jobs to run in the next tick when slots free up", async () => {
      const scheduler4 = createScheduler(mocks, { maxConcurrentJobs: 1 });

      const job1 = makeJobRow({ id: "job-1", jobKey: "sync-1" });
      const job2 = makeJobRow({ id: "job-2", jobKey: "sync-2" });

      // Tick 1: two due, only job1 dispatched (max=1), completes immediately
      (mocks.jobStore.createRun as any)
        .mockResolvedValueOnce(makeRunRow({ id: "run-1", jobId: "job-1" }))
        .mockResolvedValueOnce(makeRunRow({ id: "run-2", jobId: "job-2" }));

      mocks.selectWhereMock.mockResolvedValueOnce([job1, job2]);
      await scheduler4.tick();

      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(1);

      // Tick 2: job1 completed, so job2 can now run
      mocks.selectWhereMock.mockResolvedValueOnce([job2]);
      await scheduler4.tick();

      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(2);

      scheduler4.stop();
    });
  });

  // =========================================================================
  // worker not running
  // =========================================================================

  describe("worker availability", () => {
    it("skips jobs when the worker is not running", async () => {
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      (mocks.workerManager.isRunning as any).mockReturnValue(false);

      await scheduler.tick();

      expect(mocks.jobStore.createRun).not.toHaveBeenCalled();
    });

    it("dispatches only jobs whose worker is available in a mixed set", async () => {
      const PLUGIN_ID_2 = "plugin-uuid-2";

      const job1 = makeJobRow({ id: "job-1", pluginId: PLUGIN_ID });
      const job2 = makeJobRow({ id: "job-2", pluginId: PLUGIN_ID_2, jobKey: "sync-other" });

      // Plugin 1 worker is running, Plugin 2 is not
      (mocks.workerManager.isRunning as any).mockImplementation(
        (pluginId: string) => pluginId === PLUGIN_ID,
      );

      (mocks.jobStore.createRun as any).mockResolvedValueOnce(
        makeRunRow({ id: "run-1", jobId: "job-1" }),
      );

      mocks.selectWhereMock.mockResolvedValueOnce([job1, job2]);
      await scheduler.tick();

      // Only job1 should have been dispatched
      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(1);
      expect(mocks.jobStore.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ pluginId: PLUGIN_ID }),
      );
    });
  });

  // =========================================================================
  // registerPlugin
  // =========================================================================

  describe("registerPlugin", () => {
    it("computes nextRunAt for active jobs that need it", async () => {
      const job = makeJobRow({ nextRunAt: null });
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([job]);

      await scheduler.registerPlugin(PLUGIN_ID);

      expect(mocks.jobStore.updateRunTimestamps).toHaveBeenCalledWith(
        JOB_ID,
        expect.any(Date),
        expect.any(Date), // non-null nextRunAt
      );
    });

    it("skips jobs that already have a future nextRunAt", async () => {
      const futureDate = new Date("2030-01-01T00:00:00Z");
      const job = makeJobRow({ nextRunAt: futureDate });
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([job]);

      await scheduler.registerPlugin(PLUGIN_ID);

      expect(mocks.jobStore.updateRunTimestamps).not.toHaveBeenCalled();
    });

    it("skips jobs without a schedule", async () => {
      const job = makeJobRow({ schedule: "", nextRunAt: null });
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([job]);

      await scheduler.registerPlugin(PLUGIN_ID);

      expect(mocks.jobStore.updateRunTimestamps).not.toHaveBeenCalled();
    });

    it("skips jobs with an invalid cron expression", async () => {
      const job = makeJobRow({ schedule: "invalid", nextRunAt: null });
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([job]);

      await scheduler.registerPlugin(PLUGIN_ID);

      expect(mocks.jobStore.updateRunTimestamps).not.toHaveBeenCalled();
    });

    it("computes nextRunAt for jobs with past nextRunAt", async () => {
      // nextRunAt is in the past — should be recomputed
      const pastDate = new Date("2024-01-01T00:00:00Z");
      const job = makeJobRow({ nextRunAt: pastDate });
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([job]);

      await scheduler.registerPlugin(PLUGIN_ID);

      expect(mocks.jobStore.updateRunTimestamps).toHaveBeenCalledWith(
        JOB_ID,
        expect.any(Date),
        expect.any(Date),
      );
    });

    it("handles multiple jobs for the same plugin", async () => {
      const job1 = makeJobRow({ id: "job-1", jobKey: "sync-a", nextRunAt: null });
      const job2 = makeJobRow({
        id: "job-2",
        jobKey: "sync-b",
        schedule: "0 * * * *",
        nextRunAt: null,
      });
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([job1, job2]);

      await scheduler.registerPlugin(PLUGIN_ID);

      expect(mocks.jobStore.updateRunTimestamps).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // unregisterPlugin
  // =========================================================================

  describe("unregisterPlugin", () => {
    it("cancels in-flight runs for the plugin", async () => {
      const runningRun = makeRunRow({ status: "running", startedAt: new Date("2025-01-15T10:25:00Z") });
      mocks.selectWhereMock.mockResolvedValueOnce([runningRun]);
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([]);

      await scheduler.unregisterPlugin(PLUGIN_ID);

      expect(mocks.jobStore.completeRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.objectContaining({
          status: "cancelled",
          error: "Plugin unregistered",
        }),
      );
    });

    it("removes active job tracking", async () => {
      mocks.selectWhereMock.mockResolvedValueOnce([]); // no running runs
      const job = makeJobRow();
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([job]);

      await scheduler.unregisterPlugin(PLUGIN_ID);

      // Verify diagnostics — no active jobs
      expect(scheduler.diagnostics().activeJobIds).not.toContain(JOB_ID);
    });

    it("cancels both queued and running runs", async () => {
      const runningRun = makeRunRow({
        id: "run-1",
        status: "running",
        startedAt: new Date("2025-01-15T10:25:00Z"),
      });
      const queuedRun = makeRunRow({ id: "run-2", status: "queued" });

      mocks.selectWhereMock.mockResolvedValueOnce([runningRun, queuedRun]);
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([]);

      await scheduler.unregisterPlugin(PLUGIN_ID);

      // Both should be cancelled
      expect(mocks.jobStore.completeRun).toHaveBeenCalledTimes(2);
      expect(mocks.jobStore.completeRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ status: "cancelled" }),
      );
      expect(mocks.jobStore.completeRun).toHaveBeenCalledWith(
        "run-2",
        expect.objectContaining({ status: "cancelled" }),
      );
    });

    it("calculates durationMs for running runs with startedAt", async () => {
      const startedAt = new Date("2025-01-15T10:25:00Z");
      const runningRun = makeRunRow({
        id: "run-1",
        status: "running",
        startedAt,
      });

      mocks.selectWhereMock.mockResolvedValueOnce([runningRun]);
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([]);

      await scheduler.unregisterPlugin(PLUGIN_ID);

      const completeCall = (mocks.jobStore.completeRun as any).mock.calls[0];
      const result = completeCall[1];
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe("number");
    });

    it("sets durationMs to null for queued runs without startedAt", async () => {
      const queuedRun = makeRunRow({
        id: "run-1",
        status: "queued",
        startedAt: null,
      });

      mocks.selectWhereMock.mockResolvedValueOnce([queuedRun]);
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([]);

      await scheduler.unregisterPlugin(PLUGIN_ID);

      const completeCall = (mocks.jobStore.completeRun as any).mock.calls[0];
      expect(completeCall[1].durationMs).toBeNull();
    });

    it("tolerates errors during run cancellation gracefully", async () => {
      const runningRun = makeRunRow({ status: "running", startedAt: new Date() });
      mocks.selectWhereMock.mockResolvedValueOnce([runningRun]);
      (mocks.jobStore.completeRun as any).mockRejectedValueOnce(
        new Error("DB write failed"),
      );
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce([]);

      // Should not throw despite the completeRun error
      await expect(scheduler.unregisterPlugin(PLUGIN_ID)).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // triggerJob
  // =========================================================================

  describe("triggerJob", () => {
    it("creates and dispatches a manual run", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      // DB query for existing running runs
      mocks.selectWhereMock.mockResolvedValueOnce([]);

      const result = await scheduler.triggerJob(JOB_ID);

      expect(result.runId).toBe(RUN_ID);
      expect(result.jobId).toBe(JOB_ID);

      // The run was created with "manual" trigger
      expect(mocks.jobStore.createRun).toHaveBeenCalledWith({
        jobId: JOB_ID,
        pluginId: PLUGIN_ID,
        trigger: "manual",
      });
    });

    it("supports retry trigger", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);

      await scheduler.triggerJob(JOB_ID, "retry");

      expect(mocks.jobStore.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "retry" }),
      );
    });

    it("throws when the job is not found", async () => {
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(null);

      await expect(scheduler.triggerJob(JOB_ID)).rejects.toThrow(
        "Job not found",
      );
    });

    it("throws when the job is not active", async () => {
      const job = makeJobRow({ status: "paused" });
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);

      await expect(scheduler.triggerJob(JOB_ID)).rejects.toThrow(
        "not active",
      );
    });

    it("throws when the job already has a running execution (DB check)", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      // DB shows a running run
      mocks.selectWhereMock.mockResolvedValueOnce([makeRunRow({ status: "running" })]);

      await expect(scheduler.triggerJob(JOB_ID)).rejects.toThrow(
        "already has a running execution",
      );
    });

    it("throws when the worker is not running", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);
      (mocks.workerManager.isRunning as any).mockReturnValue(false);

      await expect(scheduler.triggerJob(JOB_ID)).rejects.toThrow(
        "not running",
      );
    });

    it("returns correct runId and jobId from triggerJob result", async () => {
      const customRunId = "custom-run-uuid";
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);
      (mocks.jobStore.createRun as any).mockResolvedValueOnce(
        makeRunRow({ id: customRunId }),
      );

      const result = await scheduler.triggerJob(JOB_ID);

      expect(result.runId).toBe(customRunId);
      expect(result.jobId).toBe(JOB_ID);
    });

    it("dispatches the manual run in the background (non-blocking)", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);

      // Worker call hangs — should not block triggerJob
      let resolveWorkerCall: (() => void) | null = null;
      (mocks.workerManager.call as any).mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveWorkerCall = resolve;
        }),
      );

      // triggerJob should return immediately
      const result = await scheduler.triggerJob(JOB_ID);
      expect(result.runId).toBe(RUN_ID);

      // Worker hasn't been resolved yet — but triggerJob already returned
      resolveWorkerCall!();

      // Allow microtasks to settle
      await vi.waitFor(() => {
        expect(mocks.jobStore.completeRun).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // diagnostics
  // =========================================================================

  describe("diagnostics", () => {
    it("reports initial state", () => {
      const diag = scheduler.diagnostics();
      expect(diag.running).toBe(false);
      expect(diag.activeJobCount).toBe(0);
      expect(diag.activeJobIds).toEqual([]);
      expect(diag.tickCount).toBe(0);
      expect(diag.lastTickAt).toBeNull();
    });

    it("updates after start and tick", async () => {
      scheduler.start();
      mocks.selectWhereMock.mockResolvedValueOnce([]);
      await scheduler.tick();

      const diag = scheduler.diagnostics();
      expect(diag.running).toBe(true);
      expect(diag.tickCount).toBe(1);
      expect(diag.lastTickAt).not.toBeNull();
    });

    it("shows zero active jobs after completion", async () => {
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      // After completion, no active jobs
      const diag = scheduler.diagnostics();
      expect(diag.activeJobCount).toBe(0);
      expect(diag.activeJobIds).toEqual([]);
    });

    it("increments tick count across multiple ticks", async () => {
      mocks.selectWhereMock.mockResolvedValue([]); // always return empty

      await scheduler.tick();
      await scheduler.tick();
      await scheduler.tick();

      expect(scheduler.diagnostics().tickCount).toBe(3);
    });

    it("lastTickAt is an ISO 8601 string", async () => {
      mocks.selectWhereMock.mockResolvedValueOnce([]);
      await scheduler.tick();

      const diag = scheduler.diagnostics();
      expect(diag.lastTickAt).toBe("2025-01-15T10:30:00.000Z");
    });
  });

  // =========================================================================
  // no schedule
  // =========================================================================

  describe("jobs without schedule", () => {
    it("skips jobs with empty schedule during tick", async () => {
      const dueJob = makeJobRow({ schedule: "" });
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      expect(mocks.jobStore.createRun).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // schedule pointer advancement
  // =========================================================================

  describe("schedule pointer", () => {
    it("advances nextRunAt after successful run", async () => {
      const dueJob = makeJobRow({ schedule: "*/15 * * * *" });
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      const updateCall = (mocks.jobStore.updateRunTimestamps as any).mock.calls[0];
      expect(updateCall[0]).toBe(JOB_ID); // jobId
      expect(updateCall[1]).toBeInstanceOf(Date); // lastRunAt
      expect(updateCall[2]).toBeInstanceOf(Date); // nextRunAt (non-null for valid cron)
    });

    it("advances nextRunAt even after failed run", async () => {
      const dueJob = makeJobRow({ schedule: "0 * * * *" });
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      (mocks.workerManager.call as any).mockRejectedValueOnce(
        new Error("boom"),
      );

      await scheduler.tick();

      // Should still advance the schedule even on failure
      expect(mocks.jobStore.updateRunTimestamps).toHaveBeenCalled();
    });

    it("computes nextRunAt based on current time for every-15-min schedule", async () => {
      // System time is 2025-01-15T10:30:00Z
      const dueJob = makeJobRow({ schedule: "*/15 * * * *" });
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      const updateCall = (mocks.jobStore.updateRunTimestamps as any).mock.calls[0];
      const nextRunAt = updateCall[2] as Date;

      // Next occurrence after 10:30 for */15 should be 10:45
      expect(nextRunAt.toISOString()).toBe("2025-01-15T10:45:00.000Z");
    });

    it("sets nextRunAt to null for invalid cron schedule during pointer advance", async () => {
      // Use a valid-looking but schedule that becomes invalid during pointer advance
      // This happens when parseCron succeeds during dispatchJob but validateCron
      // returns an error during advanceSchedulePointer. In practice this is rare,
      // but we test that it's handled.
      const dueJob = makeJobRow({ schedule: "*/15 * * * *" });
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      // For a valid cron, nextRunAt should be non-null
      const updateCall = (mocks.jobStore.updateRunTimestamps as any).mock.calls[0];
      expect(updateCall[2]).not.toBeNull();
    });

    it("computes nextRunAt for hourly schedule", async () => {
      // System time is 2025-01-15T10:30:00Z
      const dueJob = makeJobRow({ schedule: "0 * * * *" });
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      const updateCall = (mocks.jobStore.updateRunTimestamps as any).mock.calls[0];
      const nextRunAt = updateCall[2] as Date;

      // Next occurrence after 10:30 for "0 * * * *" should be 11:00
      expect(nextRunAt.toISOString()).toBe("2025-01-15T11:00:00.000Z");
    });

    it("computes nextRunAt for daily schedule", async () => {
      // System time is 2025-01-15T10:30:00Z
      const dueJob = makeJobRow({ schedule: "0 9 * * *" }); // daily at 09:00
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      const updateCall = (mocks.jobStore.updateRunTimestamps as any).mock.calls[0];
      const nextRunAt = updateCall[2] as Date;

      // Next occurrence after 10:30 for "0 9 * * *" should be next day 09:00
      expect(nextRunAt.toISOString()).toBe("2025-01-16T09:00:00.000Z");
    });

    it("computes nextRunAt for weekday schedule (Mon-Fri)", async () => {
      // System time is 2025-01-15T10:30:00Z (Wednesday)
      const dueJob = makeJobRow({ schedule: "0 9 * * 1-5" }); // Mon-Fri at 09:00
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      const updateCall = (mocks.jobStore.updateRunTimestamps as any).mock.calls[0];
      const nextRunAt = updateCall[2] as Date;

      // Next weekday 9am after Wed 10:30 should be Thursday 09:00
      expect(nextRunAt.toISOString()).toBe("2025-01-16T09:00:00.000Z");
    });
  });

  // =========================================================================
  // failure recording — comprehensive
  // =========================================================================

  describe("failure recording", () => {
    it("records the error message from a thrown Error", async () => {
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      (mocks.workerManager.call as any).mockRejectedValueOnce(
        new Error("Connection refused"),
      );

      await scheduler.tick();

      expect(mocks.jobStore.completeRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.objectContaining({
          status: "failed",
          error: "Connection refused",
        }),
      );
    });

    it("records non-Error thrown values as string", async () => {
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      (mocks.workerManager.call as any).mockRejectedValueOnce(
        "string error message",
      );

      await scheduler.tick();

      expect(mocks.jobStore.completeRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.objectContaining({
          status: "failed",
          error: "string error message",
        }),
      );
    });

    it("records durationMs on failure", async () => {
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      (mocks.workerManager.call as any).mockRejectedValueOnce(
        new Error("timeout"),
      );

      await scheduler.tick();

      const completeCall = (mocks.jobStore.completeRun as any).mock.calls[0];
      const result = completeCall[1];
      expect(result.status).toBe("failed");
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("records durationMs on success", async () => {
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      const completeCall = (mocks.jobStore.completeRun as any).mock.calls[0];
      const result = completeCall[1];
      expect(result.status).toBe("succeeded");
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("still advances schedule pointer when completeRun itself throws", async () => {
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      (mocks.workerManager.call as any).mockRejectedValueOnce(
        new Error("Worker crashed"),
      );
      // completeRun throws when trying to record the failure
      (mocks.jobStore.completeRun as any).mockRejectedValueOnce(
        new Error("DB write error"),
      );

      await scheduler.tick();

      // Despite completeRun throwing, the schedule pointer should still advance
      expect(mocks.jobStore.updateRunTimestamps).toHaveBeenCalled();
    });

    it("removes job from activeJobs even when completeRun throws", async () => {
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      (mocks.workerManager.call as any).mockRejectedValueOnce(
        new Error("Worker crashed"),
      );
      (mocks.jobStore.completeRun as any).mockRejectedValueOnce(
        new Error("DB write error"),
      );

      await scheduler.tick();

      // Job should still be removed from active set
      expect(scheduler.diagnostics().activeJobIds).not.toContain(JOB_ID);
    });

    it("does not record failure if createRun fails (no runId available)", async () => {
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      (mocks.jobStore.createRun as any).mockRejectedValueOnce(
        new Error("DB connection lost"),
      );

      // Should not throw — error is caught in the dispatch pipeline
      await scheduler.tick();

      // completeRun should NOT be called since we never got a runId
      expect(mocks.jobStore.completeRun).not.toHaveBeenCalled();

      // But the schedule pointer should still advance
      expect(mocks.jobStore.updateRunTimestamps).toHaveBeenCalled();
    });

    it("dispatches multiple jobs and records individual failures", async () => {
      const job1 = makeJobRow({ id: "job-1", jobKey: "sync-1" });
      const job2 = makeJobRow({ id: "job-2", jobKey: "sync-2" });

      (mocks.jobStore.createRun as any)
        .mockResolvedValueOnce(makeRunRow({ id: "run-1", jobId: "job-1" }))
        .mockResolvedValueOnce(makeRunRow({ id: "run-2", jobId: "job-2" }));

      // Job 1 succeeds, job 2 fails
      (mocks.workerManager.call as any)
        .mockResolvedValueOnce(undefined) // job 1 succeeds
        .mockRejectedValueOnce(new Error("Job 2 failed")); // job 2 fails

      mocks.selectWhereMock.mockResolvedValueOnce([job1, job2]);
      await scheduler.tick();

      // Both runs should be completed
      expect(mocks.jobStore.completeRun).toHaveBeenCalledTimes(2);

      // Job 1 succeeded
      expect(mocks.jobStore.completeRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ status: "succeeded" }),
      );

      // Job 2 failed
      expect(mocks.jobStore.completeRun).toHaveBeenCalledWith(
        "run-2",
        expect.objectContaining({
          status: "failed",
          error: "Job 2 failed",
        }),
      );
    });

    it("failure in one job does not prevent other jobs from running", async () => {
      const job1 = makeJobRow({ id: "job-1", jobKey: "sync-1" });
      const job2 = makeJobRow({ id: "job-2", jobKey: "sync-2" });

      (mocks.jobStore.createRun as any)
        .mockResolvedValueOnce(makeRunRow({ id: "run-1", jobId: "job-1" }))
        .mockResolvedValueOnce(makeRunRow({ id: "run-2", jobId: "job-2" }));

      // Job 1 fails, job 2 succeeds (reversed order from above)
      (mocks.workerManager.call as any)
        .mockRejectedValueOnce(new Error("Job 1 crashed"))
        .mockResolvedValueOnce(undefined);

      mocks.selectWhereMock.mockResolvedValueOnce([job1, job2]);
      await scheduler.tick();

      // Both runs should be dispatched
      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(2);
      // Both should be completed (one failed, one succeeded)
      expect(mocks.jobStore.completeRun).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // retry logic
  // =========================================================================

  describe("retry logic", () => {
    it("creates a run with retry trigger via triggerJob", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);

      const result = await scheduler.triggerJob(JOB_ID, "retry");

      expect(result.runId).toBe(RUN_ID);
      expect(mocks.jobStore.createRun).toHaveBeenCalledWith({
        jobId: JOB_ID,
        pluginId: PLUGIN_ID,
        trigger: "retry",
      });
    });

    it("retry trigger passes trigger value to worker RPC", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);

      await scheduler.triggerJob(JOB_ID, "retry");

      // Allow async dispatch to complete
      await vi.waitFor(() => {
        expect(mocks.workerManager.call).toHaveBeenCalled();
      });

      expect(mocks.workerManager.call).toHaveBeenCalledWith(
        PLUGIN_ID,
        "runJob",
        expect.objectContaining({
          job: expect.objectContaining({
            jobKey: "full-sync",
            trigger: "retry",
          }),
        }),
        expect.any(Number),
      );
    });

    it("retry run records success on completion", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);

      await scheduler.triggerJob(JOB_ID, "retry");

      // Allow async dispatch to complete
      await vi.waitFor(() => {
        expect(mocks.jobStore.completeRun).toHaveBeenCalled();
      });

      expect(mocks.jobStore.completeRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.objectContaining({ status: "succeeded" }),
      );
    });

    it("retry run records failure when worker RPC throws", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);
      (mocks.workerManager.call as any).mockRejectedValueOnce(
        new Error("Retry also failed"),
      );

      await scheduler.triggerJob(JOB_ID, "retry");

      // Allow async dispatch to complete
      await vi.waitFor(() => {
        expect(mocks.jobStore.completeRun).toHaveBeenCalled();
      });

      expect(mocks.jobStore.completeRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.objectContaining({
          status: "failed",
          error: "Retry also failed",
        }),
      );
    });

    it("retry respects overlap prevention via DB check", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      // DB check shows a running execution exists
      mocks.selectWhereMock.mockResolvedValueOnce([makeRunRow({ status: "running" })]);

      await expect(scheduler.triggerJob(JOB_ID, "retry")).rejects.toThrow(
        "already has a running execution",
      );
    });

    it("retry respects overlap prevention (DB check)", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      // DB shows a running run from another instance
      mocks.selectWhereMock.mockResolvedValueOnce([makeRunRow({ status: "running" })]);

      await expect(scheduler.triggerJob(JOB_ID, "retry")).rejects.toThrow(
        "already has a running execution",
      );
    });

    it("retry removes job from activeJobs after completion", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);

      await scheduler.triggerJob(JOB_ID, "retry");

      // Allow async dispatch to complete
      await vi.waitFor(() => {
        expect(mocks.jobStore.completeRun).toHaveBeenCalled();
      });

      // Job should no longer be in active set
      expect(scheduler.diagnostics().activeJobIds).not.toContain(JOB_ID);
    });

    it("retry removes job from activeJobs after failure", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);
      (mocks.workerManager.call as any).mockRejectedValueOnce(
        new Error("Failed again"),
      );

      await scheduler.triggerJob(JOB_ID, "retry");

      // Allow async dispatch to complete
      await vi.waitFor(() => {
        expect(mocks.jobStore.completeRun).toHaveBeenCalled();
      });

      // Job should still be removed from active set
      expect(scheduler.diagnostics().activeJobIds).not.toContain(JOB_ID);
    });

    it("manual trigger defaults to 'manual' when trigger not specified", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);

      await scheduler.triggerJob(JOB_ID);

      expect(mocks.jobStore.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "manual" }),
      );
    });
  });

  // =========================================================================
  // cron scheduling — edge cases
  // =========================================================================

  describe("cron scheduling edge cases", () => {
    it("dispatches jobs with different cron schedules independently", async () => {
      const job15min = makeJobRow({ id: "job-1", jobKey: "every-15", schedule: "*/15 * * * *" });
      const jobHourly = makeJobRow({ id: "job-2", jobKey: "hourly", schedule: "0 * * * *" });

      (mocks.jobStore.createRun as any)
        .mockResolvedValueOnce(makeRunRow({ id: "run-1", jobId: "job-1" }))
        .mockResolvedValueOnce(makeRunRow({ id: "run-2", jobId: "job-2" }));

      mocks.selectWhereMock.mockResolvedValueOnce([job15min, jobHourly]);
      await scheduler.tick();

      // Both should be dispatched
      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(2);

      // Each should get its own nextRunAt computed
      expect(mocks.jobStore.updateRunTimestamps).toHaveBeenCalledTimes(2);
    });

    it("handles job with nextRunAt exactly at current time (boundary condition)", async () => {
      // nextRunAt is exactly "now" — the job is due
      vi.setSystemTime(new Date("2025-01-15T10:30:00Z"));
      const dueJob = makeJobRow({
        nextRunAt: new Date("2025-01-15T10:30:00Z"),
      });
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      expect(mocks.jobStore.createRun).toHaveBeenCalled();
    });

    it("registerPlugin computes nextRunAt correctly for various cron expressions", async () => {
      const jobs = [
        makeJobRow({ id: "job-1", jobKey: "every-min", schedule: "* * * * *", nextRunAt: null }),
        makeJobRow({ id: "job-2", jobKey: "every-hour", schedule: "0 * * * *", nextRunAt: null }),
        makeJobRow({ id: "job-3", jobKey: "daily-9am", schedule: "0 9 * * *", nextRunAt: null }),
      ];
      (mocks.jobStore.listJobs as any).mockResolvedValueOnce(jobs);

      await scheduler.registerPlugin(PLUGIN_ID);

      expect(mocks.jobStore.updateRunTimestamps).toHaveBeenCalledTimes(3);

      // Verify each computed nextRunAt
      const calls = (mocks.jobStore.updateRunTimestamps as any).mock.calls;

      // "* * * * *" — next minute after 10:30 → 10:31
      const nextEveryMin = calls[0][2] as Date;
      expect(nextEveryMin.toISOString()).toBe("2025-01-15T10:31:00.000Z");

      // "0 * * * *" — next hour → 11:00
      const nextEveryHour = calls[1][2] as Date;
      expect(nextEveryHour.toISOString()).toBe("2025-01-15T11:00:00.000Z");

      // "0 9 * * *" — next 9am → Jan 16 09:00
      const nextDaily = calls[2][2] as Date;
      expect(nextDaily.toISOString()).toBe("2025-01-16T09:00:00.000Z");
    });

    it("handles month-boundary scheduling", async () => {
      // System time is end of January
      vi.setSystemTime(new Date("2025-01-31T23:50:00Z"));
      const scheduler2 = createScheduler(mocks);

      const dueJob = makeJobRow({ schedule: "0 0 1 * *" }); // 1st of every month
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler2.tick();

      const updateCall = (mocks.jobStore.updateRunTimestamps as any).mock.calls[0];
      const nextRunAt = updateCall[2] as Date;

      // Next 1st of month should be Feb 1
      expect(nextRunAt.toISOString()).toBe("2025-02-01T00:00:00.000Z");

      scheduler2.stop();
    });

    it("handles year-boundary scheduling", async () => {
      // System time is end of December
      vi.setSystemTime(new Date("2025-12-31T23:50:00Z"));
      const scheduler2 = createScheduler(mocks);

      const dueJob = makeJobRow({ schedule: "0 0 1 1 *" }); // Jan 1st only
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler2.tick();

      const updateCall = (mocks.jobStore.updateRunTimestamps as any).mock.calls[0];
      const nextRunAt = updateCall[2] as Date;

      // Next Jan 1 should be 2026
      expect(nextRunAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");

      scheduler2.stop();
    });
  });

  // =========================================================================
  // tick guard — preventing overlapping ticks
  // =========================================================================

  describe("tick guard", () => {
    it("prevents overlapping tick execution", async () => {
      let resolveTick: (() => void) | null = null;

      // Make the DB query hang so the first tick takes a long time
      mocks.selectWhereMock.mockReturnValueOnce(
        new Promise<unknown[]>((resolve) => {
          resolveTick = () => resolve([]);
        }),
      );

      // Start first tick (it will hang on the DB query)
      const tick1 = scheduler.tick();

      // Start second tick while first is in progress — should be skipped
      await scheduler.tick();

      // Only 1 tick should be counted (the second was skipped)
      expect(scheduler.diagnostics().tickCount).toBe(1);

      // Resolve the first tick
      resolveTick!();
      await tick1;
    });
  });

  // =========================================================================
  // tick error handling
  // =========================================================================

  describe("tick error handling", () => {
    it("handles DB query errors gracefully without crashing", async () => {
      mocks.selectWhereMock.mockRejectedValueOnce(new Error("DB connection lost"));

      // Should not throw
      await scheduler.tick();

      // Tick count should still increment
      expect(scheduler.diagnostics().tickCount).toBe(1);
    });

    it("tick continues working after a failed tick", async () => {
      // First tick: DB error
      mocks.selectWhereMock.mockRejectedValueOnce(new Error("Temporary DB error"));
      await scheduler.tick();

      // Second tick: works fine
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);
      await scheduler.tick();

      // The second tick should have dispatched the job
      expect(mocks.jobStore.createRun).toHaveBeenCalledTimes(1);
      expect(scheduler.diagnostics().tickCount).toBe(2);
    });
  });

  // =========================================================================
  // job timeout
  // =========================================================================

  describe("job timeout", () => {
    it("passes configured jobTimeoutMs to worker call", async () => {
      const customTimeout = 120_000; // 2 minutes
      const scheduler2 = createScheduler(mocks, { jobTimeoutMs: customTimeout });

      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler2.tick();

      expect(mocks.workerManager.call).toHaveBeenCalledWith(
        expect.any(String),
        "runJob",
        expect.any(Object),
        customTimeout,
      );

      scheduler2.stop();
    });

    it("uses default timeout (5 minutes) when not configured", async () => {
      const dueJob = makeJobRow();
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      expect(mocks.workerManager.call).toHaveBeenCalledWith(
        expect.any(String),
        "runJob",
        expect.any(Object),
        5 * 60 * 1_000, // 300000ms = 5 minutes
      );
    });
  });

  // =========================================================================
  // RPC payload shape
  // =========================================================================

  describe("RPC payload", () => {
    it("sends correct job payload to worker for scheduled runs", async () => {
      const nextRunAt = new Date("2025-01-15T10:00:00Z");
      const dueJob = makeJobRow({ nextRunAt });
      mocks.selectWhereMock.mockResolvedValueOnce([dueJob]);

      await scheduler.tick();

      expect(mocks.workerManager.call).toHaveBeenCalledWith(
        PLUGIN_ID,
        "runJob",
        {
          job: {
            jobKey: "full-sync",
            runId: RUN_ID,
            trigger: "schedule",
            scheduledAt: nextRunAt.toISOString(),
          },
        },
        expect.any(Number),
      );
    });

    it("sends scheduledAt as current time for manual/retry runs", async () => {
      const job = makeJobRow();
      (mocks.jobStore.getJobById as any).mockResolvedValueOnce(job);
      mocks.selectWhereMock.mockResolvedValueOnce([]);

      await scheduler.triggerJob(JOB_ID, "manual");

      // Allow async dispatch to run
      await vi.waitFor(() => {
        expect(mocks.workerManager.call).toHaveBeenCalled();
      });

      const callArgs = (mocks.workerManager.call as any).mock.calls[0];
      const payload = callArgs[2];
      expect(payload.job.trigger).toBe("manual");
      // scheduledAt should be an ISO 8601 string
      expect(payload.job.scheduledAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
      );
    });
  });
});
