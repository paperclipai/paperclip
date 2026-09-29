import { useId, useState } from "react";
import { completedActivitySummary } from "./completed-activity-summary";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CirclePause,
  Gauge,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { cn } from "@/lib/utils";
import { useTaskChatExpansion } from "./expansion-state";
import type { TaskChatActivityPhaseItem } from "./task-chat-model";
import {
  protocolActivityIsRunning,
  protocolActivityLabel,
  protocolActivityPresentation,
} from "./task-chat-activity-presentation";
import {
  TaskChatProtocolActivityDetails,
  hasTaskChatProtocolActivityDetails,
} from "./TaskChatProtocolActivityRow";
import { TaskChatUsageReadout } from "./TaskChatUsageReadout";
import { toolActivityPresentation } from "./tool-taxonomy";

type Activity = TaskChatActivityPhaseItem["items"][number];

function presentation(item: Activity, active: boolean) {
  if (item.kind === "tool") {
    const tool = toolActivityPresentation({
      name: item.rawName ?? item.name,
      target: item.target,
    });
    const running =
      active && (item.status === "pending" || item.status === "in_progress");
    return {
      icon: tool.icon,
      label:
        item.status === "failed"
          ? tool.failedLabel
          : item.status === "interrupted"
            ? tool.interruptedLabel
            : running
              ? tool.runningLabel
              : tool.completedLabel,
      target: item.target,
      mono: true,
      running,
    };
  }
  if (item.kind === "thinking") {
    const running = active && Boolean(item.streaming);
    return {
      icon: Brain,
      label: running ? "Thinking" : "Thought",
      target: item.lines
        .filter((line) => line.trim())
        .at(-1)
        ?.trim(),
      mono: false,
      running,
    };
  }
  if (item.kind === "protocol") {
    const protocol = protocolActivityPresentation(item);
    if (!protocol) return null;
    return {
      icon: protocol.icon,
      label: protocolActivityLabel(item, protocol),
      target: protocol.detail,
      mono: true,
      running: active && protocolActivityIsRunning(item),
    };
  }
  if (item.kind === "marker")
    return {
      icon: CirclePause,
      label: item.label,
      target: item.detail,
      mono: false,
      running: false,
    };
  const { used, size, inputTokens, outputTokens, costUsd } = item.usage;
  const usage = [
    size > 0
      ? `${used.toLocaleString()}/${size.toLocaleString()} ctx`
      : undefined,
    inputTokens != null || outputTokens != null
      ? `↑${(inputTokens ?? 0).toLocaleString()} ↓${(outputTokens ?? 0).toLocaleString()}`
      : undefined,
    costUsd != null ? `$${costUsd.toFixed(4)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    icon: Gauge,
    label: item.label ?? "Token usage",
    target: usage || item.detail,
    mono: false,
    running: false,
  };
}

function ActivityContent({
  item,
  active,
}: {
  item: Activity;
  active: boolean;
}) {
  const row = presentation(item, active);
  if (!row) return null;
  const Icon = row.icon;
  return (
    <span
      className="flex min-w-0 flex-1 items-center gap-2"
      data-activity-row={item.id}
      data-activity-family={
        item.kind === "protocol"
          ? item.surface === "provider_activity"
            ? item.family
            : item.surface
          : undefined
      }
    >
      <span
        className="flex size-5 shrink-0 items-center justify-center"
        data-activity-icon
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap">
        <span
          className={cn(
            "max-w-full shrink-0 truncate text-xs",
            row.running && "text-foreground",
          )}
        >
          {row.label}
        </span>
        {row.target ? (
          <span
            title={row.target}
            className={cn(
              "truncate text-xs text-muted-foreground",
              row.mono && "font-mono",
            )}
          >
            {row.target}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** Only a new logical activity moves; token and status updates stay mounted. */
function RollingActivity({
  item,
  active,
}: {
  item: Activity;
  active: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const [frame, setFrame] = useState({
    current: item,
    previous: null as Activity | null,
  });
  if (frame.current.id !== item.id)
    setFrame({ current: item, previous: reducedMotion ? null : frame.current });
  else if (frame.current !== item) setFrame({ ...frame, current: item });
  return (
    <span
      className="relative flex h-8 min-w-0 flex-1 items-center overflow-hidden"
      aria-live="polite"
      aria-atomic="true"
      data-testid="task-chat-activity-viewport"
    >
      {frame.previous && !reducedMotion ? (
        <span
          key={`exit-${item.id}`}
          className="runner-activity-roll-out absolute inset-0 flex items-center"
          aria-hidden="true"
          onAnimationEnd={() =>
            setFrame((current) =>
              current.current.id === item.id
                ? { ...current, previous: null }
                : current,
            )
          }
        >
          <ActivityContent item={frame.previous} active={false} />
        </span>
      ) : null}
      <span
        key={item.id}
        className={cn(
          "relative flex w-full min-w-0 items-center",
          frame.previous && !reducedMotion && "runner-activity-roll-in",
        )}
      >
        <ActivityContent item={item} active={active} />
      </span>
    </span>
  );
}

function ActivityDetails({ item }: { item: Activity }) {
  if (item.kind === "thinking")
    return <MarkdownBody softBreaks>{item.lines.join("\n")}</MarkdownBody>;
  if (item.kind === "usage") return <TaskChatUsageReadout item={item} />;
  if (item.kind === "protocol")
    return <TaskChatProtocolActivityDetails item={item} neutral />;
  if (item.kind === "marker")
    return (
      <p className="whitespace-pre-wrap break-words">
        {item.detail ?? item.label}
      </p>
    );
  return (
    <>
      {item.target ? (
        <p className="break-all font-mono">{item.target}</p>
      ) : null}
      {item.detail ? (
        <pre className="whitespace-pre-wrap break-words font-mono">
          {item.detail}
        </pre>
      ) : null}
      {item.decision ? <p>Permission {item.decision}</p> : null}
      {item.diff ? (
        <p className="break-all font-mono">
          {item.diff.path} · +{item.diff.added} −{item.diff.removed}
        </p>
      ) : null}
    </>
  );
}

function hasActivityDetails(item: Activity): boolean {
  if (item.kind === "protocol") return hasTaskChatProtocolActivityDetails(item);
  if (item.kind === "thinking") return item.lines.some((line) => line.trim());
  if (item.kind === "tool")
    return Boolean(
      item.target?.trim() || item.detail?.trim() || item.diff || item.decision,
    );
  if (item.kind === "marker") return Boolean(item.detail?.trim());
  return Boolean(
    item.detail ||
    item.usage.size > 0 ||
    item.usage.inputTokens != null ||
    item.usage.outputTokens != null ||
    item.usage.costUsd != null,
  );
}

function ExpandedActivity({
  item,
  active,
}: {
  item: Activity;
  active: boolean;
}) {
  const [open, setOpen] = useTaskChatExpansion(
    `runner-detail:${item.id}`,
    false,
  );
  const detailId = useId();
  const expandable = hasActivityDetails(item);
  const content = <ActivityContent item={item} active={active} />;
  return (
    <li className="min-w-0" data-activity-item-id={item.id}>
      {expandable ? (
        <button
          type="button"
          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
        >
          {content}
          <ChevronRight
            className={cn("size-3.5 shrink-0", open && "rotate-90")}
            aria-hidden="true"
          />
        </button>
      ) : (
        <div className="flex h-8 w-full min-w-0 items-center gap-2 text-muted-foreground">
          {content}
        </div>
      )}
      {expandable && open ? (
        <div
          id={detailId}
          className="flex min-w-0 flex-col gap-2 overflow-hidden rounded-md bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground"
          data-testid="task-chat-runner-activity-detail"
        >
          <ActivityDetails item={item} />
        </div>
      ) : null}
    </li>
  );
}

/** One rolling activity between commentary messages, with persistent optional history. */
export function TaskChatRunnerActivityGroup({
  item,
  defaultExpanded = false,
}: {
  item: TaskChatActivityPhaseItem;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useTaskChatExpansion(
    item.id,
    defaultExpanded,
  );
  const historyId = useId();
  const activities = item.items.filter(
    (activity) => presentation(activity, false) !== null,
  );
  const latest = activities.at(-1);
  const summary = completedActivitySummary(activities);
  const SummaryIcon = summary.icon;
  const countLabel = `${activities.length} ${activities.length === 1 ? "activity" : "activities"}`;
  return (
    <section
      className="flex min-w-0 flex-col gap-2"
      data-testid="task-chat-activity-phase"
      data-activity-group={item.id}
      data-expanded={expanded}
    >
      {item.interstitial ? (
        <div
          className="min-w-0 text-sm text-foreground/90"
          data-testid="task-chat-phase-interstitial"
        >
          <MarkdownBody softBreaks linkIssueReferences>
            {item.interstitial.text}
          </MarkdownBody>
        </div>
      ) : null}
      {latest ? (
        <div className="min-w-0">
          <button
            type="button"
            className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="task-chat-activity-phase-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-controls={expanded ? historyId : undefined}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${item.active ? countLabel : `${summary.fullLabel.toLowerCase()} (${countLabel})`}`}
          >
            {!item.active ? (
              <span
                className="flex h-8 min-w-0 flex-1 items-center gap-2 text-xs"
                data-completed-summary
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <SummaryIcon className="size-3.5" aria-hidden="true" />
                </span>
                <span className="truncate" title={summary.fullLabel}>
                  {summary.label}
                </span>
              </span>
            ) : expanded ? (
              <span className="flex min-h-8 flex-1 items-center gap-2 text-xs">
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                </span>
                <span>{countLabel}</span>
              </span>
            ) : (
              <RollingActivity item={latest} active={item.active} />
            )}
            <span className="flex shrink-0 items-center gap-1 text-xs">
              {expanded ? countLabel : item.active ? activities.length : null}
              <ChevronRight
                className={cn("size-3.5", expanded && "rotate-90")}
                aria-hidden="true"
              />
            </span>
          </button>
          {expanded ? (
            <ol
              id={historyId}
              className="flex min-w-0 flex-col gap-1"
              aria-label="Activity history"
              data-testid="task-chat-runner-activity-list"
            >
              {activities.map((activity, index) => (
                <ExpandedActivity
                  key={activity.id}
                  item={activity}
                  active={item.active && index === activities.length - 1}
                />
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
