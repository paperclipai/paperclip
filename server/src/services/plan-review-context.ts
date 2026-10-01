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
  DocumentReviewContext,
  DocumentReviewContextDocument,
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

type BuildDocumentReviewContextInput = Omit<BuildPlanReviewContextInput, "issueWorkMode" | "interactionId">;

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
  // Issue-scoped interaction routes historically allowed the target to omit
  // issueId because the parent interaction already supplies that boundary.
  // Preserve an explicit mismatch check without dropping otherwise valid
  // plan-review results (including the reviewer's rejection reason).
  const targetIssueId = nonEmptyString(target.issueId);
  if (targetIssueId !== null && targetIssueId !== issueId) return null;
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

/**
 * Builds the non-plan half of issue-document review context. Plan context stays
 * on its legacy builder and payload field so plan-only wakes remain byte-for-byte
 * compatible. Budgets are shared across documents, while each document also
 * observes the legacy per-document limits.
 */
export async function buildDocumentReviewContext(
  input: BuildDocumentReviewContextInput,
): Promise<DocumentReviewContext | null> {
  if (input.includeForIssueComment !== true && input.includeForAnnotationDelta !== true) return null;

  const documentRows = await input.db
    .select({
      documentId: documents.id,
      documentKey: issueDocuments.key,
      title: documents.title,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
      updatedAt: issueDocuments.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(
      eq(issueDocuments.companyId, input.companyId),
      eq(issueDocuments.issueId, input.issueId),
      eq(documents.companyId, input.companyId),
      sql`${issueDocuments.key} <> 'plan'`,
    ))
    .orderBy(desc(issueDocuments.updatedAt), desc(issueDocuments.id));
  if (documentRows.length === 0) return null;

  let remainingThreads = PLAN_REVIEW_CONTEXT_LIMITS.maxThreads;
  let remainingComments = PLAN_REVIEW_CONTEXT_LIMITS.maxComments;
  let remainingBodyChars = PLAN_REVIEW_CONTEXT_LIMITS.maxTotalBodyChars;
  let totalOpenThreads = 0;
  let totalComments = 0;
  let includedThreads = 0;
  let includedComments = 0;
  let truncated = false;
  const groupedDocuments: DocumentReviewContextDocument[] = [];

  for (const document of documentRows) {
    const [{ count: openThreadCount }] = await input.db
      .select({ count: sql<number>`count(*)::int` })
      .from(documentAnnotationThreads)
      .where(and(
        eq(documentAnnotationThreads.companyId, input.companyId),
        eq(documentAnnotationThreads.issueId, input.issueId),
        eq(documentAnnotationThreads.documentId, document.documentId),
        eq(documentAnnotationThreads.documentKey, document.documentKey),
        eq(documentAnnotationThreads.status, "open"),
      ));
    if (openThreadCount === 0) continue;

    const perDocumentThreadLimit = Math.min(PLAN_REVIEW_CONTEXT_LIMITS.maxThreads, remainingThreads);
    const threadRows = perDocumentThreadLimit === 0 ? [] : await input.db
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
        eq(documentAnnotationThreads.documentId, document.documentId),
        eq(documentAnnotationThreads.documentKey, document.documentKey),
        eq(documentAnnotationThreads.status, "open"),
      ))
      .orderBy(desc(documentAnnotationThreads.updatedAt), desc(documentAnnotationThreads.id))
      .limit(perDocumentThreadLimit);

    const threadIds = threadRows.map((thread) => thread.id);
    const perDocumentCommentLimit = Math.min(PLAN_REVIEW_CONTEXT_LIMITS.maxComments, remainingComments);
    const commentRows = threadIds.length === 0 || perDocumentCommentLimit === 0 ? [] : await input.db
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
        eq(documentAnnotationComments.documentId, document.documentId),
        inArray(documentAnnotationComments.threadId, threadIds),
      ))
      .orderBy(asc(documentAnnotationComments.createdAt), asc(documentAnnotationComments.id))
      .limit(perDocumentCommentLimit);

    const [{ count: commentCount }] = await input.db
      .select({ count: sql<number>`count(*)::int` })
      .from(documentAnnotationComments)
      .innerJoin(documentAnnotationThreads, eq(documentAnnotationComments.threadId, documentAnnotationThreads.id))
      .where(and(
        eq(documentAnnotationComments.companyId, input.companyId),
        eq(documentAnnotationComments.issueId, input.issueId),
        eq(documentAnnotationComments.documentId, document.documentId),
        eq(documentAnnotationThreads.companyId, input.companyId),
        eq(documentAnnotationThreads.issueId, input.issueId),
        eq(documentAnnotationThreads.documentId, document.documentId),
        eq(documentAnnotationThreads.documentKey, document.documentKey),
        eq(documentAnnotationThreads.status, "open"),
      ));

    const commentsByThread = new Map<string, typeof commentRows>();
    for (const comment of commentRows) {
      const current = commentsByThread.get(comment.threadId) ?? [];
      current.push(comment);
      commentsByThread.set(comment.threadId, current);
    }

    let documentIncludedComments = 0;
    let documentTruncated = openThreadCount > threadRows.length;
    const threads = threadRows.map((thread) => {
      const selectedText = truncateText(thread.selectedText, PLAN_REVIEW_CONTEXT_LIMITS.maxAnchorTextChars);
      const prefixText = truncateText(thread.prefixText, PLAN_REVIEW_CONTEXT_LIMITS.maxAnchorTextChars);
      const suffixText = truncateText(thread.suffixText, PLAN_REVIEW_CONTEXT_LIMITS.maxAnchorTextChars);
      if (selectedText.truncated || prefixText.truncated || suffixText.truncated) documentTruncated = true;
      const sourceComments = commentsByThread.get(thread.id) ?? [];
      const comments = [];
      for (const comment of sourceComments) {
        if (remainingComments <= 0 || remainingBodyChars <= 0) {
          documentTruncated = true;
          break;
        }
        const body = truncateText(
          comment.body,
          Math.min(PLAN_REVIEW_CONTEXT_LIMITS.maxBodyChars, remainingBodyChars),
        );
        if (body.truncated) documentTruncated = true;
        remainingBodyChars -= body.text.length;
        remainingComments -= 1;
        documentIncludedComments += 1;
        includedComments += 1;
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
      const commentsTruncated = comments.length < sourceComments.length;
      if (commentsTruncated) documentTruncated = true;
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
        commentCount: sourceComments.length,
        comments,
        commentsTruncated,
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      };
    });

    remainingThreads -= threads.length;
    totalOpenThreads += openThreadCount;
    totalComments += commentCount;
    includedThreads += threads.length;
    if (commentCount > documentIncludedComments) documentTruncated = true;
    if (documentTruncated) truncated = true;
    groupedDocuments.push({
      documentKey: document.documentKey,
      documentId: document.documentId,
      title: document.title,
      latestRevisionId: document.latestRevisionId,
      latestRevisionNumber: document.latestRevisionNumber,
      threads,
      totals: {
        openThreadCount,
        includedThreadCount: threads.length,
        omittedThreadCount: Math.max(0, openThreadCount - threads.length),
        commentCount,
        includedCommentCount: documentIncludedComments,
        omittedCommentCount: Math.max(0, commentCount - documentIncludedComments),
      },
      truncated: documentTruncated,
    });
  }

  if (groupedDocuments.length === 0) return null;
  return {
    issueId: input.issueId,
    documents: groupedDocuments,
    totals: {
      openThreadCount: totalOpenThreads,
      includedThreadCount: includedThreads,
      omittedThreadCount: Math.max(0, totalOpenThreads - includedThreads),
      commentCount: totalComments,
      includedCommentCount: includedComments,
      omittedCommentCount: Math.max(0, totalComments - includedComments),
    },
    limits: { ...PLAN_REVIEW_CONTEXT_LIMITS },
    truncated,
  };
}
