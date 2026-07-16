import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export const GREEN_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
export const GREEN_STATUS_STATES = new Set(["SUCCESS"]);
export const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const GH_JSON_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export function parseArgs(argv, defaults = {}) {
  const args = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (path === "-") process.stdout.write(body);
  else writeFileSync(path, body);
}

export function ghJson(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: GH_JSON_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Surface gh diagnostics (warnings, deprecation/auth notices, error output)
  // on both success and failure — spawnSync captures stderr in every case.
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`gh ${args.join(" ")} exited with status ${result.status}`);
    error.stderr = result.stderr;
    error.status = result.status;
    throw error;
  }
  return JSON.parse(result.stdout);
}

export function isMissingPullRequestError(error) {
  const detail = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
  // Scope to the exact signals gh emits for a deleted/nonexistent PR: the GraphQL
  // "Could not resolve to a PullRequest" message and REST "Not Found (HTTP 404)".
  // A bare "Not Found" would over-match unrelated failures (e.g. "repository not
  // found"), so we require the HTTP 404 marker for the REST case.
  return /Could not resolve to a PullRequest|HTTP 404/i.test(detail);
}

export function normalizeRepository(value) {
  const match = String(value).match(/(?:github\.com[/:])?([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!match) throw new Error(`Invalid GitHub repository: ${value}`);
  return `${match[1]}/${match[2]}`;
}

export function repositoryFromGh() {
  return normalizeRepository(ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner);
}

export function prUrl(repository, number) {
  return `https://github.com/${repository}/pull/${number}`;
}

export function pullRequestIdentity(value) {
  const match = String(value).match(/(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
  if (!match) return null;
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${Number(match[3])}`;
}

export function extractPullRequestNumber(value, repository) {
  const identity = pullRequestIdentity(value);
  const prefix = `${repository.toLowerCase()}#`;
  return identity?.startsWith(prefix) ? Number(identity.slice(prefix.length)) : null;
}

export async function paperclipGet(path, { apiUrl, apiKey }) {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Paperclip GET ${path} failed (${response.status}): ${body}`);
  }
  return response.json();
}

export function issueSummary(issue) {
  return {
    issueId: issue.issueId,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId,
    updatedAt: issue.updatedAt,
  };
}

export function chooseOriginatingIssue(sourceIssues, pullRequestUrl) {
  const targetIdentity = pullRequestIdentity(pullRequestUrl);
  const workProductIssue = sourceIssues.find((issue) =>
    issue.workProducts?.some(
      (product) => product.type === "pull_request" && pullRequestIdentity(product.url) === targetIdentity,
    ),
  );
  if (workProductIssue) return { ...issueSummary(workProductIssue), selectionBasis: "pull_request_work_product" };

  const commentIssues = sourceIssues
    .filter((issue) => issue.mentions.some((mention) => mention.field === "comment"))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (commentIssues[0]) return { ...issueSummary(commentIssues[0]), selectionBasis: "comment_mention" };

  const recentIssue = [...sourceIssues].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return recentIssue ? { ...issueSummary(recentIssue), selectionBasis: "most_recent_mention" } : null;
}

export function normalizeCheck(context) {
  if (context.__typename === "CheckRun") {
    return {
      type: "check_run",
      name: context.name,
      status: context.status,
      conclusion: context.conclusion,
      detailsUrl: context.detailsUrl ?? null,
      workflowName: context.workflowName ?? null,
      green: context.status === "COMPLETED" && GREEN_CHECK_CONCLUSIONS.has(context.conclusion),
      pending: context.status !== "COMPLETED",
    };
  }
  return {
    type: "status_context",
    name: context.context,
    status: context.state,
    conclusion: context.state,
    detailsUrl: context.targetUrl ?? null,
    workflowName: null,
    green: GREEN_STATUS_STATES.has(context.state),
    pending: context.state === "PENDING" || context.state === "EXPECTED",
  };
}

export function reason(code, message, severity = "blocking", details = {}) {
  return { code, severity, message, ...details };
}

export function isTerminalIssue(status) {
  return TERMINAL_ISSUE_STATUSES.has(status);
}
