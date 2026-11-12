import { connectionGrants, toolConnections } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { ghFetch } from "./github-fetch.js";
import type { ProjectRepository, ProjectWorkspace } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { isConnectionGrantAudienceAllowed } from "./tool-gateway.js";

export function canBrowseProjectRepositoryGrant(input: {
  grant: { status: string; kind: string; subjectUserId: string | null };
  userId: string | null;
  activeMember: boolean;
  audience: string[];
}) {
  const { grant, userId, activeMember, audience } = input;
  if (grant.status !== "active") return false;
  if (grant.kind === "user") return Boolean(userId && activeMember && grant.subjectUserId === userId);
  return grant.kind === "organization" && isConnectionGrantAudienceAllowed(audience, userId, activeMember);
}

export function mergeProjectRepository(
  repositories: Map<string, ProjectRepository>,
  repo: { id: string; fullName: string; private?: boolean; ownerType?: ProjectRepository["ownerType"] },
  connectionName: string,
  connectionId?: string,
) {
  const previous = repositories.get(repo.id);
  repositories.set(repo.id, {
    ...repo, url: `https://github.com/${repo.fullName}`,
    connections: [...new Set([...(previous?.connections ?? []), connectionName])],
    ...(connectionId ? { connectionIds: [...new Set([...(previous?.connectionIds ?? []), connectionId])] } : {}),
  });
}

/** Prefer current provider metadata; unavailable existing selections can remain. */
export function resolveProjectRepositorySelection(
  ids: string[],
  available: ProjectRepository[],
  existing: Pick<ProjectWorkspace, "name" | "repoUrl" | "metadata">[] = [],
): ProjectRepository[] {
  return [...new Set(ids)].map((id) => {
    const current = available.find((repo) => repo.id === id);
    if (current) return current;
    const retained = existing.find((workspace) => workspace.metadata?.githubRepositoryId === id && workspace.repoUrl);
    if (retained) return { id, fullName: retained.name, url: retained.repoUrl!, connections: [],
      ...(typeof retained.metadata?.githubRepositoryPrivate === "boolean" ? { private: retained.metadata.githubRepositoryPrivate } : {}) };
    throw unprocessable("A selected GitHub repository is no longer available. Refresh repositories and try again.");
  });
}

/** Register an existing GitHub URL without assuming it is in the connection catalog.
 * No fetch or credential sharing: execution uses the normal repository access policy.
 */
export function normalizeProjectRepositoryUrl(value: string): { fullName: string; url: string } {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw unprocessable("Repository URL must be an HTTPS GitHub repository URL"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw unprocessable("Repository URL must be an HTTPS GitHub repository URL without credentials, query, or fragment");
  }
  const path = parsed.pathname.replace(/\/$/, "").replace(/\.git$/, "");
  if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) || path.split("/").some(part => part === "." || part === "..")) {
    throw unprocessable("Repository URL must identify a GitHub owner and repository");
  }
  return { fullName: path.slice(1), url: `https://github.com${path}` };
}

/** Use the freshest active catalog visibility (the UI lock), then retained selections. Legacy URL-only
 * sources need anonymous discovery; unknown visibility must never start a private clone. */
export async function projectRepositoryIsPrivate(
  db: import("@paperclipai/db").Db,
  companyId: string,
  workspace: Pick<ProjectWorkspace, "repoUrl" | "metadata">,
): Promise<boolean> {
  const repo = normalizeProjectRepositoryUrl(workspace.repoUrl!);
  const visibility = await db.select({
    refreshedAt: sql<string | null>`${connectionGrants.providerTenant}->'github'->>'lastAccessRefreshAt'`,
    private: sql<boolean | null>`(
    select bool_or((repository->>'private')::boolean)
    from jsonb_array_elements(coalesce(${connectionGrants.providerTenant}->'github'->'repositories', '[]'::jsonb)) repository
    where lower(repository->>'fullName') = ${repo.fullName.toLowerCase()}
  )` }).from(connectionGrants).innerJoin(toolConnections, and(
    eq(toolConnections.id, connectionGrants.connectionId), eq(toolConnections.companyId, companyId),
  )).where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.status, "active"),
    eq(toolConnections.status, "active"), eq(toolConnections.enabled, true)));
  // OAuth refreshes change updatedAt without observing repository visibility.
  const current = visibility.filter(row => typeof row.private === "boolean" && Number.isFinite(Date.parse(row.refreshedAt ?? "")))
    .sort((a, b) => Date.parse(b.refreshedAt!) - Date.parse(a.refreshedAt!))[0];
  if (current) return current.private!;
  if (workspace.metadata?.githubRepositoryUrl === repo.url && typeof workspace.metadata.githubRepositoryPrivate === "boolean") {
    return workspace.metadata.githubRepositoryPrivate;
  }
  const legacy = visibility.filter(row => typeof row.private === "boolean");
  if (legacy.length && legacy.every(row => row.private === legacy[0]!.private)) return legacy[0]!.private!;
  const response = await ghFetch(`https://api.github.com/repos/${repo.fullName}`, {
    headers: { Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) {
    const result = await response.json() as { full_name?: string; private?: boolean };
    if (result.full_name?.toLowerCase() === repo.fullName.toLowerCase() && result.private === false) return false;
  }
  throw unprocessable("Repository visibility is unavailable; retry discovery or refresh the GitHub repository selection before provisioning.");
}
