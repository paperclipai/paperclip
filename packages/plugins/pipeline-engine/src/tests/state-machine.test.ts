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
      db.query.mockResolvedValueOnce([{ id: "stage-1" }]);
      const claimed = await sm.claimStageForDispatch("stage-1");
      expect(claimed).toBe(true);
      const sql = db.query.mock.calls[0][0] as string;
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain("started_at");
    });

    it("returns false when stage is not pending", async () => {
      db.query.mockResolvedValueOnce([]);
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
});
