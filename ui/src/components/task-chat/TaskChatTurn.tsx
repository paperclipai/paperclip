import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useStreamlinedTaskChatPresentation } from "./presentation-mode";
import { Check, ChevronRight, X } from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import type {
  TaskChatTurnItem,
  TaskChatTurnChildItem,
} from "./task-chat-model";
import { TaskChatStatusPill } from "./TaskChatStatusPill";
import { TaskChatAgentIdentity } from "./TaskChatBubble";

interface TaskChatTurnProps {
  item: TaskChatTurnItem;
  renderChild: (child: TaskChatTurnChildItem) => ReactNode;
  /**
   * When the settled turn is attached to its reply bubble (round 9), the
   * bubble's timestamp leads the summary line — "2:34 PM · ✓ Worked · 38s" —
   * always visible, in the slot the hover-only timestamp used to occupy.
   */
  timestampPrefix?: string;
  /**
   * Content rendered on the header row (PAP-413: the copy/👍/👎 action
   * cluster). The inspection caret and timestamp stay left; actions sit at the
   * stable right edge, outside the expandable fold.
   */
  leading?: ReactNode;
}

/** Metric segments after the label: "38s · 3 tools · +34 −3 · 12.3k tokens". */
export function turnSummaryMetrics(
  summary: TaskChatTurnItem["summary"],
): string {
  const parts: string[] = [];
  if (summary.durationLabel) parts.push(summary.durationLabel);
  if (summary.toolCount > 0)
    parts.push(
      `${summary.toolCount} tool${summary.toolCount === 1 ? "" : "s"}`,
    );
  if (summary.added > 0 || summary.removed > 0)
    parts.push(`+${summary.added} −${summary.removed}`);
  if (summary.tokensLabel) parts.push(summary.tokensLabel);
  return parts.join(" · ");
}

/** "✓ Worked · 38s · 3 tools · +34 −3 · 12.3k tokens" (parts omitted when unknown). */
export function turnSummaryText(summary: TaskChatTurnItem["summary"]): string {
  const metrics = turnSummaryMetrics(summary);
  const label = summary.failed ? "Stopped" : "Worked";
  return metrics ? `${label} · ${metrics}` : label;
}

/**
 * One agent turn's activity behind a single expandable header row. Paperclip
 * Runner turns opt into the chronological-timeline branch below instead.
 *
 * While the turn is live and carries `liveStatus`, that status line (whimsy or
 * taxonomy gerund + elapsed + tokens) IS the turn: one parent row, collapsed
 * by default, owning all activity (PAP-354). Expanding nests the chronological
 * tool/thinking history underneath — each row keeping its own expand — and new
 * rows append live while open. On settle the header morphs in place into the
 * "✓ Worked · …" summary, preserving the expand state, so the running line
 * reads as being replaced by the summary in the same slot.
 *
 * Both directions of the fold reuse the .tc-turn-fold grid-rows motion
 * (--motion-turn-fold, zeroed under prefers-reduced-motion). The fold class
 * only transitions on state CHANGE, so first paint in the folded state (e.g. a
 * turn that loads already settled) never animates. A live turn without
 * `liveStatus` (harness fixtures) renders its children expanded with no header
 * and folds when it settles.
 */
export function TaskChatTurn({
  item,
  renderChild,
  timestampPrefix,
  leading,
}: TaskChatTurnProps) {
  const streamlined = useStreamlinedTaskChatPresentation();
  const parentRow = !item.settled && item.liveStatus != null;
  // The new Paperclip Runner task surface owns one durable chronological
  // timeline. The Worked/Stopped row is its stable header, so it stays directly
  // below the preceding human bubble and above commentary, activity phases,
  // request receipts, and plan artifacts. The classic task interface continues
  // to use the run-wide fold below.
  if (item.standaloneHeader) {
    return (
      <div
        data-testid="task-chat-turn"
        data-settled={item.settled ? "true" : "false"}
      >
        <div
          className="flex min-h-8 w-full min-w-0 items-center gap-2 pb-1 pt-1.5 text-sm text-muted-foreground"
          data-testid="task-chat-turn-summary"
          data-turn-position="identity"
        >
          {item.agentName ? (
            <TaskChatAgentIdentity
              agentName={item.agentName}
              agentIcon={item.agentIcon}
            />
          ) : null}
          <span className="min-w-0 truncate">
            {item.continuedAfterSteering ? "Continued after steering · " : ""}
            {item.summary.durationLabel
              ? `${item.summary.failed ? "Stopped" : "Worked"} for ${item.summary.durationLabel}`
              : item.summary.failed
                ? "Stopped"
                : "Worked"}
          </span>
        </div>
        {item.items.length > 0 ? (
          <div
            className="flex min-w-0 flex-col gap-2 py-1"
            data-testid="task-chat-turn-timeline"
          >
            {item.items.map((child) => (
              <div
                className="min-w-0"
                key={child.id}
                data-testid="task-chat-turn-timeline-row"
                data-timeline-row-id={child.id}
              >
                {renderChild(child)}
              </div>
            ))}
          </div>
        ) : null}
        {item.finalResponse ? (
          <div className="w-full" data-testid="task-chat-final-response">
            <div
              className="break-words px-1 py-2 text-sm text-foreground"
              data-testid="task-chat-agent-bubble"
            >
              <MarkdownBody softBreaks linkIssueReferences>
                {item.finalResponse.text}
              </MarkdownBody>
            </div>
          </div>
        ) : null}
      </div>
    );
  }
  const persistentItems = item.settled
    ? item.items.filter(
        (child) =>
          child.kind === "protocol" && child.surface === "runtime_request",
      )
    : [];
  const persistentItemIds = new Set(persistentItems.map((child) => child.id));
  const foldedItems =
    persistentItems.length > 0
      ? item.items.filter((child) => !persistentItemIds.has(child.id))
      : item.items;
  // Parent-row live turns and settled turns start as their one-line header;
  // only the headerless legacy live turn starts expanded.
  const [open, setOpen] = useState(
    () => !item.settled && item.liveStatus == null,
  );
  const [prevSettled, setPrevSettled] = useState(item.settled);
  const [wasParentRow, setWasParentRow] = useState(parentRow);

  // Render-adjusted state (not effects) so transitions land in the same
  // commit — no flash of the wrong fold state.
  if (parentRow && !wasParentRow) setWasParentRow(true);
  // Live → settled while mounted: a parent-row turn keeps its expand state
  // (the header morphs in place); a headerless expanded turn folds (animated
  // via CSS unless reduced motion).
  if (item.settled !== prevSettled) {
    setPrevSettled(item.settled);
    if (item.settled && !wasParentRow) setOpen(false);
  }

  const expandable = foldedItems.length > 0;
  const folded = (item.settled || parentRow) && !open;
  const SummaryIcon = item.summary.failed ? X : Check;

  const header = item.settled ? (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-expanded={open}
      className={cn(
        "group flex w-full items-center gap-2 px-1 text-muted-foreground transition-colors hover:text-foreground",
        item.standaloneHeader
          ? "border-b border-border/70 py-2 text-sm"
          : "py-0.5 text-xs",
        streamlined && "min-w-0",
      )}
      data-testid="task-chat-turn-summary"
    >
      {timestampPrefix ? (
        <>
          <span className="text-(length:--text-micro)">{timestampPrefix}</span>
          <span aria-hidden className="text-(length:--text-micro)">
            ·
          </span>
        </>
      ) : null}
      {!item.standaloneHeader ? (
        <SummaryIcon className="h-3.5 w-3.5 shrink-0" />
      ) : null}
      <span>
        {item.standaloneHeader && item.summary.durationLabel
          ? `${item.summary.failed ? "Stopped" : "Worked"} for ${item.summary.durationLabel}`
          : item.summary.failed
            ? "Stopped"
            : "Worked"}
      </span>
      {!item.standaloneHeader && turnSummaryMetrics(item.summary) ? (
        // Time/tools/tokens is demoted, not deleted (PAP-502): it stays in the
        // DOM (and the accessible tree) but fades in only on hover/focus so the
        // settled line reads as "2:34 PM · ✓ Worked" at rest. Revealed too when
        // the fold is open, so the metrics don't vanish while you read below.
        <span
          className="tc-turn-metrics"
          data-visible={open ? "true" : "false"}
        >
          <span className="min-w-0 overflow-hidden whitespace-nowrap font-mono text-(length:--text-micro)">
            {turnSummaryMetrics(item.summary)}
          </span>
        </span>
      ) : null}
      <ChevronRight
        className={cn(
          "h-3 w-3 shrink-0 transition-transform",
          item.standaloneHeader && "ml-auto",
          open ? "rotate-90" : null,
        )}
        aria-hidden
      />
    </button>
  ) : parentRow ? (
    // The pill renders the expand button itself, wrapped around only the
    // gerund status line — the interstitial row above stays outside the
    // hover/click target (PAP-376). Without activity there is no
    // chevron/button.
    <TaskChatStatusPill
      item={item.liveStatus!}
      chevronOpen={expandable ? open : undefined}
      onToggle={expandable ? () => setOpen((o) => !o) : undefined}
    />
  ) : null;

  return (
    <div
      data-testid="task-chat-turn"
      data-settled={item.settled ? "true" : "false"}
    >
      {leading ? (
        streamlined ? (
          <div className="flex w-full items-center justify-between gap-2">
            <div className="min-w-0">{header}</div>
            <div className="shrink-0">{leading}</div>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {leading}
            {header}
          </div>
        )
      ) : (
        header
      )}
      <div
        className="tc-turn-fold"
        data-folded={folded ? "true" : "false"}
        aria-hidden={folded}
      >
        <div>
          <div className="flex flex-col gap-2 pt-1">
            {foldedItems.map((child) => (
              <div key={child.id}>{renderChild(child)}</div>
            ))}
          </div>
        </div>
      </div>
      {persistentItems.length > 0 ? (
        <div
          className="flex flex-col gap-2 pt-2"
          data-testid="task-chat-turn-persistent-history"
        >
          {persistentItems.map((child) => (
            <div key={child.id}>{renderChild(child)}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
