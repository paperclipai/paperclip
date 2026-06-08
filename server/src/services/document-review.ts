import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documentAnnotationComments,
  documentAnnotationThreads,
  documentRevisions,
  documentReviewComments,
  documentReviewThreads,
  documentSuggestionAnchorSnapshots,
  documentSuggestionComments,
  documentSuggestions,
  documents,
  issueComments,
  issueDocuments,
} from "@paperclipai/db";
import {
  anchorSnapshotToSelector,
  remapDocumentAnchor,
  selectorToAnchorSnapshot,
  verifyDocumentAnchorSelector,
  type AcceptDocumentSuggestion,
  type CreateDocumentReviewComment,
  type CreateDocumentReviewThread,
  type CreateDocumentSuggestion,
  type CreateDocumentSuggestionComment,
  type DocumentAnnotationAnchorSnapshot,
  type DocumentAnnotationComment,
  type DocumentAnnotationThread,
  type DocumentReviewComment,
  type DocumentReviewIndex,
  type DocumentReviewThread,
  type DocumentSuggestion,
  type DocumentSuggestionComment,
  type RejectDocumentSuggestion,
  type ResolveDocumentSuggestion,
  type UpdateDocumentReviewThread,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type ActorInput = {
  actorType: "agent" | "user";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type IssueDocumentRow = {
  issueId: string;
  companyId: string;
  documentId: string;
  documentKey: string;
  title: string | null;
  format: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
};

const annotationThreadSelect = {
  id: documentAnnotationThreads.id,
  companyId: documentAnnotationThreads.companyId,
  issueId: documentAnnotationThreads.issueId,
  documentId: documentAnnotationThreads.documentId,
  documentKey: documentAnnotationThreads.documentKey,
  status: documentAnnotationThreads.status,
  anchorState: documentAnnotationThreads.anchorState,
  anchorConfidence: documentAnnotationThreads.anchorConfidence,
  originalRevisionId: documentAnnotationThreads.originalRevisionId,
  originalRevisionNumber: documentAnnotationThreads.originalRevisionNumber,
  currentRevisionId: documentAnnotationThreads.currentRevisionId,
  currentRevisionNumber: documentAnnotationThreads.currentRevisionNumber,
  selectedText: documentAnnotationThreads.selectedText,
  prefixText: documentAnnotationThreads.prefixText,
  suffixText: documentAnnotationThreads.suffixText,
  normalizedStart: documentAnnotationThreads.normalizedStart,
  normalizedEnd: documentAnnotationThreads.normalizedEnd,
  markdownStart: documentAnnotationThreads.markdownStart,
  markdownEnd: documentAnnotationThreads.markdownEnd,
  anchorSelector: documentAnnotationThreads.anchorSelector,
  createdByAgentId: documentAnnotationThreads.createdByAgentId,
  createdByUserId: documentAnnotationThreads.createdByUserId,
  resolvedByAgentId: documentAnnotationThreads.resolvedByAgentId,
  resolvedByUserId: documentAnnotationThreads.resolvedByUserId,
  resolvedAt: documentAnnotationThreads.resolvedAt,
  createdAt: documentAnnotationThreads.createdAt,
  updatedAt: documentAnnotationThreads.updatedAt,
};

const annotationCommentSelect = {
  id: documentAnnotationComments.id,
  companyId: documentAnnotationComments.companyId,
  threadId: documentAnnotationComments.threadId,
  issueId: documentAnnotationComments.issueId,
  documentId: documentAnnotationComments.documentId,
  body: documentAnnotationComments.body,
  authorType: documentAnnotationComments.authorType,
  authorAgentId: documentAnnotationComments.authorAgentId,
  authorUserId: documentAnnotationComments.authorUserId,
  createdByRunId: documentAnnotationComments.createdByRunId,
  issueCommentId: documentAnnotationComments.issueCommentId,
  createdAt: documentAnnotationComments.createdAt,
  updatedAt: documentAnnotationComments.updatedAt,
};

const reviewThreadSelect = {
  id: documentReviewThreads.id,
  companyId: documentReviewThreads.companyId,
  issueId: documentReviewThreads.issueId,
  documentId: documentReviewThreads.documentId,
  documentKey: documentReviewThreads.documentKey,
  status: documentReviewThreads.status,
  createdByAgentId: documentReviewThreads.createdByAgentId,
  createdByUserId: documentReviewThreads.createdByUserId,
  resolvedByAgentId: documentReviewThreads.resolvedByAgentId,
  resolvedByUserId: documentReviewThreads.resolvedByUserId,
  resolvedAt: documentReviewThreads.resolvedAt,
  createdAt: documentReviewThreads.createdAt,
  updatedAt: documentReviewThreads.updatedAt,
};

const reviewCommentSelect = {
  id: documentReviewComments.id,
  companyId: documentReviewComments.companyId,
  threadId: documentReviewComments.threadId,
  issueId: documentReviewComments.issueId,
  documentId: documentReviewComments.documentId,
  body: documentReviewComments.body,
  authorType: documentReviewComments.authorType,
  authorAgentId: documentReviewComments.authorAgentId,
  authorUserId: documentReviewComments.authorUserId,
  createdByRunId: documentReviewComments.createdByRunId,
  issueCommentId: documentReviewComments.issueCommentId,
  createdAt: documentReviewComments.createdAt,
  updatedAt: documentReviewComments.updatedAt,
};

const suggestionSelect = {
  id: documentSuggestions.id,
  companyId: documentSuggestions.companyId,
  issueId: documentSuggestions.issueId,
  documentId: documentSuggestions.documentId,
  documentKey: documentSuggestions.documentKey,
  kind: documentSuggestions.kind,
  status: documentSuggestions.status,
  anchorState: documentSuggestions.anchorState,
  anchorConfidence: documentSuggestions.anchorConfidence,
  originalRevisionId: documentSuggestions.originalRevisionId,
  originalRevisionNumber: documentSuggestions.originalRevisionNumber,
  currentRevisionId: documentSuggestions.currentRevisionId,
  currentRevisionNumber: documentSuggestions.currentRevisionNumber,
  selectedText: documentSuggestions.selectedText,
  proposedText: documentSuggestions.proposedText,
  insertionPosition: documentSuggestions.insertionPosition,
  prefixText: documentSuggestions.prefixText,
  suffixText: documentSuggestions.suffixText,
  normalizedStart: documentSuggestions.normalizedStart,
  normalizedEnd: documentSuggestions.normalizedEnd,
  markdownStart: documentSuggestions.markdownStart,
  markdownEnd: documentSuggestions.markdownEnd,
  anchorSelector: documentSuggestions.anchorSelector,
  createdByAgentId: documentSuggestions.createdByAgentId,
  createdByUserId: documentSuggestions.createdByUserId,
  acceptedByAgentId: documentSuggestions.acceptedByAgentId,
  acceptedByUserId: documentSuggestions.acceptedByUserId,
  acceptedAt: documentSuggestions.acceptedAt,
  acceptedRevisionId: documentSuggestions.acceptedRevisionId,
  rejectedByAgentId: documentSuggestions.rejectedByAgentId,
  rejectedByUserId: documentSuggestions.rejectedByUserId,
  rejectedAt: documentSuggestions.rejectedAt,
  resolvedByAgentId: documentSuggestions.resolvedByAgentId,
  resolvedByUserId: documentSuggestions.resolvedByUserId,
  resolvedAt: documentSuggestions.resolvedAt,
  createdAt: documentSuggestions.createdAt,
  updatedAt: documentSuggestions.updatedAt,
};

const suggestionCommentSelect = {
  id: documentSuggestionComments.id,
  companyId: documentSuggestionComments.companyId,
  suggestionId: documentSuggestionComments.suggestionId,
  issueId: documentSuggestionComments.issueId,
  documentId: documentSuggestionComments.documentId,
  body: documentSuggestionComments.body,
  authorType: documentSuggestionComments.authorType,
  authorAgentId: documentSuggestionComments.authorAgentId,
  authorUserId: documentSuggestionComments.authorUserId,
  createdByRunId: documentSuggestionComments.createdByRunId,
  issueCommentId: documentSuggestionComments.issueCommentId,
  createdAt: documentSuggestionComments.createdAt,
  updatedAt: documentSuggestionComments.updatedAt,
};

function snapshotFromSuggestion(suggestion: Pick<DocumentSuggestion, "selectedText" | "prefixText" | "suffixText" | "normalizedStart" | "normalizedEnd" | "markdownStart" | "markdownEnd">): DocumentAnnotationAnchorSnapshot {
  return {
    selectedText: suggestion.selectedText,
    prefixText: suggestion.prefixText,
    suffixText: suggestion.suffixText,
    normalizedStart: suggestion.normalizedStart,
    normalizedEnd: suggestion.normalizedEnd,
    markdownStart: suggestion.markdownStart,
    markdownEnd: suggestion.markdownEnd,
  };
}

function applySuggestionToBody(body: string, suggestion: DocumentSuggestion) {
  if (suggestion.anchorState === "orphaned") {
    throw conflict("Cannot accept an orphaned suggestion", { suggestionId: suggestion.id });
  }
  if (suggestion.kind === "insertion") {
    const insertionText = suggestion.proposedText ?? "";
    if (!insertionText) throw unprocessable("Insertion suggestion is missing proposedText");
    const position = suggestion.insertionPosition === "before" ? suggestion.markdownStart : suggestion.markdownEnd;
    return `${body.slice(0, position)}${insertionText}${body.slice(position)}`;
  }
  if (suggestion.kind === "deletion") {
    return `${body.slice(0, suggestion.markdownStart)}${body.slice(suggestion.markdownEnd)}`;
  }
  const replacementText = suggestion.proposedText ?? "";
  if (!replacementText) throw unprocessable("Substitution suggestion is missing proposedText");
  return `${body.slice(0, suggestion.markdownStart)}${replacementText}${body.slice(suggestion.markdownEnd)}`;
}

export function documentReviewService(db: Db) {
  async function getIssueDocument(issueId: string, key: string, dbOrTx: any = db): Promise<IssueDocumentRow | null> {
    return dbOrTx
      .select({
        issueId: issueDocuments.issueId,
        companyId: documents.companyId,
        documentId: documents.id,
        documentKey: issueDocuments.key,
        title: documents.title,
        format: documents.format,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
      .then((rows: IssueDocumentRow[]) => rows[0] ?? null);
  }

  async function assertLinkedIssueComment(issueId: string, commentId: string | null | undefined, dbOrTx: any = db) {
    if (!commentId) return null;
    const comment = await dbOrTx
      .select({ id: issueComments.id, issueId: issueComments.issueId })
      .from(issueComments)
      .where(and(eq(issueComments.id, commentId), isNull(issueComments.deletedAt)))
      .then((rows: Array<{ id: string; issueId: string }>) => rows[0] ?? null);
    if (!comment || comment.issueId !== issueId) {
      throw unprocessable("Linked issue comment must belong to this issue");
    }
    return comment;
  }

  async function commentsForReviewThreads(threadIds: string[], dbOrTx: any = db): Promise<DocumentReviewComment[]> {
    if (threadIds.length === 0) return [];
    return dbOrTx
      .select(reviewCommentSelect)
      .from(documentReviewComments)
      .where(inArray(documentReviewComments.threadId, threadIds))
      .orderBy(asc(documentReviewComments.createdAt), asc(documentReviewComments.id));
  }

  async function commentsForSuggestions(suggestionIds: string[], dbOrTx: any = db): Promise<DocumentSuggestionComment[]> {
    if (suggestionIds.length === 0) return [];
    return dbOrTx
      .select(suggestionCommentSelect)
      .from(documentSuggestionComments)
      .where(inArray(documentSuggestionComments.suggestionId, suggestionIds))
      .orderBy(asc(documentSuggestionComments.createdAt), asc(documentSuggestionComments.id));
  }

  async function commentsForAnnotationThreads(threadIds: string[], dbOrTx: any = db): Promise<DocumentAnnotationComment[]> {
    if (threadIds.length === 0) return [];
    return dbOrTx
      .select(annotationCommentSelect)
      .from(documentAnnotationComments)
      .where(inArray(documentAnnotationComments.threadId, threadIds))
      .orderBy(asc(documentAnnotationComments.createdAt), asc(documentAnnotationComments.id));
  }

  async function getReviewThreadForIssue(issueId: string, documentKey: string, threadId: string, dbOrTx: any = db) {
    return dbOrTx
      .select(reviewThreadSelect)
      .from(documentReviewThreads)
      .where(and(
        eq(documentReviewThreads.id, threadId),
        eq(documentReviewThreads.issueId, issueId),
        eq(documentReviewThreads.documentKey, documentKey),
      ))
      .then((rows: DocumentReviewThread[]) => rows[0] ?? null);
  }

  async function getSuggestionForIssue(issueId: string, documentKey: string, suggestionId: string, dbOrTx: any = db) {
    return dbOrTx
      .select(suggestionSelect)
      .from(documentSuggestions)
      .where(and(
        eq(documentSuggestions.id, suggestionId),
        eq(documentSuggestions.issueId, issueId),
        eq(documentSuggestions.documentKey, documentKey),
      ))
      .then((rows: DocumentSuggestion[]) => rows[0] ?? null);
  }

  return {
    getReviewIndex: async (
      issueId: string,
      key: string,
      options: { status?: "open" | "all"; includeComments?: boolean } = {},
    ): Promise<DocumentReviewIndex> => {
      const doc = await getIssueDocument(issueId, key);
      if (!doc) throw notFound("Document not found");
      const openOnly = options.status !== "all";
      const annotationConditions = [
        eq(documentAnnotationThreads.issueId, issueId),
        eq(documentAnnotationThreads.documentId, doc.documentId),
      ];
      const reviewConditions = [
        eq(documentReviewThreads.issueId, issueId),
        eq(documentReviewThreads.documentId, doc.documentId),
      ];
      const suggestionConditions = [
        eq(documentSuggestions.issueId, issueId),
        eq(documentSuggestions.documentId, doc.documentId),
      ];
      if (openOnly) {
        annotationConditions.push(eq(documentAnnotationThreads.status, "open"));
        reviewConditions.push(eq(documentReviewThreads.status, "open"));
        suggestionConditions.push(eq(documentSuggestions.status, "pending"));
      }

      const [
        annotationThreads,
        reviewThreads,
        suggestions,
        annotationCountRows,
        reviewCountRows,
        suggestionCountRows,
      ] = await Promise.all([
        db.select(annotationThreadSelect).from(documentAnnotationThreads)
          .where(and(...annotationConditions))
          .orderBy(desc(documentAnnotationThreads.updatedAt), desc(documentAnnotationThreads.id)),
        db.select(reviewThreadSelect).from(documentReviewThreads)
          .where(and(...reviewConditions))
          .orderBy(desc(documentReviewThreads.updatedAt), desc(documentReviewThreads.id)),
        db.select(suggestionSelect).from(documentSuggestions)
          .where(and(...suggestionConditions))
          .orderBy(desc(documentSuggestions.updatedAt), desc(documentSuggestions.id)),
        db.select({
          openAnchoredThreads: sql<number>`count(*) filter (where ${documentAnnotationThreads.status} = 'open')`.mapWith(Number),
          resolvedAnchoredThreads: sql<number>`count(*) filter (where ${documentAnnotationThreads.status} = 'resolved')`.mapWith(Number),
          staleAnchors: sql<number>`count(*) filter (where ${documentAnnotationThreads.status} = 'open' and ${documentAnnotationThreads.anchorState} = 'stale')`.mapWith(Number),
          orphanedAnchors: sql<number>`count(*) filter (where ${documentAnnotationThreads.status} = 'open' and ${documentAnnotationThreads.anchorState} = 'orphaned')`.mapWith(Number),
        }).from(documentAnnotationThreads).where(and(
          eq(documentAnnotationThreads.issueId, issueId),
          eq(documentAnnotationThreads.documentId, doc.documentId),
        )),
        db.select({
          openReviewThreads: sql<number>`count(*) filter (where ${documentReviewThreads.status} = 'open')`.mapWith(Number),
          resolvedReviewThreads: sql<number>`count(*) filter (where ${documentReviewThreads.status} = 'resolved')`.mapWith(Number),
        }).from(documentReviewThreads).where(and(
          eq(documentReviewThreads.issueId, issueId),
          eq(documentReviewThreads.documentId, doc.documentId),
        )),
        db.select({
          pendingSuggestions: sql<number>`count(*) filter (where ${documentSuggestions.status} = 'pending')`.mapWith(Number),
          acceptedSuggestions: sql<number>`count(*) filter (where ${documentSuggestions.status} = 'accepted')`.mapWith(Number),
          rejectedSuggestions: sql<number>`count(*) filter (where ${documentSuggestions.status} = 'rejected')`.mapWith(Number),
          resolvedSuggestions: sql<number>`count(*) filter (where ${documentSuggestions.status} = 'resolved')`.mapWith(Number),
          staleAnchors: sql<number>`count(*) filter (where ${documentSuggestions.status} = 'pending' and ${documentSuggestions.anchorState} = 'stale')`.mapWith(Number),
          orphanedAnchors: sql<number>`count(*) filter (where ${documentSuggestions.status} = 'pending' and ${documentSuggestions.anchorState} = 'orphaned')`.mapWith(Number),
        }).from(documentSuggestions).where(and(
          eq(documentSuggestions.issueId, issueId),
          eq(documentSuggestions.documentId, doc.documentId),
        )),
      ]);

      const annotationCounts = annotationCountRows[0] ?? {
        openAnchoredThreads: 0,
        resolvedAnchoredThreads: 0,
        staleAnchors: 0,
        orphanedAnchors: 0,
      };
      const reviewCounts = reviewCountRows[0] ?? {
        openReviewThreads: 0,
        resolvedReviewThreads: 0,
      };
      const suggestionCounts = suggestionCountRows[0] ?? {
        pendingSuggestions: 0,
        acceptedSuggestions: 0,
        rejectedSuggestions: 0,
        resolvedSuggestions: 0,
        staleAnchors: 0,
        orphanedAnchors: 0,
      };
      const countsBase = {
        openAnchoredThreads: annotationCounts.openAnchoredThreads,
        resolvedAnchoredThreads: annotationCounts.resolvedAnchoredThreads,
        openReviewThreads: reviewCounts.openReviewThreads,
        resolvedReviewThreads: reviewCounts.resolvedReviewThreads,
        pendingSuggestions: suggestionCounts.pendingSuggestions,
        acceptedSuggestions: suggestionCounts.acceptedSuggestions,
        rejectedSuggestions: suggestionCounts.rejectedSuggestions,
        resolvedSuggestions: suggestionCounts.resolvedSuggestions,
        staleAnchors: annotationCounts.staleAnchors + suggestionCounts.staleAnchors,
        orphanedAnchors: annotationCounts.orphanedAnchors + suggestionCounts.orphanedAnchors,
      };
      const [annotationComments, reviewComments, suggestionComments] = options.includeComments
        ? await Promise.all([
          commentsForAnnotationThreads(annotationThreads.map((thread) => thread.id)),
          commentsForReviewThreads(reviewThreads.map((thread) => thread.id)),
          commentsForSuggestions(suggestions.map((suggestion) => suggestion.id)),
        ])
        : [[], [], []] as const;
      const annotationCommentsByThread = new Map<string, DocumentAnnotationComment[]>();
      for (const comment of annotationComments) {
        annotationCommentsByThread.set(comment.threadId, [...(annotationCommentsByThread.get(comment.threadId) ?? []), comment]);
      }
      const reviewCommentsByThread = new Map<string, DocumentReviewComment[]>();
      for (const comment of reviewComments) {
        reviewCommentsByThread.set(comment.threadId, [...(reviewCommentsByThread.get(comment.threadId) ?? []), comment]);
      }
      const commentsBySuggestion = new Map<string, DocumentSuggestionComment[]>();
      for (const comment of suggestionComments) {
        commentsBySuggestion.set(comment.suggestionId, [...(commentsBySuggestion.get(comment.suggestionId) ?? []), comment]);
      }

      return {
        issueId,
        documentId: doc.documentId,
        documentKey: doc.documentKey,
        latestRevisionId: doc.latestRevisionId,
        latestRevisionNumber: doc.latestRevisionNumber,
        counts: {
          ...countsBase,
          unresolved: countsBase.openAnchoredThreads + countsBase.openReviewThreads + countsBase.pendingSuggestions,
        },
        annotationThreads: annotationThreads.map((thread) => ({
          ...thread,
          comments: annotationCommentsByThread.get(thread.id) ?? [],
        })),
        reviewThreads: reviewThreads.map((thread) => ({
          ...thread,
          comments: reviewCommentsByThread.get(thread.id) ?? [],
        })),
        suggestions: suggestions.map((suggestion) => ({
          ...suggestion,
          comments: commentsBySuggestion.get(suggestion.id) ?? [],
        })),
      };
    },

    createReviewThread: async (
      issueId: string,
      key: string,
      input: CreateDocumentReviewThread,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const doc = await getIssueDocument(issueId, key, tx);
      if (!doc) throw notFound("Document not found");
      const now = new Date();
      const linkedIssueComment = await assertLinkedIssueComment(issueId, input.issueCommentId, tx);
      const [thread] = await tx.insert(documentReviewThreads).values({
        companyId: doc.companyId,
        issueId,
        documentId: doc.documentId,
        documentKey: doc.documentKey,
        status: "open",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdAt: now,
        updatedAt: now,
      }).returning(reviewThreadSelect);
      const [comment] = await tx.insert(documentReviewComments).values({
        companyId: doc.companyId,
        threadId: thread.id,
        issueId,
        documentId: doc.documentId,
        body: input.body,
        authorType: actor.actorType,
        authorAgentId: actor.agentId ?? null,
        authorUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
        issueCommentId: linkedIssueComment?.id ?? null,
        createdAt: now,
        updatedAt: now,
      }).returning(reviewCommentSelect);
      return { ...thread, comments: [comment] };
    }),

    addReviewComment: async (
      issueId: string,
      key: string,
      threadId: string,
      input: CreateDocumentReviewComment,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const thread = await getReviewThreadForIssue(issueId, key, threadId, tx);
      if (!thread) throw notFound("Review thread not found");
      const now = new Date();
      const linkedIssueComment = await assertLinkedIssueComment(issueId, input.issueCommentId, tx);
      const [comment] = await tx.insert(documentReviewComments).values({
        companyId: thread.companyId,
        threadId: thread.id,
        issueId: thread.issueId,
        documentId: thread.documentId,
        body: input.body,
        authorType: actor.actorType,
        authorAgentId: actor.agentId ?? null,
        authorUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
        issueCommentId: linkedIssueComment?.id ?? null,
        createdAt: now,
        updatedAt: now,
      }).returning(reviewCommentSelect);
      await tx.update(documentReviewThreads).set({ updatedAt: now }).where(eq(documentReviewThreads.id, thread.id));
      return comment;
    }),

    updateReviewThread: async (
      issueId: string,
      key: string,
      threadId: string,
      input: UpdateDocumentReviewThread,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const thread = await getReviewThreadForIssue(issueId, key, threadId, tx);
      if (!thread) throw notFound("Review thread not found");
      if (!input.status || input.status === thread.status) return thread;
      const now = new Date();
      const [updated] = await tx.update(documentReviewThreads)
        .set(input.status === "resolved"
          ? {
            status: "resolved",
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt: now,
            updatedAt: now,
          }
          : {
            status: "open",
            resolvedByAgentId: null,
            resolvedByUserId: null,
            resolvedAt: null,
            updatedAt: now,
          })
        .where(eq(documentReviewThreads.id, thread.id))
        .returning(reviewThreadSelect);
      return updated;
    }),

    createSuggestion: async (
      issueId: string,
      key: string,
      input: CreateDocumentSuggestion,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${documents.id}
        from ${issueDocuments}
        inner join ${documents} on ${issueDocuments.documentId} = ${documents.id}
        where ${and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key))}
        for update of ${documents}
      `);
      const doc = await getIssueDocument(issueId, key, tx);
      if (!doc) throw notFound("Document not found");
      if (input.baseRevisionId !== doc.latestRevisionId || input.baseRevisionNumber !== doc.latestRevisionNumber) {
        throw conflict("Suggestion anchor requires the current document revision", {
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
        });
      }
      const verification = verifyDocumentAnchorSelector({ markdown: doc.latestBody, selector: input.selector });
      if (!verification.ok || !verification.anchor) {
        throw unprocessable("Suggestion anchor does not match the current document revision", {
          reason: verification.reason,
        });
      }
      const now = new Date();
      const [suggestion] = await tx.insert(documentSuggestions).values({
        companyId: doc.companyId,
        issueId,
        documentId: doc.documentId,
        documentKey: doc.documentKey,
        kind: input.kind,
        status: "pending",
        anchorState: "active",
        anchorConfidence: "exact",
        originalRevisionId: doc.latestRevisionId,
        originalRevisionNumber: doc.latestRevisionNumber,
        currentRevisionId: doc.latestRevisionId,
        currentRevisionNumber: doc.latestRevisionNumber,
        selectedText: verification.anchor.selectedText,
        proposedText: input.kind === "deletion" ? null : input.proposedText ?? null,
        insertionPosition: input.kind === "insertion" ? input.insertionPosition ?? "after" : null,
        prefixText: verification.anchor.prefixText,
        suffixText: verification.anchor.suffixText,
        normalizedStart: verification.anchor.normalizedStart,
        normalizedEnd: verification.anchor.normalizedEnd,
        markdownStart: verification.anchor.markdownStart,
        markdownEnd: verification.anchor.markdownEnd,
        anchorSelector: input.selector,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdAt: now,
        updatedAt: now,
      }).returning(suggestionSelect);
      const comments = [];
      if (input.body) {
        const linkedIssueComment = await assertLinkedIssueComment(issueId, input.issueCommentId, tx);
        const [comment] = await tx.insert(documentSuggestionComments).values({
          companyId: doc.companyId,
          suggestionId: suggestion.id,
          issueId,
          documentId: doc.documentId,
          body: input.body,
          authorType: actor.actorType,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          issueCommentId: linkedIssueComment?.id ?? null,
          createdAt: now,
          updatedAt: now,
        }).returning(suggestionCommentSelect);
        comments.push(comment);
      }
      return { ...suggestion, comments };
    }),

    addSuggestionComment: async (
      issueId: string,
      key: string,
      suggestionId: string,
      input: CreateDocumentSuggestionComment,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const suggestion = await getSuggestionForIssue(issueId, key, suggestionId, tx);
      if (!suggestion) throw notFound("Suggestion not found");
      const now = new Date();
      const linkedIssueComment = await assertLinkedIssueComment(issueId, input.issueCommentId, tx);
      const [comment] = await tx.insert(documentSuggestionComments).values({
        companyId: suggestion.companyId,
        suggestionId: suggestion.id,
        issueId: suggestion.issueId,
        documentId: suggestion.documentId,
        body: input.body,
        authorType: actor.actorType,
        authorAgentId: actor.agentId ?? null,
        authorUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
        issueCommentId: linkedIssueComment?.id ?? null,
        createdAt: now,
        updatedAt: now,
      }).returning(suggestionCommentSelect);
      await tx.update(documentSuggestions).set({ updatedAt: now }).where(eq(documentSuggestions.id, suggestion.id));
      return comment;
    }),

    rejectSuggestion: async (
      issueId: string,
      key: string,
      suggestionId: string,
      _input: RejectDocumentSuggestion,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const suggestion = await getSuggestionForIssue(issueId, key, suggestionId, tx);
      if (!suggestion) throw notFound("Suggestion not found");
      if (suggestion.status !== "pending") {
        throw conflict("Only pending suggestions can be rejected", { status: suggestion.status });
      }
      const now = new Date();
      const [updated] = await tx.update(documentSuggestions).set({
        status: "rejected",
        rejectedByAgentId: actor.agentId ?? null,
        rejectedByUserId: actor.userId ?? null,
        rejectedAt: now,
        updatedAt: now,
      }).where(eq(documentSuggestions.id, suggestion.id)).returning(suggestionSelect);
      return updated;
    }),

    // "Resolve" = handled outside review / no longer applies. Distinct from
    // reject (disagreement) so the audit trail keeps the two apart. Like reject,
    // only a pending suggestion can be resolved.
    resolveSuggestion: async (
      issueId: string,
      key: string,
      suggestionId: string,
      _input: ResolveDocumentSuggestion,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const suggestion = await getSuggestionForIssue(issueId, key, suggestionId, tx);
      if (!suggestion) throw notFound("Suggestion not found");
      if (suggestion.status !== "pending") {
        throw conflict("Only pending suggestions can be resolved", { status: suggestion.status });
      }
      const now = new Date();
      const [updated] = await tx.update(documentSuggestions).set({
        status: "resolved",
        resolvedByAgentId: actor.agentId ?? null,
        resolvedByUserId: actor.userId ?? null,
        resolvedAt: now,
        updatedAt: now,
      }).where(eq(documentSuggestions.id, suggestion.id)).returning(suggestionSelect);
      return updated;
    }),

    acceptSuggestion: async (
      issueId: string,
      key: string,
      suggestionId: string,
      input: AcceptDocumentSuggestion,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${documents.id}
        from ${issueDocuments}
        inner join ${documents} on ${issueDocuments.documentId} = ${documents.id}
        where ${and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key))}
        for update of ${documents}
      `);
      const doc = await getIssueDocument(issueId, key, tx);
      if (!doc) throw notFound("Document not found");
      const suggestion = await getSuggestionForIssue(issueId, key, suggestionId, tx);
      if (!suggestion || suggestion.documentId !== doc.documentId) throw notFound("Suggestion not found");
      if (suggestion.status !== "pending") {
        throw conflict("Only pending suggestions can be accepted", { status: suggestion.status });
      }
      if (doc.latestRevisionId !== input.baseRevisionId) {
        throw conflict("Document was updated by someone else", { currentRevisionId: doc.latestRevisionId });
      }
      if (suggestion.currentRevisionId !== doc.latestRevisionId || suggestion.currentRevisionNumber !== doc.latestRevisionNumber) {
        throw conflict("Suggestion must be remapped to the current document revision before acceptance", {
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
          suggestionRevisionId: suggestion.currentRevisionId,
          suggestionRevisionNumber: suggestion.currentRevisionNumber,
        });
      }
      const verification = verifyDocumentAnchorSelector({ markdown: doc.latestBody, selector: suggestion.anchorSelector });
      if (!verification.ok) {
        throw conflict("Suggestion anchor no longer matches the current document revision", { reason: verification.reason });
      }

      const now = new Date();
      const nextBody = applySuggestionToBody(doc.latestBody, suggestion);
      const nextRevisionNumber = doc.latestRevisionNumber + 1;
      const [revision] = await tx.insert(documentRevisions).values({
        companyId: doc.companyId,
        documentId: doc.documentId,
        revisionNumber: nextRevisionNumber,
        title: doc.title,
        format: doc.format,
        body: nextBody,
        changeSummary: input.changeSummary ?? `Accepted ${suggestion.kind} suggestion ${suggestion.id.slice(0, 8)}`,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
        createdAt: now,
      }).returning();
      await tx.update(documents).set({
        latestBody: nextBody,
        latestRevisionId: revision.id,
        latestRevisionNumber: nextRevisionNumber,
        updatedByAgentId: actor.agentId ?? null,
        updatedByUserId: actor.userId ?? null,
        updatedAt: now,
      }).where(eq(documents.id, doc.documentId));
      await tx.update(issueDocuments).set({ updatedAt: now }).where(eq(issueDocuments.documentId, doc.documentId));
      const [updatedSuggestion] = await tx.update(documentSuggestions).set({
        status: "accepted",
        acceptedByAgentId: actor.agentId ?? null,
        acceptedByUserId: actor.userId ?? null,
        acceptedAt: now,
        acceptedRevisionId: revision.id,
        updatedAt: now,
      }).where(eq(documentSuggestions.id, suggestion.id)).returning(suggestionSelect);

      return {
        suggestion: updatedSuggestion,
        document: {
          id: doc.documentId,
          companyId: doc.companyId,
          issueId,
          key: doc.documentKey,
          title: doc.title,
          format: doc.format,
          body: nextBody,
          latestRevisionId: revision.id,
          latestRevisionNumber: nextRevisionNumber,
        },
        revision,
      };
    }),

    remapOpenSuggestionsForDocument: async (input: {
      issueId: string;
      key: string;
      documentId: string;
      nextRevisionId: string | null;
      nextRevisionNumber: number;
      nextBody: string;
    }) => db.transaction(async (tx) => {
      const suggestions: DocumentSuggestion[] = await tx.select(suggestionSelect).from(documentSuggestions)
        .where(and(
          eq(documentSuggestions.issueId, input.issueId),
          eq(documentSuggestions.documentId, input.documentId),
          eq(documentSuggestions.status, "pending"),
        ));
      const changed = [];
      const now = new Date();
      for (const suggestion of suggestions) {
        if (suggestion.currentRevisionId === input.nextRevisionId) continue;
        const previousAnchor = snapshotFromSuggestion(suggestion);
        const remap = remapDocumentAnchor({
          previousAnchor,
          nextMarkdown: input.nextBody,
        });
        const nextAnchor = remap.anchor;
        const nextSelector = nextAnchor ? anchorSnapshotToSelector(nextAnchor) : suggestion.anchorSelector;
        const [updated] = await tx.update(documentSuggestions).set({
          currentRevisionId: input.nextRevisionId,
          currentRevisionNumber: input.nextRevisionNumber,
          anchorState: remap.anchorState,
          anchorConfidence: remap.confidence,
          ...(nextAnchor
            ? {
              selectedText: nextAnchor.selectedText,
              prefixText: nextAnchor.prefixText,
              suffixText: nextAnchor.suffixText,
              normalizedStart: nextAnchor.normalizedStart,
              normalizedEnd: nextAnchor.normalizedEnd,
              markdownStart: nextAnchor.markdownStart,
              markdownEnd: nextAnchor.markdownEnd,
            }
            : {}),
          anchorSelector: nextSelector,
          updatedAt: now,
        }).where(eq(documentSuggestions.id, suggestion.id)).returning(suggestionSelect);
        const [snapshot] = await tx.insert(documentSuggestionAnchorSnapshots).values({
          companyId: suggestion.companyId,
          suggestionId: suggestion.id,
          documentId: suggestion.documentId,
          fromRevisionId: suggestion.currentRevisionId,
          fromRevisionNumber: suggestion.currentRevisionNumber,
          toRevisionId: input.nextRevisionId,
          toRevisionNumber: input.nextRevisionNumber,
          previousAnchor,
          nextAnchor,
          anchorState: remap.anchorState,
          anchorConfidence: remap.confidence,
          failureReason: remap.anchor ? null : remap.reason,
          createdAt: now,
        }).returning();
        changed.push({ suggestion: updated, snapshot });
      }
      return changed;
    }),

    selectorToAnchorSnapshot,
  };
}
