type UnknownRecord = Record<string, unknown>;

const SAFE_ADAPTER_SCALAR_FIELDS = [
  "provider",
  "model",
  "thinking",
  "engine",
  "mode",
  "nonInteractivePermissions",
  "warmHandleIdleMs",
  "timeoutSec",
  "graceSec",
  "maxTurnsPerRun",
  "toolsets",
  "persistSession",
  "worktreeMode",
  "checkpoints",
  "quiet",
  "verbose",
  "sessionKeyStrategy",
  "eventReconnectMs",
  "instructions",
  "promptTemplate",
  "bootstrapPromptTemplate",
] as const;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function projectSafeScalarFields(input: unknown): UnknownRecord {
  const source = asRecord(input);
  if (!source) return {};
  const result: UnknownRecord = {};
  for (const key of SAFE_ADAPTER_SCALAR_FIELDS) {
    const value = source[key];
    if (
      typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
      || value === null
    ) {
      result[key] = value;
    }
  }
  return result;
}

export function projectAgentAdapterConfig(input: unknown): UnknownRecord {
  return projectSafeScalarFields(input);
}

export function projectAgentRuntimeConfig(input: unknown): UnknownRecord {
  const source = asRecord(input);
  const profiles = asRecord(source?.modelProfiles);
  if (!profiles) return {};

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
  return Object.keys(projectedProfiles).length > 0
    ? { modelProfiles: projectedProfiles }
    : {};
}

function projectAgentPermissions(input: unknown): UnknownRecord {
  const source = asRecord(input);
  if (!source) return {};
  const result: UnknownRecord = {};
  if (typeof source.canCreateAgents === "boolean") result.canCreateAgents = source.canCreateAgents;
  if (typeof source.canCreateSkills === "boolean") result.canCreateSkills = source.canCreateSkills;
  if (typeof source.trustPreset === "string") result.trustPreset = source.trustPreset;
  return result;
}

function projectOrgChainHealth(input: unknown): UnknownRecord | undefined {
  const source = asRecord(input);
  if (!source) return undefined;
  const result: UnknownRecord = {};
  for (const key of ["status", "reason", "repairGuidance"] as const) {
    const value = source[key];
    if (typeof value === "string" || value === null) result[key] = value;
  }
  return result;
}

/**
 * Positive, response-safe projection for persisted/materialized agent rows.
 * Unknown top-level, config, runtime, permission, and metadata fields are denied
 * by default so newly added persistence fields cannot silently become API fields.
 */
export function projectAgentResponse(agent: UnknownRecord) {
  const projected: UnknownRecord = {
    id: agent.id,
    companyId: agent.companyId,
    name: agent.name,
    urlKey: agent.urlKey,
    role: agent.role,
    title: agent.title,
    icon: agent.icon,
    status: agent.status,
    reportsTo: agent.reportsTo,
    capabilities: agent.capabilities,
    adapterType: agent.adapterType,
    adapterConfig: projectAgentAdapterConfig(agent.adapterConfig),
    runtimeConfig: projectAgentRuntimeConfig(agent.runtimeConfig),
    defaultEnvironmentId: agent.defaultEnvironmentId ?? null,
    budgetMonthlyCents: agent.budgetMonthlyCents,
    spentMonthlyCents: agent.spentMonthlyCents,
    pauseReason: agent.pauseReason,
    pausedAt: agent.pausedAt,
    errorReason: agent.errorReason ?? null,
    permissions: projectAgentPermissions(agent.permissions),
    lastHeartbeatAt: agent.lastHeartbeatAt,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
  const orgChainHealth = projectOrgChainHealth(agent.orgChainHealth);
  if (orgChainHealth) projected.orgChainHealth = orgChainHealth;
  return projected;
}
