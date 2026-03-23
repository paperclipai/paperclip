import { beforeEach, describe, expect, it, vi } from "vitest";
import { workflowService } from "../services/workflows.ts";

const mockPublishLiveEvent = vi.hoisted(() => vi.fn());

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: mockPublishLiveEvent,
}));

function createMockDb() {
  const insertedValues: any[] = [];
  const executeLog: any[] = [];
  const updateLog: any[] = [];

  const returning = vi.fn(async () => [{
    id: "wf-1",
    companyId: "comp-1",
    name: "Test Workflow",
    steps: [],
    status: "pending",
    onStepFailure: "pause",
    currentStep: 0,
  }]);

  const insertValues = vi.fn((vals: any) => {
    insertedValues.push(vals);
    return { returning };
  });

  const updateWhere = vi.fn(async () => []);
  const updateSet = vi.fn((data: any) => {
    updateLog.push(data);
    return { where: updateWhere };
  });

  // For advanceStep: select().from().where().then()
  let selectThenResult: any = null;
  const selectThen = vi.fn((fn: any) => Promise.resolve(fn(selectThenResult ?? [])));
  const selectOrderBy = vi.fn(async () => []);
  const selectWhere = vi.fn(() => ({ then: selectThen, orderBy: selectOrderBy }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));

  return {
    db: {
      select: vi.fn(() => ({ from: selectFrom })),
      insert: vi.fn(() => ({ values: insertValues })),
      update: vi.fn(() => ({ set: updateSet })),
      execute: vi.fn(async (...args: any[]) => {
        executeLog.push(args);
        return [];
      }),
      transaction: vi.fn(async (fn: any) => fn({
        execute: vi.fn(async () => []),
        insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
      })),
    },
    insertedValues,
    executeLog,
    updateLog,
    returning,
    insertValues,
    updateSet,
    updateWhere,
    selectThen,
    setSelectResult: (result: any) => { selectThenResult = result; },
  };
}

describe("workflowService — meeting/consensus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createMeeting", () => {
    it("creates N participant steps + 1 synthesis step", async () => {
      const { db, insertValues, returning } = createMockDb();
      returning.mockResolvedValueOnce([{
        id: "wf-meeting-1",
        companyId: "comp-1",
        name: "Standup",
        steps: [],
        status: "pending",
      }]);

      const svc = workflowService(db as any);
      await svc.createMeeting("comp-1", {
        name: "Standup",
        participantAgentIds: ["agent-1", "agent-2", "agent-3"],
        meetingType: "standup",
        prompt: "What did you do today?",
      });

      // First insert: workflow creation (values is called with object)
      // Second insert: step runs (values is called with array of 4 steps: 3 participants + 1 synthesis)
      expect(db.insert).toHaveBeenCalledTimes(2);
      const stepRunValues = insertValues.mock.calls[1][0];
      expect(stepRunValues).toHaveLength(4); // 3 participants + 1 synthesis
    });

    it("sets workflow_type to meeting via raw SQL", async () => {
      const { db, returning } = createMockDb();
      returning.mockResolvedValueOnce([{
        id: "wf-meeting-1",
        companyId: "comp-1",
        name: "Meeting",
        steps: [],
        status: "pending",
      }]);

      const svc = workflowService(db as any);
      await svc.createMeeting("comp-1", {
        name: "Meeting",
        participantAgentIds: ["agent-1"],
        meetingType: "consultation",
        prompt: "Review this",
      });

      expect(db.execute).toHaveBeenCalled();
    });

    it("publishes meeting.started event", async () => {
      const { db, returning } = createMockDb();
      returning.mockResolvedValueOnce([{
        id: "wf-meeting-1",
        companyId: "comp-1",
        name: "Standup",
        steps: [],
        status: "pending",
      }]);

      const svc = workflowService(db as any);
      await svc.createMeeting("comp-1", {
        name: "Standup",
        participantAgentIds: ["agent-1", "agent-2"],
        meetingType: "standup",
        prompt: "Status update",
      });

      expect(mockPublishLiveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "comp-1",
          type: "meeting.started",
          payload: expect.objectContaining({
            workflowId: "wf-meeting-1",
            name: "Standup",
            participantCount: 2,
          }),
        }),
      );
    });
  });

  describe("createConsensus", () => {
    it("creates 3 model steps + 1 synthesis step", async () => {
      const { db, insertValues, returning } = createMockDb();
      returning.mockResolvedValueOnce([{
        id: "wf-consensus-1",
        companyId: "comp-1",
        name: "Tri-Model Consensus",
        steps: [],
        status: "pending",
      }]);

      const svc = workflowService(db as any);
      await svc.createConsensus("comp-1", {
        prompt: "Evaluate this architecture",
      });

      // First insert: workflow, second insert: step runs
      expect(db.insert).toHaveBeenCalledTimes(2);
      const stepRunValues = insertValues.mock.calls[1][0];
      expect(stepRunValues).toHaveLength(4); // 3 models + 1 synthesis
    });

    it("sets workflow_type to consensus via raw SQL", async () => {
      const { db, returning } = createMockDb();
      returning.mockResolvedValueOnce([{
        id: "wf-consensus-1",
        companyId: "comp-1",
        name: "Tri-Model Consensus",
        steps: [],
        status: "pending",
      }]);

      const svc = workflowService(db as any);
      await svc.createConsensus("comp-1", {
        prompt: "Evaluate this",
      });

      expect(db.execute).toHaveBeenCalled();
    });
  });

  describe("advanceStep", () => {
    it("marks workflow completed and emits meeting.completed when last step completes", async () => {
      const { db, setSelectResult, updateSet } = createMockDb();
      setSelectResult([{
        id: "wf-1",
        companyId: "comp-1",
        name: "Meeting",
        steps: [
          { adapterType: "claude_local", action: "meeting_response" },
          { adapterType: "claude_local", action: "meeting_synthesis" },
        ],
        status: "running",
        onStepFailure: "pause",
        currentStep: 1,
      }]);

      const svc = workflowService(db as any);
      const result = await svc.advanceStep("wf-1", 1, { status: "completed" });

      expect(result).toEqual({ action: "completed" });
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: "completed" }),
      );
      expect(mockPublishLiveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "meeting.completed",
        }),
      );
    });

    it("sets workflow to failed with abort policy", async () => {
      const { db, setSelectResult, updateSet } = createMockDb();
      setSelectResult([{
        id: "wf-1",
        companyId: "comp-1",
        name: "Meeting",
        steps: [
          { adapterType: "claude_local" },
          { adapterType: "claude_local" },
        ],
        status: "running",
        onStepFailure: "abort",
        currentStep: 0,
      }]);

      const svc = workflowService(db as any);
      const result = await svc.advanceStep("wf-1", 0, {
        status: "failed",
        error: "Agent crashed",
      });

      expect(result).toEqual({ action: "aborted" });
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    });

    it("pauses workflow with pause policy on failure", async () => {
      const { db, setSelectResult, updateSet } = createMockDb();
      setSelectResult([{
        id: "wf-1",
        companyId: "comp-1",
        name: "Meeting",
        steps: [
          { adapterType: "claude_local" },
          { adapterType: "claude_local" },
        ],
        status: "running",
        onStepFailure: "pause",
        currentStep: 0,
      }]);

      const svc = workflowService(db as any);
      const result = await svc.advanceStep("wf-1", 0, {
        status: "failed",
        error: "Timeout",
      });

      expect(result).toEqual({ action: "paused" });
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: "paused" }),
      );
    });
  });

  describe("start", () => {
    it("sets workflow status to running and first step to running", async () => {
      const { db, updateSet } = createMockDb();

      const svc = workflowService(db as any);
      await svc.start("wf-1");

      // Two update calls: one for workflowRuns, one for workflowStepRuns
      expect(db.update).toHaveBeenCalledTimes(2);
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "running",
          startedAt: expect.any(Date),
        }),
      );
    });
  });
});
