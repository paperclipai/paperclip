import type { Db } from "@paperclipai/db";
import type { ExternalObjectCanonicalUrl } from "@paperclipai/shared";
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

const DEFAULT_GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;
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

function pullRequestSnapshot(identity: GitHubObjectIdentity, body: Record<string, unknown>, etag: string | null): ExternalObjectResolverSnapshot {
  const title = asString(body.title);
  const state = asString(body.state) ?? "unknown";
  const draft = asBoolean(body.draft) ?? false;
  const merged = (asBoolean(body.merged) ?? false) || Boolean(asString(body.merged_at));
  const authorLogin = asNestedString(body, "user", "login");
  const headRef = asNestedString(body, "head", "ref");
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
      ...(baseRef ? { baseRef } : {}),
      ...(reviewDecision ? { reviewDecision } : {}),
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
