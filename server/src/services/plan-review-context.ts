import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documentAnnotationComments,
  documentAnnotationThreads,
  documents,
  issueDocuments,
  issueThreadInteractions,
} from "@paperclipai/db";
import type {
  PlanReviewContext,
  PlanReviewContextAuthor,
  PlanReviewInteractionContext,
  PlanReviewInteractionResultContext,
  PlanReviewInteractionTargetContext,
} from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";

export const PLAN_REVIEW_CONTEXT_LIMITS = {
  maxThreads: 20,
  maxComments: 80,
  maxBodyChars: 1_200,
  maxTotalBodyChars: 12_000,
  maxAnchorTextChars: 500,
} as const;

type BuildPlanReviewContextInput = {
  db: Db;
  companyId: string;
  issueId: string;
  issueWorkMode?: string | null;
  includeForIssueComment?: boolean;
  includeForAnnotationDelta?: boolean;
  interactionId?: string | null;
};

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

function authorFrom(row: {
  authorType?: string | null;
  authorAgentId?: string | null;
  authorUserId?: string | null;
}): PlanReviewContextAuthor {
  if (row.authorAgentId) return { type: "agent", id: row.authorAgentId };
  if (row.authorUserId) return { type: "user", id: row.authorUserId };
  return {
    type: row.authorType === "agent" || row.authorType === "user" || row.authorType === "system"
      ? row.authorType
      : "system",
    id: null,
  };
}

function readPlanTarget(value: unknown, issueId: string): PlanReviewInteractionTargetContext | null {
  const target = parseObject(value);
  if (target.type !== "issue_document") return null;
  if (target.key !== "plan") return null;
  if (nonEmptyString(target.issueId) !== issueId) return null;
  return {
    issueId,
    documentId: nonEmptyString(target.documentId),
    key: "plan",
    revisionId: nonEmptyString(target.revisionId),
    revisionNumber: typeof target.revisionNumber === "number" ? target.revisionNumber : null,
  };
}

function readResult(value: unknown): PlanReviewInteractionResultContext | null {
  const result = parseObject(value);
  if (Object.keys(result).length === 0) return null;
  return {
    outcome: nonEmptyString(result.outcome),
    reason: nonEmptyString(result.reason) ?? nonEmptyString(result.rejectionReason),
    commentId: nonEmptyString(result.commentId),
  };
}

async function getPlanInteractionContext(input: {
  db: Db;
  companyId: string;
  issueId: string;
  interactionId: string | null;
}): Promise<PlanReviewInteractionContext | null> {
  if (!input.interactionId) return null;

  const row = await input.db
    .select({
      id: issueThreadInteractions.id,
      kind: issueThreadInteractions.kind,
      status: issueThreadInteractions.status,
      continuationPolicy: issueThreadInteractions.continuationPolicy,
      sourceCommentId: issueThreadInteractions.sourceCommentId,
      sourceRunId: issueThreadInteractions.sourceRunId,
      payload: issueThreadInteractions.payload,
      result: issueThreadInteractions.result,
      resolvedAt: issueThreadInteractions.resolvedAt,
    })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.id, input.interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
    ))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  const payload = parseObject(row.payload);
  const target = readPlanTarget(payload.target, input.issueId);
  if (!target) return null;
  const result = readResult(row.result);

  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    continuationPolicy: row.continuationPolicy,
    sourceCommentId: row.sourceCommentId ?? null,
    sourceRunId: row.sourceRunId ?? null,
    target,
    acceptedTargetRevision: row.status === "accepted" ? target : null,
    result,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

export async function buildPlanReviewContext(input: BuildPlanReviewContextInput): Promise<PlanReviewContext | null> {
  const interaction = await getPlanInteractionContext({
    db: input.db,
    companyId: input.companyId,
    issueId: input.issueId,
    interactionId: nonEmptyString(input.interactionId),
  });
  const shouldInclude =
    input.issueWorkMode === "planning" ||
    input.includeForIssueComment === true ||
    input.includeForAnnotationDelta === true ||
    interaction !== null;
  if (!shouldInclude) return null;

  const planDocument = await input.db
    .select({
      documentId: documents.id,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(
      eq(issueDocuments.companyId, input.companyId),
      eq(issueDocuments.issueId, input.issueId),
      eq(issueDocuments.key, "plan"),
      eq(documents.companyId, input.companyId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!planDocument) return null;

  const [{ count: openThreadCount }] = await input.db
    .select({ count: sql<number>`count(*)::int` })
    .from(documentAnnotationThreads)
    .where(and(
      eq(documentAnnotationThreads.companyId, input.companyId),
      eq(documentAnnotationThreads.issueId, input.issueId),
      eq(documentAnnotationThreads.documentId, planDocument.documentId),
      eq(documentAnnotationThreads.documentKey, "plan"),
      eq(documentAnnotationThreads.status, "open"),
    ));

  const threadRows = await input.db
    .select({
      id: documentAnnotationThreads.id,
      documentId: documentAnnotationThreads.documentId,
      documentKey: documentAnnotationThreads.documentKey,
      status: documentAnnotationThreads.status,
      revisionId: documentAnnotationThreads.currentRevisionId,
      revisionNumber: documentAnnotationThreads.currentRevisionNumber,
      anchorState: documentAnnotationThreads.anchorState,
      anchorConfidence: documentAnnotationThreads.anchorConfidence,
      selectedText: documentAnnotationThreads.selectedText,
      prefixText: documentAnnotationThreads.prefixText,
      suffixText: documentAnnotationThreads.suffixText,
      createdByAgentId: documentAnnotationThreads.createdByAgentId,
      createdByUserId: documentAnnotationThreads.createdByUserId,
      createdAt: documentAnnotationThreads.createdAt,
      updatedAt: documentAnnotationThreads.updatedAt,
    })
    .from(documentAnnotationThreads)
    .where(and(
      eq(documentAnnotationThreads.companyId, input.companyId),
      eq(documentAnnotationThreads.issueId, input.issueId),
      eq(documentAnnotationThreads.documentId, planDocument.documentId),
      eq(documentAnnotationThreads.documentKey, "plan"),
      eq(documentAnnotationThreads.status, "open"),
    ))
    .orderBy(desc(documentAnnotationThreads.updatedAt), desc(documentAnnotationThreads.id))
    .limit(PLAN_REVIEW_CONTEXT_LIMITS.maxThreads);

  const threadIds = threadRows.map((thread) => thread.id);
  const commentRows = threadIds.length === 0
    ? []
    : await input.db
      .select({
        id: documentAnnotationComments.id,
        threadId: documentAnnotationComments.threadId,
        body: documentAnnotationComments.body,
        authorType: documentAnnotationComments.authorType,
        authorAgentId: documentAnnotationComments.authorAgentId,
        authorUserId: documentAnnotationComments.authorUserId,
        createdAt: documentAnnotationComments.createdAt,
        updatedAt: documentAnnotationComments.updatedAt,
      })
      .from(documentAnnotationComments)
      .where(and(
        eq(documentAnnotationComments.companyId, input.companyId),
        eq(documentAnnotationComments.issueId, input.issueId),
        eq(documentAnnotationComments.documentId, planDocument.documentId),
        inArray(documentAnnotationComments.threadId, threadIds),
      ))
      .orderBy(asc(documentAnnotationComments.createdAt), asc(documentAnnotationComments.id))
      .limit(PLAN_REVIEW_CONTEXT_LIMITS.maxComments);

  const [{ count: commentCount }] = await input.db
    .select({ count: sql<number>`count(*)::int` })
    .from(documentAnnotationComments)
    .innerJoin(documentAnnotationThreads, eq(documentAnnotationComments.threadId, documentAnnotationThreads.id))
    .where(and(
      eq(documentAnnotationComments.companyId, input.companyId),
      eq(documentAnnotationComments.issueId, input.issueId),
      eq(documentAnnotationComments.documentId, planDocument.documentId),
      eq(documentAnnotationThreads.companyId, input.companyId),
      eq(documentAnnotationThreads.issueId, input.issueId),
      eq(documentAnnotationThreads.documentId, planDocument.documentId),
      eq(documentAnnotationThreads.documentKey, "plan"),
      eq(documentAnnotationThreads.status, "open"),
    ));

  const commentsByThread = new Map<string, typeof commentRows>();
  for (const comment of commentRows) {
    const existing = commentsByThread.get(comment.threadId) ?? [];
    existing.push(comment);
    commentsByThread.set(comment.threadId, existing);
  }

  let remainingBodyChars = PLAN_REVIEW_CONTEXT_LIMITS.maxTotalBodyChars;
  let includedCommentCount = 0;
  let truncated = openThreadCount > threadRows.length;
  const threads = threadRows.map((thread) => {
    const selectedText = truncateText(thread.selectedText, PLAN_REVIEW_CONTEXT_LIMITS.maxAnchorTextChars);
    const prefixText = truncateText(thread.prefixText, PLAN_REVIEW_CONTEXT_LIMITS.maxAnchorTextChars);
    const suffixText = truncateText(thread.suffixText, PLAN_REVIEW_CONTEXT_LIMITS.maxAnchorTextChars);
    if (selectedText.truncated || prefixText.truncated || suffixText.truncated) truncated = true;

    const threadComments = commentsByThread.get(thread.id) ?? [];
    const comments = [];
    for (const comment of threadComments) {
      if (includedCommentCount >= PLAN_REVIEW_CONTEXT_LIMITS.maxComments || remainingBodyChars <= 0) {
        truncated = true;
        break;
      }
      const allowedChars = Math.min(PLAN_REVIEW_CONTEXT_LIMITS.maxBodyChars, remainingBodyChars);
      const body = truncateText(comment.body, allowedChars);
      if (body.truncated) truncated = true;
      remainingBodyChars -= body.text.length;
      includedCommentCount += 1;
      comments.push({
        id: comment.id,
        threadId: comment.threadId,
        body: body.text,
        bodyTruncated: body.truncated,
        author: authorFrom(comment),
        createdAt: comment.createdAt.toISOString(),
        updatedAt: comment.updatedAt.toISOString(),
      });
    }

    const commentsTruncated = comments.length < threadComments.length;
    if (commentsTruncated) truncated = true;

    return {
      id: thread.id,
      documentKey: thread.documentKey,
      documentId: thread.documentId,
      status: thread.status,
      revisionId: thread.revisionId,
      revisionNumber: thread.revisionNumber,
      anchorState: thread.anchorState,
      anchorConfidence: thread.anchorConfidence,
      selectedText: selectedText.text,
      selectedTextTruncated: selectedText.truncated,
      prefixText: prefixText.text,
      prefixTextTruncated: prefixText.truncated,
      suffixText: suffixText.text,
      suffixTextTruncated: suffixText.truncated,
      author: authorFrom({ authorAgentId: thread.createdByAgentId, authorUserId: thread.createdByUserId }),
      commentCount: threadComments.length,
      comments,
      commentsTruncated,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    };
  });

  const omittedCommentCount = Math.max(0, commentCount - includedCommentCount);
  if (omittedCommentCount > 0) truncated = true;

  return {
    documentKey: "plan",
    issueId: input.issueId,
    latestRevisionId: planDocument.latestRevisionId,
    latestRevisionNumber: planDocument.latestRevisionNumber,
    threads,
    interaction,
    totals: {
      openThreadCount,
      includedThreadCount: threads.length,
      omittedThreadCount: Math.max(0, openThreadCount - threads.length),
      commentCount,
      includedCommentCount,
      omittedCommentCount,
    },
    limits: { ...PLAN_REVIEW_CONTEXT_LIMITS },
    truncated,
  };
}
