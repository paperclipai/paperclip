import { isDeepStrictEqual } from "node:util";
import { currentPluginInteractionOrigin } from "./plugin-interaction-context.js";
import { assertAgentInteraction } from "./agent-interaction-policy.js";
import { preserveAgentInteractionPermissions } from "../lib/agent-interaction-permissions.js";
import { notifyMuseContactVerification } from "../modules/external-agents/index.js";
import { assertEphemeralAgentInstructions } from "./agent-instructions.js";
import { notifyStrandedAgentStatus } from "./live-run-recovery-notifications.js";
import { notifyDeferredExecutionEligibility } from "./deferred-execution-notifications.js";
import { notifyRunDispatch } from "./run-dispatch-notifications.js";
import { notifyAttentionRetentionWork } from "./retention-work-notifications.js";
import { notifySkillVersionPinChange } from "./skill-version-retention-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { notifyExternalConversationSettlement } from "./external-conversation-settlement-notifications.js";
import { and, eq } from "drizzle-orm";
import { agents, assets, agentConfigRevisions, agentTaskSessions, agentRuntimeState, type Db } from "@paperclipai/db";
import { normalizeAgentUrlKey, extractAgentMentionIds } from "@paperclipai/shared";
import { normalizePaperclipRunnerAdapterConfig } from "@paperclipai/adapter-utils/server-utils";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { agentRecordQueries, type UpdateAgentOptions, type AgentConfigurationPatch, type AgentConfigurationRecord, isPlainRecord, buildConfigSnapshot,
  hasConfigPatchFields, changedPendingApprovalConfigFields, diffConfigSnapshot, jsonEqual } from "../lib/agent-records.js";
import { CEO_HIRING_DENIAL_KEY, ceoHiringDenial, normalizeAgentPermissions } from "../lib/agent-permissions.js";
import type { ActivityPublication } from "../types/activity-publication.js";
import { secretService, assertClaudeOAuthBindingInvariant } from "./secrets.js";
import { agentCredentialService } from "./agent-credentials.js";
import { clearPrimaryAgent } from "./primary-agent.js";
import { budgetServiceInTransaction } from "./budgets.js";

export async function lockAgentConfigurationInteractions(tx: Db, id: string, data: AgentConfigurationPatch, options?: UpdateAgentOptions) {
  const pluginOrigin = currentPluginInteractionOrigin();
  if (pluginOrigin) options = { ...options, recordRevision: { ...options?.recordRevision,
    createdByAgentId: pluginOrigin.agentId, createdByUserId: null, source: options?.recordRevision?.source ?? "plugin_agent" } };
  const interactionActorId = pluginOrigin?.agentId ?? options?.recordRevision?.createdByAgentId;
  if (interactionActorId) {
    const [target] = await tx.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, id));
    if (!target) return options;
    await assertAgentInteraction(tx, { companyId: target.companyId, actorAgentId: interactionActorId,
      operation: "configure", targetAgentId: id, lockAgentIds: configurationText(data).flatMap(extractAgentMentionIds), lock: "update" });
  }
  return options;
}

export async function prepareAgentConfiguration(db: Db, existing: AgentConfigurationRecord, data: AgentConfigurationPatch, options?: UpdateAgentOptions): Promise<AgentConfigurationPatch> {
  await assertAgentInteraction(db, { companyId: existing.companyId, actorAgentId: options?.recordRevision?.createdByAgentId,
    operation: "mention", texts: changedConfigurationText(data, existing) });
  if (data.permissions !== undefined) data = { ...data, permissions: preserveAgentInteractionPermissions(existing.permissions, data.permissions) };
  if (options?.recordRevision?.createdByAgentId && data.budgetMonthlyCents !== undefined && data.budgetMonthlyCents !== existing.budgetMonthlyCents) {
    throw forbidden("Only board operators can change agent budgets");
  }
  await notifyAttentionRetentionWork(db, { companyId: existing.companyId });
  const id = existing.id;
  const { ensureManager, assertNoCycle, assertCompanyShortnameAvailable, assertBuiltInAgentMetadataMutationAllowed } = agentRecordQueries(db);
  if (existing.status === "pending_approval" && !options?.allowPendingApprovalConfigUpdate) {
    const changedFields = changedPendingApprovalConfigFields(agentRecordQueries(db).normalizeAgentRow(existing), data);
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
  const normalizedPatch = { ...data } as AgentConfigurationPatch;
  if (options?.recordRevision?.createdByAgentId) delete normalizedPatch.budgetMonthlyCents;
  if (data.permissions !== undefined) {
    // Only the permissions control records a CEO hiring restriction. Keep an
    // existing one unless this write turns hiring on, and never take one from input.
    const incoming = data.permissions && typeof data.permissions === "object" && !Array.isArray(data.permissions)
      ? Object.fromEntries(Object.entries(data.permissions).filter(([key]) => key !== CEO_HIRING_DENIAL_KEY)) : data.permissions;
    const denial = ceoHiringDenial(existing.permissions);
    normalizedPatch.permissions = normalizeAgentPermissions(
      denial && (incoming as Record<string, unknown> | null)?.canCreateAgents !== true
        ? { ...(incoming as Record<string, unknown>), [CEO_HIRING_DENIAL_KEY]: denial } : incoming,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(normalizedPatch, "adapterConfig") &&
    isPlainRecord(normalizedPatch.adapterConfig)
  ) {
    const normalizedAdapterConfig = await secretService(db).normalizeAdapterConfigForPersistence(
      existing.companyId,
      normalizedPatch.adapterConfig,
      { adapterType: (normalizedPatch.adapterType ?? existing.adapterType) as string },
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
  if(normalizedPatch.adapterType!==undefined&&normalizedPatch.adapterType!==existing.adapterType
    ||normalizedPatch.adapterConfig!==undefined&&!jsonEqual(normalizedPatch.adapterConfig,existing.adapterConfig))
    await notifyMuseContactVerification(db,{companyId:existing.companyId,agentId:existing.id});
  await notifyStrandedAgentStatus(db, { companyId: existing.companyId, agentId: existing.id });
  await notifyRunDispatch(db, { companyId: existing.companyId });
  await notifyDeferredExecutionEligibility(db, { companyId: existing.companyId });
  if (normalizedPatch.runtimeConfig !== undefined || normalizedPatch.reportsTo !== undefined) {
    await notifyDeliveryWork(db, DELIVERY_QUEUES.agentTimers);
  }
  if (normalizedPatch.adapterConfig !== undefined) {
    await notifySkillVersionPinChange(db, existing.companyId, existing.adapterConfig ?? {}, normalizedPatch.adapterConfig);
  }
  assertEphemeralAgentInstructions({ ...existing, ...normalizedPatch });
  return normalizedPatch;
}

export async function completeAgentConfiguration(txDb: Db, existing: AgentConfigurationRecord, updated: AgentConfigurationRecord, normalizedPatch: AgentConfigurationPatch, options: UpdateAgentOptions | undefined, publications: ActivityPublication[]) {
  const id = updated.id;
  const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);
  const beforeConfig = shouldRecordRevision
    ? buildConfigSnapshot(agentRecordQueries(txDb).normalizeAgentRow(existing))
    : null;
  if (updated.status === "terminated") {
    await clearPrimaryAgent(txDb, updated.companyId, id);
  }

  const priorAdapterConfig = isPlainRecord(existing.adapterConfig) ? existing.adapterConfig : {};
  const afterConfig = isPlainRecord(updated.adapterConfig) ? updated.adapterConfig : {};
  const changedExecution = updated.adapterType !== existing.adapterType
    || (updated.adapterType === "paperclip_runner" && ["provider", "acpxAgent", "model"].some(
      (key) => priorAdapterConfig[key] !== afterConfig[key],
    ));
  if (changedExecution) {
    await notifyExternalConversationSettlement(txDb, { companyId: existing.companyId });
    await txDb.delete(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, existing.companyId), eq(agentTaskSessions.agentId, id)));
    await txDb.update(agentRuntimeState).set({ adapterType: updated.adapterType, sessionId: null, stateJson: {}, updatedAt: new Date() })
      .where(and(eq(agentRuntimeState.companyId, existing.companyId), eq(agentRuntimeState.agentId, id)));
  }

  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "adapterConfig")) {
    await agentCredentialService(txDb).enforceClaudeOAuthBindingClaim(txDb, {
      companyId: existing.companyId, consume: false, environmentId: null,
      childAdapterConfig: updated.adapterConfig, claudeLogin: options?.claudeLogin,
      decision: assertClaudeOAuthBindingInvariant({ adapterType: updated.adapterType,
        nextConfig: updated.adapterConfig, priorConfig: existing.adapterConfig }),
    });
    await agentCredentialService(txDb).syncAgentSecretBindings(
      updated, txDb,
      existing.adapterConfig,
      options?.recordRevision,
    );
  }

  if (normalizedPatch.budgetMonthlyCents !== undefined) {
    await budgetServiceInTransaction(txDb, publications).upsertPolicy(existing.companyId, {
      scopeType: "agent", scopeId: id, amount: normalizedPatch.budgetMonthlyCents,
      isActive: normalizedPatch.budgetMonthlyCents > 0, windowKind: "calendar_month_utc",
    }, options?.recordRevision?.createdByUserId ?? null);
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
}

function configurationText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(configurationText);
  if (value && typeof value === "object") return Object.values(value).flatMap(configurationText);
  return [];
}

function changedConfigurationText(next: unknown, previous: unknown): string[] {
  if (isDeepStrictEqual(next, previous)) return [];
  if (typeof next === "string") return [next];
  if (next && typeof next === "object") {
    const prior = previous && typeof previous === "object" ? previous as Record<string, unknown> : {};
    return Object.entries(next).flatMap(([key, value]) => changedConfigurationText(value, prior[key]));
  }
  return [];
}
