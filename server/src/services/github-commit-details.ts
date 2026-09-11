import type { Db } from "@paperclipai/db";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { secretService } from "./secrets.js";

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
  const tokenProvider = Object.prototype.hasOwnProperty.call(opts, "tokenProvider") && opts.tokenProvider !== undefined
    ? opts.tokenProvider
    : ((companyId: string) => defaultTokenProvider(db, companyId, secretNames));

  return async (companyId, reference) => {
    try {
      const token = (typeof tokenProvider === "function" ? await tokenProvider(companyId) : tokenProvider)?.trim() || null;
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "user-agent": "paperclip-work-product-resolver",
        "x-github-api-version": "2022-11-28",
      };
      if (token) headers.authorization = `Bearer ${token}`;

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
