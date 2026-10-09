import type { LifecycleEffects } from "./effects.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, agentApiKeys, type Db } from "@paperclipai/db";
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
        const prepared = await effects.prepareHire(txDb, companyId, data, options);
        const created = await tx
          .insert(agents)
          .values({
            ...prepared,
            lifecycleState: data.status === "pending_approval" ? "pending_approval" : data.status === "terminated" ? "terminated" : data.status === "paused" ? "paused" : "preparing",
            lifecycleVersion: 1,
            lifecycleHolds: data.status === "paused" ? [data.pauseReason ?? "manual"] : [],
            pauseReason: data.status === "paused" ? data.pauseReason ?? "manual" : null,
            pausedAt: data.status === "paused" ? new Date() : null,
            lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0, resumeState: "preparing", responsibleUserId: options?.responsibleUserId ?? options?.createdByUserId },
            status: data.status === "pending_approval" ? "pending_approval" : data.status === "terminated" ? "terminated" : "paused",
            companyId,
          })
          .returning()
          .then((rows) => rows[0]);
        await effects.initializeHire(txDb, created, options);
        if (created.status !== "pending_approval" && created.status !== "terminated") {
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
        const updated = await tx
          .update(agents)
          .set({ ...patch, status: "paused", lifecycleState: "preparing", lifecycleVersion: existing.lifecycleVersion + 1, lifecycleError: null, lifecycleOperation: sql`jsonb_build_object('id', ${randomUUID()}::text, 'hostComplete', false, 'completedPluginIds', '[]'::jsonb, 'attempts', 0, 'responsibleUserId', coalesce(nullif(${agents.lifecycleOperation}->'responsibleUserId', 'null'::jsonb), to_jsonb(${requestedByUserId ?? null}::text)))`, updatedAt: new Date() })
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
