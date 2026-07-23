/**
 * When a board issue is marked `done`, optionally merge linked GitHub pull requests.
 *
 * - **Policy:** Per-project `executionWorkspacePolicy.pullRequestPolicy.disableAutoMergeOnIssueDone`
 *   opts out. When absent, auto-merge is enabled (company default).
 * - **Auth:** `PAPERCLIP_GITHUB_PR_MERGE_TOKEN` or `GITHUB_TOKEN` — a token with `repo` scope
 *   (or GitHub App installation token with contents + pull_requests). Documented for operators;
 *   not stored in the database in this path.
 * - **PR discovery:** `pull_request` work products (GitHub URLs) plus `github.com/{owner}/{repo}/pull/{n}`
 *   links in the issue title and description.
 * - **Safety:** Uses the GitHub merge API only when the PR reports `mergeable` and does not
 *   override branch protection (no admin merge, no force).
 */
import type { IssueWorkProduct } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";

const PR_URL_RE = /https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\b/g;

export type GitHubPrRef = { owner: string; repo: string; number: number; hostname: string };

function resolveMergeToken(): string | null {
  const a = process.env.PAPERCLIP_GITHUB_PR_MERGE_TOKEN?.trim();
  if (a) return a;
  const b = process.env.GITHUB_TOKEN?.trim();
  if (b) return b;
  return null;
}

export function parseGitHubPrUrl(rawUrl: string | null | undefined): GitHubPrRef | null {
  if (!rawUrl) return null;
  const u = rawUrl.trim();
  const m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/?|\?|#|$)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]), hostname: "github.com" };
}

function collectPrUrlsFromText(text: string | null | undefined, into: Map<string, GitHubPrRef>) {
  if (!text) return;
  PR_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PR_URL_RE.exec(text)) !== null) {
    const ref: GitHubPrRef = {
      owner: m[1],
      repo: m[2],
      number: Number(m[3]),
      hostname: "github.com",
    };
    into.set(`${ref.owner}/${ref.repo}#${ref.number}`, ref);
  }
}

function prKey(ref: GitHubPrRef) {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

type PullRequestPolicy = {
  disableAutoMergeOnIssueDone?: boolean;
  mergeMethod?: "merge" | "squash" | "rebase";
};

function readPullRequestPolicy(raw: unknown): PullRequestPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const mergeMethodRaw = o.mergeMethod;
  const mergeMethod =
    mergeMethodRaw === "merge" || mergeMethodRaw === "squash" || mergeMethodRaw === "rebase"
      ? mergeMethodRaw
      : undefined;
  return {
    ...(o.disableAutoMergeOnIssueDone === true ? { disableAutoMergeOnIssueDone: true } : {}),
    ...(mergeMethod ? { mergeMethod } : {}),
  };
}

async function githubJson(
  token: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const { timeoutMs = 25_000, ...rest } = init;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: ac.signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

type GhPull = {
  html_url?: string;
  merged?: boolean;
  state?: string;
  mergeable?: boolean | null;
  mergeable_state?: string;
  title?: string;
};

async function fetchPull(token: string, ref: GitHubPrRef, attempt = 0): Promise<GhPull | null> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const { ok, json } = await githubJson(token, url);
  if (!ok || !json || typeof json !== "object") {
    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 2000));
      return fetchPull(token, ref, attempt + 1);
    }
    return null;
  }
  return json as GhPull;
}

/** Wait briefly when GitHub has not finished computing mergeable. */
async function resolveMergeablePull(token: string, ref: GitHubPrRef): Promise<GhPull | null> {
  for (let i = 0; i < 3; i++) {
    const pull = await fetchPull(token, ref, 0);
    if (!pull) return null;
    if (pull.merged === true) return pull;
    if (pull.mergeable !== null) return pull;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return fetchPull(token, ref, 0);
}

function formatMergeError(json: unknown): string {
  if (json && typeof json === "object" && "message" in json && typeof (json as { message: unknown }).message === "string") {
    return (json as { message: string }).message;
  }
  return "merge request failed";
}

export type AutoMergeOnIssueDoneInput = {
  issue: {
    id: string;
    projectId: string | null;
    title: string;
    description: string | null;
    identifier: string | null;
  };
  workProducts: IssueWorkProduct[];
  mergeToken: string;
  mergeMethod: "merge" | "squash" | "rebase";
};

export type PrAutoMergeLine =
  | { pr: GitHubPrRef; result: "merged"; htmlUrl: string }
  | { pr: GitHubPrRef; result: "skipped"; reason: "already_merged" | "closed"; htmlUrl: string }
  | {
      pr: GitHubPrRef;
      result: "failed";
      reason: "not_mergeable" | "blocked" | "behind" | "draft" | "api_error" | "merge_rejected";
      detail: string;
      htmlUrl: string;
    };

export async function runGithubPullRequestAutoMergeForDoneIssue(
  input: AutoMergeOnIssueDoneInput,
): Promise<PrAutoMergeLine[]> {
  const { issue, workProducts, mergeToken, mergeMethod } = input;
  const byKey = new Map<string, GitHubPrRef>();
  for (const wp of workProducts) {
    if (wp.type !== "pull_request") continue;
    const ref = parseGitHubPrUrl(wp.url);
    if (ref) byKey.set(prKey(ref), ref);
  }
  collectPrUrlsFromText(issue.title, byKey);
  collectPrUrlsFromText(issue.description, byKey);

  const results: PrAutoMergeLine[] = [];
  for (const ref of byKey.values()) {
    const pull = await resolveMergeablePull(mergeToken, ref);
    const htmlUrl = pull?.html_url ?? `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;

    if (!pull) {
      results.push({
        pr: ref,
        result: "failed",
        reason: "api_error",
        detail: "Could not load pull request from GitHub (not found or API error).",
        htmlUrl,
      });
      continue;
    }
    if (pull.merged === true || pull.state === "closed") {
      const reason = pull.merged === true ? "already_merged" : "closed";
      results.push({ pr: ref, result: "skipped", reason, htmlUrl: pull.html_url ?? htmlUrl });
      continue;
    }
    if (pull.mergeable === false) {
      results.push({
        pr: ref,
        result: "failed",
        reason: "not_mergeable",
        detail: `mergeable_state=${String(pull.mergeable_state)} — resolve conflicts in GitHub.`,
        htmlUrl,
      });
      continue;
    }
    if (pull.mergeable === true && pull.mergeable_state !== "clean") {
      const st = String(pull.mergeable_state ?? "unknown");
      const reason =
        st === "behind" ? "behind" : st === "blocked" || st === "unstable" ? "blocked" : st === "draft" ? "draft" : "not_mergeable";
      results.push({
        pr: ref,
        result: "failed",
        reason: reason as "behind" | "blocked" | "draft" | "not_mergeable",
        detail: `Branch protection or required checks are not satisfied (mergeable_state=${st}). Fix CI, reviews, or update the branch in GitHub — Paperclip does not override protection.`,
        htmlUrl,
      });
      continue;
    }
    if (pull.mergeable === null) {
      results.push({
        pr: ref,
        result: "failed",
        reason: "not_mergeable",
        detail: "GitHub has not finished computing merge status yet; try again in a moment.",
        htmlUrl,
      });
      continue;
    }

    const mergeUrl = `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/merge`;
    const { ok, json } = await githubJson(mergeToken, mergeUrl, {
      method: "PUT",
      body: JSON.stringify({ merge_method: mergeMethod }),
    });
    if (ok) {
      results.push({ pr: ref, result: "merged", htmlUrl: pull.html_url ?? htmlUrl });
    } else {
      results.push({
        pr: ref,
        result: "failed",
        reason: "merge_rejected",
        detail: formatMergeError(json),
        htmlUrl: pull.html_url ?? htmlUrl,
      });
    }
  }

  return results;
}

export function formatAutoMergeReportMarkdown(results: PrAutoMergeLine[], issueIdentifier: string | null): string {
  const head = `**Auto-merge (GitHub)** for ${issueIdentifier ?? "issue"}`;
  if (results.length === 0) {
    return `${head}\n\nNo linked GitHub pull requests were found (add a \`pull_request\` work product or link a PR URL in the title/description).`;
  }
  const lines = results.map((r) => {
    if (r.result === "merged") {
      return `- Merged: ${r.htmlUrl}`;
    }
    if (r.result === "skipped") {
      return `- Skipped (${r.reason}): ${r.htmlUrl}`;
    }
    return `- Failed: ${r.htmlUrl} — ${r.detail}`;
  });
  return `${head}\n\n${lines.join("\n")}`;
}

export function shouldSkipAutoMergeForProjectPolicy(project: { executionWorkspacePolicy: unknown } | null | undefined) {
  if (!project) return { skip: false as const, prPolicy: {} as PullRequestPolicy };
  const parsed = parseProjectExecutionWorkspacePolicy(project.executionWorkspacePolicy);
  const prPolicy = readPullRequestPolicy(parsed?.pullRequestPolicy);
  if (prPolicy.disableAutoMergeOnIssueDone === true) {
    return { skip: true as const, prPolicy };
  }
  return { skip: false as const, prPolicy };
}

function pickMergeMethod(prPolicy: PullRequestPolicy): "merge" | "squash" | "rebase" {
  return prPolicy.mergeMethod ?? "squash";
}

export type ScheduleIssueAutoMergeContext = {
  workProducts: IssueWorkProduct[];
  project: { executionWorkspacePolicy: unknown } | null;
};

/**
 * Fire-and-forget: resolves policy, token, and GitHub calls; posts a system comment with outcomes.
 * Never throws to the route handler; logs failures.
 */
export function scheduleAutoMergeOnIssueMarkedDone(input: {
  issue: {
    id: string;
    projectId: string | null;
    title: string;
    description: string | null;
    identifier: string | null;
  };
  getContext: () => Promise<ScheduleIssueAutoMergeContext>;
  addSystemComment: (body: string) => Promise<unknown>;
  workProductUpdate?: (id: string, patch: { status: IssueWorkProduct["status"] }) => Promise<unknown>;
}): void {
  void (async () => {
    try {
      const { issue, getContext, addSystemComment, workProductUpdate } = input;
      const { workProducts, project } = await getContext();
      const { skip, prPolicy } = shouldSkipAutoMergeForProjectPolicy(project);
      if (skip) return;

      const hasGithubPr = workProducts.some((wp) => wp.type === "pull_request" && parseGitHubPrUrl(wp.url));
      const hasPrUrlInText = [issue.title, issue.description].some(
        (t) => t && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(t),
      );
      const expectPr = hasGithubPr || hasPrUrlInText;

      if (!expectPr) {
        return;
      }

      const token = resolveMergeToken();
      if (!token) {
        await addSystemComment(
          `**Auto-merge (GitHub)** for ${issue.identifier ?? "this issue"}\n\n` +
            "Linked pull request(s) were found, but **no GitHub token** is configured on the Paperclip server. " +
            "Set `PAPERCLIP_GITHUB_PR_MERGE_TOKEN` (or `GITHUB_TOKEN`) with permission to merge PRs for the target repos, then mark the issue done again (or re-run the merge manually in GitHub).",
        );
        return;
      }

      const lines = await runGithubPullRequestAutoMergeForDoneIssue({
        issue,
        workProducts,
        mergeToken: token,
        mergeMethod: pickMergeMethod(prPolicy),
      });
      const body = formatAutoMergeReportMarkdown(lines, issue.identifier);
      await addSystemComment(body);

      if (workProductUpdate) {
        for (const wp of workProducts) {
          if (wp.type !== "pull_request" || !parseGitHubPrUrl(wp.url)) continue;
          const key = prKey(parseGitHubPrUrl(wp.url)!);
          const matched = lines.find(
            (l) => l.result === "merged" && prKey(l.pr) === key,
          );
          if (matched) {
            await workProductUpdate(wp.id, { status: "merged" });
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, "issue auto-merge: unexpected failure");
    }
  })();
}
