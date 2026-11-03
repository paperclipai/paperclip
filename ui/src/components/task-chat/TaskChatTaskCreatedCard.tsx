import { ArrowUpRight, ListTree } from "lucide-react";
import { Link } from "@/lib/router";
import { IssueStatusBadge } from "@/components/StatusBadge";
import type { TaskChatTaskCreatedItem } from "./task-chat-model";

export function TaskChatTaskCreatedCard({ item }: { item: TaskChatTaskCreatedItem }) {
  const { task } = item;
  return (
    <Link
      to={`/issues/${task.identifier ?? task.id}`}
      aria-label={`Open ${task.identifier ?? "task"}: ${task.title}`}
      data-testid="task-chat-created-task"
      className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ListTree className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 space-y-2">
        <span className="block text-xs text-muted-foreground">{item.isSubtask ? "Subtask created" : "Task created"}</span>
        <span className="block break-words text-sm font-medium">{task.title}</span>
        <span className="flex flex-wrap items-center gap-2">
          {task.identifier && <span className="font-mono text-xs text-muted-foreground">{task.identifier}</span>}
          <IssueStatusBadge status={task.status} />
        </span>
      </span>
      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}
