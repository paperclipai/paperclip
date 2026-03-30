import type { Db } from "@paperclipai/db";
import { assets, companySubscriptions, issues, projects, subscriptionPlans, agents } from "@paperclipai/db";
import { eq, count, sql } from "drizzle-orm";
import { HttpError } from "../errors.js";

interface PlanQuotas {
  maxAgents: number | null;
  maxIssues: number | null;
  maxProjects: number | null;
  maxStorageBytes: number | null;
}

export function planLimits(db: Db) {
  async function getPlanQuotas(companyId: string): Promise<PlanQuotas | null> {
    try {
      return await db
        .select({
          maxAgents: subscriptionPlans.maxAgents,
          maxIssues: subscriptionPlans.maxIssues,
          maxProjects: subscriptionPlans.maxProjects,
          maxStorageBytes: subscriptionPlans.maxStorageBytes,
        })
        .from(companySubscriptions)
        .innerJoin(subscriptionPlans, eq(companySubscriptions.planId, subscriptionPlans.id))
        .where(eq(companySubscriptions.companyId, companyId))
        .then((rows) => rows[0] ?? null);
    } catch {
      return null;
    }
  }

  return {
    async checkAgentLimit(companyId: string): Promise<void> {
      const quotas = await getPlanQuotas(companyId);
      if (!quotas || quotas.maxAgents === null) return;

      const [row] = await db.select({ count: count() }).from(agents).where(eq(agents.companyId, companyId));
      if (Number(row?.count ?? 0) >= quotas.maxAgents) {
        throw new HttpError(402, `Agent limit reached (${quotas.maxAgents}) for your current plan. Upgrade to add more agents.`);
      }
    },

    async checkIssueLimit(companyId: string): Promise<void> {
      const quotas = await getPlanQuotas(companyId);
      if (!quotas || quotas.maxIssues === null) return;

      const [row] = await db.select({ count: count() }).from(issues).where(eq(issues.companyId, companyId));
      if (Number(row?.count ?? 0) >= quotas.maxIssues) {
        throw new HttpError(402, `Issue limit reached (${quotas.maxIssues}) for your current plan.`);
      }
    },

    async checkProjectLimit(companyId: string): Promise<void> {
      const quotas = await getPlanQuotas(companyId);
      if (!quotas || quotas.maxProjects === null) return;

      const [row] = await db.select({ count: count() }).from(projects).where(eq(projects.companyId, companyId));
      if (Number(row?.count ?? 0) >= quotas.maxProjects) {
        throw new HttpError(402, `Project limit reached (${quotas.maxProjects}) for your current plan.`);
      }
    },

    async checkStorageLimit(companyId: string): Promise<void> {
      const quotas = await getPlanQuotas(companyId);
      if (!quotas || quotas.maxStorageBytes === null) return;

      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${assets.byteSize}), 0)` })
        .from(assets)
        .where(eq(assets.companyId, companyId));
      const totalBytes = Number(row?.total ?? 0);
      const maxBytes = Number(quotas.maxStorageBytes);
      if (totalBytes >= maxBytes) {
        const maxMb = Math.round(maxBytes / (1024 * 1024));
        throw new HttpError(402, `Storage limit reached (${maxMb}MB) for your current plan.`);
      }
    },
  };
}
