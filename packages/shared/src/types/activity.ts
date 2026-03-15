import type { IssuePriority, IssueStatus } from "../constants.js";

export interface ActivityEvent {
  id: string;
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export interface MentionEntry {
  issueId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  mentionedAt: string;
  commentId: string | null;
  isUnread: boolean;
}
