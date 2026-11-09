import type { LifecycleEffects } from "./effects.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, agentApiKeys, companies, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../../../errors.js";
import { agentRecordQueries, type CreateAgentOptions, type CreateAgentData } from "../../../lib/agent-records.js";

export function agentRecords(db: Db, effects: LifecycleEffects) {
  const { getById } = agentRecordQueries(db);

  return {
    getById,
    create: async (companyId: string, data: CreateAgentData, options?: CreateAgentOptions) => {
      if (Object.keys(data).some(key => key.startsWith("lifecycle"))) throw conflict("Lifecycle fields belong to the lifecycle module");
      return effects.transaction(db, companyId, async (txDb) => {
        const tx = txDb;
        const setupId = options?.setupAgentId ?? (options?.setupOnly ? data.id : undefined);
        const [setup] = setupId ? await tx.select().from(agents).where(eq(agents.id, setupId)).for("update") : [];
        if (setup && setup.companyId !== companyId) {
          throw conflict("Agent setup is no longer available");
        }
        if (options?.setupOnly && setup) {
          if (setup.createdByUserId !== (options.createdByUserId ?? null)) throw notFound("Agent setup not found");
          const existing = await agentRecordQueries(txDb).getById(setup.id);
          if (!existing) throw notFound("Agent setup not found");
          return existing;
        }
        if (setup && (setup.lifecycleState !== "paused" || !setup.lifecycleHolds.includes("setup"))) {
          throw conflict("Agent setup is no longer available");
        }
        if (options?.setupAgentId && !setup) throw notFound("Agent setup not found");
        const prepared = await effects.prepareHire(txDb, companyId, data, options);
        const status = options?.setupOnly ? "paused" : data.status;
        const pauseReason = options?.setupOnly ? "setup" : data.pauseReason;
        const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
        const companyHolds = company?.status === "paused" ? ["company_paused"] : company?.status === "archived" ? ["company_archived"] : [];
        const holds = [...(status === "paused" ? [pauseReason ?? "manual"] : []), ...companyHolds];
        const lifecycleState = status === "pending_approval" ? "pending_approval" : status === "terminated" ? "terminated"
          : status === "paused" ? "paused" : companyHolds.length ? "pausing" : "preparing";
        if (lifecycleState === "preparing" || lifecycleState === "pausing") await effects.notifyWork(tx);
        const values: typeof agents.$inferInsert = {
          ...prepared,
          createdByUserId: setup?.createdByUserId ?? options?.createdByUserId ?? null,
          lifecycleState,
          lifecycleVersion: setup ? setup.lifecycleVersion + 1 : 1,
          lifecycleHolds: holds,
          pauseReason: holds[0] ?? null,
          pausedAt: holds.length ? new Date() : null,
          lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0, resumeState: "preparing" as const, responsibleUserId: options?.responsibleUserId ?? options?.createdByUserId },
          status: status === "pending_approval" ? "pending_approval" : status === "terminated" ? "terminated" : "paused",
          companyId,
        };
        const created = await (options?.setupAgentId
          ? tx.update(agents).set({ ...values, updatedAt: new Date() }).where(eq(agents.id, options.setupAgentId))
          : tx.insert(agents).values(values))
          .returning()
          .then((rows) => rows[0]);
        await effects.initializeHire(txDb, created, options);
        if (!options?.setupOnly && created.status !== "pending_approval" && created.status !== "terminated") {
          await effects.recordCreation(txDb, companyId, created.id);
        }
        const normalizedCreated = await agentRecordQueries(txDb).getById(created.id);
        if (!normalizedCreated) {
          throw notFound("Agent not found");
        }
        return normalizedCreated;
      });
    },

    clearError: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot clear error on terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot have errors cleared");
      }
      if (existing.status !== "error") {
        throw conflict("Only agents in error status can have their error cleared");
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, id), eq(agents.status, "error"), eq(agents.lifecycleState, "ready")))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) {
        throw conflict("Only agents in error status can have their error cleared");
      }
      return getById(updated.id);
    },

    rejectPendingHire: async (id: string) => {
      const rows = await db.update(agents).set({ status: "terminated", lifecycleState: "rejected",
        lifecycleVersion: sql`${agents.lifecycleVersion} + 1`, lifecycleOperation: null,
        updatedAt: new Date() }).where(and(eq(agents.id, id), eq(agents.lifecycleState, "pending_approval"))).returning();
      for (const row of rows) {
        await effects.clearPrimary(db, row.companyId, id);
        await db.update(agentApiKeys).set({ revokedAt: new Date() }).where(eq(agentApiKeys.agentId, id));
        await effects.recordStatus(db, row.companyId, id, "pending_approval", "terminated");
      }
      return rows;
    },

    activatePendingApproval: async (id: string, approvedPayload?: Record<string, unknown> | null, requestedByUserId?: string | null) => {
      const activatedAgent = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const existing = await agentRecordQueries(txDb).getById(id);
        if (!existing || existing.status !== "pending_approval") return null;
        const patch = await effects.prepareHireApproval(txDb, existing, approvedPayload);
        const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, existing.companyId));
        const holds = existing.lifecycleHolds.filter(hold => hold !== "company_paused" && hold !== "company_archived");
        if (company?.status === "paused") holds.push("company_paused");
        if (company?.status === "archived") holds.push("company_archived");
        await effects.notifyWork(txDb);
        const updated = await tx
          .update(agents)
          .set({ ...patch, status: "paused", lifecycleState: holds.length ? "pausing" : "preparing", lifecycleHolds: holds, pauseReason: holds[0] ?? null, lifecycleVersion: existing.lifecycleVersion + 1, lifecycleError: null, lifecycleOperation: sql`jsonb_build_object('id', ${randomUUID()}::text, 'hostComplete', false, 'completedPluginIds', '[]'::jsonb, 'attempts', 0, 'responsibleUserId', coalesce(nullif(${agents.lifecycleOperation}->'responsibleUserId', 'null'::jsonb), to_jsonb(${requestedByUserId ?? null}::text)))`, updatedAt: new Date() })
          .where(and(eq(agents.id, id), eq(agents.status, "pending_approval")))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        await effects.completeHireApproval(txDb, updated, existing);
        await effects.recordCreation(txDb, existing.companyId, updated.id);
        const agent = await agentRecordQueries(txDb).getById(updated.id);
        if (!agent) {
          throw notFound("Agent not found");
        }
        return agent;
      });

      if (activatedAgent) {
        return { agent: activatedAgent, activated: true };
      }

      const existing = await getById(id);
      return existing ? { agent: existing, activated: false } : null;
    },

  };
}
