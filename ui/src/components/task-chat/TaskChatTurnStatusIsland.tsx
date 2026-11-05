import { useId, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  LoaderCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  TaskChatItem,
  TaskChatProtocolStep,
  TaskChatProviderActivityItem,
  TaskChatWorkspaceChangeItem,
} from "./task-chat-model";

/**
 * Active-turn status docked above the composer.
 *
 * The plan is the provider-neutral `plan.updated` checklist (Claude task
 * tools, Codex `turn/plan/updated`, Cursor todos, any ACP `plan` update).
 * Visibility rules live here so every harness gets the same behavior:
 *
 * - Hidden when no plan steps and no workspace changes exist, and hidden once
 *   the run is terminal (the caller passes `null`; the turn transcript keeps
 *   the plan record).
 * - Single-step plans render as a header only: a one-item list adds no
 *   information beyond the header.
 * - Expanded by default while work remains; auto-collapses once every step is
 *   done unless the viewer explicitly reopened it.
 * - Forced to a header (`compact`) while a question or approval needs the
 *   viewer, so the decision stays the focus.
 * - Long plans show a window around the current step with "earlier" and
 *   "more" rows that reveal every step. The list always scrolls within a
 *   bounded height so it never covers the conversation.
 */

export type TaskChatTurnPlanSegment = {
  kind: "plan";
  steps: TaskChatProtocolStep[];
  currentStepIndex: number;
  complete: boolean;
};

export type TaskChatTurnStatusSegment =
  | TaskChatTurnPlanSegment
  | {
      kind: "workspace_diff";
      files: number;
      additions: number | null;
      deletions: number | null;
    };

export interface TaskChatTurnStatusModel {
  segments: TaskChatTurnStatusSegment[];
}

type WorkspaceSegment = Extract<TaskChatTurnStatusSegment, { kind: "workspace_diff" }>;

function latestPlan(items: readonly TaskChatItem[]): TaskChatProviderActivityItem | null {
  let latest: TaskChatProviderActivityItem | null = null;
  let latestOrder = -1;
  for (const [index, item] of items.entries()) {
    if (item.kind !== "protocol" || item.surface !== "provider_activity" || item.family !== "plan") continue;
    const order = item.transcriptIndex ?? index;
    if (order >= latestOrder) {
      latest = item;
      latestOrder = order;
    }
  }
  return latest;
}

function latestWorkspaceDiff(items: readonly TaskChatItem[]): TaskChatWorkspaceChangeItem | null {
  let latest: TaskChatWorkspaceChangeItem | null = null;
  for (const item of items) {
    if (item.kind === "protocol" && item.surface === "workspace_change") latest = item;
  }
  return latest;
}

function currentStepIndex(steps: readonly TaskChatProtocolStep[]): number {
  const inProgress = steps.findIndex((step) => step.status === "in_progress");
  if (inProgress >= 0) return inProgress;
  const blocked = steps.findIndex((step) => step.status === "blocked" || step.status === "failed");
  if (blocked >= 0) return blocked;
  const pending = steps.findIndex((step) => step.status === "pending");
  if (pending >= 0) return pending;
  return Math.max(0, steps.length - 1);
}

export function taskChatTurnPlanSegment(steps: TaskChatProtocolStep[]): TaskChatTurnPlanSegment {
  return {
    kind: "plan",
    steps,
    currentStepIndex: currentStepIndex(steps),
    complete: steps.length > 0 && steps.every((step) => step.status === "completed"),
  };
}

export function taskChatTurnStatusModel(items: readonly TaskChatItem[]): TaskChatTurnStatusModel | null {
  const segments: TaskChatTurnStatusSegment[] = [];
  const plan = latestPlan(items);
  if (plan && plan.steps.length > 0) segments.push(taskChatTurnPlanSegment(plan.steps));
  const workspace = latestWorkspaceDiff(items);
  const files = workspace ? workspace.totals.files || workspace.files.length : 0;
  if (workspace && files > 0) {
    segments.push({
      kind: "workspace_diff",
      files,
      additions: workspace.totals.additions,
      deletions: workspace.totals.deletions,
    });
  }
  return segments.length > 0 ? { segments } : null;
}

/** Plans up to this length always list every step. */
export const PLAN_FULL_LIST_LIMIT = 7;
const PLAN_WINDOW_SIZE = 5;

export type TaskChatTurnPlanRow =
  | { kind: "step"; step: TaskChatProtocolStep; index: number; current: boolean }
  | { kind: "earlier"; count: number; allCompleted: boolean }
  | { kind: "more"; count: number };

/** Rows to render: every step for short plans, else a window around the current step. */
export function taskChatTurnPlanRows(plan: TaskChatTurnPlanSegment, showAll: boolean): TaskChatTurnPlanRow[] {
  const toRow = (step: TaskChatProtocolStep, index: number): TaskChatTurnPlanRow => ({
    kind: "step",
    step,
    index,
    current: !plan.complete && index === plan.currentStepIndex,
  });
  if (showAll || plan.steps.length <= PLAN_FULL_LIST_LIMIT) return plan.steps.map(toRow);
  const start = Math.max(0, Math.min(plan.currentStepIndex - 1, plan.steps.length - PLAN_WINDOW_SIZE));
  const end = Math.min(plan.steps.length, start + PLAN_WINDOW_SIZE);
  const rows: TaskChatTurnPlanRow[] = [];
  if (start > 0) {
    rows.push({
      kind: "earlier",
      count: start,
      allCompleted: plan.steps.slice(0, start).every((step) => step.status === "completed"),
    });
  }
  for (let index = start; index < end; index += 1) rows.push(toRow(plan.steps[index]!, index));
  if (end < plan.steps.length) rows.push({ kind: "more", count: plan.steps.length - end });
  return rows;
}

function isProblem(step: TaskChatProtocolStep | undefined): boolean {
  return step?.status === "blocked" || step?.status === "failed";
}

export function taskChatTurnPlanHeadline(plan: TaskChatTurnPlanSegment): string {
  const step = plan.steps[plan.currentStepIndex];
  if (plan.complete) return plan.steps.length === 1 ? "Step done" : `All ${plan.steps.length} steps done`;
  if (!step) return "Plan";
  if (isProblem(step)) return `Blocked: ${step.label}`;
  if (step.status === "pending") return `Up next: ${step.label}`;
  return step.label;
}

function planHeaderIcon(plan: TaskChatTurnPlanSegment) {
  const status = plan.steps[plan.currentStepIndex]?.status;
  if (plan.complete) return <CheckCircle2 className="size-4 shrink-0 text-(--status-task-icon-done)" aria-hidden />;
  if (status === "blocked" || status === "failed") {
    return <CircleAlert className="size-4 shrink-0 text-(--status-task-icon-blocked)" aria-hidden />;
  }
  if (status === "pending") return <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
  return <LoaderCircle className="size-4 shrink-0 text-(--status-agent-running) motion-safe:animate-spin" aria-hidden />;
}

function checklistIcon(step: TaskChatProtocolStep) {
  if (step.status === "completed") {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-(--status-task-icon-done)" aria-hidden />;
  }
  if (step.status === "in_progress") {
    return <LoaderCircle className="mt-0.5 size-4 shrink-0 text-(--status-agent-running) motion-safe:animate-spin" aria-hidden />;
  }
  if (isProblem(step)) {
    return <CircleAlert className="mt-0.5 size-4 shrink-0 text-(--status-task-icon-blocked)" aria-hidden />;
  }
  return <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

const STEP_STATUS_LABEL: Record<TaskChatProtocolStep["status"], string> = {
  completed: "done",
  in_progress: "in progress",
  pending: "not started",
  blocked: "blocked",
  failed: "failed",
};

function fileCountLabel(files: number): string {
  return `${files} ${files === 1 ? "file" : "files"} changed`;
}

function WorkspaceStats({ workspace, compact }: { workspace: WorkspaceSegment; compact?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={cn("min-w-0 truncate text-sm text-muted-foreground", compact && "sr-only")}>
        {fileCountLabel(workspace.files)}
      </span>
      {workspace.additions != null ? (
        <span className="shrink-0 font-mono text-sm tabular-nums text-(--status-task-icon-done)">
          +{workspace.additions}
        </span>
      ) : null}
      {workspace.deletions != null ? (
        <span className="shrink-0 font-mono text-sm tabular-nums text-(--status-task-icon-blocked)">
          −{workspace.deletions}
        </span>
      ) : null}
    </span>
  );
}

const ISLAND_CLASS_NAME = "mx-auto flex min-h-10 max-w-(--sz-turn-status-island) items-center overflow-hidden rounded-full border border-border bg-popover/95 px-4 py-2 text-foreground shadow-sm backdrop-blur";

const ROW_BUTTON_CLASS_NAME = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function PlanRow({ row, onShowAll }: { row: TaskChatTurnPlanRow; onShowAll: () => void }) {
  if (row.kind === "earlier") {
    return (
      <li>
        <button type="button" className={ROW_BUTTON_CLASS_NAME} onClick={onShowAll} data-testid="task-chat-turn-plan-earlier">
          {row.allCompleted
            ? <CheckCircle2 className="size-4 shrink-0 text-(--status-task-icon-done)" aria-hidden />
            : <Circle className="size-4 shrink-0" aria-hidden />}
          <span>{row.count} earlier {row.count === 1 ? "step" : "steps"}{row.allCompleted ? " done" : ""}</span>
        </button>
      </li>
    );
  }
  if (row.kind === "more") {
    return (
      <li>
        <button type="button" className={ROW_BUTTON_CLASS_NAME} onClick={onShowAll} data-testid="task-chat-turn-plan-more">
          <Circle className="size-4 shrink-0 opacity-0" aria-hidden />
          <span>+{row.count} more {row.count === 1 ? "step" : "steps"}</span>
        </button>
      </li>
    );
  }
  const { step, current } = row;
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-md px-2 py-1.5 text-sm leading-5",
        current && "bg-muted font-medium text-foreground",
        step.status === "completed" && "text-muted-foreground",
        step.status === "pending" && !current && "text-foreground",
        isProblem(step) && "text-foreground",
      )}
      aria-current={current ? "step" : undefined}
      data-step-status={step.status}
    >
      {checklistIcon(step)}
      <span className="min-w-0 break-words">
        {step.label}
        <span className="sr-only"> ({STEP_STATUS_LABEL[step.status]})</span>
      </span>
    </li>
  );
}

export interface TaskChatTurnPlanProps {
  plan: TaskChatTurnPlanSegment;
  workspace?: WorkspaceSegment | null;
  /** Start collapsed (used on mobile, where dock height is scarce). */
  defaultCollapsed?: boolean;
  /** Force a header-only presentation while the viewer must answer something. */
  compact?: boolean;
}

export function TaskChatTurnPlan({ plan, workspace = null, defaultCollapsed = false, compact = false }: TaskChatTurnPlanProps) {
  const listId = useId();
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const total = plan.steps.length;
  const listable = total > 1;
  const automaticExpanded = !defaultCollapsed && !plan.complete;
  const expanded = listable && !compact && (expandedOverride ?? automaticExpanded);
  const headline = taskChatTurnPlanHeadline(plan);
  const rows = taskChatTurnPlanRows(plan, showAll);
  const problem = isProblem(plan.steps[plan.currentStepIndex]);

  const headerContent = (
    <>
      {planHeaderIcon(plan)}
      <span
        className={cn("min-w-0 flex-1 truncate text-left text-sm", !plan.complete && "font-medium")}
        aria-live="polite"
        aria-atomic="true"
        data-testid="task-chat-turn-plan-headline"
      >
        {headline}
      </span>
      {workspace ? <WorkspaceStats workspace={workspace} compact /> : null}
      <span
        className={cn("shrink-0 font-mono text-xs tabular-nums", problem ? "text-(--status-task-icon-blocked)" : "text-muted-foreground")}
        data-testid="task-chat-turn-plan-progress"
      >
        <span aria-hidden>{completed}/{total}</span>
        <span className="sr-only">{completed} of {total} steps done</span>
      </span>
    </>
  );

  return (
    <section
      aria-label="Agent plan"
      className="mx-auto w-full max-w-(--sz-turn-status-island) overflow-hidden rounded-xl border border-border bg-popover/95 text-foreground shadow-sm backdrop-blur"
      data-testid="task-chat-turn-status-island"
      data-plan-state={plan.complete ? "complete" : problem ? "blocked" : "active"}
      data-expanded={expanded ? "true" : "false"}
    >
      {listable && !compact ? (
        <button
          type="button"
          className="flex min-h-10 w-full items-center gap-2 px-3 py-2 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpandedOverride(!expanded)}
          data-testid="task-chat-turn-plan-header"
        >
          {headerContent}
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>
      ) : (
        <div className="flex min-h-10 w-full items-center gap-2 px-3 py-2" role="status" data-testid="task-chat-turn-plan-header">
          {headerContent}
        </div>
      )}
      <div
        className="h-0.5 w-full bg-muted"
        role="progressbar"
        aria-label="Plan progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
      >
        <div
          className={cn(
            "h-full transition-[width] motion-reduce:transition-none",
            problem ? "bg-(--status-task-icon-blocked)" : "bg-(--status-task-icon-done)",
          )}
          style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
        />
      </div>
      {expanded ? (
        <ol
          id={listId}
          aria-label="Within-turn checklist"
          className="flex max-h-(--sz-turn-plan-list-max-h) flex-col gap-0.5 overflow-y-auto p-1.5"
        >
          {rows.map((row) => (
            <PlanRow
              key={row.kind === "step" ? row.step.id : row.kind}
              row={row}
              onShowAll={() => setShowAll(true)}
            />
          ))}
          {showAll && total > PLAN_FULL_LIST_LIMIT ? (
            <li>
              <button type="button" className={ROW_BUTTON_CLASS_NAME} onClick={() => setShowAll(false)}>
                <Circle className="size-4 shrink-0 opacity-0" aria-hidden />
                <span>Show fewer</span>
              </button>
            </li>
          ) : null}
        </ol>
      ) : null}
    </section>
  );
}

export interface TaskChatTurnStatusIslandProps {
  model: TaskChatTurnStatusModel;
  defaultCollapsed?: boolean;
  compact?: boolean;
}

export function TaskChatTurnStatusIsland({ model, defaultCollapsed, compact }: TaskChatTurnStatusIslandProps) {
  const plan = model.segments.find((segment): segment is TaskChatTurnPlanSegment => segment.kind === "plan");
  const workspace = model.segments.find((segment): segment is WorkspaceSegment => segment.kind === "workspace_diff") ?? null;
  if (plan) {
    return <TaskChatTurnPlan plan={plan} workspace={workspace} defaultCollapsed={defaultCollapsed} compact={compact} />;
  }
  if (!workspace) return null;
  return (
    <div className={ISLAND_CLASS_NAME} role="status" data-testid="task-chat-turn-status-island">
      <WorkspaceStats workspace={workspace} />
    </div>
  );
}
