import { beforeEach, describe, expect, it, vi } from "vitest";
import { budgetService } from "../services/budgets.ts";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type SelectResult = unknown[];

function createDbStub(selectResults: SelectResult[]) {
  const pendingSelects = [...selectResults];

  // Returns a "thenable builder" — awaitable and chainable with .orderBy().
  function makeResultChain(data: unknown[]) {
    return {
      then(resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(data).then(resolve, reject);
      },
      orderBy: vi.fn(async () => data),
    };
  }

  const selectWhere = vi.fn(() => makeResultChain(pendingSelects.shift() ?? []));
  const selectThen = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])));
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
    db: {
      select,
      insert,
      update,
    },
    queueInsert: (rows: unknown[]) => {
      pendingInserts.push(rows);
    },
    queueUpdate: (rows: unknown[] = []) => {
      pendingUpdates.push(rows);
    },
    selectWhere,
    insertValues,
    updateSet,
  };
}

describe("budgetService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a hard-stop incident and pauses an agent when spend exceeds a budget", async () => {
    const policy = {
      id: "policy-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const dbStub = createDbStub([
      [policy],
      [{ total: 150 }],
      [],
      [{
        companyId: "company-1",
        name: "Budget Agent",
        status: "running",
        pauseReason: null,
      }],
    ]);

    dbStub.queueInsert([{
      id: "approval-1",
      companyId: "company-1",
      status: "pending",
    }]);
    dbStub.queueInsert([{
      id: "incident-1",
      companyId: "company-1",
      policyId: "policy-1",
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
        type: "budget_override_required",
        status: "pending",
      }),
    );
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        policyId: "policy-1",
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 150,
        approvalId: "approval-1",
      }),
    );
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        pauseReason: "budget",
        pausedAt: expect.any(Date),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "budget.hard_threshold_crossed",
        entityId: "incident-1",
      }),
    );
    expect(cancelWorkForScope).toHaveBeenCalledWith({
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
    });
  });

  it("blocks new work when an agent hard-stop remains exceeded even if the agent is not paused yet", async () => {
    const agentPolicy = {
      id: "policy-agent-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    const dbStub = createDbStub([
      [{
        status: "running",
        pauseReason: null,
        companyId: "company-1",
        name: "Budget Agent",
      }],
      [{
        status: "active",
        name: "Paperclip",
      }],
      [],
      [agentPolicy],
      [{ total: 120 }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual({
      scopeType: "agent",
      scopeId: "agent-1",
      scopeName: "Budget Agent",
      reason: "Agent cannot start because its budget hard-stop is still exceeded.",
    });
  });

  it("surfaces a budget-owned company pause distinctly from a manual pause", async () => {
    const dbStub = createDbStub([
      [{
        status: "idle",
        pauseReason: null,
        companyId: "company-1",
        name: "Budget Agent",
      }],
      [{
        status: "paused",
        pauseReason: "budget",
        name: "Paperclip",
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual({
      scopeType: "company",
      scopeId: "company-1",
      scopeName: "Paperclip",
      reason: "Company is paused because its budget hard-stop was reached.",
    });
  });

  /**
   * Regression tests for https://github.com/paperclipai/paperclip/issues/3060
   *
   * Deleting an agent should not leave orphaned budget_policies that crash
   * /dashboard, /sidebar-badges, and /budgets/overview.
   */
  it("overview returns empty policies array when all agent-scoped policies are orphaned", async () => {
    const orphanedPolicy = {
      id: "policy-orphan",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-deleted",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Queued in order: listPolicyRows, resolveScopeRecord (agent not found), listActiveIncidents
    const dbStub = createDbStub([
      [orphanedPolicy],
      [],
      [],
    ]);

    const service = budgetService(dbStub.db as any);
    const overview = await service.overview("company-1");

    expect(overview.policies).toHaveLength(0);
    expect(overview.pausedAgentCount).toBe(0);
  });

  it("overview returns empty policies array when all project-scoped policies are orphaned", async () => {
    const orphanedPolicy = {
      id: "policy-orphan-proj",
      companyId: "company-1",
      scopeType: "project",
      scopeId: "project-deleted",
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 500,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Queued in order: listPolicyRows, resolveScopeRecord (project not found), listActiveIncidents
    const dbStub = createDbStub([
      [orphanedPolicy],
      [],
      [],
    ]);

    const service = budgetService(dbStub.db as any);
    const overview = await service.overview("company-1");

    expect(overview.policies).toHaveLength(0);
    expect(overview.pausedProjectCount).toBe(0);
  });

  it("overview preserves valid policies alongside orphaned ones", async () => {
    const orphanedPolicy = {
      id: "policy-orphan",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-deleted",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const validPolicy = {
      id: "policy-valid",
      companyId: "company-1",
      scopeType: "company",
      scopeId: "company-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: false,
      notifyEnabled: true,
      isActive: true,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Queued in order:
    //  1. listPolicyRows → both policies
    //  2. resolveScopeRecord for orphanedPolicy (agent) → [] (not found)
    //  3. resolveScopeRecord for validPolicy (company) → [{ companyId, name, status... }]
    //  4. computeObservedAmount for validPolicy → [{ total: 50 }]
    //  5. listActiveIncidents → []
    const dbStub = createDbStub([
      [orphanedPolicy, validPolicy],
      [],
      [{ companyId: "company-1", name: "Acme", status: "active", pauseReason: null, pausedAt: null }],
      [{ total: 50 }],
      [],
    ]);

    const service = budgetService(dbStub.db as any);
    const overview = await service.overview("company-1");

    expect(overview.policies).toHaveLength(1);
    expect(overview.policies[0]?.policyId).toBe("policy-valid");
  });

  it("uses live observed spend when raising a budget incident", async () => {
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "company-1",
        policyId: "policy-1",
        amountObserved: 120,
        approvalId: "approval-1",
      }],
      [{
        id: "policy-1",
        companyId: "company-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
      }],
      [{ total: 150 }],
    ]);

    const service = budgetService(dbStub.db as any);

    await expect(
      service.resolveIncident(
        "company-1",
        "incident-1",
        { action: "raise_budget_and_resume", amount: 140 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");
  });

  it("syncs company monthly budget when raising and resuming a company incident", async () => {
    const now = new Date();
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "company-1",
        policyId: "policy-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: now,
        windowEnd: now,
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 120,
        status: "open",
        approvalId: "approval-1",
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      }],
      [{
        id: "policy-1",
        companyId: "company-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
      }],
      [{ total: 120 }],
      [{ id: "approval-1", status: "approved" }],
      [{
        companyId: "company-1",
        name: "Paperclip",
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    await service.resolveIncident(
      "company-1",
      "incident-1",
      { action: "raise_budget_and_resume", amount: 175 },
      "board-user",
    );

    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetMonthlyCents: 175,
        updatedAt: expect.any(Date),
      }),
    );
  });
});
