import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, X } from "lucide-react";
import type { TaskChatTurnItem, TaskChatTurnChildItem } from "./task-chat-model";
import { TaskChatStatusPill } from "./TaskChatStatusPill";

interface TaskChatTurnProps {
  item: TaskChatTurnItem;
  renderChild: (child: TaskChatTurnChildItem) => ReactNode;
  /**
   * When the settled turn is attached to its reply bubble (round 9), the
   * bubble's timestamp leads the summary line — "2:34 PM · ✓ Worked · 38s" —
   * always visible, in the slot the hover-only timestamp used to occupy.
   */
  timestampPrefix?: string;
}

/** Metric segments after the label: "38s · 3 tools · +34 −3 · 12.3k tokens". */
export function turnSummaryMetrics(summary: TaskChatTurnItem["summary"]): string {
  const parts: string[] = [];
  if (summary.durationLabel) parts.push(summary.durationLabel);
  if (summary.toolCount > 0) parts.push(`${summary.toolCount} tool${summary.toolCount === 1 ? "" : "s"}`);
  if (summary.added > 0 || summary.removed > 0) parts.push(`+${summary.added} −${summary.removed}`);
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
 * One agent turn's activity behind a single expandable header row.
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
export function TaskChatTurn({ item, renderChild, timestampPrefix }: TaskChatTurnProps) {
  const parentRow = !item.settled && item.liveStatus != null;
  // Parent-row live turns and settled turns start as their one-line header;
  // only the headerless legacy live turn starts expanded.
  const [open, setOpen] = useState(() => !item.settled && item.liveStatus == null);
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

  const expandable = item.items.length > 0;
  const folded = (item.settled || parentRow) && !open;
  const SummaryIcon = item.summary.failed ? X : Check;

  return (
    <div data-testid="task-chat-turn" data-settled={item.settled ? "true" : "false"}>
      {item.settled ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="group flex items-center gap-2 px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          data-testid="task-chat-turn-summary"
        >
          {timestampPrefix ? (
            <>
              <span className="text-(length:--text-micro)">{timestampPrefix}</span>
              <span aria-hidden className="text-(length:--text-micro)">·</span>
            </>
          ) : null}
          <SummaryIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{item.summary.failed ? "Stopped" : "Worked"}</span>
          {turnSummaryMetrics(item.summary) ? (
            <span className="font-mono text-(length:--text-micro)">{turnSummaryMetrics(item.summary)}</span>
          ) : null}
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open ? "rotate-90" : null)} />
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
      ) : null}
      <div className="tc-turn-fold" data-folded={folded ? "true" : "false"} aria-hidden={folded}>
        <div>
          <div className="flex flex-col gap-2 pt-1">
            {item.items.map((child) => (
              <div key={child.id}>{renderChild(child)}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
