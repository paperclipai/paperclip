import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
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
});

describe("approvalService request_board_approval grant propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeBoardApproval(status: "pending" | "approved" | "rejected" = "pending") {
    return {
      id: "approval-board-1",
      companyId: "company-1",
      type: "request_board_approval",
      status,
      payload: {
        title: "Need secrets:read to wire CAR-16",
        grants: [
          { permissionKey: "secrets:read", scope: { environmentId: "env-prod" } },
          { permissionKey: "tasks:assign" },
        ],
      },
      requestedByAgentId: "agent-requester-1",
      requestedByUserId: null,
    };
  }

  it("upserts permission grants to the requesting agent when a request_board_approval is newly approved", async () => {
    const approved = makeBoardApproval("approved");
    const selectResults: unknown[][] = [
      [makeBoardApproval("pending")],
      [],
      [],
      [],
      [],
    ];
    let selectIdx = 0;
    const selectWhere = vi.fn(async () => selectResults[selectIdx++] ?? []);
    const from = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from }));

    const returning = vi.fn(async () => [approved]);
    const updateWhere = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set }));

    const onConflictDoUpdate = vi.fn().mockReturnThis();
    const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values: insertValues }));

    const dbStub = { select, update, insert };

    const svc = approvalService(dbStub as any);
    const result = await svc.approve("approval-board-1", "user-board-1", "ship it");

    expect(result.applied).toBe(true);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insertValues).toHaveBeenCalledTimes(2);
    const firstValues = insertValues.mock.calls[0][0] as Record<string, unknown>;
    const secondValues = insertValues.mock.calls[1][0] as Record<string, unknown>;
    expect(firstValues).toMatchObject({
      companyId: "company-1",
      principalType: "agent",
      principalId: "agent-requester-1",
      permissionKey: "secrets:read",
      scope: { environmentId: "env-prod" },
      grantedByUserId: "user-board-1",
    });
    expect(secondValues).toMatchObject({
      principalType: "agent",
      principalId: "agent-requester-1",
      permissionKey: "tasks:assign",
      scope: null,
      grantedByUserId: "user-board-1",
    });
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.any(Array),
        set: expect.objectContaining({
          grantedByUserId: "user-board-1",
        }),
      }),
    );
  });

  it("re-applies grants on a repeated approval retry so partial-failure is recoverable", async () => {
    const selectResults: unknown[][] = [
      [makeBoardApproval("pending")],
      [makeBoardApproval("approved")],
    ];
    let selectIdx = 0;
    const selectWhere = vi.fn(async () => selectResults[selectIdx++] ?? []);
    const from = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from }));

    const updateReturning = vi.fn(async () => []);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const set = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set }));

    const onConflictDoUpdate = vi.fn().mockReturnThis();
    const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values: insertValues }));
    const dbStub = { select, update, insert };

    const svc = approvalService(dbStub as any);
    const result = await svc.approve("approval-board-1", "user-board-1");

    expect(result.applied).toBe(false);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insertValues).toHaveBeenCalledTimes(2);
  });

  it("skips grant insertion when the request_board_approval payload has no grants", async () => {
    const approved = { ...makeBoardApproval("approved"), payload: { title: "no grants" } };
    const selectResults: unknown[][] = [
      [{ ...approved, status: "pending" }],
      [],
      [],
      [],
    ];
    let selectIdx = 0;
    const selectWhere = vi.fn(async () => selectResults[selectIdx++] ?? []);
    const from = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from }));

    const returning = vi.fn(async () => [approved]);
    const updateWhere = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set }));

    const insert = vi.fn(() => ({ values: vi.fn() }));
    const dbStub = { select, update, insert };

    const svc = approvalService(dbStub as any);
    const result = await svc.approve("approval-board-1", "user-board-1");

    expect(result.applied).toBe(true);
    expect(insert).not.toHaveBeenCalled();
  });
});
