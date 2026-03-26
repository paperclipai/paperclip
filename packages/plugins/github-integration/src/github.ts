/**
 * GitHub REST API client. Uses the plugin SDK's http.fetch for outbound calls
 * so all requests go through the capability-gated host proxy.
 */

const GITHUB_API = "https://api.github.com";

interface GitHubFetch {
  (url: string, init?: RequestInit): Promise<Response>;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string;
}

export interface GitHubSearchResult {
  total_count: number;
  items: GitHubIssue[];
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

const MAX_RETRIES = 1;
const BASE_RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps fetch with one retry for rate-limit (429) and transient server (5xx) errors.
 * On 429: honors the Retry-After header (seconds) before retrying.
 * On 5xx: uses exponential backoff starting at BASE_RETRY_DELAY_MS.
 */
async function fetchWithRetry(
  fetch: GitHubFetch,
  url: string,
  init?: RequestInit,
  attempt = 0,
): Promise<Response> {
  const res = await fetch(url, init);

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfterHeader = (res.headers as Headers).get("Retry-After");
    const delayMs = retryAfterHeader
      ? parseFloat(retryAfterHeader) * 1000
      : BASE_RETRY_DELAY_MS;
    await sleep(delayMs);
    return fetchWithRetry(fetch, url, init, attempt + 1);
  }

  if (res.status >= 500 && attempt < MAX_RETRIES) {
    await sleep(BASE_RETRY_DELAY_MS * Math.pow(2, attempt));
    return fetchWithRetry(fetch, url, init, attempt + 1);
  }

  return res;
}

export async function searchIssues(
  fetch: GitHubFetch,
  token: string,
  repo: string,
  query: string,
  perPage = 10,
): Promise<GitHubSearchResult> {
  const clampedPerPage = Math.max(1, Math.min(perPage, 100));
  const q = encodeURIComponent(`repo:${repo} is:issue ${query}`);
  const res = await fetchWithRetry(fetch, `${GITHUB_API}/search/issues?q=${q}&per_page=${clampedPerPage}`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`GitHub search failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<GitHubSearchResult>;
}

export async function getIssue(
  fetch: GitHubFetch,
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubIssue> {
  const res = await fetchWithRetry(fetch, `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`GitHub get issue failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<GitHubIssue>;
}

export async function updateIssueState(
  fetch: GitHubFetch,
  token: string,
  owner: string,
  repo: string,
  number: number,
  state: "open" | "closed",
): Promise<GitHubIssue> {
  const res = await fetchWithRetry(fetch, `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`, {
    method: "PATCH",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) throw new Error(`GitHub update issue failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<GitHubIssue>;
}

/**
 * Fetch all comments for an issue, paginating automatically.
 * GitHub returns up to 100 comments per page; we follow pagination
 * up to a safety cap to avoid runaway requests.
 */
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 10; // 1000 comments max

export async function listComments(
  fetch: GitHubFetch,
  token: string,
  owner: string,
  repo: string,
  number: number,
  since?: string,
): Promise<GitHubComment[]> {
  const all: GitHubComment[] = [];
  let page = 1;

  while (page <= MAX_COMMENT_PAGES) {
    const qs = new URLSearchParams({ per_page: String(COMMENTS_PER_PAGE), page: String(page) });
    if (since) qs.set("since", since);

    const res = await fetchWithRetry(
      fetch,
      `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/comments?${qs}`,
      { headers: headers(token) },
    );
    if (!res.ok) throw new Error(`GitHub list comments failed: ${res.status} ${res.statusText}`);

    const batch = (await res.json()) as GitHubComment[];
    all.push(...batch);

    // If we got fewer than a full page, there are no more pages
    if (batch.length < COMMENTS_PER_PAGE) break;
    page++;
  }

  return all;
}

export async function createComment(
  fetch: GitHubFetch,
  token: string,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<GitHubComment> {
  const res = await fetchWithRetry(
    fetch,
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/comments`,
    {
      method: "POST",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
  if (!res.ok) throw new Error(`GitHub create comment failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<GitHubComment>;
}

/**
 * Parse a GitHub issue reference from various formats:
 * - https://github.com/owner/repo/issues/123
 * - owner/repo#123
 * - #123 (requires default repo)
 */
export function parseGitHubIssueRef(
  ref: string,
  defaultRepo?: string,
): { owner: string; repo: string; number: number } | null {
  const urlMatch = ref.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: parseInt(urlMatch[3], 10) };
  }

  const refMatch = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (refMatch) {
    return { owner: refMatch[1], repo: refMatch[2], number: parseInt(refMatch[3], 10) };
  }

  const numMatch = ref.match(/^#?(\d+)$/);
  if (numMatch && defaultRepo) {
    const [owner, repo] = defaultRepo.split("/");
    if (owner && repo) return { owner, repo, number: parseInt(numMatch[1], 10) };
  }

  return null;
}
