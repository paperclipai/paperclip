import { useRef } from "react";
import type { ExecutionProjection } from "@paperclipai/shared";
import { useSecondTick } from "@/hooks/useSecondTick";
import { cn } from "@/lib/utils";
import type {
  TaskChatItem,
  TaskChatMessageItem,
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
} from "./task-chat-model";
import { TaskChatAgentIdentity, TaskChatBubble } from "./TaskChatBubble";
import { TaskChatBubbleActions } from "./TaskChatBubbleActions";
import { formatTaskChatTimestamp } from "./task-chat-adapter";
import { TaskChatRunnerActivityGroup } from "./TaskChatRunnerActivityGroup";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import { TaskChatPlanPreviewCard } from "./TaskChatPlanPreviewCard";
import {
  buildTurnTimelineRows,
  isTerminalRunStatus,
  omitProgressRepeatedByResponse,
  paperclipRunnerFinalResponse,
  paperclipRunnerTimelineItems,
} from "./transcript-adapter";

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

function RunnerCurrentActivityTail({ status }: { status: string }) {
  if (isTerminalRunStatus(status)) return null;
  return <div className="mt-2 flex min-h-8 min-w-0 items-center gap-2 px-1 py-1 text-xs text-muted-foreground" data-testid="task-chat-current-activity" data-turn-position="tail">
    <span className="shimmer-text shimmer-text-muted" aria-live="polite" data-testid="task-chat-current-activity-label">Thinking</span>
  </div>;
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
  const terminal = isTerminalRunStatus(status);
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
  const currentActivityItems = currentActivityStatusItems(timelineItems);
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
      {activityUnavailable ? (
        <div
          className="px-1 py-1 text-xs text-muted-foreground"
          role="status"
          data-testid="task-chat-activity-unavailable"
        >
          Live runner activity is temporarily unavailable. Retrying…
        </div>
      ) : null}
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
              data-thread-anchor={row.id}
            >
              {row.kind === "activity_phase" ? (
                <TaskChatRunnerActivityGroup item={row} />
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
      {!final && currentActivityItems.length === 0 ? <RunnerCurrentActivityTail status={status} /> : null}
    </div>
  );
}
