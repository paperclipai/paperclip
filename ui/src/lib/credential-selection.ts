import type { CredentialType } from "@paperclipai/shared";

export type CredentialSelectionItem = {
  id: string;
  type: CredentialType | string;
};

function credentialTypeById(credentials: CredentialSelectionItem[]): Map<string, string> {
  return new Map(credentials.map((credential) => [credential.id, credential.type]));
}

export function hasMixedCodexAuthModes(
  credentials: CredentialSelectionItem[],
  selectedIds: string[],
): boolean {
  const typeById = credentialTypeById(credentials);
  const selectedTypes = new Set(selectedIds.map((id) => typeById.get(id)).filter(Boolean));
  return selectedTypes.has("codex_oauth") && selectedTypes.has("openai_api_key");
}

export function toggleCredentialSelectionForAuthMode(
  credentials: CredentialSelectionItem[],
  selectedIds: string[],
  credentialId: string,
  options: { enforceCodexAuthMode?: boolean } = {},
): string[] {
  const selectedSet = new Set(selectedIds);
  if (selectedSet.has(credentialId)) {
    return selectedIds.filter((id) => id !== credentialId);
  }

  const typeById = credentialTypeById(credentials);
  const credentialType = typeById.get(credentialId);
  const next = [...selectedIds, credentialId];

  if (options.enforceCodexAuthMode === false) return next;

  if (credentialType === "codex_oauth") {
    return next.filter((id) => typeById.get(id) !== "openai_api_key");
  }
  if (credentialType === "openai_api_key") {
    return next.filter((id) => typeById.get(id) !== "codex_oauth");
  }

  return next;
}
