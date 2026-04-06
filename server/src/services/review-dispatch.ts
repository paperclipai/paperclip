import type { Db } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { agentService } from "./agents.js";
import { companyService } from "./companies.js";
import { issueService } from "./issues.js";
import { workProductService } from "./work-products.js";

const REVIEW_DISPATCH_ORIGIN_KIND = "technical_review_dispatch";
/** Default agent name reference when company and env omit overrides. */
export const DEFAULT_TECHNICAL_REVIEWER_REFERENCE = "revisor-pr";
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

type IssueSummary = Awaited<ReturnType<ReturnType<typeof issueService>["getById"]>>;
type IssueListItem = Awaited<ReturnType<ReturnType<typeof issueService>["list"]>>[number];
type IssueCreateResult = Awaited<ReturnType<ReturnType<typeof issueService>["create"]>>;
type IssueComment = Awaited<ReturnType<ReturnType<typeof issueService>["getComment"]>>;
type AgentSummary = Awaited<ReturnType<ReturnType<typeof agentService>["resolveByReference"]>>["agent"];
type ReviewIssueRecord = NonNullable<IssueCreateResult> | IssueListItem;

type ResolvedPullRequestRef = {
  owner: string;
  repo: string;
  repoFullName: string;
  prNumber: number;
  url: string;
};

type ResolvedReviewArtifact = {
  source: "work_product" | "comment" | "description";
  sourceId: string;
  sourceCreatedAt: Date | null;
  sourceLink: string | null;
  title: string;
  bodyContext: string;
  pullRequest: ResolvedPullRequestRef;
  diffIdentity: string;
  headSha: string | null;
};

type PreviousReviewReference = {
  issue: ReviewIssueRecord;
  pullRequest: ResolvedPullRequestRef | null;
};

export type ReviewDispatchDedupReason =
  | "exact_diff_identity"
  | "same_pr_recent_comment"
  | "same_head_sha"
  | "same_pr_existing_artifact"
  | "no_new_diff_declared";

export type ReviewDispatchNoopReason =
  | "issue_not_found"
  | "status_not_handoff_ready"
  | "reviewer_not_found"
  | "reviewer_ambiguous"
  | "pull_request_not_found";

export type ReviewDispatchResult =
  | { kind: "noop"; reason: ReviewDispatchNoopReason | string }
  | {
    kind: "created" | "reused" | "already_reviewed";
    artifact: ResolvedReviewArtifact;
    reviewIssue: ReviewIssueRecord;
    reviewer: AgentSummary;
    dedupReason?: ReviewDispatchDedupReason;
  };

type ReviewDispatchDeps = {
  agents?: ReturnType<typeof agentService>;
  issues?: ReturnType<typeof issueService>;
  workProducts?: ReturnType<typeof workProductService>;
  companies?: {
    getById: (
      id: string,
    ) => Promise<{ technicalReviewerReference?: string | null } | null>;
  };
};

function technicalReviewerReferenceFromEnv() {
  const t = process.env.PAPERCLIP_TECHNICAL_REVIEWER_REFERENCE?.trim();
  return t && t.length > 0 ? t : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asPositiveInteger(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function pullRequestRefFromUrl(rawUrl: string | null | undefined): ResolvedPullRequestRef | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname !== "github.com") return null;
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/);
    if (!match) return null;
    const owner = match[1] ?? "";
    const repo = match[2] ?? "";
    const prNumber = Number.parseInt(match[3] ?? "", 10);
    if (!owner || !repo || !Number.isFinite(prNumber)) return null;
    return {
      owner,
      repo,
      repoFullName: `${owner}/${repo}`,
      prNumber,
      url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
    };
  } catch {
    return null;
  }
}

function extractPullRequestRefFromText(text: string | null | undefined) {
  if (!text) return null;
  const match = text.match(/https?:\/\/github\.com\/[^/\s)]+\/[^/\s)]+\/pull\/\d+(?:[^\s)]*)?/i);
  return match ? pullRequestRefFromUrl(match[0]) : null;
}

function requireIssueIdentifier(issue: { id: string; identifier: string | null }) {
  if (!issue.identifier) {
    throw new Error(`Issue ${issue.id} is missing identifier`);
  }
  return issue.identifier;
}

function buildIssueLink(issue: { id: string; identifier: string | null }) {
  const identifier = requireIssueIdentifier(issue);
  const prefix = identifier.split("-")[0] ?? identifier;
  return `/${prefix}/issues/${identifier}`;
}

function buildIssueCommentLink(issue: { id: string; identifier: string | null }, commentId: string) {
  return `${buildIssueLink(issue)}#comment-${commentId}`;
}

function extractHeadSha(metadata: Record<string, unknown> | null) {
  if (!metadata) return null;
  return (
    asNonEmptyString(metadata.headSha)
    ?? asNonEmptyString(metadata.headCommitSha)
    ?? asNonEmptyString(metadata.headRefSha)
    ?? asNonEmptyString(metadata.commitSha)
    ?? asNonEmptyString(metadata.sha)
    ?? null
  );
}

function extractHeadShaFromText(text: string | null | undefined) {
  if (!text) return null;
  const match = text.match(
    /\bhead(?:\s+atual|\s+sha|\s+commit|\s+ref)?\b[^0-9a-fA-F]{0,16}([0-9a-fA-F]{7,40})\b/i,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function resolvedPullRequestRefFromWorkProduct(product: IssueWorkProduct): ResolvedPullRequestRef | null {
  const fromUrl = pullRequestRefFromUrl(product.url);
  if (fromUrl) return fromUrl;

  const metadata = isRecord(product.metadata) ? product.metadata : null;
  const repoFullName =
    asNonEmptyString(metadata?.repoFullName)
    ?? asNonEmptyString(metadata?.repositoryFullName)
    ?? asNonEmptyString(metadata?.repo)
    ?? null;
  const prNumber = asPositiveInteger(metadata?.prNumber) ?? asPositiveInteger(product.externalId);
  if (!repoFullName || !prNumber) return null;
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    repoFullName,
    prNumber,
    url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
  };
}

function parseReviewTicketPullRequest(issue: Pick<IssueListItem, "title" | "description">) {
  return extractPullRequestRefFromText(issue.description) ?? extractPullRequestRefFromText(issue.title);
}

function normalizeFreeformText(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .toLowerCase();
}

function commentDeclaresNoNewDiff(commentBody: string | null | undefined) {
  if (!commentBody) return false;
  const normalized = normalizeFreeformText(commentBody);
  return [
    "sem alterar codigo, commit, push ou pr",
    "sem alterar codigo, commit ou pr",
    "sem alterar codigo, commit",
    "sem novo diff",
    "sem novas mudancas de codigo",
    "sem novas mudancas de codigo nesta rodada",
    "sem novas alteracoes de codigo",
    "sem novas alteracoes",
    "mesmo change set",
    "mesmo diff ja entregue",
    "mantive o mesmo change set",
    "sem diff novo",
    "nao houve diff novo",
    "nao houve novo diff",
    "sem novo diff nem novo commit",
    "nao houve novo diff nem novo commit",
    "diff permaneceu inalterado",
    "codigo permaneceu inalterado",
    "estado do codigo: inalterado",
    "estado do codigo inalterado",
    "inalterado desde o commit",
    "codigo inalterado desde o commit",
  ].some((pattern) => normalized.includes(pattern));
}

function commentSignalsExplicitReviewHandoff(commentBody: string | null | undefined) {
  if (!commentBody) return false;
  const normalized = normalizeFreeformText(commentBody);
  const suppressingPatterns = [
    "sem novo handoff",
    "nao estou emitindo novo handoff",
    "nao houve novo handoff",
  ];
  if (suppressingPatterns.some((pattern) => normalized.includes(pattern))) return false;
  return /(^|\n)\s*#+\s*handoff\b/.test(normalized) || /(^|\s)@revisor pr\b/.test(normalized);
}

function buildArtifactTitle(ref: ResolvedPullRequestRef, rawTitle: string | null | undefined) {
  const normalized = asNonEmptyString(rawTitle);
  if (!normalized) return `PR #${ref.prNumber}`;
  return normalized;
}

function buildReviewDescription(input: {
  sourceIssue: NonNullable<IssueSummary>;
  artifact: ResolvedReviewArtifact;
  previousReview: PreviousReviewReference | null;
}) {
  const { sourceIssue, artifact, previousReview } = input;
  const sourceIssueLink = `[${sourceIssue.identifier}](${buildIssueLink(sourceIssue)})`;
  const lines = [
    "## Contexto",
    "",
    `${sourceIssueLink} entrou em \`handoff_ready\` e precisa de revisão técnica para o diff atual.`,
  ];

  if (artifact.source === "comment" && artifact.sourceLink) {
    lines.push(`- Handoff atual: [comentario mais recente](${artifact.sourceLink})`);
  } else if (artifact.bodyContext) {
    lines.push(`- Origem do PR: ${artifact.bodyContext}`);
  }
  if (artifact.headSha) {
    lines.push(`- Head do diff atual: \`${artifact.headSha}\``);
  }

  if (previousReview?.issue) {
    const previousLink = `[${previousReview.issue.identifier}](${buildIssueLink(previousReview.issue)})`;
    const previousPrLabel = previousReview.pullRequest ? `PR #${previousReview.pullRequest.prNumber}` : "diff anterior";
    lines.push(`- Revisão anterior relacionada: ${previousLink} (${previousPrLabel})`);
  }

  lines.push(
    "",
    "## Objetivo",
    "",
    `Revisar tecnicamente o PR #${artifact.pullRequest.prNumber} com foco em bugs, regressões, riscos de segurança, aderência aos padrões do repositório e suficiência dos testes.`,
    "",
    "## Definition of Done",
    "",
    `- Revisão publicada no GitHub em ${artifact.pullRequest.url}`,
    "- Antes de declarar bloqueio de autenticação/acesso ao GitHub, validar no terminal com `gh auth status` e registrar o resultado no comentário da issue",
    "- Resumo objetivo postado nesta issue com findings ordenados por severidade",
    `- Se houver ajustes: indicar retorno de ${sourceIssueLink} para \`in_progress\``,
    `- Se não houver findings bloqueantes: registrar que ${sourceIssueLink} pode seguir para revisão humana final/merge`,
    "",
    "## Links",
    "",
    `- Issue fonte: ${sourceIssueLink}`,
    `- PR atual: ${artifact.pullRequest.url}`,
  );

  if (previousReview?.issue) {
    lines.push(`- Revisão anterior: [${previousReview.issue.identifier}](${buildIssueLink(previousReview.issue)})`);
  }

  return lines.join("\n");
}

function buildCommentArtifact(sourceIssue: NonNullable<IssueSummary>, comment: NonNullable<IssueComment>) {
  const pullRequest = extractPullRequestRefFromText(comment.body);
  if (!pullRequest) return null;
  const noNewDiff = commentDeclaresNoNewDiff(comment.body);
  const headSha = extractHeadShaFromText(comment.body);
  return {
    source: "comment" as const,
    sourceId: comment.id,
    sourceCreatedAt: comment.createdAt,
    sourceLink: buildIssueCommentLink(sourceIssue, comment.id),
    title: buildArtifactTitle(pullRequest, null),
    bodyContext: "comentario de handoff com link de PR",
    pullRequest,
    diffIdentity: noNewDiff
      ? `github:${pullRequest.repoFullName}:pr:${pullRequest.prNumber}:no-new-diff`
      : (headSha
        ? `github:${pullRequest.repoFullName}:pr:${pullRequest.prNumber}:head:${headSha}`
        : `github:${pullRequest.repoFullName}:pr:${pullRequest.prNumber}:comment:${comment.id}`),
    headSha,
  };
}

function buildDescriptionArtifact(sourceIssue: NonNullable<IssueSummary>) {
  const pullRequest = extractPullRequestRefFromText(sourceIssue.description);
  if (!pullRequest) return null;
  return {
    source: "description" as const,
    sourceId: `${sourceIssue.id}:description`,
    sourceCreatedAt: null,
    sourceLink: buildIssueLink(sourceIssue),
    title: buildArtifactTitle(pullRequest, null),
    bodyContext: "descricao da issue fonte",
    pullRequest,
    diffIdentity: `github:${pullRequest.repoFullName}:pr:${pullRequest.prNumber}:description`,
    headSha: extractHeadShaFromText(sourceIssue.description),
  };
}

function buildWorkProductArtifact(product: IssueWorkProduct) {
  const pullRequest = resolvedPullRequestRefFromWorkProduct(product);
  if (!pullRequest) return null;
  const metadata = isRecord(product.metadata) ? product.metadata : null;
  const headSha = extractHeadSha(metadata);
  return {
    source: "work_product" as const,
    sourceId: product.id,
    sourceCreatedAt: product.updatedAt,
    sourceLink: product.url ?? null,
    title: buildArtifactTitle(pullRequest, product.title),
    bodyContext: "work product de PR anexado na issue",
    pullRequest,
    diffIdentity: headSha
      ? `github:${pullRequest.repoFullName}:pr:${pullRequest.prNumber}:head:${headSha}`
      : `github:${pullRequest.repoFullName}:pr:${pullRequest.prNumber}:work-product:${product.id}:${product.updatedAt.toISOString()}`,
    headSha,
  };
}

export function reviewDispatchService(db: Db, deps: ReviewDispatchDeps = {}) {
  const agents = deps.agents ?? agentService(db);
  const issues = deps.issues ?? issueService(db);
  const workProducts = deps.workProducts ?? workProductService(db);
  const companies = deps.companies ?? companyService(db);

  async function resolveReviewerReferenceString(companyId: string) {
    const row = await companies.getById(companyId);
    const fromCompany = row?.technicalReviewerReference?.trim();
    if (fromCompany) return fromCompany;
    const fromEnv = technicalReviewerReferenceFromEnv();
    if (fromEnv) return fromEnv;
    return DEFAULT_TECHNICAL_REVIEWER_REFERENCE;
  }

  async function resolveReviewer(companyId: string) {
    const reference = await resolveReviewerReferenceString(companyId);
    const resolved = await agents.resolveByReference(companyId, reference);
    if (resolved.ambiguous) {
      return { reviewer: null as AgentSummary | null, noopReason: "reviewer_ambiguous" as const };
    }
    if (!resolved.agent) {
      return { reviewer: null as AgentSummary | null, noopReason: "reviewer_not_found" as const };
    }
    return { reviewer: resolved.agent, noopReason: null as null };
  }

  async function resolveArtifact(sourceIssue: NonNullable<IssueSummary>, comment: IssueComment | null | undefined) {
    // Same-PATCH handoff comment should take precedence because it reflects the latest
    // executor intent for this transition into `handoff_ready`.
    if (comment) {
      const fromCurrentComment = buildCommentArtifact(sourceIssue, comment);
      if (fromCurrentComment) return fromCurrentComment;
    }

    const products = await workProducts.listForIssue(sourceIssue.id);
    for (const product of products) {
      if (product.type !== "pull_request") continue;
      const artifact = buildWorkProductArtifact(product);
      if (artifact) return artifact;
    }

    const latestComments = await issues.listComments(sourceIssue.id, { order: "desc", limit: 20 });
    let newestCommentWithPr: ReturnType<typeof buildCommentArtifact> = null;
    for (const entry of latestComments) {
      const artifact = buildCommentArtifact(sourceIssue, entry);
      if (!artifact) continue;
      if (!newestCommentWithPr) newestCommentWithPr = artifact;
      if (commentSignalsExplicitReviewHandoff(entry.body) || commentDeclaresNoNewDiff(entry.body)) {
        return artifact;
      }
    }
    if (newestCommentWithPr) return newestCommentWithPr;

    return buildDescriptionArtifact(sourceIssue);
  }

  function findPreviousReview(
    childIssues: ReviewIssueRecord[],
    artifact: ResolvedReviewArtifact,
    excludedIssueId?: string,
  ): PreviousReviewReference | null {
    const candidate = childIssues
      .filter((child) => child.id !== excludedIssueId)
      .map((child) => ({ issue: child, pullRequest: parseReviewTicketPullRequest(child) }))
      .sort((left, right) => new Date(right.issue.createdAt).getTime() - new Date(left.issue.createdAt).getTime())
      .find(({ issue, pullRequest }) =>
        issue.originKind === REVIEW_DISPATCH_ORIGIN_KIND
          || (pullRequest?.repoFullName === artifact.pullRequest.repoFullName),
      );

    return candidate ?? null;
  }

  function matchExistingReview(
    childIssues: ReviewIssueRecord[],
    artifact: ResolvedReviewArtifact,
  ): { reviewIssue: ReviewIssueRecord; dedupReason: ReviewDispatchDedupReason } | null {
    const byOrigin = childIssues.find((child) =>
      child.originKind === REVIEW_DISPATCH_ORIGIN_KIND
      && child.originId === artifact.diffIdentity,
    );
    if (byOrigin) {
      return {
        reviewIssue: byOrigin,
        dedupReason: artifact.diffIdentity.endsWith(":no-new-diff") ? "no_new_diff_declared" : "exact_diff_identity",
      };
    }

    if (artifact.source === "comment" && artifact.sourceCreatedAt) {
      const fallback = childIssues
        .filter((child) => parseReviewTicketPullRequest(child)?.url === artifact.pullRequest.url)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .find((child) => new Date(child.createdAt).getTime() >= artifact.sourceCreatedAt!.getTime());
      if (fallback) {
        return {
          reviewIssue: fallback,
          dedupReason: "same_pr_recent_comment",
        };
      }
    }

    if (artifact.headSha) {
      const sameHead = childIssues.find((child) =>
        child.originKind === REVIEW_DISPATCH_ORIGIN_KIND
        && child.originId === `github:${artifact.pullRequest.repoFullName}:pr:${artifact.pullRequest.prNumber}:head:${artifact.headSha}`,
      );
      if (sameHead) {
        return {
          reviewIssue: sameHead,
          dedupReason: "same_head_sha",
        };
      }
    }

    if (artifact.source !== "comment") {
      const fallback = childIssues.find((child) =>
        !TERMINAL_ISSUE_STATUSES.has(child.status)
        && parseReviewTicketPullRequest(child)?.url === artifact.pullRequest.url,
      );
      if (fallback) {
        return {
          reviewIssue: fallback,
          dedupReason: "same_pr_existing_artifact",
        };
      }
    }

    if (artifact.diffIdentity.endsWith(":no-new-diff")) {
      const samePullRequest = childIssues
        .filter((child) => parseReviewTicketPullRequest(child)?.url === artifact.pullRequest.url)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
      if (samePullRequest) {
        return {
          reviewIssue: samePullRequest,
          dedupReason: "no_new_diff_declared",
        };
      }
    }

    return null;
  }

  async function dispatchForIssue(input: {
    issueId: string;
    commentId?: string | null;
  }): Promise<ReviewDispatchResult> {
    const sourceIssue = await issues.getById(input.issueId);
    if (!sourceIssue) return { kind: "noop", reason: "issue_not_found" };
    if (sourceIssue.status !== "handoff_ready") return { kind: "noop", reason: "status_not_handoff_ready" };

    const { reviewer, noopReason: reviewerResolution } = await resolveReviewer(sourceIssue.companyId);
    if (!reviewer) {
      return {
        kind: "noop",
        reason: reviewerResolution ?? "reviewer_not_found",
      };
    }

    const comment = input.commentId ? await issues.getComment(input.commentId) : null;
    const artifact = await resolveArtifact(sourceIssue, comment);
    if (!artifact) return { kind: "noop", reason: "pull_request_not_found" };

    const childIssues = await issues.list(sourceIssue.companyId, { parentId: sourceIssue.id });
    const reviewerChildren = childIssues.filter((child) => child.assigneeAgentId === reviewer.id);
    const existingReview = matchExistingReview(reviewerChildren, artifact);
    if (existingReview) {
      return {
        kind: TERMINAL_ISSUE_STATUSES.has(existingReview.reviewIssue.status) ? "already_reviewed" : "reused",
        artifact,
        reviewIssue: existingReview.reviewIssue,
        reviewer,
        dedupReason: existingReview.dedupReason,
      };
    }

    const previousReview = findPreviousReview(reviewerChildren, artifact);
    const created = await issues.create(sourceIssue.companyId, {
      title: `Revisar PR #${artifact.pullRequest.prNumber} de ${sourceIssue.identifier}`,
      description: buildReviewDescription({
        sourceIssue,
        artifact,
        previousReview,
      }),
      status: "todo",
      priority: sourceIssue.priority,
      assigneeAgentId: reviewer.id,
      projectId: sourceIssue.projectId,
      projectWorkspaceId: sourceIssue.projectWorkspaceId,
      goalId: sourceIssue.goalId,
      parentId: sourceIssue.id,
      billingCode: sourceIssue.billingCode,
      executionWorkspaceId: sourceIssue.executionWorkspaceId,
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: artifact.diffIdentity,
    });

    return {
      kind: "created",
      artifact,
      reviewIssue: created,
      reviewer,
    };
  }

  return {
    dispatchForIssue,
  };
}

export { REVIEW_DISPATCH_ORIGIN_KIND };
