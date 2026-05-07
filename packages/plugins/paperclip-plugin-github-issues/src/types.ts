export interface GhRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  html_url: string;
}

export interface GhLabel {
  name: string;
}

export interface GhIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: GhLabel[];
  html_url: string;
  user: { login: string };
}

export interface GhComment {
  id: number;
  node_id: string;
  body: string;
  user: { login: string };
  html_url: string;
}

export interface GhPullRequest {
  id: number;
  node_id: string;
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  head: { sha: string; ref: string };
  base: { ref: string };
  html_url: string;
}

export interface GhWorkflowRun {
  id: number;
  node_id: string;
  head_sha: string;
  conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "neutral"
    | "skipped"
    | "timed_out"
    | "action_required"
    | null;
  status: "queued" | "in_progress" | "completed";
  pull_requests: Array<{
    number: number;
    head: { sha: string };
    base: { ref: string };
  }>;
  html_url: string;
}

export type GhEvent =
  | { type: "issues"; action: string; issue: GhIssue; repository: GhRepo }
  | {
      type: "issue_comment";
      action: string;
      issue: GhIssue;
      comment: GhComment;
      repository: GhRepo;
    }
  | {
      type: "pull_request";
      action: string;
      pull_request: GhPullRequest;
      repository: GhRepo;
    }
  | {
      type: "workflow_run";
      action: string;
      workflow_run: GhWorkflowRun;
      repository: GhRepo;
    };

export interface PluginConfig {
  hmacSecret: string;
  ceoAgentId: string;
  labelGate: string;
  repoToProject: Record<string, string>;
  companyId: string;
}
