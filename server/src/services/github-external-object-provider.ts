import type { Db } from "@paperclipai/db";
import type { ExternalObjectCanonicalUrl } from "@paperclipai/shared";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { secretService } from "./secrets.js";
import type {
  ExternalObjectDetection,
  ExternalObjectDetector,
  ExternalObjectResolver,
  ExternalObjectResolverSnapshot,
  ExternalObjectResolveResult,
} from "./external-objects.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubExternalObjectProviderOptions {
  fetch?: FetchLike;
  tokenProvider?: (companyId: string) => Promise<string | null> | string | null;
  secretNames?: readonly string[];
}

interface GitHubObjectIdentity {
  host: string;
  owner: string;
  repo: string;
  number: number;
  objectType: "pull_request" | "issue";
  pathKind: "pull" | "issues";
}

const GITHUB_OBJECT_TTL_SECONDS = 300;

function isGitHubHost(host: string) {
  const h = host.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function asNestedString(record: Record<string, unknown>, key: string, nestedKey: string) {
  const nested = asRecord(record[key]);
  return nested ? asString(nested[nestedKey]) : null;
}

function parseGitHubCanonicalUrl(canonical: ExternalObjectCanonicalUrl): GitHubObjectIdentity | null {
  if (canonical.canonicalIdentity.scheme !== "https") return null;
  const host = canonical.canonicalIdentity.host.toLowerCase();
  if (!isGitHubHost(host)) return null;

  const parts = canonical.canonicalIdentity.path.split("/").filter(Boolean);
  if (parts.length !== 4) return null;
  const [owner, repo, kind, rawNumber] = parts;
  if (!owner || !repo || !kind || !rawNumber) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  if (!/^[1-9][0-9]*$/.test(rawNumber)) return null;
  if (kind !== "pull" && kind !== "issues") return null;

  return {
    host: host === "www.github.com" ? "github.com" : host,
    owner,
    repo,
    number: Number(rawNumber),
    pathKind: kind,
    objectType: kind === "pull" ? "pull_request" : "issue",
  };
}

function parseGitHubObject(object: { externalId: string; sanitizedCanonicalUrl: string | null }): GitHubObjectIdentity | null {
  const match = /^([^/]+)\/([^/]+)#(pull|issues)\/([1-9][0-9]*)$/.exec(object.externalId);
  if (!match) return null;
  let host = "github.com";
  if (object.sanitizedCanonicalUrl) {
    try {
      const url = new URL(object.sanitizedCanonicalUrl);
      if (isGitHubHost(url.hostname)) host = url.hostname === "www.github.com" ? "github.com" : url.hostname;
    } catch {
      return null;
    }
  }
  return {
    host,
    owner: match[1]!,
    repo: match[2]!,
    pathKind: match[3] as "pull" | "issues",
    number: Number(match[4]),
    objectType: match[3] === "pull" ? "pull_request" : "issue",
  };
}

function externalIdFor(identity: GitHubObjectIdentity) {
  return `${identity.owner.toLowerCase()}/${identity.repo.toLowerCase()}#${identity.pathKind}/${identity.number}`;
}

function displayTitleFor(identity: GitHubObjectIdentity) {
  return `${identity.owner}/${identity.repo}#${identity.number}`;
}

function displayKeyFor(identity: Pick<GitHubObjectIdentity, "objectType">) {
  return identity.objectType === "pull_request" ? "GitHub Pull Request" : "GitHub Issue";
}

function retryAfterSeconds(response: Response) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^[0-9]+$/.test(retryAfter)) return Number(retryAfter);

  const reset = response.headers.get("x-ratelimit-reset");
  if (reset && /^[0-9]+$/.test(reset)) {
    return Math.max(1, Number(reset) - Math.floor(Date.now() / 1000));
  }

  return 300;
}

function failureFromGitHubResponse(response: Response): ExternalObjectResolveResult | null {
  if (response.status === 401) {
    return {
      ok: false,
      liveness: "auth_required",
      errorCode: "github_auth_required",
      errorMessage: "GitHub authentication is required to refresh this object.",
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }

  if (response.status === 403) {
    const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
    if (rateLimitRemaining === "0") {
      return {
        ok: false,
        liveness: "unreachable",
        errorCode: "github_rate_limited",
        errorMessage: "GitHub rate limit reached while refreshing this object.",
        retryAfterSeconds: retryAfterSeconds(response),
      };
    }
    return {
      ok: false,
      liveness: "auth_required",
      errorCode: "github_forbidden",
      errorMessage: "GitHub rejected the configured credentials for this object.",
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }

  if (response.status === 429 || response.status >= 500) {
    return {
      ok: false,
      liveness: "unreachable",
      errorCode: response.status === 429 ? "github_rate_limited" : "github_unreachable",
      errorMessage: `GitHub returned HTTP ${response.status} while refreshing this object.`,
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }

  return null;
}

function notFoundSnapshot(identity: GitHubObjectIdentity, etag: string | null): ExternalObjectResolverSnapshot {
  return {
    displayKey: displayKeyFor(identity),
    iconKey: "github",
    displayTitle: displayTitleFor(identity),
    statusKey: "not_found",
    statusLabel: "Not found",
    statusIconKey: "archive",
    statusCategory: "archived",
    statusTone: "muted",
    isTerminal: true,
    etag,
    ttlSeconds: GITHUB_OBJECT_TTL_SECONDS,
    data: {
      provider: "github",
      owner: identity.owner,
      repo: identity.repo,
      number: identity.number,
      notFound: true,
    },
  };
}

function pullRequestSnapshot(
  identity: GitHubObjectIdentity,
  body: Record<string, unknown>,
  etag: string | null,
  checksState: ChecksState | null,
): ExternalObjectResolverSnapshot {
  const title = asString(body.title);
  const state = asString(body.state) ?? "unknown";
  const draft = asBoolean(body.draft) ?? false;
  const merged = (asBoolean(body.merged) ?? false) || Boolean(asString(body.merged_at));
  const authorLogin = asNestedString(body, "user", "login");
  const headRef = asNestedString(body, "head", "ref");
  const headSha = asNestedString(body, "head", "sha");
  const baseRef = asNestedString(body, "base", "ref");
  const reviewDecision = asString(body.review_decision);

  let statusKey = state;
  let statusLabel = state === "open" ? "Open" : state === "closed" ? "Closed" : "Unknown";
  let statusCategory: ExternalObjectResolverSnapshot["statusCategory"] = state === "open" ? "open" : "unknown";
  let statusTone: ExternalObjectResolverSnapshot["statusTone"] = state === "open" ? "info" : "neutral";
  let isTerminal = false;

  if (merged) {
    statusKey = "merged";
    statusLabel = "Merged";
    statusCategory = "succeeded";
    statusTone = "success";
    isTerminal = true;
  } else if (state === "closed") {
    statusKey = "closed";
    statusLabel = "Closed";
    statusCategory = "closed";
    statusTone = "muted";
    isTerminal = true;
  } else if (draft) {
    statusKey = "draft";
    statusLabel = "Draft";
    statusCategory = "waiting";
    statusTone = "warning";
  }

  return {
    displayKey: displayKeyFor(identity),
    iconKey: "github",
    displayTitle: title ? `${displayTitleFor(identity)}: ${title}` : displayTitleFor(identity),
    statusKey,
    statusLabel,
    statusIconKey: merged
      ? "git-merge"
      : state === "closed"
      ? "x-circle"
      : draft
      ? "clock"
      : "git-pull-request",
    statusCategory,
    statusTone,
    isTerminal,
    remoteVersion: asString(body.updated_at),
    etag,
    ttlSeconds: GITHUB_OBJECT_TTL_SECONDS,
    data: {
      provider: "github",
      owner: identity.owner,
      repo: identity.repo,
      number: identity.number,
      state,
      merged,
      draft,
      ...(authorLogin ? { authorLogin } : {}),
      ...(headRef ? { headRef } : {}),
      ...(headSha ? { headSha } : {}),
      ...(baseRef ? { baseRef } : {}),
      ...(reviewDecision ? { reviewDecision } : {}),
      ...(checksState ? { checksState } : {}),
    },
  };
}

function issueSnapshot(identity: GitHubObjectIdentity, body: Record<string, unknown>, etag: string | null): ExternalObjectResolverSnapshot {
  const title = asString(body.title);
  const state = asString(body.state) ?? "unknown";
  const stateReason = asString(body.state_reason);
  const authorLogin = asNestedString(body, "user", "login");
  const statusKey = state === "closed" && stateReason ? `closed_${stateReason}` : state;
  const statusLabel = state === "closed"
    ? stateReason
      ? `Closed: ${stateReason.replace(/_/g, " ")}`
      : "Closed"
    : state === "open"
    ? "Open"
    : "Unknown";

  return {
    displayKey: displayKeyFor(identity),
    iconKey: "github",
    displayTitle: title ? `${displayTitleFor(identity)}: ${title}` : displayTitleFor(identity),
    statusKey,
    statusLabel,
    statusIconKey: state === "closed" ? "circle" : "circle-dot",
    statusCategory: state === "open" ? "open" : state === "closed" ? "closed" : "unknown",
    statusTone: state === "open" ? "info" : state === "closed" ? "muted" : "neutral",
    isTerminal: state === "closed",
    remoteVersion: asString(body.updated_at),
    etag,
    ttlSeconds: GITHUB_OBJECT_TTL_SECONDS,
    data: {
      provider: "github",
      owner: identity.owner,
      repo: identity.repo,
      number: identity.number,
      state,
      ...(stateReason ? { stateReason } : {}),
      ...(authorLogin ? { authorLogin } : {}),
    },
  };
}

async function safeJson(response: Response) {
  try {
    return asRecord(await response.json());
  } catch {
    return null;
  }
}

type ChecksState = "success" | "failure" | "pending";

// Allow-list, not a block-list: GitHub's check-run `conclusion` values keep
// growing (stale, skipped, neutral, ...), and a gate that only recognizes a
// fixed set of *failing* conclusions silently treats any conclusion it
// doesn't recognize as green. Only these conclusions count as confirmed-not-
// blocking; anything else on a completed run (including an unrecognized
// future value) is treated as failure.
const PASSING_CHECK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

function checksStateFromCheckRuns(checkRuns: Array<Record<string, unknown>>): ChecksState | null {
  if (checkRuns.length === 0) return null;
  let sawIncomplete = false;
  let sawFailure = false;
  for (const run of checkRuns) {
    const status = asString(run.status);
    if (status !== "completed") {
      sawIncomplete = true;
      continue;
    }
    const conclusion = asString(run.conclusion);
    if (!conclusion || !PASSING_CHECK_CONCLUSIONS.has(conclusion)) sawFailure = true;
  }
  if (sawFailure) return "failure";
  if (sawIncomplete) return "pending";
  return "success";
}

function checksStateFromCombinedStatus(body: Record<string, unknown> | null): ChecksState | null {
  if (!body) return null;
  // GitHub's combined-status endpoint reports `state: "pending"` even when no
  // legacy commit status has ever been posted for this commit (empty
  // `statuses`). That is "no signal", not a real pending check — only trust
  // `state` once at least one status exists.
  const statuses = Array.isArray(body.statuses) ? body.statuses : [];
  if (statuses.length === 0) return null;
  const state = asString(body.state);
  if (state === "success" || state === "failure" || state === "pending") return state;
  // The combined-status endpoint also documents an "error" state distinct
  // from "failure" (e.g. a status reporter itself errored). Treat it the same
  // as "failure": it is not a confirmed-green signal.
  if (state === "error") return "failure";
  return null;
}

const CHECKS_STATE_SEVERITY: Record<ChecksState, number> = { success: 0, pending: 1, failure: 2 };

function worstChecksState(states: Array<ChecksState | null>): ChecksState | null {
  let worst: ChecksState | null = null;
  for (const state of states) {
    if (!state) continue;
    if (!worst || CHECKS_STATE_SEVERITY[state] > CHECKS_STATE_SEVERITY[worst]) worst = state;
  }
  return worst;
}

async function fetchChecksState(input: {
  fetchImpl: FetchLike;
  headers: Record<string, string>;
  host: string;
  owner: string;
  repo: string;
  headSha: string | null;
}): Promise<ChecksState | null> {
  const { fetchImpl, headers, host, owner, repo, headSha } = input;
  if (!headSha) return null;
  const base = `${gitHubApiBase(host)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  let checkRunsState: ChecksState | null = null;
  let checkRunsFetchFailed = false;
  try {
    // GitHub paginates check-runs (default page size 30). Request the
    // maximum page size so a repo with a realistic number of checks is
    // covered by one request, and detect when `total_count` says there is
    // more data than this single page returned.
    const checkRunsResponse = await fetchImpl(
      `${base}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`,
      { headers },
    );
    if (checkRunsResponse.ok) {
      const body = await safeJson(checkRunsResponse);
      if (body === null) {
        // 2xx but an unreadable/non-JSON body: we cannot tell whether there
        // were check-runs or not. Do not treat this the same as a
        // confirmed-empty check-runs list.
        checkRunsFetchFailed = true;
      } else {
        const checkRuns = Array.isArray(body.check_runs) ? (body.check_runs as Array<Record<string, unknown>>) : [];
        const totalCount = typeof body.total_count === "number" ? body.total_count : checkRuns.length;
        const fromVisiblePage = checksStateFromCheckRuns(checkRuns);
        if (fromVisiblePage === "success" && totalCount > checkRuns.length) {
          // The visible page looks all-green, but `total_count` says there
          // are more check-runs we did not fetch. A failing/pending run on
          // a later page would otherwise be invisible to this gate -- treat
          // an incomplete "success" read as unknown rather than confirmed.
          checkRunsFetchFailed = true;
        } else {
          checkRunsState = fromVisiblePage;
        }
      }
    } else {
      checkRunsFetchFailed = true;
    }
  } catch {
    checkRunsFetchFailed = true;
  }

  let statusState: ChecksState | null = null;
  let statusFetchFailed = false;
  try {
    const statusResponse = await fetchImpl(`${base}/commits/${encodeURIComponent(headSha)}/status`, { headers });
    if (statusResponse.ok) {
      const body = await safeJson(statusResponse);
      if (body === null) {
        statusFetchFailed = true;
      } else {
        statusState = checksStateFromCombinedStatus(body);
      }
    } else {
      statusFetchFailed = true;
    }
  } catch {
    statusFetchFailed = true;
  }

  // Combine both signals rather than trusting check-runs alone: a commit can
  // have all-green GitHub Checks and a failing/pending legacy commit status
  // (posted by a non-Checks-API CI integration) at the same time. The worse
  // of the two known signals wins, and an explicit "failure" from either
  // source is trusted even if the other lookup could not be completed.
  const combined = worstChecksState([checkRunsState, statusState]);
  if (combined === "failure") return "failure";

  // One of the two lookups did not actually complete (network error, non-2xx,
  // unreadable body). We only have a partial picture of this commit's CI
  // state, so we must not report "pending" or "success" as if we had
  // confirmed both signals -- report unknown and let the caller fail closed.
  if (checkRunsFetchFailed || statusFetchFailed) return null;

  if (combined) return combined;

  // Both endpoints were reached successfully and reported nothing: there is
  // genuinely no CI configured for this commit, so there is nothing to gate on.
  return "success";
}

async function defaultTokenProvider(db: Db, companyId: string, secretNames: readonly string[]) {
  const secrets = secretService(db);
  for (const secretName of secretNames) {
    const secret = await secrets.getByName(companyId, secretName);
    if (!secret) continue;
    const token = await secrets.resolveSecretValue(companyId, secret.id, "latest");
    const trimmed = token.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function createGitHubExternalObjectProvider(
  db: Db,
  opts: GitHubExternalObjectProviderOptions = {},
): { detector: ExternalObjectDetector; resolvers: ExternalObjectResolver[] } {
  const fetchImpl = opts.fetch ?? ghFetch;
  const secretNames = opts.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  const tokenProvider = Object.prototype.hasOwnProperty.call(opts, "tokenProvider") && opts.tokenProvider !== undefined
    ? opts.tokenProvider
    : ((companyId: string) => defaultTokenProvider(db, companyId, secretNames));

  const detector: ExternalObjectDetector = {
    key: "github",
    detect({ urls }): ExternalObjectDetection[] {
      return urls.flatMap((canonical) => {
        const identity = parseGitHubCanonicalUrl(canonical);
        if (!identity) return [];
        return [{
          canonical,
          detectorKey: "github",
          providerKey: "github",
          objectType: identity.objectType,
          externalId: externalIdFor(identity),
          displayKey: displayKeyFor(identity),
          iconKey: "github",
          displayTitle: displayTitleFor(identity),
          confidence: "exact",
        }];
      });
    },
  };

  function resolver(objectType: GitHubObjectIdentity["objectType"]): ExternalObjectResolver {
    return {
      providerKey: "github",
      objectType,
      async resolve({ companyId, object }) {
        const identity = parseGitHubObject(object);
        if (!identity || identity.objectType !== objectType) {
          return {
            ok: false,
            liveness: "unreachable",
            errorCode: "github_invalid_identity",
            errorMessage: "GitHub object identity is invalid.",
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }

        let token: string | null = null;
        try {
          token = typeof tokenProvider === "function" ? await tokenProvider(companyId) : tokenProvider;
        } catch {
          return {
            ok: false,
            liveness: "auth_required",
            errorCode: "github_token_unavailable",
            errorMessage: "Configured GitHub credentials could not be resolved.",
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }
        token = token?.trim() || null;
        const headers: Record<string, string> = {
          accept: "application/vnd.github+json",
          "user-agent": "paperclip-external-object-resolver",
          "x-github-api-version": "2022-11-28",
        };
        if (token) headers.authorization = `Bearer ${token}`;

        const apiKind = objectType === "pull_request" ? "pulls" : "issues";
        const url = `${gitHubApiBase(identity.host)}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}/${apiKind}/${identity.number}`;

        let response: Response;
        try {
          response = await fetchImpl(url, { headers });
        } catch {
          return {
            ok: false,
            liveness: "unreachable",
            errorCode: "github_fetch_failed",
            errorMessage: "GitHub could not be reached while refreshing this object.",
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }

        const etag = response.headers.get("etag");
        if (response.status === 404) {
          return { ok: true, snapshot: notFoundSnapshot(identity, etag) };
        }

        const failure = failureFromGitHubResponse(response);
        if (failure) return failure;
        if (!response.ok) {
          return {
            ok: false,
            liveness: "unreachable",
            errorCode: "github_unexpected_response",
            errorMessage: `GitHub returned HTTP ${response.status} while refreshing this object.`,
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }

        const body = await safeJson(response);
        if (!body) {
          return {
            ok: false,
            liveness: "unreachable",
            errorCode: "github_invalid_response",
            errorMessage: "GitHub returned an invalid object response.",
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }

        if (objectType !== "pull_request") {
          return { ok: true, snapshot: issueSnapshot(identity, body, etag) };
        }

        const headSha = asNestedString(body, "head", "sha");
        // A merged PR's own head SHA only carries the pre-merge CI result. GitHub
        // (and any merge-queue/canary gate layered on top of it, e.g. a
        // post-merge-only check against `main`) can report green on that head
        // SHA while the actual merge commit that landed on the base branch was
        // never checked at all, or was checked and failed. Once a PR is
        // reported merged, gate on its `merge_commit_sha` -- the commit that is
        // actually reachable from the base branch -- so "merged" cannot be
        // satisfied by a PR whose landed commit was red. Fall back to head SHA
        // only if GitHub did not report a merge commit SHA for some reason.
        const merged = (asBoolean(body.merged) ?? false) || Boolean(asString(body.merged_at));
        const mergeCommitSha = asString(body.merge_commit_sha);
        const checksSha = merged ? (mergeCommitSha ?? headSha) : headSha;
        const checksState = await fetchChecksState({
          fetchImpl,
          headers,
          host: identity.host,
          owner: identity.owner,
          repo: identity.repo,
          headSha: checksSha,
        });

        return {
          ok: true,
          snapshot: pullRequestSnapshot(identity, body, etag, checksState),
        };
      },
    };
  }

  return {
    detector,
    resolvers: [resolver("pull_request"), resolver("issue")],
  };
}
