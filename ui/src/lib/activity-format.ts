import type { Agent } from "@paperclipai/shared";
import { getCurrentLocale, translate, type MessageKey, type TranslationValues } from "@/i18n/runtime";

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
  locale?: string | null;
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

function activityMessage(
  key: string,
  fallback: string,
  options: ActivityFormatOptions,
  values?: TranslationValues,
): string {
  return translate(key as MessageKey, { locale: options.locale ?? getCurrentLocale(), fallback, values });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function activityNoun(key: string, fallback: string, options: ActivityFormatOptions): string {
  return activityMessage(key, fallback, options);
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

function formatUserLabel(userId: string | null | undefined, options: ActivityFormatOptions): string {
  if (!userId || userId === "local-board") return activityMessage("activity.actor.board", "Board", options);
  if (options.currentUserId && userId === options.currentUserId) return activityMessage("activity.actor.you", "You", options);
  return activityMessage("activity.actor.user", "user {{id}}", options, { id: userId.slice(0, 5) });
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? activityMessage("activity.actor.agent", "agent", options);
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference, options: ActivityFormatOptions): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return activityMessage("activity.entity.issue", "issue", options);
}

function formatChangedEntityLabel(
  kind: "blocker" | "reviewer" | "approver",
  labels: string[],
  options: ActivityFormatOptions,
): string {
  const fallbackPlural = kind === "blocker" ? "blockers" : `${kind}s`;
  if (labels.length <= 0) return activityNoun(`activity.noun.${kind}.plural`, fallbackPlural, options);
  if (labels.length === 1) {
    return activityMessage(`activity.changed.${kind}.single`, `${kind} {{label}}`, options, { label: labels[0] });
  }
  return activityMessage(`activity.changed.${kind}.multiple`, `{{count}} ${fallbackPlural}`, options, { count: labels.length });
}

function formatIssueUpdatedVerb(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  if (details.status !== undefined) {
    const from = previous.status;
    return from
      ? activityMessage("activity.verb.issue.updated.status.fromTo", "changed status from {{from}} to {{to}} on", options, {
        from: humanizeValue(from),
        to: humanizeValue(details.status),
      })
      : activityMessage("activity.verb.issue.updated.status.to", "changed status to {{to}} on", options, {
        to: humanizeValue(details.status),
      });
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? activityMessage("activity.verb.issue.updated.priority.fromTo", "changed priority from {{from}} to {{to}} on", options, {
        from: humanizeValue(from),
        to: humanizeValue(details.priority),
      })
      : activityMessage("activity.verb.issue.updated.priority.to", "changed priority to {{to}} on", options, {
        to: humanizeValue(details.priority),
      });
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  if (details.status !== undefined) {
    const from = previous.status;
    parts.push(
      from
        ? activityMessage("activity.action.issue.updated.status.fromTo", "changed the status from {{from}} to {{to}}", options, {
          from: humanizeValue(from),
          to: humanizeValue(details.status),
        })
        : activityMessage("activity.action.issue.updated.status.to", "changed the status to {{to}}", options, {
          to: humanizeValue(details.status),
        }),
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? activityMessage("activity.action.issue.updated.priority.fromTo", "changed the priority from {{from}} to {{to}}", options, {
          from: humanizeValue(from),
          to: humanizeValue(details.priority),
        })
        : activityMessage("activity.action.issue.updated.priority.to", "changed the priority to {{to}}", options, {
          to: humanizeValue(details.priority),
        }),
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    parts.push(
      details.assigneeAgentId || details.assigneeUserId
        ? activityMessage("activity.action.issue.updated.assigned", "assigned the issue", options)
        : activityMessage("activity.action.issue.updated.unassigned", "unassigned the issue", options),
    );
  }
  if (details.title !== undefined) parts.push(activityMessage("activity.action.issue.updated.title", "updated the title", options));
  if (details.description !== undefined) parts.push(activityMessage("activity.action.issue.updated.description", "updated the description", options));

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
    const added = readIssueReferences(details, "addedBlockedByIssues").map((reference) => formatIssueReferenceLabel(reference, input.options));
    const removed = readIssueReferences(details, "removedBlockedByIssues").map((reference) => formatIssueReferenceLabel(reference, input.options));
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel("blocker", added, input.options);
      return input.forIssueDetail
        ? activityMessage("activity.action.issue.blockers_updated.added", "added {{changed}}", input.options, { changed })
        : activityMessage("activity.verb.issue.blockers_updated.added", "added {{changed}} to", input.options, { changed });
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("blocker", removed, input.options);
      return input.forIssueDetail
        ? activityMessage("activity.action.issue.blockers_updated.removed", "removed {{changed}}", input.options, { changed })
        : activityMessage("activity.verb.issue.blockers_updated.removed", "removed {{changed}} from", input.options, { changed });
    }
    return input.forIssueDetail
      ? activityMessage("activity.action.issue.blockers_updated.updated", "updated blockers", input.options)
      : activityMessage("activity.verb.issue.blockers_updated.updated", "updated blockers on", input.options);
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(input.action === "issue.reviewers_updated" ? "reviewer" : "approver", added, input.options);
      return input.forIssueDetail
        ? activityMessage(`activity.action.${input.action}.added`, "added {{changed}}", input.options, { changed })
        : activityMessage(`activity.verb.${input.action}.added`, "added {{changed}} to", input.options, { changed });
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(input.action === "issue.reviewers_updated" ? "reviewer" : "approver", removed, input.options);
      return input.forIssueDetail
        ? activityMessage(`activity.action.${input.action}.removed`, "removed {{changed}}", input.options, { changed })
        : activityMessage(`activity.verb.${input.action}.removed`, "removed {{changed}} from", input.options, { changed });
    }
    return input.forIssueDetail
      ? activityMessage(`activity.action.${input.action}.updated`, input.action === "issue.reviewers_updated" ? "updated reviewers" : "updated approvers", input.options)
      : activityMessage(`activity.verb.${input.action}.updated`, input.action === "issue.reviewers_updated" ? "updated reviewers on" : "updated approvers on", input.options);
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

  return activityMessage(`activity.verb.${action}`, ACTIVITY_ROW_VERBS[action] ?? action.replace(/[._]/g, " "), options);
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
    const label = activityMessage(`activity.action.${action}`, ISSUE_ACTIVITY_LABELS[action] ?? action, options);
    return `${label} ${key}${title}`;
  }

  return activityMessage(`activity.action.${action}`, ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " "), options);
}
