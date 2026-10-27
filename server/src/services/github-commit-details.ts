import type { Db } from "@paperclipai/db";
import {
  DEFAULT_GITHUB_TOKEN_SECRET_NAMES,
  resolveGitHubApiCredential,
  type GitHubApiCredential,
} from "./git-credentials.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type GitHubCommitReference = {
  host: "github.com";
  owner: string;
  repo: string;
  sha: string;
};

export type GitHubCommitDiffDetails = {
  additions: number;
  deletions: number;
  changedFiles: number;
};

export type GitHubCommitDiffDetailsResolver = (
  companyId: string,
  reference: GitHubCommitReference,
) => Promise<GitHubCommitDiffDetails | null>;

export interface GitHubCommitDetailsResolverOptions {
  fetch?: FetchLike;
  tokenProvider?: (companyId: string) => Promise<string | null> | string | null;
  credentialProvider?: (companyId: string) => Promise<GitHubApiCredential | null> | GitHubApiCredential | null;
  secretNames?: readonly string[];
}

const GITHUB_COMMIT_URL_PATTERN = /https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/commit\/([0-9a-f]{7,64})\b/i;
const GITHUB_COMMIT_SHORTHAND_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([0-9a-f]{7,64})$/i;

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeCredential(credential: GitHubApiCredential | null | undefined): GitHubApiCredential | null {
  const token = credential?.token?.trim();
  if (!token) return null;
  return { token, source: credential!.source, secretName: credential!.secretName ?? null };
}

export function extractGitHubCommitReference(values: readonly unknown[]): GitHubCommitReference | null {
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    const match = GITHUB_COMMIT_URL_PATTERN.exec(value) ?? GITHUB_COMMIT_SHORTHAND_PATTERN.exec(value);
    if (!match) continue;
    return {
      host: "github.com",
      owner: match[1]!,
      repo: match[2]!,
      sha: match[3]!,
    };
  }
  return null;
}

async function defaultCredentialProvider(db: Db, companyId: string, secretNames: readonly string[]) {
  return resolveGitHubApiCredential(db, companyId, { secretNames });
}

/** Return the repo's `private` flag, or null when the probe does not answer. */
async function probeRepoIsPrivate(
  reference: GitHubCommitReference,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<boolean | null> {
  try {
    const response = await fetchImpl(
      `${gitHubApiBase(reference.host)}/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}`,
      { headers },
    );
    if (!response.ok) return null;
    const body = record(await response.json());
    return typeof body?.private === "boolean" ? body.private : null;
  } catch {
    return null;
  }
}

function hasNextPage(response: Response): boolean {
  const link = response.headers.get("link");
  if (!link) return false;
  for (const part of link.split(",")) {
    const match = /^\s*<[^>]+>;\s*rel="([^"]+)"\s*$/.exec(part);
    if (match?.[1]?.split(/\s+/).includes("next")) return true;
  }
  return false;
}

export function createGitHubCommitDiffDetailsResolver(
  db: Db,
  opts: GitHubCommitDetailsResolverOptions = {},
): GitHubCommitDiffDetailsResolver {
  const fetchImpl = opts.fetch ?? ghFetch;
  const secretNames = opts.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  const credentialProvider: (companyId: string) => Promise<GitHubApiCredential | null> =
    opts.credentialProvider
      ? async (companyId: string) => normalizeCredential(await opts.credentialProvider!(companyId))
      : Object.prototype.hasOwnProperty.call(opts, "tokenProvider") && opts.tokenProvider !== undefined
        ? async (companyId: string) => {
            const raw = typeof opts.tokenProvider === "function" ? await opts.tokenProvider(companyId) : opts.tokenProvider;
            const token = raw?.trim();
            return token ? { token, source: "company_secret", secretName: null } : null;
          }
        : (companyId: string) => defaultCredentialProvider(db, companyId, secretNames);

  return async (companyId, reference) => {
    try {
      const credential = await credentialProvider(companyId);
      const token = credential?.token?.trim() || null;
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "user-agent": "paperclip-work-product-resolver",
        "x-github-api-version": "2022-11-28",
      };
      if (token) headers.authorization = `Bearer ${token}`;

      // A server-environment token is instance-wide. Do not use it to read a private
      // repository on behalf of one company; only a company-scoped credential may.
      if (credential?.source === "server_env") {
        const isPrivate = await probeRepoIsPrivate(reference, headers, fetchImpl);
        if (isPrivate !== false) return null;
      }

      const commitUrl = `${gitHubApiBase(reference.host)}/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/commits/${encodeURIComponent(reference.sha)}`;
      let additions: number | null = null;
      let deletions: number | null = null;
      let changedFiles = 0;
      let pages = 0;
      let morePages = true;
      while (morePages && pages < 30) {
        const url = `${commitUrl}?per_page=100&page=${pages + 1}`;
        const response = await fetchImpl(url, { headers });
        if (!response.ok) return null;
        const body = record(await response.json());
        if (!body) return null;
        if (pages === 0) {
          const stats = record(body.stats);
          additions = nonNegativeInteger(stats?.additions);
          deletions = nonNegativeInteger(stats?.deletions);
          if (additions === null || deletions === null) return null;
        }
        if (!Array.isArray(body.files)) return null;
        changedFiles += body.files.length;
        morePages = hasNextPage(response);
        pages += 1;
      }
      if (morePages || additions === null || deletions === null) return null;
      return { additions, deletions, changedFiles };
    } catch {
      return null;
    }
  };
}
