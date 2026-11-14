import type { IssueBlockerAttention } from "@paperclipai/shared";
import { displayText } from "@/i18n/display-text";

/**
 * Everything a task status surface needs to pick its glyph and label. Every
 * view (sidebar rows, task header, properties, status picker, lists, inbox,
 * pills, search) resolves through {@link resolveTaskStatusPresentation}, so one
 * underlying state always renders the same icon and label (BUG-07).
 */
export interface TaskStatusPresentationInput {
  status: string;
  /** Server-derived presentation; mutations still use the canonical status. */
  displayStatus?: string | null;
  externalConversationState?: "active" | "waiting" | null;
  blockerAttention?: IssueBlockerAttention | null;
}

export interface TaskStatusPresentation {
  /** Key into the unified StatusGlyph icon/colour tables. */
  glyphStatus: string;
  /** Short visible label ("Blocked", "Idle", "Monitoring", …). */
  label: string;
  /** Full accessible/tooltip copy, including the blocked reason. */
  ariaLabel: string;
}

export function taskStatusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function blockedAttentionLabel(blockerAttention: IssueBlockerAttention | null | undefined) {
  if (!blockerAttention || blockerAttention.state === "none") return displayText("Blocked");

  if (blockerAttention.reason === "active_child") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return displayText("Blocked · waiting on active sub-task {{v0}}", { v0: blockerAttention.sampleBlockerIdentifier });
    }
    if (count === 1) return displayText("Blocked · waiting on 1 active sub-task");
    return displayText("Blocked · waiting on {{v0}} active sub-tasks", { v0: count });
  }

  if (blockerAttention.reason === "active_dependency") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return displayText("Blocked · covered by active dependency {{v0}}", { v0: blockerAttention.sampleBlockerIdentifier });
    }
    if (count === 1) return displayText("Blocked · covered by 1 active dependency");
    return displayText("Blocked · covered by {{v0}} active dependencies", { v0: count });
  }

  if (blockerAttention.reason === "stalled_review") {
    const count = blockerAttention.stalledBlockerCount;
    const leaf = blockerAttention.sampleStalledBlockerIdentifier ?? blockerAttention.sampleBlockerIdentifier;
    if (count === 1 && leaf) return displayText("Blocked · review stalled on {{v0}}", { v0: leaf });
    if (count === 1) return displayText("Blocked · review stalled with no clear next step");
    return displayText("Blocked · {{v0}} reviews stalled with no clear next step", { v0: count });
  }

  if (blockerAttention.reason === "attention_required") {
    const count = blockerAttention.attentionBlockerCount || blockerAttention.unresolvedBlockerCount;
    const coveredCount = blockerAttention.coveredBlockerCount;
    if (coveredCount > 0) {
      return count === 1
        ? displayText("Blocked · {{v0}} blocker needs attention; {{v1}} covered by active work", { v0: count, v1: coveredCount })
        : displayText("Blocked · {{v0}} blockers need attention; {{v1}} covered by active work", { v0: count, v1: coveredCount });
    }
    return count === 1
      ? displayText("Blocked · {{v0}} blocker needs attention", { v0: count })
      : displayText("Blocked · {{v0}} blockers need attention", { v0: count });
  }

  return displayText("Blocked");
}

/**
 * The one state → glyph/label mapping:
 * - in_review whose external conversation is waiting → "Idle"
 * - in_progress presented as monitoring → "Monitoring" (clock)
 * - blocked and covered by active work → the blue "in queue" glyph, with the
 *   blocked reason on the accessible label
 */
export function resolveTaskStatusPresentation(input: TaskStatusPresentationInput): TaskStatusPresentation {
  const { status, displayStatus, externalConversationState, blockerAttention } = input;
  // A saved/optimistic transition must win over the previous read projection.
  const projectedStatus = status === "in_progress" ? (displayStatus ?? status) : status;
  const visibleStatus = projectedStatus === "in_review" && externalConversationState === "waiting"
    ? "idle"
    : projectedStatus;
  const isCoveredBlocked = projectedStatus === "blocked" && blockerAttention?.state === "covered";
  return {
    glyphStatus: isCoveredBlocked ? "in_queue" : visibleStatus,
    label: taskStatusLabel(visibleStatus),
    ariaLabel: projectedStatus === "blocked" ? blockedAttentionLabel(blockerAttention) : taskStatusLabel(visibleStatus),
  };
}

type TaskStatusSource = {
  status: string;
  displayStatus?: string | null;
  externalConversationState?: "active" | "waiting" | null;
  blockerAttention?: IssueBlockerAttention | null;
};

/**
 * Pick every status-presentation field from a task record so a view cannot
 * silently drop one (e.g. `blockerAttention`) and render a different glyph
 * than the task pane. Spread into `<StatusIcon {...taskStatusIconProps(task)} />`.
 */
export function taskStatusIconProps(task: TaskStatusSource): TaskStatusPresentationInput {
  return {
    status: task.status,
    displayStatus: task.displayStatus ?? null,
    externalConversationState: task.externalConversationState ?? null,
    blockerAttention: task.blockerAttention ?? null,
  };
}
