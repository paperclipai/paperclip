import type { IssueComment } from "./issue.js";

export interface CopilotRouteContext {
  pageKind: string;
  pagePath: string;
  entityType?: string | null;
  entityId?: string | null;
  title?: string | null;
  filters?: Record<string, string>;
}

export interface CopilotThreadSummary {
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  issueStatus: string;
  issuePriority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  threadOwnerUserId: string | null;
  updatedAt: Date;
}

export interface CopilotThreadHistoryEntry extends CopilotThreadSummary {
  hiddenAt: Date | null;
}

export interface CopilotMessageCreateResponse {
  thread: CopilotThreadSummary;
  comment: IssueComment;
  wakeup: {
    enqueued: boolean;
    warning: string | null;
  };
}
