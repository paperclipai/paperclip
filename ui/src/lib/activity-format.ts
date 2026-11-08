import { t } from "@/i18n";
import type { Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "./company-members";
import { formatReviewPolicyValue } from "./review-policy";

type ActivityDetails = Record<string, unknown> | null | undefined;

type ActivityParticipant = {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
};

type ActivityIssueReference = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
};

interface ActivityFormatOptions {
  agentMap?: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  currentUserId?: string | null;
}

const ACTIVITY_ROW_VERBS: Record<string, string> = {
  "case.created": "activity_activity_row_verbs_case_created",
  "case.updated": "activity_activity_row_verbs_case_updated",
  "case.fields_changed": "activity_activity_row_verbs_case_fields_changed",
  "case.status_changed": "activity_activity_row_verbs_case_status_changed",
  "case.issue_linked": "activity_activity_row_verbs_case_issue_linked",
  "case.issue_unlinked": "activity_activity_row_verbs_case_issue_unlinked",
  "case.child_linked": "activity_activity_row_verbs_case_child_linked",
  "case.attachment_added": "activity_activity_row_verbs_case_attachment_added",
  "case.label_added": "activity_activity_row_verbs_case_label_added",
  "case.label_removed": "activity_activity_row_verbs_case_label_removed",
  "case.document_revised": "activity_activity_row_verbs_case_document_revised",
  "case.handoff_requested": "activity_activity_row_verbs_case_handoff_requested",
  "case.handoff_applied": "activity_activity_row_verbs_case_handoff_applied",
  "case.handoff_delivered": "activity_activity_row_verbs_case_handoff_delivered",
  "case.handoff_retry_requested": "activity_activity_row_verbs_case_handoff_retry_requested",
  "case.handoff_cancelled": "activity_activity_row_verbs_case_handoff_cancelled",
  "case.handoff_completed": "activity_activity_row_verbs_case_handoff_completed",
  "issue.created": "activity_activity_row_verbs_issue_created",
  "issue.updated": "activity_activity_row_verbs_issue_updated",
  "issue.read_marked": "activity_activity_row_verbs_issue_read_marked",
  "issue.read_unmarked": "activity_activity_row_verbs_issue_read_unmarked",
  "issue.checked_out": "activity_activity_row_verbs_issue_checked_out",
  "issue.released": "activity_activity_row_verbs_issue_released",
  "issue.comment_added": "activity_activity_row_verbs_issue_comment_added",
  "issue.comment_cancelled": "activity_activity_row_verbs_issue_comment_cancelled",
  "issue.queued_comment_edited": "activity_activity_row_verbs_issue_queued_comment_edited",
  "issue.queued_comments_reordered": "activity_activity_row_verbs_issue_queued_comments_reordered",
  "issue.queued_comment_discarded": "activity_activity_row_verbs_issue_queued_comment_discarded",
  "issue.comment_deleted": "activity_activity_row_verbs_issue_comment_deleted",
  "issue.attachment_added": "activity_activity_row_verbs_issue_attachment_added",
  "issue.attachment_removed": "activity_activity_row_verbs_issue_attachment_removed",
  "issue.document_created": "activity_activity_row_verbs_issue_document_created",
  "issue.document_updated": "activity_activity_row_verbs_issue_document_updated",
  "issue.document_locked": "activity_activity_row_verbs_issue_document_locked",
  "issue.document_unlocked": "activity_activity_row_verbs_issue_document_unlocked",
  "issue.document_deleted": "activity_activity_row_verbs_issue_document_deleted",
  "issue.monitor_scheduled": "activity_activity_row_verbs_issue_monitor_scheduled",
  "issue.monitor_triggered": "activity_activity_row_verbs_issue_monitor_triggered",
  "issue.monitor_cleared": "activity_activity_row_verbs_issue_monitor_cleared",
  "issue.monitor_skipped": "activity_activity_row_verbs_issue_monitor_skipped",
  "issue.monitor_exhausted": "activity_activity_row_verbs_issue_monitor_exhausted",
  "issue.monitor_recovery_wake_queued": "activity_activity_row_verbs_issue_monitor_recovery_wake_queued",
  "issue.monitor_recovery_issue_created": "activity_activity_row_verbs_issue_monitor_recovery_issue_created",
  "issue.monitor_escalated_to_board": "activity_activity_row_verbs_issue_monitor_escalated_to_board",
  "issue.commented": "activity_activity_row_verbs_issue_commented",
  "issue.deleted": "activity_activity_row_verbs_issue_deleted",
  "issue.successful_run_handoff_required": "activity_activity_row_verbs_issue_successful_run_handoff_required",
  "issue.successful_run_handoff_resolved": "activity_activity_row_verbs_issue_successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated": "activity_activity_row_verbs_issue_successful_run_handoff_escalated",
  "issue.accepted_plan_decomposition_updated": "activity_activity_row_verbs_issue_accepted_plan_decomposition_updated",
  "issue.recovery_action_opened": "activity_activity_row_verbs_issue_recovery_action_opened",
  "issue.workspace_recovered": "activity_activity_row_verbs_issue_workspace_recovered",
  "issue.workspace_recovery_requested": "activity_activity_row_verbs_issue_workspace_recovery_requested",
  "issue.recovery_action_resolved": "activity_activity_row_verbs_issue_recovery_action_resolved",
  "issue.recovery_action_escalated": "activity_activity_row_verbs_issue_recovery_action_escalated",
  "agent.created": "activity_activity_row_verbs_agent_created",
  "agent.updated": "activity_activity_row_verbs_agent_updated",
  "agent.paused": "activity_activity_row_verbs_agent_paused",
  "agent.resumed": "activity_activity_row_verbs_agent_resumed",
  "agent.error_cleared": "activity_activity_row_verbs_agent_error_cleared",
  "agent.terminated": "activity_activity_row_verbs_agent_terminated",
  "agent.key_created": "activity_activity_row_verbs_agent_key_created",
  "agent.budget_updated": "activity_activity_row_verbs_agent_budget_updated",
  "agent.runtime_session_reset": "activity_activity_row_verbs_agent_runtime_session_reset",
  "heartbeat.invoked": "activity_activity_row_verbs_heartbeat_invoked",
  "heartbeat.cancelled": "activity_activity_row_verbs_heartbeat_cancelled",
  "heartbeat.output_stale_source_resolved": "activity_activity_row_verbs_heartbeat_output_stale_source_resolved",
  "heartbeat.output_stale_recovery_recursion_refused": "activity_activity_row_verbs_heartbeat_output_stale_recovery_recursion_refused",
  "approval.created": "activity_activity_row_verbs_approval_created",
  "approval.approved": "activity_activity_row_verbs_approval_approved",
  "approval.rejected": "activity_activity_row_verbs_approval_rejected",
  // Interaction outcomes (PAP-16506). An agent may now resolve one — including a
  // review of its own work — so these must read as outcomes in the feed instead
  // of falling through to the raw "issue thread interaction accepted" action id.
  // `details.interactionKind` sharpens the wording; see INTERACTION_OUTCOME_LABELS.
  "issue.thread_interaction_created": "activity_activity_row_verbs_issue_thread_interaction_created",
  "issue.thread_interaction_accepted": "activity_activity_row_verbs_issue_thread_interaction_accepted",
  "issue.thread_interaction_rejected": "activity_activity_row_verbs_issue_thread_interaction_rejected",
  "issue.thread_interaction_answered": "activity_activity_row_verbs_issue_thread_interaction_answered",
  "issue.thread_interaction_withdrawn": "activity_activity_row_verbs_issue_thread_interaction_withdrawn",
  "issue.thread_interaction_cancelled": "activity_activity_row_verbs_issue_thread_interaction_cancelled",
  "issue.thread_interaction_skipped": "activity_activity_row_verbs_issue_thread_interaction_skipped",
  "issue.thread_interaction_dismissed": "activity_activity_row_verbs_issue_thread_interaction_dismissed",
  "issue.thread_interaction_expired": "activity_activity_row_verbs_issue_thread_interaction_expired",
  "issue.thread_interaction_item_verdicts_submitted": "activity_activity_row_verbs_issue_thread_interaction_item_verdicts_submitted",
  "issue.stalled_review_decided": "activity_activity_row_verbs_issue_stalled_review_decided",
  "project.created": "activity_activity_row_verbs_project_created",
  "project.updated": "activity_activity_row_verbs_project_updated",
  "project.deleted": "activity_activity_row_verbs_project_deleted",
  "goal.created": "activity_activity_row_verbs_goal_created",
  "goal.updated": "activity_activity_row_verbs_goal_updated",
  "goal.deleted": "activity_activity_row_verbs_goal_deleted",
  "cost.reported": "activity_activity_row_verbs_cost_reported",
  "cost.recorded": "activity_activity_row_verbs_cost_recorded",
  "company.created": "activity_activity_row_verbs_company_created",
  "company.updated": "activity_activity_row_verbs_company_updated",
  "company.archived": "activity_activity_row_verbs_company_archived",
  "company.reactivated": "activity_activity_row_verbs_company_reactivated",
  "company.budget_updated": "activity_activity_row_verbs_company_budget_updated",
  "audit.exported": "activity_activity_row_verbs_audit_exported",
  "tool_app.connected": "activity_activity_row_verbs_tool_app_connected",
  "tool_app.oauth_connected": "activity_activity_row_verbs_tool_app_oauth_connected",
  "tool_app.oauth_failed": "activity_activity_row_verbs_tool_app_oauth_failed",
  "tool_app.oauth_access_finalized": "activity_activity_row_verbs_tool_app_oauth_access_finalized",
  "tool_app.finished": "activity_activity_row_verbs_tool_app_finished",
  "tool_app.reconnected": "activity_activity_row_verbs_tool_app_reconnected",
  "tool_connection.created": "activity_activity_row_verbs_tool_connection_created",
  "tool_connection.updated": "activity_activity_row_verbs_tool_connection_updated",
  "tool_connection.archived": "activity_activity_row_verbs_tool_connection_archived",
  "tool_connection.catalog_refresh": "activity_activity_row_verbs_tool_connection_catalog_refresh",
  "tool_connection.installs_synced": "activity_activity_row_verbs_tool_connection_installs_synced",
  "tool_connection.install_access_extended": "activity_activity_row_verbs_tool_connection_install_access_extended",
  "tool_connection.grant_audience_replaced": "activity_activity_row_verbs_tool_connection_grant_audience_replaced",
  "tool_connection.grant_added": "activity_activity_row_verbs_tool_connection_grant_added",
  "tool_connection.grant_revoked": "activity_activity_row_verbs_tool_connection_grant_revoked",
  "tool_connection.grant_delegated": "activity_activity_row_verbs_tool_connection_grant_delegated",
  "tool_connection.grant_delegation_revoked": "activity_activity_row_verbs_tool_connection_grant_delegation_revoked",
};

const ISSUE_ACTIVITY_LABELS: Record<string, string> = {
  "issue.created": "activity_issue_activity_labels_issue_created",
  "issue.updated": "activity_issue_activity_labels_issue_updated",
  "issue.checked_out": "activity_issue_activity_labels_issue_checked_out",
  "issue.released": "activity_issue_activity_labels_issue_released",
  "issue.comment_added": "activity_issue_activity_labels_issue_comment_added",
  "issue.comment_cancelled": "activity_issue_activity_labels_issue_comment_cancelled",
  "issue.queued_comment_edited": "activity_issue_activity_labels_issue_queued_comment_edited",
  "issue.queued_comments_reordered": "activity_issue_activity_labels_issue_queued_comments_reordered",
  "issue.queued_comment_discarded": "activity_issue_activity_labels_issue_queued_comment_discarded",
  "issue.comment_deleted": "activity_issue_activity_labels_issue_comment_deleted",
  "issue.feedback_vote_saved": "activity_issue_activity_labels_issue_feedback_vote_saved",
  "issue.attachment_added": "activity_issue_activity_labels_issue_attachment_added",
  "issue.attachment_removed": "activity_issue_activity_labels_issue_attachment_removed",
  "issue.document_created": "activity_issue_activity_labels_issue_document_created",
  "issue.document_updated": "activity_issue_activity_labels_issue_document_updated",
  "issue.document_locked": "activity_issue_activity_labels_issue_document_locked",
  "issue.document_unlocked": "activity_issue_activity_labels_issue_document_unlocked",
  "issue.document_deleted": "activity_issue_activity_labels_issue_document_deleted",
  "issue.monitor_scheduled": "activity_issue_activity_labels_issue_monitor_scheduled",
  "issue.monitor_triggered": "activity_issue_activity_labels_issue_monitor_triggered",
  "issue.monitor_cleared": "activity_issue_activity_labels_issue_monitor_cleared",
  "issue.monitor_skipped": "activity_issue_activity_labels_issue_monitor_skipped",
  "issue.monitor_exhausted": "activity_issue_activity_labels_issue_monitor_exhausted",
  "issue.monitor_recovery_wake_queued": "activity_issue_activity_labels_issue_monitor_recovery_wake_queued",
  "issue.monitor_recovery_issue_created": "activity_issue_activity_labels_issue_monitor_recovery_issue_created",
  "issue.monitor_escalated_to_board": "activity_issue_activity_labels_issue_monitor_escalated_to_board",
  "issue.deleted": "activity_issue_activity_labels_issue_deleted",
  "issue.successful_run_handoff_required": "activity_issue_activity_labels_issue_successful_run_handoff_required",
  "issue.successful_run_handoff_resolved": "activity_issue_activity_labels_issue_successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated": "activity_issue_activity_labels_issue_successful_run_handoff_escalated",
  "issue.cross_issue_influence_cap_rejected": "activity_issue_activity_labels_issue_cross_issue_influence_cap_rejected",
  "issue.cross_issue_influence_observed": "activity_issue_activity_labels_issue_cross_issue_influence_observed",
  "issue.attribution_spoof_rejected": "activity_issue_activity_labels_issue_attribution_spoof_rejected",
  "issue.recovery_action_opened": "activity_issue_activity_labels_issue_recovery_action_opened",
  "issue.workspace_recovered": "activity_issue_activity_labels_issue_workspace_recovered",
  "issue.workspace_recovery_requested": "activity_issue_activity_labels_issue_workspace_recovery_requested",
  "issue.recovery_action_resolved": "activity_issue_activity_labels_issue_recovery_action_resolved",
  "issue.recovery_action_escalated": "activity_issue_activity_labels_issue_recovery_action_escalated",
  "issue.accepted_plan_decomposition_updated": "activity_issue_activity_labels_issue_accepted_plan_decomposition_updated",
  "agent.created": "activity_issue_activity_labels_agent_created",
  "agent.updated": "activity_issue_activity_labels_agent_updated",
  "agent.paused": "activity_issue_activity_labels_agent_paused",
  "agent.resumed": "activity_issue_activity_labels_agent_resumed",
  "agent.error_cleared": "activity_issue_activity_labels_agent_error_cleared",
  "agent.terminated": "activity_issue_activity_labels_agent_terminated",
  "heartbeat.invoked": "activity_issue_activity_labels_heartbeat_invoked",
  "heartbeat.cancelled": "activity_issue_activity_labels_heartbeat_cancelled",
  "heartbeat.output_stale_source_resolved": "activity_issue_activity_labels_heartbeat_output_stale_source_resolved",
  "heartbeat.output_stale_recovery_recursion_refused": "activity_issue_activity_labels_heartbeat_output_stale_recovery_recursion_refused",
  "approval.created": "activity_issue_activity_labels_approval_created",
  "approval.approved": "activity_issue_activity_labels_approval_approved",
  "approval.rejected": "activity_issue_activity_labels_approval_rejected",
  "issue.thread_interaction_created": "activity_issue_activity_labels_issue_thread_interaction_created",
  "issue.thread_interaction_accepted": "activity_issue_activity_labels_issue_thread_interaction_accepted",
  "issue.thread_interaction_rejected": "activity_issue_activity_labels_issue_thread_interaction_rejected",
  "issue.thread_interaction_answered": "activity_issue_activity_labels_issue_thread_interaction_answered",
  "issue.thread_interaction_withdrawn": "activity_issue_activity_labels_issue_thread_interaction_withdrawn",
  "issue.thread_interaction_cancelled": "activity_issue_activity_labels_issue_thread_interaction_cancelled",
  "issue.thread_interaction_skipped": "activity_issue_activity_labels_issue_thread_interaction_skipped",
  "issue.thread_interaction_dismissed": "activity_issue_activity_labels_issue_thread_interaction_dismissed",
  "issue.thread_interaction_expired": "activity_issue_activity_labels_issue_thread_interaction_expired",
  "issue.thread_interaction_item_verdicts_submitted": "activity_issue_activity_labels_issue_thread_interaction_item_verdicts_submitted",
  "issue.stalled_review_decided": "activity_issue_activity_labels_issue_stalled_review_decided",
};

/**
 * `issue.stalled_review_decided` carries the verb the actor chose, so the line
 * names the verdict ("approved the review") rather than the generic action.
 * Mirrors `StalledReviewDecisionAction` in shared.
 */
const STALLED_REVIEW_DECISION_LABELS: Record<string, string> = {
  approve: "activity_stalled_review_decision_labels_approve",
  request_changes: "activity_stalled_review_decision_labels_request_changes",
  send_back: "activity_stalled_review_decision_labels_send_back",
};

/**
 * `issue.thread_interaction_accepted` / `_rejected` fire for *every* interaction
 * kind, not only for a review. A task suggestion or a question is accepted, not
 * approved, so the kind on the event picks the verb. Kinds absent from a map
 * keep the neutral "accepted the request" wording from the tables above, which
 * is also the fallback for an event that carries no kind.
 */
const INTERACTION_ACCEPTED_LABELS: Record<string, string> = {
  request_confirmation: "activity_interaction_accepted_labels_request_confirmation",
  request_checkbox_confirmation: "activity_interaction_accepted_labels_request_checkbox_confirmation",
  suggest_tasks: "activity_interaction_accepted_labels_suggest_tasks",
  ask_user_questions: "activity_interaction_accepted_labels_ask_user_questions",
};

const INTERACTION_REJECTED_LABELS: Record<string, string> = {
  request_confirmation: "activity_interaction_rejected_labels_request_confirmation",
  request_checkbox_confirmation: "activity_interaction_rejected_labels_request_checkbox_confirmation",
  suggest_tasks: "activity_interaction_rejected_labels_suggest_tasks",
  ask_user_questions: "activity_interaction_rejected_labels_ask_user_questions",
};

/**
 * Kind-aware wording for an interaction outcome, or `null` when the tables
 * above already say it well enough.
 */
function formatInteractionOutcomeLabel(action: string, details: ActivityDetails): string | null {
  const table = action === "issue.thread_interaction_accepted"
    ? INTERACTION_ACCEPTED_LABELS
    : action === "issue.thread_interaction_rejected"
      ? INTERACTION_REJECTED_LABELS
      : null;
  if (!table) return null;
  const kind = typeof details?.interactionKind === "string" ? details.interactionKind : null;
  return kind && table[kind] ? t(`display:${table[kind]}`) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? t("display:none"));
  return t(`display:activity_value_${value}`, { defaultValue: value.replace(/_/g, " ") });
}

function isActivityParticipant(value: unknown): value is ActivityParticipant {
  const record = asRecord(value);
  if (!record) return false;
  return record.type === "agent" || record.type === "user";
}

function isActivityIssueReference(value: unknown): value is ActivityIssueReference {
  return asRecord(value) !== null;
}

function readParticipants(details: ActivityDetails, key: string): ActivityParticipant[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityParticipant);
}

function readIssueReferences(details: ActivityDetails, key: string): ActivityIssueReference[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityIssueReference);
}

function formatUserLabel(userId: string | null | undefined, options: ActivityFormatOptions = {}): string {
  if (!userId || userId === "local-board") return t("display:board");
  if (options.currentUserId && userId === options.currentUserId) return t("display:you");
  const profile = options.userProfileMap?.get(userId);
  if (profile) return profile.label;
  return t("display:user_short", { id: userId.slice(0, 5) });
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? t("display:agent");
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return t("display:task");
}

function formatChangedEntityLabel(
  singular: string,
  plural: string,
  labels: string[],
): string {
  if (labels.length <= 0) return t(`display:entity_${plural}`);
  if (labels.length === 1) return t("display:entity_single", { entity: t(`display:entity_${singular}`), name: labels[0] });
  return t("display:entity_count", { count: labels.length, entity: t(`display:entity_${plural}`) });
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function readStringArrayLength(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((entry) => typeof entry === "string" && entry.length > 0).length;
}

function formatAcceptedPlanDecompositionDetail(details: ActivityDetails): string | null {
  if (!details) return null;
  const status = typeof details.status === "string" ? details.status : null;
  const requested = readNumber(details.requestedChildCount);
  const totalChildren = readStringArrayLength(details.childIssueIds);
  const newlyCreated = readStringArrayLength(details.newlyCreatedChildIssueIds);
  const reused = Math.max(0, totalChildren - newlyCreated);
  const parts: string[] = [];
  if (newlyCreated > 0) parts.push(t("display:decomposition_new", { count: newlyCreated }));
  if (reused > 0) parts.push(t("display:decomposition_reused", { count: reused }));
  if (parts.length === 0 && requested !== null) parts.push(t("display:decomposition_requested", { count: requested }));
  const summary = parts.length > 0 ? parts.join(t("display:list_separator")) : null;
  if (status === "completed" && summary) return t("display:decomposition_completed_summary", { summary: summary });
  if (status === "completed") return t("display:decomposition_completed");
  if (status === "in_flight" && summary) return t("display:decomposition_in_flight", { summary: summary });
  return summary;
}

function formatIssueUpdatedVerb(details: ActivityDetails): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  if (details.status !== undefined) {
    const from = previous.status;
    const to = humanizeValue(details.status === "in_review" && details.externalConversationState === "waiting" ? "idle" : details.status);
    return from
      ? t("display:activity_status_from_row", { from: humanizeValue(from), to: to })
      : t("display:activity_status_to_row", { to: to });
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? t("display:activity_priority_from_row", { from: humanizeValue(from), to: humanizeValue(details.priority) })
      : t("display:activity_priority_to_row", { to: humanizeValue(details.priority) });
  }
  return null;
}

function formatAssigneeName(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const agentId = details.assigneeAgentId;
  const userId = details.assigneeUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? t("display:agent");
  }
  if (typeof userId === "string" && userId) {
    return formatUserLabel(userId, options);
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails, options: ActivityFormatOptions = {}): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  if (details.status !== undefined) {
    const from = previous.status;
    const to = humanizeValue(details.status === "in_review" && details.externalConversationState === "waiting" ? "idle" : details.status);
    parts.push(
      from
        ? t("display:activity_status_from", { from: humanizeValue(from), to: to })
        : t("display:activity_status_to", { to: to }),
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? t("display:activity_priority_from", { from: humanizeValue(from), to: humanizeValue(details.priority) })
        : t("display:activity_priority_to", { to: humanizeValue(details.priority) }),
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    const assigneeName = formatAssigneeName(details, options);
    parts.push(assigneeName ? t("display:activity_responsible", { name: assigneeName }) : t("display:activity_responsible_cleared"));
  }
  if (details.reviewPolicy !== undefined) {
    // `null` is the default ("anyone can approve"), so it must not read as
    // "changed the review policy to none" (PAP-16506).
    parts.push(t("display:activity_policy", { policy: formatReviewPolicyValue(details.reviewPolicy) }));
  }
  if (details.title !== undefined) parts.push(t("display:activity_title_updated"));
  if (details.description !== undefined) parts.push(t("display:activity_description_updated"));

  return parts.length > 0 ? parts.join(t("display:list_separator")) : null;
}

function formatStructuredIssueChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
  forIssueDetail: boolean;
}): string | null {
  const details = input.details;
  if (!details) return null;

  if (input.action === "issue.blockers_updated") {
    const added = readIssueReferences(details, "addedBlockedByIssues").map(formatIssueReferenceLabel);
    const removed = readIssueReferences(details, "removedBlockedByIssues").map(formatIssueReferenceLabel);
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", added);
      return input.forIssueDetail ? t("display:change_added", { changed: changed }) : t("display:change_added_row", { changed: changed });
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", removed);
      return input.forIssueDetail ? t("display:change_removed", { changed: changed }) : t("display:change_removed_row", { changed: changed });
    }
    return input.forIssueDetail ? t("display:blockers_updated") : t("display:blockers_updated_row");
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const singular = input.action === "issue.reviewers_updated" ? "reviewer" : "approver";
    const plural = input.action === "issue.reviewers_updated" ? "reviewers" : "approvers";
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, added);
      return input.forIssueDetail ? t("display:change_added", { changed: changed }) : t("display:change_added_row", { changed: changed });
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, removed);
      return input.forIssueDetail ? t("display:change_removed", { changed: changed }) : t("display:change_removed_row", { changed: changed });
    }
    return input.forIssueDetail ? t("display:participants_updated", { participants: t(`display:entity_${plural}`) }) : t("display:participants_updated_row", { participants: t(`display:entity_${plural}`) });
  }

  return null;
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action.startsWith("tool_gateway.")) {
    const rawTool = typeof details?.tool === "string"
      ? details.tool
      : typeof details?.upstreamToolName === "string"
        ? details.upstreamToolName
        : t("display:tool_action");
    const tool = rawTool.replace(/[._-]+/g, " ");
    const isTest = details?.source === "test";
    if (action === "tool_gateway.call_completed") return isTest ? t("display:tool_tested", { tool: tool }) : t("display:tool_used", { tool: tool });
    if (action === "tool_gateway.call_allowed") return isTest ? t("display:tool_test_started", { tool: tool }) : t("display:tool_allowed", { tool: tool });
    if (action === "tool_gateway.call_denied") return t("display:tool_denied", { tool: tool });
    if (action === "tool_gateway.approval_requested") return t("display:tool_requested", { tool: tool });
    if (action === "tool_gateway.session_created") return t("display:tool_session");
    if (action === "tool_gateway.session_rejected") return t("display:tool_session_denied");
    if (action === "tool_gateway.discovery") return t("display:tool_discovery");
  }

  if (action === "issue.updated") {
    const issueUpdatedVerb = formatIssueUpdatedVerb(details);
    if (issueUpdatedVerb) return issueUpdatedVerb;
  }

  if (action === "issue.stalled_review_decided") {
    const decision = typeof details?.action === "string" ? details.action : null;
    const label = decision ? STALLED_REVIEW_DECISION_LABELS[decision] ? t(`display:${STALLED_REVIEW_DECISION_LABELS[decision]}`) : null : null;
    if (label) return t("display:activity_outcome_row", { label: label });
  }

  const outcomeLabel = formatInteractionOutcomeLabel(action, details);
  if (outcomeLabel) return t("display:activity_outcome_row", { label: outcomeLabel });

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: false,
  });
  if (structuredChange) return structuredChange;

  return ACTIVITY_ROW_VERBS[action] ? t(`display:${ACTIVITY_ROW_VERBS[action]}`) : action.replace(/[._]/g, " ");
}

export function formatIssueActivityAction(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedAction = formatIssueUpdatedAction(details, options);
    if (issueUpdatedAction) return issueUpdatedAction;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: true,
  });
  if (structuredChange) return structuredChange;

  if (action === "issue.accepted_plan_decomposition_updated") {
    const detail = formatAcceptedPlanDecompositionDetail(details);
    if (detail) return detail;
  }

  if (action === "issue.stalled_review_decided") {
    const decision = typeof details?.action === "string" ? details.action : null;
    const label = decision ? STALLED_REVIEW_DECISION_LABELS[decision] ? t(`display:${STALLED_REVIEW_DECISION_LABELS[decision]}`) : null : null;
    if (label) return label;
  }

  const outcomeLabel = formatInteractionOutcomeLabel(action, details);
  if (outcomeLabel) return outcomeLabel;

  if (action.startsWith("issue.monitor_") && details) {
    const serviceName = typeof details.serviceName === "string" && details.serviceName.trim()
      ? details.serviceName.trim()
      : null;
    const base = ISSUE_ACTIVITY_LABELS[action] ? t(`display:${ISSUE_ACTIVITY_LABELS[action]}`) : action.replace(/[._]/g, " ");
    return serviceName ? t("display:monitor_service", { base: base, service: serviceName }) : base;
  }

  if (
    (
      action === "issue.document_created" ||
      action === "issue.document_updated" ||
      action === "issue.document_locked" ||
      action === "issue.document_unlocked" ||
      action === "issue.document_deleted"
    ) &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : t("display:document");
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return t("display:activity_document", { action: ISSUE_ACTIVITY_LABELS[action] ? t(`display:${ISSUE_ACTIVITY_LABELS[action]}`) : action, key: key, title: title });
  }

  return ISSUE_ACTIVITY_LABELS[action] ? t(`display:${ISSUE_ACTIVITY_LABELS[action]}`) : action.replace(/[._]/g, " ");
}
