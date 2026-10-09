import { cn } from "@/lib/utils";
import { Check, Circle, Loader2 } from "lucide-react";
import type { TaskChatPlan, TaskChatPlanEntryStatus } from "./task-chat-model";

const STATUS_ICON: Record<TaskChatPlanEntryStatus, { Icon: typeof Check; spin: boolean; tone: string }> = {
  completed: { Icon: Check, spin: false, tone: "text-(--status-task-icon-done)" },
  in_progress: { Icon: Loader2, spin: true, tone: "text-(--status-agent-running)" },
  pending: { Icon: Circle, spin: false, tone: "text-muted-foreground" },
};

const PRIORITY_TONE = {
  high: "text-destructive",
  medium: "text-(--status-agent-paused)",
  low: "text-muted-foreground",
} as const;

/**
 * Structured plan/todo viewer (ACP Plan / PlanEntry). Used both by the harness
 * "plan-todo" state and by the properties-pane Plans tab. Renders a live
 * checklist with per-entry status and a revision label; entries stagger in.
 */
export function TaskChatPlanView({ plan }: { plan: TaskChatPlan }) {
  const done = plan.entries.filter((e) => e.status === "completed").length;
  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Plan</span>
        <span>· rev {plan.revision}</span>
        <span className="ml-auto">
          {done}/{plan.entries.length} done
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {plan.entries.map((entry, i) => {
          const { Icon, spin, tone } = STATUS_ICON[entry.status];
          return (
            <li
              key={entry.id}
              className="tc-enter-plan-entry flex items-start gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1.5 text-sm"
              style={{ animationDelay: `calc(var(--motion-plan-entry-stagger) * ${i})` }}
            >
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone, spin && "animate-spin")} />
              <span className={cn("min-w-0 flex-1", entry.status === "completed" && "text-muted-foreground line-through")}>
                {entry.content}
              </span>
              <span className={cn("shrink-0 text-(length:--text-nano) uppercase tracking-wide", PRIORITY_TONE[entry.priority])}>
                {entry.priority}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
