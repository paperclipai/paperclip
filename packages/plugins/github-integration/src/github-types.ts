/**
 * Minimal type definitions for the GitHub webhook payloads we care about.
 * Only the fields we actually read are typed; the rest passes through as `unknown`.
 */

export interface GitHubWorkflowRunEvent {
  action: "completed" | "requested" | "in_progress" | string;
  workflow_run: {
    id: number;
    name: string;
    head_branch: string;
    head_sha: string;
    status: string;
    conclusion: "success" | "failure" | "cancelled" | "timed_out" | "action_required" | string | null;
    html_url: string;
    run_number: number;
    run_attempt: number;
    actor: { login: string } | null;
    head_commit: {
      id: string;
      message: string;
      author: { name: string; email: string } | null;
    } | null;
    pull_requests: Array<{
      number: number;
      head: { ref: string; sha: string };
      base: { ref: string };
    }>;
    repository?: { full_name: string; html_url: string };
  };
  repository: { full_name: string; html_url: string };
}

export interface GitHubCheckRunEvent {
  action: "completed" | "created" | "rerequested" | "requested_action" | string;
  check_run: {
    id: number;
    name: string;
    status: string;
    conclusion: "success" | "failure" | "cancelled" | "timed_out" | "action_required" | "skipped" | string | null;
    html_url: string;
    head_sha: string;
    output: {
      title: string | null;
      summary: string | null;
    };
    check_suite: {
      id: number;
      head_branch: string;
      pull_requests: Array<{
        number: number;
        head: { ref: string; sha: string };
        base: { ref: string };
      }>;
    } | null;
    app: { slug: string; name: string } | null;
  };
  repository: { full_name: string; html_url: string };
}

export interface GitHubPullRequestEvent {
  action: "opened" | "closed" | "reopened" | "synchronize" | "edited" | string;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    state: "open" | "closed";
    merged: boolean;
    html_url: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    user: { login: string } | null;
    merged_by: { login: string } | null;
  };
  repository: { full_name: string; html_url: string };
}

export type GitHubWebhookPayload =
  | GitHubWorkflowRunEvent
  | GitHubCheckRunEvent
  | GitHubPullRequestEvent;
