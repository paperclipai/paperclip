import type { Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "./company-members";

type ActivityDetails = Record<string, unknown> | null | undefined;

type ActivityParticipant = {
  type: "agent";
  id: string;
} | {
  type: "user";
  id: string;
} | {
  type: "system";
};

interface ActivityFormatOptions {
  agentMap?: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  currentUserId?: string | null;
  t?: (key: string, options?: Record<string, unknown> | string) => string;
  i18n?: { language: string };
}

const ISSUE_ACTIVITY_LABELS: Record<string, string> = {
  "issue.created": "created this issue",
  "issue.updated": "updated this issue",
  "issue.status_changed": "changed status to",
  "issue.priority_changed": "changed priority to",
  "issue.assignee_changed": "changed assignee to",
  "issue.project_changed": "changed project to",
  "issue.title_changed": "changed title",
  "issue.description_changed": "changed description",
  "issue.comment_added": "added a comment",
  "issue.comment_updated": "updated a comment",
  "issue.comment_deleted": "deleted a comment",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_deleted": "deleted an attachment",
  "issue.document_added": "added a document",
  "issue.document_updated": "updated a document",
  "issue.document_deleted": "deleted a document",
  "issue.goal_linked": "linked a goal",
  "issue.goal_unlinked": "unlinked a goal",
  "issue.parent_linked": "linked a parent issue",
  "issue.parent_unlinked": "unlinked a parent issue",
  "issue.sub_issue_linked": "linked a sub-issue",
  "issue.sub_issue_unlinked": "unlinked a sub-issue",
};

export function formatIssueActivityAction(
  action: string,
  details: ActivityDetails,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.status_changed" && details?.status) {
    const status = String(details.status);
    return `${ISSUE_ACTIVITY_LABELS[action]} ${status}`;
  }

  if (action === "issue.priority_changed" && details?.priority) {
    const priority = String(details.priority);
    return `${ISSUE_ACTIVITY_LABELS[action]} ${priority}`;
  }

  if (action === "issue.assignee_changed") {
    const agentId = details?.assigneeAgentId ? String(details.assigneeAgentId) : null;
    const userId = details?.assigneeUserId ? String(details.assigneeUserId) : null;

    if (agentId) {
      const agent = options.agentMap?.get(agentId);
      return `${ISSUE_ACTIVITY_LABELS[action]} ${agent?.name ?? agentId.slice(0, 8)}`;
    }
    if (userId) {
      if (options.currentUserId && userId === options.currentUserId) {
        return `${ISSUE_ACTIVITY_LABELS[action]} You`;
      }
      const profile = options.userProfileMap?.get(userId);
      return `${ISSUE_ACTIVITY_LABELS[action]} ${profile?.displayName ?? userId.slice(0, 8)}`;
    }
    return `${ISSUE_ACTIVITY_LABELS[action]} unassigned`;
  }

  if (action === "issue.project_changed" && details?.projectId) {
    const key = String(details.projectId).slice(0, 8);
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ISSUE_ACTIVITY_LABELS[action]} ${key}${title}`;
  }

  return ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
}
