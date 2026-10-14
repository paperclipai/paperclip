import { and, eq } from "drizzle-orm";
import { assets, agentConfigRevisions, agentTaskSessions, agentRuntimeState, type Db } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { normalizePaperclipRunnerAdapterConfig } from "@paperclipai/adapter-utils/server-utils";
import { conflict, notFound, unprocessable } from "../errors.js";
import { agentRecordQueries, type UpdateAgentOptions, type AgentConfigurationPatch, type AgentConfigurationRecord, isPlainRecord, buildConfigSnapshot,
  hasConfigPatchFields, changedPendingApprovalConfigFields, diffConfigSnapshot } from "../lib/agent-records.js";
import { normalizeAgentPermissions } from "../lib/agent-permissions.js";
import type { ActivityPublication } from "../types/activity-publication.js";
import { secretService, assertClaudeOAuthBindingInvariant } from "./secrets.js";
import { agentCredentialService } from "./agent-credentials.js";
import { clearPrimaryAgent } from "./primary-agent.js";
import { budgetServiceInTransaction } from "./budgets.js";

export async function prepareAgentConfiguration(db: Db, existing: AgentConfigurationRecord, data: AgentConfigurationPatch, options?: UpdateAgentOptions): Promise<AgentConfigurationPatch> {
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
  if (data.permissions !== undefined) {
    normalizedPatch.permissions = normalizeAgentPermissions(data.permissions);
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
