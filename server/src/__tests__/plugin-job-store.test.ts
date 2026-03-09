import { describe, expect, it, vi, beforeEach } from "vitest";
import { pluginJobStore } from "../services/plugin-job-store.js";
import type { PluginJobDeclaration } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-uuid-1",
    pluginId: "plugin-uuid-1",
    jobKey: "full-sync",
    schedule: "0 * * * *",
    status: "active",
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-uuid-1",
    jobId: "job-uuid-1",
    pluginId: "plugin-uuid-1",
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
 * Build a mock DB that tracks calls to select, insert, update, delete.
 *
 * The `selectResults` is a list of result arrays — each call to `.where()`
 * pops the next result off the list. If `selectResults` is empty, returns [].
 */
function makeMockDb(selectResults: unknown[][] = [[]]) {
  let selectCallIndex = 0;

  const setMock = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([]),
  });
  const updateMock = vi.fn().mockReturnValue({
    set: setMock,
  });

  const returningMock = vi.fn().mockImplementation(() => {
    // Return the values that were passed to .values() as a "created" row
    return Promise.resolve([makeRunRow()]);
  });
  const valuesMock = vi.fn().mockReturnValue({
    returning: returningMock,
    onConflictDoUpdate: vi.fn().mockResolvedValue([]),
  });
  const insertMock = vi.fn().mockReturnValue({
    values: valuesMock,
  });

  const deleteWhereMock = vi.fn().mockResolvedValue([]);
  const deleteMock = vi.fn().mockReturnValue({
    where: deleteWhereMock,
  });

  const limitMock = vi.fn().mockImplementation(() => {
    const idx = Math.min(selectCallIndex, selectResults.length - 1);
    return Promise.resolve(selectResults[idx] ?? []);
  });
  const orderByMock = vi.fn().mockReturnValue({
    limit: limitMock,
  });
  const selectWhereMock = vi.fn().mockImplementation(() => {
    const idx = selectCallIndex++;
    const result = selectResults[idx] ?? selectResults[selectResults.length - 1] ?? [];
    // Return an object that supports both chaining to .orderBy() and direct resolution
    const chainResult = Promise.resolve(result);
    (chainResult as any).orderBy = orderByMock;
    return chainResult;
  });
  const fromMock = vi.fn().mockReturnValue({
    where: selectWhereMock,
    orderBy: orderByMock,
  });
  const selectMock = vi.fn().mockReturnValue({
    from: fromMock,
  });

  return {
    db: {
      select: selectMock,
      insert: insertMock,
      update: updateMock,
      delete: deleteMock,
    },
    mocks: {
      selectMock,
      selectWhereMock,
      fromMock,
      insertMock,
      valuesMock,
      returningMock,
      updateMock,
      setMock,
      deleteMock,
      deleteWhereMock,
      orderByMock,
      limitMock,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pluginJobStore", () => {
  // =========================================================================
  // syncJobDeclarations
  // =========================================================================

  describe("syncJobDeclarations", () => {
    it("inserts new job declarations", async () => {
      // First select: plugin existence check (returns plugin)
      // Second select: existing jobs (empty — no jobs yet)
      const { db, mocks } = makeMockDb([
        [{ id: "plugin-uuid-1" }], // plugin exists
        [], // no existing jobs
      ]);

      const store = pluginJobStore(db as never);
      const declarations: PluginJobDeclaration[] = [
        {
          jobKey: "full-sync",
          displayName: "Full Sync",
          schedule: "0 * * * *",
        },
      ];

      await store.syncJobDeclarations("plugin-uuid-1", declarations);

      expect(mocks.insertMock).toHaveBeenCalled();
      expect(mocks.valuesMock).toHaveBeenCalled();
      const insertedValues = mocks.valuesMock.mock.calls[0][0];
      expect(insertedValues).toMatchObject({
        pluginId: "plugin-uuid-1",
        jobKey: "full-sync",
        schedule: "0 * * * *",
        status: "active",
      });
    });

    it("updates schedule for existing jobs", async () => {
      const existingJob = makeJobRow({ schedule: "0 * * * *" });

      const { db, mocks } = makeMockDb([
        [{ id: "plugin-uuid-1" }], // plugin exists
        [existingJob], // existing job
      ]);

      const store = pluginJobStore(db as never);
      const declarations: PluginJobDeclaration[] = [
        {
          jobKey: "full-sync",
          displayName: "Full Sync",
          schedule: "*/15 * * * *", // changed schedule
        },
      ];

      await store.syncJobDeclarations("plugin-uuid-1", declarations);

      // Should have called update, not insert
      expect(mocks.updateMock).toHaveBeenCalled();
    });

    it("re-activates paused jobs that are re-declared", async () => {
      const pausedJob = makeJobRow({ status: "paused", schedule: "0 * * * *" });

      const { db, mocks } = makeMockDb([
        [{ id: "plugin-uuid-1" }],
        [pausedJob],
      ]);

      const store = pluginJobStore(db as never);
      const declarations: PluginJobDeclaration[] = [
        {
          jobKey: "full-sync",
          displayName: "Full Sync",
          schedule: "0 * * * *",
        },
      ];

      await store.syncJobDeclarations("plugin-uuid-1", declarations);

      // Should have called update to re-activate
      expect(mocks.updateMock).toHaveBeenCalled();
      const setArg = mocks.setMock.mock.calls[0][0];
      expect(setArg.status).toBe("active");
    });

    it("pauses jobs that are removed from the manifest", async () => {
      const existingJob = makeJobRow({
        jobKey: "old-sync",
        status: "active",
      });

      const { db, mocks } = makeMockDb([
        [{ id: "plugin-uuid-1" }],
        [existingJob], // old-sync exists in DB
      ]);

      const store = pluginJobStore(db as never);
      // Declare an empty set — old-sync should be paused
      await store.syncJobDeclarations("plugin-uuid-1", []);

      expect(mocks.updateMock).toHaveBeenCalled();
      const setArg = mocks.setMock.mock.calls[0][0];
      expect(setArg.status).toBe("paused");
    });

    it("uses empty string for schedule when not specified", async () => {
      const { db, mocks } = makeMockDb([
        [{ id: "plugin-uuid-1" }],
        [],
      ]);

      const store = pluginJobStore(db as never);
      const declarations: PluginJobDeclaration[] = [
        {
          jobKey: "manual-only",
          displayName: "Manual Only Job",
          // No schedule — should default to ""
        },
      ];

      await store.syncJobDeclarations("plugin-uuid-1", declarations);

      const insertedValues = mocks.valuesMock.mock.calls[0][0];
      expect(insertedValues.schedule).toBe("");
    });

    it("throws when the plugin does not exist", async () => {
      const { db } = makeMockDb([
        [], // plugin not found
      ]);

      const store = pluginJobStore(db as never);
      await expect(
        store.syncJobDeclarations("nonexistent-id", []),
      ).rejects.toThrow();
    });

    it("handles multiple declarations in one call", async () => {
      const { db, mocks } = makeMockDb([
        [{ id: "plugin-uuid-1" }],
        [], // no existing jobs
      ]);

      const store = pluginJobStore(db as never);
      const declarations: PluginJobDeclaration[] = [
        { jobKey: "sync-a", displayName: "Sync A", schedule: "0 * * * *" },
        { jobKey: "sync-b", displayName: "Sync B", schedule: "0 0 * * *" },
      ];

      await store.syncJobDeclarations("plugin-uuid-1", declarations);

      // Should insert twice (once per declaration)
      expect(mocks.insertMock).toHaveBeenCalledTimes(2);
    });

    it("does not pause already-paused jobs", async () => {
      const alreadyPausedJob = makeJobRow({
        jobKey: "old-job",
        status: "paused",
      });

      const { db, mocks } = makeMockDb([
        [{ id: "plugin-uuid-1" }],
        [alreadyPausedJob],
      ]);

      const store = pluginJobStore(db as never);
      // Declare empty — old-job is already paused, should not update it
      await store.syncJobDeclarations("plugin-uuid-1", []);

      // No update call should have been made for already-paused job
      expect(mocks.updateMock).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // listJobs
  // =========================================================================

  describe("listJobs", () => {
    it("returns all jobs for a plugin", async () => {
      const jobs = [
        makeJobRow({ jobKey: "sync-a" }),
        makeJobRow({ jobKey: "sync-b", id: "job-uuid-2" }),
      ];
      const { db } = makeMockDb([jobs]);

      const store = pluginJobStore(db as never);
      const result = await store.listJobs("plugin-uuid-1");

      expect(result).toHaveLength(2);
    });

    it("returns empty array when no jobs exist", async () => {
      const { db } = makeMockDb([[]]);

      const store = pluginJobStore(db as never);
      const result = await store.listJobs("plugin-uuid-1");

      expect(result).toEqual([]);
    });

    it("accepts an optional status filter", async () => {
      const { db, mocks } = makeMockDb([[]]);

      const store = pluginJobStore(db as never);
      await store.listJobs("plugin-uuid-1", "active");

      expect(mocks.selectWhereMock).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // getJobByKey
  // =========================================================================

  describe("getJobByKey", () => {
    it("returns the job when found", async () => {
      const job = makeJobRow();
      const { db } = makeMockDb([[job]]);

      const store = pluginJobStore(db as never);
      const result = await store.getJobByKey("plugin-uuid-1", "full-sync");

      expect(result).toMatchObject({ jobKey: "full-sync" });
    });

    it("returns null when not found", async () => {
      const { db } = makeMockDb([[]]);

      const store = pluginJobStore(db as never);
      const result = await store.getJobByKey("plugin-uuid-1", "nonexistent");

      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // getJobById
  // =========================================================================

  describe("getJobById", () => {
    it("returns the job when found", async () => {
      const job = makeJobRow({ id: "specific-uuid" });
      const { db } = makeMockDb([[job]]);

      const store = pluginJobStore(db as never);
      const result = await store.getJobById("specific-uuid");

      expect(result).toMatchObject({ id: "specific-uuid" });
    });

    it("returns null when not found", async () => {
      const { db } = makeMockDb([[]]);

      const store = pluginJobStore(db as never);
      const result = await store.getJobById("missing-uuid");

      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // updateJobStatus
  // =========================================================================

  describe("updateJobStatus", () => {
    it("calls update with the correct status", async () => {
      const { db, mocks } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      await store.updateJobStatus("job-uuid-1", "paused");

      expect(mocks.updateMock).toHaveBeenCalledOnce();
      const setArg = mocks.setMock.mock.calls[0][0];
      expect(setArg.status).toBe("paused");
      expect(setArg.updatedAt).toBeInstanceOf(Date);
    });
  });

  // =========================================================================
  // updateRunTimestamps
  // =========================================================================

  describe("updateRunTimestamps", () => {
    it("updates lastRunAt and nextRunAt", async () => {
      const { db, mocks } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      const lastRunAt = new Date("2025-06-01T12:00:00Z");
      const nextRunAt = new Date("2025-06-01T13:00:00Z");
      await store.updateRunTimestamps("job-uuid-1", lastRunAt, nextRunAt);

      expect(mocks.updateMock).toHaveBeenCalledOnce();
      const setArg = mocks.setMock.mock.calls[0][0];
      expect(setArg.lastRunAt).toBe(lastRunAt);
      expect(setArg.nextRunAt).toBe(nextRunAt);
    });

    it("accepts null nextRunAt", async () => {
      const { db, mocks } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      await store.updateRunTimestamps("job-uuid-1", new Date(), null);

      const setArg = mocks.setMock.mock.calls[0][0];
      expect(setArg.nextRunAt).toBeNull();
    });
  });

  // =========================================================================
  // deleteAllJobs
  // =========================================================================

  describe("deleteAllJobs", () => {
    it("calls delete targeting the correct plugin", async () => {
      const { db, mocks } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      await store.deleteAllJobs("plugin-uuid-1");

      expect(mocks.deleteMock).toHaveBeenCalledOnce();
      expect(mocks.deleteWhereMock).toHaveBeenCalledOnce();
    });

    it("resolves to undefined on success", async () => {
      const { db } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      await expect(store.deleteAllJobs("plugin-uuid-1")).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // createRun
  // =========================================================================

  describe("createRun", () => {
    it("inserts a run with status queued", async () => {
      const { db, mocks } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      const run = await store.createRun({
        jobId: "job-uuid-1",
        pluginId: "plugin-uuid-1",
        trigger: "schedule",
      });

      expect(mocks.insertMock).toHaveBeenCalledOnce();
      expect(mocks.valuesMock).toHaveBeenCalledOnce();
      const insertedValues = mocks.valuesMock.mock.calls[0][0];
      expect(insertedValues).toMatchObject({
        jobId: "job-uuid-1",
        pluginId: "plugin-uuid-1",
        trigger: "schedule",
        status: "queued",
      });
      expect(run).toBeDefined();
    });

    it("supports manual trigger", async () => {
      const { db, mocks } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      await store.createRun({
        jobId: "job-uuid-1",
        pluginId: "plugin-uuid-1",
        trigger: "manual",
      });

      const insertedValues = mocks.valuesMock.mock.calls[0][0];
      expect(insertedValues.trigger).toBe("manual");
    });

    it("supports retry trigger", async () => {
      const { db, mocks } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      await store.createRun({
        jobId: "job-uuid-1",
        pluginId: "plugin-uuid-1",
        trigger: "retry",
      });

      const insertedValues = mocks.valuesMock.mock.calls[0][0];
      expect(insertedValues.trigger).toBe("retry");
    });
  });

  // =========================================================================
  // markRunning
  // =========================================================================

  describe("markRunning", () => {
    it("updates status to running and sets startedAt", async () => {
      const { db, mocks } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      const before = new Date();
      await store.markRunning("run-uuid-1");

      expect(mocks.updateMock).toHaveBeenCalledOnce();
      const setArg = mocks.setMock.mock.calls[0][0];
      expect(setArg.status).toBe("running");
      expect(setArg.startedAt).toBeInstanceOf(Date);
      expect(setArg.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  // =========================================================================
  // completeRun
  // =========================================================================

  describe("completeRun", () => {
    it("updates run with succeeded status and duration", async () => {
      const { db, mocks } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      await store.completeRun("run-uuid-1", {
        status: "succeeded",
        durationMs: 1500,
      });

      expect(mocks.updateMock).toHaveBeenCalledOnce();
      const setArg = mocks.setMock.mock.calls[0][0];
      expect(setArg.status).toBe("succeeded");
      expect(setArg.durationMs).toBe(1500);
      expect(setArg.error).toBeNull();
      expect(setArg.finishedAt).toBeInstanceOf(Date);
    });

    it("records error message on failure", async () => {
      const { db, mocks } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      await store.completeRun("run-uuid-1", {
        status: "failed",
        error: "Connection timeout",
        durationMs: 30000,
      });

      const setArg = mocks.setMock.mock.calls[0][0];
      expect(setArg.status).toBe("failed");
      expect(setArg.error).toBe("Connection timeout");
    });

    it("defaults error and durationMs to null when not provided", async () => {
      const { db, mocks } = makeMockDb([]);

      const store = pluginJobStore(db as never);
      await store.completeRun("run-uuid-1", {
        status: "cancelled",
      });

      const setArg = mocks.setMock.mock.calls[0][0];
      expect(setArg.error).toBeNull();
      expect(setArg.durationMs).toBeNull();
    });
  });

  // =========================================================================
  // getRunById
  // =========================================================================

  describe("getRunById", () => {
    it("returns the run when found", async () => {
      const run = makeRunRow({ id: "specific-run" });
      const { db } = makeMockDb([[run]]);

      const store = pluginJobStore(db as never);
      const result = await store.getRunById("specific-run");

      expect(result).toMatchObject({ id: "specific-run" });
    });

    it("returns null when not found", async () => {
      const { db } = makeMockDb([[]]);

      const store = pluginJobStore(db as never);
      const result = await store.getRunById("missing-run");

      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // listRunsByJob
  // =========================================================================

  describe("listRunsByJob", () => {
    it("returns runs for a given job", async () => {
      const runs = [
        makeRunRow({ id: "run-1" }),
        makeRunRow({ id: "run-2" }),
      ];
      const { db, mocks } = makeMockDb([runs]);

      // The listRunsByJob path uses orderBy → limit, not where directly
      mocks.limitMock.mockResolvedValue(runs);

      const store = pluginJobStore(db as never);
      const result = await store.listRunsByJob("job-uuid-1");

      expect(result).toHaveLength(2);
    });

    it("defaults limit to 50", async () => {
      const { db, mocks } = makeMockDb([[]]);
      mocks.limitMock.mockResolvedValue([]);

      const store = pluginJobStore(db as never);
      await store.listRunsByJob("job-uuid-1");

      expect(mocks.limitMock).toHaveBeenCalledWith(50);
    });

    it("accepts custom limit", async () => {
      const { db, mocks } = makeMockDb([[]]);
      mocks.limitMock.mockResolvedValue([]);

      const store = pluginJobStore(db as never);
      await store.listRunsByJob("job-uuid-1", 10);

      expect(mocks.limitMock).toHaveBeenCalledWith(10);
    });
  });

  // =========================================================================
  // listRunsByPlugin
  // =========================================================================

  describe("listRunsByPlugin", () => {
    it("returns runs for a given plugin", async () => {
      const runs = [makeRunRow()];
      const { db, mocks } = makeMockDb([runs]);
      mocks.limitMock.mockResolvedValue(runs);

      const store = pluginJobStore(db as never);
      const result = await store.listRunsByPlugin("plugin-uuid-1");

      expect(result).toHaveLength(1);
    });

    it("accepts optional status filter", async () => {
      const { db, mocks } = makeMockDb([[]]);
      mocks.limitMock.mockResolvedValue([]);

      const store = pluginJobStore(db as never);
      await store.listRunsByPlugin("plugin-uuid-1", "failed");

      // Should have queried with conditions
      expect(mocks.selectMock).toHaveBeenCalled();
    });

    it("defaults limit to 50", async () => {
      const { db, mocks } = makeMockDb([[]]);
      mocks.limitMock.mockResolvedValue([]);

      const store = pluginJobStore(db as never);
      await store.listRunsByPlugin("plugin-uuid-1");

      expect(mocks.limitMock).toHaveBeenCalledWith(50);
    });
  });

  // =========================================================================
  // Type export
  // =========================================================================

  describe("PluginJobStore type", () => {
    it("returns an object with all expected methods", () => {
      const { db } = makeMockDb([]);
      const store = pluginJobStore(db as never);

      expect(typeof store.syncJobDeclarations).toBe("function");
      expect(typeof store.listJobs).toBe("function");
      expect(typeof store.getJobByKey).toBe("function");
      expect(typeof store.getJobById).toBe("function");
      expect(typeof store.updateJobStatus).toBe("function");
      expect(typeof store.updateRunTimestamps).toBe("function");
      expect(typeof store.deleteAllJobs).toBe("function");
      expect(typeof store.createRun).toBe("function");
      expect(typeof store.markRunning).toBe("function");
      expect(typeof store.completeRun).toBe("function");
      expect(typeof store.getRunById).toBe("function");
      expect(typeof store.listRunsByJob).toBe("function");
      expect(typeof store.listRunsByPlugin).toBe("function");
    });
  });

  // =========================================================================
  // Ordering verification
  // =========================================================================

  describe("ordering", () => {
    it("listRunsByJob applies orderBy before limit", async () => {
      const { db, mocks } = makeMockDb([[]]);
      mocks.limitMock.mockResolvedValue([]);

      const store = pluginJobStore(db as never);
      await store.listRunsByJob("job-uuid-1");

      // orderBy should be called (which chains to limit)
      expect(mocks.orderByMock).toHaveBeenCalled();
      expect(mocks.limitMock).toHaveBeenCalledWith(50);
    });

    it("listRunsByPlugin applies orderBy before limit", async () => {
      const { db, mocks } = makeMockDb([[]]);
      mocks.limitMock.mockResolvedValue([]);

      const store = pluginJobStore(db as never);
      await store.listRunsByPlugin("plugin-uuid-1");

      expect(mocks.orderByMock).toHaveBeenCalled();
      expect(mocks.limitMock).toHaveBeenCalledWith(50);
    });

    it("listRunsByJob passes DESC ordering argument", async () => {
      const { db, mocks } = makeMockDb([[]]);
      mocks.limitMock.mockResolvedValue([]);

      const store = pluginJobStore(db as never);
      await store.listRunsByJob("job-uuid-1");

      // Verify orderBy received an argument (the desc() wrapper)
      expect(mocks.orderByMock.mock.calls[0].length).toBeGreaterThan(0);
    });

    it("listRunsByPlugin passes DESC ordering argument", async () => {
      const { db, mocks } = makeMockDb([[]]);
      mocks.limitMock.mockResolvedValue([]);

      const store = pluginJobStore(db as never);
      await store.listRunsByPlugin("plugin-uuid-1");

      // Verify orderBy received an argument (the desc() wrapper)
      expect(mocks.orderByMock.mock.calls[0].length).toBeGreaterThan(0);
    });
  });
});
