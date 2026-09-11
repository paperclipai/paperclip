import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  LoaderCircle,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type {
  TaskChatItem,
  TaskChatProtocolStep,
  TaskChatProviderActivityItem,
  TaskChatWorkspaceChangeItem,
} from "./task-chat-model";

export type TaskChatTurnStatusSegment =
  | {
      kind: "plan";
      steps: TaskChatProtocolStep[];
      currentStepIndex: number;
      complete: boolean;
    }
  | {
      kind: "workspace_diff";
      files: number;
      additions: number | null;
      deletions: number | null;
    };

export interface TaskChatTurnStatusModel {
  segments: TaskChatTurnStatusSegment[];
}

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

export function taskChatTurnStatusModel(items: readonly TaskChatItem[]): TaskChatTurnStatusModel | null {
  const segments: TaskChatTurnStatusSegment[] = [];
  const plan = latestPlan(items);
  if (plan && plan.steps.length > 0) {
    segments.push({
      kind: "plan",
      steps: plan.steps,
      currentStepIndex: currentStepIndex(plan.steps),
      complete: plan.steps.every((step) => step.status === "completed"),
    });
  }
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

function planIcon(plan: Extract<TaskChatTurnStatusSegment, { kind: "plan" }>) {
  const status = plan.steps[plan.currentStepIndex]?.status;
  if (plan.complete) return <CheckCircle2 className="size-4 text-(--status-task-icon-done)" aria-hidden />;
  if (status === "blocked" || status === "failed") {
    return <CircleAlert className="size-4 text-(--status-task-icon-blocked)" aria-hidden />;
  }
  return <LoaderCircle className="size-4 text-(--status-agent-running) motion-safe:animate-spin" aria-hidden />;
}

function checklistIcon(step: TaskChatProtocolStep) {
  if (step.status === "completed") {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-(--status-task-icon-done)" aria-hidden />;
  }
  if (step.status === "in_progress") {
    return <LoaderCircle className="mt-0.5 size-4 shrink-0 text-(--status-agent-running) motion-safe:animate-spin" aria-hidden />;
  }
  if (step.status === "blocked" || step.status === "failed") {
    return <CircleAlert className="mt-0.5 size-4 shrink-0 text-(--status-task-icon-blocked)" aria-hidden />;
  }
  return <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

function fileCountLabel(files: number): string {
  return `${files} ${files === 1 ? "file" : "files"} changed`;
}

function IslandBody({ model }: { model: TaskChatTurnStatusModel }) {
  const plan = model.segments.find(
    (segment): segment is Extract<TaskChatTurnStatusSegment, { kind: "plan" }> => segment.kind === "plan",
  );
  const workspace = model.segments.find(
    (segment): segment is Extract<TaskChatTurnStatusSegment, { kind: "workspace_diff" }> => segment.kind === "workspace_diff",
  );
  return (
    <span className="flex min-w-0 items-center gap-2">
      {plan ? (
        <span className="flex shrink-0 items-center gap-2">
          {planIcon(plan)}
          <span className="font-mono text-sm tabular-nums" aria-live="polite" aria-atomic="true">
            Step {plan.currentStepIndex + 1} / {plan.steps.length}
            <span className="sr-only">: {plan.steps[plan.currentStepIndex]?.label}</span>
          </span>
        </span>
      ) : null}
      {plan && workspace ? <span className="text-muted-foreground" aria-hidden>·</span> : null}
      {workspace ? (
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm text-muted-foreground">
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
      ) : null}
    </span>
  );
}

function islandLabel(model: TaskChatTurnStatusModel): string {
  const parts: string[] = [];
  for (const segment of model.segments) {
    if (segment.kind === "plan") {
      const step = segment.steps[segment.currentStepIndex];
      parts.push(`Step ${segment.currentStepIndex + 1} of ${segment.steps.length}${step ? `: ${step.label}` : ""}`);
    } else {
      parts.push(fileCountLabel(segment.files));
      if (segment.additions != null) parts.push(`${segment.additions} additions`);
      if (segment.deletions != null) parts.push(`${segment.deletions} deletions`);
    }
  }
  return parts.join(", ");
}

const ISLAND_CLASS_NAME = "mx-auto flex min-h-10 max-w-(--sz-turn-status-island) items-center overflow-hidden rounded-full border border-border bg-popover/95 px-4 py-2 text-foreground shadow-sm backdrop-blur";

const HOVER_CLOSE_GRACE_MS = 100;

export function TaskChatTurnStatusIsland({ model }: { model: TaskChatTurnStatusModel }) {
  const plan = model.segments.find(
    (segment): segment is Extract<TaskChatTurnStatusSegment, { kind: "plan" }> => segment.kind === "plan",
  );
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    if (pinned) return;
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_GRACE_MS);
  };

  if (!plan) {
    return (
      <div className={ISLAND_CLASS_NAME} role="status" data-testid="task-chat-turn-status-island">
        <IslandBody model={model} />
      </div>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setPinned(false);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={islandLabel(model)}
          className={cn(
            ISLAND_CLASS_NAME,
            "cursor-pointer transition-colors hover:bg-muted/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none",
          )}
          data-testid="task-chat-turn-status-island"
          onPointerEnter={(event) => {
            if (event.pointerType !== "mouse") return;
            cancelClose();
            setOpen(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") scheduleClose();
          }}
          onFocus={() => setOpen(true)}
          onClick={(event) => {
            event.preventDefault();
            const nextPinned = !pinned;
            setPinned(nextPinned);
            setOpen(nextPinned);
          }}
        >
          <IslandBody model={model} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="w-(--sz-turn-status-popover) p-2"
        aria-label="Turn plan"
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") cancelClose();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") scheduleClose();
        }}
        onEscapeKeyDown={() => setPinned(false)}
        onInteractOutside={() => setPinned(false)}
      >
        <ol className="flex flex-col gap-1" aria-label="Within-turn checklist">
          {plan.steps.map((step, index) => (
            <li
              key={step.id}
              className={cn(
                "flex items-start gap-2 rounded-md px-2 py-1.5 text-sm leading-5",
                index === plan.currentStepIndex && "bg-muted",
                step.status === "completed" && "text-muted-foreground",
              )}
              aria-current={index === plan.currentStepIndex ? "step" : undefined}
            >
              {checklistIcon(step)}
              <span className="min-w-0 break-words">{step.label}</span>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  );
}
