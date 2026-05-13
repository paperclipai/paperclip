import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns } from "@paperclipai/db";
import type { ClusterTenantPoliciesService } from "./cluster-tenant-policies.js";

export interface SecretService {
  resolve(secretId: string): Promise<string>;
}

export type IssueGitCredentialsResult =
  | { ok: true; username: string; password: string; expiresAt: string }
  | { ok: false; reason: "not_configured" | "denied" | "internal_error" };

export interface IssueGitCredentialsInput {
  runId: string;
  companyId: string;
  clusterConnectionId: string;
  repoUrl: string;
}

export interface IssueGitCredentialsDeps {
  db: Db;
  secretService: SecretService;
  clusterTenantPolicies: ClusterTenantPoliciesService;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function canonicalRepoUrl(value: string): string {
  const trimmed = value.trim();
  const sshMatch = /^git@([^:]+):(.+)$/i.exec(trimmed);
  if (sshMatch) {
    return `${sshMatch[1]!.toLowerCase()}/${sshMatch[2]!}`
      .replace(/\.git$/i, "")
      .replace(/\/+$/g, "");
  }

  try {
    const url = new URL(trimmed);
    return `${url.host.toLowerCase()}${url.pathname}`
      .replace(/\.git$/i, "")
      .replace(/\/+$/g, "");
  } catch {
    return trimmed.replace(/\.git$/i, "").replace(/\/+$/g, "");
  }
}

function repoUrlsMatch(requested: string, expected: string): boolean {
  return requested.trim() === expected.trim() ||
    canonicalRepoUrl(requested) === canonicalRepoUrl(expected);
}

async function resolveRunRepoUrl(
  db: Db,
  input: Pick<IssueGitCredentialsInput, "runId" | "companyId">,
): Promise<string | null> {
  const rows = await db
    .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
    .limit(1);
  const context = readObject(rows[0]?.contextSnapshot);
  if (!context) return null;

  const paperclipWorkspace = readObject(context.paperclipWorkspace);
  const contextRepoUrl = readNonEmptyString(paperclipWorkspace?.repoUrl);
  if (contextRepoUrl) return contextRepoUrl;

  const executionWorkspaceId = readNonEmptyString(context.executionWorkspaceId);
  if (!executionWorkspaceId) return null;

  const workspaceRows = await db
    .select({ repoUrl: executionWorkspaces.repoUrl })
    .from(executionWorkspaces)
    .where(and(
      eq(executionWorkspaces.id, executionWorkspaceId),
      eq(executionWorkspaces.companyId, input.companyId),
    ))
    .limit(1);
  return readNonEmptyString(workspaceRows[0]?.repoUrl);
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
  const runRepoUrl = await resolveRunRepoUrl(deps.db, input);
  if (!runRepoUrl || !repoUrlsMatch(input.repoUrl, runRepoUrl)) {
    return { ok: false, reason: "denied" };
  }

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
