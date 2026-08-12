import type { ReactElement } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { TaskChatItem } from "./task-chat-model";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { TaskChatUsageReadout } from "./TaskChatUsageReadout";
import { TaskChatActivityPhase } from "./TaskChatActivityPhase";
import { buildActivityPhases } from "./transcript-adapter";

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
 * Stable assistant boundaries compact the rows into activity phases. The
 * trailing streaming assistant chunk stays in the status pill's self-talk
 * slot, while historical interstitials remain readable above their summaries.
 */
export function TaskChatLiveTail({
  items,
  emptyMessage,
}: {
  items: readonly TaskChatItem[];
  /** Shown when nothing renderable has streamed yet (queued / pre-first-token). */
  emptyMessage?: string;
}) {
  const rows = buildActivityPhases(items, true)
    .map((item) => renderTailRow(item))
    .filter((row): row is ReactElement => row != null);

  if (rows.length === 0) {
    return emptyMessage ? (
      <div className="px-1 py-1 text-xs text-muted-foreground/70">{emptyMessage}</div>
    ) : null;
  }

  return <div className="flex flex-col gap-2">{rows}</div>;
}

function renderTailRow(item: TaskChatItem): ReactElement | null {
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
    case "activity_phase":
      return (
        <TaskChatActivityPhase
          key={item.id}
          item={item}
          renderChild={(child) => child.kind === "tool" ? <TaskChatToolCard item={child} /> : <TaskChatUsageReadout item={child} />}
        />
      );
    // Thinking never renders as a row (PAP-361): its live signal is the status
    // pill, and the text stays in the run log / classic transcript. Every other
    // kind (markers, interactions, briefs, statuses, turns, and the dropped
    // debug kinds) cannot appear in a parsed live transcript.
    default:
      return null;
  }
}
