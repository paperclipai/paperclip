/**
 * Verifies that GitHub commit evidence cited in issue comments is actually
 * reachable on the remote repository, not just a locally-constructed URL
 * pointing at an unpushed commit.
 *
 * The validator checks both commit links and PR links because dependency-
 * sensitive tasks need landed evidence, not just remote-visible evidence.
 */

import { logger } from "../middleware/logger.js";

const GITHUB_COMMIT_URL_CAPTURE_RE =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/commit\/([0-9a-fA-F]{7,40})/g;

const GITHUB_PR_URL_CAPTURE_RE =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

const GITHUB_PR_LINK_RE =
  /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

const VERIFY_TIMEOUT_MS = 10_000;

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface GitHubCommitRef {
  owner: string;
  repo: string;
  sha: string;
  url: string;
}

export interface GitHubPullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface GitHubEvidenceTarget extends GitHubRepoRef {
  baseRef: string | null;
}

type GitHubRepoMetadata = {
  accessible: boolean;
  softPass: boolean;
  defaultBranch: string | null;
  error?: string;
};

type CommitVerificationResult = {
  exists: boolean;
  softPass: boolean;
  error?: string;
};

type CommitLandingResult = {
  landed: boolean;
  softPass: boolean;
  error?: string;
};

type PullRequestVerificationResult = {
  merged: boolean;
  softPass: boolean;
  error?: string;
};

function buildGitHubHeaders() {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Paperclip-Evidence-Validator",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function normalizeGitHubRepoSegment(value: string) {
  return value.trim().toLowerCase();
}

function sameGitHubRepo(left: GitHubRepoRef, right: GitHubRepoRef) {
  return (
    normalizeGitHubRepoSegment(left.owner) === normalizeGitHubRepoSegment(right.owner) &&
    normalizeGitHubRepoSegment(left.repo) === normalizeGitHubRepoSegment(right.repo)
  );
}

function cacheKeyForRepo(ref: GitHubRepoRef) {
  return `${normalizeGitHubRepoSegment(ref.owner)}/${normalizeGitHubRepoSegment(ref.repo)}`;
}

function readNonEmptyString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fetchGitHub(
  url: string,
  headers: Record<string, string>,
): Promise<
  | {
      response: Response;
      networkError?: never;
    }
  | {
      response?: never;
      networkError: string;
    }
> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    return { response };
  } catch (err) {
    return {
      networkError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readRepoMetadata(
  ref: GitHubRepoRef,
  headers: Record<string, string>,
  cache: Map<string, GitHubRepoMetadata>,
): Promise<GitHubRepoMetadata> {
  const key = cacheKeyForRepo(ref);
  const cached = cache.get(key);
  if (cached) return cached;

  const token = process.env.GITHUB_TOKEN;
  const repoUrl = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
  const result = await fetchGitHub(repoUrl, headers);
  if ("networkError" in result) {
    const metadata: GitHubRepoMetadata = {
      accessible: false,
      softPass: true,
      defaultBranch: null,
      error: `Network error checking repo visibility: ${result.networkError}`,
    };
    logger.warn({ ref, error: result.networkError }, "Failed to check repo visibility, soft-passing");
    cache.set(key, metadata);
    return metadata;
  }

  const repoResponse = result.response;
  if (repoResponse.ok) {
    let defaultBranch: string | null = null;
    try {
      const payload = (await repoResponse.json()) as { default_branch?: unknown };
      defaultBranch = readNonEmptyString(payload?.default_branch);
    } catch {
      defaultBranch = null;
    }
    const metadata: GitHubRepoMetadata = {
      accessible: true,
      softPass: false,
      defaultBranch,
    };
    cache.set(key, metadata);
    return metadata;
  }

  if (repoResponse.status === 403 || repoResponse.status === 429) {
    const metadata: GitHubRepoMetadata = {
      accessible: false,
      softPass: true,
      defaultBranch: null,
      error: "GitHub API rate limited",
    };
    logger.warn(
      { ref, status: repoResponse.status },
      "GitHub API rate limited while checking repo metadata, soft-passing",
    );
    cache.set(key, metadata);
    return metadata;
  }

  if (repoResponse.status === 404) {
    const metadata: GitHubRepoMetadata = token
      ? {
          accessible: false,
          softPass: false,
          defaultBranch: null,
          error: `Tracked GitHub repo github.com/${ref.owner}/${ref.repo} was not found`,
        }
      : {
          accessible: false,
          softPass: true,
          defaultBranch: null,
          error: `Cannot verify tracked repo github.com/${ref.owner}/${ref.repo} — set GITHUB_TOKEN for private repo verification`,
        };
    cache.set(key, metadata);
    return metadata;
  }

  if (repoResponse.status >= 500) {
    const metadata: GitHubRepoMetadata = {
      accessible: false,
      softPass: true,
      defaultBranch: null,
      error: `GitHub API returned ${repoResponse.status}`,
    };
    logger.warn(
      { ref, status: repoResponse.status },
      "GitHub API error while checking repo metadata, soft-passing",
    );
    cache.set(key, metadata);
    return metadata;
  }

  const metadata: GitHubRepoMetadata = {
    accessible: false,
    softPass: false,
    defaultBranch: null,
    error: `GitHub API returned ${repoResponse.status} for github.com/${ref.owner}/${ref.repo}`,
  };
  cache.set(key, metadata);
  return metadata;
}

async function resolveTrackedBaseRef(
  target: GitHubEvidenceTarget,
  headers: Record<string, string>,
  cache: Map<string, GitHubRepoMetadata>,
): Promise<{ baseRef: string | null; softPass: boolean; error?: string }> {
  const explicitBaseRef = readNonEmptyString(target.baseRef);
  if (explicitBaseRef) {
    return { baseRef: explicitBaseRef, softPass: false };
  }

  const metadata = await readRepoMetadata(target, headers, cache);
  if (metadata.accessible) {
    return {
      baseRef: metadata.defaultBranch,
      softPass: false,
      error:
        metadata.defaultBranch == null
          ? `Tracked GitHub repo github.com/${target.owner}/${target.repo} does not report a default branch`
          : undefined,
    };
  }

  return {
    baseRef: null,
    softPass: metadata.softPass,
    error: metadata.error,
  };
}

export function parseGitHubRepoIdentityFromRepoUrl(repoUrl: string | null | undefined): GitHubRepoRef | null {
  const raw = readNonEmptyString(repoUrl);
  if (!raw) return null;

  const scpMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(raw);
  if (scpMatch) {
    return {
      owner: scpMatch[1]!,
      repo: scpMatch[2]!,
    };
  }

  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return {
      owner: parts[0]!,
      repo: parts[1]!.replace(/\.git$/i, ""),
    };
  } catch {
    return null;
  }
}

export function extractGitHubCommitRefs(body: string): GitHubCommitRef[] {
  const refs: GitHubCommitRef[] = [];
  for (const match of body.matchAll(GITHUB_COMMIT_URL_CAPTURE_RE)) {
    refs.push({
      owner: match[1],
      repo: match[2],
      sha: match[3],
      url: match[0],
    });
  }
  return refs;
}

export function extractGitHubPullRequestRefs(body: string): GitHubPullRequestRef[] {
  const refs: GitHubPullRequestRef[] = [];
  for (const match of body.matchAll(GITHUB_PR_URL_CAPTURE_RE)) {
    refs.push({
      owner: match[1]!,
      repo: match[2]!,
      number: Number.parseInt(match[3]!, 10),
      url: match[0]!,
    });
  }
  return refs;
}

export function containsGitHubPrLink(body: string): boolean {
  return GITHUB_PR_LINK_RE.test(body);
}

export interface VerifyResult {
  /** true when all commit refs are confirmed on the remote (or only PR links are present) */
  valid: boolean;
  /** human-readable explanation when invalid */
  error?: string;
  /** refs that could not be found on the remote */
  unreachableRefs?: GitHubCommitRef[];
  /** true when verification was skipped due to network/auth issues */
  softPass?: boolean;
  /** coarse failure kind for route-level error shaping */
  failureKind?: "unreachable" | "not_landed";
}

/**
 * Verify a single commit ref exists on GitHub.
 *
 * Strategy:
 * - 200 → exists
 * - 404 with GITHUB_TOKEN set → definitely not found (we have auth)
 * - 404 without GITHUB_TOKEN → check repo visibility; if public, commit
 *   is definitively missing; if private/inaccessible, soft-pass
 * - 403/429 (rate limit) → soft-pass
 * - network/timeout → soft-pass
 */
async function verifyCommitRef(
  ref: GitHubCommitRef,
  headers: Record<string, string>,
  repoCache: Map<string, GitHubRepoMetadata>,
): Promise<CommitVerificationResult> {
  const token = process.env.GITHUB_TOKEN;
  const commitUrl = `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${ref.sha}`;

  const result = await fetchGitHub(commitUrl, headers);
  if ("networkError" in result) {
    logger.warn({ ref, error: result.networkError }, "GitHub commit verification network error, soft-passing");
    return { exists: false, softPass: true, error: `Network error verifying commit: ${result.networkError}` };
  }

  const commitResponse = result.response;
  if (commitResponse.ok) {
    return { exists: true, softPass: false };
  }

  if (commitResponse.status === 403 || commitResponse.status === 429) {
    logger.warn(
      { ref, status: commitResponse.status },
      "GitHub API rate limited during commit verification, soft-passing",
    );
    return { exists: false, softPass: true, error: "GitHub API rate limited" };
  }

  if (commitResponse.status === 404) {
    // With auth token, 404 is definitive
    if (token) {
      return {
        exists: false,
        softPass: false,
        error: `Commit ${ref.sha.slice(0, 7)} not found on github.com/${ref.owner}/${ref.repo}`,
      };
    }

    // Without auth, 404 could mean private repo — check repo visibility
    const metadata = await readRepoMetadata(ref, headers, repoCache);
    if (metadata.accessible) {
      return {
        exists: false,
        softPass: false,
        error: `Commit ${ref.sha.slice(0, 7)} not found on github.com/${ref.owner}/${ref.repo} (public repo)`,
      };
    }
    logger.warn(
      { ref, error: metadata.error },
      "Cannot verify commit on inaccessible repo, soft-passing (set GITHUB_TOKEN for private repos)",
    );
    return {
      exists: false,
      softPass: true,
      error:
        metadata.error ??
        `Cannot verify commit on inaccessible repo github.com/${ref.owner}/${ref.repo} — set GITHUB_TOKEN for private repo verification`,
    };
  }

  // Other status codes (422 for malformed sha, 5xx, etc.)
  if (commitResponse.status >= 500) {
    logger.warn({ ref, status: commitResponse.status }, "GitHub API error, soft-passing");
    return { exists: false, softPass: true, error: `GitHub API returned ${commitResponse.status}` };
  }

  return {
    exists: false,
    softPass: false,
    error: `GitHub API returned ${commitResponse.status} for commit ${ref.sha.slice(0, 7)}`,
  };
}

async function verifyCommitLandedOnBaseRef(
  ref: GitHubCommitRef,
  baseRef: string,
  headers: Record<string, string>,
  repoCache: Map<string, GitHubRepoMetadata>,
): Promise<CommitLandingResult> {
  const compareUrl =
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/compare/` +
    `${encodeURIComponent(ref.sha)}...${encodeURIComponent(baseRef)}`;
  const result = await fetchGitHub(compareUrl, headers);
  if ("networkError" in result) {
    logger.warn(
      { ref, baseRef, error: result.networkError },
      "GitHub compare failed while checking landed commit evidence, soft-passing",
    );
    return {
      landed: false,
      softPass: true,
      error: `Network error verifying landed commit evidence: ${result.networkError}`,
    };
  }

  const compareResponse = result.response;
  if (compareResponse.ok) {
    let status: string | null = null;
    try {
      const payload = (await compareResponse.json()) as { status?: unknown };
      status = readNonEmptyString(payload?.status);
    } catch {
      status = null;
    }

    if (status === "behind" || status === "identical") {
      return { landed: true, softPass: false };
    }

    if (status === "ahead" || status === "diverged") {
      return {
        landed: false,
        softPass: false,
        error:
          `Commit ${ref.sha.slice(0, 7)} is not landed on github.com/${ref.owner}/${ref.repo}@${baseRef}. ` +
          `Paperclip only closes dependency-sensitive code tasks once their evidence is reachable from the tracked base branch.`,
      };
    }

    return {
      landed: false,
      softPass: false,
      error: `Could not determine whether commit ${ref.sha.slice(0, 7)} is landed on ${baseRef}`,
    };
  }

  if (compareResponse.status === 403 || compareResponse.status === 429) {
    logger.warn(
      { ref, baseRef, status: compareResponse.status },
      "GitHub compare rate limited while checking landed commit evidence, soft-passing",
    );
    return { landed: false, softPass: true, error: "GitHub API rate limited" };
  }

  if (compareResponse.status === 404) {
    const metadata = await readRepoMetadata(ref, headers, repoCache);
    if (!metadata.accessible && metadata.softPass) {
      return {
        landed: false,
        softPass: true,
        error: metadata.error,
      };
    }
    return {
      landed: false,
      softPass: false,
      error: `Tracked base branch ${baseRef} was not found on github.com/${ref.owner}/${ref.repo}`,
    };
  }

  if (compareResponse.status >= 500) {
    logger.warn(
      { ref, baseRef, status: compareResponse.status },
      "GitHub compare failed with 5xx while checking landed commit evidence, soft-passing",
    );
    return { landed: false, softPass: true, error: `GitHub API returned ${compareResponse.status}` };
  }

  return {
    landed: false,
    softPass: false,
    error: `GitHub API returned ${compareResponse.status} while checking whether commit ${ref.sha.slice(0, 7)} is landed`,
  };
}

async function verifyPullRequestRef(
  ref: GitHubPullRequestRef,
  trackedBaseRef: string | null,
  headers: Record<string, string>,
  repoCache: Map<string, GitHubRepoMetadata>,
): Promise<PullRequestVerificationResult> {
  const prUrl = `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const result = await fetchGitHub(prUrl, headers);
  if ("networkError" in result) {
    logger.warn(
      { ref, error: result.networkError },
      "GitHub pull request verification network error, soft-passing",
    );
    return {
      merged: false,
      softPass: true,
      error: `Network error verifying pull request: ${result.networkError}`,
    };
  }

  const prResponse = result.response;
  if (prResponse.ok) {
    let payload: {
      merged?: unknown;
      merged_at?: unknown;
      draft?: unknown;
      state?: unknown;
      base?: { ref?: unknown } | null;
    };
    try {
      payload = (await prResponse.json()) as typeof payload;
    } catch {
      return {
        merged: false,
        softPass: false,
        error: `Could not read pull request #${ref.number} metadata from github.com/${ref.owner}/${ref.repo}`,
      };
    }

    const merged = payload?.merged === true || readNonEmptyString(payload?.merged_at) !== null;
    const draft = payload?.draft === true;
    const state = readNonEmptyString(payload?.state) ?? "unknown";
    const baseRef = readNonEmptyString(payload?.base?.ref);

    if (!merged) {
      if (draft || state === "open") {
        return {
          merged: false,
          softPass: false,
          error: `Pull request #${ref.number} on github.com/${ref.owner}/${ref.repo} is not merged yet`,
        };
      }
      return {
        merged: false,
        softPass: false,
        error: `Pull request #${ref.number} on github.com/${ref.owner}/${ref.repo} was closed without merging`,
      };
    }

    if (trackedBaseRef && baseRef && baseRef !== trackedBaseRef) {
      return {
        merged: false,
        softPass: false,
        error:
          `Pull request #${ref.number} on github.com/${ref.owner}/${ref.repo} merged into ${baseRef}, ` +
          `not the tracked base branch ${trackedBaseRef}`,
      };
    }

    return { merged: true, softPass: false };
  }

  if (prResponse.status === 403 || prResponse.status === 429) {
    logger.warn(
      { ref, status: prResponse.status },
      "GitHub PR verification rate limited, soft-passing",
    );
    return { merged: false, softPass: true, error: "GitHub API rate limited" };
  }

  if (prResponse.status === 404) {
    const metadata = await readRepoMetadata(ref, headers, repoCache);
    if (!metadata.accessible && metadata.softPass) {
      return {
        merged: false,
        softPass: true,
        error: metadata.error,
      };
    }
    return {
      merged: false,
      softPass: false,
      error: `Pull request #${ref.number} was not found on github.com/${ref.owner}/${ref.repo}`,
    };
  }

  if (prResponse.status >= 500) {
    logger.warn({ ref, status: prResponse.status }, "GitHub PR API error, soft-passing");
    return { merged: false, softPass: true, error: `GitHub API returned ${prResponse.status}` };
  }

  return {
    merged: false,
    softPass: false,
    error: `GitHub API returned ${prResponse.status} for pull request #${ref.number}`,
  };
}

/**
 * Verify that all GitHub evidence in a comment body is reachable on the remote.
 * When a tracked target is supplied, Paperclip also verifies that the cited
 * evidence is landed on that tracked base branch.
 */
export async function verifyGitHubEvidenceIsRemoteVisible(
  commentBody: string,
  options?: { trackedTarget?: GitHubEvidenceTarget | null },
): Promise<VerifyResult> {
  const headers = buildGitHubHeaders();
  const repoCache = new Map<string, GitHubRepoMetadata>();
  const commitRefs = extractGitHubCommitRefs(commentBody);
  const prRefs = extractGitHubPullRequestRefs(commentBody);
  const trackedTarget = options?.trackedTarget ?? null;
  let trackedBaseRef: string | null = trackedTarget?.baseRef ?? null;

  if (trackedTarget) {
    const baseRefResult = await resolveTrackedBaseRef(trackedTarget, headers, repoCache);
    if (baseRefResult.baseRef) trackedBaseRef = baseRefResult.baseRef;
    else if (!baseRefResult.softPass && baseRefResult.error) {
      return {
        valid: false,
        failureKind: "not_landed",
        error: baseRefResult.error,
      };
    }
  }

  if (commitRefs.length === 0 && prRefs.length === 0) {
    return { valid: true };
  }

  const unreachable: GitHubCommitRef[] = [];
  const unverifiable: Array<{ ref: GitHubCommitRef; reason: string }> = [];

  for (const ref of commitRefs) {
    if (trackedTarget && !sameGitHubRepo(ref, trackedTarget)) {
      return {
        valid: false,
        failureKind: "not_landed",
        error:
          `GitHub evidence points at github.com/${ref.owner}/${ref.repo}, ` +
          `but the tracked repository is github.com/${trackedTarget.owner}/${trackedTarget.repo}`,
      };
    }

    const result = await verifyCommitRef(ref, headers, repoCache);
    if (!result.exists && result.softPass) {
      unverifiable.push({ ref, reason: result.error ?? "GitHub verification was unavailable" });
    } else if (!result.exists) {
      unreachable.push(ref);
    } else if (result.exists) {
      if (trackedBaseRef) {
        const landed = await verifyCommitLandedOnBaseRef(ref, trackedBaseRef, headers, repoCache);
        if (!landed.landed && !landed.softPass) {
          return {
            valid: false,
            failureKind: "not_landed",
            error: landed.error,
          };
        }
      }
    }
  }

  if (unreachable.length > 0) {
    const details = unreachable
      .map((r) => `\`${r.sha.slice(0, 7)}\` on github.com/${r.owner}/${r.repo}`)
      .join(", ");
    return {
      valid: false,
      failureKind: "unreachable",
      error: `Commit evidence is not reachable on the remote: ${details}. Push the commit(s) before marking the issue done.`,
      unreachableRefs: unreachable,
    };
  }

  for (const ref of prRefs) {
    if (trackedTarget && !sameGitHubRepo(ref, trackedTarget)) {
      return {
        valid: false,
        failureKind: "not_landed",
        error:
          `GitHub evidence points at github.com/${ref.owner}/${ref.repo}, ` +
          `but the tracked repository is github.com/${trackedTarget.owner}/${trackedTarget.repo}`,
      };
    }

    const result = await verifyPullRequestRef(ref, trackedBaseRef, headers, repoCache);
    if (!result.merged && !result.softPass) {
      return {
        valid: false,
        failureKind: "not_landed",
        error: result.error,
      };
    }
  }

  if (unverifiable.length > 0) {
    const details = unverifiable
      .map((item) => `\`${item.ref.sha.slice(0, 7)}\` on github.com/${item.ref.owner}/${item.ref.repo} (${item.reason})`)
      .join(", ");
    logger.warn({ unverifiable }, "Commit evidence verification was inconclusive due to GitHub/API access issues");
    return {
      valid: false,
      softPass: true,
      error: `Commit evidence could not be verified against GitHub: ${details}. Retry when GitHub API access is healthy, or configure GITHUB_TOKEN for private repositories.`,
    };
  }

  return { valid: true };
}
