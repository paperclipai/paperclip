import { agentAppearanceSchema, randomAgentAppearance } from "@paperclipai/shared";
import { normalizePaperclipRunnerAdapterConfig } from "@paperclipai/adapter-utils/server-utils";
import { agents, toolConnectionInstalls, principalPermissionGrants, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { unprocessable } from "../errors.js";
import { agentRecordQueries, isPlainRecord, configPatchFromApprovalPayload, normalizeRuntimeConfigForNewAgent,
  deduplicateAgentName, type CreateAgentData, type CreateAgentOptions, type AgentConfigurationPatch, type AgentHireRecord } from "../lib/agent-records.js";
import { normalizeAgentPermissions, permissionsImplyLowTrust, NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS,
  newStandardAgentGrantScope } from "../lib/agent-permissions.js";
import { readBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { secretService, assertClaudeOAuthBindingInvariant } from "./secrets.js";
import { agentCredentialService } from "./agent-credentials.js";
import { agentIdentityService } from "./agent-identity.js";
import { initializePrimaryAgent } from "./primary-agent.js";
import { resolveNewAgentRunnerForCompany } from "./agent-runner-selection.js";

export async function prepareAgentHire(db: Db, companyId: string, input: CreateAgentData, options?: CreateAgentOptions): Promise<CreateAgentData> {
  // Resolve every new hire before adapter-specific normalization and credentials.
  // Approval/import callers freeze their reviewed execution; runner is request-only.
  const { runner, ...data } = input;
  const selection = options?.runnerResolved
    ? { adapterType: data.adapterType ?? "process", adapterConfig: isPlainRecord(data.adapterConfig) ? data.adapterConfig : {} }
    : await resolveNewAgentRunnerForCompany(db, companyId, {
        ...data, adapterConfig: isPlainRecord(data.adapterConfig) ? data.adapterConfig : {}, runner,
      });
  data.adapterType = selection.adapterType;
  data.adapterConfig = selection.adapterConfig;
  const { ensureManager, assertBuiltInAgentMetadataMutationAllowed } = agentRecordQueries(db);
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
    ? await secretService(db).normalizeAdapterConfigForPersistence(companyId, data.adapterConfig, { adapterType })
    : {};
  const adapterConfig = normalizePaperclipRunnerAdapterConfig(adapterType, rawAdapterConfig);
  await agentCredentialService(db).enforceClaudeOAuthBindingClaim(db, {
    companyId, consume: true, environmentId: data.defaultEnvironmentId ?? null,
    childAdapterConfig: adapterConfig, claudeLogin: options?.claudeLogin,
    decision: assertClaudeOAuthBindingInvariant({ adapterType, nextConfig: adapterConfig }),
  });
  return { ...data, name: uniqueName,
    appearance: data.appearance == null ? randomAgentAppearance() : agentAppearanceSchema.parse(data.appearance),
    role, adapterType, adapterConfig, permissions: normalizedPermissions, runtimeConfig };
}

export async function initializeAgentHire(txDb: Db, created: AgentHireRecord, options?: CreateAgentOptions) {
  const tx = txDb;
  const companyId = created.companyId;
  await agentIdentityService(txDb).ensureAgentIdentity(companyId, created.id);
  // New standard agents receive the standard direct grants at activation.
  // Low-trust and bundled agents keep their explicit, narrower grants.
  if (created.status !== "pending_approval" && !permissionsImplyLowTrust(created.permissions) &&
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
  await agentCredentialService(txDb).syncAgentSecretBindings(created, txDb);
  if (options?.createdByUserId && !readBuiltInAgentMarker(created.metadata)) {
    await initializePrimaryAgent(txDb, companyId, options.createdByUserId, created.id);
  }
}

export async function prepareAgentHireApproval(txDb: Db, existing: AgentHireRecord, approvedPayload?: Record<string, unknown> | null): Promise<AgentConfigurationPatch> {
  const approvedPatch = approvedPayload ? configPatchFromApprovalPayload(approvedPayload) : {};
  const patch = { ...approvedPatch } as AgentConfigurationPatch;
  const hasApprovedAdapterConfig = Object.prototype.hasOwnProperty.call(patch, "adapterConfig") && isPlainRecord(patch.adapterConfig);
  if (
    Object.prototype.hasOwnProperty.call(patch, "adapterConfig") &&
    isPlainRecord(patch.adapterConfig)
  ) {
    const normalizedAdapterConfig = await secretService(txDb).normalizeAdapterConfigForPersistence(
      existing.companyId, patch.adapterConfig, { adapterType: (patch.adapterType ?? existing.adapterType) as string },
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
  if (hasApprovedAdapterConfig) {
    await agentCredentialService(txDb).enforceClaudeOAuthBindingClaim(txDb, {
      companyId: existing.companyId, consume: false, environmentId: null,
      childAdapterConfig: patch.adapterConfig,
      decision: assertClaudeOAuthBindingInvariant({ adapterType: patch.adapterType ?? existing.adapterType,
        nextConfig: patch.adapterConfig, priorConfig: existing.adapterConfig }),
    });
  }
  return patch;
}

export async function completeAgentHireApproval(txDb: Db, updated: AgentHireRecord, existing: AgentHireRecord) {
  const tx = txDb;
  await agentCredentialService(txDb).syncAgentSecretBindings(updated, txDb, existing.adapterConfig);
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
}
