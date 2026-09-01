import { Brain } from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { cn } from "@/lib/utils";
import type {
  TaskChatItem,
  TaskChatMessageItem,
  TaskChatThinkingItem,
  TaskChatToolItem,
} from "./task-chat-model";
import { TaskChatLiveRunPill } from "./TaskChatLiveRunPill";
import { TaskChatLiveTail } from "./TaskChatLiveTail";
import { isTerminalRunStatus } from "./transcript-adapter";
import { toolTaxonomy } from "./tool-taxonomy";

function lastOf<T extends TaskChatItem>(
  items: readonly TaskChatItem[],
  predicate: (item: TaskChatItem) => item is T,
): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && predicate(item)) return item;
  }
  return undefined;
}

function CurrentActivity({ items }: { items: readonly TaskChatItem[] }) {
  const activity = lastOf<TaskChatThinkingItem | TaskChatToolItem>(
    items,
    (item): item is TaskChatThinkingItem | TaskChatToolItem =>
      item.kind === "thinking" || item.kind === "tool",
  );
  if (!activity || activity.kind === "thinking") {
    return (
      <div
        className="flex items-center gap-2 px-1 py-1.5 text-sm text-muted-foreground"
        data-testid="task-chat-current-activity"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="shimmer-text shimmer-text-muted">Thinking</span>
      </div>
    );
  }
  const taxonomy = toolTaxonomy(activity.rawName ?? activity.name);
  const Icon = taxonomy.icon;
  const active = activity.status === "pending" || activity.status === "in_progress";
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-1 py-1.5 text-sm text-muted-foreground"
      data-testid="task-chat-current-activity"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className={cn("shrink-0", active && "shimmer-text shimmer-text-muted")}>
        {taxonomy.verbLabel}
      </span>
      {activity.target ? (
        <span className="min-w-0 truncate font-mono text-xs">{activity.target}</span>
      ) : null}
    </div>
  );
}

/**
 * Runner-only live turn. Its compact parent row and final response are driven
 * by persisted runtime facts; direct adapters continue through TaskChatLiveTail.
 */
export function TaskChatRunnerTurn({
  items,
  status,
  startedAtMs,
  finishedAtMs,
  toolSummary,
}: {
  items: readonly TaskChatItem[];
  status: string;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  toolSummary: string | null;
}) {
  const terminal = isTerminalRunStatus(status);
  const progress = lastOf<TaskChatMessageItem>(
    items,
    (item): item is TaskChatMessageItem =>
      item.kind === "message" &&
      (item.channel === "progress" || (!terminal && item.channel === "unknown")),
  );
  const final = lastOf<TaskChatMessageItem>(
    items,
    (item): item is TaskChatMessageItem =>
      item.kind === "message" &&
      (item.channel === "final" || (terminal && item.channel === "unknown")),
  );
  const activityItems = items.filter((item) => item.kind !== "message");

  if (status === "queued") {
    return (
      <div className="py-1" data-testid="task-chat-runner-turn" data-phase="startup">
        <CurrentActivity items={items} />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col" data-testid="task-chat-runner-turn">
      <TaskChatLiveRunPill
        status={status}
        startedAtMs={startedAtMs}
        finishedAtMs={finishedAtMs}
        toolSummary={toolSummary}
      />
      <div className="flex flex-col gap-2 py-2">
        <TaskChatLiveTail items={activityItems} />
      </div>
      {progress || (!final && !terminal) ? (
        <div className="flex min-w-0 flex-col py-1">
          {progress ? (
            <div
              className="tc-enter-cot-line min-w-0 px-1 py-1.5 text-sm text-foreground/90"
              data-testid="task-chat-progress-update"
            >
              <MarkdownBody softBreaks linkIssueReferences>
                {progress.text}
              </MarkdownBody>
            </div>
          ) : null}
          {!final && !terminal ? <CurrentActivity items={items} /> : null}
        </div>
      ) : null}
      {final ? (
        <div
          className="tc-enter-bubble px-1 py-2 text-sm text-foreground"
          data-testid="task-chat-final-response"
        >
          <MarkdownBody softBreaks linkIssueReferences>
            {final.text}
          </MarkdownBody>
        </div>
      ) : null}
    </div>
  );
}
