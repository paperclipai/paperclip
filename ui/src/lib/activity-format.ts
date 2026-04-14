import type { Agent } from "@paperclipai/shared";
import { createTranslator } from "../../../packages/shared/src/i18n.js";
import { getCurrentLocale } from "./locale-store";

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
  currentUserId?: string | null;
}

const ACTIVITY_ROW_VERBS = {
  "issue.created": "activity.created",
  "issue.updated": "activity.updated",
  "issue.checked_out": "activity.checkedOut",
  "issue.released": "activity.released",
  "issue.comment_added": "activity.commentedOn",
  "issue.comment_cancelled": "activity.cancelledQueuedCommentOn",
  "issue.attachment_added": "activity.attachedFileTo",
  "issue.attachment_removed": "activity.removedAttachmentFrom",
  "issue.document_created": "activity.createdDocumentFor",
  "issue.document_updated": "activity.updatedDocumentOn",
  "issue.document_deleted": "activity.deletedDocumentFrom",
  "issue.commented": "activity.commentedOn",
  "issue.deleted": "activity.deleted",
  "agent.created": "activity.created",
  "agent.updated": "activity.updated",
  "agent.paused": "activity.paused",
  "agent.resumed": "activity.resumed",
  "agent.terminated": "activity.terminated",
  "agent.key_created": "activity.createdApiKeyFor",
  "agent.budget_updated": "activity.updatedBudgetFor",
  "agent.runtime_session_reset": "activity.resetSessionFor",
  "heartbeat.invoked": "activity.invokedHeartbeatFor",
  "heartbeat.cancelled": "activity.cancelledHeartbeatFor",
  "approval.created": "activity.requestedApproval",
  "approval.approved": "activity.approved",
  "approval.rejected": "activity.rejected",
  "project.created": "activity.created",
  "project.updated": "activity.updated",
  "project.deleted": "activity.deleted",
  "goal.created": "activity.created",
  "goal.updated": "activity.updated",
  "goal.deleted": "activity.deleted",
  "cost.reported": "activity.reportedCostFor",
  "cost.recorded": "activity.recordedCostFor",
  "company.created": "activity.createdCompany",
  "company.updated": "activity.updatedCompany",
  "company.archived": "activity.archived",
  "company.budget_updated": "activity.updatedBudgetFor",
} as const;

const ISSUE_ACTIVITY_LABELS = {
  "issue.created": "activity.createdTheIssue",
  "issue.updated": "activity.updatedTheIssue",
  "issue.checked_out": "activity.checkedOutTheIssue",
  "issue.released": "activity.releasedTheIssue",
  "issue.comment_added": "activity.addedComment",
  "issue.comment_cancelled": "activity.cancelledQueuedComment",
  "issue.feedback_vote_saved": "activity.savedFeedbackOnAiOutput",
  "issue.attachment_added": "activity.addedAttachment",
  "issue.attachment_removed": "activity.removedAttachment",
  "issue.document_created": "activity.createdDocument",
  "issue.document_updated": "activity.updatedDocument",
  "issue.document_deleted": "activity.deletedDocument",
  "issue.deleted": "activity.deletedTheIssue",
  "agent.created": "activity.createdAgent",
  "agent.updated": "activity.updatedAgent",
  "agent.paused": "activity.pausedAgent",
  "agent.resumed": "activity.resumedAgent",
  "agent.terminated": "activity.terminatedAgent",
  "heartbeat.invoked": "activity.invokedHeartbeat",
  "heartbeat.cancelled": "activity.cancelledHeartbeat",
  "approval.created": "activity.requestedApproval",
  "approval.approved": "activity.approved",
  "approval.rejected": "activity.rejected",
} as const;

function getActivityTranslator() {
  return createTranslator(getCurrentLocale()).t;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown): string {
  const t = getActivityTranslator();
  if (typeof value !== "string") return String(value ?? t("common.none"));
  switch (value) {
    case "backlog":
      return t("issue.statusBacklog");
    case "todo":
      return t("issue.statusTodo");
    case "in_progress":
      return t("issue.statusInProgress");
    case "in_review":
      return t("issue.statusInReview");
    case "done":
      return t("issue.statusDone");
    case "critical":
      return t("issue.priorityCritical");
    case "high":
      return t("issue.priorityHigh");
    case "medium":
      return t("issue.priorityMedium");
    case "low":
      return t("issue.priorityLow");
    default:
      return value.replace(/_/g, " ");
  }
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

function formatUserLabel(userId: string | null | undefined, currentUserId?: string | null): string {
  const t = getActivityTranslator();
  if (!userId || userId === "local-board") return t("common.board");
  if (currentUserId && userId === currentUserId) return t("common.you");
  return t("activity.userLabel", { id: userId.slice(0, 5) });
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  const t = getActivityTranslator();
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? t("common.agent");
  }
  return formatUserLabel(participant.userId, options.currentUserId);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  const t = getActivityTranslator();
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return t("activity.issueEntity");
}

function formatChangedEntityLabel(
  singularKey: "activity.blocker" | "activity.reviewer" | "activity.approver",
  pluralKey: "activity.blockers" | "activity.reviewers" | "activity.approvers",
  labels: string[],
): string {
  const t = getActivityTranslator();
  if (labels.length <= 0) return t(pluralKey);
  if (labels.length === 1) {
    return t("activity.namedEntity", {
      entity: t(singularKey),
      label: labels[0],
    });
  }
  return t("activity.countedEntity", {
    count: labels.length,
    entity: t(pluralKey),
  });
}

function formatIssueUpdatedVerb(details: ActivityDetails): string | null {
  const t = getActivityTranslator();
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  if (details.status !== undefined) {
    const from = previous.status;
    return from
      ? t("activity.changedStatusFromToOn", {
          from: humanizeValue(from),
          to: humanizeValue(details.status),
        })
      : t("activity.changedStatusToOn", { to: humanizeValue(details.status) });
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? t("activity.changedPriorityFromToOn", {
          from: humanizeValue(from),
          to: humanizeValue(details.priority),
        })
      : t("activity.changedPriorityToOn", { to: humanizeValue(details.priority) });
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails): string | null {
  const t = getActivityTranslator();
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  if (details.status !== undefined) {
    const from = previous.status;
    parts.push(
      from
        ? t("activity.changedTheStatusFromTo", {
            from: humanizeValue(from),
            to: humanizeValue(details.status),
          })
        : t("activity.changedTheStatusTo", { to: humanizeValue(details.status) }),
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? t("activity.changedThePriorityFromTo", {
            from: humanizeValue(from),
            to: humanizeValue(details.priority),
          })
        : t("activity.changedThePriorityTo", { to: humanizeValue(details.priority) }),
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    parts.push(t(details.assigneeAgentId || details.assigneeUserId ? "activity.assignedIssue" : "activity.unassignedIssue"));
  }
  if (details.title !== undefined) parts.push(t("activity.updatedTitle"));
  if (details.description !== undefined) parts.push(t("activity.updatedDescription"));

  return parts.length > 0 ? parts.join(", ") : null;
}

function formatStructuredIssueChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
  forIssueDetail: boolean;
}): string | null {
  const t = getActivityTranslator();
  const details = input.details;
  if (!details) return null;

  if (input.action === "issue.blockers_updated") {
    const added = readIssueReferences(details, "addedBlockedByIssues").map(formatIssueReferenceLabel);
    const removed = readIssueReferences(details, "removedBlockedByIssues").map(formatIssueReferenceLabel);
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel("activity.blocker", "activity.blockers", added);
      return input.forIssueDetail ? t("activity.addedEntity", { entity: changed }) : t("activity.addedEntityTo", { entity: changed });
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("activity.blocker", "activity.blockers", removed);
      return input.forIssueDetail ? t("activity.removedEntity", { entity: changed }) : t("activity.removedEntityFrom", { entity: changed });
    }
    return input.forIssueDetail ? t("activity.updatedBlockers") : t("activity.updatedBlockersOn");
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const singular = input.action === "issue.reviewers_updated" ? "activity.reviewer" : "activity.approver";
    const plural = input.action === "issue.reviewers_updated" ? "activity.reviewers" : "activity.approvers";
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, added);
      return input.forIssueDetail ? t("activity.addedEntity", { entity: changed }) : t("activity.addedEntityTo", { entity: changed });
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, removed);
      return input.forIssueDetail ? t("activity.removedEntity", { entity: changed }) : t("activity.removedEntityFrom", { entity: changed });
    }
    if (input.action === "issue.reviewers_updated") {
      return input.forIssueDetail ? t("activity.updatedReviewers") : t("activity.updatedReviewersOn");
    }
    return input.forIssueDetail ? t("activity.updatedApprovers") : t("activity.updatedApproversOn");
  }

  return null;
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  const t = getActivityTranslator();
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

  const key = ACTIVITY_ROW_VERBS[action as keyof typeof ACTIVITY_ROW_VERBS];
  return key ? t(key) : action.replace(/[._]/g, " ");
}

export function formatIssueActivityAction(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  const t = getActivityTranslator();
  if (action === "issue.updated") {
    const issueUpdatedAction = formatIssueUpdatedAction(details);
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
    const actionLabelKey = ISSUE_ACTIVITY_LABELS[action as keyof typeof ISSUE_ACTIVITY_LABELS];
    const actionLabel = actionLabelKey ? t(actionLabelKey) : action;
    if (typeof details.title === "string" && details.title) {
      return t("activity.documentActionWithTitle", { action: actionLabel, key, title: details.title });
    }
    return t("activity.documentAction", { action: actionLabel, key });
  }

  const key = ISSUE_ACTIVITY_LABELS[action as keyof typeof ISSUE_ACTIVITY_LABELS];
  return key ? t(key) : action.replace(/[._]/g, " ");
}
