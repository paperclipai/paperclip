import { describe, it, expect, vi, beforeEach } from "vitest";
import { StateMachine } from "../state-machine.js";

function createMockDb(namespace: string) {
  return {
    namespace,
    query: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

describe("state-machine", () => {
  let db: ReturnType<typeof createMockDb>;
  let sm: StateMachine;

  beforeEach(() => {
    db = createMockDb("plugin_pipeline_engine_abc123");
    sm = new StateMachine(db);
  });

  describe("createRun", () => {
    it("inserts a pipeline run record", async () => {
      await sm.createRun({
        id: "run-1",
        companyId: "company-1",
        parentIssueId: "issue-1",
        pipelineName: "feature",
        pipelineVersion: 1,
        pipelineYaml: "yaml-content",
      });
      expect(db.execute).toHaveBeenCalledOnce();
      const sql = db.execute.mock.calls[0][0] as string;
      expect(sql).toContain("pipeline_runs");
      expect(sql).toContain("INSERT");
    });
  });

  describe("updateRunStatus", () => {
    it("updates the run status", async () => {
      await sm.updateRunStatus("run-1", "completed");
      expect(db.execute).toHaveBeenCalledOnce();
      const sql = db.execute.mock.calls[0][0] as string;
      expect(sql).toContain("UPDATE");
      expect(sql).toContain("pipeline_runs");
    });
  });

  describe("createStage", () => {
    it("inserts a stage record", async () => {
      await sm.createStage({
        id: "stage-1",
        pipelineRunId: "run-1",
        stageId: "spec-review",
      });
      expect(db.execute).toHaveBeenCalledOnce();
      const sql = db.execute.mock.calls[0][0] as string;
      expect(sql).toContain("pipeline_stages");
    });
  });

  describe("updateStageStatus", () => {
    it("sets completed_at for terminal states", async () => {
      await sm.updateStageStatus("stage-1", "completed");
      const sql = db.execute.mock.calls[0][0] as string;
      expect(sql).toContain("completed_at");
    });

    it("does not set completed_at for running status", async () => {
      await sm.updateStageStatus("stage-1", "running");
      const sql = db.execute.mock.calls[0][0] as string;
      expect(sql).not.toContain("completed_at");
    });
  });

  describe("claimStageForDispatch", () => {
    it("returns true when stage is pending", async () => {
      db.execute.mockResolvedValueOnce({ rowCount: 1 });
      const claimed = await sm.claimStageForDispatch("stage-1");
      expect(claimed).toBe(true);
      const sql = db.execute.mock.calls[0][0] as string;
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain("started_at");
    });

    it("returns false when stage is not pending", async () => {
      db.execute.mockResolvedValueOnce({ rowCount: 0 });
      const claimed = await sm.claimStageForDispatch("stage-1");
      expect(claimed).toBe(false);
    });
  });

  describe("setStageOutput", () => {
    it("stores parsed output JSON", async () => {
      await sm.setStageOutput("stage-1", { status: "pass" });
      const params = db.execute.mock.calls[0][1] as unknown[];
      expect(JSON.parse(params[0] as string)).toEqual({ status: "pass" });
    });
  });

  describe("incrementRetryCount", () => {
    it("increments and returns new count", async () => {
      db.query.mockResolvedValueOnce([{ retry_count: 2 }]);
      const count = await sm.incrementRetryCount("stage-1");
      expect(count).toBe(2);
    });
  });

  describe("getRunStages", () => {
    it("queries stages for a run", async () => {
      db.query.mockResolvedValueOnce([
        { id: "s1", pipeline_run_id: "run-1", stage_id: "spec-review", sub_issue_id: null, status: "completed", retry_count: 0, output: null, error: null, started_at: null, completed_at: null },
      ]);
      const stages = await sm.getRunStages("run-1");
      expect(stages).toHaveLength(1);
      expect(stages[0].stageId).toBe("spec-review");
    });
  });

  describe("getActiveRunForIssue", () => {
    it("returns null if no active run", async () => {
      db.query.mockResolvedValueOnce([]);
      const run = await sm.getActiveRunForIssue("issue-1", "company-1");
      expect(run).toBeNull();
    });
  });

  describe("listRuns", () => {
    it("queries pipeline_runs ordered by created_at DESC", async () => {
      db.query.mockResolvedValueOnce([]);
      await sm.listRuns("company-1");
      const sql = db.query.mock.calls[0][0] as string;
      expect(sql).toContain("pipeline_runs");
      expect(sql).toContain("ORDER BY created_at DESC");
      expect(sql).toContain("LIMIT 50");
    });

    it("filters by issueId when provided", async () => {
      db.query.mockResolvedValueOnce([]);
      await sm.listRuns("company-1", { issueId: "issue-123" });
      const sql = db.query.mock.calls[0][0] as string;
      const params = db.query.mock.calls[0][1] as unknown[];
      expect(sql).toContain("parent_issue_id");
      expect(params).toContain("issue-123");
    });

    it("filters by status when provided", async () => {
      db.query.mockResolvedValueOnce([]);
      await sm.listRuns("company-1", { status: "running" });
      const sql = db.query.mock.calls[0][0] as string;
      const params = db.query.mock.calls[0][1] as unknown[];
      expect(sql).toContain("status");
      expect(params).toContain("running");
    });

    it("respects custom limit", async () => {
      db.query.mockResolvedValueOnce([]);
      await sm.listRuns("company-1", { limit: 10 });
      const sql = db.query.mock.calls[0][0] as string;
      expect(sql).toContain("LIMIT 10");
    });

    it("maps rows to PipelineRun objects", async () => {
      db.query.mockResolvedValueOnce([{
        id: "run-1",
        company_id: "company-1",
        parent_issue_id: "issue-1",
        pipeline_name: "feature",
        pipeline_version: 1,
        pipeline_yaml: "{}",
        status: "completed",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T01:00:00Z",
      }]);
      const runs = await sm.listRuns("company-1");
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe("run-1");
      expect(runs[0].pipelineName).toBe("feature");
      expect(runs[0].status).toBe("completed");
    });
  });

  describe("cancelRun", () => {
    it("sets run status to cancelled", async () => {
      await sm.cancelRun("run-1");
      const calls = db.execute.mock.calls as Array<[string, unknown[]]>;
      const runUpdateCall = calls.find(([sql]) => sql.includes("pipeline_runs"));
      expect(runUpdateCall).toBeDefined();
      expect(runUpdateCall![0]).toContain("cancelled");
    });

    it("sets pending and running stages to skipped", async () => {
      await sm.cancelRun("run-1");
      const calls = db.execute.mock.calls as Array<[string, unknown[]]>;
      const stageUpdateCall = calls.find(([sql]) => sql.includes("pipeline_stages"));
      expect(stageUpdateCall).toBeDefined();
      expect(stageUpdateCall![0]).toContain("skipped");
      expect(stageUpdateCall![0]).toContain("pending");
      expect(stageUpdateCall![0]).toContain("running");
    });

    it("releases the advisory lock for the run", async () => {
      // Acquire a lock first
      await sm.tryAdvisoryLock("run-1");
      // Lock should be held
      const secondLock = await sm.tryAdvisoryLock("run-1");
      expect(secondLock).toBe(false);

      // Cancel should release it
      await sm.cancelRun("run-1");
      const thirdLock = await sm.tryAdvisoryLock("run-1");
      expect(thirdLock).toBe(true);
    });
  });
});
