import type {
  AgentOrgChainHealth,
  AgentResponse,
  AgentResponsePermissions,
  TrustAuthorizationPolicy,
} from "@paperclipai/shared";

type UnknownRecord = Record<string, unknown>;

const SAFE_ADAPTER_SCALAR_FIELDS = [
  "provider",
  "model",
  "modelReasoningEffort",
  "reasoningEffort",
  "thinkingEffort",
  "thinking",
  "variant",
  "effort",
  "engine",
  "mode",
  "permissionMode",
  "nonInteractivePermissions",
  "warmHandleIdleMs",
  "timeoutSec",
  "graceSec",
  "maxTurnsPerRun",
  "persistSession",
  "worktreeMode",
  "checkpoints",
  "quiet",
  "verbose",
  "fastMode",
  "search",
  "chrome",
  "dangerouslyBypassApprovalsAndSandbox",
  "dangerouslySkipPermissions",
  "sessionKeyStrategy",
  "eventReconnectMs",
  "waitTimeoutMs",
  "disableDeviceAuth",
  "autoPairOnFirstConnect",
  "role",
  "paperclipApiUrl",
  "url",
  "agentId",
  "command",
  "agentCommand",
  "hermesCommand",
  "stateDir",
  "cwd",
  "instructions",
  "instructionsFilePath",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "repoUrl",
  "repoStartingRef",
  "repoPullRequestUrl",
  "runtimeEnvType",
  "runtimeEnvName",
  "workOnCurrentBranch",
  "autoCreatePR",
  "skipReviewerRequest",
  "apiBaseUrl",
  "dangerouslyAllowInsecureRemoteHttp",
  "sessionKey",
  "sandbox",
] as const;

const SAFE_ADAPTER_STRING_ARRAY_FIELDS = [
  "toolsets",
  "enabledToolsets",
  "extraArgs",
  "args",
  "scopes",
] as const;

export const PUBLIC_AGENT_ADAPTER_CONFIG_KEYS = new Set<string>([
  ...SAFE_ADAPTER_SCALAR_FIELDS,
  ...SAFE_ADAPTER_STRING_ARRAY_FIELDS,
  "workspaceStrategy",
  "paperclipSkillSync",
]);

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function projectScalar(value: unknown): string | number | boolean | null | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
    ? value
    : undefined;
}

function projectStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return [...value];
}

function projectSelectedFields(source: UnknownRecord | null, keys: readonly string[]): UnknownRecord {
  const result: UnknownRecord = {};
  if (!source) return result;
  for (const key of keys) {
    const projected = projectScalar(source[key]);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

function projectWorkspaceStrategy(value: unknown): UnknownRecord | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const result = projectSelectedFields(source, ["type", "baseRef", "branchTemplate", "worktreeParentDir"]);
  return Object.keys(result).length > 0 ? result : undefined;
}

function projectDesiredSkillEntries(value: unknown): Array<string | { key: string; versionId: string | null }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Array<string | { key: string; versionId: string | null }> = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      result.push(entry);
      continue;
    }
    const source = asRecord(entry);
    if (!source || typeof source.key !== "string") continue;
    result.push({
      key: source.key,
      versionId: typeof source.versionId === "string" ? source.versionId : null,
    });
  }
  return result;
}

function projectPaperclipSkillSync(value: unknown): UnknownRecord | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const result: UnknownRecord = {};
  const desiredSkills = projectDesiredSkillEntries(source.desiredSkills);
  if (desiredSkills) result.desiredSkills = desiredSkills;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function projectAgentAdapterConfig(input: unknown): UnknownRecord {
  const source = asRecord(input);
  if (!source) return {};
  const result = projectSelectedFields(source, SAFE_ADAPTER_SCALAR_FIELDS);
  for (const key of SAFE_ADAPTER_STRING_ARRAY_FIELDS) {
    const value = source[key];
    if (key === "toolsets" && typeof value === "string") {
      result[key] = value;
      continue;
    }
    const projected = projectStringArray(value);
    if (projected) result[key] = projected;
  }
  const workspaceStrategy = projectWorkspaceStrategy(source.workspaceStrategy);
  if (workspaceStrategy) result.workspaceStrategy = workspaceStrategy;
  const paperclipSkillSync = projectPaperclipSkillSync(source.paperclipSkillSync);
  if (paperclipSkillSync) result.paperclipSkillSync = paperclipSkillSync;
  return result;
}

function projectMaxTurnContinuation(value: unknown): UnknownRecord | undefined {
  const result = projectSelectedFields(asRecord(value), ["enabled", "maxAttempts", "delayMs"]);
  return Object.keys(result).length > 0 ? result : undefined;
}

function projectHeartbeat(value: unknown): UnknownRecord | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const result = projectSelectedFields(source, [
    "enabled",
    "intervalSec",
    "wakeOnDemand",
    "cooldownSec",
    "maxConcurrentRuns",
  ]);
  const maxTurnContinuation = projectMaxTurnContinuation(source.maxTurnContinuation);
  if (maxTurnContinuation) result.maxTurnContinuation = maxTurnContinuation;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function projectAgentRuntimeConfig(input: unknown): UnknownRecord {
  const source = asRecord(input);
  if (!source) return {};
  const result: UnknownRecord = {};
  const heartbeat = projectHeartbeat(source.heartbeat);
  if (heartbeat) result.heartbeat = heartbeat;

  const profiles = asRecord(source.modelProfiles);
  if (profiles) {
    const projectedProfiles: UnknownRecord = {};
    for (const profileName of ["default", "cheap"] as const) {
      const profile = asRecord(profiles[profileName]);
      if (!profile) continue;
      const projectedProfile: UnknownRecord = {
        adapterConfig: projectAgentAdapterConfig(profile.adapterConfig),
      };
      if (typeof profile.enabled === "boolean") projectedProfile.enabled = profile.enabled;
      if (typeof profile.label === "string") projectedProfile.label = profile.label;
      projectedProfiles[profileName] = projectedProfile;
    }
    if (Object.keys(projectedProfiles).length > 0) result.modelProfiles = projectedProfiles;
  }
  return result;
}

function projectLowTrustReviewPreset(value: unknown): UnknownRecord | undefined {
  const result = projectSelectedFields(asRecord(value), ["id", "version", "rawOutputDisposition"]);
  return Object.keys(result).length > 0 ? result : undefined;
}

function projectOutputPromotionTarget(value: unknown): UnknownRecord | undefined {
  const result = projectSelectedFields(asRecord(value), ["type", "issueId"]);
  return Object.keys(result).length > 0 ? result : undefined;
}

function projectTrustBoundary(value: unknown): UnknownRecord | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const result = projectSelectedFields(source, ["mode", "companyId", "rootIssueId"]);
  for (const key of [
    "projectIds",
    "issueIds",
    "allowedAgentIds",
    "allowedSecretBindingIds",
    "allowedToolClasses",
  ] as const) {
    const projected = projectStringArray(source[key]);
    if (projected) result[key] = projected;
  }
  const outputPromotionTarget = projectOutputPromotionTarget(source.outputPromotionTarget);
  if (outputPromotionTarget) result.outputPromotionTarget = outputPromotionTarget;
  return Object.keys(result).length > 0 ? result : undefined;
}

function projectAuthorizationPolicy(value: unknown): TrustAuthorizationPolicy | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const result = projectSelectedFields(source, ["trustPreset"]);
  const reviewPreset = projectLowTrustReviewPreset(source.reviewPreset);
  if (reviewPreset) result.reviewPreset = reviewPreset;
  const trustBoundary = projectTrustBoundary(source.trustBoundary);
  if (trustBoundary) result.trustBoundary = trustBoundary;
  return Object.keys(result).length > 0 ? result as TrustAuthorizationPolicy : undefined;
}

export function projectAgentPermissions(input: unknown): AgentResponsePermissions {
  const source = asRecord(input);
  const result: AgentResponsePermissions = {
    canCreateAgents: source?.canCreateAgents === true,
  };
  if (!source) return result;
  if (typeof source.canCreateSkills === "boolean") result.canCreateSkills = source.canCreateSkills;
  if (typeof source.trustPreset === "string") result.trustPreset = source.trustPreset as AgentResponsePermissions["trustPreset"];
  const authorizationPolicy = projectAuthorizationPolicy(source.authorizationPolicy);
  if (authorizationPolicy) result.authorizationPolicy = authorizationPolicy;
  return result;
}

function projectOrgChainEntry(value: unknown): AgentOrgChainHealth["fullChain"][number] | null {
  const source = asRecord(value);
  if (
    !source
    || typeof source.id !== "string"
    || typeof source.companyId !== "string"
    || typeof source.name !== "string"
    || typeof source.status !== "string"
    || typeof source.depth !== "number"
    || (source.relation !== "self" && source.relation !== "ancestor")
  ) return null;
  return {
    id: source.id,
    companyId: source.companyId,
    name: source.name,
    status: source.status,
    reportsTo: typeof source.reportsTo === "string" ? source.reportsTo : null,
    depth: source.depth,
    relation: source.relation,
  };
}

function projectInvalidAncestor(value: unknown): AgentOrgChainHealth["invalidAncestors"][number] | null {
  const source = asRecord(value);
  if (!source || typeof source.id !== "string" || typeof source.name !== "string" || typeof source.status !== "string") {
    return null;
  }
  return { id: source.id, name: source.name, status: source.status };
}

function projectOrgChainHealth(input: unknown): AgentOrgChainHealth | undefined {
  const source = asRecord(input);
  if (
    !source
    || (source.status !== "healthy" && source.status !== "invalid_org_chain")
    || !["healthy", "terminated_ancestor", "missing_manager", "cycle"].includes(String(source.reason))
  ) return undefined;
  const fullChain = Array.isArray(source.fullChain)
    ? source.fullChain.map(projectOrgChainEntry).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];
  const invalidAncestors = Array.isArray(source.invalidAncestors)
    ? source.invalidAncestors.map(projectInvalidAncestor).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];
  const firstInvalidAncestor = projectInvalidAncestor(source.firstInvalidAncestor);
  return {
    status: source.status,
    reason: source.reason as AgentOrgChainHealth["reason"],
    fullChain,
    firstInvalidAncestor,
    invalidAncestors,
    repairGuidance: typeof source.repairGuidance === "string" ? source.repairGuidance : null,
  };
}

function projectRequiredUserSecretKeys(adapterConfig: unknown): string[] | undefined {
  const env = asRecord(asRecord(adapterConfig)?.env);
  if (!env) return undefined;
  const keys = new Set<string>();
  for (const binding of Object.values(env)) {
    const source = asRecord(binding);
    if (
      source?.type === "user_secret_ref"
      && typeof source.key === "string"
      && source.key.trim().length > 0
      && source.required !== false
      && source.allowMissingOverride !== true
    ) keys.add(source.key.trim());
  }
  return keys.size > 0 ? [...keys] : undefined;
}

/** Positive, response-safe projection for persisted/materialized agent rows. */
export function projectAgentResponse(agent: UnknownRecord): AgentResponse {
  const projected: AgentResponse = {
    id: agent.id as string,
    companyId: agent.companyId as string,
    name: agent.name as string,
    urlKey: agent.urlKey as string,
    role: agent.role as AgentResponse["role"],
    title: agent.title as string | null,
    icon: agent.icon as string | null,
    status: agent.status as AgentResponse["status"],
    reportsTo: agent.reportsTo as string | null,
    capabilities: agent.capabilities as string | null,
    adapterType: agent.adapterType as AgentResponse["adapterType"],
    adapterConfig: projectAgentAdapterConfig(agent.adapterConfig),
    runtimeConfig: projectAgentRuntimeConfig(agent.runtimeConfig),
    defaultEnvironmentId: typeof agent.defaultEnvironmentId === "string" ? agent.defaultEnvironmentId : null,
    budgetMonthlyCents: agent.budgetMonthlyCents as number,
    spentMonthlyCents: agent.spentMonthlyCents as number,
    pauseReason: agent.pauseReason as AgentResponse["pauseReason"],
    pausedAt: agent.pausedAt as Date | null,
    errorReason: typeof agent.errorReason === "string" ? agent.errorReason : null,
    permissions: projectAgentPermissions(agent.permissions),
    lastHeartbeatAt: agent.lastHeartbeatAt as Date | null,
    metadata: null,
    createdAt: agent.createdAt as Date,
    updatedAt: agent.updatedAt as Date,
  };
  const requiredUserSecretKeys = projectRequiredUserSecretKeys(agent.adapterConfig);
  if (requiredUserSecretKeys) projected.requiredUserSecretKeys = requiredUserSecretKeys;
  const orgChainHealth = projectOrgChainHealth(agent.orgChainHealth);
  if (orgChainHealth) projected.orgChainHealth = orgChainHealth;
  return projected;
}
