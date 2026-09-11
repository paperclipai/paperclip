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
 * A check run exactly as GitHub recorded it, including the app that created it.
 *
 * `appSlug` is the slug of the GitHub App that produced the run. GitHub sets it
 * from the app's own authenticated request, so it is the provenance that
 * distinguishes the real Greptile app from any other check that merely names
 * itself "Greptile". `headSha` is GitHub's record of the commit the run
 * belongs to.
 */
export type GitHubCheckRun = {
  id: number | null;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  headSha: string | null;
  appSlug: string | null;
  completedAt: string | null;
  startedAt: string | null;
  url: string | null;
};

/**
 * One comment inside an authoritative pull request review thread.
 *
 * `id` is GitHub's own node id — the same identity a governed provider read
 * publishes for an inline finding — and `commitSha` is GitHub's `commit.oid`
 * for that comment. Both are read, never inferred.
 */
export type GitHubReviewThreadComment = {
  id: string;
  commitSha: string | null;
};

/**
 * An authoritative pull request review thread.
 *
 * `isResolved` is GitHub's own resolution record for the thread. It is the only
 * host-side "this finding is addressed" authority: a provider's own `addressed`
 * flag describes the provider's review, while the resolution is the decision
 * the pull request recorded. `isOutdated` is *not* resolution — a thread whose
 * diff line moved is still unresolved until someone resolves it.
 */
export type GitHubReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  /** Every comment GitHub records in the thread, oldest first. */
  comments: GitHubReviewThreadComment[];
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

/** Check runs are read at GitHub's maximum page size. */
const CHECK_RUNS_PAGE_SIZE = 100;

/** Page bound for a complete check-run read; exhausting it is an unreadable record. */
const MAX_CHECK_RUN_PAGES = 10;

/** Array REST reads (reviews, review comments) are read at the maximum page size. */
const ARRAY_PAGE_SIZE = 100;

/** Page bound for a complete array read; exhausting it is an unreadable record. */
const MAX_ARRAY_PAGES = 20;

/** Review threads and their comments are read at the maximum page size. */
const REVIEW_THREAD_PAGE_SIZE = 100;

/**
 * GitHub's own wording for a GraphQL input that does not accept the exact-head
 * binding. The field is part of the documented `EnqueuePullRequestInput`; a
 * host or API version that does not know it must fail closed rather than
 * enqueue an unbound entry that could merge a head no review evaluated.
 */
const MERGE_QUEUE_HEAD_BINDING_UNSUPPORTED = /expectedHeadOid|EnqueuePullRequestInput|unknown argument/i;

/** Page bounds for a complete thread read; exhausting one is an unreadable record. */
const MAX_REVIEW_THREAD_PAGES = 10;
const MAX_THREAD_COMMENT_PAGES = 10;

/**
 * The GraphQL shape a governed review-thread read needs: GitHub's own thread
 * identity and resolution flag, plus each comment's node id and commit.
 */
const REVIEW_THREADS_QUERY = `query DeliveryReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${REVIEW_THREAD_PAGE_SIZE}, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: ${REVIEW_THREAD_PAGE_SIZE}) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { id commit { oid } }
          }
        }
      }
    }
  }
}`;

/** Continuation shape for a thread whose comment list is longer than one page. */
const REVIEW_THREAD_COMMENTS_QUERY = `query DeliveryReviewThreadComments($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: ${REVIEW_THREAD_PAGE_SIZE}, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id commit { oid } }
      }
    }
  }
}`;

function apiBase(host: string) {
  return gitHubApiBase(host);
}

/**
 * A failed read of GitHub's review-thread record. One shared shape because
 * every unreadable thread, comment or pagination page is the same fact: a
 * partial list must never be read as a complete one.
 */
const REVIEW_THREAD_READ_FAILURE: GitHubFailure = {
  ok: false,
  status: null,
  errorCode: "github_invalid_response",
  message: "GitHub returned an unreadable review thread record",
  retryAfterSeconds: null,
};

type PageConnection = {
  rows: unknown[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
};

/**
 * Read one page of a connection inside the review-thread query envelope.
 *
 * The root query answers with `data.repository.pullRequest.reviewThreads`, so
 * the connection is read where GitHub actually puts it rather than assumed at
 * the data root. A missing or reshaped envelope is unreadable, never empty.
 */
function readPullRequestConnection(data: unknown, key: string): PageConnection | null {
  const pullRequest = record(record(record(data)?.repository)?.pullRequest);
  return readPageConnection(pullRequest, key);
}

/**
 * Read one page of a GraphQL connection.
 *
 * `totalCount`, `pageInfo.hasNextPage` and `endCursor` must all be present and
 * mutually consistent: a connection whose metadata cannot be read is unreadable
 * rather than empty, so no caller mistakes a broken page for a complete record.
 */
function readPageConnection(value: unknown, key: string): PageConnection | null {
  const connection = record(record(value)?.[key]);
  if (!connection || !Array.isArray(connection.nodes)) return null;
  const totalCount = num(connection.totalCount);
  if (totalCount === null || totalCount < 0 || connection.nodes.length > totalCount) return null;
  const pageInfo = record(connection.pageInfo);
  const hasNextPage = bool(pageInfo?.hasNextPage);
  if (hasNextPage === null) return null;
  const endCursor = str(pageInfo?.endCursor);
  if (hasNextPage && !endCursor) return null;
  return { rows: connection.nodes, totalCount, hasNextPage, endCursor };
}

function readThreadComment(value: unknown): GitHubReviewThreadComment | null {
  const row = record(value);
  const id = str(row?.id);
  if (!row || !id) return null;
  return { id, commitSha: str(record(row.commit)?.oid) };
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

  /**
   * One GraphQL request against the governed connection.
   *
   * GraphQL answers a rejected request with HTTP 200 plus an `errors` array, so
   * a body is only usable when it carries neither an error nor a missing
   * `data`. The credential is resolved per call and never cached.
   */
  async function graphqlRequest(
    companyId: string,
    connectionId: string | null,
    host: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GitHubResult<unknown>> {
    const credential = await resolveCredential(companyId, connectionId, host);
    if (!credential.ok) return credential;
    let response: Response;
    try {
      response = await fetchImpl(`${apiBase(host)}/graphql`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "paperclip-delivery-controller",
          authorization: credential.value.authorization,
        },
        body: JSON.stringify({ query, variables }),
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
        errorCode: response.status === 401 ? "github_auth_required" : "github_unexpected_response",
        message: str(record(firstError)?.message) ?? `GitHub returned HTTP ${response.status}`,
        retryAfterSeconds: retryAfterSeconds(response),
      };
    }
    const errors = arrayOf(payload?.errors);
    if (errors.length > 0) {
      return {
        ok: false,
        status: 200,
        errorCode: "github_unexpected_response",
        message: str(record(errors[0])?.message) ?? "GitHub rejected the GraphQL request",
        retryAfterSeconds: null,
      };
    }
    if (!payload || payload.data == null) {
      return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned a GraphQL response without data", retryAfterSeconds: null };
    }
    return { ok: true, value: payload.data };
  }

  /**
   * Follow an array REST read to its own end.
   *
   * GitHub publishes no total for these collections, so the end signal is the
   * short page: a page smaller than the requested size is the last one. A page
   * bound exhausted while every page was full is an unreadable record, never a
   * truncated list that a caller could read as complete evidence.
   */
  async function readAllPages<T>(
    companyId: string,
    connectionId: string | null,
    host: string,
    path: string,
    parse: (payload: unknown) => T[] | null,
  ): Promise<GitHubResult<T[]>> {
    const rows: T[] = [];
    for (let page = 1; page <= MAX_ARRAY_PAGES; page += 1) {
      const result = await request<unknown>(
        companyId, connectionId, host, "GET",
        `${path}?per_page=${ARRAY_PAGE_SIZE}&page=${page}`,
      );
      if (!result.ok) return result;
      const parsed = parse(result.value);
      if (parsed === null) {
        return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned an unreadable list", retryAfterSeconds: null };
      }
      rows.push(...parsed);
      if (parsed.length < ARRAY_PAGE_SIZE) return { ok: true, value: rows };
    }
    return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned an incomplete list", retryAfterSeconds: null };
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
    // A complete read: `summarizeReviews` decides from each reviewer's latest
    // state, so a truncated list could drop the newest review — a still-standing
    // change request, or the approval acceptance depends on.
    const result = await readAllPages<GitHubReviewEntry>(
      companyId, connectionId, host,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`,
      (payload) => Array.isArray(payload)
        ? payload.flatMap((entry) => {
          const row = record(entry);
          const state = str(row?.state);
          if (!state) return [];
          return [{
            state,
            login: str(record(row?.user)?.login),
            submittedAt: str(row?.submitted_at),
            commitSha: str(row?.commit_id),
          }];
        })
        : null,
    );
    if (!result.ok) return result;
    const summary = summarizeReviews(result.value);
    return {
      ok: true,
      value: {
        ...summary,
        reviews: result.value,
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
    // A comment identity is the pivot a governed finding is correlated through,
    // both for head provenance and for the review thread that carries it, so the
    // read is complete or it fails: a truncated list would silently drop the
    // identity a finding needs and read as an absent (never-resolved) comment.
    const result = await readAllPages<GitHubReviewComment>(
      companyId, connectionId, host,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/comments`,
      (payload) => {
        if (!Array.isArray(payload)) return null;
        const comments: GitHubReviewComment[] = [];
        for (const entry of payload) {
          const row = record(entry);
          const id = num(row?.id);
          if (!id) return null;
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
        return comments;
      },
    );
    if (!result.ok) return result;
    return { ok: true, value: result.value };
  }

  /**
   * Authoritative pull request review threads, with GitHub's own resolution
   * record for each thread.
   *
   * This is the host-side authority for "the reviewers consider this finding
   * addressed": a resolved thread is resolved evidence, an unresolved thread is
   * not, and a provider flag substitutes for neither. The read is complete or
   * it fails — every thread page and every thread's comment pages are followed
   * until GitHub's own totals are accounted for — because a resolution hidden
   * past a page bound would read as an unresolved thread, and a truncated
   * comment list would lose the identity a governed finding correlates through.
   */
  async function getReviewThreads(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubResult<GitHubReviewThread[]>> {
    const rawThreads: unknown[] = [];
    let expectedCount: number | null = null;
    let cursor: string | null = null;
    let complete = false;
    for (let page = 1; page <= MAX_REVIEW_THREAD_PAGES && !complete; page += 1) {
      const result = await graphqlRequest(
        companyId, connectionId, host, REVIEW_THREADS_QUERY,
        { owner, repo, number, cursor },
      );
      if (!result.ok) return result;
      const connection = readPullRequestConnection(result.value, "reviewThreads");
      if (!connection) return REVIEW_THREAD_READ_FAILURE;
      if (expectedCount === null) expectedCount = connection.totalCount;
      else if (expectedCount !== connection.totalCount) return REVIEW_THREAD_READ_FAILURE;
      rawThreads.push(...connection.rows);
      if (rawThreads.length > expectedCount) return REVIEW_THREAD_READ_FAILURE;
      if (!connection.hasNextPage) {
        // GitHub's own total is the completeness proof: a shorter list is a
        // truncated record, not a pull request with fewer threads.
        if (rawThreads.length !== expectedCount) return REVIEW_THREAD_READ_FAILURE;
        complete = true;
        break;
      }
      cursor = connection.endCursor;
    }
    if (!complete) return REVIEW_THREAD_READ_FAILURE;

    const threads: GitHubReviewThread[] = [];
    const seenThreadIds = new Set<string>();
    for (const raw of rawThreads) {
      const row = record(raw);
      const id = str(row?.id);
      const isResolved = bool(row?.isResolved);
      const isOutdated = bool(row?.isOutdated);
      if (!row || !id || isResolved === null || isOutdated === null || seenThreadIds.has(id)) {
        return REVIEW_THREAD_READ_FAILURE;
      }
      seenThreadIds.add(id);
      const comments = await readThreadComments(companyId, connectionId, host, id, row.comments);
      if (!comments.ok) return comments;
      threads.push({
        id,
        isResolved,
        isOutdated,
        comments: comments.value,
      });
    }
    return { ok: true, value: threads };
  }

  /**
   * Every comment of one review thread.
   *
   * The thread's first comment page arrives with the thread list; a longer
   * thread is continued through `node(id:)` until GitHub's own comment total is
   * accounted for. An unreadable or unfinished comment list is a failed read:
   * a comment hidden past the page bound could be the exact identity a governed
   * finding resolves through.
   */
  async function readThreadComments(
    companyId: string,
    connectionId: string | null,
    host: string,
    threadId: string,
    firstPage: unknown,
  ): Promise<GitHubResult<GitHubReviewThreadComment[]>> {
    const comments: GitHubReviewThreadComment[] = [];
    const seenCommentIds = new Set<string>();
    let expectedCount: number | null = null;
    let pendingPage: unknown = firstPage;
    for (let page = 1; page <= MAX_THREAD_COMMENT_PAGES; page += 1) {
      const connection = readPageConnection({ comments: pendingPage }, "comments");
      if (!connection) return REVIEW_THREAD_READ_FAILURE;
      if (expectedCount === null) expectedCount = connection.totalCount;
      else if (expectedCount !== connection.totalCount) return REVIEW_THREAD_READ_FAILURE;
      for (const node of connection.rows) {
        const comment = readThreadComment(node);
        if (!comment || seenCommentIds.has(comment.id)) return REVIEW_THREAD_READ_FAILURE;
        seenCommentIds.add(comment.id);
        comments.push(comment);
      }
      if (comments.length > expectedCount) return REVIEW_THREAD_READ_FAILURE;
      if (!connection.hasNextPage) {
        if (comments.length !== expectedCount) return REVIEW_THREAD_READ_FAILURE;
        return { ok: true, value: comments };
      }
      const next = await graphqlRequest(
        companyId, connectionId, host, REVIEW_THREAD_COMMENTS_QUERY,
        { id: threadId, cursor: connection.endCursor },
      );
      if (!next.ok) return next;
      pendingPage = record(record(next.value)?.node)?.comments;
    }
    return REVIEW_THREAD_READ_FAILURE;
  }

  /**
   * Check runs GitHub records for one exact commit, with app provenance intact.
   *
   * Used to authenticate a provider's GitHub-side review evidence (which app
   * reported an outcome on which head), not for required-check policy —
   * `getChecks` keeps that flattened role. The read is only a usable record
   * when it is complete: pages are followed until the response's own
   * `total_count` is accounted for within a small page bound, so an outcome
   * hidden beyond the first page can never be dropped from the evidence. A
   * malformed response — an unreadable list, missing or malformed pagination
   * metadata, an unparseable run, or a page budget exhausted before
   * `total_count` is accounted for — is a failed read, never a partial list,
   * so a caller can never mistake a truncated record for a complete one.
   */
  async function getCheckRuns(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<GitHubResult<GitHubCheckRun[]>> {
    const checkRunsPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs`;
    const checkRuns: GitHubCheckRun[] = [];
    let fetched = 0;
    let expectedCount: number | null = null;
    const seenIds = new Set<number>();
    for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
      const result = await request<Record<string, unknown>>(
        companyId, connectionId, host, "GET",
        `${checkRunsPath}?per_page=${CHECK_RUNS_PAGE_SIZE}&page=${page}`,
      );
      if (!result.ok) return result;
      const payload = record(result.value);
      const runs = payload === null ? null : payload.check_runs;
      if (!Array.isArray(runs)) {
        return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned an unreadable check-run list", retryAfterSeconds: null };
      }
      const totalCount = num(payload?.total_count);
      if (totalCount === null || totalCount < fetched + runs.length || (expectedCount !== null && totalCount !== expectedCount)) {
        return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned unreadable check-run pagination metadata", retryAfterSeconds: null };
      }
      expectedCount = totalCount;
      fetched += runs.length;
      for (const entry of runs) {
        const row = record(entry);
        const id = row ? num(row.id) : null;
        if (!row || id === null || id <= 0 || seenIds.has(id)) {
          return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned an unreadable check-run list", retryAfterSeconds: null };
        }
        seenIds.add(id);
        checkRuns.push({
          id,
          name: str(row.name),
          status: str(row.status),
          conclusion: str(row.conclusion),
          headSha: str(row.head_sha),
          appSlug: str(record(row.app)?.slug),
          completedAt: str(row.completed_at),
          startedAt: str(row.started_at),
          url: str(row.html_url),
        });
      }
      if (fetched >= totalCount) return { ok: true, value: checkRuns };
      if (runs.length === 0) {
        return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned an incomplete check-run list", retryAfterSeconds: null };
      }
    }
    return { ok: false, status: null, errorCode: "github_invalid_response", message: "GitHub returned an incomplete check-run list", retryAfterSeconds: null };
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
   *
   * The entry is bound to the exact revision acceptance evaluated
   * (`expectedHeadOid`), so a head pushed after the evidence read cannot be
   * merged under that evidence. A host or API version that rejects the binding
   * fails closed with a distinct error code instead of enqueueing an unbound
   * entry: the queue would otherwise merge whatever the branch points at.
   */
  async function enqueuePullRequest(input: {
    companyId: string;
    connectionId: string | null;
    host: string;
    pullRequestNodeId: string;
    /** Exact revision the queue entry may merge. */
    expectedHeadOid: string;
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
          query: `mutation EnqueuePullRequest($id: ID!, $oid: GitObjectID!) {
            enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $oid }) {
              mergeQueueEntry { position }
            }
          }`,
          variables: { id: input.pullRequestNodeId, oid: input.expectedHeadOid },
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
      if (MERGE_QUEUE_HEAD_BINDING_UNSUPPORTED.test(message)) {
        return {
          ok: false,
          status: 200,
          errorCode: "merge_queue_head_binding_unsupported",
          message: "GitHub's merge queue does not accept an exact-head binding on this host",
          retryAfterSeconds: null,
        };
      }
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
    getReviewThreads,
    getCheckRuns,
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
  /**
   * Authoritative review threads with GitHub's own resolution record. The read
   * is complete or it fails; absence of a thread is never resolution evidence.
   */
  getReviewThreads(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubResult<GitHubReviewThread[]>>;
  getCheckRuns(
    companyId: string,
    connectionId: string | null,
    host: string,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<GitHubResult<GitHubCheckRun[]>>;
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
    /** Exact revision the queue entry may merge; an unbound entry is refused. */
    expectedHeadOid: string;
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
