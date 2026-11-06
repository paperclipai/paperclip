import { t } from "@/i18n";
import type { IssueBlockerAttention } from "@paperclipai/shared";

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
  const key = `deep-ui:status_${status}`;
  const known = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked", "idle", "monitoring"];
  return known.includes(status) ? t(key) : status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function blockedAttentionLabel(blockerAttention: IssueBlockerAttention | null | undefined) {
  if (!blockerAttention || blockerAttention.state === "none") return t("task-components:blocked_18f2a094");

  if (blockerAttention.reason === "active_child") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return t("deep-ui:blocked_child_id", { id: blockerAttention.sampleBlockerIdentifier });
    }
    if (count === 1) return t("deep-ui:blocked_waiting_on_1_active_sub_task_5878bb");
    return t("deep-ui:blocked_children", { count });
  }

  if (blockerAttention.reason === "active_dependency") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return t("deep-ui:blocked_dependency_id", { id: blockerAttention.sampleBlockerIdentifier });
    }
    if (count === 1) return t("deep-ui:blocked_covered_by_1_active_dependency_319c94");
    return t("deep-ui:blocked_dependencies", { count });
  }

  if (blockerAttention.reason === "stalled_review") {
    const count = blockerAttention.stalledBlockerCount;
    const leaf = blockerAttention.sampleStalledBlockerIdentifier ?? blockerAttention.sampleBlockerIdentifier;
    if (count === 1 && leaf) return t("deep-ui:blocked_review_id", { id: leaf });
    if (count === 1) return t("deep-ui:blocked_review_stalled_with_no_clear_next_step_4978f3");
    return t("deep-ui:blocked_reviews", { count });
  }

  if (blockerAttention.reason === "attention_required") {
    const count = blockerAttention.attentionBlockerCount || blockerAttention.unresolvedBlockerCount;

    const coveredCount = blockerAttention.coveredBlockerCount;
    if (coveredCount > 0) {
      return t("deep-ui:blocked_attention_covered", { count, coveredCount });
    }
    return t("deep-ui:blocked_attention", { count });
  }

  return t("task-components:blocked_18f2a094");
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
  const visibleStatus = status === "in_review" && externalConversationState === "waiting"
    ? "idle"
    : status === "in_progress" && displayStatus === "monitoring"
      ? "monitoring"
      : status;
  const isCoveredBlocked = status === "blocked" && blockerAttention?.state === "covered";
  return {
    glyphStatus: isCoveredBlocked ? "in_queue" : visibleStatus,
    label: taskStatusLabel(visibleStatus),
    ariaLabel: status === "blocked" ? blockedAttentionLabel(blockerAttention) : taskStatusLabel(visibleStatus),
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
