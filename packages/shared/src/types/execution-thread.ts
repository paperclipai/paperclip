export interface ExecutionThreadIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  parentId: string | null;
  assigneeAgentId: string | null;
  createdAt: string;
}

export type ExecutionThreadEntryKind =
  | "issue_created"
  | "status_change"
  | "assignment_change"
  | "comment"
  | "blocker_added"
  | "blocker_removed"
  | "issue_updated";

export interface ExecutionThreadEntry {
  id: string;
  kind: ExecutionThreadEntryKind;
  issueId: string;
  issueIdentifier: string | null;
  actorType: "agent" | "user" | "system";
  actorId: string;
  timestamp: string;
  commentBody?: string;
  statusFrom?: string | null;
  statusTo?: string | null;
  assigneeFrom?: string | null;
  assigneeTo?: string | null;
  blockerIssueId?: string | null;
  blockerIssueIdentifier?: string | null;
  details?: Record<string, unknown> | null;
}

export interface ExecutionThreadResponse {
  rootIssueId: string;
  rootIssueIdentifier: string | null;
  issues: ExecutionThreadIssueSummary[];
  entries: ExecutionThreadEntry[];
  truncated: boolean;
}
