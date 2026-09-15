import type { ReactElement } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { TaskChatItem, TaskChatRuntimeRequestDecision, TaskChatRuntimeRequestItem } from "./task-chat-model";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { TaskChatUsageReadout } from "./TaskChatUsageReadout";
import { TaskChatActivityPhase } from "./TaskChatActivityPhase";
import { TaskChatThinking } from "./TaskChatThinking";
import { TaskChatMarker } from "./TaskChatMarker";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import { TaskChatProtocolActivityRow } from "./TaskChatProtocolActivityRow";
import { buildTurnTimelineRows } from "./transcript-adapter";

/**
 * Live-tail body for the experimental chat-style view (PAP-463, Workstream C1
 * of PAP-458).
 *
 * Renders the in-flight run's streaming transcript as the SAME clean rows the
 * settled thread uses — tool cards (with diffs) and the streamed reply markdown
 * — instead of the verbatim `RunTranscriptView` debug viewer that the live tail
 * used since `e4f3d7733`. The items come from `transcriptToTaskChatItems`, which
 * already drops the debug plumbing (init / stdout / stderr / system / user /
 * result), so none of `RunTranscriptView`'s noise can reach the thread: no INIT
 * row, no "N LOG LINES" / "N SYSTEM MESSAGES" banners, no raw stdout/JSON dumps,
 * no "Streaming" chip, no uppercase "USED TERMINAL" cards. The status pill above
 * this body (`TaskChatLiveRunPill`) owns the run-status affordance.
 *
 * Stable assistant and runtime-request boundaries compact the rows into an
 * ordered turn timeline. Commentary remains readable above the activity group
 * it introduced, and resolved request receipts keep their original slot.
 */
export function TaskChatLiveTail({
  items,
  emptyMessage,
  excludeFinal = false,
  onRuntimeRequestDecision,
}: {
  items: readonly TaskChatItem[];
  /** Shown when nothing renderable has streamed yet (queued / pre-first-token). */
  emptyMessage?: string;
  /** New-runner turn renders final-answer messages in its dedicated response slot. */
  excludeFinal?: boolean;
  onRuntimeRequestDecision?: (
    item: TaskChatRuntimeRequestItem,
    decision: TaskChatRuntimeRequestDecision,
  ) => void | Promise<void>;
}) {
  const visibleItems = excludeFinal
    ? items.filter((item) => item.kind !== "message" || item.interstitial)
    : items;
  const rows = buildTurnTimelineRows(visibleItems, true)
    .map((item) => renderTailRow(item, onRuntimeRequestDecision))
    .filter((row): row is ReactElement => row != null);

  if (rows.length === 0) {
    return emptyMessage ? (
      <div className="px-1 py-1 text-xs text-muted-foreground/70">{emptyMessage}</div>
    ) : null;
  }

  return <div className="flex flex-col gap-2">{rows}</div>;
}

function renderTailRow(
  item: TaskChatItem,
  onRuntimeRequestDecision?: (
    item: TaskChatRuntimeRequestItem,
    decision: TaskChatRuntimeRequestDecision,
  ) => void | Promise<void>,
): ReactElement | null {
  switch (item.kind) {
    case "message": {
      // Streamed reply text (always interstitial from the transcript adapter).
      // Rendered as plain markdown — the settled thread later replaces it with
      // the posted comment bubble, so no author header/bubble chrome here.
      const text = item.text.trim();
      if (!text) return null;
      return (
        <div
          key={item.id}
          className="px-1 text-sm text-foreground/90"
          data-testid="task-chat-live-text"
        >
          <MarkdownBody softBreaks linkIssueReferences>
            {item.text}
          </MarkdownBody>
        </div>
      );
    }
    case "tool":
      return (
        <div key={item.id}>
          <TaskChatToolCard item={item} />
        </div>
      );
    case "usage":
      return (
        <div key={item.id}>
          <TaskChatUsageReadout item={item} />
        </div>
      );
    case "thinking":
      return <TaskChatThinking key={item.id} item={item} />;
    case "activity_phase":
      return (
        <TaskChatActivityPhase
          key={item.id}
          item={item}
          defaultOpen={item.items.some(
            (child) =>
              child.kind === "thinking" &&
              child.lines.some((line) => line.trim().length > 0),
          )}
          childrenClassName="relative ml-2.5 pl-6"
          showChildRail
          renderChild={(child) => child.kind === "tool"
            ? <TaskChatToolCard item={child} />
            : child.kind === "thinking"
              ? <TaskChatThinking item={child} />
              : child.kind === "marker"
                ? <TaskChatMarker item={child} />
                : child.kind === "protocol"
                  ? child.surface === "runtime_request"
                    ? <TaskChatProtocolCard item={child} onRuntimeRequestDecision={onRuntimeRequestDecision} />
                    : <TaskChatProtocolActivityRow item={child} />
                  : <TaskChatUsageReadout item={child} />}
        />
      );
    case "protocol":
      return <TaskChatProtocolCard key={item.id} item={item} onRuntimeRequestDecision={onRuntimeRequestDecision} />;
    // Markers, interactions, briefs, statuses, turns, and dropped debug kinds
    // cannot appear as direct live-tail rows.
    default:
      return null;
  }
}
