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

type TranslateFn = (key: string, params?: Record<string, string | number | null | undefined>) => string;

interface ActivityFormatOptions {
  agentMap?: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  currentUserId?: string | null;
  t?: TranslateFn;
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
  "issue.commented": "commented on",
  "issue.blockers_updated": "updated blockers on",
  "issue.blockers.updated": "updated blockers on",
  "issue.reviewers_updated": "updated reviewers on",
  "issue.approvers_updated": "updated approvers on",
  "issue.deleted": "deleted",
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

const ACTIVITY_ROW_VERB_KEYS: Record<string, string> = {
  "issue.updated": "activity.verb.issueUpdated",
  "issue.comment_added": "activity.verb.issueCommentedOn",
  "issue.commented": "activity.verb.issueCommentedOn",
  "issue.blockers_updated": "activity.verb.issueBlockersUpdated",
  "issue.blockers.updated": "activity.verb.issueBlockersUpdated",
  "issue.reviewers_updated": "activity.verb.issueReviewersUpdated",
  "issue.approvers_updated": "activity.verb.issueApproversUpdated",
  "agent.created": "activity.verb.agentCreated",
  "agent.updated": "activity.verb.agentUpdated",
  "agent.deleted": "activity.verb.agentDeleted",
  "agent.terminated": "activity.verb.agentDeleted",
  "agent.key_created": "activity.verb.agentKeyCreated",
  "agent.key.created": "activity.verb.agentKeyCreated",
  "agent.key_revoked": "activity.verb.agentKeyRevoked",
  "agent.key.revoked": "activity.verb.agentKeyRevoked",
  "agent.paused": "activity.verb.agentPaused",
  "agent.resumed": "activity.verb.agentResumed",
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
  "issue.deleted": "deleted the issue",
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

function translated(options: ActivityFormatOptions, key: string, fallback: string, params?: Record<string, string | number | null | undefined>): string {
  const value = options.t?.(key, params);
  return value && value !== key ? value : fallback;
}

function humanizeValue(value: unknown, options: ActivityFormatOptions = {}): string {
  if (typeof value !== "string") return String(value ?? "none");
  if (options.t) {
    const labelMap: Record<string, string> = {
      backlog: translated(options, "status.backlog", "backlog"),
      todo: translated(options, "status.todo", "todo"),
      in_progress: translated(options, "status.inProgress", "in progress"),
      in_review: translated(options, "status.inReview", "in review"),
      done: translated(options, "status.done", "done"),
      cancelled: translated(options, "status.cancelled", "cancelled"),
      blocked: translated(options, "status.blocked", "blocked"),
      critical: translated(options, "chart.priority.critical", "Critical"),
      high: translated(options, "chart.priority.high", "High"),
      medium: translated(options, "chart.priority.medium", "Medium"),
      low: translated(options, "chart.priority.low", "Low"),
    };
    if (labelMap[value]) return labelMap[value];
  }
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
  if (!userId || userId === "local-board") return "Board";
  if (options.currentUserId && userId === options.currentUserId) return "You";
  const profile = options.userProfileMap?.get(userId);
  if (profile) return profile.label;
  return `user ${userId.slice(0, 5)}`;
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? "agent";
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return "issue";
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
  if (details.status !== undefined) {
    const from = previous.status;
    return from
      ? translated(options, "activity.verb.changedStatusFrom", `changed status from ${humanizeValue(from)} to ${humanizeValue(details.status)} on`, {
          from: humanizeValue(from, options),
          to: humanizeValue(details.status, options),
        })
      : translated(options, "activity.verb.changedStatusTo", `changed status to ${humanizeValue(details.status)} on`, {
          to: humanizeValue(details.status, options),
        });
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? translated(options, "activity.verb.changedPriorityFrom", `changed priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)} on`, {
          from: humanizeValue(from, options),
          to: humanizeValue(details.priority, options),
        })
      : translated(options, "activity.verb.changedPriorityTo", `changed priority to ${humanizeValue(details.priority)} on`, {
          to: humanizeValue(details.priority, options),
        });
  }
  return null;
}

function formatAssigneeName(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const agentId = details.assigneeAgentId;
  const userId = details.assigneeUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? "agent";
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
        ? `changed the status from ${humanizeValue(from, options)} to ${humanizeValue(details.status, options)}`
        : `changed the status to ${humanizeValue(details.status, options)}`,
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? `changed the priority from ${humanizeValue(from, options)} to ${humanizeValue(details.priority, options)}`
        : `changed the priority to ${humanizeValue(details.priority, options)}`,
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    const assigneeName = formatAssigneeName(details, options);
    parts.push(assigneeName ? `assigned the issue to ${assigneeName}` : "unassigned the issue");
  }
  if (details.title !== undefined) parts.push("updated the title");
  if (details.description !== undefined) parts.push("updated the description");

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

  if (input.options.t && !input.forIssueDetail) {
    if (input.action === "issue.blockers_updated" || input.action === "issue.blockers.updated") {
      return translated(input.options, "activity.verb.issueBlockersUpdated", "updated blockers on");
    }
    if (input.action === "issue.reviewers_updated") return translated(input.options, "activity.verb.issueReviewersUpdated", "updated reviewers on");
    if (input.action === "issue.approvers_updated") return translated(input.options, "activity.verb.issueApproversUpdated", "updated approvers on");
  }

  if (input.action === "issue.blockers_updated" || input.action === "issue.blockers.updated") {
    const added = readIssueReferences(details, "addedBlockedByIssues").map(formatIssueReferenceLabel);
    const removed = readIssueReferences(details, "removedBlockedByIssues").map(formatIssueReferenceLabel);
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", added);
      return input.forIssueDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", removed);
      return input.forIssueDetail ? `removed ${changed}` : `removed ${changed} from`;
    }
    return input.forIssueDetail ? "updated blockers" : "updated blockers on";
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const singular = input.action === "issue.reviewers_updated" ? "reviewer" : "approver";
    const plural = input.action === "issue.reviewers_updated" ? "reviewers" : "approvers";
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, added);
      return input.forIssueDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, removed);
      return input.forIssueDetail ? `removed ${changed}` : `removed ${changed} from`;
    }
    return input.forIssueDetail ? `updated ${plural}` : `updated ${plural} on`;
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

  const fallback = ACTIVITY_ROW_VERBS[action] ?? action.replace(/[._]/g, " ");
  const key = ACTIVITY_ROW_VERB_KEYS[action];
  return key ? translated(options, key, fallback) : fallback;
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

  if (
    (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted") &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ISSUE_ACTIVITY_LABELS[action] ?? action} ${key}${title}`;
  }

  return ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
}
