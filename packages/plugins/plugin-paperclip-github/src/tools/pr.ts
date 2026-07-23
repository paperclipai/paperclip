import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { GitHubClient } from "../auth.js";
import type { ResolvedConfig } from "../config.js";
import { RefusalError, type HandlerEnv } from "../audit.js";

export interface OpenPrParams {
  issueId: string;
  branch: string;
  title: string;
  body: string;
  draft?: boolean;
  labels?: string[];
}

export interface OpenPrResult {
  prNumber: number;
  htmlUrl: string;
  headSha: string;
}

const ISSUE_REF_PATTERN = /(#\d+|paperclip[:/][a-z0-9-]+)/i;

export async function openPr(
  client: GitHubClient,
  cfg: ResolvedConfig,
  params: unknown,
  _runCtx: ToolRunContext,
  _env: HandlerEnv,
): Promise<ToolResult> {
  const p = parseOpenPr(params);

  // Refusal rule: "no merge without a tracked task". PRs that do not mention
  // an issue or paperclip task in the body bypass Delivery Lead.
  const bodyWithIssue = ensureIssueRef(p.body, p.issueId);
  if (!ISSUE_REF_PATTERN.test(bodyWithIssue)) {
    throw new RefusalError("missing_issue_ref", "PR body must reference issueId");
  }

  const { data } = await client.rest.pulls.create({
    owner: client.owner,
    repo: client.name,
    title: p.title,
    head: p.branch,
    base: cfg.defaultBranch,
    body: bodyWithIssue,
    draft: p.draft ?? true,
  });

  if (p.labels && p.labels.length > 0) {
    await client.rest.issues.addLabels({
      owner: client.owner,
      repo: client.name,
      issue_number: data.number,
      labels: p.labels,
    });
  }

  const result: OpenPrResult = {
    prNumber: data.number,
    htmlUrl: data.html_url,
    headSha: data.head.sha,
  };
  return { content: `opened PR #${data.number}`, data: result };
}

export interface GetPrResult {
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeStateStatus: string;
  headSha: string;
  baseSha: string;
  requiredChecks: string[];
  failingChecks: string[];
  passingChecks: string[];
  reviewDecision: string | null;
}

const GET_PR_QUERY = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        state
        isDraft
        mergeable
        mergeStateStatus
        baseRefOid
        headRefOid
        reviewDecision
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      conclusion
                      status
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface PrGraphqlResponse {
  repository: {
    pullRequest: {
      state: string;
      isDraft: boolean;
      mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
      mergeStateStatus: string;
      baseRefOid: string;
      headRefOid: string;
      reviewDecision: string | null;
      commits: {
        nodes: Array<{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: Array<
                  | { __typename: "CheckRun"; name: string; conclusion: string | null; status: string }
                  | { __typename: "StatusContext"; context: string; state: string }
                >;
              };
            } | null;
          };
        }>;
      };
    };
  };
}

export async function getPr(
  client: GitHubClient,
  params: unknown,
  _runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseGetPr(params);
  const resp = await client.graphql<PrGraphqlResponse>(GET_PR_QUERY, {
    owner: client.owner,
    repo: client.name,
    number: p.prNumber,
  });
  const pr = resp.repository.pullRequest;
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;

  const passingChecks: string[] = [];
  const failingChecks: string[] = [];

  for (const ctxNode of rollup?.contexts.nodes ?? []) {
    if (ctxNode.__typename === "CheckRun") {
      const ok = ctxNode.conclusion === "SUCCESS" || ctxNode.conclusion === "NEUTRAL" || ctxNode.conclusion === "SKIPPED";
      (ok ? passingChecks : failingChecks).push(ctxNode.name);
    } else {
      const ok = ctxNode.state === "SUCCESS";
      (ok ? passingChecks : failingChecks).push(ctxNode.context);
    }
  }

  const result: GetPrResult = {
    state: pr.state,
    draft: pr.isDraft,
    mergeable: pr.mergeable === "UNKNOWN" ? null : pr.mergeable === "MERGEABLE",
    mergeStateStatus: pr.mergeStateStatus,
    headSha: pr.headRefOid,
    baseSha: pr.baseRefOid,
    requiredChecks: passingChecks.concat(failingChecks),
    passingChecks,
    failingChecks,
    reviewDecision: pr.reviewDecision,
  };
  return { content: `PR #${p.prNumber}: ${pr.state} (${pr.mergeStateStatus})`, data: result };
}

function ensureIssueRef(body: string, issueId: string): string {
  if (ISSUE_REF_PATTERN.test(body)) return body;
  return `${body}\n\nFixes #${issueId}`;
}

function parseOpenPr(params: unknown): OpenPrParams {
  if (typeof params !== "object" || params === null) {
    throw new Error("openPr: params must be an object");
  }
  const p = params as Record<string, unknown>;
  if (typeof p.issueId !== "string" || !p.issueId.trim()) throw new Error("issueId required");
  if (typeof p.branch !== "string" || !p.branch.trim()) throw new Error("branch required");
  if (typeof p.title !== "string" || !p.title.trim()) throw new Error("title required");
  if (typeof p.body !== "string") throw new Error("body required");
  return {
    issueId: p.issueId,
    branch: p.branch,
    title: p.title,
    body: p.body,
    draft: typeof p.draft === "boolean" ? p.draft : undefined,
    labels: Array.isArray(p.labels) ? p.labels.filter((x): x is string => typeof x === "string") : undefined,
  };
}

function parseGetPr(params: unknown): { prNumber: number } {
  if (typeof params !== "object" || params === null) throw new Error("getPr: params must be an object");
  const p = params as Record<string, unknown>;
  if (typeof p.prNumber !== "number") throw new Error("prNumber required");
  return { prNumber: p.prNumber };
}
