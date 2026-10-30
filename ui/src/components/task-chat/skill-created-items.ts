import type { ActivityEvent } from "@paperclipai/shared";
import type { TaskChatSkillCreatedItem } from "./task-chat-model";

export function skillCreatedItems(events: readonly ActivityEvent[]): TaskChatSkillCreatedItem[] {
  const seen = new Set<string>();
  return events.flatMap((event) => {
    if (event.action !== "company.skill_created" || event.entityType !== "company_skill" || seen.has(event.entityId)) return [];
    const details = event.details ?? {};
    if (typeof details.name !== "string") return [];
    seen.add(event.entityId);
    return [{
      id: `skill-created:${event.entityId}`,
      kind: "skill_created" as const,
      skillId: event.entityId,
      name: details.name,
      description: typeof details.description === "string" ? details.description : null,
      slug: typeof details.slug === "string" ? details.slug : null,
      versionId: typeof details.versionId === "string" ? details.versionId : null,
      timestamp: new Date(event.createdAt).toISOString(),
    }];
  });
}
