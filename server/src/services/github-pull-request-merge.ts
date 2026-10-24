import type { Db } from "@paperclipai/db";
import { createGitHubExternalObjectProvider } from "./github-external-object-provider.js";
import { extractGitHubPullRequestReferences, type GitHubPullRequestReference } from "./github-pull-request-references.js";
export { extractGitHubPullRequestReferences } from "./github-pull-request-references.js";
export type { GitHubPullRequestReference } from "./github-pull-request-references.js";

export type PullRequestMergeState = "merged" | "open" | "unknown";

export type PullRequestMergeDetails = {
  state: PullRequestMergeState;
  headRef: string | null;
  headSha: string | null;
  workProductState?: "open" | "draft" | "merged" | "closed";
  draft?: boolean;
  baseRef?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
};

export type PullRequestMergeStateResolver = (
  companyId: string,
  reference: GitHubPullRequestReference,
) => Promise<PullRequestMergeState>;

export type PullRequestMergeDetailsResolver = (
  companyId: string,
  reference: GitHubPullRequestReference,
) => Promise<PullRequestMergeDetails>;

export const PULL_REQUEST_CACHE_MAX_ENTRIES = 1_000;

export function setBoundedPullRequestCacheEntry<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
) {
  cache.delete(key);
  while (cache.size >= PULL_REQUEST_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  cache.set(key, value);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function createPullRequestMergeDetailsResolver(db: Db): PullRequestMergeDetailsResolver {
  const resolver = createGitHubExternalObjectProvider(db).resolvers
    .find((candidate) => candidate.objectType === "pull_request") ?? null;

  return async (companyId, reference) => {
    if (!resolver) return { state: "unknown", headRef: null, headSha: null };
    const result = await resolver.resolve({
      companyId,
      object: {
        externalId: `${reference.owner}/${reference.repo}#pull/${reference.number}`,
        sanitizedCanonicalUrl: `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`,
      } as never,
    });
    if (!result.ok) return { state: "unknown", headRef: null, headSha: null };
    const data = readRecord(result.snapshot.data);
    const statusKey = result.snapshot.statusKey;
    const workProductState = statusKey === "open" || statusKey === "draft" || statusKey === "merged" || statusKey === "closed"
      ? statusKey
      : undefined;
    return {
      state: statusKey === "merged" || data?.merged === true
        ? "merged"
        : statusKey === "open" || statusKey === "draft" || statusKey === "closed"
          ? "open"
          : "unknown",
      headRef: typeof data?.headRef === "string" ? data.headRef : null,
      headSha: typeof data?.headSha === "string" ? data.headSha : null,
      ...(workProductState ? { workProductState } : {}),
      draft: data?.draft === true,
      baseRef: typeof data?.baseRef === "string" ? data.baseRef : null,
      additions: typeof data?.additions === "number" ? data.additions : null,
      deletions: typeof data?.deletions === "number" ? data.deletions : null,
      changedFiles: typeof data?.changedFiles === "number" ? data.changedFiles : null,
    };
  };
}

export function createPullRequestMergeStateResolver(db: Db): PullRequestMergeStateResolver {
  const resolveDetails = createPullRequestMergeDetailsResolver(db);
  return async (companyId, reference) => (await resolveDetails(companyId, reference)).state;
}
