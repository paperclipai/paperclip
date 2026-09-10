import { secretService } from "../secrets.js";
import {
  DEFAULT_GITHUB_TOKEN_SECRET_NAMES,
  resolveGitHubConnectionCredential,
} from "../git-credentials.js";
import { gitHubApiBase, isGitHubDotCom } from "../github-fetch.js";
import { type Db } from "@paperclipai/db";
import type { DeliveryCheck } from "@paperclipai/shared";

/**
 * GitHub access for the delivery controller.
 *
 * Credentials come from the governed company connection (or, when a policy has
 * no connection, the company's default GitHub token secrets). They are resolved
 * per call and never persisted, never returned to a worker, and never accepted
 * from a request body.
 */

export type GitHubFailure = {
  ok: false;
  status: number | null;
  errorCode: string;
  message: string;
  retryAfterSeconds: number | null;
};

export type GitHubOk<T> = { ok: true; value: T };
export type GitHubResult<T> = GitHubOk<T> | GitHubFailure;

export type GitHubRepositoryIdentity = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  allowMergeCommit: boolean;
  allowSquashMerge: boolean;
  allowRebaseMerge: boolean;
};

export type GitHubPullRequest = {
  number: number;
  url: string;
  nodeId: string | null;
  authorLogin: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  title: string;
  updatedAt: string | null;
};

export type GitHubReviewEntry = {
  state: string;
  login: string | null;
  submittedAt: string | null;
  commitSha: string | null;
};

/** A reviewer whose *latest* review state is APPROVED, with the commit they approved. */
export type GitHubApproval = {
  login: string;
  commitSha: string | null;
};

export type GitHubReviewState = {
  status: string;
  headSha: string | null;
  /** Commit of the most recent still-standing approval. */
  approvedHeadSha: string | null;
  /** Latest-state approvals, each linked to the commit that reviewer approved. */
  approvals: GitHubApproval[];
  blockingFindings: number;
  reviews: GitHubReviewEntry[];
};

/**
 * An authoritative pull request review comment.
 *
 * `commitSha` is GitHub's own `commit_id`: the commit the comment was written
 * against. It is the only accepted source for head provenance when a governed
 * provider read has to be related to a revision, and it is never inferred from
 * the candidate head or from a provider-supplied status flag.
 */
export type GitHubReviewComment = {
  id: string;
  login: string | null;
  commitSha: string | null;
  path: string | null;
  line: number | null;
  body: string | null;
  url: string | null;
  createdAt: string | null;
};

/**
 * Whether a GitHub compare status proves inclusion. For
 * `compare(base=candidate, head=target)`, only `ahead` (target contains the
 * candidate plus newer commits) or `identical` proves the candidate landed in
 * the target. Exported so the receipt path and regression tests share one
 * definition of the direction.
 */
export function isMergeIncluded(status: string): boolean {
  return status === "ahead" || status === "identical";
}

/**
 * Collapse a raw review list into the state that governs merge readiness.
 */
export function summarizeReviews(reviews: GitHubReviewEntry[]): {
  status: string;
  headSha: string | null;
  approvedHeadSha: string | null;
  approvals: GitHubApproval[];
  blockingFindings: number;
} {
  const latestByReviewer = new Map<string, { state: string; commitSha: string | null; submittedAt: string | null }>();
  for (const review of reviews) {
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    const key = review.login ?? `anonymous:${review.submittedAt ?? ""}`;
    latestByReviewer.set(key, {
      state: review.state,
      commitSha: review.commitSha,
      submittedAt: review.submittedAt,
    });
  }
  const blockingFindings = [...latestByReviewer.values()]
    .filter((review) => review.state === "CHANGES_REQUESTED").length;
  const approvals = [...latestByReviewer.entries()]
    .filter(([login, review]) => review.state === "APPROVED" && !login.startsWith("anonymous:"))
    .sort((left, right) => (left[1].submittedAt ?? "").localeCompare(right[1].submittedAt ?? ""))
    .map(([login, review]) => ({ login, commitSha: review.commitSha }));
  return {
    status: blockingFindings > 0
      ? "changes_requested"
      : approvals.length > 0
        ? "approved"
        : reviews.length > 0
          ? "commented"
          : "none",
    headSha: reviews.find((review) => review.commitSha)?.commitSha ?? null,
    approvedHeadSha: approvals.at(-1)?.commitSha ?? null,
    approvals,
    blockingFindings,
  };
}

export type GitHubMergeResult = {
  merged: boolean;
  sha: string | null;
  message: string;
};

const GITHUB_TIMEOUT_MS = 20_000;

function apiBase(host: string) {
  return gitHubApiBase(host);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function retryAfterSeconds(response: Response) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^[0-9]+$/.test(retryAfter)) return Number(retryAfter);
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset && /^[0-9]+$/.test(reset)) {
    return Math.max(1, Number(reset) - Math.floor(Date.now() / 1000));
  }
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createGitHubDeliveryClient(
  db: Db,
  options: { fetch?: typeof fetch } = {},
): GitHubDeliveryClient {
  const fetchImpl = options.fetch ?? fetch;

  async function resolveCredential(
    companyId: string,
    connectionId: string | null,
    host: string,
  ): Promise<GitHubResult<{ token: string; authorization: string }>> {
    if (!isGitHubDotCom(host)) {
      return {
        ok: false,
        status: null,
        errorCode: "connection_missing",
        message: "GitHub connection does not match the repository host",
        retryAfterSeconds: null,
      };
    }
    if (connectionId) {
      const credential = await resolveGitHubConnectionCredential(db, companyId, connectionId);
      if (!credential.ok) {
        return {
          ok: false,
          status: null,
          errorCode: "connection_missing",
          message: credential.error,
          retryAfterSeconds: null,
        };
      }
      return {
        ok: true,
        value: {
          token: credential.token,
          authorization: credential.authorization,
        },
      };
    }
    const secrets = secretService(db);
    for (const name of DEFAULT_GITHUB_TOKEN_SECRET_NAMES) {
      const secret = await secrets.getByName(companyId, name);
      if (!secret) continue;
      try {
        const value = (await secrets.resolveSecretValue(companyId, secret.id, "latest")).trim();
        if (value) {
          return {
            ok: true,
            value: { token: value, authorization: `Bearer ${value}` },
          };
        }
      } catch {
        // Fall through to the next configured name.
      }
    }
    return {
      ok: false,
      status: null,
      errorCode: "connection_missing",
      message: "No GitHub credential is configured for this company",
      retryAfterSeconds: null,
    };
  }

  async function resolveToken(companyId: string, connectionId: string | null): Promise<GitHubResult<string>> {
    const credential = await resolveCredential(companyId, connectionId, "github.com");
    return credential.ok
      ? { ok: true, value: credential.value.token }
      : credential;
  }

  async function request<T>(
    companyId: string,
    connectionId: string | null,
    host: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GitHubResult<T>> {
    const credential = await resolveCredential(companyId, connectionId, host);
    if (!credential.ok) return credential;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "paperclip-delivery-controller",
      "x-github-api-version": "2022-11-28",
      authorization: credential.value.authorization,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(`${apiBase(host)}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: null, errorCode: "github_unreachable", message: "GitHub could not be reached", retryAfterSeconds: null };
    }
    if (response.status === 204) return { ok: true, value: null as T };
    const payload = await readJson(response);
    if (response.ok) return { ok: true, value: payload as T };
    if (response.status === 401) {
      return { ok: false, status: 401, errorCode: "github_auth_required", message: "GitHub credentials were rejected", retryAfterSeconds: retryAfterSeconds(response) };
    }
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      return { ok: false, status: 403, errorCode: "github_rate_limited", message: "GitHub rate limit reached", retryAfterSeconds: retryAfterSeconds(response) };
    }
    if (response.status === 404) {
      return { ok: false, status: 404, errorCode: "github_not_found", message: "GitHub resource not found", retryAfterSeconds: null };
    }
    if (response.status === 405 || response.status === 409 || response.status === 422) {
      const message = str(record(payload)?.message) ?? `GitHub rejected the request (HTTP ${response.status})`;
      return { ok: false, status: response.status, errorCode: "github_rejected", message, retryAfterSeconds: null };
    }
    return {
      ok: false,
      status: response.status,
      errorCode: response.status >= 500 ? "github_unreachable" : "github_unexpected_response",
      message: `GitHub returned HTTP ${response.status}`,
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }

  async function getRepository(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
  ): Promise<GitHubResult<GitHubRepositoryIdentity>> {
    const result = await request<Record<string, unknown>>(
      companyId, connectionId, host, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
    if (!result.ok) return result;
    const body = record(result.value);
    const id = num(body?.id);
    const fullName = str(body?.full_name);
    const defaultBranch = str(body?.default_branch);
    const repoOwner = str(record(body?.owner)?.login);
    const name = str(body?.name);
    if (id === null || !fullName || !defaultBranch || !repoOwner || !name) {
      return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned an incomplete repository response", retryAfterSeconds: null };
    }
    return {
      ok: true,
      value: {
        id: String(id),
        owner: repoOwner,
        name,
        fullName,
        defaultBranch,
        private: bool(body?.private) ?? false,
        archived: bool(body?.archived) ?? false,
        allowMergeCommit: bool(body?.allow_merge_commit) ?? true,
        allowSquashMerge: bool(body?.allow_squash_merge) ?? true,
        allowRebaseMerge: bool(body?.allow_rebase_merge) ?? true,
      },
    };
  }

  async function getPullRequest(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubResult<GitHubPullRequest>> {
    const result = await request<Record<string, unknown>>(
      companyId, connectionId, host, "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
    );
    if (!result.ok) return result;
    const body = record(result.value);
    const head = record(body?.head);
    const base = record(body?.base);
    const headSha = str(head?.sha);
    const headRef = str(head?.ref);
    const baseRef = str(base?.ref);
    const prNumber = num(body?.number);
    const url = str(body?.html_url);
    const state = str(body?.state);
    if (headSha === null || headRef === null || baseRef === null || prNumber === null || url === null || (state !== "open" && state !== "closed")) {
      return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned an incomplete pull request response", retryAfterSeconds: null };
    }
    return {
      ok: true,
      value: {
        number: prNumber,
        url,
        nodeId: str(body?.node_id),
        authorLogin: str(record(body?.user)?.login),
        state,
        draft: bool(body?.draft) ?? false,
        merged: bool(body?.merged) ?? Boolean(str(body?.merged_at)),
        mergedAt: str(body?.merged_at),
        mergeCommitSha: str(body?.merge_commit_sha),
        headRef,
        headSha,
        baseRef,
        baseSha: str(base?.sha),
        mergeable: bool(body?.mergeable),
        mergeableState: str(body?.mergeable_state),
        title: str(body?.title) ?? "",
        updatedAt: str(body?.updated_at),
      },
    };
  }

  /**
   * Combined check state for a revision: legacy commit statuses plus check runs.
   * Required-check matching is done by the policy layer, not here.
   */
  async function getChecks(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<GitHubResult<DeliveryCheck[]>> {
    const checks: DeliveryCheck[] = [];
    const status = await request<Record<string, unknown>>(
      companyId, connectionId, host, "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/status`,
    );
    if (status.ok) {
      for (const entry of Array.isArray(record(status.value)?.statuses) ? record(status.value)!.statuses as unknown[] : []) {
        const row = record(entry);
        const name = str(row?.context);
        if (!name) continue;
        checks.push({
          name,
          status: str(row?.state) ?? "unknown",
          url: str(row?.target_url),
        });
      }
    }
    const runs = await request<Record<string, unknown>>(
      companyId, connectionId, host, "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    );
    if (runs.ok) {
      for (const entry of Array.isArray(record(runs.value)?.check_runs) ? record(runs.value)!.check_runs as unknown[] : []) {
        const row = record(entry);
        const name = str(row?.name);
        if (!name) continue;
        const conclusion = str(row?.conclusion);
        const statusValue = str(row?.status);
        checks.push({
          name,
          status: conclusion ?? statusValue ?? "unknown",
          url: str(row?.html_url) ?? str(record(row?.app)?.html_url),
        });
      }
    }
    if (!status.ok && !runs.ok) {
      return status.ok ? runs : status;
    }
    return { ok: true, value: checks };
  }

  async function getReviews(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubResult<GitHubReviewState>> {
    const result = await request<unknown[]>(
      companyId, connectionId, host, "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews?per_page=100`,
    );
    if (!result.ok) return result;
    const reviews = (Array.isArray(result.value) ? result.value : []).flatMap((entry) => {
      const row = record(entry);
      const state = str(row?.state);
      if (!state) return [];
      return [{
        state,
        login: str(record(row?.user)?.login),
        submittedAt: str(row?.submitted_at),
        commitSha: str(row?.commit_id),
      }];
    });
    const summary = summarizeReviews(reviews);
    return {
      ok: true,
      value: {
        ...summary,
        reviews,
      },
    };
  }

  /**
   * Authoritative pull request review comments. Used only to relate a scoped
   * provider finding identity (for example a Greptile `commentId`) to the exact
   * commit GitHub recorded for it. A malformed response is a failed read, never
   * a partial list, so callers cannot mistake an unreadable comment for an
   * absent one.
   */
  async function getReviewComments(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubResult<GitHubReviewComment[]>> {
    const result = await request<unknown>(
      companyId, connectionId, host, "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/comments?per_page=100`,
    );
    if (!result.ok) return result;
    if (!Array.isArray(result.value)) {
      return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned an unreadable review comment list", retryAfterSeconds: null };
    }
    const comments: GitHubReviewComment[] = [];
    for (const entry of result.value) {
      const row = record(entry);
      const id = num(row?.id);
      if (!id) {
        return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned a review comment without an id", retryAfterSeconds: null };
      }
      comments.push({
        id: str(row?.node_id) ?? String(id),
        login: str(record(row?.user)?.login),
        commitSha: str(row?.commit_id),
        path: str(row?.path),
        line: num(row?.line) ?? num(row?.original_line),
        body: str(row?.body),
        url: str(row?.html_url),
        createdAt: str(row?.created_at),
      });
    }
    return { ok: true, value: comments };
  }

  async function mergePullRequest(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    number: number,
    input: { sha: string; mergeMethod: "merge" | "squash" | "rebase"; commitTitle?: string; commitMessage?: string },
  ): Promise<GitHubResult<GitHubMergeResult>> {
    const result = await request<Record<string, unknown>>(
      companyId, connectionId, host, "PUT",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`,
      {
        sha: input.sha,
        merge_method: input.mergeMethod,
        ...(input.commitTitle ? { commit_title: input.commitTitle } : {}),
        ...(input.commitMessage ? { commit_message: input.commitMessage } : {}),
      },
    );
    if (!result.ok) return result;
    const body = record(result.value);
    return {
      ok: true,
      value: {
        merged: bool(body?.merged) ?? false,
        sha: str(body?.sha),
        message: str(body?.message) ?? "",
      },
    };
  }

  /**
   * GraphQL escape hatch for the native merge queue. Only `enqueuePullRequest`
   * is ever issued; no mutation may bypass branch protection.
   */
  async function enqueuePullRequest(input: {
    companyId: string;
    connectionId: string | null;
    host: string;
    pullRequestNodeId: string;
  }): Promise<GitHubResult<{ enqueued: boolean; position: number | null }>> {
    const credential = await resolveCredential(input.companyId, input.connectionId, input.host);
    if (!credential.ok) return credential;
    let response: Response;
    try {
      response = await fetchImpl(`${apiBase(input.host)}/graphql`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "paperclip-delivery-controller",
          authorization: credential.value.authorization,
        },
        body: JSON.stringify({
          query: `mutation EnqueuePullRequest($id: ID!) {
            enqueuePullRequest(input: { pullRequestId: $id }) {
              mergeQueueEntry { position }
            }
          }`,
          variables: { id: input.pullRequestNodeId },
        }),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: null, errorCode: "github_unreachable", message: "GitHub could not be reached", retryAfterSeconds: null };
    }
    const payload = record(await readJson(response));
    if (!response.ok) {
      const firstError = arrayOf(payload?.errors)[0];
      return {
        ok: false,
        status: response.status,
        errorCode: response.status === 401 ? "github_auth_required" : "github_rejected",
        message: str(record(firstError)?.message) ?? `GitHub returned HTTP ${response.status}`,
        retryAfterSeconds: retryAfterSeconds(response),
      };
    }
    const errors = arrayOf(payload?.errors);
    if (errors.length > 0) {
      const message = str(record(errors[0])?.message) ?? "GitHub rejected the merge-queue request";
      return { ok: false, status: 200, errorCode: "github_rejected", message, retryAfterSeconds: null };
    }
    const entry = record(record(record(payload?.data)?.enqueuePullRequest)?.mergeQueueEntry);
    return { ok: true, value: { enqueued: true, position: num(entry?.position) } };
  }

  /**
   * Ancestry check used to prove a merged revision is actually included in the
   * target branch. The call is `compare(base=head-candidate, head=target)`:
   * the candidate is included exactly when the target is ahead of it (or the
   * same commit). `behind` means the target is *behind* the candidate — the
   * inverted direction — and never proves inclusion.
   */
  async function compareCommits(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<GitHubResult<{ status: string; aheadBy: number; behindBy: number; included: boolean }>> {
    const result = await request<Record<string, unknown>>(
      companyId, connectionId, host, "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    if (!result.ok) return result;
    const status = str(record(result.value)?.status) ?? "unknown";
    const aheadBy = num(record(result.value)?.ahead_by) ?? 0;
    const behindBy = num(record(result.value)?.behind_by) ?? 0;
    return {
      ok: true,
      value: { status, aheadBy, behindBy, included: isMergeIncluded(status) },
    };
  }

  async function findOpenPullRequest(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    head: string,
    base: string,
  ): Promise<GitHubResult<GitHubPullRequest | null>> {
    const result = await request<unknown[]>(
      companyId, connectionId, host, "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=10`,
    );
    if (!result.ok) return result;
    const first = Array.isArray(result.value) ? record(result.value[0]) : null;
    if (!first) return { ok: true, value: null };
    const number = num(first.number);
    if (number === null) return { ok: true, value: null };
    return getPullRequest(companyId, connectionId, host, owner, repo, number);
  }

  return {
    resolveToken,
    getRepository,
    getPullRequest,
    getChecks,
    getReviews,
    getReviewComments,
    mergePullRequest,
    enqueuePullRequest,
    compareCommits,
    findOpenPullRequest,
  };
}

export interface GitHubDeliveryClient {
  resolveToken(companyId: string, connectionId: string | null): Promise<GitHubResult<string>>;
  getRepository(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
  ): Promise<GitHubResult<GitHubRepositoryIdentity>>;
  getPullRequest(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubResult<GitHubPullRequest>>;
  getChecks(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<GitHubResult<DeliveryCheck[]>>;
  getReviews(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubResult<GitHubReviewState>>;
  getReviewComments(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubResult<GitHubReviewComment[]>>;
  mergePullRequest(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    number: number,
    input: { sha: string; mergeMethod: "merge" | "squash" | "rebase"; commitTitle?: string; commitMessage?: string },
  ): Promise<GitHubResult<GitHubMergeResult>>;
  enqueuePullRequest(input: {
    companyId: string;
    connectionId: string | null;
    host: string;
    pullRequestNodeId: string;
  }): Promise<GitHubResult<{ enqueued: boolean; position: number | null }>>;
  compareCommits(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<GitHubResult<{ status: string; aheadBy: number; behindBy: number; included: boolean }>>;
  findOpenPullRequest(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    head: string,
    base: string,
  ): Promise<GitHubResult<GitHubPullRequest | null>>;
}
