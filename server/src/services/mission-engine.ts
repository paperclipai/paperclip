import { setup } from "xstate";
import { eq, and, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { missions, missionApprovalRules, approvals } from "@paperclipai/db";
import type { CreateMission, UpdateMission } from "@paperclipai/shared";

// ─── State Machine ────────────────────────────────────────────────────────────

export function createMissionMachine() {
  return setup({
    types: {} as { events: MissionEvent },
  }).createMachine({
    id: "mission",
    initial: "draft",
    states: {
      draft:      { on: { LAUNCH: "active" } },
      active:     { on: { PAUSE: "paused", COMPLETE: "completed", FAIL: "failed" } },
      paused:     { on: { RESUME: "active", FAIL: "failed" } },
      completed:  { type: "final" },
      failed:     { type: "final" },
    },
  });
}

type MissionEvent =
  | { type: "LAUNCH" } | { type: "PAUSE" } | { type: "RESUME" }
  | { type: "COMPLETE" } | { type: "FAIL" };

// Valid transitions map (used for DB-only updates without running actor)
const VALID_TRANSITIONS: Record<string, string[]> = {
  draft:    ["active"],
  active:   ["paused", "completed", "failed"],
  paused:   ["active", "failed"],
  completed: [],
  failed:   [],
};

// ─── Default approval rules seeded on mission creation ───────────────────────

export const DEFAULT_APPROVAL_RULES = [
  { actionType: "code_fix",            riskTier: "green",  autoApproveAfterMin: null },
  { actionType: "write_test",          riskTier: "green",  autoApproveAfterMin: null },
  { actionType: "write_doc",           riskTier: "green",  autoApproveAfterMin: null },
  { actionType: "read_analytics",      riskTier: "green",  autoApproveAfterMin: null },
  { actionType: "read_revenue",        riskTier: "green",  autoApproveAfterMin: null },
  { actionType: "staging_deploy",      riskTier: "yellow", autoApproveAfterMin: 60  },
  { actionType: "dependency_update",   riskTier: "yellow", autoApproveAfterMin: 60  },
  { actionType: "social_post_draft",   riskTier: "yellow", autoApproveAfterMin: 30  },
  { actionType: "social_post_publish", riskTier: "yellow", autoApproveAfterMin: 30  },
  { actionType: "email_campaign",      riskTier: "yellow", autoApproveAfterMin: 120 },
  { actionType: "production_deploy",   riskTier: "red",    autoApproveAfterMin: null },
  { actionType: "user_data_change",    riskTier: "red",    autoApproveAfterMin: null },
  { actionType: "paid_integration",    riskTier: "red",    autoApproveAfterMin: null },
  { actionType: "pricing_change",      riskTier: "red",    autoApproveAfterMin: null },
  { actionType: "crypto_payout",       riskTier: "red",    autoApproveAfterMin: null },
  { actionType: "delete_data",         riskTier: "red",    autoApproveAfterMin: null },
];

// ─── Service ──────────────────────────────────────────────────────────────────

export function missionEngine(db: Db) {
  return {
    async create(companyId: string, createdBy: string, data: CreateMission) {
      const { expiresAt, budgetCapUsd, ...otherData } = data;
      
      const [mission] = await db.insert(missions).values({
        companyId,
        createdBy,
        ...otherData,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        budgetCapUsd: budgetCapUsd ? budgetCapUsd.toString() : null,
        objectives: data.objectives,
      }).returning();

      await db.insert(missionApprovalRules).values(
        DEFAULT_APPROVAL_RULES.map(r => ({ ...r, missionId: mission.id }))
      );

      return mission;
    },

    async list(companyId: string) {
      return db.select().from(missions).where(eq(missions.companyId, companyId));
    },

    async get(missionId: string) {
      const [mission] = await db.select().from(missions).where(eq(missions.id, missionId));
      return mission ?? null;
    },

    async transition(missionId: string, event: "LAUNCH" | "PAUSE" | "RESUME" | "COMPLETE" | "FAIL") {
      const mission = await this.get(missionId);
      if (!mission) throw new Error(`Mission ${missionId} not found`);

      const statusMap: Record<string, string> = {
        LAUNCH: "active", PAUSE: "paused", RESUME: "active",
        COMPLETE: "completed", FAIL: "failed",
      };
      const nextStatus = statusMap[event];

      if (!VALID_TRANSITIONS[mission.status]?.includes(nextStatus)) {
        throw new Error(`Cannot transition from ${mission.status} to ${nextStatus}`);
      }

      const updates: Record<string, unknown> = { status: nextStatus, updatedAt: new Date() };
      if (event === "LAUNCH") updates.startedAt = new Date();
      if (event === "COMPLETE" || event === "FAIL") updates.completedAt = new Date();

      const [updated] = await db.update(missions).set(updates)
        .where(eq(missions.id, missionId)).returning();
      return updated;
    },

    async update(missionId: string, data: UpdateMission) {
      const { expiresAt, budgetCapUsd, ...otherData } = data;
      
      const [updated] = await db.update(missions)
        .set({ 
          ...otherData, 
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          budgetCapUsd: budgetCapUsd ? budgetCapUsd.toString() : null,
          updatedAt: new Date() 
        })
        .where(eq(missions.id, missionId)).returning();
      return updated;
    },

    async delete(missionId: string) {
      await db.delete(missions).where(eq(missions.id, missionId));
    },

    async getBudgetSpent(missionId: string): Promise<number> {
      // Aggregate cost_events linked to this mission's date range
      const mission = await this.get(missionId);
      if (!mission?.startedAt) return 0;
      const result = await db.execute(sql`
        SELECT COALESCE(SUM(total_cost_usd), 0) as spent
        FROM cost_events
        WHERE company_id = ${mission.companyId}
          AND created_at >= ${mission.startedAt}
      `);
      const row = result[0] as { spent: string } | undefined;
      return Number(row?.spent ?? 0);
    },

    async evaluateRiskTier(missionId: string, actionType: string): Promise<{
      riskTier: string; autoApproveAfterMin: number | null;
    }> {
      const [rule] = await db.select().from(missionApprovalRules)
        .where(and(
          eq(missionApprovalRules.missionId, missionId),
          eq(missionApprovalRules.actionType, actionType)
        ));
      return rule
        ? { riskTier: rule.riskTier, autoApproveAfterMin: rule.autoApproveAfterMin }
        : { riskTier: "yellow", autoApproveAfterMin: 60 }; // safe default
    },
  };
}
