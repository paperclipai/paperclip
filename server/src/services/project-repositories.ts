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
