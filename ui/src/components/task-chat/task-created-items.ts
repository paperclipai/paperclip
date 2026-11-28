import type { Issue } from "@paperclipai/shared";
import type { TaskChatTaskCreatedItem } from "./task-chat-model";

/** Tasks come from the existing access-checked child/source-task reads, never tool output. */
export function taskCreatedItems(
  tasks: readonly Issue[],
  issueId: string | null,
  companyId: string | null | undefined,
  representedTaskIds: ReadonlySet<string>,
): TaskChatTaskCreatedItem[] {
  const seen = new Set(representedTaskIds);
  return tasks.flatMap((task) => {
    if (!task.createdByAgentId || task.id === issueId || seen.has(task.id) || task.companyId !== companyId) return [];
    seen.add(task.id);
    return [{
      id: `task-created:${task.id}`,
      kind: "task_created" as const,
      // Keep every status-presentation field so the chip matches the task pane.
      task: {
        id: task.id, identifier: task.identifier, title: task.title, status: task.status,
        displayStatus: task.displayStatus, externalConversationState: task.externalConversationState, blockerAttention: task.blockerAttention,
      },
      isSubtask: task.parentId === issueId,
      timestamp: new Date(task.createdAt).toISOString(),
    }];
  });
}
