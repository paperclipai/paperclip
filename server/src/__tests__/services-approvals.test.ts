import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.js";
const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue({ id: "agent-created" }),
  terminate: vi.fn().mockResolvedValue(undefined),
}));
const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn().mockResolvedValue(undefined),
}));
const mockNotifyHireApproved = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn().mockResolvedValue({ censorUsernameInLogs: false }),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));
vi.mock("../services/budgets.js", () => ({
  budgetService: () => mockBudgetService,
}));
vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

function createDb(selectRows: Array<Array<Record<string, unknown>>>, updateRows: Array<Record<string, unknown>> = []) {
  const pending = [...selectRows];
  const selectWhere = vi.fn(async () => pending.shift() ?? []);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const returning = vi.fn(async () => updateRows);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(async () => [
        {
          id: "comment-1",
          companyId: "company-1",
          approvalId: "approval-1",
          body: "Looks good",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
    })),
  }));

  return { db: { select, update, insert } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("services/approvals.ts", () => {
  it("approves pending approvals and applies hire side effects", async () => {
    const pending = {
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: { agentId: "agent-1", budgetMonthlyCents: 0 },
    };
    const approved = { ...pending, status: "approved" };
    const { db } = createDb([[pending]], [approved]);
    const service = approvalService(db as any);

    const result = await service.approve("approval-1", "board-user", "approved");
    expect(result).toEqual({
      approval: approved,
      applied: true,
    });
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("treats already-approved records as idempotent approve retries", async () => {
    const alreadyApproved = {
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "approved",
      payload: { agentId: "agent-1" },
    };
    const { db } = createDb([[alreadyApproved]]);
    const service = approvalService(db as any);

    const result = await service.approve("approval-1", "board-user");
    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
  });

  it("rejects revision requests when approval is not pending", async () => {
    const { db } = createDb([
      [
        {
          id: "approval-1",
          companyId: "company-1",
          type: "hire_agent",
          status: "approved",
          payload: {},
        },
      ],
    ]);
    const service = approvalService(db as any);

    await expect(service.requestRevision("approval-1", "board-user", "need changes")).rejects.toThrow(
      "Only pending approvals can request revision",
    );
  });

  it("rejects resubmit unless approval is revision_requested", async () => {
    const { db } = createDb([
      [
        {
          id: "approval-1",
          companyId: "company-1",
          type: "hire_agent",
          status: "pending",
          payload: {},
        },
      ],
    ]);
    const service = approvalService(db as any);

    await expect(service.resubmit("approval-1", { updated: true })).rejects.toThrow(
      "Only revision requested approvals can be resubmitted",
    );
  });

  it("returns expected service contract", () => {
    const service = approvalService(createDb([]).db as any);
    expect(service).toMatchObject({
      approve: expect.any(Function),
      reject: expect.any(Function),
      requestRevision: expect.any(Function),
      resubmit: expect.any(Function),
      addComment: expect.any(Function),
    });
  });
});

