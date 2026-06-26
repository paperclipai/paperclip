import crypto from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { issueService, logActivity } from "./index.js";

export const GITHUB_WEBHOOK_ALLOWED_EVENTS = [
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
] as const;

export const DEFAULT_GITHUB_BOT_LOGINS = ["chatgpt-codex-connector[bot]"];

export type GitHubWebhookEvent = (typeof GITHUB_WEBHOOK_ALLOWED_EVENTS)[number];
export type GitHubWebhookDisposition = "actionable" | "triage" | "ignored";

export type GitHubWebhookConfig = {
  secret: string;
  companyId: string;
  projectId: string | null;
  allowedRepos: string[];
  allowedOrgs: string[];
  allowedBotLogins: string[];
  allowHumanReviewers: boolean;
  defaultAssigneeAgentId: string | null;
  ownerAgentIds: Record<GitHubWebhookOwner, string | null>;
};

export type GitHubWebhookOwner = "CEO" | "DevOps" | "QA" | "CTO" | "UXDesigner";

export type GitHubWebhookNormalizedIdentity = {
  login: string | null;
  name: string | null;
  type: string | null;
  htmlUrl: string | null;
};

export type GitHubWebhookRepository = {
  owner: string | null;
  name: string | null;
  fullName: string | null;
  htmlUrl: string | null;
};

export type GitHubWebhookPullRequest = {
  number: number | null;
  title: string | null;
  body: string | null;
  htmlUrl: string | null;
  headRef: string | null;
  headSha: string | null;
  baseRef: string | null;
  user: GitHubWebhookNormalizedIdentity;
};

export type GitHubWebhookReview = {
  id: string | null;
  state: string | null;
  body: string | null;
  htmlUrl: string | null;
  user: GitHubWebhookNormalizedIdentity;
};

export type GitHubWebhookComment = {
  id: string | null;
  body: string | null;
  path: string | null;
  line: number | null;
  side: string | null;
  htmlUrl: string | null;
  user: GitHubWebhookNormalizedIdentity;
};

export type GitHubWebhookNormalizedEvent = {
  provider: "github";
  event: GitHubWebhookEvent;
  action: string;
  deliveryId: string | null;
  repository: GitHubWebhookRepository;
  pullRequest: GitHubWebhookPullRequest;
  review: GitHubWebhookReview | null;
  comment: GitHubWebhookComment | null;
  issueCommentIsOnPullRequest: boolean;
  sender: GitHubWebhookNormalizedIdentity;
  actorLogin: string | null;
  originId: string;
  originFingerprint: string;
  title: string;
  description: string;
  disposition: GitHubWebhookDisposition;
  dispositionReason: string;
  assigneeAgentId: string | null;
  priority: "high" | "medium" | "low";
};

type PlainRecord = Record<string, unknown>;

type GitHubWebhookIssueRow = {
  id: string;
  companyId: string;
  status: string;
  title: string;
  description: string | null;
  assigneeAgentId: string | null;
  projectId: string | null;
  priority: string;
  originKind: string;
  originId: string | null;
  originFingerprint: string | null;
  updatedAt: Date;
};

function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readIdentifier(value: unknown): string | null {
  const stringValue = readString(value);
  if (stringValue) return stringValue;
  const numericValue = readNumber(value);
  return numericValue === null ? null : String(numericValue);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const parsed = readString(value);
    if (parsed) return parsed;
  }
  return null;
}

function toLowerSet(values: readonly string[]) {
  return new Set(values.map((value) => value.toLowerCase()));
}

function splitEnvList(value: string | undefined, fallback: readonly string[] = []) {
  const raw = value?.trim();
  if (!raw) return [...fallback];
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readTruthyEnv(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function readOwnerAgentIds(env: NodeJS.ProcessEnv): Record<GitHubWebhookOwner, string | null> {
  const legacyRoles: Record<Exclude<GitHubWebhookOwner, "CEO">, string> = {
    DevOps: "GITHUB_WEBHOOK_AGENT_DEVOPS",
    QA: "GITHUB_WEBHOOK_AGENT_QA",
    CTO: "GITHUB_WEBHOOK_AGENT_CTO",
    UXDesigner: "GITHUB_WEBHOOK_AGENT_UXDESIGNER",
  };

  return {
    CEO: readString(env.GITHUB_WEBHOOK_CEO_AGENT_ID) ?? readString(env.GITHUB_WEBHOOK_DEFAULT_ASSIGNEE_AGENT_ID),
    DevOps: readString(env[legacyRoles.DevOps]),
    QA: readString(env[legacyRoles.QA]),
    CTO: readString(env[legacyRoles.CTO]),
    UXDesigner: readString(env[legacyRoles.UXDesigner]),
  };
}

export function readGitHubWebhookConfig(env: NodeJS.ProcessEnv = process.env): GitHubWebhookConfig {
  return {
    secret: readString(env.GITHUB_WEBHOOK_SECRET) ?? "",
    companyId: readString(env.GITHUB_WEBHOOK_COMPANY_ID) ?? "",
    projectId: readString(env.GITHUB_WEBHOOK_PROJECT_ID),
    allowedRepos: splitEnvList(env.GITHUB_WEBHOOK_ALLOWED_REPOS),
    allowedOrgs: splitEnvList(env.GITHUB_WEBHOOK_ALLOWED_ORGS),
    allowedBotLogins: splitEnvList(env.GITHUB_WEBHOOK_ALLOWED_BOT_LOGINS, DEFAULT_GITHUB_BOT_LOGINS),
    allowHumanReviewers: readTruthyEnv(env.GITHUB_WEBHOOK_ALLOW_HUMAN_REVIEWERS),
    defaultAssigneeAgentId:
      readString(env.GITHUB_WEBHOOK_DEFAULT_ASSIGNEE_AGENT_ID) ??
      readString(env.GITHUB_WEBHOOK_CEO_AGENT_ID) ??
      null,
    ownerAgentIds: readOwnerAgentIds(env),
  };
}

function normalizeIdentity(value: unknown): GitHubWebhookNormalizedIdentity {
  if (!isPlainRecord(value)) {
    return { login: null, name: null, type: null, htmlUrl: null };
  }
  return {
    login: firstString(value.login),
    name: firstString(value.name),
    type: firstString(value.type),
    htmlUrl: firstString(value.html_url, value.htmlUrl),
  };
}

function normalizeRepository(payload: PlainRecord): GitHubWebhookRepository {
  const repository = isPlainRecord(payload.repository) ? payload.repository : {};
  const owner = isPlainRecord(repository.owner)
    ? firstString(repository.owner.login, repository.owner.name)
    : null;
  const fullName = firstString(repository.full_name, repository.fullName);
  const name = firstString(repository.name) ?? (fullName ? fullName.split("/").at(1) ?? null : null);
  return {
    owner,
    name,
    fullName,
    htmlUrl: firstString(repository.html_url, repository.htmlUrl),
  };
}

function normalizePullRequest(payload: PlainRecord): GitHubWebhookPullRequest {
  const pullRequest = isPlainRecord(payload.pull_request) ? payload.pull_request : {};
  const issue = isPlainRecord(payload.issue) ? payload.issue : {};
  const source = isPlainRecord(payload.pull_request) ? pullRequest : issue;
  const head = isPlainRecord(source.head) ? source.head : {};
  const base = isPlainRecord(source.base) ? source.base : {};
  return {
    number: readNumber(source.number),
    title: firstString(source.title),
    body: firstString(source.body),
    htmlUrl: firstString(source.html_url, source.htmlUrl, issue.html_url, issue.htmlUrl),
    headRef: firstString(head.ref, source.head_ref, source.headRef),
    headSha: firstString(head.sha, source.head_sha, source.headSha),
    baseRef: firstString(base.ref, source.base_ref, source.baseRef),
    user: normalizeIdentity(source.user),
  };
}

function normalizeReview(payload: PlainRecord): GitHubWebhookReview | null {
  const review = isPlainRecord(payload.review) ? payload.review : null;
  if (!review) return null;
  return {
    id: readIdentifier(review.id),
    state: firstString(review.state),
    body: firstString(review.body),
    htmlUrl: firstString(review.html_url, review.htmlUrl),
    user: normalizeIdentity(review.user),
  };
}

function normalizeComment(payload: PlainRecord): GitHubWebhookComment | null {
  const comment = isPlainRecord(payload.comment) ? payload.comment : null;
  if (!comment) return null;
  return {
    id: readIdentifier(comment.id),
    body: firstString(comment.body),
    path: firstString(comment.path),
    line: readNumber(comment.line),
    side: firstString(comment.side),
    htmlUrl: firstString(comment.html_url, comment.htmlUrl),
    user: normalizeIdentity(comment.user),
  };
}

function normalizeSender(payload: PlainRecord): GitHubWebhookNormalizedIdentity {
  return normalizeIdentity(payload.sender);
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function hasApprovalLanguage(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "lgtm",
    "looks good",
    "approved",
    "ship it",
    "ready to merge",
    "good to merge",
    "merge it",
    "should merge",
    "good to go",
    "all good",
    "no blockers",
  ].some((needle) => normalized.includes(needle));
}

function hasActionableMarker(text: string): boolean {
  const normalized = text.toLowerCase();
  const actionablePatterns = [
    /\bplease\b/,
    /\bfix\b/,
    /\badjust\b/,
    /\bchange\b/,
    /\breplace\b/,
    /\bremove\b/,
    /\brefactor\b/,
    /\brename\b/,
    /\bresolve\b/,
    /\baddress\b/,
    /\binvestigate\b/,
    /\bcleanup\b/,
    /\bdocument\b/,
    /\bretest\b/,
    /\bverify\b/,
    /\btest\b/,
    /\bbug\b/,
    /\bregression\b/,
    /\bbroken\b/,
    /\bfailing\b/,
    /\bsecurity\b/,
    /\bupdate\s+(?:the|this|that|these|those|tests?|docs?|documentation|readme|code|logic|implementation|layout|ui|api|copy|text|comments?|handlers?|checks?|validation|support|handling|coverage|fallback|guard|examples?|files?|routes?|inputs?|outputs?)\b/,
    /\badd\s+(?:the|this|that|these|those|tests?|docs?|documentation|readme|code|logic|implementation|handlers?|checks?|validation|support|handling|coverage|fallback|guard|examples?|comments?|files?|routes?|inputs?|outputs?)\b/,
  ];

  return actionablePatterns.some((pattern) => pattern.test(normalized));
}

function repoMatchesAllowlist(repository: GitHubWebhookRepository, config: GitHubWebhookConfig): boolean {
  const allowAll = config.allowedRepos.length === 0 && config.allowedOrgs.length === 0;
  if (allowAll) return true;

  const fullName = repository.fullName?.toLowerCase() ?? "";
  const owner = repository.owner?.toLowerCase() ?? "";
  const repoName = repository.name?.toLowerCase() ?? "";
  const repoSet = toLowerSet(config.allowedRepos);
  const orgSet = toLowerSet(config.allowedOrgs);

  if (fullName && repoSet.has(fullName)) return true;
  if (owner && orgSet.has(owner)) return true;
  if (owner && repoName && repoSet.has(`${owner}/${repoName}`)) return true;
  if (owner && repoSet.has(`${owner}/*`)) return true;
  return false;
}

function isAllowedActor(login: string | null, config: GitHubWebhookConfig): boolean {
  if (!login) return false;
  return config.allowedBotLogins.map((entry) => entry.toLowerCase()).includes(login.toLowerCase());
}

function readAction(payload: PlainRecord): string {
  return readString(payload.action) ?? "";
}

function buildOriginId(input: {
  repository: GitHubWebhookRepository;
  event: GitHubWebhookEvent;
  action: string;
  pullRequestNumber: number | null;
  reviewId: string | null;
  commentId: string | null;
}) {
  const repo = input.repository.fullName ?? `${input.repository.owner ?? "unknown"}/${input.repository.name ?? "unknown"}`;
  const pullRequestNumber = input.pullRequestNumber ?? "unknown";
  const uniqueId = input.reviewId ?? input.commentId ?? "unknown";
  return [
    "github:webhook",
    repo,
    input.event,
    input.action,
    `pr:${pullRequestNumber}`,
    `item:${uniqueId}`,
  ].join("|");
}

function buildOriginFingerprint(input: {
  repository: GitHubWebhookRepository;
  pullRequestNumber: number | null;
}) {
  const repo = input.repository.fullName ?? `${input.repository.owner ?? "unknown"}/${input.repository.name ?? "unknown"}`;
  return [`github:webhook`, repo, `pr:${input.pullRequestNumber ?? "unknown"}`].join("|");
}

function buildIssueBody(input: GitHubWebhookNormalizedEvent) {
  const lines = [
    "GitHub review event received by Paperclip.",
    "",
    `Repository: ${input.repository.fullName ?? "not provided"}`,
    input.repository.htmlUrl ? `Repository URL: ${input.repository.htmlUrl}` : null,
    `Event: ${input.event}`,
    `Action: ${input.action}`,
    `Delivery ID: ${input.deliveryId ?? "not provided"}`,
    "",
    `Pull request: ${input.pullRequest.number != null ? `#${input.pullRequest.number}` : "not provided"}`,
    input.pullRequest.htmlUrl ? `Pull request URL: ${input.pullRequest.htmlUrl}` : null,
    input.pullRequest.title ? `Pull request title: ${input.pullRequest.title}` : null,
    input.pullRequest.headRef ? `Head branch: ${input.pullRequest.headRef}` : null,
    input.pullRequest.baseRef ? `Base branch: ${input.pullRequest.baseRef}` : null,
    input.pullRequest.headSha ? `Head SHA: ${input.pullRequest.headSha}` : null,
    input.pullRequest.user.login ? `PR author: ${input.pullRequest.user.login}` : null,
    "",
    `Feedback author: ${input.actorLogin ?? "not provided"}`,
    input.sender.login ? `Sender: ${input.sender.login}` : null,
    input.review?.id ? `Review ID: ${input.review.id}` : null,
    input.review?.state ? `Review state: ${input.review.state}` : null,
    input.review?.htmlUrl ? `Review URL: ${input.review.htmlUrl}` : null,
    input.comment?.id ? `Comment ID: ${input.comment.id}` : null,
    input.comment?.htmlUrl ? `Comment URL: ${input.comment.htmlUrl}` : null,
    input.comment?.path ? `File: ${input.comment.path}` : null,
    input.comment?.line != null ? `Line: ${input.comment.line}` : null,
    input.comment?.side ? `Side: ${input.comment.side}` : null,
    "",
    "Feedback body:",
    normalizeText(firstString(input.review?.body, input.comment?.body, input.pullRequest.body, "No content provided.") ?? "No content provided."),
    "",
    `Disposition: ${input.disposition === "actionable" ? "actionable" : input.disposition === "triage" ? "triage" : "ignored"}`,
    `Reason: ${input.dispositionReason}`,
    "",
    "Acceptance criteria:",
    "- Confirm the comment or review actually requests a change to the PR.",
    "- Apply the fix on the PR branch.",
    "- Run the relevant tests for the affected area.",
    "- Reply on the PR with the fix summary and validation result.",
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

function buildIssueTitle(input: GitHubWebhookNormalizedEvent) {
  const repo = input.repository.fullName ?? input.repository.name ?? "GitHub";
  const prNumber = input.pullRequest.number != null ? `PR #${input.pullRequest.number}` : "PR";
  const noun = input.disposition === "triage" ? "Triage" : "Fix";
  const subject = input.review?.state === "changes_requested"
    ? "review"
    : input.comment?.path
      ? `comment on ${input.comment.path}`
      : input.event === "issue_comment"
        ? "PR comment"
        : "review";
  return `${noun} from GitHub on ${repo} ${prNumber}: ${subject}`;
}

function resolveWebhookOwner(input: {
  disposition: GitHubWebhookDisposition;
  review: GitHubWebhookReview | null;
  comment: GitHubWebhookComment | null;
}): GitHubWebhookOwner {
  const text = normalizeText(`${input.review?.body ?? ""} ${input.comment?.body ?? ""}`).toLowerCase();
  if (text.includes("design") || text.includes("ui") || text.includes("layout") || text.includes("spacing")) {
    return "UXDesigner";
  }
  if (text.includes("deploy") || text.includes("workflow") || text.includes("ci") || text.includes("pipeline")) {
    return "DevOps";
  }
  if (text.includes("test") || text.includes("qa") || text.includes("regression")) {
    return "QA";
  }
  if (text.includes("security") || text.includes("permission") || text.includes("auth")) {
    return "CTO";
  }
  return input.disposition === "triage" ? "CEO" : "CTO";
}

function resolveDisposition(input: {
  event: GitHubWebhookEvent;
  action: string;
  review: GitHubWebhookReview | null;
  comment: GitHubWebhookComment | null;
  issueCommentIsOnPullRequest: boolean;
  allowHumanReviewers: boolean;
  allowedActor: boolean;
}): { disposition: GitHubWebhookDisposition; reason: string } {
  if (!input.allowedActor && !input.allowHumanReviewers) {
    return { disposition: "ignored", reason: "The author is not on the configured bot allowlist." };
  }

  const body = normalizeText(input.review?.body ?? input.comment?.body ?? "");
  if (!body) {
    return { disposition: "ignored", reason: "The event does not include actionable review or comment text." };
  }

  if (input.event === "pull_request_review") {
    const state = input.review?.state?.toLowerCase() ?? "";
    if (state === "dismissed" || state === "approved") {
      if (hasActionableMarker(body)) {
        return { disposition: "actionable", reason: "Approved or dismissed review still includes a clear change request." };
      }
      return { disposition: "ignored", reason: "Approved or dismissed review does not include a clear change request." };
    }
    if (state === "changes_requested") {
      return { disposition: "actionable", reason: "Review with changes_requested needs a change." };
    }
    return hasActionableMarker(body)
      ? { disposition: "actionable", reason: "Review includes clear change instructions." }
      : { disposition: "triage", reason: "Review is ambiguous and goes to triage." };
  }

  if (input.event === "pull_request_review_comment") {
    if (input.comment?.path || input.comment?.line != null) {
      return { disposition: "actionable", reason: "Comment points to a specific file or line." };
    }
    if (hasActionableMarker(body)) {
      return { disposition: "actionable", reason: "Review comment includes clear change instructions." };
    }
    if (hasApprovalLanguage(body)) {
      return { disposition: "ignored", reason: "Review comment is approval or merge language, not a change request." };
    }
    return { disposition: "triage", reason: "Review comment is ambiguous and goes to triage." };
  }

  if (input.event === "issue_comment" && input.issueCommentIsOnPullRequest) {
    if (hasActionableMarker(body)) {
      return { disposition: "actionable", reason: "PR comment includes clear change instructions." };
    }
    if (hasApprovalLanguage(body)) {
      return { disposition: "ignored", reason: "PR comment is approval or merge language, not a change request." };
    }
    return { disposition: "triage", reason: "PR comment is accepted as triage." };
  }

  return { disposition: "ignored", reason: "The event does not indicate actionable work." };
}

export function verifyGitHubWebhookSignature(args: {
  secret: string;
  rawBody: Buffer;
  signature: string | null | undefined;
}) {
  const provided = args.signature?.trim() ?? "";
  if (!provided || !args.secret.trim()) return false;

  const normalizedProvided = provided.replace(/^sha256=/, "");
  const expected = crypto
    .createHmac("sha256", args.secret)
    .update(args.rawBody)
    .digest("hex");

  if (normalizedProvided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(normalizedProvided), Buffer.from(expected));
}

export function normalizeGitHubWebhookEvent(input: {
  event: GitHubWebhookEvent;
  deliveryId: string | null;
  payload: unknown;
  config: GitHubWebhookConfig;
}): GitHubWebhookNormalizedEvent | null {
  if (!isPlainRecord(input.payload)) return null;

  const repository = normalizeRepository(input.payload);
  if (!repository.fullName) return null;

  if (!repoMatchesAllowlist(repository, input.config)) return null;

  const action = readAction(input.payload);
  const pullRequest = normalizePullRequest(input.payload);
  const review = normalizeReview(input.payload);
  const comment = normalizeComment(input.payload);
  const sender = normalizeSender(input.payload);
  const actorLogin = review?.user.login ?? comment?.user.login ?? sender.login ?? null;
  const allowedActor = isAllowedActor(actorLogin, input.config);
  const issue = isPlainRecord(input.payload.issue) ? input.payload.issue : null;
  const issueCommentIsOnPullRequest = Boolean(issue?.pull_request);

  if (input.event === "issue_comment" && !issueCommentIsOnPullRequest) return null;

  const disposition = resolveDisposition({
    event: input.event,
    action,
    review,
    comment,
    issueCommentIsOnPullRequest,
    allowHumanReviewers: input.config.allowHumanReviewers,
    allowedActor,
  });

  const originId = buildOriginId({
    repository,
    event: input.event,
    action,
    pullRequestNumber: pullRequest.number,
    reviewId: review?.id ?? null,
    commentId: comment?.id ?? null,
  });
  const originFingerprint = buildOriginFingerprint({
    repository,
    pullRequestNumber: pullRequest.number,
  });

  const owner = resolveWebhookOwner({
    disposition: disposition.disposition,
    review,
    comment,
  });
  const assigneeAgentId = input.config.ownerAgentIds[owner] ?? input.config.defaultAssigneeAgentId;
  const priority = disposition.disposition === "actionable" ? "high" : "medium";
  const normalized: GitHubWebhookNormalizedEvent = {
    provider: "github",
    event: input.event,
    action,
    deliveryId: input.deliveryId,
    repository,
    pullRequest,
    review,
    comment,
    issueCommentIsOnPullRequest,
    sender,
    actorLogin,
    originId,
    originFingerprint,
    title: buildIssueTitle({
      provider: "github",
      event: input.event,
      action,
      deliveryId: input.deliveryId,
      repository,
      pullRequest,
      review,
      comment,
      issueCommentIsOnPullRequest,
      sender,
      actorLogin,
      originId,
      originFingerprint,
      title: "",
      description: "",
      disposition: disposition.disposition,
      dispositionReason: disposition.reason,
      assigneeAgentId,
      priority,
    }),
    description: buildIssueBody({
      provider: "github",
      event: input.event,
      action,
      deliveryId: input.deliveryId,
      repository,
      pullRequest,
      review,
      comment,
      issueCommentIsOnPullRequest,
      sender,
      actorLogin,
      originId,
      originFingerprint,
      title: "",
      description: "",
      disposition: disposition.disposition,
      dispositionReason: disposition.reason,
      assigneeAgentId,
      priority,
    }),
    disposition: disposition.disposition,
    dispositionReason: disposition.reason,
    assigneeAgentId,
    priority,
  };

  return normalized;
}

export function buildGitHubWebhookIssueInput(event: GitHubWebhookNormalizedEvent) {
  return {
    title: event.title,
    description: event.description,
    status: "todo" as const,
    priority: event.priority,
    assigneeAgentId: event.assigneeAgentId,
    originKind: "github:webhook" as const,
    originId: event.originId,
    originFingerprint: event.originFingerprint,
  };
}

export function buildGitHubWebhookIssuePatch(event: GitHubWebhookNormalizedEvent) {
  return {
    title: event.title,
    description: event.description,
    priority: event.priority,
    ...(event.assigneeAgentId ? { assigneeAgentId: event.assigneeAgentId } : {}),
    originKind: "github:webhook" as const,
    originId: event.originId,
    originFingerprint: event.originFingerprint,
  };
}

export type GitHubWebhookIssueStore = {
  findByOrigin(companyId: string, originKind: string, originId: string): Promise<GitHubWebhookIssueRow | null>;
  create(companyId: string, input: ReturnType<typeof buildGitHubWebhookIssueInput>): Promise<{ id: string }>;
  update(issueId: string, input: ReturnType<typeof buildGitHubWebhookIssuePatch>): Promise<GitHubWebhookIssueRow | null>;
};

export function createGitHubWebhookIssueStore(db: Db): GitHubWebhookIssueStore {
  const issuesSvc = issueService(db);
  return {
    async findByOrigin(companyId, originKind, originId) {
      return db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          title: issues.title,
          description: issues.description,
          assigneeAgentId: issues.assigneeAgentId,
          projectId: issues.projectId,
          priority: issues.priority,
          originKind: issues.originKind,
          originId: issues.originId,
          originFingerprint: issues.originFingerprint,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, originKind), eq(issues.originId, originId), isNull(issues.hiddenAt)))
        .then((rows) => rows[0] ?? null);
    },
    async create(companyId, input) {
      return issuesSvc.create(companyId, input);
    },
    async update(issueId, input) {
      return issuesSvc.update(issueId, input);
    },
  };
}

function issueSummaryChanged(existing: GitHubWebhookIssueRow, next: ReturnType<typeof buildGitHubWebhookIssuePatch>) {
  return (
    existing.title !== next.title ||
    (existing.description ?? null) !== (next.description ?? null) ||
    existing.priority !== next.priority ||
    existing.assigneeAgentId !== (next.assigneeAgentId ?? null) ||
    existing.originId !== (next.originId ?? null) ||
    existing.originFingerprint !== (next.originFingerprint ?? null)
  );
}

export type GitHubWebhookProcessResult =
  | {
      kind: "ignored";
      reason: string;
    }
  | {
      kind: "created";
      issueId: string;
      normalized: GitHubWebhookNormalizedEvent;
    }
  | {
      kind: "updated";
      issueId: string;
      normalized: GitHubWebhookNormalizedEvent;
    }
  | {
      kind: "duplicate";
      issueId: string;
      normalized: GitHubWebhookNormalizedEvent;
    };

export async function processGitHubWebhook(input: {
  db: Db;
  config: GitHubWebhookConfig;
  event: GitHubWebhookEvent;
  deliveryId: string | null;
  rawBody: Buffer;
  payload: unknown;
  signature: string | null | undefined;
  issueStore?: GitHubWebhookIssueStore;
  log?: typeof logActivity;
}): Promise<GitHubWebhookProcessResult> {
  if (!verifyGitHubWebhookSignature({
    secret: input.config.secret,
    rawBody: input.rawBody,
    signature: input.signature,
  })) {
    return { kind: "ignored", reason: "Invalid signature" };
  }

  const normalized = normalizeGitHubWebhookEvent({
    event: input.event,
    deliveryId: input.deliveryId,
    payload: input.payload,
    config: input.config,
  });
  if (!normalized) {
    return { kind: "ignored", reason: "Event is outside the allowlist or does not target an actionable pull request." };
  }
  if (normalized.disposition === "ignored") {
    return { kind: "ignored", reason: normalized.dispositionReason };
  }

  const store = input.issueStore ?? createGitHubWebhookIssueStore(input.db);
  const existing = await store.findByOrigin(input.config.companyId, "github:webhook", normalized.originId);
  const activity = input.log ?? logActivity;

  if (!existing) {
    const issue = await store.create(input.config.companyId, buildGitHubWebhookIssueInput(normalized));
    await activity(input.db, {
      companyId: input.config.companyId,
      actorType: "system",
      actorId: "github-webhook",
      action: "github.webhook.issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        provider: normalized.provider,
        event: normalized.event,
        action: normalized.action,
        deliveryId: normalized.deliveryId,
        repository: normalized.repository,
        pullRequest: normalized.pullRequest,
        review: normalized.review,
        comment: normalized.comment,
        sender: normalized.sender,
        disposition: normalized.disposition,
        dispositionReason: normalized.dispositionReason,
        originId: normalized.originId,
        originFingerprint: normalized.originFingerprint,
      },
    });
    return { kind: "created", issueId: issue.id, normalized };
  }

  if (existing.status === "done" || existing.status === "cancelled") {
    await activity(input.db, {
      companyId: input.config.companyId,
      actorType: "system",
      actorId: "github-webhook",
      action: "github.webhook.duplicate_terminal_ignored",
      entityType: "issue",
      entityId: existing.id,
      details: {
        provider: normalized.provider,
        event: normalized.event,
        action: normalized.action,
        deliveryId: normalized.deliveryId,
        repository: normalized.repository,
        pullRequest: normalized.pullRequest,
        review: normalized.review,
        comment: normalized.comment,
        sender: normalized.sender,
        disposition: normalized.disposition,
        dispositionReason: normalized.dispositionReason,
        originId: normalized.originId,
        originFingerprint: normalized.originFingerprint,
      },
    });
    return { kind: "duplicate", issueId: existing.id, normalized };
  }

  const patch = buildGitHubWebhookIssuePatch(normalized);
  if (!issueSummaryChanged(existing, patch)) {
    await activity(input.db, {
      companyId: input.config.companyId,
      actorType: "system",
      actorId: "github-webhook",
      action: "github.webhook.duplicate_ignored",
      entityType: "issue",
      entityId: existing.id,
      details: {
        provider: normalized.provider,
        event: normalized.event,
        action: normalized.action,
        deliveryId: normalized.deliveryId,
        repository: normalized.repository,
        pullRequest: normalized.pullRequest,
        review: normalized.review,
        comment: normalized.comment,
        sender: normalized.sender,
        disposition: normalized.disposition,
        dispositionReason: normalized.dispositionReason,
        originId: normalized.originId,
        originFingerprint: normalized.originFingerprint,
      },
    });
    return { kind: "duplicate", issueId: existing.id, normalized };
  }

  const updated = await store.update(existing.id, patch);
  if (!updated) {
    const issue = await store.create(input.config.companyId, buildGitHubWebhookIssueInput(normalized));
    await activity(input.db, {
      companyId: input.config.companyId,
      actorType: "system",
      actorId: "github-webhook",
      action: "github.webhook.issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        provider: normalized.provider,
        event: normalized.event,
        action: normalized.action,
        deliveryId: normalized.deliveryId,
        repository: normalized.repository,
        pullRequest: normalized.pullRequest,
        review: normalized.review,
        comment: normalized.comment,
        sender: normalized.sender,
        disposition: normalized.disposition,
        dispositionReason: normalized.dispositionReason,
        originId: normalized.originId,
        originFingerprint: normalized.originFingerprint,
      },
    });
    return { kind: "created", issueId: issue.id, normalized };
  }

  await activity(input.db, {
    companyId: input.config.companyId,
    actorType: "system",
    actorId: "github-webhook",
    action: "github.webhook.issue.updated",
    entityType: "issue",
    entityId: updated.id,
    details: {
      provider: normalized.provider,
      event: normalized.event,
      action: normalized.action,
      deliveryId: normalized.deliveryId,
      repository: normalized.repository,
      pullRequest: normalized.pullRequest,
      review: normalized.review,
      comment: normalized.comment,
      sender: normalized.sender,
      disposition: normalized.disposition,
      dispositionReason: normalized.dispositionReason,
      originId: normalized.originId,
      originFingerprint: normalized.originFingerprint,
    },
  });
  return { kind: "updated", issueId: updated.id, normalized };
}
