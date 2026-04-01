import type {
  AdapterAuthRequirementStatus,
  AdapterAuthStatusResponse,
} from "@paperclipai/shared";

export type AdapterAuthSelectionMap = Record<string, string>;

function isRequirementResolved(
  requirement: AdapterAuthRequirementStatus,
  selections: AdapterAuthSelectionMap,
): boolean {
  if (requirement.resolved) return true;
  const selectedCredentialId = selections[requirement.requirementId];
  if (!selectedCredentialId) return false;
  return requirement.availableCredentials.some((credential) => credential.id === selectedCredentialId);
}

export function countUnresolvedAdapterAuth(
  status: AdapterAuthStatusResponse | null | undefined,
  selections: AdapterAuthSelectionMap,
): number {
  if (!status) return 0;
  return status.requirements.filter((requirement) => !isRequirementResolved(requirement, selections)).length;
}

export function applyAdapterAuthSelections(
  adapterConfig: Record<string, unknown>,
  status: AdapterAuthStatusResponse | null | undefined,
  selections: AdapterAuthSelectionMap,
): Record<string, unknown> {
  if (!status || status.requirements.length === 0) return adapterConfig;

  const env =
    typeof adapterConfig.env === "object" &&
    adapterConfig.env !== null &&
    !Array.isArray(adapterConfig.env)
      ? { ...(adapterConfig.env as Record<string, unknown>) }
      : {};

  let changed = false;
  for (const requirement of status.requirements) {
    const selectedCredentialId = selections[requirement.requirementId];
    if (!selectedCredentialId) continue;

    const selectedCredential = requirement.availableCredentials.find(
      (credential) => credential.id === selectedCredentialId,
    );
    if (!selectedCredential) continue;

    env[selectedCredential.envKey] = {
      type: "secret_ref",
      secretId: selectedCredential.secretId,
      version: "latest",
    };
    changed = true;
  }

  if (!changed) return adapterConfig;
  return {
    ...adapterConfig,
    env,
  };
}

export function pruneAdapterAuthSelections(
  status: AdapterAuthStatusResponse | null | undefined,
  selections: AdapterAuthSelectionMap,
): AdapterAuthSelectionMap {
  if (!status) return {};
  const next: AdapterAuthSelectionMap = {};

  for (const requirement of status.requirements) {
    const selectedCredentialId = selections[requirement.requirementId];
    if (!selectedCredentialId) continue;
    if (requirement.availableCredentials.some((credential) => credential.id === selectedCredentialId)) {
      next[requirement.requirementId] = selectedCredentialId;
    }
  }

  return next;
}

export function requirementMissingMessage(requirement: AdapterAuthRequirementStatus): string {
  if (requirement.unresolvedReason) return requirement.unresolvedReason;
  if (requirement.requiredEnvKeys.length > 0) {
    return `Requires ${requirement.requiredEnvKeys.join(" or ")}.`;
  }
  return "Authentication setup is required.";
}
