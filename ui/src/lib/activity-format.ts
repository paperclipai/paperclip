import type { Agent } from "@paperclipai/shared";
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
  t?: (key: string, options?: any) => string;
}

const ACTIVITY_ROW_VERBS: Record<string, string> = {
  "issue.created": "created",
  "issue.updated": "updated",
  "issue.checked_out": "checked out",
  "issue.released": "released",
  "issue.comment_added": "commented on",
  "issue.comment_cancelled": "cancelled a queued comment on",
  "issue.attachment_added": "attached file to",
  "issue.attachment_removed": "removed attachment from",
  "issue.document_created": "created document for",
  "issue.document_updated": "updated document on",
  "issue.document_deleted": "deleted document from",
  "issue.monitor_scheduled": "scheduled monitor on",
  "issue.monitor_triggered": "triggered monitor for",
  "issue.monitor_cleared": "cleared monitor on",
  "issue.monitor_skipped": "skipped monitor for",
  "issue.monitor_exhausted": "exhausted monitor on",
  "issue.monitor_recovery_wake_queued": "queued monitor recovery for",
  "issue.monitor_recovery_issue_created": "created monitor recovery for",
  "issue.monitor_escalated_to_board": "escalated monitor for",
  "issue.commented": "commented on",
  "issue.deleted": "deleted",
  "issue.successful_run_handoff_required": "flagged missing next step on",
  "issue.successful_run_handoff_resolved": "recorded next step chosen on",
  "issue.successful_run_handoff_escalated": "escalated missing next step on",
  "issue.recovery_action_opened": "opened a recovery action on",
  "issue.recovery_action_resolved": "resolved the recovery action on",
  "issue.recovery_action_escalated": "escalated the recovery action on",
  "agent.created": "created",
  "agent.updated": "updated",
  "agent.paused": "paused",
  "agent.resumed": "resumed",
  "agent.terminated": "terminated",
  "agent.key_created": "created API key for",
  "agent.budget_updated": "updated budget for",
  "agent.runtime_session_reset": "reset session for",
  "heartbeat.invoked": "invoked heartbeat for",
  "heartbeat.cancelled": "cancelled heartbeat for",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "project.created": "created",
  "project.updated": "updated",
  "project.deleted": "deleted",
  "goal.created": "created",
  "goal.updated": "updated",
  "goal.deleted": "deleted",
  "cost.reported": "reported cost for",
  "cost.recorded": "recorded cost for",
  "company.created": "created company",
  "company.updated": "updated company",
  "company.archived": "archived",
  "company.budget_updated": "updated budget for",
};

const ISSUE_ACTIVITY_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.comment_cancelled": "cancelled a queued comment",
  "issue.feedback_vote_saved": "saved feedback on an AI output",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.document_created": "created a document",
  "issue.document_updated": "updated a document",
  "issue.document_deleted": "deleted a document",
  "issue.monitor_scheduled": "scheduled a monitor",
  "issue.monitor_triggered": "triggered a monitor",
  "issue.monitor_cleared": "cleared a monitor",
  "issue.monitor_skipped": "skipped a monitor",
  "issue.monitor_exhausted": "exhausted a monitor",
  "issue.monitor_recovery_wake_queued": "queued a monitor recovery wake",
  "issue.monitor_recovery_issue_created": "created a monitor recovery issue",
  "issue.monitor_escalated_to_board": "escalated a monitor to the board",
  "issue.deleted": "deleted the issue",
  "issue.successful_run_handoff_required": "Run finished without a clear next step",
  "issue.successful_run_handoff_resolved": "Next step chosen",
  "issue.successful_run_handoff_escalated": "Run finished without a next step - recovery escalated",
  "issue.recovery_action_opened": "Opened a source-scoped recovery action",
  "issue.recovery_action_resolved": "Resolved the recovery action",
  "issue.recovery_action_escalated": "Escalated the recovery action",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
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
  if (!userId || userId === "local-board") return options.t ? options.t('activity.board') : "Board";
  if (options.currentUserId && userId === options.currentUserId) return options.t ? options.t('common.you') : "You";
  const profile = options.userProfileMap?.get(userId);
  if (profile) return profile.label;
  const userPrefix = options.t ? options.t('activity.user') : "user";
  return `${userPrefix} ${userId.slice(0, 5)}`;
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? (options.t ? options.t('sidebar.agent') : "agent");
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference, options: ActivityFormatOptions = {}): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return options.t ? options.t('sidebar.issue') : "issue";
}

function formatChangedEntityLabel(
  singular: string,
  plural: string,
  labels: string[],
): string {
  if (labels.length <= 0) return plural;
  if (labels.length === 1) return `${singular} ${labels[0]}`;
  return `${labels.length} ${plural}`;
}

function formatIssueUpdatedVerb(details: ActivityDetails, options: ActivityFormatOptions = {}): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const t = options.t;
  if (details.status !== undefined) {
    const from = previous.status;
    const to = details.status;
    if (t) {
      return from
        ? t('activity.verbs.changedStatusFromTo', { from: humanizeValue(from), to: humanizeValue(to) })
        : t('activity.verbs.changedStatusTo', { to: humanizeValue(to) });
    }
    return from ? `changed status from ${humanizeValue(from)} to ${humanizeValue(to)}` : `changed status to ${humanizeValue(to)}`;
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    const to = details.priority;
    if (t) {
      return from
        ? t('activity.verbs.changedPriorityFromTo', { from: humanizeValue(from), to: humanizeValue(to) })
        : t('activity.verbs.changedPriorityTo', { to: humanizeValue(to) });
    }
    return from ? `changed priority from ${humanizeValue(from)} to ${humanizeValue(to)}` : `changed priority to ${humanizeValue(to)}`;
  }
  return null;
}

function formatAssigneeName(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const agentId = details.assigneeAgentId;
  const userId = details.assigneeUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? (options.t ? options.t('sidebar.agent') : "agent");
  }
  if (typeof userId === "string" && userId) {
    return formatUserLabel(userId, options);
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails, options: ActivityFormatOptions = {}): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const t = options.t;
  const parts: string[] = [];

  if (details.status !== undefined) {
    const from = previous.status;
    const to = details.status;
    if (t) {
      parts.push(
        from
          ? t('activity.verbs.changedStatusFromTo', { from: humanizeValue(from), to: humanizeValue(to) })
          : t('activity.verbs.changedStatusTo', { to: humanizeValue(to) }),
      );
    } else {
      parts.push(from ? `changed status from ${humanizeValue(from)} to ${humanizeValue(to)}` : `changed status to ${humanizeValue(to)}`);
    }
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    const to = details.priority;
    if (t) {
      parts.push(
        from
          ? t('activity.verbs.changedPriorityFromTo', { from: humanizeValue(from), to: humanizeValue(to) })
          : t('activity.verbs.changedPriorityTo', { to: humanizeValue(to) }),
      );
    } else {
      parts.push(from ? `changed priority from ${humanizeValue(from)} to ${humanizeValue(to)}` : `changed priority to ${humanizeValue(to)}`);
    }
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    const assigneeName = formatAssigneeName(details, options);
    if (t) {
      parts.push(assigneeName ? t('activity.verbs.assignedTo', { name: assigneeName }) : t('activity.verbs.unassigned'));
    } else {
      parts.push(assigneeName ? `assigned to ${assigneeName}` : "unassigned");
    }
  }
  if (details.title !== undefined) parts.push(t ? t('activity.verbs.updatedTitle') : "updated title");
  if (details.description !== undefined) parts.push(t ? t('activity.verbs.updatedDescription') : "updated description");

  return parts.length > 0 ? parts.join(", ") : null;
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
    const added = readIssueReferences(details, "addedBlockedByIssues").map((ref) => formatIssueReferenceLabel(ref, input.options));
    const removed = readIssueReferences(details, "removedBlockedByIssues").map((ref) => formatIssueReferenceLabel(ref, input.options));
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(input.options.t ? input.options.t('activity.blocker') : "blocker", input.options.t ? input.options.t('activity.blockers') : "blockers", added);
      return input.forIssueDetail ? (input.options.t ? input.options.t('activity.verbs.added', { entity: changed }) : `added ${changed}`) : (input.options.t ? input.options.t('activity.verbs.addedTo', { entity: changed }) : `added ${changed} to`);
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(input.options.t ? input.options.t('activity.blocker') : "blocker", input.options.t ? input.options.t('activity.blockers') : "blockers", removed);
      return input.forIssueDetail ? (input.options.t ? input.options.t('activity.verbs.removed', { entity: changed }) : `removed ${changed}`) : (input.options.t ? input.options.t('activity.verbs.removedFrom', { entity: changed }) : `removed ${changed} from`);
    }
    return input.forIssueDetail ? (input.options.t ? input.options.t('activity.verbs.updatedBlockers') : "updated blockers") : (input.options.t ? input.options.t('activity.verbs.updatedBlockersOn') : "updated blockers on");
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const singular = input.action === "issue.reviewers_updated" ? (input.options.t ? input.options.t('activity.reviewer') : "reviewer") : (input.options.t ? input.options.t('activity.approver') : "approver");
    const plural = input.action === "issue.reviewers_updated" ? (input.options.t ? input.options.t('activity.reviewers') : "reviewers") : (input.options.t ? input.options.t('activity.approvers') : "approvers");
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, added);
      return input.forIssueDetail ? (input.options.t ? input.options.t('activity.verbs.added', { entity: changed }) : `added ${changed}`) : (input.options.t ? input.options.t('activity.verbs.addedTo', { entity: changed }) : `added ${changed} to`);
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, removed);
      return input.forIssueDetail ? (input.options.t ? input.options.t('activity.verbs.removed', { entity: changed }) : `removed ${changed}`) : (input.options.t ? input.options.t('activity.verbs.removedFrom', { entity: changed }) : `removed ${changed} from`);
    }
    return input.forIssueDetail ? (input.options.t ? input.options.t('activity.verbs.updatedEntity', { entity: plural }) : `updated ${plural}`) : (input.options.t ? input.options.t('activity.verbs.updatedEntityOn', { entity: plural }) : `updated ${plural} on`);
  }

  return null;
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedVerb = formatIssueUpdatedVerb(details, options);
    if (issueUpdatedVerb) return issueUpdatedVerb;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: false,
  });
  if (structuredChange) return structuredChange;

  if (options.t) {
    const key = `activity.verbs.${action}`;
    const translated = options.t(key, { defaultValue: "" });
    if (translated) return translated;
  }

  return ACTIVITY_ROW_VERBS[action] ?? action.replace(/[._]/g, " ");
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
    const base = ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
    if (serviceName) {
      return options.t
        ? options.t("activity.labels.issue.monitor_for", { base, serviceName, defaultValue: `${base} for ${serviceName}` })
        : `${base} for ${serviceName}`;
    }
    return base;
  }

  if (
    (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted") &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ISSUE_ACTIVITY_LABELS[action] ?? action} ${key}${title}`;
  }

  if (options.t) {
    const key = `activity.labels.${action}`;
    const translated = options.t(key, { defaultValue: "" });
    if (translated) {
       // handle dynamic labels with details if needed
       return translated;
    }
  }

  return ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
}
