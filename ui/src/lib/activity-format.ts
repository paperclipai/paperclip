import type { Agent } from "@paperclipai/shared";
import { t } from "@/i18n";
import type { CompanyUserProfile } from "./company-members";

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

const ACTIVITY_VERB_KEYS: Record<string, string> = {
  "issue.created": "lib.activityFormat.verb.issue_created",
  "issue.updated": "lib.activityFormat.verb.issue_updated",
  "issue.checked_out": "lib.activityFormat.verb.issue_checked_out",
  "issue.released": "lib.activityFormat.verb.issue_released",
  "issue.comment_added": "lib.activityFormat.verb.issue_comment_added",
  "issue.comment_cancelled": "lib.activityFormat.verb.issue_comment_cancelled",
  "issue.attachment_added": "lib.activityFormat.verb.issue_attachment_added",
  "issue.attachment_removed": "lib.activityFormat.verb.issue_attachment_removed",
  "issue.document_created": "lib.activityFormat.verb.issue_document_created",
  "issue.document_updated": "lib.activityFormat.verb.issue_document_updated",
  "issue.document_locked": "lib.activityFormat.verb.issue_document_locked",
  "issue.document_unlocked": "lib.activityFormat.verb.issue_document_unlocked",
  "issue.document_deleted": "lib.activityFormat.verb.issue_document_deleted",
  "issue.monitor_scheduled": "lib.activityFormat.verb.issue_monitor_scheduled",
  "issue.monitor_triggered": "lib.activityFormat.verb.issue_monitor_triggered",
  "issue.monitor_cleared": "lib.activityFormat.verb.issue_monitor_cleared",
  "issue.monitor_skipped": "lib.activityFormat.verb.issue_monitor_skipped",
  "issue.monitor_exhausted": "lib.activityFormat.verb.issue_monitor_exhausted",
  "issue.monitor_recovery_wake_queued": "lib.activityFormat.verb.issue_monitor_recovery_wake_queued",
  "issue.monitor_recovery_issue_created": "lib.activityFormat.verb.issue_monitor_recovery_issue_created",
  "issue.monitor_escalated_to_board": "lib.activityFormat.verb.issue_monitor_escalated_to_board",
  "issue.commented": "lib.activityFormat.verb.issue_commented",
  "issue.deleted": "lib.activityFormat.verb.issue_deleted",
  "issue.successful_run_handoff_required": "lib.activityFormat.verb.issue_successful_run_handoff_required",
  "issue.successful_run_handoff_resolved": "lib.activityFormat.verb.issue_successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated": "lib.activityFormat.verb.issue_successful_run_handoff_escalated",
  "issue.recovery_action_opened": "lib.activityFormat.verb.issue_recovery_action_opened",
  "issue.recovery_action_resolved": "lib.activityFormat.verb.issue_recovery_action_resolved",
  "issue.recovery_action_escalated": "lib.activityFormat.verb.issue_recovery_action_escalated",
  "agent.created": "lib.activityFormat.verb.agent_created",
  "agent.updated": "lib.activityFormat.verb.agent_updated",
  "agent.paused": "lib.activityFormat.verb.agent_paused",
  "agent.resumed": "lib.activityFormat.verb.agent_resumed",
  "agent.terminated": "lib.activityFormat.verb.agent_terminated",
  "agent.key_created": "lib.activityFormat.verb.agent_key_created",
  "agent.budget_updated": "lib.activityFormat.verb.agent_budget_updated",
  "agent.runtime_session_reset": "lib.activityFormat.verb.agent_runtime_session_reset",
  "heartbeat.invoked": "lib.activityFormat.verb.heartbeat_invoked",
  "heartbeat.cancelled": "lib.activityFormat.verb.heartbeat_cancelled",
  "heartbeat.output_stale_source_resolved": "lib.activityFormat.verb.heartbeat_output_stale_source_resolved",
  "heartbeat.output_stale_recovery_recursion_refused": "lib.activityFormat.verb.heartbeat_output_stale_recovery_recursion_refused",
  "approval.created": "lib.activityFormat.verb.approval_created",
  "approval.approved": "lib.activityFormat.verb.approval_approved",
  "approval.rejected": "lib.activityFormat.verb.approval_rejected",
  "project.created": "lib.activityFormat.verb.project_created",
  "project.updated": "lib.activityFormat.verb.project_updated",
  "project.deleted": "lib.activityFormat.verb.project_deleted",
  "goal.created": "lib.activityFormat.verb.goal_created",
  "goal.updated": "lib.activityFormat.verb.goal_updated",
  "goal.deleted": "lib.activityFormat.verb.goal_deleted",
  "cost.reported": "lib.activityFormat.verb.cost_reported",
  "cost.recorded": "lib.activityFormat.verb.cost_recorded",
  "company.created": "lib.activityFormat.verb.company_created",
  "company.updated": "lib.activityFormat.verb.company_updated",
  "company.archived": "lib.activityFormat.verb.company_archived",
  "company.budget_updated": "lib.activityFormat.verb.company_budget_updated",
};

const ISSUE_ACTIVITY_LABEL_KEYS: Record<string, string> = {
  "issue.created": "lib.activityFormat.label.issue_created",
  "issue.updated": "lib.activityFormat.label.issue_updated",
  "issue.checked_out": "lib.activityFormat.label.issue_checked_out",
  "issue.released": "lib.activityFormat.label.issue_released",
  "issue.comment_added": "lib.activityFormat.label.issue_comment_added",
  "issue.comment_cancelled": "lib.activityFormat.label.issue_comment_cancelled",
  "issue.feedback_vote_saved": "lib.activityFormat.label.issue_feedback_vote_saved",
  "issue.attachment_added": "lib.activityFormat.label.issue_attachment_added",
  "issue.attachment_removed": "lib.activityFormat.label.issue_attachment_removed",
  "issue.document_created": "lib.activityFormat.label.issue_document_created",
  "issue.document_updated": "lib.activityFormat.label.issue_document_updated",
  "issue.document_locked": "lib.activityFormat.label.issue_document_locked",
  "issue.document_unlocked": "lib.activityFormat.label.issue_document_unlocked",
  "issue.document_deleted": "lib.activityFormat.label.issue_document_deleted",
  "issue.monitor_scheduled": "lib.activityFormat.label.issue_monitor_scheduled",
  "issue.monitor_triggered": "lib.activityFormat.label.issue_monitor_triggered",
  "issue.monitor_cleared": "lib.activityFormat.label.issue_monitor_cleared",
  "issue.monitor_skipped": "lib.activityFormat.label.issue_monitor_skipped",
  "issue.monitor_exhausted": "lib.activityFormat.label.issue_monitor_exhausted",
  "issue.monitor_recovery_wake_queued": "lib.activityFormat.label.issue_monitor_recovery_wake_queued",
  "issue.monitor_recovery_issue_created": "lib.activityFormat.label.issue_monitor_recovery_issue_created",
  "issue.monitor_escalated_to_board": "lib.activityFormat.label.issue_monitor_escalated_to_board",
  "issue.deleted": "lib.activityFormat.label.issue_deleted",
  "issue.successful_run_handoff_required": "lib.activityFormat.label.issue_successful_run_handoff_required",
  "issue.successful_run_handoff_resolved": "lib.activityFormat.label.issue_successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated": "lib.activityFormat.label.issue_successful_run_handoff_escalated",
  "issue.recovery_action_opened": "lib.activityFormat.label.issue_recovery_action_opened",
  "issue.recovery_action_resolved": "lib.activityFormat.label.issue_recovery_action_resolved",
  "issue.recovery_action_escalated": "lib.activityFormat.label.issue_recovery_action_escalated",
  "agent.created": "lib.activityFormat.label.agent_created",
  "agent.updated": "lib.activityFormat.label.agent_updated",
  "agent.paused": "lib.activityFormat.label.agent_paused",
  "agent.resumed": "lib.activityFormat.label.agent_resumed",
  "agent.terminated": "lib.activityFormat.label.agent_terminated",
  "heartbeat.invoked": "lib.activityFormat.label.heartbeat_invoked",
  "heartbeat.cancelled": "lib.activityFormat.label.heartbeat_cancelled",
  "heartbeat.output_stale_source_resolved": "lib.activityFormat.label.heartbeat_output_stale_source_resolved",
  "heartbeat.output_stale_recovery_recursion_refused": "lib.activityFormat.label.heartbeat_output_stale_recovery_recursion_refused",
  "approval.created": "lib.activityFormat.label.approval_created",
  "approval.approved": "lib.activityFormat.label.approval_approved",
  "approval.rejected": "lib.activityFormat.label.approval_rejected",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? t("lib.activityFormat.humanizeNone"));
  return value.replace(/_/g, " ");
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
  if (!userId || userId === "local-board") return t("lib.activityFormat.user.board");
  if (options.currentUserId && userId === options.currentUserId) return t("lib.activityFormat.user.you");
  const profile = options.userProfileMap?.get(userId);
  if (profile) return profile.label;
  return t("lib.activityFormat.user.fallback", { prefix: userId.slice(0, 5) });
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? t("lib.activityFormat.actor.agent");
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return t("lib.activityFormat.issueRef.fallback");
}

type EntityKind = "blocker" | "reviewer" | "approver";

function formatChangedEntityLabel(kind: EntityKind, labels: string[]): string {
  if (labels.length <= 0) return pluralLabelForKind(kind);
  if (labels.length === 1) {
    const singleKey = kind === "blocker"
      ? "lib.activityFormat.entity.blockerSingle"
      : kind === "reviewer"
        ? "lib.activityFormat.entity.reviewerSingle"
        : "lib.activityFormat.entity.approverSingle";
    return t(singleKey, { label: labels[0] });
  }
  const manyKey = kind === "blocker"
    ? "lib.activityFormat.entity.blockerMany"
    : kind === "reviewer"
      ? "lib.activityFormat.entity.reviewerMany"
      : "lib.activityFormat.entity.approverMany";
  return t(manyKey, { count: labels.length });
}

function pluralLabelForKind(kind: EntityKind): string {
  if (kind === "blocker") return t("lib.activityFormat.structured.blockersPlural");
  if (kind === "reviewer") return t("lib.activityFormat.entity.reviewerPlural");
  return t("lib.activityFormat.entity.approverPlural");
}

function formatIssueUpdatedVerb(details: ActivityDetails): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  if (details.status !== undefined) {
    const from = previous.status;
    return from
      ? t("lib.activityFormat.verbChange.statusFrom", { from: humanizeValue(from), to: humanizeValue(details.status) })
      : t("lib.activityFormat.verbChange.statusTo", { to: humanizeValue(details.status) });
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? t("lib.activityFormat.verbChange.priorityFrom", { from: humanizeValue(from), to: humanizeValue(details.priority) })
      : t("lib.activityFormat.verbChange.priorityTo", { to: humanizeValue(details.priority) });
  }
  return null;
}

function formatAssigneeName(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const agentId = details.assigneeAgentId;
  const userId = details.assigneeUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? t("lib.activityFormat.actor.agent");
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
    parts.push(
      from
        ? t("lib.activityFormat.actionChange.statusFrom", { from: humanizeValue(from), to: humanizeValue(details.status) })
        : t("lib.activityFormat.actionChange.statusTo", { to: humanizeValue(details.status) }),
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? t("lib.activityFormat.actionChange.priorityFrom", { from: humanizeValue(from), to: humanizeValue(details.priority) })
        : t("lib.activityFormat.actionChange.priorityTo", { to: humanizeValue(details.priority) }),
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    const assigneeName = formatAssigneeName(details, options);
    parts.push(
      assigneeName
        ? t("lib.activityFormat.actionChange.assignedTo", { name: assigneeName })
        : t("lib.activityFormat.actionChange.unassigned"),
    );
  }
  if (details.title !== undefined) parts.push(t("lib.activityFormat.actionChange.titleUpdated"));
  if (details.description !== undefined) parts.push(t("lib.activityFormat.actionChange.descriptionUpdated"));

  return parts.length > 0 ? parts.join(t("lib.activityFormat.actionChange.joiner")) : null;
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
      const changed = formatChangedEntityLabel("blocker", added);
      return input.forIssueDetail
        ? t("lib.activityFormat.structured.addedDetail", { changed })
        : t("lib.activityFormat.structured.addedTo", { changed });
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("blocker", removed);
      return input.forIssueDetail
        ? t("lib.activityFormat.structured.removedDetail", { changed })
        : t("lib.activityFormat.structured.removedFrom", { changed });
    }
    const plural = pluralLabelForKind("blocker");
    return input.forIssueDetail
      ? t("lib.activityFormat.structured.updatedDetail", { plural })
      : t("lib.activityFormat.structured.updatedOn", { plural });
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const kind: EntityKind = input.action === "issue.reviewers_updated" ? "reviewer" : "approver";
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(kind, added);
      return input.forIssueDetail
        ? t("lib.activityFormat.structured.addedDetail", { changed })
        : t("lib.activityFormat.structured.addedTo", { changed });
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(kind, removed);
      return input.forIssueDetail
        ? t("lib.activityFormat.structured.removedDetail", { changed })
        : t("lib.activityFormat.structured.removedFrom", { changed });
    }
    const plural = pluralLabelForKind(kind);
    return input.forIssueDetail
      ? t("lib.activityFormat.structured.updatedDetail", { plural })
      : t("lib.activityFormat.structured.updatedOn", { plural });
  }

  return null;
}

function resolveVerbFallback(action: string): string {
  const key = ACTIVITY_VERB_KEYS[action];
  if (key) return t(key);
  return action.replace(/[._]/g, " ");
}

function resolveLabelFallback(action: string): string {
  const key = ISSUE_ACTIVITY_LABEL_KEYS[action];
  if (key) return t(key);
  return action.replace(/[._]/g, " ");
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedVerb = formatIssueUpdatedVerb(details);
    if (issueUpdatedVerb) return issueUpdatedVerb;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: false,
  });
  if (structuredChange) return structuredChange;

  return resolveVerbFallback(action);
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

  if (action.startsWith("issue.monitor_") && details) {
    const serviceName = typeof details.serviceName === "string" && details.serviceName.trim()
      ? details.serviceName.trim()
      : null;
    const base = resolveLabelFallback(action);
    return serviceName
      ? t("lib.activityFormat.monitor.withService", { base, service: serviceName })
      : base;
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
    const key = typeof details.key === "string" ? details.key : "document";
    const base = resolveLabelFallback(action);
    if (typeof details.title === "string" && details.title) {
      return t("lib.activityFormat.document.withKeyAndTitle", { base, key, title: details.title });
    }
    return t("lib.activityFormat.document.withKey", { base, key });
  }

  return resolveLabelFallback(action);
}
