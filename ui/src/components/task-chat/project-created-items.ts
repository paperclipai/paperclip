import type { ActivityEvent } from "@paperclipai/shared";
import type { TaskChatProjectCreatedItem } from "./task-chat-model";

export function projectCreatedItems(events: readonly ActivityEvent[]): TaskChatProjectCreatedItem[] {
  const seen = new Set<string>();
  return events.flatMap(event => {
    if (event.action !== "project.created" || event.entityType !== "project" || seen.has(event.entityId)) return [];
    const details = event.details ?? {};
    if (typeof details.name !== "string") return [];
    seen.add(event.entityId);
    const repositories = Array.isArray(details.repositories) ? details.repositories.flatMap(value => {
      if (!value || typeof value !== "object") return [];
      const repo = value as Record<string, unknown>;
      if (typeof repo.id !== "string" || typeof repo.name !== "string" || typeof repo.url !== "string" || !/^https:\/\//.test(repo.url)) return [];
      return [{ id: repo.id, name: repo.name, url: repo.url }];
    }) : [];
    return [{ id: `project-created:${event.entityId}`, kind: "project_created" as const, projectId: event.entityId,
      name: details.name, description: typeof details.description === "string" ? details.description : null,
      repositories, timestamp: new Date(event.createdAt).toISOString() }];
  });
}
