import type { ProjectRepository, ProjectWorkspace } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

/** Prefer current provider metadata; unavailable existing selections can remain. */
export function resolveProjectRepositorySelection(
  ids: string[],
  available: ProjectRepository[],
  existing: Pick<ProjectWorkspace, "name" | "repoUrl" | "metadata">[] = [],
): ProjectRepository[] {
  return [...new Set(ids)].map((id) => {
    const current = available.find((repo) => repo.id === id);
    if (current) return current;
    const retained = existing.find((workspace) => workspace.repoUrl &&
      (workspace.metadata?.repositoryId === id || workspace.metadata?.githubRepositoryId === id));
    if (retained) {
      const metadata = retained.metadata ?? {};
      const provider = typeof metadata.repositoryProvider === "string" ? metadata.repositoryProvider : undefined;
      const privateValue = typeof metadata.repositoryPrivate === "boolean" ? metadata.repositoryPrivate : metadata.githubRepositoryPrivate;
      return { id, fullName: retained.name, url: retained.repoUrl!, connections: [],
        ...(provider && provider !== "github" ? { provider } : {}),
        ...(typeof privateValue === "boolean" ? { private: privateValue } : {}) };
    }
    throw unprocessable("A selected repository is no longer available. Refresh repositories and try again.");
  });
}
