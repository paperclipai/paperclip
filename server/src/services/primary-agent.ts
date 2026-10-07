import { and, eq } from "drizzle-orm";
import { agents, userCompanyPreferences, type Db } from "@paperclipai/db";
import type { PrimaryAgentPreference } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { resourceMembershipService } from "./resource-memberships.js";

const preferenceWhere = (companyId: string, userId: string) => and(
  eq(userCompanyPreferences.companyId, companyId), eq(userCompanyPreferences.userId, userId),
);

/** Call inside the transaction that creates the human's agent. The unique key
 * arbitrates concurrent first creations; an explicit or cleared choice wins. */
export async function initializePrimaryAgent(db: Db, companyId: string, userId: string, agentId: string) {
  const [row] = await db.insert(userCompanyPreferences).values({
    companyId, userId, primaryAgentId: agentId, primaryAgentInitialized: true,
  }).onConflictDoUpdate({
    target: [userCompanyPreferences.companyId, userCompanyPreferences.userId],
    set: { primaryAgentId: agentId, primaryAgentInitialized: true, updatedAt: new Date() },
    setWhere: eq(userCompanyPreferences.primaryAgentInitialized, false),
  }).returning();
  if (row) await persistActivity(db, {
    companyId, actorType: "user", actorId: userId, action: "primary_agent.initialized",
    entityType: "agent", entityId: agentId, details: { primaryAgentId: agentId },
  });
}

/** Keep initialization sticky when the primary leaves or is terminated. */
export async function clearPrimaryAgent(db: Db, companyId: string, agentId: string, userId?: string) {
  const rows = await db.update(userCompanyPreferences).set({
    primaryAgentId: null, updatedAt: new Date(),
  }).where(and(
    eq(userCompanyPreferences.companyId, companyId), eq(userCompanyPreferences.primaryAgentId, agentId),
    userId ? eq(userCompanyPreferences.userId, userId) : undefined,
  )).returning();
  for (const row of rows) await persistActivity(db, {
    companyId, actorType: "system", actorId: "primary-agent-lifecycle", action: "primary_agent.cleared",
    entityType: "agent", entityId: agentId,
    details: { userId: row.userId, previousPrimaryAgentId: agentId },
  });
}

export function primaryAgentService(db: Db) {
  async function get(companyId: string, userId: string): Promise<PrimaryAgentPreference> {
    const row = await db.query.userCompanyPreferences.findFirst({ where: preferenceWhere(companyId, userId) });
    return { companyId, userId, primaryAgentId: row?.primaryAgentId ?? null, initialized: row?.primaryAgentInitialized ?? false };
  }
  return {
    get,
    async set(companyId: string, userId: string, agentId: string, actor: Express.Request["actor"]) {
      const result = await db.transaction(async tx => {
        const txDb = tx as unknown as Db;
        // Same lock order as leave/termination: agent, then preference. A racing
        // lifecycle change cannot leave a newly crowned unavailable agent.
        const [agent] = await tx.select().from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("update");
        if (!agent) throw notFound("Agent not found");
        if (agent.status === "terminated" || agent.status === "pending_approval") {
          throw unprocessable("Choose an active, approved agent as your primary.");
        }
        await resourceMembershipService(txDb).updateAgent({ companyId, userId, agentId, state: "joined", actor });
        // Serialize personal changes even when they target different agents, so
        // the audit trail records the primary that this choice actually replaced.
        await tx.insert(userCompanyPreferences).values({ companyId, userId }).onConflictDoNothing();
        await tx.select().from(userCompanyPreferences).where(preferenceWhere(companyId, userId)).for("update");
        const previous = await primaryAgentService(txDb).get(companyId, userId);
        await tx.insert(userCompanyPreferences).values({
          companyId, userId, primaryAgentId: agentId, primaryAgentInitialized: true,
        }).onConflictDoUpdate({
          target: [userCompanyPreferences.companyId, userCompanyPreferences.userId],
          set: { primaryAgentId: agentId, primaryAgentInitialized: true, updatedAt: new Date() },
        });
        const { publication } = await persistActivity(txDb, {
          companyId, actorType: "user", actorId: userId, action: "primary_agent.updated",
          entityType: "agent", entityId: agentId,
          details: { previousPrimaryAgentId: previous.primaryAgentId, primaryAgentId: agentId },
        });
        return { preference: await primaryAgentService(txDb).get(companyId, userId), publication };
      });
      publishActivity(result.publication);
      return result.preference;
    },
  };
}
