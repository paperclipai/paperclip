import { AgentLifecycleConflict } from "../domain/policy.js";
import { createLifecycleStore } from "./postgres.js";
import type { LifecycleEffects } from "./effects.js";
import type { ActivityPublication } from "../../../types/activity-publication.js";
import { agentAppearanceSchema, randomAgentAppearance } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  assets,
  toolConnectionInstalls,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  budgetReservations,
  heartbeatRunEvents,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
  issueComments,
  principalPermissionGrants,
} from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { normalizePaperclipRunnerAdapterConfig } from "@paperclipai/adapter-utils/server-utils";
import { conflict, notFound, unprocessable } from "../../../errors.js";

import {
  NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS,
  newStandardAgentGrantScope,
  normalizeAgentPermissions,
  permissionsImplyLowTrust,
} from "../../../lib/agent-permissions.js";

import { readBuiltInAgentMarker } from "../../../lib/built-in-agent-metadata.js";

import {
  agentRecordQueries,
  UpdateAgentOptions,
  CreateAgentOptions,
  isPlainRecord,
  jsonEqual,
  buildConfigSnapshot,
  hasConfigPatchFields,
  changedPendingApprovalConfigFields,
  configPatchFromApprovalPayload,
  normalizeRuntimeConfigForNewAgent,
  diffConfigSnapshot,
  deduplicateAgentName,
} from "../../../lib/agent-records.js";

export function agentRecords(db: Db, effects: LifecycleEffects) {
  const {
    normalizeAgentRow,
    getById,
    ensureManager,
    assertNoCycle,
    assertCompanyShortnameAvailable,
    assertBuiltInAgentMetadataMutationAllowed
  } = agentRecordQueries(db);
  async function updateAgent(
    id: string,
    data: Partial<Omit<typeof agents.$inferInsert, "status" | "pauseReason" | "pausedAt" | "lifecycleState" | "lifecycleVersion" | "lifecycleError" | "lifecycleOperation" | "lifecycleRequiredPluginIds" | "lifecycleHolds">>,
    options?: UpdateAgentOptions,
    lifecycleCommand?: "pause" | "resume" | "terminate",
  ) {
    for (const field of ["status", "pauseReason", "pausedAt", "lifecycleState", "lifecycleRequiredPluginIds", "lifecycleHolds", "lifecycleVersion", "lifecycleError", "lifecycleOperation"]) {
      if (Object.prototype.hasOwnProperty.call(data, field)) throw conflict("Use an agent lifecycle command to change lifecycle state");
    }
    const existing = await getById(id);
    if (!existing) return null;

    if (existing.status === "pending_approval" && !options?.allowPendingApprovalConfigUpdate) {
      const changedFields = changedPendingApprovalConfigFields(existing, data);
      if (changedFields.length > 0) {
        throw conflict("Pending approval agent configuration cannot be changed before board approval", {
          code: "pending_approval_agent_config_frozen",
          agentId: id,
          fields: changedFields,
        });
      }
    }

    if (data.reportsTo !== undefined) {
      if (data.reportsTo) {
        await ensureManager(existing.companyId, data.reportsTo);
      }
      await assertNoCycle(id, data.reportsTo);
    }

    if (data.name !== undefined) {
      const previousShortname = normalizeAgentUrlKey(existing.name);
      const nextShortname = normalizeAgentUrlKey(data.name);
      if (previousShortname !== nextShortname) {
        await assertCompanyShortnameAvailable(existing.companyId, data.name, { excludeAgentId: id });
      }
    }

    if (Object.prototype.hasOwnProperty.call(data, "metadata")) {
      assertBuiltInAgentMetadataMutationAllowed(existing.metadata, data.metadata, options);
    }

    if (data.appearance?.customAvatarAssetId) {
      const [asset] = await db.select().from(assets).where(and(
        eq(assets.id, data.appearance.customAvatarAssetId), eq(assets.companyId, existing.companyId),
        eq(assets.createdByAgentId, id),
      ));
      if (!asset || asset.contentType !== "image/png" || !asset.objectKey.startsWith(`${existing.companyId}/agent-avatars/${id}/`)) {
        throw unprocessable("Use the avatar upload endpoint to set this agent's image");
      }
    }
    const normalizedPatch = { ...data } as Partial<typeof agents.$inferInsert>;
    if (data.permissions !== undefined) {
      normalizedPatch.permissions = normalizeAgentPermissions(data.permissions);
    }
    if (
      Object.prototype.hasOwnProperty.call(normalizedPatch, "adapterConfig") &&
      isPlainRecord(normalizedPatch.adapterConfig)
    ) {
      const normalizedAdapterConfig = await effects.normalizeAdapterConfig(db,
        existing.companyId,
        normalizedPatch.adapterConfig,
        (normalizedPatch.adapterType ?? existing.adapterType) as string,
      );
      normalizedPatch.adapterConfig = normalizePaperclipRunnerAdapterConfig(
        (normalizedPatch.adapterType ?? existing.adapterType) as string,
        normalizedAdapterConfig,
      );
    } else if (
      Object.prototype.hasOwnProperty.call(normalizedPatch, "adapterType")
      && isPlainRecord(existing.adapterConfig)
    ) {
      normalizedPatch.adapterConfig = normalizePaperclipRunnerAdapterConfig(
        normalizedPatch.adapterType as string,
        existing.adapterConfig,
      );
    }
    const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);
    const beforeConfig = shouldRecordRevision ? buildConfigSnapshot(existing) : null;

    type AgentUpdateResult = Awaited<ReturnType<typeof getById>>;
    const applyUpdate = async (txDb: Db, publications: ActivityPublication[] = []): Promise<AgentUpdateResult> => {
      const [current] = await txDb.select().from(agents).where(eq(agents.id, id)).for("update");
      if (!current) return null;
      const changedConfig = ["adapterType", "adapterConfig", "runtimeConfig", "defaultEnvironmentId"].some(key =>
        Object.prototype.hasOwnProperty.call(normalizedPatch, key) && !jsonEqual(normalizedPatch[key as keyof typeof normalizedPatch], current[key as keyof typeof current]));
      const verificationPatch = changedConfig && ["preparing", "verifying", "resuming"].includes(current.lifecycleState)
        ? { lifecycleVersion: current.lifecycleVersion + 1, lifecycleError: null,
            lifecycleOperation: { ...current.lifecycleOperation!, id: randomUUID(), hostComplete: false, completedPluginIds: [], leaseOwner: undefined, leaseUntil: undefined, retryAt: undefined } }
        : {};
      const updated = await txDb
        .update(agents)
        .set({ ...normalizedPatch, ...verificationPatch, updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      if (updated.status === "terminated") {
        await effects.clearPrimary(txDb, updated.companyId, id);
      }

      const priorAdapterConfig = isPlainRecord(existing.adapterConfig) ? existing.adapterConfig : {};
      const afterConfig = isPlainRecord(updated.adapterConfig) ? updated.adapterConfig : {};
      const changedExecution = updated.adapterType !== existing.adapterType
        || (updated.adapterType === "paperclip_runner" && ["provider", "acpxAgent", "model"].some(
          (key) => priorAdapterConfig[key] !== afterConfig[key],
        ));
      if (changedExecution) {
        await txDb.delete(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, existing.companyId), eq(agentTaskSessions.agentId, id)));
        await txDb.update(agentRuntimeState).set({ adapterType: updated.adapterType, sessionId: null, stateJson: {}, updatedAt: new Date() })
          .where(and(eq(agentRuntimeState.companyId, existing.companyId), eq(agentRuntimeState.agentId, id)));
      }

      if (Object.prototype.hasOwnProperty.call(normalizedPatch, "adapterConfig")) {
        await effects.bindCredentials(txDb, {
          companyId: existing.companyId, adapterType: updated.adapterType,
          adapterConfig: updated.adapterConfig, previousAdapterConfig: existing.adapterConfig,
          consume: false, claudeLogin: options?.claudeLogin,
        });
        await effects.syncSecrets(
          txDb,
          updated,
          existing.adapterConfig,
          options?.recordRevision,
        );
      }

      if (normalizedPatch.budgetMonthlyCents !== undefined) {
        await effects.setAgentBudget(txDb, publications, existing.companyId, id,
          normalizedPatch.budgetMonthlyCents, options?.recordRevision?.createdByUserId ?? null, normalizedPatch.budgetMonthlyCents > 0);
      }
      const normalizedUpdated = await agentRecordQueries(txDb).getById(updated.id);
      if (!normalizedUpdated) {
        throw notFound("Agent not found");
      }

      if (shouldRecordRevision && beforeConfig) {
        const afterConfig = buildConfigSnapshot(normalizedUpdated);
        const changedKeys = diffConfigSnapshot(beforeConfig, afterConfig);
        if (changedKeys.length > 0) {
          await txDb.insert(agentConfigRevisions).values({
            companyId: normalizedUpdated.companyId,
            agentId: normalizedUpdated.id,
            createdByAgentId: options?.recordRevision?.createdByAgentId ?? null,
            createdByUserId: options?.recordRevision?.createdByUserId ?? null,
            source: options?.recordRevision?.source ?? "patch",
            rolledBackFromRevisionId: options?.recordRevision?.rolledBackFromRevisionId ?? null,
            changedKeys,
            beforeConfig: beforeConfig as unknown as Record<string, unknown>,
            afterConfig: afterConfig as unknown as Record<string, unknown>,
          });
        }
      }

      if (lifecycleCommand) {
        await createLifecycleStore(txDb, effects).change(id, lifecycleCommand, { reason: lifecycleCommand === "resume" ? "user" : "manual" });
        return agentRecordQueries(txDb).getById(id);
      }
      return normalizedUpdated;
    };

    if (normalizedPatch.budgetMonthlyCents !== undefined || lifecycleCommand) {
      const result = await effects.transaction(db, existing.companyId, applyUpdate);
      if (normalizedPatch.budgetMonthlyCents !== undefined) await effects.enforceBudget(db, existing.companyId);
      return result;
    }

    const transaction = (db as unknown as {
      transaction?: (callback: (tx: unknown) => Promise<AgentUpdateResult>) => Promise<AgentUpdateResult>;
    }).transaction;
    if (typeof transaction !== "function") return applyUpdate(db);
    return transaction.call(db, async (tx) => applyUpdate(tx as unknown as Db));
  }

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

    update: (id: string, data: Parameters<typeof updateAgent>[1], options?: UpdateAgentOptions) => updateAgent(id, data, options),
    updateAndTransition: (id: string, command: "pause" | "resume" | "terminate", data: Parameters<typeof updateAgent>[1], options?: UpdateAgentOptions) =>
      updateAgent(id, data, options, command),

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

    remove: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      const builtInMarker = readBuiltInAgentMarker(existing.metadata);
      if (builtInMarker) {
        throw conflict("Built-in agents cannot be deleted; pause them instead", {
          code: "built_in_agent_undeletable",
          key: builtInMarker.key,
          featureKeys: builtInMarker.featureKeys,
        });
      }

      return effects.transaction(db, existing.companyId, async (tx) => {
        const [decisionHold] = await tx.select({ id: budgetReservations.id }).from(budgetReservations).where(and(
          eq(budgetReservations.companyId, existing.companyId), eq(budgetReservations.agentId, id),
          eq(budgetReservations.state, "held"), sql`${budgetReservations.decisionInvocationId} is not null`,
        )).limit(1);
        if (decisionHold) throw conflict("Wait for active decisions or resolve their unknown charges in Costs before deleting this agent", {
          code: "agent_decision_accounting_pending",
        });
        const [current] = await tx.select().from(agents).where(eq(agents.id, id)).for("update");
        if (!current) return null;
        if (!["terminated", "rejected"].includes(current.lifecycleState)) throw new AgentLifecycleConflict("Complete termination before deleting the agent");
        await effects.cancelInteractions(tx as unknown as Db, existing.companyId, id);
        await tx.update(agents).set({ reportsTo: null }).where(eq(agents.reportsTo, id));
        await tx
          .update(issues)
          .set({ assigneeAgentId: null, createdByAgentId: null })
          .where(or(eq(issues.assigneeAgentId, id), eq(issues.createdByAgentId, id)));
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
        await tx.delete(activityLog).where(
          or(
            eq(activityLog.agentId, id),
            sql`${activityLog.runId} in (select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.agentId} = ${id})`,
          ),
        );
        await tx.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.actorAgentId, id));
        await tx.delete(issueComments).where(eq(issueComments.authorAgentId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
        await tx.delete(principalPermissionGrants).where(and(
          eq(principalPermissionGrants.companyId, existing.companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalId, id),
        ));
        const deleted = await tx
          .delete(agents)
          .where(eq(agents.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return deleted ? normalizeAgentRow(deleted) : null;
      });
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
