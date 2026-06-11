import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());
const mockCreateInstructionApplyTask = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

vi.mock("../services/instruction-apply-hook.js", () => ({
  createInstructionApplyTask: mockCreateInstructionApplyTask,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string, type = "hire_agent"): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type,
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("creates the board-auth apply task when an instruction-generation approval is newly approved", async () => {
    const approved = createApproval("approved", "instruction_generation");
    const dbStub = createDbStub(
      [[createApproval("pending", "instruction_generation")]],
      [approved],
    );
    mockCreateInstructionApplyTask.mockResolvedValue({ issueId: "issue-1", created: true });

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "apply it");

    expect(result.applied).toBe(true);
    expect(result.applyTask).toEqual({ issueId: "issue-1", created: true });
    expect(mockCreateInstructionApplyTask).toHaveBeenCalledWith(dbStub.db, {
      companyId: "company-1",
      approvalId: "approval-1",
      decidedByUserId: "board",
      payload: { agentId: "agent-1" },
    });
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
  });

  it("does not create an apply task when an instruction-generation approve retry is a no-op", async () => {
    const dbStub = createDbStub(
      [
        [createApproval("pending", "instruction_generation")],
        [createApproval("approved", "instruction_generation")],
      ],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "apply it");

    expect(result.applied).toBe(false);
    expect(result.applyTask).toBeNull();
    expect(mockCreateInstructionApplyTask).not.toHaveBeenCalled();
  });
});
