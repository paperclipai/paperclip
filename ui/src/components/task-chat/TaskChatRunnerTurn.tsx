import { useRef, useState, type ComponentType, type SVGProps } from "react";
import type { ExecutionProjection } from "@paperclipai/shared";
import { Brain, ChevronRight, OctagonX } from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useSecondTick } from "@/hooks/useSecondTick";
import { cn } from "@/lib/utils";
import type {
  TaskChatItem,
  TaskChatMessageItem,
  TaskChatMarkerItem,
  TaskChatProtocolItem,
  TaskChatProviderActivityItem,
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
  TaskChatThinkingItem,
  TaskChatToolItem,
} from "./task-chat-model";
import { TaskChatAgentIdentity, TaskChatBubble } from "./TaskChatBubble";
import { TaskChatBubbleActions } from "./TaskChatBubbleActions";
import { formatTaskChatTimestamp } from "./task-chat-adapter";
import { TaskChatActivityPhase } from "./TaskChatActivityPhase";
import { TaskChatProtocolActivityRow } from "./TaskChatProtocolActivityRow";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import { TaskChatPlanPreviewCard } from "./TaskChatPlanPreviewCard";
import { TaskChatThinking } from "./TaskChatThinking";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { TaskChatUsageReadout } from "./TaskChatUsageReadout";
import {
  protocolActivityIsRunning,
  protocolActivityLabel,
  protocolActivityPresentation,
} from "./task-chat-activity-presentation";
import {
  buildTurnTimelineRows,
  isTerminalRunStatus,
  omitProgressRepeatedByResponse,
  paperclipRunnerFinalResponse,
  paperclipRunnerTimelineItems,
} from "./transcript-adapter";
import { toolTaxonomy } from "./tool-taxonomy";

function lastOf<T extends TaskChatItem>(
  items: readonly TaskChatItem[],
  predicate: (item: TaskChatItem) => item is T,
): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (predicate(item)) return item;
  }
  return undefined;
}

function isHeadlineProtocolActivity(
  item: TaskChatItem,
): item is TaskChatProtocolItem {
  return (
    item.kind === "protocol" && protocolActivityPresentation(item) !== null
  );
}

function currentActivityStatusItems(
  items: readonly TaskChatItem[],
): readonly TaskChatItem[] {
  let boundaryIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item.kind === "message" ||
      item.kind === "plan_document" ||
      (item.kind === "protocol" &&
        (item.surface === "runtime_request" ||
          item.surface === "run_result" ||
          item.surface === "run_terminal"))
    ) {
      boundaryIndex = index;
      break;
    }
  }
  return items.slice(boundaryIndex + 1);
}

type FoldedActivity = {
  kind: "reasoning" | "tool" | "protocol";
  logicalKey: string;
  text: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  mono?: boolean;
};

function latestFoldedActivity(
  items: readonly TaskChatItem[],
): FoldedActivity | null {
  let latest: FoldedActivity | null = null;
  for (const item of items) {
    if (item.kind === "thinking") {
      for (
        let lineIndex = item.lines.length - 1;
        lineIndex >= 0;
        lineIndex -= 1
      ) {
        const line = item.lines[lineIndex]?.trim();
        if (line) {
          latest = {
            kind: "reasoning",
            logicalKey: `${item.id}:${lineIndex}`,
            text: line,
            icon: Brain,
          };
          break;
        }
      }
      continue;
    }
    if (item.kind === "tool") {
      const taxonomy = toolTaxonomy(item.rawName ?? item.name);
      latest = {
        kind: "tool",
        logicalKey: item.id,
        text: item.target
          ? `${taxonomy.verbLabel} · ${item.target}`
          : taxonomy.verbLabel,
        icon: taxonomy.icon,
        mono: Boolean(item.target),
      };
      continue;
    }
    if (isHeadlineProtocolActivity(item)) {
      const presentation = protocolActivityPresentation(item);
      if (presentation) {
        const label = protocolActivityLabel(item, presentation);
        latest = {
          kind: "protocol",
          logicalKey: item.id,
          text: presentation.detail
            ? `${label} · ${presentation.detail}`
            : label,
          icon: presentation.icon,
        };
      }
    }
  }
  return latest;
}

function FoldedActivityTicker({
  activity,
  open,
  onToggle,
}: {
  activity: FoldedActivity;
  open: boolean;
  onToggle: () => void;
}) {
  const [ticker, setTicker] = useState({
    logicalKey: activity.logicalKey,
    motionKey: 0,
    current: activity.text,
  });
  if (ticker.logicalKey !== activity.logicalKey) {
    setTicker({
      logicalKey: activity.logicalKey,
      motionKey: ticker.motionKey + 1,
      current: activity.text,
    });
  } else if (ticker.current !== activity.text) {
    // Token fragments update the mounted line. Only a new logical line moves
    // the ticker, so streaming text does not restart the animation per token.
    setTicker({ ...ticker, current: activity.text });
  }

  const Icon = activity.icon;

  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="group/live-reasoning flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm px-1 py-1.5 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="task-chat-reasoning-ticker"
      data-activity-kind={activity.kind}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <Icon className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden />
      </span>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        <span
          key={`in-${ticker.motionKey}`}
          className={cn(
            "absolute inset-x-0 truncate text-(length:--text-compact) leading-5 text-muted-foreground",
            activity.kind === "reasoning" && "italic",
            activity.mono && "font-mono",
            ticker.motionKey > 0 && "cot-line-enter",
          )}
          aria-live="polite"
          aria-atomic="true"
        >
          {ticker.current}
        </span>
      </div>
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
          aria-hidden
        />
      </span>
    </button>
  );
}

function formatCompactDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function terminalStatusFailed(status: string): boolean {
  return (
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out" ||
    status === "interrupted"
  );
}

function RunnerActivityTimeline({ items }: { items: readonly TaskChatItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="relative ml-4 min-w-0 pl-6">
      <span
        className="absolute inset-y-1 left-0 w-px bg-border/70"
        aria-hidden
        data-testid="task-chat-runner-activity-rail"
      />
      <ol
        className="flex min-w-0 flex-col gap-2 py-1"
        aria-label="Run activity"
        data-testid="task-chat-runner-activity-list"
      >
        {items.map((item, index) => (
          <li className="min-w-0" key={item.id} data-activity-item-id={item.id}>
            {item.kind === "message" ? (
              <div
                className="min-w-0 px-1 text-sm text-foreground/90"
                data-testid="task-chat-activity-commentary"
              >
                <MarkdownBody softBreaks linkIssueReferences>
                  {item.text}
                </MarkdownBody>
              </div>
            ) : item.kind === "thinking" ? (
              <TaskChatThinking
                item={item}
                active={Boolean(item.streaming) && index === items.length - 1}
                defaultOpen={false}
                rowClassName="mx-0 px-0"
              />
            ) : item.kind === "tool" ? (
              <TaskChatToolCard item={item} />
            ) : item.kind === "usage" ? (
              <TaskChatUsageReadout item={item} />
            ) : item.kind === "marker" ? (
              <RunnerActivityMarker item={item} />
            ) : item.kind === "protocol" ? (
              <TaskChatProtocolActivityRow item={item} />
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function RunnerActivityMarker({ item }: { item: TaskChatMarkerItem }) {
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-2 py-1 text-xs text-destructive">
      <span className="flex w-5 shrink-0 items-center justify-center">
        <OctagonX
          className="h-3.5 w-3.5 shrink-0"
          aria-hidden
          data-testid="task-chat-marker-icon"
        />
      </span>
      <span className="shrink-0 font-medium">{item.label}</span>
      {item.detail ? (
        <span className="min-w-0 truncate text-muted-foreground">
          {item.detail}
        </span>
      ) : null}
    </div>
  );
}

function RunnerTurnStatus({
  status,
  startedAtMs,
  finishedAtMs,
  continuedAfterSteering = false,
}: {
  status: string;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  continuedAfterSteering?: boolean;
}) {
  const terminal = isTerminalRunStatus(status);
  useSecondTick(!terminal && startedAtMs != null);
  const elapsedMs =
    startedAtMs == null
      ? null
      : Math.max(
          0,
          (terminal ? (finishedAtMs ?? Date.now()) : Date.now()) - startedAtMs,
        );
  const elapsed = formatCompactDuration(elapsedMs);

  const failed = terminalStatusFailed(status);
  const label = terminal ? (failed ? "Stopped" : "Worked") : "Working";
  const semanticLabel = terminal
    ? elapsed
      ? `${label} ${failed ? "after" : "for"} ${elapsed}`
      : label
    : `${label} for ${elapsed ?? "0s"}`;
  const visibleLabel = continuedAfterSteering
    ? `Continued after steering · ${semanticLabel}`
    : semanticLabel;

  return (
    <span
      className="min-w-0 truncate text-sm font-normal text-muted-foreground"
      data-testid="task-chat-turn-status-header"
      data-turn-position="identity"
      aria-live="polite"
      aria-atomic="true"
    >
      {visibleLabel}
    </span>
  );
}

function RunnerCurrentActivityTail({
  items,
  status,
}: {
  items: readonly TaskChatItem[];
  status: string;
}) {
  if (isTerminalRunStatus(status)) return null;
  const activity = lastOf<
    TaskChatThinkingItem | TaskChatToolItem | TaskChatProtocolItem
  >(
    items,
    (
      item,
    ): item is TaskChatThinkingItem | TaskChatToolItem | TaskChatProtocolItem =>
      item.kind === "thinking" ||
      item.kind === "tool" ||
      isHeadlineProtocolActivity(item),
  );

  let Icon: ComponentType<SVGProps<SVGSVGElement>> | null = null;
  let label = "Thinking";
  let detail: string | undefined;
  let family: string | undefined;
  let active = true;
  if (activity?.kind === "tool") {
    const taxonomy = toolTaxonomy(activity.rawName ?? activity.name);
    Icon = taxonomy.icon;
    label = taxonomy.verbLabel;
    detail = activity.target;
    active = activity.status === "pending" || activity.status === "in_progress";
  } else if (activity?.kind === "protocol") {
    const presentation = protocolActivityPresentation(activity);
    if (presentation) {
      Icon = presentation.icon;
      label = protocolActivityLabel(activity, presentation);
      detail = presentation.detail;
      active = protocolActivityIsRunning(activity);
      family =
        activity.surface === "provider_activity"
          ? activity.family
          : activity.surface;
    }
  }

  return (
    <div
      className="mt-2 flex min-h-8 min-w-0 items-center gap-2 px-1 py-1 text-xs text-muted-foreground"
      data-testid="task-chat-current-activity"
      data-activity-family={family}
      data-turn-position="tail"
    >
      {Icon ? (
        <span className="flex w-5 shrink-0 items-center justify-center">
          <Icon
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              active && "text-(--status-agent-running)",
            )}
            aria-hidden
            data-testid="task-chat-current-activity-icon"
          />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 font-normal",
            active && "shimmer-text shimmer-text-muted",
          )}
          aria-live="polite"
          aria-atomic="true"
          data-testid="task-chat-current-activity-label"
        >
          {label}
        </span>
        {detail ? (
          <span className="min-w-0 truncate font-mono text-(length:--text-micro)">
            {detail}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function TaskChatRunnerTurn({
  runId,
  agentName,
  agentIcon,
  items,
  status,
  startedAtMs,
  finishedAtMs,
  activityUnavailable = false,
  suppressFinal = false,
  continuedAfterSteering = false,
  onRuntimeRequestDecision,
}: {
  /** Stable identity used to clear replay-latched final text for the next turn. */
  runId?: string | null;
  agentName?: string | null;
  agentIcon?: string | null;
  items: readonly TaskChatItem[];
  status: string;
  execution?: ExecutionProjection | null;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  activityUnavailable?: boolean;
  /** Accepted wait/interaction authority overrides an early provider final. */
  suppressFinal?: boolean;
  /** The visible tail resumes the same native run after an accepted steer. */
  continuedAfterSteering?: boolean;
  onRuntimeRequestDecision?: (
    item: TaskChatRuntimeRequestItem,
    decision: TaskChatRuntimeRequestDecision,
  ) => void | Promise<void>;
}) {
  const [liveActivityOpen, setLiveActivityOpen] = useState(false);
  const terminal = isTerminalRunStatus(status);
  const foldedActivity = latestFoldedActivity(items);
  const currentActivityItems = currentActivityStatusItems(items);
  const yielded = items.some(
    (item) =>
      item.kind === "protocol" &&
      item.surface === "run_result" &&
      item.disposition === "yielded",
  );
  const observedFinal = suppressFinal
    ? undefined
    : paperclipRunnerFinalResponse(items, {
        allowFallback: terminal,
      });
  const observedProviderText = Boolean(
    observedFinal &&
    items.some(
      (item) =>
        item.kind === "message" &&
        item.id === observedFinal.id &&
        item.channel !== "progress",
    ),
  );
  // A reconnect/replay can briefly rebuild the transcript without the final
  // item (or with an earlier, shorter prefix). Provider-authored final text
  // always replaces a structured summary fallback, even when it is shorter;
  // within either class, displayed answer text remains monotonic.
  const finalRef = useRef<{
    runId?: string | null;
    item?: TaskChatMessageItem;
    providerText?: boolean;
  }>({ runId });
  if (finalRef.current.runId !== runId) finalRef.current = { runId };
  // A provider final can arrive before the accepted yielded result. Clear any
  // replay latch once the control plane establishes that this turn is waiting
  // for continuation rather than presenting a durable assistant reply.
  if (yielded || suppressFinal) finalRef.current = { runId };
  if (
    observedFinal &&
    (!finalRef.current.item ||
      (observedProviderText && !finalRef.current.providerText) ||
      (observedProviderText === Boolean(finalRef.current.providerText) &&
        observedFinal.text.length >= finalRef.current.item.text.length))
  ) {
    finalRef.current.item = observedFinal;
    finalRef.current.providerText = observedProviderText;
  }
  const final = finalRef.current.item;
  const timelineItems = paperclipRunnerTimelineItems(items);
  const timelineRows = buildTurnTimelineRows(
    omitProgressRepeatedByResponse(timelineItems, final?.text),
    !terminal,
  );

  return (
    <div
      className="flex min-w-0 flex-col"
      data-testid="task-chat-runner-turn"
      data-phase={status === "queued" ? "startup" : undefined}
    >
      <div
        className={cn(
          "flex min-h-8 min-w-0 items-center gap-2",
          status === "queued" ? "pb-1" : "pb-1 pt-2",
        )}
        data-testid="task-chat-runner-identity-row"
      >
        {agentName ? (
          <TaskChatAgentIdentity agentName={agentName} agentIcon={agentIcon} />
        ) : null}
        <RunnerTurnStatus
          status={status}
          startedAtMs={startedAtMs}
          finishedAtMs={finishedAtMs}
          continuedAfterSteering={continuedAfterSteering}
        />
      </div>
      {!terminal && foldedActivity && !final ? (
        <div
          className="flex min-w-0 flex-col py-1"
          data-testid="task-chat-live-narration"
        >
          <FoldedActivityTicker
            activity={foldedActivity}
            open={liveActivityOpen}
            onToggle={() => setLiveActivityOpen((value) => !value)}
          />
        </div>
      ) : null}
      {activityUnavailable ? (
        <div
          className="px-1 py-1 text-xs text-destructive"
          role="status"
          data-testid="task-chat-activity-unavailable"
        >
          Live runner activity is temporarily unavailable. Retrying…
        </div>
      ) : null}
      {timelineRows.length > 0 ? (
        <div
          className={cn(
            "min-w-0 flex-col gap-2 py-1",
            !terminal && foldedActivity && !liveActivityOpen
              ? "hidden"
              : "flex",
          )}
          data-testid="task-chat-turn-timeline"
        >
          {timelineRows.map((row) => (
            <div
              className="min-w-0"
              key={`${runId ?? "run"}:${row.id}`}
              data-testid="task-chat-turn-timeline-row"
              data-timeline-row-id={row.id}
              data-thread-anchor={row.id}
            >
              {row.kind === "activity_phase" ? (
                <TaskChatActivityPhase
                  item={row}
                  appearance="runner"
                  autoOpen={false}
                  childrenClassName="pl-0"
                  renderChild={() => null}
                  renderChildren={(children) => (
                    <RunnerActivityTimeline items={children} />
                  )}
                />
              ) : row.kind === "plan_document" ? (
                <TaskChatPlanPreviewCard
                  source={{ kind: "saved", document: row.document }}
                  testId={
                    row.placement === "fallback"
                      ? "task-chat-plan-preview-fallback"
                      : "task-chat-plan-preview"
                  }
                />
              ) : row.kind === "protocol" ? (
                <TaskChatProtocolCard
                  item={row}
                  onRuntimeRequestDecision={onRuntimeRequestDecision}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {final ? (
        <div
          className="w-full"
          data-testid="task-chat-final-response"
        >
          <TaskChatBubble
            item={{ ...final, authorName: agentName ?? undefined, agentIcon, timestamp: final.timestamp ?? formatTaskChatTimestamp(final.atMs) }}
            animateEntry={false}
            hideAgentIdentity={!continuedAfterSteering}
            actions={<TaskChatBubbleActions copyText={final.text} />}
          />
        </div>
      ) : null}
      {!final ? (
        <div className={cn(foldedActivity && "hidden")}>
          <RunnerCurrentActivityTail items={currentActivityItems} status={status} />
        </div>
      ) : null}
    </div>
  );
}
