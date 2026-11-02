import { GITHUB_REVIEW_EVENTS, type GitHubReviewPolicy, type GitHubTaskReview } from "../../packages/shared/src/types/chat-github.js";
import type { Matcher } from "./types.js";

export const githubJourneyCheckpoints = ["target", "dependencies", "agent", "app_creation_consent", "app_created", "repository_scope", "identity", "configuration_saved", "configuration_reloaded", "pr_created", "automatic_task", "skill_binding", "review_completed", "github_delivery", "github_inline_delivery", "check_projection", "task_done", "persisted"] as const;
export interface GitHubReviewJourneyEvidence {
  version: 1;
  outcome: "running" | "passed" | "failed" | "awaiting_user" | "missing_credential" | "blocked_target";
  phase: string;
  setupId: string;
  hosting: "self-hosted" | "paperclip-cloud";
  targetCommit: string | null;
  assisted: boolean;
  dependencies: Array<{ alias: string; consumer: "harness" | "browser" | "product-agent"; status: "ready" | "unverified" | "created-in-journey"; source: "onepassword" | "environment" | "browser-session" | "product-connection" }>;
  checkpoints: Partial<Record<typeof githubJourneyCheckpoints[number], boolean>>;
  cleanup: { endpoint: boolean; pullRequest: boolean; branch: boolean; app: boolean };
  definitionHash?: string;
  score?: number;
  conclusion?: string;
  budgetPolicyRead?: "verified" | "unavailable";
  budgetPolicies?: Array<{ scopeType: string; amount: number; hardStopEnabled: boolean; unpricedUsagePolicy: string }>;
  execution?: { reviewId: string; issueId: string; runId: string | null; runStatus?: string; issueStatus?: string; runtimeMode?: string; environmentId?: string; provider?: string; model?: string };
  review?: { id: string; repository: string; pullNumber: number; headSha: string; state: string; score?: number; conclusion: string | null; summaryUrl: string | null; checkUrl: string | null };
  inlinePublication?: { url: string; fileUrl: string; path: string; author: string; text: string };
}

export function retainGitHubReview(review: GitHubTaskReview): NonNullable<GitHubReviewJourneyEvidence["review"]> {
  return { id: review.id, repository: review.repository, pullNumber: review.pullNumber, headSha: review.headSha,
    state: review.state, score: review.assessment?.score, conclusion: review.conclusion, summaryUrl: review.summaryUrl, checkUrl: review.checkUrl };
}

export function gradeGitHubReviewJourney(evidence: GitHubReviewJourneyEvidence) {
  return [...githubJourneyCheckpoints.map(id => ({ matcher: { kind: "json_path", path: `githubReviewJourney.checkpoints.${id}`, expected: true } as Matcher,
    passed: evidence.checkpoints[id] === true, detail: `${id}: ${evidence.checkpoints[id] === true ? "verified" : "missing"}` })),
  { matcher: { kind: "json_path", path: "githubReviewJourney.cleanup", expected: true } as Matcher,
    passed: Object.values(evidence.cleanup).every(Boolean), detail: "All attempt-owned resources reconciled; reusable repository retained." }];
}

/** Mentions and comment replies are manual intake, separate from automatic PR events. */
export function hasOnlyOpenedAutomaticReview(policy: Pick<GitHubReviewPolicy, "events" | "issueOpened">) {
  const automatic = policy.events.filter(event => GITHUB_REVIEW_EVENTS.slice(0, 4).includes(event));
  return automatic.length === 1 && automatic[0] === "opened" && policy.issueOpened !== true;
}

export function matchesGitHubJourneyEnvironment(environment: { id: string; driver: string; config: Record<string, unknown> }, id: string, kind: "local" | "daytona") {
  return environment.id === id && (kind === "local" ? environment.driver === "local"
    : environment.driver === "sandbox" && environment.config.provider === "daytona");
}

export function verifyGitHubReviewRun(run: Record<string, any> | undefined, expected: {
  runId: string | null; companyId: string; agentId: string; issueId: string;
  runtimeMode: string; environmentId: string; executionEnvironment: "local" | "daytona";
  environment: { id: string; driver: string; config: Record<string, unknown> }; provider: string; model: string;
}) {
  const provider = run?.runnerProfileJson?.nativeExecutionInput?.provider;
  return Boolean(run && run.id === expected.runId && run.companyId === expected.companyId
    && run.agentId === expected.agentId && run.issueId === expected.issueId
    && run.status === "succeeded" && run.runtimeMode === expected.runtimeMode
    && matchesGitHubJourneyEnvironment(expected.environment, expected.environmentId, expected.executionEnvironment)
    && run.contextSnapshot?.paperclipEnvironment?.id === expected.environmentId
    && run.contextSnapshot?.paperclipEnvironment?.driver === expected.environment.driver
    && (expected.runtimeMode !== "native" || (provider?.kind === expected.provider && provider?.model === expected.model)));
}

function ownedDeliveryUrl(value: string | null, repository: string, pullNumber: number, kind: "summary" | "check") {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.origin !== "https://github.com" || url.username || url.password) return false;
    const prefix = `/${repository}/`;
    if (!url.pathname.startsWith(prefix)) return false;
    const path = url.pathname.slice(prefix.length);
    return kind === "summary"
      ? (path === `pull/${pullNumber}` || path === `issues/${pullNumber}`) && /^#(?:issuecomment|pullrequestreview)-\d+$/.test(url.hash)
      : /^(?:runs\/\d+|actions\/runs\/\d+(?:\/job\/\d+)?)$/.test(path);
  } catch { return false; }
}

/** Independent identity/cause/output gates; a Done task or success prose cannot satisfy them. */
export function verifyGitHubReview(input: {
  review: GitHubTaskReview; companyId: string; endpointId: string; issueId: string; repository: string; pullNumber: number; headSha: string;
  issue: { id: string; companyId: string; assigneeAgentId: string; status: string }; agentId: string;
}) {
  const { review: r } = input; const assessment = r.assessment;
  return r.companyId === input.companyId && r.endpointId === input.endpointId && r.issueId === input.issueId
    && r.repository === input.repository && r.pullNumber === input.pullNumber && r.headSha === input.headSha
    && r.event.event === "opened" && r.event.headSha === input.headSha && r.event.repository === input.repository
    && r.state === "completed" && assessment?.complete === true && assessment.reviewedCommit === input.headSha
    && assessment.coverage.reviewedPaths.includes("cart-total.js") && assessment.findings.some(f => f.path === "cart-total.js" && f.side === "RIGHT"
      && /precision|decimal|floating|cents/i.test(f.body) && f.line >= 1 && f.line <= 7)
    && assessment.score < 5 && r.conclusion === "failure"
    && ownedDeliveryUrl(r.summaryUrl, input.repository, input.pullNumber, "summary") && ownedDeliveryUrl(r.checkUrl, input.repository, input.pullNumber, "check")
    && input.issue.id === input.issueId && input.issue.companyId === input.companyId && input.issue.assigneeAgentId === input.agentId && input.issue.status === "done";
}

/** New, versioned fixture: price precision is explicitly part of the repository's test contract. */
export const githubCartFixture = [
  "// Prices are decimal currency units; totals must be exact to a cent.",
  "export function calculateCartTotal(items) {",
  "  return items.reduce((total, item) => {",
  "    const price = Number(item.price);",
  "    return total + price * Number(item.quantity);",
  "  }, 0);",
  "}",
].join("\n") + "\n";
