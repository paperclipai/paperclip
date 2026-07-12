export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role.trim().toLowerCase() === "ceo",
    canCreateSkills: true,
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  const preserved = { ...record };
  return {
    ...preserved,
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    canCreateSkills:
      typeof record.canCreateSkills === "boolean"
        ? record.canCreateSkills
        : defaults.canCreateSkills,
  };
}

// Merge a permissions patch onto an existing permissions record while keeping
// top-level `trustPreset` and nested `authorizationPolicy` consistent.
//
// Why: `/api/agents/:id/permissions` accepts partial updates. A shallow spread
// leaves the stale nested `authorizationPolicy` in the DB when the caller only
// changes `trustPreset` — and `trust-preset-resolver` treats the nested policy
// as authoritative, silently overriding the top-level preset (EXE-12657,
// EXE-13808). This helper drops the stale nested object when the preset moves
// without an explicit policy, and honours `authorizationPolicy: null` as an
// explicit "clear" intent.
export function sanitizePermissionsForUpdate(
  existing: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const existingRecord =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...existingRecord, ...patch };

  const presetChanged =
    typeof patch.trustPreset === "string" &&
    patch.trustPreset !== existingRecord.trustPreset;
  const policyExplicit = Object.prototype.hasOwnProperty.call(patch, "authorizationPolicy");

  if (policyExplicit && patch.authorizationPolicy === null) {
    delete merged.authorizationPolicy;
  } else if (presetChanged && !policyExplicit) {
    delete merged.authorizationPolicy;
  }

  return merged;
}
