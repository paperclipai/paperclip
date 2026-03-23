import { eq, and, sql, count } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { revenueEvents, userMetricsSnapshots, issues, missions, approvals } from "@paperclipai/db";

export function agentMetricsService(db: Db) {
  return {
    async getMetrics(companyId: string) {
      // MRR: sum of last 30 days recurring revenue
      const mrrResult = await db.execute(sql`
        SELECT COALESCE(SUM(amount_usd), 0) as mrr
        FROM revenue_events
        WHERE company_id = ${companyId}
          AND type = 'subscription'
          AND created_at >= NOW() - INTERVAL '30 days'
      `);
      const mrrRow = mrrResult[0] as { mrr: string } | undefined;

      // User count: latest snapshot
      const [latestSnapshot] = await db.select()
        .from(userMetricsSnapshots)
        .where(eq(userMetricsSnapshots.companyId, companyId))
        .orderBy(sql`created_at DESC`)
        .limit(1);

      // Open bugs
      const [bugCount] = await db.select({ count: count() })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.status, "open"),
          sql`labels @> '["bug"]'`
        ));

      return {
        mrrUsd: Number(mrrRow?.mrr ?? 0),
        userCount: latestSnapshot?.totalUsers ?? 0,
        openBugs: bugCount?.count ?? 0,
      };
    },

    async getActiveMission(companyId: string) {
      const [mission] = await db.select()
        .from(missions)
        .where(and(eq(missions.companyId, companyId), eq(missions.status, "active")));

      if (!mission) return { active: false };

      return {
        active: true,
        missionId: mission.id,
        title: mission.title,
        objectives: mission.objectives,
        autonomyLevel: mission.autonomyLevel,
        budgetCapUsd: mission.budgetCapUsd ? Number(mission.budgetCapUsd) : null,
        startedAt: mission.startedAt,
      };
    },

    async proposeAction(companyId: string, missionId: string, opts: {
      actionType: string; description: string; impactSummary: string;
    }) {
      const { missionEngine } = await import("./mission-engine.js");
      const engine = missionEngine(db);
      const { riskTier, autoApproveAfterMin } = await engine.evaluateRiskTier(missionId, opts.actionType);

      if (riskTier === "green") {
        return { approved: true, riskTier };
      }

      // Create approval request
      const autoApproveAt = autoApproveAfterMin
        ? new Date(Date.now() + autoApproveAfterMin * 60 * 1000)
        : null;

      const [approval] = await db.insert(approvals).values({
        companyId,
        type: opts.actionType,
        status: "pending",
        payload: { description: opts.description, impactSummary: opts.impactSummary, missionId },
        actionType: opts.actionType,
        riskTier,
        autoApproveAt,
        missionId,
      }).returning();

      if (autoApproveAt && autoApproveAfterMin) {
        const { enqueueApproveTimer } = await import("../services/jobs/approve-timer.js");
        await enqueueApproveTimer(approval.id, companyId, autoApproveAfterMin);
      }

      return {
        approved: false,
        riskTier,
        pendingId: approval.id,
        autoApproveAt,
      };
    },
  };
}
