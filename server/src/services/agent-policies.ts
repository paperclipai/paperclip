import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentPolicies, agentPolicyRevisions, agents as agentsTable } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";

export interface AgentPolicy {
  id: string;
  companyId: string;
  agentId: string;
  key: string;
  title: string;
  format: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  scope: string;
  scopeId: string | null;
  active: boolean;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentPolicyRevision {
  id: string;
  policyId: string;
  revisionNumber: number;
  title: string;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

function rowToPolicy(row: typeof agentPolicies.$inferSelect): AgentPolicy {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    key: row.key,
    title: row.title,
    format: row.format,
    latestBody: row.latestBody,
    latestRevisionId: row.latestRevisionId ?? null,
    latestRevisionNumber: row.latestRevisionNumber,
    scope: row.scope,
    scopeId: row.scopeId ?? null,
    active: row.active,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToRevision(row: typeof agentPolicyRevisions.$inferSelect): AgentPolicyRevision {
  return {
    id: row.id,
    policyId: row.policyId,
    revisionNumber: row.revisionNumber,
    title: row.title,
    body: row.body,
    changeSummary: row.changeSummary ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
  };
}

export function agentPoliciesService(db: Db) {
  return {
    listPolicies: async (
      agentId: string,
      filters?: { active?: boolean; scope?: string },
    ): Promise<AgentPolicy[]> => {
      const conditions = [eq(agentPolicies.agentId, agentId)];
      if (filters?.active !== undefined) {
        conditions.push(eq(agentPolicies.active, filters.active));
      }
      if (filters?.scope !== undefined) {
        conditions.push(eq(agentPolicies.scope, filters.scope));
      }
      const rows = await db
        .select()
        .from(agentPolicies)
        .where(and(...conditions))
        .orderBy(desc(agentPolicies.updatedAt));
      return rows.map(rowToPolicy);
    },

    getPolicy: async (agentId: string, key: string): Promise<AgentPolicy | null> => {
      const rows = await db
        .select()
        .from(agentPolicies)
        .where(and(eq(agentPolicies.agentId, agentId), eq(agentPolicies.key, key)));
      return rows[0] ? rowToPolicy(rows[0]) : null;
    },

    upsertPolicy: async (
      agentId: string,
      key: string,
      input: {
        title: string;
        format?: string;
        body: string;
        changeSummary?: string | null;
        baseRevisionId?: string | null;
        scope?: string;
        scopeId?: string | null;
        createdByAgentId?: string | null;
        createdByUserId?: string | null;
      },
    ): Promise<{ created: boolean; policy: AgentPolicy }> => {
      return await db.transaction(async (tx) => {
        const now = new Date();
        const existing = await tx
          .select()
          .from(agentPolicies)
          .where(and(eq(agentPolicies.agentId, agentId), eq(agentPolicies.key, key)))
          .then((rows) => rows[0] ?? null);

        if (existing) {
          if (!input.baseRevisionId) {
            throw conflict("Policy update requires baseRevisionId", {
              currentRevisionId: existing.latestRevisionId,
            });
          }
          if (input.baseRevisionId !== existing.latestRevisionId) {
            throw conflict("Policy was updated by someone else", {
              currentRevisionId: existing.latestRevisionId,
            });
          }

          const nextRevisionNumber = existing.latestRevisionNumber + 1;
          const [revision] = await tx
            .insert(agentPolicyRevisions)
            .values({
              policyId: existing.id,
              revisionNumber: nextRevisionNumber,
              title: input.title,
              body: input.body,
              changeSummary: input.changeSummary ?? null,
              createdByAgentId: input.createdByAgentId ?? null,
              createdByUserId: input.createdByUserId ?? null,
              createdAt: now,
            })
            .returning();

          const [updated] = await tx
            .update(agentPolicies)
            .set({
              title: input.title,
              format: input.format ?? existing.format,
              latestBody: input.body,
              latestRevisionId: revision.id,
              latestRevisionNumber: nextRevisionNumber,
              updatedByAgentId: input.createdByAgentId ?? null,
              updatedByUserId: input.createdByUserId ?? null,
              updatedAt: now,
            })
            .where(eq(agentPolicies.id, existing.id))
            .returning();

          return { created: false, policy: rowToPolicy(updated) };
        }

        // New policy — resolve companyId from agents table
        const agentRow = await tx
          .select({ companyId: agentsTable.companyId })
          .from(agentsTable)
          .where(eq(agentsTable.id, agentId))
          .then((rows) => rows[0] ?? null);
        if (!agentRow) throw notFound("Agent not found");

        const [policy] = await tx
          .insert(agentPolicies)
          .values({
            companyId: agentRow.companyId,
            agentId,
            key,
            title: input.title,
            format: input.format ?? "markdown",
            latestBody: input.body,
            latestRevisionId: null,
            latestRevisionNumber: 0,
            scope: input.scope ?? "agent",
            scopeId: input.scopeId ?? null,
            active: true,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const [revision] = await tx
          .insert(agentPolicyRevisions)
          .values({
            policyId: policy.id,
            revisionNumber: 1,
            title: input.title,
            body: input.body,
            changeSummary: input.changeSummary ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            createdAt: now,
          })
          .returning();

        const [final] = await tx
          .update(agentPolicies)
          .set({ latestRevisionId: revision.id, latestRevisionNumber: 1 })
          .where(eq(agentPolicies.id, policy.id))
          .returning();

        return { created: true, policy: rowToPolicy(final) };
      });
    },

    deactivatePolicy: async (agentId: string, key: string): Promise<AgentPolicy> => {
      const existing = await db
        .select()
        .from(agentPolicies)
        .where(and(eq(agentPolicies.agentId, agentId), eq(agentPolicies.key, key)))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Policy not found");

      const [updated] = await db
        .update(agentPolicies)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(agentPolicies.id, existing.id))
        .returning();

      return rowToPolicy(updated);
    },

    listRevisions: async (agentId: string, key: string): Promise<AgentPolicyRevision[]> => {
      const policy = await db
        .select()
        .from(agentPolicies)
        .where(and(eq(agentPolicies.agentId, agentId), eq(agentPolicies.key, key)))
        .then((rows) => rows[0] ?? null);
      if (!policy) throw notFound("Policy not found");

      const rows = await db
        .select()
        .from(agentPolicyRevisions)
        .where(eq(agentPolicyRevisions.policyId, policy.id))
        .orderBy(asc(agentPolicyRevisions.revisionNumber));

      return rows.map(rowToRevision);
    },

    rollbackPolicy: async (
      agentId: string,
      key: string,
      targetRevisionId: string,
      actor?: { agentId?: string | null; userId?: string | null },
    ): Promise<AgentPolicy> => {
      return await db.transaction(async (tx) => {
        const now = new Date();
        const existing = await tx
          .select()
          .from(agentPolicies)
          .where(and(eq(agentPolicies.agentId, agentId), eq(agentPolicies.key, key)))
          .then((rows) => rows[0] ?? null);
        if (!existing) throw notFound("Policy not found");

        const targetRevision = await tx
          .select()
          .from(agentPolicyRevisions)
          .where(
            and(
              eq(agentPolicyRevisions.id, targetRevisionId),
              eq(agentPolicyRevisions.policyId, existing.id),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!targetRevision) throw notFound("Revision not found");

        const nextRevisionNumber = existing.latestRevisionNumber + 1;
        const [revision] = await tx
          .insert(agentPolicyRevisions)
          .values({
            policyId: existing.id,
            revisionNumber: nextRevisionNumber,
            title: targetRevision.title,
            body: targetRevision.body,
            changeSummary: `Rollback to revision ${targetRevision.revisionNumber}`,
            createdByAgentId: actor?.agentId ?? null,
            createdByUserId: actor?.userId ?? null,
            createdAt: now,
          })
          .returning();

        const [updated] = await tx
          .update(agentPolicies)
          .set({
            title: targetRevision.title,
            latestBody: targetRevision.body,
            latestRevisionId: revision.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: actor?.agentId ?? null,
            updatedByUserId: actor?.userId ?? null,
            updatedAt: now,
          })
          .where(eq(agentPolicies.id, existing.id))
          .returning();

        return rowToPolicy(updated);
      });
    },

    getActivePoliciesForAgent: async (agentId: string): Promise<AgentPolicy[]> => {
      const rows = await db
        .select()
        .from(agentPolicies)
        .where(and(eq(agentPolicies.agentId, agentId), eq(agentPolicies.active, true)))
        .orderBy(asc(agentPolicies.createdAt));
      return rows.map(rowToPolicy);
    },
  };
}
