import { useId } from "react";
import { Bot, ChevronRight } from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useSecondTick } from "@/hooks/useSecondTick";
import { cn } from "@/lib/utils";
import { useTaskChatExpansion } from "./expansion-state";
import type {
  TaskChatActivityPhaseItem,
  TaskChatSubagent,
  TaskChatSubagentStatus,
} from "./task-chat-model";

import { TaskChatRunnerActivityGroup } from "./TaskChatRunnerActivityGroup";

export type { TaskChatSubagent, TaskChatSubagentStatus } from "./task-chat-model";

/*
 * A delegated subagent (Claude `Task`/`Agent` tool call, Codex collab child
 * thread) shown as its own collapsible card inside the parent turn. Nested
 * tool rows reuse the runner activity group so a child reads exactly like a
 * parent turn, one level in.
 */

function formatElapsed(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

const STATUS_LABEL: Record<TaskChatSubagentStatus, string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

export function TaskChatSubagentStatusDot({ status }: { status: TaskChatSubagentStatus }) {
  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center" data-subagent-status={status}>
      {status === "running" ? (
        <span className="absolute size-2 rounded-full bg-(--status-agent-running) opacity-60 motion-safe:animate-ping" aria-hidden />
      ) : null}
      <span
        className={cn(
          "relative size-2 rounded-full",
          status === "running" && "bg-(--status-agent-running)",
          status === "completed" && "bg-(--status-task-icon-done)",
          status === "failed" && "bg-(--status-task-icon-blocked)",
          status === "cancelled" && "bg-muted-foreground",
        )}
        aria-hidden
      />
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </span>
  );
}

function toolCount(subagent: TaskChatSubagent): number {
  return subagent.activity.filter((item) => item.kind === "tool" || (item.kind === "protocol" && item.surface === "provider_activity")).length;
}

function useElapsed(subagent: TaskChatSubagent): string | null {
  const running = subagent.status === "running";
  useSecondTick(running);
  if (subagent.startedAtMs == null) return null;
  const end = running ? Date.now() : (subagent.finishedAtMs ?? null);
  return end == null ? null : formatElapsed(end - subagent.startedAtMs);
}

function SubagentMeta({ subagent }: { subagent: TaskChatSubagent }) {
  const elapsed = useElapsed(subagent);
  const tools = toolCount(subagent);
  const parts = [tools > 0 ? `${tools} ${tools === 1 ? "tool" : "tools"}` : null, elapsed].filter(Boolean);
  if (parts.length === 0) return null;
  return <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{parts.join(" · ")}</span>;
}

function SubagentBody({ subagent }: { subagent: TaskChatSubagent }) {
  const running = subagent.status === "running";
  const phase: TaskChatActivityPhaseItem = {
    id: `${subagent.id}:activity`,
    kind: "activity_phase",
    items: subagent.activity,
    summary: "",
    active: running,
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 px-3 pb-3" data-testid="task-chat-subagent-body">
      {subagent.prompt ? (
        <details className="group min-w-0 text-xs text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground">
            <ChevronRight className="size-3.5 shrink-0 group-open:rotate-90" aria-hidden />
            Prompt{subagent.model ? <span className="font-mono"> · {subagent.model}</span> : null}
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 leading-relaxed">{subagent.prompt}</div>
        </details>
      ) : null}
      {subagent.activity.length > 0 ? <TaskChatRunnerActivityGroup item={phase} /> : null}
      {subagent.result ? (
        <div className="max-h-(--sz-subagent-result-max-h) min-w-0 overflow-y-auto border-t border-border pt-2 text-sm text-foreground/90" data-testid="task-chat-subagent-result">
          <MarkdownBody softBreaks>{subagent.result}</MarkdownBody>
        </div>
      ) : null}
    </div>
  );
}

/** One subagent row: header always visible, body on expand. */
export function TaskChatSubagentCard({
  subagent,
  defaultExpanded,
  nested = false,
}: {
  subagent: TaskChatSubagent;
  defaultExpanded?: boolean;
  /** Inside a parallel tree: drop the outer border, the tree draws it. */
  nested?: boolean;
}) {
  const running = subagent.status === "running";
  const [open, setOpen] = useTaskChatExpansion(`subagent:${subagent.id}`, defaultExpanded ?? false);
  const bodyId = useId();
  const liveLine = running ? subagent.progressSummary : undefined;
  return (
    <div
      className={cn(
        "min-w-0",
        !nested && "rounded-lg border border-border bg-card",
        nested && open && "rounded-md bg-muted/30",
      )}
      data-testid="task-chat-subagent-card"
      data-subagent-id={subagent.id}
      data-expanded={open}
    >
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          nested && "px-2",
        )}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
      >
        <span className="flex h-5 shrink-0 items-center">
          {nested ? <TaskChatSubagentStatusDot status={subagent.status} /> : (
            <span className="flex size-5 items-center justify-center text-muted-foreground"><Bot className="size-3.5" aria-hidden /></span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-sm bg-muted px-1.5 font-mono text-xs text-muted-foreground">{subagent.agentType}</span>
            <span className="min-w-0 truncate text-sm text-foreground">{subagent.description}</span>
          </span>
          {liveLine ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground shimmer-text" data-testid="task-chat-subagent-progress">
              {liveLine}
            </span>
          ) : !running && !open && subagent.status !== "completed" ? (
            <span className="text-xs text-(--status-task-icon-blocked)">{STATUS_LABEL[subagent.status]}</span>
          ) : null}
        </span>
        <span className="flex h-5 shrink-0 items-center gap-1.5">
          <SubagentMeta subagent={subagent} />
          {!nested ? <TaskChatSubagentStatusDot status={subagent.status} /> : null}
          <ChevronRight className={cn("size-3.5 text-muted-foreground", open && "rotate-90")} aria-hidden />
        </span>
      </button>
      {open ? <div id={bodyId}><SubagentBody subagent={subagent} /></div> : null}
    </div>
  );
}

/** Parallel subagents dispatched together, shown as a small tree. A single
 * subagent renders as its own card with no group header. */
export function TaskChatSubagentTree({ subagents }: { subagents: readonly TaskChatSubagent[] }) {
  if (subagents.length === 0) return null;
  if (subagents.length === 1) return <TaskChatSubagentCard subagent={subagents[0]!} />;
  const running = subagents.filter((subagent) => subagent.status === "running").length;
  const failed = subagents.filter((subagent) => subagent.status === "failed").length;
  const label = running > 0
    ? `Running ${subagents.length} subagents · ${subagents.length - running} done`
    : failed > 0
      ? `Ran ${subagents.length} subagents · ${failed} failed`
      : `Ran ${subagents.length} subagents`;
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card" data-testid="task-chat-subagent-tree">
      <div className="flex min-h-9 items-center gap-2 px-3 pt-2 text-xs text-muted-foreground">
        <span className="flex size-5 items-center justify-center"><Bot className="size-3.5" aria-hidden /></span>
        <span className={cn(running > 0 && "text-foreground")}>{label}</span>
      </div>
      <ol className="ml-5 flex min-w-0 flex-col gap-0.5 border-l border-border py-1 pl-2 pr-1 pb-2" aria-label="Subagents">
        {subagents.map((subagent) => (
          <li key={subagent.id} className="min-w-0">
            <TaskChatSubagentCard subagent={subagent} nested />
          </li>
        ))}
      </ol>
    </section>
  );
}
