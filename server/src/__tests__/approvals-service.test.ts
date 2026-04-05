import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  update: vi.fn(),
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
    payload: { agentId: "33333333-3333-4333-8333-333333333333" },
    requestedByAgentId: "11111111-1111-4111-8111-111111111111",
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
    mockAgentService.update.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" });
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
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
    expect(mockAgentService.update).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", {
      name: undefined,
      role: undefined,
      title: null,
      reportsTo: null,
      capabilities: null,
      adapterType: undefined,
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      metadata: null,
    });
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("reconciles approved hire payload fields back onto pending agents", async () => {
    const approved = {
      ...createApproval("approved"),
      payload: {
        agentId: "33333333-3333-4333-8333-333333333333",
        name: "Hermes Worker",
        role: "engineer",
        title: "IC",
        reportsTo: "22222222-2222-4222-8222-222222222222",
        capabilities: "Ship delegated work",
        adapterType: "hermes_local",
        adapterConfig: { model: "gpt-4o" },
        runtimeConfig: { cwd: "/tmp/worker" },
        budgetMonthlyCents: 0,
        metadata: { origin: "approval" },
      },
    };
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    await svc.approve("approval-1", "board", "ship it");

    expect(mockAgentService.update).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", {
      name: "Hermes Worker",
      role: "engineer",
      title: "IC",
      reportsTo: "22222222-2222-4222-8222-222222222222",
      capabilities: "Ship delegated work",
      adapterType: "hermes_local",
      adapterConfig: { model: "gpt-4o" },
      runtimeConfig: { cwd: "/tmp/worker" },
      budgetMonthlyCents: 0,
      metadata: { origin: "approval" },
    });
  });

  it("maps literal Paperclip self placeholders back to the requesting agent during approval", async () => {
    const approved = {
      ...createApproval("approved"),
      payload: {
        agentId: "33333333-3333-4333-8333-333333333333",
        name: "Hermes Worker",
        role: "engineer",
        reportsTo: "$PAPERCLIP_AGENT_ID",
        adapterType: "hermes_local",
        adapterConfig: { model: "gpt-4o" },
      },
    };
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    await svc.approve("approval-1", "board", "ship it");

    expect(mockAgentService.update).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", {
      name: "Hermes Worker",
      role: "engineer",
      title: null,
      reportsTo: "11111111-1111-4111-8111-111111111111",
      capabilities: null,
      adapterType: "hermes_local",
      adapterConfig: { model: "gpt-4o" },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      metadata: null,
    });
  });
});
