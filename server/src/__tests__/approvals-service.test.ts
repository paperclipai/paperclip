import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());
const mockPrepareAdapterConfigForPersistence = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

vi.mock("../services/agent-adapter-config.js", () => ({
  prepareAdapterConfigForPersistence: mockPrepareAdapterConfigForPersistence,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: vi.fn(() => ({
    normalizeAdapterConfigForPersistence: vi.fn(),
    resolveAdapterConfigForRuntime: vi.fn(),
  })),
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

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[][]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const pendingUpdateResults = [...updateResults];
  const returning = vi.fn(async () => pendingUpdateResults.shift() ?? []);
  const updateCalls: unknown[] = [];
  const setCalls: unknown[] = [];
  const whereCalls: unknown[] = [];
  const updateWhere = (condition?: unknown) => {
    whereCalls.push(condition);
    return { returning };
  };
  const set = (values?: unknown) => {
    setCalls.push(values);
    return { where: updateWhere };
  };
  const update = (table?: unknown) => {
    updateCalls.push(table);
    return { set };
  };

  return {
    db: { select, update },
    selectWhere,
    update,
    updateWhere,
    updateCalls,
    setCalls,
    whereCalls,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepareAdapterConfigForPersistence.mockImplementation(
      async ({ adapterConfig }: { adapterConfig: Record<string, unknown> }) => adapterConfig,
    );
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [[]],
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
      [[]],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")], [createApproval("pending")]], [[approved]]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("rejects approval-created opencode_local agents without model", async () => {
    const pending = createApproval("pending");
    pending.payload = {
      name: "OpenCode Agent",
      role: "general",
      adapterType: "opencode_local",
      adapterConfig: {},
    };
    const approved = { ...pending, status: "approved" };
    const dbStub = createDbStub([[pending]], [[approved]]);
    mockPrepareAdapterConfigForPersistence.mockRejectedValueOnce(
      new Error("OpenCode requires an explicit model in provider/model format."),
    );

    const svc = approvalService(dbStub.db as any);

    await expect(svc.approve("approval-1", "board", "ship it")).rejects.toThrow(
      "OpenCode requires an explicit model in provider/model format.",
    );
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("keeps repeated approve retries as no-ops for already-approved opencode_local hires", async () => {
    const approved = createApproval("approved");
    approved.payload = {
      name: "OpenCode Agent",
      role: "general",
      adapterType: "opencode_local",
      adapterConfig: {},
    };
    const dbStub = createDbStub([[approved], [approved]], [[]]);
    mockPrepareAdapterConfigForPersistence.mockRejectedValueOnce(
      new Error("OpenCode requires an explicit model in provider/model format."),
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockPrepareAdapterConfigForPersistence).not.toHaveBeenCalled();
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("rolls approval back when the payload changes after prevalidation and the latest payload is invalid", async () => {
    const pending = createApproval("pending");
    pending.payload = {
      name: "OpenCode Agent",
      role: "general",
      adapterType: "opencode_local",
      adapterConfig: { model: "openai/gpt-5-codex" },
    };
    const approved = {
      ...pending,
      status: "approved",
      decidedByUserId: "board",
      decidedAt: new Date("2026-04-08T15:00:00.000Z"),
      payload: {
        name: "OpenCode Agent",
        role: "general",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
    };
    const reverted = { ...pending, status: "pending" };
    const dbStub = createDbStub(
      [[pending], [pending]],
      [[approved], [reverted]],
    );
    mockPrepareAdapterConfigForPersistence
      .mockResolvedValueOnce({ model: "openai/gpt-5-codex" })
      .mockRejectedValueOnce(new Error("OpenCode requires an explicit model in provider/model format."));

    const svc = approvalService(dbStub.db as any);

    await expect(svc.approve("approval-1", "board", "ship it")).rejects.toThrow(
      "OpenCode requires an explicit model in provider/model format.",
    );
    expect(mockPrepareAdapterConfigForPersistence).toHaveBeenCalled();
    expect(
      mockPrepareAdapterConfigForPersistence.mock.calls.at(-1)?.[0],
    ).toMatchObject({
      adapterConfig: {},
      adapterType: "opencode_local",
      companyId: "company-1",
    });
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("normalizes legacy operations hire approvals to coo when approving", async () => {
    const pending = createApproval("pending");
    pending.payload = {
      name: "Operations Agent",
      role: "operations",
      adapterType: "process",
      adapterConfig: {},
    };
    const approved = { ...pending, status: "approved" };
    const dbStub = createDbStub([[pending], [pending]], [[approved]]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        role: "coo",
      }),
    );
  });
});
