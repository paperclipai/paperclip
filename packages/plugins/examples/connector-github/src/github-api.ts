import type { PluginContext } from "@paperclipai/plugin-sdk";

type GitHubIssuePayload = {
  title: string;
  body?: string;
  state?: "open" | "closed";
};

type GitHubCommentPayload = {
  body: string;
};

type GitHubIssueResponse = {
  number: number;
  html_url: string;
};

type GitHubCommentResponse = {
  id: number;
  html_url: string;
};

async function ghFetch(
  ctx: PluginContext,
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<Response> {
  return await ctx.http.fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

export async function createGitHubIssue(
  ctx: PluginContext,
  token: string,
  owner: string,
  repo: string,
  payload: GitHubIssuePayload,
): Promise<GitHubIssueResponse> {
  const res = await ghFetch(ctx, token, "POST", `https://api.github.com/repos/${owner}/${repo}/issues`, payload);
  if (!res.ok) {
    throw new Error(`GitHub createIssue failed: ${res.status} ${await res.text()}`);
  }
  return await res.json() as GitHubIssueResponse;
}

export async function updateGitHubIssue(
  ctx: PluginContext,
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  payload: Partial<GitHubIssuePayload>,
): Promise<GitHubIssueResponse> {
  const res = await ghFetch(ctx, token, "PATCH", `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, payload);
  if (!res.ok) {
    throw new Error(`GitHub updateIssue failed: ${res.status} ${await res.text()}`);
  }
  return await res.json() as GitHubIssueResponse;
}

/**
 * Replace all priority:* labels on a GitHub issue with the given set.
 * Non-priority labels are preserved — only labels matching PRIORITY_LABEL_PREFIX are touched.
 */
export async function syncGitHubPriorityLabels(
  ctx: PluginContext,
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  priorityLabel: string | null,
): Promise<void> {
  // Fetch current labels
  const res = await ghFetch(ctx, token, "GET", `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/labels`);
  if (!res.ok) {
    throw new Error(`GitHub getLabels failed: ${res.status} ${await res.text()}`);
  }
  const current = await res.json() as Array<{ name: string }>;
  const nonPriority = current.map(l => l.name).filter(n => !n.startsWith("priority:"));
  const next = priorityLabel ? [...nonPriority, priorityLabel] : nonPriority;

  const setRes = await ghFetch(ctx, token, "PUT", `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { labels: next });
  if (!setRes.ok) {
    throw new Error(`GitHub setLabels failed: ${setRes.status} ${await setRes.text()}`);
  }
}

export async function createGitHubComment(
  ctx: PluginContext,
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<GitHubCommentResponse> {
  const payload: GitHubCommentPayload = { body };
  const res = await ghFetch(ctx, token, "POST", `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, payload);
  if (!res.ok) {
    throw new Error(`GitHub createComment failed: ${res.status} ${await res.text()}`);
  }
  return await res.json() as GitHubCommentResponse;
}
