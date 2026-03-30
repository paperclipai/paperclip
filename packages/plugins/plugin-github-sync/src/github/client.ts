import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getInstallationToken } from "./auth.js";
import type {
  GitHubCreateCommitResponse,
  GitHubCreatePRResponse,
  GitHubCreateTreeResponse,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRef,
  GitHubRepo,
  GitHubSyncConfig,
  GitHubTreeEntry,
} from "./types.js";
import { STATE_KEYS } from "../constants.js";

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

export class GitHubClient {
  constructor(
    private ctx: PluginContext,
    private config: GitHubSyncConfig,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retryCount = 0,
  ): Promise<T> {
    const token = await getInstallationToken(this.ctx, this.config);
    const url = path.startsWith("https://") ? path : `https://api.github.com${path}`;

    const response = await this.ctx.http.fetch(url, {
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Paperclip-GitHub-Sync/0.1.0",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    // Track rate limit
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAt = response.headers.get("x-ratelimit-reset");
    if (remaining && resetAt) {
      await this.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.rateLimit },
        { remaining: parseInt(remaining, 10), resetAt: parseInt(resetAt, 10) * 1000 },
      );
    }

    // Handle rate limit
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
      this.ctx.logger.warn("GitHub rate limit hit, waiting", { waitMs });
      await new Promise((r) => setTimeout(r, waitMs));
      return this.request<T>(method, path, body, retryCount);
    }

    // Retry on server errors
    if (response.status >= 500 && retryCount < MAX_RETRIES) {
      const waitMs = BACKOFF_BASE_MS * Math.pow(4, retryCount);
      this.ctx.logger.warn("GitHub server error, retrying", {
        status: response.status,
        retryCount,
        waitMs,
      });
      await new Promise((r) => setTimeout(r, waitMs));
      return this.request<T>(method, path, body, retryCount + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async isRateLimitSafe(): Promise<boolean> {
    const state = (await this.ctx.state.get({
      scopeKind: "instance",
      stateKey: STATE_KEYS.rateLimit,
    })) as { remaining: number; resetAt: number } | null;
    if (!state) return true;
    if (state.remaining < 100 && Date.now() < state.resetAt) return false;
    return true;
  }

  async listOrgRepos(): Promise<GitHubRepo[]> {
    const repos: GitHubRepo[] = [];
    let page = 1;
    while (true) {
      const batch = await this.request<GitHubRepo[]>(
        "GET",
        `/orgs/${this.config.orgName}/repos?per_page=100&page=${page}`,
      );
      repos.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return repos;
  }

  async listIssuesSince(repoFullName: string, since: string): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = [];
    let page = 1;
    while (true) {
      const batch = await this.request<GitHubIssue[]>(
        "GET",
        `/repos/${repoFullName}/issues?state=all&sort=updated&direction=desc&since=${since}&per_page=100&page=${page}`,
      );
      issues.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return issues.filter((i) => !("pull_request" in i));
  }

  async listOpenIssues(repoFullName: string): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = [];
    let page = 1;
    while (true) {
      const batch = await this.request<GitHubIssue[]>(
        "GET",
        `/repos/${repoFullName}/issues?state=open&sort=updated&per_page=100&page=${page}`,
      );
      issues.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return issues.filter((i) => !("pull_request" in i));
  }

  async addComment(repoFullName: string, issueNumber: number, body: string): Promise<void> {
    await this.request(
      "POST",
      `/repos/${repoFullName}/issues/${issueNumber}/comments`,
      { body },
    );
  }

  async addLabel(repoFullName: string, issueNumber: number, label: string): Promise<void> {
    await this.request(
      "POST",
      `/repos/${repoFullName}/issues/${issueNumber}/labels`,
      { labels: [label] },
    );
  }

  async removeLabel(repoFullName: string, issueNumber: number, label: string): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/repos/${repoFullName}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      );
    } catch {
      // Label may not exist, ignore
    }
  }

  async listClosedPRsSince(repoFullName: string, since: string): Promise<GitHubPullRequest[]> {
    const prs = await this.request<GitHubPullRequest[]>(
      "GET",
      `/repos/${repoFullName}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
    );
    return prs.filter((pr) => new Date(pr.updated_at) >= new Date(since));
  }

  async createPR(
    repoFullName: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<GitHubCreatePRResponse> {
    return this.request<GitHubCreatePRResponse>(
      "POST",
      `/repos/${repoFullName}/pulls`,
      { title, body, head, base },
    );
  }

  async getRef(repoFullName: string, ref: string): Promise<GitHubRef> {
    return this.request<GitHubRef>("GET", `/repos/${repoFullName}/git/ref/${ref}`);
  }

  async createRef(repoFullName: string, ref: string, sha: string): Promise<void> {
    await this.request("POST", `/repos/${repoFullName}/git/refs`, {
      ref: `refs/${ref}`,
      sha,
    });
  }

  async createTree(
    repoFullName: string,
    baseTreeSha: string,
    entries: GitHubTreeEntry[],
  ): Promise<GitHubCreateTreeResponse> {
    return this.request<GitHubCreateTreeResponse>(
      "POST",
      `/repos/${repoFullName}/git/trees`,
      { base_tree: baseTreeSha, tree: entries },
    );
  }

  async createCommit(
    repoFullName: string,
    message: string,
    treeSha: string,
    parentSha: string,
  ): Promise<GitHubCreateCommitResponse> {
    return this.request<GitHubCreateCommitResponse>(
      "POST",
      `/repos/${repoFullName}/git/commits`,
      { message, tree: treeSha, parents: [parentSha] },
    );
  }

  async updateRef(repoFullName: string, ref: string, sha: string): Promise<void> {
    await this.request("PATCH", `/repos/${repoFullName}/git/refs/${ref}`, {
      sha,
      force: true,
    });
  }

  async verifyConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request<GitHubRepo[]>(
        "GET",
        `/orgs/${this.config.orgName}/repos?per_page=1`,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
