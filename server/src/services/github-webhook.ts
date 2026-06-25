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
  const head = isPlainRecord(pullRequest.head) ? pullRequest.head : {};
  const base = isPlainRecord(pullRequest.base) ? pullRequest.base : {};
  return {
    number: readNumber(pullRequest.number),
    title: firstString(pullRequest.title),
    body: firstString(pullRequest.body),
    htmlUrl: firstString(pullRequest.html_url, pullRequest.htmlUrl),
    headRef: firstString(head.ref, pullRequest.head_ref, pullRequest.headRef),
    headSha: firstString(head.sha, pullRequest.head_sha, pullRequest.headSha),
    baseRef: firstString(base.ref, pullRequest.base_ref, pullRequest.baseRef),
    user: normalizeIdentity(pullRequest.user),
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

function hasActionableMarker(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "please",
    "fix",
    "adjust",
    "change",
    "replace",
    "remove",
    "add ",
    "update",
    "refactor",
    "rename",
    "resolve",
    "needs",
    "must",
    "should",
    "security",
    "bug",
    "regression",
    "broken",
    "failing",
    "cleanup",
  ].some((needle) => normalized.includes(needle));
}

function hasAmbiguousMarker(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "?",
    "maybe",
    "perhaps",
    "consider",
    "nit",
    "not sure",
    "unclear",
    "question",
  ].some((needle) => normalized.includes(needle));
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
    "Evento de review do GitHub recebido pelo Paperclip.",
    "",
    `Repositório: ${input.repository.fullName ?? "não informado"}`,
    input.repository.htmlUrl ? `URL do repositório: ${input.repository.htmlUrl}` : null,
    `Evento: ${input.event}`,
    `Ação: ${input.action}`,
    `Delivery ID: ${input.deliveryId ?? "não informado"}`,
    "",
    `PR: ${input.pullRequest.number != null ? `#${input.pullRequest.number}` : "não informado"}`,
    input.pullRequest.htmlUrl ? `URL do PR: ${input.pullRequest.htmlUrl}` : null,
    input.pullRequest.title ? `Título do PR: ${input.pullRequest.title}` : null,
    input.pullRequest.headRef ? `Branch head: ${input.pullRequest.headRef}` : null,
    input.pullRequest.baseRef ? `Branch base: ${input.pullRequest.baseRef}` : null,
    input.pullRequest.headSha ? `Head SHA: ${input.pullRequest.headSha}` : null,
    input.pullRequest.user.login ? `Autor do PR: ${input.pullRequest.user.login}` : null,
    "",
    `Autor do feedback: ${input.actorLogin ?? "não informado"}`,
    input.sender.login ? `Sender: ${input.sender.login}` : null,
    input.review?.id ? `Review ID: ${input.review.id}` : null,
    input.review?.state ? `Estado do review: ${input.review.state}` : null,
    input.review?.htmlUrl ? `URL do review: ${input.review.htmlUrl}` : null,
    input.comment?.id ? `Comentário ID: ${input.comment.id}` : null,
    input.comment?.htmlUrl ? `URL do comentário: ${input.comment.htmlUrl}` : null,
    input.comment?.path ? `Arquivo: ${input.comment.path}` : null,
    input.comment?.line != null ? `Linha: ${input.comment.line}` : null,
    input.comment?.side ? `Lado: ${input.comment.side}` : null,
    "",
    "Conteúdo do feedback:",
    normalizeText(firstString(input.review?.body, input.comment?.body, input.pullRequest.body, "Sem conteúdo.") ?? "Sem conteúdo."),
    "",
    `Classificação: ${input.disposition === "actionable" ? "acionável" : input.disposition === "triage" ? "triagem" : "ignorado"}`,
    `Motivo: ${input.dispositionReason}`,
    "",
    "Critérios de aceite:",
    "- Confirmar se o comentário/review realmente pede ajuste no PR.",
    "- Aplicar a correção na branch do PR.",
    "- Rodar os testes relevantes para o trecho afetado.",
    "- Responder no PR com o resumo da correção e o resultado da validação.",
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

function buildIssueTitle(input: GitHubWebhookNormalizedEvent) {
  const repo = input.repository.fullName ?? input.repository.name ?? "GitHub";
  const prNumber = input.pullRequest.number != null ? `PR #${input.pullRequest.number}` : "PR";
  const noun = input.disposition === "triage" ? "Triagem" : "Ajuste";
  const subject = input.review?.state === "changes_requested"
    ? "review"
    : input.comment?.path
      ? `comentário em ${input.comment.path}`
      : input.event === "issue_comment"
        ? "comentário no PR"
        : "review";
  return `${noun} do GitHub em ${repo} ${prNumber}: ${subject}`;
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
    return { disposition: "ignored", reason: "Autor não está na allowlist de bots configurada." };
  }

  const body = normalizeText(input.review?.body ?? input.comment?.body ?? "");
  if (!body) {
    return { disposition: "ignored", reason: "O evento não possui texto de review/comentário acionável." };
  }

  if (input.event === "pull_request_review") {
    const state = input.review?.state?.toLowerCase() ?? "";
    if (state === "dismissed" || state === "approved") {
      if (hasActionableMarker(body)) {
        return { disposition: "actionable", reason: "Review aprovado com texto que contém instruções de ajuste." };
      }
      return { disposition: "ignored", reason: "Review aprovado/dispensado sem pedido de ajuste." };
    }
    if (state === "changes_requested") {
      return { disposition: "actionable", reason: "Review com changes_requested precisa de ajuste." };
    }
    return hasActionableMarker(body)
      ? { disposition: "actionable", reason: "Review contém instruções de ajuste." }
      : { disposition: "triage", reason: "Review é ambíguo; vai para triagem." };
  }

  if (input.event === "pull_request_review_comment") {
    if (input.comment?.path || input.comment?.line != null) {
      return { disposition: "actionable", reason: "Comentário aponta arquivo/linha específica." };
    }
    return hasActionableMarker(body)
      ? { disposition: "actionable", reason: "Comentário contém instruções de ajuste." }
      : { disposition: "triage", reason: "Comentário em review é ambíguo; vai para triagem." };
  }

  if (input.event === "issue_comment" && input.issueCommentIsOnPullRequest) {
    if (hasActionableMarker(body)) {
      return { disposition: "actionable", reason: "Comentário em PR contém instruções de ajuste." };
    }
    return hasAmbiguousMarker(body)
      ? { disposition: "triage", reason: "Comentário em PR é ambíguo; vai para triagem." }
      : { disposition: "triage", reason: "Comentário em PR foi aceito como triagem." };
  }

  return { disposition: "ignored", reason: "Evento não indica ajuste acionável." };
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
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, originKind), eq(issues.originId, originId)))
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
    return { kind: "ignored", reason: "Evento fora da allowlist ou sem PR acionável." };
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
