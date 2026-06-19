import type { IssuePrLink, IssuePrLinkState } from "@paperclipai/shared";

export interface ParsedGitHubPrUrl {
  hostname: string;
  owner: string;
  repo: string;
  number: number;
}

const GITHUB_PR_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

// Parses a GitHub (or GitHub Enterprise) pull-request URL into its parts.
// Returns null for anything that is not a `/{owner}/{repo}/pull/{number}` URL so
// non-PR links stay plain with no status badge.
export function parseGitHubPrUrl(url: string): ParsedGitHubPrUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const match = GITHUB_PR_PATH_RE.exec(parsed.pathname);
  if (!match) return null;
  const number = Number.parseInt(match[3]!, 10);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    hostname: parsed.hostname,
    owner: match[1]!,
    repo: match[2]!,
    number,
  };
}

export interface GitHubPullPayload {
  state?: string | null;
  draft?: boolean | null;
  merged?: boolean | null;
  merged_at?: string | null;
}

// Maps a GitHub pull-request API payload to our compact lifecycle state.
// Precedence: merged > draft > open/closed.
export function mapPullRequestState(payload: GitHubPullPayload): IssuePrLinkState {
  if (payload.merged === true || (payload.merged_at != null && payload.merged_at !== "")) {
    return "merged";
  }
  if (payload.state === "closed") return "closed";
  if (payload.draft === true) return "draft";
  return "open";
}

// Derives a stable identity for a PR link so cached status can survive user edits
// that only touch `title` (or reorder the list).
function prLinkKey(link: Pick<IssuePrLink, "url">): string {
  const parsed = parseGitHubPrUrl(link.url);
  if (parsed) {
    return `gh:${parsed.hostname.toLowerCase()}/${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}#${parsed.number}`;
  }
  return `url:${link.url.trim()}`;
}

// Merges incoming user-settable `{ url, title }` entries with any previously
// cached status for the same PR. Incoming entries that match an existing URL keep
// their fetched `state` / `checks` / `statusFetchedAt` / `statusError`; brand-new
// entries start with no cached status.
export function mergePrLinkStatus(
  existing: IssuePrLink[],
  incoming: Array<Pick<IssuePrLink, "url" | "title">>,
): IssuePrLink[] {
  const existingByKey = new Map<string, IssuePrLink>();
  for (const link of existing) {
    existingByKey.set(prLinkKey(link), link);
  }
  return incoming.map((entry) => {
    const prior = existingByKey.get(prLinkKey(entry));
    const merged: IssuePrLink = {
      url: entry.url,
      title: entry.title ?? null,
    };
    if (prior) {
      if (prior.state !== undefined) merged.state = prior.state;
      if (prior.checks !== undefined) merged.checks = prior.checks;
      if (prior.statusFetchedAt !== undefined) merged.statusFetchedAt = prior.statusFetchedAt;
      if (prior.statusError !== undefined) merged.statusError = prior.statusError;
    }
    return merged;
  });
}
