import type { PluginHttpClient } from "@paperclipai/plugin-sdk";

const API_BASE = "https://api.github.com";

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface GitHubRepo {
  name: string;
  full_name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  language: string | null;
  pushed_at: string | null;
  default_branch: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  draft: boolean;
  requested_reviewers: Array<{ login: string }>;
  labels: Array<{ name: string; color: string }>;
  additions: number;
  deletions: number;
  changed_files: number;
  head: { ref: string };
  base: { ref: string; repo: { name: string; full_name: string } };
}

export interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
    committer: { name: string; date: string };
  };
  author: { login: string; avatar_url: string } | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  user: { login: string };
  labels: Array<{ name: string; color: string }>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown;
  repository?: { name: string; full_name: string };
}

export interface CommitActivityWeek {
  total: number;
  week: number;
  days: number[];
}

export interface ContributorStats {
  author: { login: string; avatar_url: string };
  total: number;
  weeks: Array<{ w: number; a: number; d: number; c: number }>;
}

export interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
}

export interface GitHubOrgMember {
  login: string;
  avatar_url: string;
  type: string;
}

// ── GitHub Actions types ──────────────────────────────────────────────

export interface WorkflowRun {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | string;
  conclusion: "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "action_required" | "neutral" | null;
  workflow_id: number;
  run_number: number;
  event: string;
  created_at: string;
  updated_at: string;
  run_started_at: string;
  actor: { login: string };
  triggering_actor: { login: string };
  repository: { name: string; full_name: string };
  run_attempt: number;
}

export interface WorkflowRunsResponse {
  total_count: number;
  workflow_runs: WorkflowRun[];
}

export interface Workflow {
  id: number;
  name: string;
  path: string;
  state: "active" | "disabled_manually" | "disabled_inactivity" | string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowsResponse {
  total_count: number;
  workflows: Workflow[];
}

export interface WorkflowRunTiming {
  run_duration_ms: number;
}

// ---------------------------------------------------------------------------
// Client — scoped to an organisation, can operate on any repo within it
// ---------------------------------------------------------------------------

export class GitHubClient {
  constructor(
    private http: PluginHttpClient,
    private org: string,
    private token: string,
  ) {}

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const res = await this.http.fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  private async paginate<T>(path: string, params?: Record<string, string>, maxPages = 5): Promise<T[]> {
    const all: T[] = [];
    const p = { per_page: "100", ...params };
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.get<T[]>(path, { ...p, page: String(page) });
      all.push(...items);
      if (items.length < 100) break;
    }
    return all;
  }

  // ── Org-level endpoints ────────────────────────────────────────────

  async listOrgRepos(): Promise<GitHubRepo[]> {
    return this.paginate<GitHubRepo>(
      `/orgs/${this.org}/repos`,
      { type: "all", sort: "pushed", direction: "desc" },
      10,
    );
  }

  async listOrgMembers(): Promise<GitHubOrgMember[]> {
    return this.paginate<GitHubOrgMember>(
      `/orgs/${this.org}/members`,
      {},
      5,
    );
  }

  async verifyOrg(): Promise<boolean> {
    try {
      await this.get<Record<string, unknown>>(`/orgs/${this.org}`);
      return true;
    } catch {
      return false;
    }
  }

  // ── Per-repo endpoints (called in a loop across org repos) ─────────

  async listPullRequests(
    repo: string,
    state: "open" | "closed" | "all" = "open",
    perPage = 30,
  ): Promise<GitHubPR[]> {
    return this.get<GitHubPR[]>(
      `/repos/${this.org}/${repo}/pulls`,
      { state, per_page: String(perPage), sort: "updated", direction: "desc" },
    );
  }

  async listCommits(repo: string, since?: string, perPage = 100): Promise<GitHubCommit[]> {
    const params: Record<string, string> = { per_page: String(perPage) };
    if (since) params.since = since;
    return this.get<GitHubCommit[]>(`/repos/${this.org}/${repo}/commits`, params);
  }

  async listIssues(
    repo: string,
    state: "open" | "closed" | "all" = "all",
    since?: string,
    perPage = 100,
  ): Promise<GitHubIssue[]> {
    const params: Record<string, string> = {
      state,
      per_page: String(perPage),
      sort: "updated",
      direction: "desc",
    };
    if (since) params.since = since;
    const items = await this.get<GitHubIssue[]>(`/repos/${this.org}/${repo}/issues`, params);
    return items.filter((i) => !i.pull_request);
  }

  async getCommitActivity(repo: string): Promise<CommitActivityWeek[]> {
    return this.get<CommitActivityWeek[]>(`/repos/${this.org}/${repo}/stats/commit_activity`);
  }

  async getContributorStats(repo: string): Promise<ContributorStats[]> {
    return this.get<ContributorStats[]>(`/repos/${this.org}/${repo}/stats/contributors`);
  }

  async listReleases(repo: string, perPage = 10): Promise<GitHubRelease[]> {
    return this.get<GitHubRelease[]>(
      `/repos/${this.org}/${repo}/releases`,
      { per_page: String(perPage) },
    );
  }

  // ── GitHub Actions endpoints ────────────────────────────────────────

  async listWorkflows(repo: string): Promise<Workflow[]> {
    const res = await this.get<WorkflowsResponse>(
      `/repos/${this.org}/${repo}/actions/workflows`,
      { per_page: "100" },
    );
    return res.workflows;
  }

  async listWorkflowRuns(
    repo: string,
    opts?: { created?: string; status?: string; perPage?: number },
  ): Promise<WorkflowRun[]> {
    const params: Record<string, string> = {
      per_page: String(opts?.perPage ?? 100),
    };
    if (opts?.created) params.created = opts.created;
    if (opts?.status) params.status = opts.status;
    const res = await this.get<WorkflowRunsResponse>(
      `/repos/${this.org}/${repo}/actions/runs`,
      params,
    );
    return res.workflow_runs;
  }
}
