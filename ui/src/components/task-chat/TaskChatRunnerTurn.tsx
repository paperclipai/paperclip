import { useRef, type ComponentType, type SVGProps } from "react";
import { OctagonX } from "lucide-react";
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
import { TaskChatAgentIdentity } from "./TaskChatBubble";
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
                className="tc-enter-cot-line min-w-0 px-1 text-sm text-foreground/90"
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
}: {
  status: string;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
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

  return (
    <span
      className="min-w-0 truncate text-sm font-normal text-muted-foreground"
      data-testid="task-chat-turn-status-header"
      data-turn-position="identity"
      aria-live="polite"
      aria-atomic="true"
    >
      {semanticLabel}
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
  onRuntimeRequestDecision,
}: {
  /** Stable identity used to clear replay-latched final text for the next turn. */
  runId?: string | null;
  agentName?: string | null;
  agentIcon?: string | null;
  items: readonly TaskChatItem[];
  status: string;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  onRuntimeRequestDecision?: (
    item: TaskChatRuntimeRequestItem,
    decision: TaskChatRuntimeRequestDecision,
  ) => void | Promise<void>;
}) {
  const terminal = isTerminalRunStatus(status);
  const timelineRows = buildTurnTimelineRows(
    paperclipRunnerTimelineItems(items),
    !terminal,
  );
  const currentActivityItems = currentActivityStatusItems(items);
  const observedFinal = paperclipRunnerFinalResponse(items, {
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
        />
      </div>
      {timelineRows.length > 0 ? (
        <div
          className="flex min-w-0 flex-col gap-2 py-1"
          data-testid="task-chat-turn-timeline"
        >
          {timelineRows.map((row) => (
            <div
              className="min-w-0"
              key={`${runId ?? "run"}:${row.id}`}
              data-testid="task-chat-turn-timeline-row"
              data-timeline-row-id={row.id}
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
          className="tc-enter-bubble w-full"
          data-testid="task-chat-final-response"
        >
          <div
            className="break-words px-1 py-2 text-sm text-foreground"
            data-testid="task-chat-agent-bubble"
          >
            <MarkdownBody softBreaks linkIssueReferences>
              {final.text}
            </MarkdownBody>
          </div>
        </div>
      ) : null}
      <RunnerCurrentActivityTail items={currentActivityItems} status={status} />
    </div>
  );
}
