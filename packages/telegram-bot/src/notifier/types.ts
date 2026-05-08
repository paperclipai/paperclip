export type IssueRef = {
  id: string;
  identifier?: string | null;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdByUserId?: string | null;
  createdByAgentId?: string | null;
  updatedAt?: string | null;
  description?: string | null;
};

export type InteractionRef = {
  id: string;
  issueId: string;
  kind: "suggest_tasks" | "ask_user_questions" | "request_confirmation";
  status: string;
  title?: string | null;
  summary?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  resolvedByAgentId?: string | null;
  resolvedByUserId?: string | null;
};

export type ApprovalRef = {
  id: string;
  type?: string | null;
  status: string;
  requestedByAgentId?: string | null;
  requestedByUserId?: string | null;
  payload?: {
    title?: string | null;
    summary?: string | null;
    recommendedAction?: string | null;
    risks?: string[] | null;
  } | null;
  issueIds?: string[] | null;
};

export type AgentRef = {
  id: string;
  displayName?: string | null;
  role?: string | null;
};

export type CommentRef = {
  id: string;
  body?: string | null;
  authorAgentId?: string | null;
  authorUserId?: string | null;
};

export type NotifierEventType = "interaction" | "approval" | "blocked" | "done";

export type RenderedEvent = {
  type: NotifierEventType;
  dedupKey: string;
  issueId: string;
  text: string;
};
