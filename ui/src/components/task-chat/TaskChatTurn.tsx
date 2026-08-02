import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, X } from "lucide-react";
import type { TaskChatTurnItem, TaskChatTurnChildItem } from "./task-chat-model";

interface TaskChatTurnProps {
  item: TaskChatTurnItem;
  renderChild: (child: TaskChatTurnChildItem) => ReactNode;
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
 * One agent turn's activity, foldable to a one-line summary once settled.
 *
 * While the turn is live it renders fully interleaved with no summary line.
 * When it settles the activity folds behind a "✓ Worked · …" line — animated
 * (grid-rows via .tc-turn-fold, --motion-turn-fold) when the settle happens
 * on-screen, instant for turns that load already settled (the fold class only
 * transitions on state CHANGE, so first paint in the folded state never
 * animates). Clicking the summary folds/unfolds with the same motion.
 * prefers-reduced-motion zeroes the transition in CSS.
 */
export function TaskChatTurn({ item, renderChild }: TaskChatTurnProps) {
  const [open, setOpen] = useState(!item.settled);
  const [prevSettled, setPrevSettled] = useState(item.settled);

  // Live → settled transition observed while mounted: fold (animated via CSS
  // unless reduced motion). Adjusted during render (not in an effect) so the
  // fold state lands in the same commit — no unfolded flash. Turns mounted
  // already-settled start folded via the useState initializers.
  if (item.settled !== prevSettled) {
    setPrevSettled(item.settled);
    if (item.settled) setOpen(false);
  }

  const folded = item.settled && !open;
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
          <SummaryIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{item.summary.failed ? "Stopped" : "Worked"}</span>
          {turnSummaryMetrics(item.summary) ? (
            <span className="font-mono text-(length:--text-micro)">{turnSummaryMetrics(item.summary)}</span>
          ) : null}
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open ? "rotate-90" : null)} />
        </button>
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
