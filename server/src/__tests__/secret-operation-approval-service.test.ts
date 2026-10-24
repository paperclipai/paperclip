import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockExecuteApprovedSecretOperation = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => ({
    activatePendingApproval: vi.fn(),
    create: vi.fn(),
    terminate: vi.fn(),
  })),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

vi.mock("../services/secret-approval-hook.js", () => ({
  executeApprovedSecretOperation: mockExecuteApprovedSecretOperation,
}));

const TARGET = "7d2e9a41-6b3c-4f5d-8e19-2a4b6c8d0e1f";

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function secretOperationApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "secret_operation",
    status,
    payload: { op: "delete", targetId: TARGET },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  // `decide()` reads the row once to route hire approvals before resolving it.
  const pendingSelectResults = [selectResults[0] ?? [], ...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return { db: { select, update } };
}

describe("approvalService secret_operation execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotifyHireApproved.mockResolvedValue(undefined);
    mockExecuteApprovedSecretOperation.mockResolvedValue({
      ok: true,
      op: "delete",
      targetId: TARGET,
      error: null,
    });
  });

  it("executes the operation when the approval transition is newly applied", async () => {
    const approved = secretOperationApproval("approved");
    const dbStub = createDbStub([[secretOperationApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "go ahead");

    expect(result.applied).toBe(true);
    expect(mockExecuteApprovedSecretOperation).toHaveBeenCalledTimes(1);
    expect(mockExecuteApprovedSecretOperation).toHaveBeenCalledWith(dbStub.db, {
      companyId: "company-1",
      approvalId: "approval-1",
      payload: approved.payload,
    });
    expect(result.secretOperation).toEqual({
      ok: true,
      op: "delete",
      targetId: TARGET,
      error: null,
    });
  });

  it("does not delete twice when the same approval is approved again", async () => {
    // Second approve: the row is already `approved`, so `applied` is false and
    // the execution branch must not run — otherwise a re-approval is a second delete.
    const dbStub = createDbStub(
      [[secretOperationApproval("pending")], [secretOperationApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "go ahead");

    expect(result.applied).toBe(false);
    expect(mockExecuteApprovedSecretOperation).not.toHaveBeenCalled();
    expect(result.secretOperation).toBeNull();
  });

  it("does not execute anything when the approval is rejected", async () => {
    const rejected = { ...secretOperationApproval("rejected") };
    const dbStub = createDbStub([[secretOperationApproval("pending")]], [rejected]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "no");

    expect(result.applied).toBe(true);
    expect(mockExecuteApprovedSecretOperation).not.toHaveBeenCalled();
  });

  it("returns the failure instead of throwing, so the requester wake still runs", async () => {
    mockExecuteApprovedSecretOperation.mockResolvedValue({
      ok: false,
      op: "delete",
      targetId: TARGET,
      error: "secret not found",
    });
    const dbStub = createDbStub(
      [[secretOperationApproval("pending")]],
      [secretOperationApproval("approved")],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "go ahead");

    expect(result.applied).toBe(true);
    expect(result.secretOperation?.ok).toBe(false);
  });

  it("leaves other approval types alone", async () => {
    const boardRequest = {
      ...secretOperationApproval("approved"),
      type: "request_board_approval",
      payload: { title: "Unrelated decision", targetId: TARGET },
    };
    const dbStub = createDbStub(
      [[{ ...boardRequest, status: "pending" }]],
      [boardRequest],
    );

    const svc = approvalService(dbStub.db as any);
    await svc.approve("approval-1", "board", "ship it");

    expect(mockExecuteApprovedSecretOperation).not.toHaveBeenCalled();
  });
});
