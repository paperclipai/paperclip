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
