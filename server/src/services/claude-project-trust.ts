import { createHash } from "node:crypto";

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

const identityKeys: Array<keyof ClaudeProjectTrustIdentity> = [
  "companyId", "projectId", "workspaceId", "agentId", "sourceType", "cwd",
  "repoUrl", "repoRef", "defaultRef", "remoteProvider", "remoteWorkspaceRef",
];

export function claudeProjectTrustSessionIdentity(identity: ClaudeProjectTrustIdentity): string {
  return createHash("sha256").update(JSON.stringify(identityKeys.map((key) => identity[key]))).digest("hex");
}

/** A trust grant is valid only for the exact workspace source and agent approved by the board. */
export function matchesClaudeProjectTrustGrant(
  grant: ClaudeProjectTrustIdentity,
  current: ClaudeProjectTrustIdentity,
): boolean {
  return identityKeys.every((key) => Object.hasOwn(grant, key)) && identityKeys.every(
    (key) => grant[key] === current[key],
  );
}
