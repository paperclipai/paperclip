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
  const selectThen = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])));
  const selectOrderBy = vi.fn(async () => pendingSelects.shift() ?? []);
  const innerJoinWhere = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectInnerJoin = vi.fn(() => ({
    where: innerJoinWhere,
  }));
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
    then: selectThen,
    orderBy: selectOrderBy,
    innerJoin: selectInnerJoin,
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
      [{ adapterType: null }], // agent adapterType lookup (evaluateCostEvent pre-filter)
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

  it("blocks new runs when adapter daily cap is exceeded (smoke: simulated run > 100% rejected)", async () => {
    const adapterPolicy = {
      id: "policy-adapter-1",
      companyId: "company-1",
      scopeType: "adapter",
      scopeId: "company-1",
      adapterName: "claude_local",
      metric: "billed_cents",
      windowKind: "calendar_day_utc",
      amount: 500,
      warnPercent: 75,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    const dbStub = createDbStub([
      // agent lookup (adapterType = claude_local)
      [{ status: "active", pauseReason: null, companyId: "company-1", name: "CTO Chef", adapterType: "claude_local" }],
      // company lookup
      [{ status: "active", pauseReason: null, name: "Rende Geruestbau" }],
      // company policy: none
      [],
      // agent policy: none
      [],
      // adapter policies query → returns our daily-cap policy
      [adapterPolicy],
      // observed spend for the adapter policy → 520 cents (> 500 limit)
      [{ total: 520 }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual(
      expect.objectContaining({
        scopeType: "adapter",
        reason: expect.stringContaining("claude_local"),
      }),
    );
  });

  describe("3-Stufen-Guardrail: costClass × Stage Matrix + Hysterese", () => {
    const agentPolicy = {
      id: "policy-guardrail",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-guardrail",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1000,
      warnPercent: 60,
      warnHighPercent: 85,
      warnRecoveryPercent: 55,
      warnHighRecoveryPercent: 75,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    function makeBlockStub(costClass: "free" | "metered" | "critical", observed: number, hasSoftIncident = false) {
      return createDbStub([
        [{ status: "active", pauseReason: null, companyId: "company-1", name: "Test Agent", adapterType: null, costClass }],
        [{ status: "active", pauseReason: null, name: "Paperclip" }],
        [],
        [agentPolicy],
        [{ total: observed }],
        hasSoftIncident ? [{ id: "soft-incident-1" }] : [],
      ]);
    }

    // Stage 1 (62 % utilization, warnPct=60)
    it("Stage 1 (62%): metered-Agent wird blockiert", async () => {
      const service = budgetService(makeBlockStub("metered", 620).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).not.toBeNull();
      expect(block?.scopeType).toBe("agent");
    });

    it("Stage 1 (62%): free-Agent passiert", async () => {
      const service = budgetService(makeBlockStub("free", 620).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).toBeNull();
    });

    it("Stage 1 (62%): critical-Agent passiert", async () => {
      const service = budgetService(makeBlockStub("critical", 620).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).toBeNull();
    });

    // Stage 2 (90 % utilization, warnHighPct=85)
    it("Stage 2 (90%): metered-Agent wird blockiert", async () => {
      const service = budgetService(makeBlockStub("metered", 900).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).not.toBeNull();
    });

    it("Stage 2 (90%): free-Agent wird blockiert", async () => {
      const service = budgetService(makeBlockStub("free", 900).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).not.toBeNull();
    });

    it("Stage 2 (90%): critical-Agent passiert", async () => {
      const service = budgetService(makeBlockStub("critical", 900).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).toBeNull();
    });

    // Stage 3 (100 % utilization, hardStop)
    it("Stage 3 (100%): metered-Agent wird blockiert", async () => {
      const service = budgetService(makeBlockStub("metered", 1000).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).not.toBeNull();
    });

    it("Stage 3 (100%): free-Agent wird blockiert", async () => {
      const service = budgetService(makeBlockStub("free", 1000).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).not.toBeNull();
    });

    it("Stage 3 (100%): critical-Agent wird blockiert", async () => {
      const service = budgetService(makeBlockStub("critical", 1000).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).not.toBeNull();
    });

    // Hysterese: Recovery-Thresholds
    it("Hysterese: 58 % mit aktiver Soft-Incident → Stage 1 bleibt (warnRecovery=55 %)", async () => {
      const service = budgetService(makeBlockStub("metered", 580, true).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).not.toBeNull();
    });

    it("Hysterese: 53 % mit aktiver Soft-Incident → Stage 0, kein Block (< warnRecovery 55 %)", async () => {
      const service = budgetService(makeBlockStub("metered", 530, true).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).toBeNull();
    });

    it("Hysterese: 58 % ohne Soft-Incident → Stage 0, kein Block (< warnPct 60 %)", async () => {
      const service = budgetService(makeBlockStub("metered", 580, false).db as any);
      const block = await service.getInvocationBlock("company-1", "agent-guardrail");
      expect(block).toBeNull();
    });
  });

  it("fires onBudgetAlert for soft threshold when adapter spend exceeds 75%", async () => {
    const adapterPolicy = {
      id: "policy-adapter-soft",
      companyId: "company-1",
      scopeType: "adapter",
      scopeId: "company-1",
      adapterName: "claude_local",
      metric: "billed_cents",
      windowKind: "calendar_day_utc",
      amount: 1000,
      warnPercent: 75,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    const dbStub = createDbStub([
      // agent lookup for evaluateCostEvent
      [{ adapterType: "claude_local" }],
      // all active policies
      [adapterPolicy],
      // innerJoin: observed amount → 800 cents (80%, > 75% threshold of 1000)
      [{ total: 800 }],
      // no existing soft incident
      [],
      // resolveScopeRecord (company lookup) inside createIncidentIfNeeded
      [{ companyId: "company-1", name: "Rende Geruestbau" }],
      // resolveScopeRecord (company lookup) again in evaluateCostEvent for alert payload
      [{ companyId: "company-1", name: "Rende Geruestbau" }],
    ]);

    dbStub.queueInsert([{
      id: "incident-soft-1",
      companyId: "company-1",
      policyId: "policy-adapter-soft",
      thresholdType: "soft",
      approvalId: null,
    }]);

    const onBudgetAlert = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(dbStub.db as any, { onBudgetAlert });

    await service.evaluateCostEvent({
      companyId: "company-1",
      agentId: "agent-1",
      projectId: null,
    } as any);

    expect(onBudgetAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        thresholdType: "soft",
        adapterName: "claude_local",
        windowKind: "calendar_day_utc",
        limitCents: 1000,
        observedCents: 800,
      }),
    );
  });
});
