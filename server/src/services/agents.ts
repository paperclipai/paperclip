import { type BudgetServiceHooks } from "./budgets.js";

import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentConfigRevisions, agentApiKeys, heartbeatRuns } from "@paperclipai/db";
import { isUuidLike, normalizeAgentApiKeyScope, normalizeAgentUrlKey, type AgentApiKeyScope } from "@paperclipai/shared";

import { conflict, notFound, unprocessable } from "../errors.js";

import { normalizeAgentPermissions } from "../lib/agent-permissions.js";

import {
  agentRecordQueries,
  hashToken,
  createToken,
  containsRedactedMarker,
  configPatchFromSnapshot,
} from "../lib/agent-records.js";
import { createAgentLifecycle } from "./agent-lifecycle.js";
import { agentConfigurationService } from "./agent-configuration.js";

export { hasAgentShortnameCollision, deduplicateAgentName } from "../lib/agent-records.js";

export function agentService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  const {
    normalizeAgentRows,
    listCompanyAgentRows,
    hydrateAgentSpend,
    getById
  } = agentRecordQueries(db);
  const updateAgent = agentConfigurationService(db, budgetHooks).update;
  return {
    list: async (companyId: string, options?: { includeTerminated?: boolean }) => {
      const conditions = [eq(agents.companyId, companyId)];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const [rows, allCompanyRows] = await Promise.all([
        db.select().from(agents).where(and(...conditions)),
        listCompanyAgentRows(companyId),
      ]);
      const hydrated = await hydrateAgentSpend(rows);
      return normalizeAgentRows(hydrated, allCompanyRows);
    },

    getById,

    updatePermissions: async (id: string, permissions: Record<string, unknown> & { canCreateAgents: boolean }) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agent permissions cannot be changed before board approval", {
          code: "pending_approval_agent_config_frozen",
          agentId: id,
          fields: ["permissions"],
        });
      }

      const updated = await db
        .update(agents)
        .set({
          permissions: normalizeAgentPermissions({ ...existing.permissions, ...permissions }),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? getById(updated.id) : null;
    },

    listConfigRevisions: async (id: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(eq(agentConfigRevisions.agentId, id))
        .orderBy(desc(agentConfigRevisions.createdAt)),

    getConfigRevision: async (id: string, revisionId: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null),

    rollbackConfigRevision: async (
      id: string,
      revisionId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const revision = await db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null);
      if (!revision) return null;
      if (containsRedactedMarker(revision.afterConfig)) {
        throw unprocessable("Cannot roll back a revision that contains redacted secret values");
      }

      const patch = configPatchFromSnapshot(revision.afterConfig);
      return updateAgent(id, patch, {
        recordRevision: {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          source: "rollback",
          rolledBackFromRevisionId: revision.id,
        },
      });
    },

    createApiKey: async (
      id: string,
      name: string,
      scope: AgentApiKeyScope = { kind: "standard" },
      options?: { responsibleUserId?: string | null },
    ) => {
      const existing = await getById(id);
      if (!existing) throw notFound("Agent not found");
      if (existing.status === "pending_approval") {
        throw conflict("Cannot create keys for pending approval agents");
      }
      if (existing.status === "terminated") {
        throw conflict("Cannot create keys for terminated agents");
      }

      const token = createToken();
      const keyHash = hashToken(token);
      const created = await db
        .insert(agentApiKeys)
        .values({
          agentId: id,
          companyId: existing.companyId,
          name,
          keyHash,
          responsibleUserId: options?.responsibleUserId?.trim() || null,
          scopeConfig: scope.kind === "standard" ? null : scope,
        })
        .returning()
        .then((rows) => rows[0]);

      return {
        id: created.id,
        name: created.name,
        scope: normalizeAgentApiKeyScope(created.scopeConfig),
        responsibleUserId: created.responsibleUserId,
        token,
        createdAt: created.createdAt,
      };
    },

    listKeys: (id: string) =>
      db
        .select({
          id: agentApiKeys.id,
          name: agentApiKeys.name,
          responsibleUserId: agentApiKeys.responsibleUserId,
          scopeConfig: agentApiKeys.scopeConfig,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, id))
        .then((rows) => rows.map((row) => ({
          id: row.id,
          name: row.name,
          scope: normalizeAgentApiKeyScope(row.scopeConfig),
          responsibleUserId: row.responsibleUserId,
          createdAt: row.createdAt,
          revokedAt: row.revokedAt,
        }))),

    getKeyById: async (keyId: string) =>
      db
        .select({
          id: agentApiKeys.id,
          agentId: agentApiKeys.agentId,
          companyId: agentApiKeys.companyId,
          name: agentApiKeys.name,
          responsibleUserId: agentApiKeys.responsibleUserId,
          scopeConfig: agentApiKeys.scopeConfig,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.id, keyId))
        .then((rows) => {
          const row = rows[0] ?? null;
          return row
            ? {
              ...row,
              scope: normalizeAgentApiKeyScope(row.scopeConfig),
            }
            : null;
        }),

    revokeKey: async (agentId: string, keyId: string) => {
      const rows = await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(agentApiKeys.id, keyId), eq(agentApiKeys.agentId, agentId)))
        .returning();
      return rows[0] ?? null;
    },

    orgForCompany: async (companyId: string) => {
      const allCompanyRows = await listCompanyAgentRows(companyId);
      const rows = allCompanyRows.filter((row) => row.status !== "terminated");
      const normalizedRows = normalizeAgentRows(rows, allCompanyRows);
      const byManager = new Map<string | null, typeof normalizedRows>();
      for (const row of normalizedRows) {
        const key = row.reportsTo && rows.some((candidate) => candidate.id === row.reportsTo) ? row.reportsTo : null;
        const group = byManager.get(key) ?? [];
        group.push(row);
        byManager.set(key, group);
      }

      const build = (managerId: string | null): Array<Record<string, unknown>> => {
        const members = byManager.get(managerId) ?? [];
        return members.map((member) => ({
          ...member,
          reports: build(member.id),
        }));
      };

      return build(null);
    },

    getChainOfCommand: async (agentId: string) => {
      const chain: { id: string; name: string; role: string; title: string | null }[] = [];
      const visited = new Set<string>([agentId]);
      const start = await getById(agentId);
      let currentId = start?.reportsTo ?? null;
      while (currentId && !visited.has(currentId) && chain.length < 50) {
        visited.add(currentId);
        const mgr = await getById(currentId);
        if (!mgr) break;
        chain.push({ id: mgr.id, name: mgr.name, role: mgr.role, title: mgr.title ?? null });
        currentId = mgr.reportsTo ?? null;
      }
      return chain;
    },

    runningForAgent: (agentId: string) =>
      db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"]))),

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { agent: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const byId = await getById(raw);
        if (!byId || byId.companyId !== companyId) {
          return { agent: null, ambiguous: false } as const;
        }
        return { agent: byId, ambiguous: false } as const;
      }

      const urlKey = normalizeAgentUrlKey(raw);
      if (!urlKey) {
        return { agent: null, ambiguous: false } as const;
      }

      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const matches = normalizeAgentRows(rows, rows)
        .filter((agent) => agent.urlKey === urlKey && agent.status !== "terminated");
      if (matches.length === 1) {
        return { agent: matches[0] ?? null, ambiguous: false } as const;
      }
      if (matches.length > 1) {
        return { agent: null, ambiguous: true } as const;
      }
      return { agent: null, ambiguous: false } as const;
    },
    update: updateAgent,
    remove: (id: string) => createAgentLifecycle(db, budgetHooks).purgeAgent(id),
    clearError: (id: string) => createAgentLifecycle(db, budgetHooks).clearError(id),
  };
}
