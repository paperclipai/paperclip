import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { GitHubClient } from "../auth.js";
import { RefusalError } from "../audit.js";
type IssueMutation = "create_issue" | "update_issue" | "label_issue";
type IssueReadback = {
  number: number;
  html_url: string;
  title: string;
  state: string;
  labels: Array<string | { name?: string | null }>;
  body?: string | null;
  pull_request?: unknown;
};

type IssueSummary = {
  number: number;
  htmlUrl: string;
  title: string;
  state: string;
  labels: string[];
  body: string;
};

export async function createIssue(client: GitHubClient, params: unknown, _ctx: ToolRunContext): Promise<ToolResult> {
  const p = objectParams(params, "createIssue");
  const labels = readLabels(p, false);
  const { data } = await githubCall(
    () =>
      client.rest.issues.create({
        owner: client.owner,
        repo: client.name,
        title: readString(p, "title", true),
        body: readString(p, "body"),
        ...(labels && labels.length > 0 ? { labels } : {}),
      }),
    "create issue",
  );
  const issue = await readIssue(client, data.number);
  assertLabelsPresent(issue, labels ?? []);
  return issueResult("created", "create_issue", issue);
}

export async function updateIssue(client: GitHubClient, params: unknown, _ctx: ToolRunContext): Promise<ToolResult> {
  const p = objectParams(params, "updateIssue");
  const issueNumber = readPositiveInteger(p, "issueNumber");
  const title = optionalString(p, "title", true);
  const body = optionalString(p, "body");
  const state = readState(p);
  if (title === undefined && body === undefined && state === undefined) throw new Error("title, body, or state required");

  await githubCall(
    () =>
      client.rest.issues.update({
        owner: client.owner,
        repo: client.name,
        issue_number: issueNumber,
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(state !== undefined ? { state } : {}),
      }),
    "update issue",
  );
  const issue = await readIssue(client, issueNumber);
  for (const key of ["title", "body", "state"] as const) {
    if ({ title, body, state }[key] !== undefined && issue[key] !== { title, body, state }[key]) {
      throw new RefusalError("github_api_failed", `issue #${issue.number} ${key} readback did not match`);
    }
  }
  return issueResult("updated", "update_issue", issue);
}

export async function labelIssue(client: GitHubClient, params: unknown, _ctx: ToolRunContext): Promise<ToolResult> {
  const p = objectParams(params, "labelIssue");
  const issueNumber = readPositiveInteger(p, "issueNumber");
  const labels = readLabels(p, true)!;
  await githubCall(
    () => client.rest.issues.addLabels({ owner: client.owner, repo: client.name, issue_number: issueNumber, labels }),
    "label issue",
  );
  const issue = await readIssue(client, issueNumber);
  assertLabelsPresent(issue, labels);
  return issueResult("labeled", "label_issue", issue);
}

async function readIssue(client: GitHubClient, issueNumber: number): Promise<IssueSummary> {
  const { data } = await githubCall(
    () => client.rest.issues.get({ owner: client.owner, repo: client.name, issue_number: issueNumber }),
    "read issue",
  );
  const issue = data as unknown as IssueReadback;
  if (issue.pull_request) throw new RefusalError("not_an_issue", `#${issueNumber} is a pull request, not an issue`);
  return {
    number: issue.number,
    htmlUrl: issue.html_url,
    title: issue.title,
    state: issue.state,
    labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
    body: issue.body ?? "",
  };
}

function issueResult(verb: string, mutation: IssueMutation, issue: IssueSummary): ToolResult {
  return {
    content: `${verb} issue #${issue.number}`,
    data: { issueNumber: issue.number, htmlUrl: issue.htmlUrl, title: issue.title, state: issue.state, labels: issue.labels, body: issue.body, verified: true, mutation },
  };
}

function assertLabelsPresent(issue: IssueSummary, expected: string[]): void {
  const actual = new Set(issue.labels.map((label) => label.toLowerCase()));
  const missing = expected.filter((label) => !actual.has(label.toLowerCase()));
  if (missing.length > 0) throw new RefusalError("github_api_failed", `issue #${issue.number} missing labels after readback: ${missing.join(", ")}`);
}

function objectParams(params: unknown, name: string): Record<string, unknown> {
  if (typeof params !== "object" || params === null) throw new Error(`${name}: params must be an object`);
  return params as Record<string, unknown>;
}

function readLabels(p: Record<string, unknown>, required: boolean): string[] | undefined {
  if (p.labels === undefined) {
    if (required) throw new Error("labels required");
    return undefined;
  }
  if (!Array.isArray(p.labels)) throw new Error("labels must be an array");
  const labels = p.labels.filter((label): label is string => typeof label === "string" && label.trim() !== "");
  if (required && labels.length === 0) throw new Error("labels required");
  return labels;
}

function optionalString(p: Record<string, unknown>, key: string, nonEmpty = false): string | undefined {
  return p[key] === undefined ? undefined : readString(p, key, nonEmpty);
}

function readString(p: Record<string, unknown>, key: string, nonEmpty = false): string {
  if (typeof p[key] !== "string" || (nonEmpty && !p[key].trim())) throw new Error(`${key} required`);
  return p[key];
}

function readState(p: Record<string, unknown>): "open" | "closed" | undefined {
  if (p.state === undefined) return undefined;
  if (p.state !== "open" && p.state !== "closed") throw new Error("state must be open or closed");
  return p.state;
}

function readPositiveInteger(p: Record<string, unknown>, key: string): number {
  const value = p[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${key} required`);
  return value;
}

async function githubCall<T>(operation: () => Promise<T>, action: string): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof RefusalError) throw err;
    const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
    const message = err instanceof Error && err.message.trim() ? err.message : String(err);
    throw new RefusalError(status === 401 || status === 403 ? "authorization_failed" : "github_api_failed", `${action} failed${typeof status === "number" ? ` (${status})` : ""}: ${message}`);
  }
}
