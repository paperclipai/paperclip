import { beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeatService } from "../services/heartbeat.ts";

const mockBudgetService = vi.hoisted(() => ({
  getInvocationBlock: vi.fn(),
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: () => mockBudgetService,
}));

type SelectResult = unknown[];

function createDbStub(selectResults: SelectResult[]) {
  const pendingSelects = [...selectResults];
  const inserted: unknown[] = [];

  const selectWhere = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectThen = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])));
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
    then: selectThen,
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));

  const insertValues = vi.fn(async (value: unknown) => {
    inserted.push(value);
    return [];
  });
  const insert = vi.fn(() => ({
    values: insertValues,
  }));

  return {
    db: {
      select,
      insert,
    },
    inserted,
    insertValues,
  };
}

describe("heartbeatService skipped wakeup receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBudgetService.getInvocationBlock.mockResolvedValue(null);
  });

  it("records a skipped timer wakeup when the agent is paused", async () => {
    const pausedAgent = {
      id: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      status: "paused",
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 30,
          wakeOnDemand: true,
        },
      },
      lastHeartbeatAt: new Date("2026-03-17T10:00:00.000Z"),
      createdAt: new Date("2026-03-17T09:00:00.000Z"),
    };
    const dbStub = createDbStub([[pausedAgent], [pausedAgent]]);

    const service = heartbeatService(dbStub.db as any);
    const result = await service.tickTimers(new Date("2026-03-17T10:01:00.000Z"));

    expect(result).toEqual({ checked: 1, enqueued: 0, skipped: 1 });
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        agentId: "agent-1",
        source: "timer",
        reason: "agent.paused",
        status: "skipped",
      }),
    );
  });

  it("records a skipped wakeup before rejecting a budget-blocked invocation", async () => {
    const activeAgent = {
      id: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      status: "running",
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 30,
          wakeOnDemand: true,
        },
      },
      createdAt: new Date("2026-03-17T09:00:00.000Z"),
    };
    const dbStub = createDbStub([[activeAgent]]);
    mockBudgetService.getInvocationBlock.mockResolvedValue({
      reason: "Agent budget is paused.",
      scopeType: "agent",
      scopeId: "agent-1",
    });

    const service = heartbeatService(dbStub.db as any);

    await expect(service.wakeup("agent-1")).rejects.toMatchObject({
      status: 409,
    });
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        agentId: "agent-1",
        source: "on_demand",
        reason: "budget.blocked",
        status: "skipped",
      }),
    );
  });
});
