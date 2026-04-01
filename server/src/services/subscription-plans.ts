import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, subscriptionPlans } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

export function subscriptionPlanService(db: Db) {
  return {
    list: async (companyId: string) => {
      return db
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.companyId, companyId))
        .orderBy(desc(subscriptionPlans.updatedAt));
    },

    getById: async (planId: string) => {
      const plan = await db
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, planId))
        .then((rows) => rows[0] ?? null);
      if (!plan) throw notFound("Subscription plan not found");
      return plan;
    },

    create: async (
      companyId: string,
      data: {
        agentId?: string | null;
        provider: string;
        biller: string;
        monthlyCostCents: number;
        seatCount?: number;
        effectiveFrom?: string;
        effectiveUntil?: string | null;
      },
    ) => {
      if (data.agentId) {
        const agent = await db
          .select()
          .from(agents)
          .where(eq(agents.id, data.agentId))
          .then((rows) => rows[0] ?? null);
        if (!agent) throw notFound("Agent not found");
        if (agent.companyId !== companyId) {
          throw unprocessable("Agent does not belong to company");
        }
      }

      return db
        .insert(subscriptionPlans)
        .values({
          companyId,
          agentId: data.agentId ?? null,
          provider: data.provider,
          biller: data.biller,
          monthlyCostCents: data.monthlyCostCents,
          seatCount: data.seatCount ?? 1,
          effectiveFrom: data.effectiveFrom ? new Date(data.effectiveFrom) : new Date(),
          effectiveUntil: data.effectiveUntil ? new Date(data.effectiveUntil) : null,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    update: async (
      companyId: string,
      planId: string,
      data: {
        monthlyCostCents?: number;
        seatCount?: number;
        effectiveUntil?: string | null;
        isActive?: boolean;
      },
    ) => {
      const existing = await db
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, planId))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Subscription plan not found");
      if (existing.companyId !== companyId) {
        throw unprocessable("Plan does not belong to company");
      }

      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (data.monthlyCostCents !== undefined) set.monthlyCostCents = data.monthlyCostCents;
      if (data.seatCount !== undefined) set.seatCount = data.seatCount;
      if (data.effectiveUntil !== undefined) {
        set.effectiveUntil = data.effectiveUntil ? new Date(data.effectiveUntil) : null;
      }
      if (data.isActive !== undefined) set.isActive = data.isActive;

      return db
        .update(subscriptionPlans)
        .set(set)
        .where(eq(subscriptionPlans.id, planId))
        .returning()
        .then((rows) => rows[0]);
    },

    delete: async (companyId: string, planId: string) => {
      const existing = await db
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, planId))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Subscription plan not found");
      if (existing.companyId !== companyId) {
        throw unprocessable("Plan does not belong to company");
      }

      await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
      return existing;
    },

    /** Find active plans matching an agent+provider at a given point in time. */
    findActivePlan: async (
      companyId: string,
      agentId: string,
      provider: string,
      at: Date = new Date(),
    ) => {
      const rows = await db
        .select()
        .from(subscriptionPlans)
        .where(
          and(
            eq(subscriptionPlans.companyId, companyId),
            eq(subscriptionPlans.isActive, true),
            eq(subscriptionPlans.provider, provider),
            lte(subscriptionPlans.effectiveFrom, at),
            or(
              isNull(subscriptionPlans.effectiveUntil),
              gte(subscriptionPlans.effectiveUntil, at),
            ),
            or(
              eq(subscriptionPlans.agentId, agentId),
              isNull(subscriptionPlans.agentId),
            ),
          ),
        )
        .orderBy(subscriptionPlans.agentId);

      // prefer agent-specific plan over company-wide plan
      return rows.find((r) => r.agentId === agentId) ?? rows[0] ?? null;
    },

    /** Sum of monthly subscription cost for active plans in a company (prorated to a window). */
    totalMonthlyCostCents: async (companyId: string) => {
      const [row] = await db
        .select({
          total: sql<number>`coalesce(sum(${subscriptionPlans.monthlyCostCents}), 0)::int`,
        })
        .from(subscriptionPlans)
        .where(
          and(
            eq(subscriptionPlans.companyId, companyId),
            eq(subscriptionPlans.isActive, true),
          ),
        );
      return Number(row?.total ?? 0);
    },

    /** Sum of prorated subscription cost for a specific agent during a calendar month. */
    agentEffectiveCostCents: async (
      companyId: string,
      agentId: string,
      monthStart: Date,
      monthEnd: Date,
    ) => {
      const rows = await db
        .select()
        .from(subscriptionPlans)
        .where(
          and(
            eq(subscriptionPlans.companyId, companyId),
            eq(subscriptionPlans.isActive, true),
            or(
              eq(subscriptionPlans.agentId, agentId),
              isNull(subscriptionPlans.agentId),
            ),
            lte(subscriptionPlans.effectiveFrom, monthEnd),
            or(
              isNull(subscriptionPlans.effectiveUntil),
              gte(subscriptionPlans.effectiveUntil, monthStart),
            ),
          ),
        );

      if (rows.length === 0) return 0;

      const daysInMonth = (monthEnd.getTime() - monthStart.getTime()) / (24 * 60 * 60 * 1000);
      let total = 0;
      for (const plan of rows) {
        const start = plan.effectiveFrom > monthStart ? plan.effectiveFrom : monthStart;
        const end = plan.effectiveUntil && plan.effectiveUntil < monthEnd ? plan.effectiveUntil : monthEnd;
        const activeDays = Math.max(0, (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
        const perSeatShare = plan.agentId ? plan.monthlyCostCents : Math.round(plan.monthlyCostCents / Math.max(1, plan.seatCount));
        total += Math.round((perSeatShare * activeDays) / daysInMonth);
      }
      return total;
    },

    /** All active plans in a company — used by the auto-finance job. */
    listActive: async (companyId?: string) => {
      const conditions = [eq(subscriptionPlans.isActive, true)];
      if (companyId) conditions.push(eq(subscriptionPlans.companyId, companyId));
      return db
        .select()
        .from(subscriptionPlans)
        .where(and(...conditions))
        .orderBy(subscriptionPlans.companyId, subscriptionPlans.provider);
    },
  };
}
