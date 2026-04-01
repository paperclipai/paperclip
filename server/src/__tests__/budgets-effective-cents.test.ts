import { beforeEach, describe, expect, it, vi } from "vitest";
import { budgetService } from "../services/budgets.ts";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type SelectResult = unknown[];

function createDbStub(selectResults: SelectResult[]) {
  const pendingSelects = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectThen = vi.fn((resolve: (value: unknown[]) => unknown) =>
    Promise.resolve(resolve(pendingSelects.shift() ?? [])),
  );
  const selectOrderBy = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
    then: selectThen,
    orderBy: selectOrderBy,
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));

  const insertValues = vi.fn();
  const insertReturning = vi.fn(async () => pendingInserts.shift() ?? []);
  const insert = vi.fn(() => ({
    values: insertValues.mockImplementation(() => ({
      returning: insertReturning,
    })),
  }));

  const updateSet = vi.fn();
  const updateWhere = vi.fn(async () => pendingUpdates.shift() ?? []);
  const update = vi.fn(() => ({
    set: updateSet.mockImplementation(() => ({
      where: updateWhere,
    })),
  }));

  const pendingInserts: unknown[][] = [];
  const pendingUpdates: unknown[][] = [];

  return {
    db: { select, insert, update },
    queueInsert: (rows: unknown[]) => pendingInserts.push(rows),
    queueUpdate: (rows: unknown[] = []) => pendingUpdates.push(rows),
    selectWhere,
    insertValues,
    updateSet,
  };
}

describe("budgetService with effective_cents metric", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes subscription plan costs in observed amount for effective_cents policies", async () => {
    const effectivePolicy = {
      id: "policy-eff",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "effective_cents",
      windowKind: "calendar_month_utc",
      amount: 25000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const subscriptionPlan = {
      id: "plan-1",
      companyId: "company-1",
      agentId: "agent-1",
      provider: "anthropic",
      biller: "anthropic",
      monthlyCostCents: 20000,
      seatCount: 1,
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      effectiveUntil: null,
      isActive: true,
    };

    const dbStub = createDbStub([
      // 1. evaluateCostEvent: select policies for the agent
      [effectivePolicy],
      // 2. computeObservedAmount: select sum of cost_events (billed portion = 5000)
      [{ total: 5000 }],
      // 3. computeSubscriptionCostForScope: select matching subscription plans
      [subscriptionPlan],
      // 4. createIncidentIfNeeded(hard): check existing incidents → none (consumed by .where(), .then() transforms it)
      [],
      // 5. resolveScopeRecord(agent): agent row (consumed by .where(), .then() transforms it)
      [{
        companyId: "company-1",
        name: "Budget Agent",
        status: "running",
        pauseReason: null,
      }],
    ]);

    // billed = 5000, subscription = 20000, effective = 25000
    // amount = 25000, so 100% utilization → triggers hard stop
    dbStub.queueInsert([{
      id: "approval-1",
      companyId: "company-1",
      status: "pending",
    }]);
    dbStub.queueInsert([{
      id: "incident-1",
      companyId: "company-1",
      policyId: "policy-eff",
      approvalId: "approval-1",
    }]);
    dbStub.queueUpdate([]);

    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(dbStub.db as any, { cancelWorkForScope });

    await service.evaluateCostEvent({
      companyId: "company-1",
      agentId: "agent-1",
      projectId: null,
    } as any);

    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        policyId: "policy-eff",
        thresholdType: "hard",
        amountObserved: 25000,
      }),
    );
  });

  it("does not trigger hard-stop when effective spend is under budget", async () => {
    const effectivePolicy = {
      id: "policy-eff",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "effective_cents",
      windowKind: "calendar_month_utc",
      amount: 50000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const subscriptionPlan = {
      id: "plan-1",
      companyId: "company-1",
      agentId: "agent-1",
      provider: "anthropic",
      biller: "anthropic",
      monthlyCostCents: 20000,
      seatCount: 1,
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      effectiveUntil: null,
      isActive: true,
    };

    const dbStub = createDbStub([
      [effectivePolicy],
      [{ total: 5000 }],
      [subscriptionPlan],
    ]);

    const service = budgetService(dbStub.db as any);

    await service.evaluateCostEvent({
      companyId: "company-1",
      agentId: "agent-1",
      projectId: null,
    } as any);

    // effective = 5000 + 20000 = 25000, which is 50% of 50000 — no incident
    expect(dbStub.insertValues).not.toHaveBeenCalled();
  });

  it("handles billed_cents policies without subscription plan lookup", async () => {
    const billedPolicy = {
      id: "policy-billed",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 10000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const dbStub = createDbStub([
      [billedPolicy],
      [{ total: 5000 }],
    ]);

    const service = budgetService(dbStub.db as any);
    await service.evaluateCostEvent({
      companyId: "company-1",
      agentId: "agent-1",
      projectId: null,
    } as any);

    // billed = 5000, amount = 10000 — under budget, no incident
    expect(dbStub.insertValues).not.toHaveBeenCalled();
  });
});
