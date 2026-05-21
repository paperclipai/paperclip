import type { Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "./company-members";
import {
  activityVerbs,
  activityLabels,
  activityChangeLabels,
  formatIssueStatus,
  formatPriorityLabel,
  formatCommonApiSlugZh,
} from "./i18n";

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

const ACTIVITY_ROW_VERBS: Record<string, string> = activityVerbs;

const ISSUE_ACTIVITY_LABELS: Record<string, string> = activityLabels;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeActivityField(field: "status" | "priority" | "generic", value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return field === "generic" ? "无" : String(value ?? "无");
  }
  if (field === "status") return formatIssueStatus(value);
  if (field === "priority") return formatPriorityLabel(value);
  const mapped = formatCommonApiSlugZh(value);
  if (mapped !== value) return mapped;
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
  if (!userId || userId === "local-board") return activityChangeLabels.board;
  if (options.currentUserId && userId === options.currentUserId) return activityChangeLabels.you;
  const profile = options.userProfileMap?.get(userId);
  if (profile) return profile.label;
  return `${activityChangeLabels.issue} ${userId.slice(0, 5)}`;
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? activityChangeLabels.agent;
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return translateIssueTitle(reference.title);
  if (reference.id) return reference.id.slice(0, 8);
  return activityChangeLabels.issue;
}

/** 将常见系统生成的 issue 标题映射为中文 */
function translateIssueTitle(title: string): string {
  if (title.startsWith("Recover missing next step")) {
    return title.replace("Recover missing next step", "恢复缺失下一步");
  }
  return title;
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

function formatChangedEntityLabelRemove(
  singular: string,
  plural: string,
  labels: string[],
): string {
  if (labels.length <= 0) return plural;
  if (labels.length === 1) return `${singular} ${labels[0]}`;
  return `${labels.length} ${plural}`;
}

function formatIssueUpdatedVerb(details: ActivityDetails): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  if (details.status !== undefined) {
    const from = previous.status;
    return from
      ? activityChangeLabels.changedStatusFrom(
          humanizeActivityField("status", from),
          humanizeActivityField("status", details.status),
        )
      : activityChangeLabels.changedStatusTo(humanizeActivityField("status", details.status));
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? activityChangeLabels.changedPriorityFrom(
          humanizeActivityField("priority", from),
          humanizeActivityField("priority", details.priority),
        )
      : activityChangeLabels.changedPriorityTo(humanizeActivityField("priority", details.priority));
  }
  return null;
}

function formatAssigneeName(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const agentId = details.assigneeAgentId;
  const userId = details.assigneeUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? activityChangeLabels.agent;
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
        ? activityChangeLabels.changedTheStatusFrom(
            humanizeActivityField("status", from),
            humanizeActivityField("status", details.status),
          )
        : activityChangeLabels.changedTheStatusTo(humanizeActivityField("status", details.status)),
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? activityChangeLabels.changedThePriorityFrom(
            humanizeActivityField("priority", from),
            humanizeActivityField("priority", details.priority),
          )
        : activityChangeLabels.changedThePriorityTo(humanizeActivityField("priority", details.priority)),
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    const assigneeName = formatAssigneeName(details, options);
    parts.push(assigneeName ? activityChangeLabels.assignedTo(assigneeName) : activityChangeLabels.unassigned);
  }
  if (details.title !== undefined) parts.push(activityChangeLabels.updatedTitle);
  if (details.description !== undefined) parts.push(activityChangeLabels.updatedDescription);

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
    const added = readIssueReferences(details, "addedBlockedByIssues").map(formatIssueReferenceLabel);
    const removed = readIssueReferences(details, "removedBlockedByIssues").map(formatIssueReferenceLabel);
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(activityChangeLabels.blocker, activityChangeLabels.blockers, added);
      return input.forIssueDetail ? `${activityChangeLabels.added} ${changed}` : `${activityChangeLabels.added} ${changed} 于`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabelRemove(activityChangeLabels.blocker, activityChangeLabels.blockers, removed);
      return input.forIssueDetail ? `${activityChangeLabels.removed} ${changed}` : `${activityChangeLabels.removed} ${changed} 于`;
    }
    return input.forIssueDetail ? `更新了 ${activityChangeLabels.blockers}` : `更新了 ${activityChangeLabels.blockers} 于`;
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const singular = input.action === "issue.reviewers_updated" ? activityChangeLabels.reviewer : activityChangeLabels.approver;
    const plural = input.action === "issue.reviewers_updated" ? activityChangeLabels.reviewers : activityChangeLabels.approvers;
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, added);
      return input.forIssueDetail ? `${activityChangeLabels.added} ${changed}` : `${activityChangeLabels.added} ${changed} 于`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabelRemove(singular, plural, removed);
      return input.forIssueDetail ? `${activityChangeLabels.removed} ${changed}` : `${activityChangeLabels.removed} ${changed} 于`;
    }
    return input.forIssueDetail ? `更新了 ${plural}` : `更新了 ${plural} 于`;
  }

  return null;
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
    return serviceName ? `${base} for ${serviceName}` : base;
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
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ISSUE_ACTIVITY_LABELS[action] ?? action} ${key}${title}`;
  }

  return ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
}
