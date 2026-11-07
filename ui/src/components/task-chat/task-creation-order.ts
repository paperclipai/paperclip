import type { TaskChatItem } from "./task-chat-model";

/** Suggestions retain this owner when acceptance morphs them into created tasks. */
export function taskCreationSourceRunId(item: TaskChatItem): string | null {
  if (item.kind === "task_handoff") return item.handoff.sourceRunId ?? null;
  if (item.kind === "interaction" && item.interaction.kind === "suggest_tasks") {
    return item.interaction.sourceRunId ?? null;
  }
  return null;
}

/**
 * A task card closes its source agent turn, including its final reply and every
 * steering segment. Run ownership is explicit; unavailable history and older
 * handoffs without provenance keep their existing chronological slots.
 * Apply before settled turns merge so a card also preserves its run boundary.
 */
export function orderTaskCreationItems(
  items: TaskChatItem[],
  sourceRunByItemId: ReadonlyMap<string, string>,
): TaskChatItem[] {
  const lastItemByRun = new Map<string, string>();
  for (const item of items) {
    const runId = sourceRunByItemId.get(item.id);
    if (runId) lastItemByRun.set(runId, item.id);
  }
  const cardsByAnchor = new Map<string, TaskChatItem[]>();
  const relocated = new Set<string>();
  for (const item of items) {
    const runId = taskCreationSourceRunId(item);
    const anchorId = runId ? lastItemByRun.get(runId) : undefined;
    if (!anchorId) continue;
    const cards = cardsByAnchor.get(anchorId) ?? [];
    cards.push(item);
    cardsByAnchor.set(anchorId, cards);
    relocated.add(item.id);
  }
  if (relocated.size === 0) return items;
  return items.flatMap(item => relocated.has(item.id)
    ? []
    : [item, ...(cardsByAnchor.get(item.id) ?? [])]);
}
