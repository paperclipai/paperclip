import type { ActivityEvent, Project } from "@paperclipai/shared";
import type { TaskChatProjectCreatedItem } from "./task-chat-model";

export function projectCreatedItems(
  events: readonly ActivityEvent[],
  projects: readonly Pick<Project, "id" | "companyId" | "workspaces">[] = [],
): TaskChatProjectCreatedItem[] {
  const seen = new Set<string>();
  return events.flatMap((event) => {
    if (
      event.action !== "project.created" ||
      event.entityType !== "project" ||
      seen.has(event.entityId)
    )
      return [];
    const details = event.details ?? {};
    if (typeof details.name !== "string") return [];
    seen.add(event.entityId);
    const project = projects.find(
      (candidate) =>
        candidate.id === event.entityId &&
        candidate.companyId === event.companyId,
    );
    const repositoryDetails = project
      ? project.workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          url: workspace.repoUrl,
        }))
      : details.repositories;
    const seenUrls = new Set<string>();
    const repositories = Array.isArray(repositoryDetails)
      ? repositoryDetails.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const repo = value as Record<string, unknown>;
          if (
            typeof repo.id !== "string" ||
            typeof repo.name !== "string" ||
            typeof repo.url !== "string" ||
            !/^https:\/\//.test(repo.url)
          )
            return [];
          if (seenUrls.has(repo.url)) return [];
          seenUrls.add(repo.url);
          return [{ id: repo.id, name: repo.name, url: repo.url }];
        })
      : [];
    return [
      {
        id: `project-created:${event.entityId}`,
        kind: "project_created" as const,
        projectId: event.entityId,
        name: details.name,
        description:
          typeof details.description === "string" ? details.description : null,
        repositories,
        timestamp: new Date(event.createdAt).toISOString(),
      },
    ];
  });
}
