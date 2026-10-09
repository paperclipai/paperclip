import type { LifecycleEffects } from "./effects.js";
import { agentAppearanceSchema, randomAgentAppearance } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, toolConnectionInstalls, agentApiKeys, principalPermissionGrants, type Db } from "@paperclipai/db";
import { normalizePaperclipRunnerAdapterConfig } from "@paperclipai/adapter-utils/server-utils";
import { conflict, notFound, unprocessable } from "../../../errors.js";
import { NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS, newStandardAgentGrantScope,
  normalizeAgentPermissions, permissionsImplyLowTrust } from "../../../lib/agent-permissions.js";
import { readBuiltInAgentMarker } from "../../../lib/built-in-agent-metadata.js";
import { agentRecordQueries, type CreateAgentOptions, isPlainRecord,
  configPatchFromApprovalPayload, normalizeRuntimeConfigForNewAgent, deduplicateAgentName } from "../../../lib/agent-records.js";

export function agentRecords(db: Db, effects: LifecycleEffects) {
  const {
    getById,
    ensureManager,
    assertBuiltInAgentMetadataMutationAllowed
  } = agentRecordQueries(db);

  return {
    getById,
    create: async (companyId: string, data: Omit<typeof agents.$inferInsert, "companyId" | "lifecycleState" | "lifecycleRequiredPluginIds" | "lifecycleHolds" | "lifecycleVersion" | "lifecycleError" | "lifecycleOperation">, options?: CreateAgentOptions) => {
      if (Object.keys(data).some(key => key.startsWith("lifecycle"))) throw conflict("Lifecycle fields belong to the lifecycle module");
      if (data.appearance?.customAvatarAssetId) throw unprocessable("Create the agent before uploading its avatar");
      assertBuiltInAgentMetadataMutationAllowed(null, data.metadata, options);
      if (data.reportsTo) {
        await ensureManager(companyId, data.reportsTo);
      }

      const existingAgents = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const uniqueName = deduplicateAgentName(data.name, existingAgents);

      const role = data.role ?? "general";
      const normalizedPermissions = normalizeAgentPermissions(data.permissions, { context: "create" });
      const runtimeConfig = normalizeRuntimeConfigForNewAgent(data.runtimeConfig);
      const adapterType = data.adapterType ?? "process";
      const rawAdapterConfig = isPlainRecord(data.adapterConfig)
        ? await effects.normalizeAdapterConfig(db, companyId, data.adapterConfig, adapterType)
        : {};
      const adapterConfig = normalizePaperclipRunnerAdapterConfig(adapterType, rawAdapterConfig);
      return effects.transaction(db, companyId, async (txDb) => {
        const tx = txDb;
        await effects.bindCredentials(txDb, {
          companyId, adapterType, adapterConfig, consume: true,
          environmentId: data.defaultEnvironmentId ?? null, claudeLogin: options?.claudeLogin,
        });
        const created = await tx
          .insert(agents)
          .values({
            ...data,
            lifecycleState: data.status === "pending_approval" ? "pending_approval" : data.status === "terminated" ? "terminated" : data.status === "paused" ? "paused" : "preparing",
            lifecycleVersion: 1,
            lifecycleHolds: data.status === "paused" ? [data.pauseReason ?? "manual"] : [],
            pauseReason: data.status === "paused" ? data.pauseReason ?? "manual" : null,
            pausedAt: data.status === "paused" ? new Date() : null,
            lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0, resumeState: "preparing", responsibleUserId: options?.responsibleUserId ?? options?.createdByUserId },
            status: data.status === "pending_approval" ? "pending_approval" : data.status === "terminated" ? "terminated" : "paused",
            name: uniqueName,
            appearance: data.appearance == null ? randomAgentAppearance() : agentAppearanceSchema.parse(data.appearance),
            companyId,
            role,
            adapterType,
            adapterConfig,
            permissions: normalizedPermissions,
            runtimeConfig,
          })
          .returning()
          .then((rows) => rows[0]);
        await effects.ensureIdentity(txDb, companyId, created.id);
        // New standard agents receive the standard direct grants at activation.
        // Low-trust and bundled agents keep their explicit, narrower grants.
        if (created.status !== "pending_approval" && !permissionsImplyLowTrust(normalizedPermissions) &&
            !readBuiltInAgentMarker(created.metadata)) {
          await tx.insert(principalPermissionGrants).values(
            NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.map((permissionKey) => ({
              companyId,
              principalType: "agent" as const,
              principalId: created.id,
              permissionKey,
              scope: newStandardAgentGrantScope(permissionKey, created.id),
            })),
          ).onConflictDoNothing();
        }
        if (options?.aiConnectionInstall) {
          const install = options.aiConnectionInstall;
          const connectionIds = [...new Set([install.connectionId, ...(install.memberConnectionIds ?? [])])];
          await tx.insert(toolConnectionInstalls).values(connectionIds.map(connectionId => ({
            companyId, connectionId,
            targetType: "agent" as const, targetId: created.id,
            createdByUserId: install.createdByUserId,
          }))).onConflictDoNothing();
        }
        await effects.syncSecrets(txDb, created);
        if (options?.createdByUserId && !readBuiltInAgentMarker(created.metadata)) {
          await effects.initializePrimary(txDb, companyId, options.createdByUserId, created.id);
        }
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
        const approvedPatch = approvedPayload ? configPatchFromApprovalPayload(approvedPayload) : {};
        let patch = { ...approvedPatch } as Partial<typeof agents.$inferInsert>;
        const hasApprovedAdapterConfig = Object.prototype.hasOwnProperty.call(patch, "adapterConfig") && isPlainRecord(patch.adapterConfig);
        if (
          Object.prototype.hasOwnProperty.call(patch, "adapterConfig") &&
          isPlainRecord(patch.adapterConfig)
        ) {
          const normalizedAdapterConfig = await effects.normalizeAdapterConfig(txDb,
            existing.companyId,
            patch.adapterConfig,
            (patch.adapterType ?? existing.adapterType) as string,
          );
          patch.adapterConfig = normalizePaperclipRunnerAdapterConfig(
            (patch.adapterType ?? existing.adapterType) as string,
            normalizedAdapterConfig,
          );
        } else if (
          Object.prototype.hasOwnProperty.call(patch, "adapterType")
          && isPlainRecord(existing.adapterConfig)
        ) {
          patch.adapterConfig = normalizePaperclipRunnerAdapterConfig(
            patch.adapterType as string,
            existing.adapterConfig,
          );
        }
        if (patch.permissions !== undefined) {
          // The pending-approval activation replays the original hire
          // request, so the new-agent creation default applies.
          patch.permissions = normalizeAgentPermissions(patch.permissions, { context: "create" });
        }
        const updated = await tx
          .update(agents)
          .set({ ...patch, status: "paused", lifecycleState: "preparing", lifecycleVersion: existing.lifecycleVersion + 1, lifecycleError: null, lifecycleOperation: sql`jsonb_build_object('id', ${randomUUID()}::text, 'hostComplete', false, 'completedPluginIds', '[]'::jsonb, 'attempts', 0, 'responsibleUserId', coalesce(nullif(${agents.lifecycleOperation}->'responsibleUserId', 'null'::jsonb), to_jsonb(${requestedByUserId ?? null}::text)))`, updatedAt: new Date() })
          .where(and(eq(agents.id, id), eq(agents.status, "pending_approval")))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        if (hasApprovedAdapterConfig) {
          await effects.bindCredentials(txDb, {
            companyId: existing.companyId, adapterType: updated.adapterType,
            adapterConfig: updated.adapterConfig, previousAdapterConfig: existing.adapterConfig, consume: false,
          });
        }
        await effects.syncSecrets(txDb, updated, existing.adapterConfig);
        if (!permissionsImplyLowTrust(updated.permissions) && !readBuiltInAgentMarker(updated.metadata)) {
          await tx.insert(principalPermissionGrants).values(
            NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.map((permissionKey) => ({
              companyId: updated.companyId,
              principalType: "agent" as const,
              principalId: updated.id,
              permissionKey,
              scope: newStandardAgentGrantScope(permissionKey, updated.id),
            })),
          ).onConflictDoNothing();
        }
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
