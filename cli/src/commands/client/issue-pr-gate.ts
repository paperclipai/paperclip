import { execFileSync } from "node:child_process";
import { Command } from "commander";
import {
  inferIssueBlockedReasonCodeFromExternalGate,
  ISSUE_GITHUB_PR_REQUIRED_REVIEWS,
  ISSUE_PREVIEW_SMOKE_STATUSES,
  type IssueBlockedReasonCode,
  type IssueExternalGate,
  type IssueGitHubPrCheckStatus,
  type IssueGitHubPrGateSnapshot,
  type IssueGitHubPrRequiredReview,
  type IssuePreviewProtectionStatus,
  type IssuePreviewSmokeStatus,
} from "@paperclipai/shared";
import { handleCommandError, printOutput } from "./common.js";

type PullRequestReviewNode = {
  authorLogin: string | null;
  state: string;
  submittedAt: string | null;
  commitOid: string | null;
};

type PullRequestGateInput = {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string | null;
  isDraft: boolean;
  mergeable: boolean | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  requiredChecks: string[];
  passedChecks: string[];
  failedChecks: string[];
  pendingChecks: string[];
  visibleReviews: PullRequestReviewNode[];
  unresolvedReviewThreads: number;
  viewerLogin: string | null;
  prAuthorLogin: string | null;
};

export type GitHubPrGatePacket = {
  blockedReasonCode: IssueBlockedReasonCode | null;
  externalGate: IssueExternalGate;
};

type IssuePrGateOptions = {
  repo: string;
  pr: string;
  requiredReview?: IssueGitHubPrRequiredReview;
  requiredCheck?: string[];
  previewUrl?: string;
  previewSmokeStatus?: IssuePreviewSmokeStatus;
  acceptedException?: boolean;
  exceptionNote?: string;
  capturedAt?: string;
  json?: boolean;
};

type GraphQlResponse = {
  data?: {
    viewer?: { login?: string | null } | null;
    repository?: {
      pullRequest?: {
        url: string;
        number: number;
        isDraft: boolean;
        mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
        mergeStateStatus?: string | null;
        reviewDecision?: string | null;
        headRefOid?: string | null;
        author?: { login?: string | null } | null;
        reviews?: {
          nodes?: Array<{
            state?: string | null;
            submittedAt?: string | null;
            author?: { login?: string | null } | null;
            commit?: { oid?: string | null } | null;
          } | null> | null;
        } | null;
        reviewThreads?: {
          nodes?: Array<{ isResolved?: boolean | null } | null> | null;
        } | null;
        commits?: {
          nodes?: Array<{
            commit?: {
              statusCheckRollup?: {
                contexts?: {
                  nodes?: Array<
                    | {
                        __typename?: "CheckRun";
                        name?: string | null;
                        conclusion?: string | null;
                        status?: string | null;
                      }
                    | {
                        __typename?: "StatusContext";
                        context?: string | null;
                        state?: string | null;
                      }
                    | null
                  > | null;
                } | null;
              } | null;
            } | null;
          } | null> | null;
        } | null;
      } | null;
    } | null;
  };
};

export function resolvePreviewProtectionStatus(input: {
  statusCode: number | null;
  error?: string | null;
}): IssuePreviewProtectionStatus {
  if (typeof input.statusCode !== "number") return input.error ? "error" : "unknown";
  if (input.statusCode === 401 || input.statusCode === 403) return "protected";
  if (input.statusCode >= 200 && input.statusCode < 400) return "open";
  return "error";
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function mergeableToBoolean(
  value: NonNullable<NonNullable<NonNullable<GraphQlResponse["data"]>["repository"]>["pullRequest"]>["mergeable"] | null | undefined,
): boolean | null {
  if (value === "MERGEABLE") return true;
  if (value === "CONFLICTING") return false;
  return null;
}

function parseEnumOption<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  optionName: string,
  fallback: T,
): T {
  if (!value?.trim()) return fallback;
  const normalized = value.trim() as T;
  if (allowed.includes(normalized)) return normalized;
  throw new Error(`Invalid ${optionName}: ${value}. Expected one of ${allowed.join(", ")}.`);
}

function classifyCheckState(name: string, state: "passed" | "failed" | "pending", target: Record<string, string[]>) {
  const list = target[state];
  if (!list.includes(name)) list.push(name);
}

function collectChecks(
  response: NonNullable<NonNullable<NonNullable<GraphQlResponse["data"]>["repository"]>["pullRequest"]>,
): {
  passedChecks: string[];
  failedChecks: string[];
  pendingChecks: string[];
} {
  const buckets = {
    passed: [] as string[],
    failed: [] as string[],
    pending: [] as string[],
  };
  const contexts = response.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  for (const node of contexts) {
    if (!node || typeof node !== "object") continue;
    if (node.__typename === "CheckRun") {
      const name = node.name?.trim();
      if (!name) continue;
      if (node.status !== "COMPLETED") {
        classifyCheckState(name, "pending", buckets);
        continue;
      }
      const conclusion = (node.conclusion ?? "").toUpperCase();
      if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) {
        classifyCheckState(name, "passed", buckets);
      } else if (conclusion) {
        classifyCheckState(name, "failed", buckets);
      } else {
        classifyCheckState(name, "pending", buckets);
      }
      continue;
    }
    if (node.__typename === "StatusContext") {
      const name = node.context?.trim();
      if (!name) continue;
      const state = (node.state ?? "").toUpperCase();
      if (state === "SUCCESS") {
        classifyCheckState(name, "passed", buckets);
      } else if (state === "FAILURE" || state === "ERROR") {
        classifyCheckState(name, "failed", buckets);
      } else {
        classifyCheckState(name, "pending", buckets);
      }
    }
  }
  return {
    passedChecks: dedupe(buckets.passed),
    failedChecks: dedupe(buckets.failed),
    pendingChecks: dedupe(buckets.pending),
  };
}

function computeChecksStatus(input: {
  requiredChecks: string[];
  passedChecks: string[];
  failedChecks: string[];
  pendingChecks: string[];
}): IssueGitHubPrCheckStatus | null {
  const requiredChecks = dedupe(input.requiredChecks);
  const passed = new Set(input.passedChecks);
  const failed = new Set(input.failedChecks);
  const pending = new Set(input.pendingChecks);
  const effectiveChecks = requiredChecks.length > 0
    ? requiredChecks
    : dedupe([...input.passedChecks, ...input.failedChecks, ...input.pendingChecks]);
  if (effectiveChecks.length === 0) return "unknown";
  if (effectiveChecks.some((check) => failed.has(check))) return "failing";
  if (effectiveChecks.some((check) => pending.has(check) || !passed.has(check))) return "pending";
  return "passing";
}

function computeCurrentViewerCanSatisfyReview(input: {
  requiredReview: IssueGitHubPrRequiredReview;
  viewerLogin: string | null;
  prAuthorLogin: string | null;
}): boolean | null {
  if (!input.viewerLogin) return null;
  if (input.requiredReview !== "non_author") return true;
  if (!input.prAuthorLogin) return null;
  return input.viewerLogin !== input.prAuthorLogin;
}

function selectLatestReviewsPerAuthor(reviews: PullRequestReviewNode[]): PullRequestReviewNode[] {
  const latestByAuthor = new Map<string, { review: PullRequestReviewNode; submittedAtMs: number; index: number }>();
  for (const [index, review] of reviews.entries()) {
    const authorLogin = review.authorLogin?.trim().toLowerCase();
    if (!authorLogin) continue;
    const submittedAtMs = review.submittedAt ? Date.parse(review.submittedAt) : Number.NEGATIVE_INFINITY;
    const existing = latestByAuthor.get(authorLogin);
    if (!existing) {
      latestByAuthor.set(authorLogin, { review, submittedAtMs, index });
      continue;
    }
    if (submittedAtMs > existing.submittedAtMs || (submittedAtMs === existing.submittedAtMs && index > existing.index)) {
      latestByAuthor.set(authorLogin, { review, submittedAtMs, index });
    }
  }
  return [...latestByAuthor.values()].map(({ review }) => review);
}

function computeReviewSatisfied(input: {
  requiredReview: IssueGitHubPrRequiredReview;
  visibleReviews: PullRequestReviewNode[];
  prAuthorLogin: string | null;
  reviewDecision: string | null;
}): boolean {
  if (input.requiredReview === "none") return true;
  const reviewDecision = input.reviewDecision?.trim().toUpperCase();
  if (reviewDecision === "CHANGES_REQUESTED" || reviewDecision === "REVIEW_REQUIRED") return false;
  const approvals = selectLatestReviewsPerAuthor(input.visibleReviews)
    .filter((review) => review.state.trim().toUpperCase() === "APPROVED");
  if (input.requiredReview === "any") return approvals.length > 0;
  const prAuthorLogin = input.prAuthorLogin?.trim().toLowerCase() ?? null;
  return approvals.some((review) => {
    const authorLogin = review.authorLogin?.trim().toLowerCase();
    return Boolean(authorLogin) && authorLogin !== prAuthorLogin;
  });
}

function isRequiredChecksSatisfied(requiredChecks: string[], checksStatus: IssueGitHubPrCheckStatus | null): boolean {
  return dedupe(requiredChecks).length === 0 || checksStatus === "passing";
}

function isPreviewSmokeSatisfied(status: IssuePreviewSmokeStatus): boolean {
  return status === "unknown" || status === "passed";
}

export function buildGitHubPrGatePacket(input: {
  pullRequest: PullRequestGateInput;
  requiredReview: IssueGitHubPrRequiredReview;
  previewProtectionStatus: IssuePreviewProtectionStatus;
  previewSmokeStatus: IssuePreviewSmokeStatus;
  acceptedException: boolean;
  exceptionNote?: string;
  capturedAt?: string;
}): GitHubPrGatePacket {
  const currentViewerCanSatisfyReview = computeCurrentViewerCanSatisfyReview({
    requiredReview: input.requiredReview,
    viewerLogin: input.pullRequest.viewerLogin,
    prAuthorLogin: input.pullRequest.prAuthorLogin,
  });
  const nonAuthorApprovalSatisfied = computeReviewSatisfied({
    requiredReview: input.requiredReview,
    visibleReviews: input.pullRequest.visibleReviews,
    prAuthorLogin: input.pullRequest.prAuthorLogin,
    reviewDecision: input.pullRequest.reviewDecision,
  });
  const checksStatus = computeChecksStatus({
    requiredChecks: input.pullRequest.requiredChecks,
    passedChecks: input.pullRequest.passedChecks,
    failedChecks: input.pullRequest.failedChecks,
    pendingChecks: input.pullRequest.pendingChecks,
  });
  const checksSatisfied = isRequiredChecksSatisfied(input.pullRequest.requiredChecks, checksStatus);
  const previewSmokeSatisfied = isPreviewSmokeSatisfied(input.previewSmokeStatus);
  const requiredSignal =
    input.acceptedException
      ? "accepted_exception"
      : input.requiredReview === "non_author" && currentViewerCanSatisfyReview === false && !nonAuthorApprovalSatisfied
        ? "accepted_exception"
        : input.requiredReview === "non_author"
          ? "github_non_author_approval"
          : "github_review_approved";
  const status =
    input.acceptedException
      ? "accepted_exception"
      : nonAuthorApprovalSatisfied && checksSatisfied && previewSmokeSatisfied
        ? "satisfied"
        : "pending";

  const githubPr: IssueGitHubPrGateSnapshot = {
    provider: "github",
    repoOwner: input.pullRequest.repoOwner,
    repoName: input.pullRequest.repoName,
    prNumber: input.pullRequest.prNumber,
    prUrl: input.pullRequest.prUrl,
    headSha: input.pullRequest.headSha,
    isDraft: input.pullRequest.isDraft,
    mergeable: input.pullRequest.mergeable,
    mergeStateStatus: input.pullRequest.mergeStateStatus,
    checksStatus,
    requiredChecks: dedupe(input.pullRequest.requiredChecks),
    passedChecks: dedupe(input.pullRequest.passedChecks),
    failedChecks: dedupe(input.pullRequest.failedChecks),
    pendingChecks: dedupe(input.pullRequest.pendingChecks),
    reviewDecision: input.pullRequest.reviewDecision,
    requiredReview: input.requiredReview,
    nonAuthorApprovalSatisfied,
    visibleReviews: input.pullRequest.visibleReviews,
    unresolvedReviewThreads: input.pullRequest.unresolvedReviewThreads,
    previewProtectionStatus: input.previewProtectionStatus,
    previewSmokeStatus: input.previewSmokeStatus,
    currentViewerLogin: input.pullRequest.viewerLogin,
    prAuthorLogin: input.pullRequest.prAuthorLogin,
    currentViewerCanSatisfyReview,
  };

  const externalGate: IssueExternalGate = {
    kind: "github_pr",
    status,
    requiredSignal,
    resolution: status === "pending"
      ? null
      : {
          signal: requiredSignal,
          capturedAt: input.capturedAt ?? null,
          note: input.acceptedException ? input.exceptionNote?.trim() ?? null : null,
        },
    githubPr,
  };

  return {
    blockedReasonCode: inferIssueBlockedReasonCodeFromExternalGate(externalGate),
    externalGate,
  };
}

function parseRepoSlug(value: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = value.trim().split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid repo slug: ${value}. Expected owner/repo.`);
  }
  return { owner, repo };
}

function collectPullRequestInput(input: {
  owner: string;
  repo: string;
  prNumber: number;
  requiredChecks: string[];
}): PullRequestGateInput {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      viewer {
        login
      }
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          url
          number
          isDraft
          mergeable
          mergeStateStatus
          reviewDecision
          headRefOid
          author {
            login
          }
          reviews(last: 100) {
            nodes {
              state
              submittedAt
              author {
                login
              }
              commit {
                oid
              }
            }
          }
          reviewThreads(first: 100) {
            nodes {
              isResolved
            }
          }
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
  const stdout = execFileSync(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `owner=${input.owner}`,
      "-f",
      `repo=${input.repo}`,
      "-F",
      `number=${input.prNumber}`,
      "-f",
      `query=${query}`,
    ],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(stdout) as GraphQlResponse;
  const pullRequest = parsed.data?.repository?.pullRequest;
  if (!pullRequest) {
    throw new Error(`Pull request #${input.prNumber} not found for ${input.owner}/${input.repo}`);
  }
  const { passedChecks, failedChecks, pendingChecks } = collectChecks(pullRequest);
  return {
    repoOwner: input.owner,
    repoName: input.repo,
    prNumber: pullRequest.number,
    prUrl: pullRequest.url,
    headSha: pullRequest.headRefOid ?? null,
    isDraft: pullRequest.isDraft,
    mergeable: mergeableToBoolean(pullRequest.mergeable as "MERGEABLE" | "CONFLICTING" | "UNKNOWN"),
    mergeStateStatus: pullRequest.mergeStateStatus ?? null,
    reviewDecision: pullRequest.reviewDecision ?? null,
    requiredChecks: dedupe(input.requiredChecks),
    passedChecks,
    failedChecks,
    pendingChecks,
    visibleReviews: (pullRequest.reviews?.nodes ?? [])
      .filter((review): review is NonNullable<typeof review> => Boolean(review?.state))
      .map((review) => ({
        authorLogin: review.author?.login ?? null,
        state: review.state ?? "COMMENTED",
        submittedAt: review.submittedAt ?? null,
        commitOid: review.commit?.oid ?? null,
      })),
    unresolvedReviewThreads: (pullRequest.reviewThreads?.nodes ?? []).filter((thread) => thread?.isResolved !== true).length,
    viewerLogin: parsed.data?.viewer?.login ?? null,
    prAuthorLogin: pullRequest.author?.login ?? null,
  };
}

async function probePreviewProtection(previewUrl: string | undefined): Promise<IssuePreviewProtectionStatus> {
  if (!previewUrl?.trim()) return "unknown";
  try {
    const res = await fetch(previewUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": "paperclipai issue pr-gate",
      },
    });
    return resolvePreviewProtectionStatus({ statusCode: res.status });
  } catch (error) {
    return resolvePreviewProtectionStatus({
      statusCode: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function registerIssuePrGateCommand(issue: Command): void {
  issue
    .command("pr-gate")
    .description("Inspect a GitHub pull request and build a Paperclip gate packet")
    .requiredOption("--repo <owner/repo>", "GitHub repository slug")
    .requiredOption("--pr <number>", "Pull request number")
    .option("--required-review <mode>", "Review requirement (none, any, non_author)", "non_author")
    .option("--required-check <name>", "Required GitHub check context", (value, previous: string[] = []) => {
      previous.push(value);
      return previous;
    }, [])
    .option("--preview-url <url>", "Optional preview URL to probe for deployment protection")
    .option("--preview-smoke-status <status>", "Preview smoke state (unknown, not_run, passed, failed)", "unknown")
    .option("--accepted-exception", "Encode the gate as an accepted human exception", false)
    .option("--exception-note <text>", "Exception note when --accepted-exception is set")
    .option("--captured-at <iso8601>", "Timestamp to store in the resolved gate packet")
    .option("--json", "Output raw JSON", false)
    .action(async (opts: IssuePrGateOptions) => {
      try {
        const { owner, repo } = parseRepoSlug(opts.repo);
        const prNumber = Number.parseInt(opts.pr, 10);
        if (!Number.isFinite(prNumber) || prNumber <= 0) {
          throw new Error(`Invalid pull request number: ${opts.pr}`);
        }
        const previewProtectionStatus = await probePreviewProtection(opts.previewUrl);
        const packet = buildGitHubPrGatePacket({
          pullRequest: collectPullRequestInput({
            owner,
            repo,
            prNumber,
            requiredChecks: opts.requiredCheck ?? [],
          }),
          requiredReview: parseEnumOption(
            opts.requiredReview,
            ISSUE_GITHUB_PR_REQUIRED_REVIEWS,
            "--required-review",
            "non_author",
          ) as IssueGitHubPrRequiredReview,
          previewProtectionStatus,
          previewSmokeStatus: parseEnumOption(
            opts.previewSmokeStatus,
            ISSUE_PREVIEW_SMOKE_STATUSES,
            "--preview-smoke-status",
            "unknown",
          ) as IssuePreviewSmokeStatus,
          acceptedException: opts.acceptedException === true,
          exceptionNote: opts.exceptionNote,
          capturedAt: opts.capturedAt,
        });
        if (opts.json) {
          printOutput(packet, { json: true });
          return;
        }
        printOutput({
          repo: `${owner}/${repo}`,
          prNumber,
          gateStatus: packet.externalGate.status,
          requiredSignal: packet.externalGate.requiredSignal,
          blockedReasonCode: packet.blockedReasonCode,
          headSha: packet.externalGate.githubPr?.headSha,
          mergeStateStatus: packet.externalGate.githubPr?.mergeStateStatus,
          checksStatus: packet.externalGate.githubPr?.checksStatus,
          reviewDecision: packet.externalGate.githubPr?.reviewDecision,
          unresolvedReviewThreads: packet.externalGate.githubPr?.unresolvedReviewThreads,
          previewProtectionStatus: packet.externalGate.githubPr?.previewProtectionStatus,
          previewSmokeStatus: packet.externalGate.githubPr?.previewSmokeStatus,
          currentViewerCanSatisfyReview: packet.externalGate.githubPr?.currentViewerCanSatisfyReview,
        }, { json: false });
      } catch (err) {
        handleCommandError(err);
      }
    });
}
