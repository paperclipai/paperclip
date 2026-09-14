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
  repo: { id: string; fullName: string; private?: boolean },
  connectionName: string,
) {
  const previous = repositories.get(repo.id);
  repositories.set(repo.id, {
    ...repo, url: `https://github.com/${repo.fullName}`,
    connections: [...new Set([...(previous?.connections ?? []), connectionName])],
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
    if (retained) return { id, fullName: retained.name, url: retained.repoUrl!, connections: [] };
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
