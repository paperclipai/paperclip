import { tauriInvoke } from "./tauri-client";

export interface Issue {
  id: string;
  company_id: string;
  project_id: string | null;
  issue_number: number;
  identifier: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_agent_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export type IssuePriority = "critical" | "high" | "medium" | "low" | "none";

export interface IssueComment {
  id: string;
  issue_id: string;
  author_agent_id: string | null;
  author_user_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export const issuesApi = {
  list: (companyId: string, status?: string) =>
    tauriInvoke<Issue[]>("list_issues", { companyId, status }),
  get: (id: string) =>
    tauriInvoke<Issue>("get_issue", { id }),
  create: (companyId: string, data: { title: string; description?: string; project_id?: string; priority?: string; assignee_agent_id?: string }) =>
    tauriInvoke<Issue>("create_issue", { companyId, data }),
  update: (id: string, data: { title?: string; description?: string; status?: string; priority?: string; assignee_agent_id?: string }) =>
    tauriInvoke<Issue>("update_issue", { id, data }),
  delete: (id: string) =>
    tauriInvoke<void>("delete_issue", { id }),
  listComments: (issueId: string) =>
    tauriInvoke<IssueComment[]>("list_issue_comments", { issueId }),
  createComment: (companyId: string, issueId: string, body: string) =>
    tauriInvoke<IssueComment>("create_issue_comment", { companyId, issueId, body }),
};
