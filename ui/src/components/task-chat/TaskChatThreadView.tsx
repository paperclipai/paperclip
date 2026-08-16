import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type {
  TaskChatInteractionItem,
  TaskChatItem,
  TaskChatMessageItem,
} from "./task-chat-model";
import { TaskChatTurn } from "./TaskChatTurn";
import { TaskChatBubble } from "./TaskChatBubble";
import { TaskChatMarker } from "./TaskChatMarker";
import { TaskChatStatusPill } from "./TaskChatStatusPill";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { TaskChatUsageReadout } from "./TaskChatUsageReadout";
import { TaskChatActivityPhase } from "./TaskChatActivityPhase";
import { TaskMessageScroller } from "./TaskMessageScroller";

interface TaskChatThreadViewProps {
  items: TaskChatItem[];
  /**
   * Content rendered above the first message INSIDE the scroll viewport (the
   * issue header when hosted by the live thread) — it scrolls away with the
   * messages instead of staying pinned above the thread.
   */
  header?: ReactNode;
  onApprovalDecision?: (statusItemId: string, optionId: string) => void;
  /**
   * Renders an interleaved issue-thread interaction (the live thread supplies
   * TaskChatInteractionCard bound to its accept/reject handlers). Interaction
   * items render nothing without it — the harness has no control plane.
   */
  renderInteraction?: (item: TaskChatInteractionItem) => ReactNode;
  /**
   * Renders the description-as-first-bubble placeholder (PAP-375). The live
   * thread binds TaskChatDescriptionBubble to the issue; brief items render
   * nothing without it.
   */
  renderBrief?: () => ReactNode;
  /**
   * Renders the copy/👍/👎 action cluster prepended to an agent bubble's footer
   * line (PAP-413). The live thread binds it to the feedback-vote API; harness
   * fixtures omit it and the bubbles render actionless.
   */
  renderMessageActions?: (item: TaskChatMessageItem) => ReactNode;
  /** Renders an interrupt action beside a queued human message. */
  renderQueuedAction?: (item: TaskChatMessageItem) => ReactNode;
  /** Content appended inside the transcript scroller after the settled thread. */
  tail?: ReactNode;
  /** Optional streaming-aware key when `tail` changes without changing `items`. */
  contentKey?: number;
  className?: string;
  /** When false, render the list without the scroll container (e.g. previews). */
  scroll?: boolean;
}

function renderItem(
  item: TaskChatItem,
  onApprovalDecision?: (statusItemId: string, optionId: string) => void,
  renderInteraction?: (item: TaskChatInteractionItem) => ReactNode,
  renderBrief?: () => ReactNode,
  renderMessageActions?: (item: TaskChatMessageItem) => ReactNode,
  renderQueuedAction?: (item: TaskChatMessageItem) => ReactNode,
) {
  switch (item.kind) {
    case "message": {
      // Compute the actions once: the bubble renders them for a runless reply
      // (footer = actions + timestamp), while an attached turn hands them to
      // TaskChatTurn's `leading` slot so they ride the summary line and stay
      // put when the tool history expands (PAP-413). The two paths are mutually
      // exclusive at runtime, so only one host ever mounts the node.
      const actions = renderMessageActions?.(item);
      return (
        <TaskChatBubble
          item={item}
          actions={actions}
          queuedAction={renderQueuedAction?.(item)}
          attachedTurn={
            item.attachedTurn ? (
              <TaskChatTurn
                item={item.attachedTurn}
                timestampPrefix={item.timestamp}
                leading={actions}
                renderChild={(child) => renderItem(child, onApprovalDecision)}
              />
            ) : undefined
          }
        />
      );
    }
    case "marker":
      return <TaskChatMarker item={item} />;
    case "thinking":
      // Thinking never renders as a row (PAP-361): its live signal is the
      // pill's "Thinking…" state, and the text stays in the run log / classic
      // transcript. The kind survives in the model because the transcript
      // parser still emits it (both nesting rules filter it out).
      return null;
    case "tool":
      return <TaskChatToolCard item={item} />;
    case "status":
      return (
        <TaskChatStatusPill
          item={item}
          onApprovalDecision={(optionId) => onApprovalDecision?.(item.id, optionId)}
        />
      );
    case "usage":
      return <TaskChatUsageReadout item={item} />;
    case "activity_phase":
      return <TaskChatActivityPhase item={item} renderChild={(child) => renderItem(child, onApprovalDecision)} />;
    case "interaction":
      return renderInteraction ? renderInteraction(item) : null;
    case "brief":
      return renderBrief ? renderBrief() : null;
    case "turn":
      return (
        <TaskChatTurn
          item={item}
          renderChild={(child) => renderItem(child, onApprovalDecision)}
        />
      );
    default: {
      // Exhaustiveness guard: a new item kind must add a branch above.
      const _never: never = item;
      return _never;
    }
  }
}

/**
 * Presentational render layer for the redesigned task thread. Consumed by both
 * the live thread (adapter over comment/run props) and the dev harness
 * (synthetic fixtures). Owns no data fetching — it maps a normalized
 * TaskChatItem[] onto the primitives inside the auto-follow scroller.
 */
export function TaskChatThreadView({
  items,
  header,
  onApprovalDecision,
  renderInteraction,
  renderBrief,
  renderMessageActions,
  renderQueuedAction,
  tail,
  contentKey,
  className,
  scroll = true,
}: TaskChatThreadViewProps) {
  const body = (
    <div className={cn("mx-auto flex w-full max-w-(--tc-shell-max-w) flex-col gap-5 px-4 py-4", className)}>
      {header ? (
        <div className="flex flex-col gap-6 pb-2" data-testid="task-chat-thread-header">
          {header}
        </div>
      ) : null}
      {items.map((item) => (
        <div key={item.id}>
          {renderItem(
            item,
            onApprovalDecision,
            renderInteraction,
            renderBrief,
            renderMessageActions,
            renderQueuedAction,
          )}
        </div>
      ))}
      {tail}
    </div>
  );

  if (!scroll) return body;

  return (
    <TaskMessageScroller contentKey={contentKey ?? taskChatContentKey(items)}>
      {body}
    </TaskMessageScroller>
  );
}

// Cheap content signature so streaming growth (text lengthening without the
// item count changing) still advances the auto-follow key. Shared by the
// desktop scroller above and the mobile window-scroll follow (TaskChatThread).
function signatureOf(it: TaskChatItem): number {
  if (it.kind === "message") return it.text.length + (it.attachedTurn ? 1 : 0);
  if (it.kind === "thinking") return it.lines.reduce((n, l) => n + l.length, 0);
  if (it.kind === "tool") return (it.diff?.lines?.length ?? 0) + (it.status === "completed" ? 1 : 0);
  if (it.kind === "turn") {
    if (it.settled) return 1;
    // The live parent row's header changes (gerund ↔ tool-state flashes,
    // streaming interstitial text growing) count too, so the collapsed
    // single-line turn still advances the key.
    const headerSig = it.liveStatus
      ? it.liveStatus.label.length +
        (it.liveStatus.detail?.length ?? 0) +
        (it.liveStatus.selfTalk?.length ?? 0)
      : 0;
    return it.items.reduce((n, child) => n + signatureOf(child), it.items.length + headerSig);
  }
  if (it.kind === "activity_phase") {
    return it.items.reduce((n, child) => n + signatureOf(child), it.summary.length + (it.interstitial?.text.length ?? 0));
  }
  return 1;
}

export function taskChatContentKey(items: TaskChatItem[]): number {
  return items.reduce((acc, it) => acc + signatureOf(it), items.length);
}
