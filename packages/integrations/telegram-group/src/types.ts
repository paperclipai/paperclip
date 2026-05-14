export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export type IssuePriority = "critical" | "high" | "medium" | "low";

export type TopicStrategy = "root-issue-with-subtree";

export type BindingScope =
  | { kind: "company" }
  | { kind: "project"; projectId: string }
  | { kind: "goal"; goalId: string };

export interface TelegramGroupBinding {
  id: string;
  companyId: string;
  scope: BindingScope;
  chatId: number;
  botTokenRef: string;
  adminUserIds: string[];
  topicStrategy: TopicStrategy;
  redactInternalIds: boolean;
  status: "pending" | "active" | "error";
  createdAt: string;
  createdByUserId: string;
}

export interface TopicBinding {
  issueId: string;
  chatId: number;
  messageThreadId: number;
  createdAt: string;
  lastSyncedAt: string;
  statusSnapshot: IssueStatus;
}

export interface IssueRef {
  id: string;
  identifier: string;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  parentId: string | null;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
}

export type PlatformIssueEvent =
  | { type: "issue.created"; actorLabel: string; issue: IssueRef }
  | {
      type: "issue.status_changed";
      actorLabel: string;
      issue: IssueRef;
      from: IssueStatus;
      to: IssueStatus;
    }
  | {
      type: "issue.comment_created";
      actorLabel: string;
      issue: IssueRef;
      commentId: string;
      body: string;
    }
  | {
      type: "issue.assignee_changed";
      actorLabel: string;
      issue: IssueRef;
      toLabel: string;
    };
