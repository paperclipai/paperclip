import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscriptionPlanService } from "../services/subscription-plans.js";

type SelectResult = unknown[];

function createDbStub(selectResults: SelectResult[]) {
  const pendingSelects = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectThen = vi.fn((resolve: (value: unknown[]) => unknown) =>
    Promise.resolve(resolve(pendingSelects.shift() ?? [])),
  );
  const selectOrderBy = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectWhereOrderBy = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectFrom = vi.fn(() => ({
    where: vi.fn(() => ({
      ...Promise.resolve(pendingSelects[0] ?? []),
      then: (resolve: (value: unknown[]) => unknown) =>
        Promise.resolve(resolve(pendingSelects.shift() ?? [])),
      orderBy: selectWhereOrderBy,
    })),
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
  const updateReturning = vi.fn(async () => pendingUpdates.shift() ?? []);
  const updateWhere = vi.fn(() => ({
    returning: updateReturning,
  }));
  const update = vi.fn(() => ({
    set: updateSet.mockImplementation(() => ({
      where: updateWhere,
    })),
  }));

  const deleteWhere = vi.fn(async () => []);
  const deleteFn = vi.fn(() => ({
    where: deleteWhere,
  }));

  const pendingInserts: unknown[][] = [];
  const pendingUpdates: unknown[][] = [];

  return {
    db: { select, insert, update, delete: deleteFn },
    queueInsert: (rows: unknown[]) => pendingInserts.push(rows),
    queueUpdate: (rows: unknown[]) => pendingUpdates.push(rows),
    selectWhere,
    insertValues,
    updateSet,
  };
}

const PLAN = {
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
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("subscriptionPlanService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("list", () => {
    it("returns all plans for a company", async () => {
      const dbStub = createDbStub([[PLAN]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.list("company-1");
      expect(result).toEqual([PLAN]);
    });

    it("returns empty array when no plans exist", async () => {
      const dbStub = createDbStub([[]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.list("company-1");
      expect(result).toEqual([]);
    });
  });

  describe("getById", () => {
    it("returns a plan when found", async () => {
      const dbStub = createDbStub([[PLAN]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.getById("plan-1");
      expect(result).toEqual(PLAN);
    });

    it("throws not found when plan does not exist", async () => {
      const dbStub = createDbStub([[]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      await expect(svc.getById("missing")).rejects.toThrow(/not found/i);
    });
  });

  describe("create", () => {
    it("creates a plan with agent validation", async () => {
      const agent = { id: "agent-1", companyId: "company-1" };
      const created = { ...PLAN, id: "plan-new" };
      const dbStub = createDbStub([
        [agent],
      ]);
      dbStub.queueInsert([created]);

      const svc = subscriptionPlanService(dbStub.db as any);
      const result = await svc.create("company-1", {
        agentId: "agent-1",
        provider: "anthropic",
        biller: "anthropic",
        monthlyCostCents: 20000,
      });

      expect(result).toEqual(created);
      expect(dbStub.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          agentId: "agent-1",
          provider: "anthropic",
          monthlyCostCents: 20000,
        }),
      );
    });

    it("throws when agent does not belong to company", async () => {
      const agent = { id: "agent-1", companyId: "company-other" };
      const dbStub = createDbStub([[agent]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      await expect(
        svc.create("company-1", {
          agentId: "agent-1",
          provider: "anthropic",
          biller: "anthropic",
          monthlyCostCents: 20000,
        }),
      ).rejects.toThrow(/does not belong/i);
    });

    it("creates a company-wide plan without agentId", async () => {
      const created = { ...PLAN, id: "plan-cw", agentId: null };
      const dbStub = createDbStub([]);
      dbStub.queueInsert([created]);

      const svc = subscriptionPlanService(dbStub.db as any);
      const result = await svc.create("company-1", {
        provider: "anthropic",
        biller: "anthropic",
        monthlyCostCents: 20000,
      });

      expect(result).toEqual(created);
      expect(dbStub.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: null }),
      );
    });
  });

  describe("update", () => {
    it("updates a plan when it belongs to the company", async () => {
      const updated = { ...PLAN, monthlyCostCents: 30000 };
      const dbStub = createDbStub([[PLAN]]);
      dbStub.queueUpdate([updated]);

      const svc = subscriptionPlanService(dbStub.db as any);
      const result = await svc.update("company-1", "plan-1", {
        monthlyCostCents: 30000,
      });

      expect(result).toEqual(updated);
    });

    it("throws when plan does not belong to company", async () => {
      const wrongPlan = { ...PLAN, companyId: "company-other" };
      const dbStub = createDbStub([[wrongPlan]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      await expect(
        svc.update("company-1", "plan-1", { monthlyCostCents: 30000 }),
      ).rejects.toThrow(/does not belong/i);
    });

    it("throws when plan is not found", async () => {
      const dbStub = createDbStub([[]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      await expect(
        svc.update("company-1", "missing", { monthlyCostCents: 30000 }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("delete", () => {
    it("deletes a plan and returns the original", async () => {
      const dbStub = createDbStub([[PLAN]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.delete("company-1", "plan-1");
      expect(result).toEqual(PLAN);
    });

    it("throws when plan does not belong to company", async () => {
      const wrongPlan = { ...PLAN, companyId: "company-other" };
      const dbStub = createDbStub([[wrongPlan]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      await expect(svc.delete("company-1", "plan-1")).rejects.toThrow(
        /does not belong/i,
      );
    });
  });

  describe("findActivePlan", () => {
    it("prefers agent-specific plan over company-wide plan", async () => {
      const companyWidePlan = { ...PLAN, id: "plan-cw", agentId: null };
      const agentPlan = { ...PLAN, id: "plan-agent", agentId: "agent-1" };

      const dbStub = createDbStub([[agentPlan, companyWidePlan]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.findActivePlan("company-1", "agent-1", "anthropic");
      expect(result?.id).toBe("plan-agent");
    });

    it("falls back to company-wide plan when no agent-specific plan exists", async () => {
      const companyWidePlan = { ...PLAN, id: "plan-cw", agentId: null };

      const dbStub = createDbStub([[companyWidePlan]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.findActivePlan("company-1", "agent-1", "anthropic");
      expect(result?.id).toBe("plan-cw");
    });

    it("returns null when no plans match", async () => {
      const dbStub = createDbStub([[]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.findActivePlan("company-1", "agent-1", "anthropic");
      expect(result).toBeNull();
    });
  });

  describe("totalMonthlyCostCents", () => {
    it("returns summed cost from SQL query", async () => {
      const dbStub = createDbStub([[{ total: 45000 }]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.totalMonthlyCostCents("company-1");
      expect(result).toBe(45000);
    });

    it("returns 0 when no active plans exist", async () => {
      const dbStub = createDbStub([[{ total: 0 }]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.totalMonthlyCostCents("company-1");
      expect(result).toBe(0);
    });
  });

  describe("agentEffectiveCostCents", () => {
    it("prorates a plan to the full month when active entire month", async () => {
      const monthStart = new Date("2026-03-01T00:00:00Z");
      const monthEnd = new Date("2026-04-01T00:00:00Z");
      const plan = {
        ...PLAN,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveUntil: null,
        monthlyCostCents: 31000,
        seatCount: 1,
      };

      const dbStub = createDbStub([[plan]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.agentEffectiveCostCents(
        "company-1", "agent-1", monthStart, monthEnd,
      );
      expect(result).toBe(31000);
    });

    it("prorates when plan is only active for part of the month", async () => {
      const monthStart = new Date("2026-03-01T00:00:00Z");
      const monthEnd = new Date("2026-04-01T00:00:00Z");
      const plan = {
        ...PLAN,
        effectiveFrom: new Date("2026-03-16T00:00:00Z"),
        effectiveUntil: null,
        monthlyCostCents: 31000,
        seatCount: 1,
      };

      const dbStub = createDbStub([[plan]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.agentEffectiveCostCents(
        "company-1", "agent-1", monthStart, monthEnd,
      );
      // 16 active days out of 31: round(31000 * 16 / 31) = 16000
      expect(result).toBe(16000);
    });

    it("returns 0 when no matching plans", async () => {
      const monthStart = new Date("2026-03-01T00:00:00Z");
      const monthEnd = new Date("2026-04-01T00:00:00Z");

      const dbStub = createDbStub([[]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.agentEffectiveCostCents(
        "company-1", "agent-1", monthStart, monthEnd,
      );
      expect(result).toBe(0);
    });

    it("divides company-wide plan cost by seat count", async () => {
      const monthStart = new Date("2026-03-01T00:00:00Z");
      const monthEnd = new Date("2026-04-01T00:00:00Z");
      const plan = {
        ...PLAN,
        agentId: null,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveUntil: null,
        monthlyCostCents: 60000,
        seatCount: 3,
      };

      const dbStub = createDbStub([[plan]]);
      const svc = subscriptionPlanService(dbStub.db as any);

      const result = await svc.agentEffectiveCostCents(
        "company-1", "agent-1", monthStart, monthEnd,
      );
      expect(result).toBe(20000);
    });
  });
});
