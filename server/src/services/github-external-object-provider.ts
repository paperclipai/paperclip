import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { ExternalObjectCanonicalUrl } from "@paperclipai/shared";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES, resolveGitHubApiCredential, type GitHubApiCredential } from "./git-credentials.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
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
  /**
   * Resolve the credential and its source. Prefer this over `tokenProvider` when the
   * caller must treat a server-environment token differently from a company credential.
   */
  credentialProvider?: (companyId: string) => Promise<GitHubApiCredential | null> | GitHubApiCredential | null;
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

function asNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asNestedString(record: Record<string, unknown>, key: string, nestedKey: string) {
  const nested = asRecord(record[key]);
  return nested ? asString(nested[nestedKey]) : null;
}

function normalizeCredential(credential: GitHubApiCredential | null | undefined): GitHubApiCredential | null {
  const token = credential?.token?.trim();
  if (!token) return null;
  return { token, source: credential!.source, secretName: credential!.secretName ?? null };
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

function rateLimitedResult(authenticated: boolean, retryAfterSeconds: number): ExternalObjectResolveResult {
  return {
    ok: false,
    liveness: "rate_limited",
    errorCode: "github_rate_limited",
    errorMessage: authenticated
      ? "GitHub rate limit reached while refreshing this object. It will retry after the limit resets."
      : "GitHub rate limit reached while refreshing this object because no GitHub credential is configured, so requests are anonymous. Add a GitHub token to raise the limit.",
    retryAfterSeconds,
  };
}

function failureFromGitHubResponse(response: Response, authenticated: boolean): ExternalObjectResolveResult | null {
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
      return rateLimitedResult(authenticated, retryAfterSeconds(response));
    }
    return {
      ok: false,
      liveness: "auth_required",
      errorCode: "github_forbidden",
      errorMessage: "GitHub rejected the configured credentials for this object.",
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }

  if (response.status === 429) {
    return rateLimitedResult(authenticated, retryAfterSeconds(response));
  }

  if (response.status >= 500) {
    return {
      ok: false,
      liveness: "unreachable",
      errorCode: "github_unreachable",
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
      // The repository was probed with the configured credentials and found
      // to be visible, so this not-found verdict is definitive, not a stale
      // guess from a time when credentials could not see the repo. The due
      // sweep uses this flag to avoid re-polling a confirmed-deleted object
      // forever and exhausting the company's GitHub API budget.
      probeVerified: true,
    },
  };
}

/**
 * Probe `/repos/{owner}/{repo}` to classify a 404 on a pull request or issue, and to
 * learn whether the repository is private.
 *
 * GitHub returns 404 both when the object does not exist and when the repository
 * exists but the credentials cannot see it (private repos are deliberately hidden
 * behind 404). This probes the repo metadata with the same credentials to tell the
 * two apart:
 *
 * - "visible": the repo returns 2xx — the referenced object really is gone. The
 *   response also carries the repo's `private` flag.
 * - "hidden": the repo returns 404/403 — the credentials lack access to the repo,
 *   so the object status cannot be determined and should not be frozen as "Not found".
 * - "rate_limited": the probe was rejected by a GitHub rate limit — retry later, with a
 *   distinct state so a quota problem is not reported as a network failure.
 * - "uncertain": the probe itself failed (network/other) — retry later.
 */
type RepoProbeOutcome = {
  visibility: "visible" | "hidden" | "rate_limited" | "uncertain";
  isPrivate: boolean | null;
};

async function probeRepoVisibility(
  identity: GitHubObjectIdentity,
  opts: { fetch: FetchLike; headers?: Record<string, string> | undefined },
): Promise<RepoProbeOutcome> {
  try {
    const probe = await opts.fetch(
      `${gitHubApiBase(identity.host)}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}`,
      { headers: opts.headers },
    );
    if (probe.ok) {
      const body = await safeJson(probe);
      return { visibility: "visible", isPrivate: typeof body?.private === "boolean" ? body.private : null };
    }
    if (probe.status === 404) return { visibility: "hidden", isPrivate: null };
    if (probe.status === 429) return { visibility: "rate_limited", isPrivate: null };
    if (probe.status === 403) {
      // GitHub can return 403 for both "credentials lack access" and "rate limit
      // reached". A rate-limited probe cannot tell the two apart, so treat it as
      // a rate limit (retry later) instead of implying missing access.
      const rateLimitRemaining = probe.headers.get("x-ratelimit-remaining");
      if (rateLimitRemaining === "0") return { visibility: "rate_limited", isPrivate: null };
      return { visibility: "hidden", isPrivate: null };
    }
    return { visibility: "uncertain", isPrivate: null };
  } catch {
    return { visibility: "uncertain", isPrivate: null };
  }
}

function pullRequestSnapshot(identity: GitHubObjectIdentity, body: Record<string, unknown>, etag: string | null): ExternalObjectResolverSnapshot {
  const title = asString(body.title);
  const state = asString(body.state) ?? "unknown";
  const draft = asBoolean(body.draft) ?? false;
  const merged = (asBoolean(body.merged) ?? false) || Boolean(asString(body.merged_at));
  const authorLogin = asNestedString(body, "user", "login");
  const headRef = asNestedString(body, "head", "ref");
  const headSha = asNestedString(body, "head", "sha");
  const baseRef = asNestedString(body, "base", "ref");
  const reviewDecision = asString(body.review_decision);
  const additions = asNonNegativeInteger(body.additions);
  const deletions = asNonNegativeInteger(body.deletions);
  const changedFiles = asNonNegativeInteger(body.changed_files);

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
      ...(additions !== null ? { additions } : {}),
      ...(deletions !== null ? { deletions } : {}),
      ...(changedFiles !== null ? { changedFiles } : {}),
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

export function createGitHubExternalObjectProvider(
  db: Db,
  opts: GitHubExternalObjectProviderOptions = {},
): { detector: ExternalObjectDetector; resolvers: ExternalObjectResolver[] } {
  const fetchImpl = opts.fetch ?? ghFetch;
  const secretNames = opts.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  // `credentialProvider` is the preferred seam; `tokenProvider` stays for callers that
  // only care about the token string. A token from `tokenProvider` is treated as
  // company-scoped, because the caller supplied it explicitly.
  const credentialProvider: (companyId: string) => Promise<GitHubApiCredential | null> =
    opts.credentialProvider
      ? async (companyId: string) => normalizeCredential(await opts.credentialProvider!(companyId))
      : Object.prototype.hasOwnProperty.call(opts, "tokenProvider") && opts.tokenProvider !== undefined
        ? async (companyId: string) => {
            const raw = typeof opts.tokenProvider === "function" ? await opts.tokenProvider(companyId) : opts.tokenProvider;
            const token = raw?.trim();
            return token ? { token, source: "company_secret", secretName: null } : null;
          }
        : (companyId: string) => resolveGitHubApiCredential(db, companyId, { secretNames });
// Cache repository-visibility probe results so many objects in the same repo
  // share a single probe instead of each issuing its own request every refresh
  // cycle. Only determined outcomes ("visible"/"hidden") are cached; uncertain
  // probes are retried on the next cycle. The cache is keyed per company+repo+
  // credential fingerprint so a verdict obtained under one token is never
  // reused after the company rotates its credentials — that would freeze a
  // reference as "probe-verified not-found" using an out-of-date result.

  const probeCache = new Map<string, { outcome: RepoProbeOutcome; expiresAt: number }>();
  async function cachedProbeRepoVisibility(
    companyId: string,
    identity: GitHubObjectIdentity,
    headers: Record<string, string>,
  ): Promise<RepoProbeOutcome> {
    const credentialFingerprint = createHash("sha256").update(headers.authorization ?? "anonymous").digest("hex");
    const key = `${companyId}\u0000${credentialFingerprint}\u0000${identity.owner.toLowerCase()}\u0000${identity.repo.toLowerCase()}`;
    const cached = probeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.outcome;
    const outcome = await probeRepoVisibility(identity, { fetch: fetchImpl, headers });
    if (outcome.visibility === "visible" || outcome.visibility === "hidden") {
      probeCache.set(key, { outcome, expiresAt: Date.now() + GITHUB_OBJECT_TTL_SECONDS * 1000 });
    }
    return outcome;
  }

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

        let credential: GitHubApiCredential | null = null;
        try {
          credential = await credentialProvider(companyId);
        } catch {
          return {
            ok: false,
            liveness: "auth_required",
            errorCode: "github_token_unavailable",
            errorMessage: "Configured GitHub credentials could not be resolved.",
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }
        const token = credential?.token?.trim() || null;
        const authenticated = Boolean(token);
        // A server-environment token is instance-wide, so it can see repositories this
        // company cannot. Only a company-scoped credential may resolve a private
        // repository for company display; a server token is limited to public repos.
        const companyScoped = credential?.source !== "server_env";
        const headers: Record<string, string> = {
          accept: "application/vnd.github+json",
          "user-agent": "paperclip-external-object-resolver",
          "x-github-api-version": "2022-11-28",
        };
        if (token) headers.authorization = `Bearer ${token}`;

        if (!companyScoped) {
          // A server-environment token is instance-wide, so it can read repositories
          // this company cannot. Before reading with it, verify that the repository is
          // public RIGHT NOW. Never serve this authorization decision from the probe
          // cache: a repository can become private inside the cache TTL, and a cached
          // "public" verdict must not authorize a later read of its private contents.
          // The cache is still used below to classify a 404, where a stale verdict can
          // only make the object look deleted — it can never expose private data.
          const probe = await probeRepoVisibility(identity, { fetch: fetchImpl, headers });
          if (probe.visibility === "hidden") {
            return {
              ok: false,
              liveness: "auth_required",
              errorCode: "github_repo_not_accessible",
              errorMessage: `GitHub returned not-found for ${identity.owner}/${identity.repo}. The repository may be private, deleted, or the configured GitHub credentials may lack access to it.`,
              retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
            };
          }
          if (probe.visibility === "rate_limited") {
            return rateLimitedResult(authenticated, GITHUB_OBJECT_TTL_SECONDS);
          }
          if (probe.visibility === "uncertain") {
            return {
              ok: false,
              liveness: "unreachable",
              errorCode: "github_repo_probe_failed",
              errorMessage: "GitHub could not verify this repository while checking this object.",
              retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
            };
          }
          // Require positive proof that the repository is public before reading
          // with the instance-wide server token. A private verdict and a probe
          // response that does not confirm public visibility both fail closed, so
          // the server token can never fetch private details for a company that
          // did not authorize it.
          if (probe.isPrivate !== false) {
            return {
              ok: false,
              liveness: "auth_required",
              errorCode: "github_repo_requires_company_token",
              errorMessage: probe.isPrivate === true
                ? `The ${identity.owner}/${identity.repo} repository is private. Add a GitHub token for this company to refresh this object.`
                : `The ${identity.owner}/${identity.repo} repository visibility could not be confirmed as public. Add a GitHub token for this company to refresh this object.`,
              retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
            };
          }
        }

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
          // GitHub deliberately returns 404 for repositories the credentials cannot
          // see, to avoid leaking that a private repo exists. A 404 therefore means
          // either "object deleted/never existed" or "repo private / no access".
          // Probe the repository metadata to classify: if the repo itself is visible
          // the object truly is gone; if it is not, surface credentials-needed
          // instead of permanently freezing a reference as "Not found".
          const probe = await cachedProbeRepoVisibility(companyId, identity, headers);
          if (probe.visibility === "visible") {
            return { ok: true, snapshot: notFoundSnapshot(identity, etag) };
          }
          if (probe.visibility === "hidden") {
            return {
              ok: false,
              liveness: "auth_required",
              errorCode: "github_repo_not_accessible",
              errorMessage: `GitHub returned not-found for ${identity.owner}/${identity.repo}. The repository may be private, deleted, or the configured GitHub credentials may lack access to it.`,
              retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
            };
          }
          if (probe.visibility === "rate_limited") {
            return rateLimitedResult(authenticated, GITHUB_OBJECT_TTL_SECONDS);
          }
          return {
            ok: false,
            liveness: "unreachable",
            errorCode: "github_repo_probe_failed",
            errorMessage: "GitHub could not verify this repository while checking this object.",
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }

        const failure = failureFromGitHubResponse(response, authenticated);
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

        return {
          ok: true,
          snapshot: objectType === "pull_request"
            ? pullRequestSnapshot(identity, body, etag)
            : issueSnapshot(identity, body, etag),
        };
      },
    };
  }

  return {
    detector,
    resolvers: [resolver("pull_request"), resolver("issue")],
  };
}
