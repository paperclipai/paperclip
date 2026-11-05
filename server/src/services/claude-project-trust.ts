export interface ClaudeProjectTrustIdentity {
  companyId: string;
  projectId: string;
  workspaceId: string;
  agentId: string;
  sourceType: string;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
  remoteProvider: string | null;
  remoteWorkspaceRef: string | null;
}

/** A trust grant is valid only for the exact workspace source and agent approved by the board. */
export function matchesClaudeProjectTrustGrant(
  grant: ClaudeProjectTrustIdentity,
  current: ClaudeProjectTrustIdentity,
): boolean {
  const keys: Array<keyof ClaudeProjectTrustIdentity> = [
    "companyId", "projectId", "workspaceId", "agentId", "sourceType", "cwd",
    "repoUrl", "repoRef", "defaultRef", "remoteProvider", "remoteWorkspaceRef",
  ];
  return keys.every((key) => Object.hasOwn(grant, key)) && keys.every(
    (key) => grant[key] === current[key],
  );
}
