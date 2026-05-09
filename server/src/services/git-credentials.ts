import type { Db } from "@paperclipai/db";
import type { ClusterTenantPoliciesService } from "./cluster-tenant-policies.js";

export interface SecretService {
  resolve(secretId: string): Promise<string>;
}

export type IssueGitCredentialsResult =
  | { ok: true; username: string; password: string; expiresAt: string }
  | { ok: false; reason: "not_configured" | "denied" | "internal_error" };

export interface IssueGitCredentialsInput {
  companyId: string;
  clusterConnectionId: string;
  repoUrl: string; // for logging/audit; M3a does not filter by URL
}

export interface IssueGitCredentialsDeps {
  db: Db;
  secretService: SecretService;
  clusterTenantPolicies: ClusterTenantPoliciesService;
}

/**
 * Resolve the per-company git credential secret and return the decoded
 * {username, password} pair. The TTL exposed to the caller is informational
 * only — the underlying companySecret is long-lived. We surface a 1h expiry
 * to keep workspace-init's contract identical to a future GitHub-App
 * implementation where the TTL becomes real.
 */
export async function issueGitCredentials(
  deps: IssueGitCredentialsDeps,
  input: IssueGitCredentialsInput,
): Promise<IssueGitCredentialsResult> {
  const policy = await deps.clusterTenantPolicies.get(input.clusterConnectionId, input.companyId);
  if (!policy?.gitCredentialsSecretId) return { ok: false, reason: "not_configured" };

  let resolved: string;
  try {
    resolved = await deps.secretService.resolve(policy.gitCredentialsSecretId);
  } catch {
    return { ok: false, reason: "internal_error" };
  }

  let parsed: { username?: unknown; password?: unknown };
  try {
    parsed = JSON.parse(resolved);
  } catch {
    return { ok: false, reason: "internal_error" };
  }

  if (typeof parsed.username !== "string" || typeof parsed.password !== "string") {
    return { ok: false, reason: "internal_error" };
  }

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return { ok: true, username: parsed.username, password: parsed.password, expiresAt };
}
