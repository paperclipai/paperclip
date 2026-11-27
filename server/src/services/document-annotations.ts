import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { assertAgentInteraction } from "./agent-interaction-policy.js";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  documentAnnotationAnchorSnapshots,
  documentAnnotationCommentReactions,
  documentAnnotationComments,
  documentAnnotationThreads,
  documents,
  caseDocuments,
  issueComments,
  issueDocuments,
  issues,
  routineDocuments,
} from "@paperclipai/db";
import { notifyDeferredExecutionWork } from "./deferred-execution-notifications.js";
import { deferredWorkIntentWait } from "./work-intent-outbox.js";
import {
  anchorSnapshotToSelector,
  remapDocumentAnchor,
  selectorToAnchorSnapshot,
  verifyDocumentAnchorSelector,
  type DocumentAnnotationAnchorSnapshot,
  DOCUMENT_ANNOTATION_COMMENT_REACTIONS,
  type DocumentAnnotationComment,
  type DocumentAnnotationCommentReactionName,
  type DocumentAnnotationCommentReactionSummary,
  type DocumentAnnotationThread,
  CreateDocumentAnnotationComment,
  CreateDocumentAnnotationThread,
  UpdateDocumentAnnotationThread,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

const ANNOTATION_QUESTION_WAKE_WINDOW_MS = 10 * 60 * 1000;
const ANNOTATION_QUESTION_WAKE_MAX_PER_WINDOW = 3;
const ANNOTATION_QUESTION_REACTION_KEY_PREFIX = "annotation-question-reaction:";

type ActorInput = {
  actorType: "agent" | "user";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type ReactionViewer = { actorType: "agent" | "user"; actorId: string } | null | undefined;

type ListThreadOptions = {
  status?: "open" | "resolved" | "all";
  includeComments?: boolean;
  viewer?: ReactionViewer;
};

export type DocumentAnnotationReactionTarget =
  | { kind: "issue"; issueId: string; key: string }
  | { kind: "routine"; routineId: string; key: string }
  | { kind: "case"; caseId: string; key: string };

type IssueDocumentRow = {
  issueId: string;
  companyId: string;
  documentId: string;
  documentKey: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
};

type RoutineDocumentRow = {
  routineId: string;
  companyId: string;
  documentId: string;
  documentKey: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
};

type CaseDocumentRow = {
  caseId: string;
  companyId: string;
  documentId: string;
  documentKey: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
};

const threadSelect = {
  id: documentAnnotationThreads.id,
  companyId: documentAnnotationThreads.companyId,
  issueId: documentAnnotationThreads.issueId,
  routineId: documentAnnotationThreads.routineId,
  caseId: documentAnnotationThreads.caseId,
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

const commentSelect = {
  id: documentAnnotationComments.id,
  companyId: documentAnnotationComments.companyId,
  threadId: documentAnnotationComments.threadId,
  issueId: documentAnnotationComments.issueId,
  routineId: documentAnnotationComments.routineId,
  caseId: documentAnnotationComments.caseId,
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

function snapshotFromThread(thread: Pick<DocumentAnnotationThread, "selectedText" | "prefixText" | "suffixText" | "normalizedStart" | "normalizedEnd" | "markdownStart" | "markdownEnd">): DocumentAnnotationAnchorSnapshot {
  return {
    selectedText: thread.selectedText,
    prefixText: thread.prefixText,
    suffixText: thread.suffixText,
    normalizedStart: thread.normalizedStart,
    normalizedEnd: thread.normalizedEnd,
    markdownStart: thread.markdownStart,
    markdownEnd: thread.markdownEnd,
  };
}

export function documentAnnotationService(db: Db) {
  async function getIssueDocument(issueId: string, key: string, dbOrTx: any = db): Promise<IssueDocumentRow | null> {
    return dbOrTx
      .select({
        issueId: issueDocuments.issueId,
        companyId: documents.companyId,
        documentId: documents.id,
        documentKey: issueDocuments.key,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
      .then((rows: IssueDocumentRow[]) => rows[0] ?? null);
  }

  async function getRoutineDocument(
    routineId: string,
    key: string,
    dbOrTx: any = db,
  ): Promise<RoutineDocumentRow | null> {
    return dbOrTx
      .select({
        routineId: routineDocuments.routineId,
        companyId: documents.companyId,
        documentId: documents.id,
        documentKey: routineDocuments.key,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
      })
      .from(routineDocuments)
      .innerJoin(documents, eq(routineDocuments.documentId, documents.id))
      .where(and(
        eq(routineDocuments.routineId, routineId),
        eq(routineDocuments.key, key),
        eq(routineDocuments.companyId, documents.companyId),
      ))
      .then((rows: RoutineDocumentRow[]) => rows[0] ?? null);
  }

  async function getCaseDocument(
    caseId: string,
    key: string,
    dbOrTx: any = db,
  ): Promise<CaseDocumentRow | null> {
    return dbOrTx
      .select({
        caseId: caseDocuments.caseId,
        companyId: documents.companyId,
        documentId: documents.id,
        documentKey: caseDocuments.key,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
      })
      .from(caseDocuments)
      .innerJoin(documents, eq(caseDocuments.documentId, documents.id))
      .where(and(
        eq(caseDocuments.caseId, caseId),
        eq(caseDocuments.key, key),
        eq(caseDocuments.companyId, documents.companyId),
      ))
      .then((rows: CaseDocumentRow[]) => rows[0] ?? null);
  }

  async function getThreadForIssue(
    issueId: string,
    documentKey: string,
    threadId: string,
    dbOrTx: any = db,
  ): Promise<DocumentAnnotationThread | null> {
    return dbOrTx
      .select(threadSelect)
      .from(documentAnnotationThreads)
      .where(and(
        eq(documentAnnotationThreads.id, threadId),
        eq(documentAnnotationThreads.issueId, issueId),
        eq(documentAnnotationThreads.documentKey, documentKey),
      ))
      .then((rows: DocumentAnnotationThread[]) => rows[0] ?? null);
  }

  async function getThreadForRoutine(
    routineId: string,
    documentKey: string,
    threadId: string,
    companyId: string,
    documentId: string,
    dbOrTx: any = db,
  ): Promise<DocumentAnnotationThread | null> {
    return dbOrTx
      .select(threadSelect)
      .from(documentAnnotationThreads)
      .where(and(
        eq(documentAnnotationThreads.id, threadId),
        eq(documentAnnotationThreads.companyId, companyId),
        eq(documentAnnotationThreads.routineId, routineId),
        eq(documentAnnotationThreads.documentId, documentId),
        eq(documentAnnotationThreads.documentKey, documentKey),
      ))
      .then((rows: DocumentAnnotationThread[]) => rows[0] ?? null);
  }

  async function getThreadForCase(
    caseId: string,
    documentKey: string,
    threadId: string,
    companyId: string,
    documentId: string,
    dbOrTx: any = db,
  ): Promise<DocumentAnnotationThread | null> {
    return dbOrTx
      .select(threadSelect)
      .from(documentAnnotationThreads)
      .where(and(
        eq(documentAnnotationThreads.id, threadId),
        eq(documentAnnotationThreads.companyId, companyId),
        eq(documentAnnotationThreads.caseId, caseId),
        eq(documentAnnotationThreads.documentId, documentId),
        eq(documentAnnotationThreads.documentKey, documentKey),
      ))
      .then((rows: DocumentAnnotationThread[]) => rows[0] ?? null);
  }

  async function reactionsForComments(
    commentIds: string[],
    viewer: ReactionViewer,
    dbOrTx: any = db,
  ): Promise<Map<string, DocumentAnnotationCommentReactionSummary[]>> {
    const byComment = new Map<string, DocumentAnnotationCommentReactionSummary[]>();
    if (commentIds.length === 0) return byComment;
    const rows: Array<{
      commentId: string;
      reaction: DocumentAnnotationCommentReactionName;
      actorType: "agent" | "user";
      actorId: string;
    }> = await dbOrTx
      .select({
        commentId: documentAnnotationCommentReactions.commentId,
        reaction: documentAnnotationCommentReactions.reaction,
        actorType: documentAnnotationCommentReactions.actorType,
        actorId: documentAnnotationCommentReactions.actorId,
      })
      .from(documentAnnotationCommentReactions)
      .where(and(
        inArray(documentAnnotationCommentReactions.commentId, commentIds),
        isNull(documentAnnotationCommentReactions.removedAt),
      ))
      .orderBy(asc(documentAnnotationCommentReactions.createdAt), asc(documentAnnotationCommentReactions.id));
    const grouped = new Map<string, Map<DocumentAnnotationCommentReactionName, DocumentAnnotationCommentReactionSummary>>();
    for (const row of rows) {
      const perComment = grouped.get(row.commentId) ?? new Map();
      grouped.set(row.commentId, perComment);
      const summary = perComment.get(row.reaction) ?? { reaction: row.reaction, count: 0, reactedByMe: false, actors: [] };
      perComment.set(row.reaction, summary);
      summary.count += 1;
      summary.actors.push({
        actorType: row.actorType,
        agentId: row.actorType === "agent" ? row.actorId : null,
        userId: row.actorType === "user" ? row.actorId : null,
      });
      if (viewer && viewer.actorType === row.actorType && viewer.actorId === row.actorId) summary.reactedByMe = true;
    }
    for (const [commentId, perComment] of grouped) {
      byComment.set(
        commentId,
        DOCUMENT_ANNOTATION_COMMENT_REACTIONS.flatMap((reaction) => perComment.get(reaction) ?? []),
      );
    }
    return byComment;
  }

  async function withReactions(
    comments: DocumentAnnotationComment[],
    viewer: ReactionViewer,
    dbOrTx: any = db,
  ): Promise<DocumentAnnotationComment[]> {
    const reactions = await reactionsForComments(comments.map((comment) => comment.id), viewer, dbOrTx);
    return comments.map((comment) => ({ ...comment, reactions: reactions.get(comment.id) ?? [] }));
  }

  async function commentsForThreads(
    threadIds: string[],
    dbOrTx: any = db,
    viewer?: ReactionViewer,
  ): Promise<DocumentAnnotationComment[]> {
    if (threadIds.length === 0) return [];
    const comments: DocumentAnnotationComment[] = await dbOrTx
      .select(commentSelect)
      .from(documentAnnotationComments)
      .where(inArray(documentAnnotationComments.threadId, threadIds))
      .orderBy(asc(documentAnnotationComments.createdAt), asc(documentAnnotationComments.id));
    return withReactions(comments, viewer, dbOrTx);
  }

  async function getThreadForReactionTarget(
    target: DocumentAnnotationReactionTarget,
    threadId: string,
    dbOrTx: any,
  ): Promise<DocumentAnnotationThread | null> {
    if (target.kind === "issue") return getThreadForIssue(target.issueId, target.key, threadId, dbOrTx);
    if (target.kind === "routine") {
      const doc = await getRoutineDocument(target.routineId, target.key, dbOrTx);
      if (!doc) throw notFound("Document not found");
      return getThreadForRoutine(target.routineId, target.key, threadId, doc.companyId, doc.documentId, dbOrTx);
    }
    const doc = await getCaseDocument(target.caseId, target.key, dbOrTx);
    if (!doc) throw notFound("Document not found");
    return getThreadForCase(target.caseId, target.key, threadId, doc.companyId, doc.documentId, dbOrTx);
  }

  async function assertLinkedIssueComment(
    issueId: string,
    commentId: string | null | undefined,
    dbOrTx: any = db,
  ) {
    if (!commentId) return null;
    const comment = await dbOrTx
      .select({
        id: issueComments.id,
        companyId: issueComments.companyId,
        issueId: issueComments.issueId,
      })
      .from(issueComments)
      .where(and(eq(issueComments.id, commentId), isNull(issueComments.deletedAt)))
      .then((rows: Array<{ id: string; companyId: string; issueId: string }>) => rows[0] ?? null);
    if (!comment || comment.issueId !== issueId) {
      throw unprocessable("Linked issue comment must belong to this issue");
    }
    return comment;
  }

  return {
    listThreadsForIssueDocument: async (
      issueId: string,
      key: string,
      options: ListThreadOptions = {},
    ) => {
      const doc = await getIssueDocument(issueId, key);
      if (!doc) throw notFound("Document not found");
      const conditions = [
        eq(documentAnnotationThreads.issueId, issueId),
        eq(documentAnnotationThreads.documentId, doc.documentId),
      ];
      if (options.status && options.status !== "all") {
        conditions.push(eq(documentAnnotationThreads.status, options.status));
      }
      const threads: DocumentAnnotationThread[] = await db
        .select(threadSelect)
        .from(documentAnnotationThreads)
        .where(and(...conditions))
        .orderBy(desc(documentAnnotationThreads.updatedAt), desc(documentAnnotationThreads.id));
      if (!options.includeComments) return threads;
      const comments = await commentsForThreads(threads.map((thread) => thread.id), db, options.viewer);
      const commentsByThread = new Map<string, DocumentAnnotationComment[]>();
      for (const comment of comments) {
        const existing = commentsByThread.get(comment.threadId) ?? [];
        existing.push(comment);
        commentsByThread.set(comment.threadId, existing);
      }
      return threads.map((thread) => ({
        ...thread,
        comments: commentsByThread.get(thread.id) ?? [],
      }));
    },

    listThreadsForRoutineDocument: async (
      routineId: string,
      key: string,
      options: ListThreadOptions = {},
    ) => {
      const doc = await getRoutineDocument(routineId, key);
      if (!doc) throw notFound("Document not found");
      const conditions = [
        eq(documentAnnotationThreads.companyId, doc.companyId),
        eq(documentAnnotationThreads.routineId, routineId),
        eq(documentAnnotationThreads.documentId, doc.documentId),
      ];
      if (options.status && options.status !== "all") {
        conditions.push(eq(documentAnnotationThreads.status, options.status));
      }
      const threads: DocumentAnnotationThread[] = await db
        .select(threadSelect)
        .from(documentAnnotationThreads)
        .where(and(...conditions))
        .orderBy(desc(documentAnnotationThreads.updatedAt), desc(documentAnnotationThreads.id));
      if (!options.includeComments) return threads;
      const comments = await commentsForThreads(threads.map((thread) => thread.id), db, options.viewer);
      const commentsByThread = new Map<string, DocumentAnnotationComment[]>();
      for (const comment of comments) {
        const existing = commentsByThread.get(comment.threadId) ?? [];
        existing.push(comment);
        commentsByThread.set(comment.threadId, existing);
      }
      return threads.map((thread) => ({
        ...thread,
        comments: commentsByThread.get(thread.id) ?? [],
      }));
    },

    listThreadsForCaseDocument: async (
      caseId: string,
      key: string,
      options: ListThreadOptions = {},
    ) => {
      const doc = await getCaseDocument(caseId, key);
      if (!doc) throw notFound("Document not found");
      const conditions = [
        eq(documentAnnotationThreads.companyId, doc.companyId),
        eq(documentAnnotationThreads.caseId, caseId),
        eq(documentAnnotationThreads.documentId, doc.documentId),
      ];
      if (options.status && options.status !== "all") {
        conditions.push(eq(documentAnnotationThreads.status, options.status));
      }
      const threads: DocumentAnnotationThread[] = await db
        .select(threadSelect)
        .from(documentAnnotationThreads)
        .where(and(...conditions))
        .orderBy(desc(documentAnnotationThreads.updatedAt), desc(documentAnnotationThreads.id));
      if (!options.includeComments) return threads;
      const comments = await commentsForThreads(threads.map((thread) => thread.id), db, options.viewer);
      const commentsByThread = new Map<string, DocumentAnnotationComment[]>();
      for (const comment of comments) {
        const existing = commentsByThread.get(comment.threadId) ?? [];
        existing.push(comment);
        commentsByThread.set(comment.threadId, existing);
      }
      return threads.map((thread) => ({
        ...thread,
        comments: commentsByThread.get(thread.id) ?? [],
      }));
    },

    getThreadForIssueDocument: async (issueId: string, key: string, threadId: string, viewer?: ReactionViewer) => {
      const thread = await getThreadForIssue(issueId, key, threadId);
      if (!thread) return null;
      const comments = await commentsForThreads([thread.id], db, viewer);
      return { ...thread, comments };
    },

    getThreadForRoutineDocument: async (routineId: string, key: string, threadId: string, viewer?: ReactionViewer) => {
      const doc = await getRoutineDocument(routineId, key);
      if (!doc) return null;
      const thread = await getThreadForRoutine(routineId, key, threadId, doc.companyId, doc.documentId);
      if (!thread) return null;
      const comments = await commentsForThreads([thread.id], db, viewer);
      return { ...thread, comments };
    },

    getThreadForCaseDocument: async (caseId: string, key: string, threadId: string, viewer?: ReactionViewer) => {
      const doc = await getCaseDocument(caseId, key);
      if (!doc) return null;
      const thread = await getThreadForCase(caseId, key, threadId, doc.companyId, doc.documentId);
      if (!thread) return null;
      const comments = await commentsForThreads([thread.id], db, viewer);
      return { ...thread, comments };
    },

    createThread: async (
      issueId: string,
      key: string,
      input: CreateDocumentAnnotationThread,
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
      await assertAgentInteraction(tx, { companyId: doc.companyId, actorAgentId: actor.agentId,
        operation: "comment", issueId, texts: [input.body], lock: true });
      if (
        input.baseRevisionId !== doc.latestRevisionId
        || input.baseRevisionNumber !== doc.latestRevisionNumber
      ) {
        throw conflict("Annotation anchor requires the current document revision", {
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
        });
      }

      const verification = verifyDocumentAnchorSelector({
        markdown: doc.latestBody,
        selector: input.selector,
      });
      if (!verification.ok || !verification.anchor) {
        throw unprocessable("Annotation anchor does not match the current document revision", {
          reason: verification.reason,
        });
      }

      const now = new Date();
      const linkedIssueComment = await assertLinkedIssueComment(issueId, input.issueCommentId, tx);
      const [thread] = await tx
        .insert(documentAnnotationThreads)
        .values({
          companyId: doc.companyId,
          issueId,
          documentId: doc.documentId,
          documentKey: doc.documentKey,
          status: "open",
          anchorState: "active",
          anchorConfidence: "exact",
          originalRevisionId: doc.latestRevisionId,
          originalRevisionNumber: doc.latestRevisionNumber,
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
          selectedText: verification.anchor.selectedText,
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
        })
        .returning(threadSelect);

      const [comment] = await tx
        .insert(documentAnnotationComments)
        .values({
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
        })
        .returning(commentSelect);

      return { ...thread, comments: [comment] };
    }),

    createRoutineThread: async (
      routineId: string,
      key: string,
      input: CreateDocumentAnnotationThread,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${documents.id}
        from ${routineDocuments}
        inner join ${documents} on ${routineDocuments.documentId} = ${documents.id}
        where ${and(eq(routineDocuments.routineId, routineId), eq(routineDocuments.key, key))}
        for update of ${documents}
      `);
      const doc = await getRoutineDocument(routineId, key, tx);
      if (!doc) throw notFound("Document not found");
      if (
        input.baseRevisionId !== doc.latestRevisionId
        || input.baseRevisionNumber !== doc.latestRevisionNumber
      ) {
        throw conflict("Annotation anchor requires the current document revision", {
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
        });
      }

      const verification = verifyDocumentAnchorSelector({
        markdown: doc.latestBody,
        selector: input.selector,
      });
      if (!verification.ok || !verification.anchor) {
        throw unprocessable("Annotation anchor does not match the current document revision", {
          reason: verification.reason,
        });
      }

      const now = new Date();
      const [thread] = await tx
        .insert(documentAnnotationThreads)
        .values({
          companyId: doc.companyId,
          issueId: null,
          routineId,
          documentId: doc.documentId,
          documentKey: doc.documentKey,
          status: "open",
          anchorState: "active",
          anchorConfidence: "exact",
          originalRevisionId: doc.latestRevisionId,
          originalRevisionNumber: doc.latestRevisionNumber,
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
          selectedText: verification.anchor.selectedText,
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
        })
        .returning(threadSelect);

      const [comment] = await tx
        .insert(documentAnnotationComments)
        .values({
          companyId: doc.companyId,
          threadId: thread.id,
          issueId: null,
          routineId,
          documentId: doc.documentId,
          body: input.body,
          authorType: actor.actorType,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          issueCommentId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(commentSelect);

      return { ...thread, comments: [comment] };
    }),

    createCaseThread: async (
      caseId: string,
      key: string,
      input: CreateDocumentAnnotationThread,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${documents.id}
        from ${caseDocuments}
        inner join ${documents} on ${caseDocuments.documentId} = ${documents.id}
        where ${and(eq(caseDocuments.caseId, caseId), eq(caseDocuments.key, key))}
        for update of ${documents}
      `);
      const doc = await getCaseDocument(caseId, key, tx);
      if (!doc) throw notFound("Document not found");
      if (
        input.baseRevisionId !== doc.latestRevisionId
        || input.baseRevisionNumber !== doc.latestRevisionNumber
      ) {
        throw conflict("Annotation anchor requires the current document revision", {
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
        });
      }

      const verification = verifyDocumentAnchorSelector({
        markdown: doc.latestBody,
        selector: input.selector,
      });
      if (!verification.ok || !verification.anchor) {
        throw unprocessable("Annotation anchor does not match the current document revision", {
          reason: verification.reason,
        });
      }

      const now = new Date();
      const [thread] = await tx
        .insert(documentAnnotationThreads)
        .values({
          companyId: doc.companyId,
          issueId: null,
          routineId: null,
          caseId,
          documentId: doc.documentId,
          documentKey: doc.documentKey,
          status: "open",
          anchorState: "active",
          anchorConfidence: "exact",
          originalRevisionId: doc.latestRevisionId,
          originalRevisionNumber: doc.latestRevisionNumber,
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
          selectedText: verification.anchor.selectedText,
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
        })
        .returning(threadSelect);

      const [comment] = await tx
        .insert(documentAnnotationComments)
        .values({
          companyId: doc.companyId,
          threadId: thread.id,
          issueId: null,
          routineId: null,
          caseId,
          documentId: doc.documentId,
          body: input.body,
          authorType: actor.actorType,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          issueCommentId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(commentSelect);

      return { ...thread, comments: [comment] };
    }),

    addComment: async (
      issueId: string,
      key: string,
      threadId: string,
      input: CreateDocumentAnnotationComment,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const thread = await getThreadForIssue(issueId, key, threadId, tx);
      if (!thread) throw notFound("Annotation thread not found");
      await assertAgentInteraction(tx, { companyId: thread.companyId, actorAgentId: actor.agentId,
        operation: "comment", issueId, texts: [input.body], lock: true });
      const now = new Date();
      const linkedIssueComment = await assertLinkedIssueComment(issueId, input.issueCommentId, tx);
      const [comment] = await tx
        .insert(documentAnnotationComments)
        .values({
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
        })
        .returning(commentSelect);
      await tx
        .update(documentAnnotationThreads)
        .set({ updatedAt: now })
        .where(eq(documentAnnotationThreads.id, thread.id));
      return comment;
    }),

    addRoutineComment: async (
      routineId: string,
      key: string,
      threadId: string,
      input: CreateDocumentAnnotationComment,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const doc = await getRoutineDocument(routineId, key, tx);
      if (!doc) throw notFound("Document not found");
      const thread = await getThreadForRoutine(routineId, key, threadId, doc.companyId, doc.documentId, tx);
      if (!thread) throw notFound("Annotation thread not found");
      const now = new Date();
      const [comment] = await tx
        .insert(documentAnnotationComments)
        .values({
          companyId: thread.companyId,
          threadId: thread.id,
          issueId: null,
          routineId: thread.routineId,
          documentId: thread.documentId,
          body: input.body,
          authorType: actor.actorType,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          issueCommentId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(commentSelect);
      await tx
        .update(documentAnnotationThreads)
        .set({ updatedAt: now })
        .where(eq(documentAnnotationThreads.id, thread.id));
      return comment;
    }),

    addCaseComment: async (
      caseId: string,
      key: string,
      threadId: string,
      input: CreateDocumentAnnotationComment,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const doc = await getCaseDocument(caseId, key, tx);
      if (!doc) throw notFound("Document not found");
      const thread = await getThreadForCase(caseId, key, threadId, doc.companyId, doc.documentId, tx);
      if (!thread) throw notFound("Annotation thread not found");
      const now = new Date();
      const [comment] = await tx
        .insert(documentAnnotationComments)
        .values({
          companyId: thread.companyId,
          threadId: thread.id,
          issueId: null,
          routineId: null,
          caseId: thread.caseId,
          documentId: thread.documentId,
          body: input.body,
          authorType: actor.actorType,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          issueCommentId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(commentSelect);
      await tx
        .update(documentAnnotationThreads)
        .set({ updatedAt: now })
        .where(eq(documentAnnotationThreads.id, thread.id));
      return comment;
    }),

    setCommentReaction: async (input: {
      target: DocumentAnnotationReactionTarget;
      threadId: string;
      commentId: string;
      reaction: DocumentAnnotationCommentReactionName;
      present: boolean;
      actor: ActorInput;
    }) => db.transaction(async (tx) => {
      const thread = await getThreadForReactionTarget(input.target, input.threadId, tx);
      if (!thread) throw notFound("Annotation thread not found");
      if (input.target.kind === "issue") {
        await assertAgentInteraction(tx, { companyId: thread.companyId, actorAgentId: input.actor.agentId,
          operation: "comment", issueId: input.target.issueId, texts: [], lock: true });
      }
      const [comment]: DocumentAnnotationComment[] = await tx
        .select(commentSelect)
        .from(documentAnnotationComments)
        .where(and(
          eq(documentAnnotationComments.id, input.commentId),
          eq(documentAnnotationComments.threadId, thread.id),
          eq(documentAnnotationComments.companyId, thread.companyId),
        ));
      if (!comment) throw notFound("Annotation comment not found");

      const changedRows: Array<{ id: string; firstAdd: boolean }> = input.present
        ? await tx
          .insert(documentAnnotationCommentReactions)
          .values({
            companyId: thread.companyId,
            commentId: comment.id,
            reaction: input.reaction,
            actorType: input.actor.actorType,
            actorId: input.actor.actorId,
          })
          .onConflictDoUpdate({
            target: [
              documentAnnotationCommentReactions.commentId,
              documentAnnotationCommentReactions.reaction,
              documentAnnotationCommentReactions.actorType,
              documentAnnotationCommentReactions.actorId,
            ],
            set: { removedAt: null },
            setWhere: sql`${documentAnnotationCommentReactions.removedAt} is not null`,
          })
          .returning({ id: documentAnnotationCommentReactions.id, firstAdd: sql<boolean>`(xmax = 0)` })
        : await tx
          .update(documentAnnotationCommentReactions)
          .set({ removedAt: new Date() })
          .where(and(
            eq(documentAnnotationCommentReactions.commentId, comment.id),
            eq(documentAnnotationCommentReactions.reaction, input.reaction),
            eq(documentAnnotationCommentReactions.actorType, input.actor.actorType),
            eq(documentAnnotationCommentReactions.actorId, input.actor.actorId),
            isNull(documentAnnotationCommentReactions.removedAt),
          ))
          .returning({ id: documentAnnotationCommentReactions.id, firstAdd: sql<boolean>`false` });
      const changed = changedRows.length > 0;
      const firstAdd = changedRows[0]?.firstAdd === true;
      let questionWakeRequestId: string | null = null;
      let questionWakeAgentId: string | null = null;
      let questionWakeSuppressed = false;
      if (
        input.present &&
        firstAdd &&
        input.reaction === "question" &&
        input.actor.actorType === "user" &&
        input.target.kind === "issue"
      ) {
        const [issue] = await tx
          .select({
            id: issues.id,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            conversationAgentId: issues.conversationAgentId,
            conversationUserId: issues.conversationUserId,
          })
          .from(issues)
          .where(and(eq(issues.companyId, thread.companyId), eq(issues.id, input.target.issueId)))
          .for("update");
        const chatOwnerAllowed =
          !issue?.conversationAgentId ||
          (issue.assigneeAgentId === issue.conversationAgentId &&
            issue.conversationUserId === input.actor.actorId);
        if (
          issue &&
          issue.assigneeAgentId &&
          issue.status !== "done" &&
          issue.status !== "cancelled" &&
          chatOwnerAllowed
        ) {
          const [existingPending] = await tx
            .select({ id: agentWakeupRequests.id })
            .from(agentWakeupRequests)
            .where(and(
              eq(agentWakeupRequests.companyId, thread.companyId),
              eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
              inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued", "claimed"]),
              sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
              sql`${agentWakeupRequests.payload}->>'mutation' = 'annotation_reaction'`,
            ))
            .limit(1);
          const windowStart = new Date(Date.now() - ANNOTATION_QUESTION_WAKE_WINDOW_MS);
          const recentActorWakes = existingPending
            ? []
            : await tx
              .select({ id: agentWakeupRequests.id })
              .from(agentWakeupRequests)
              .where(and(
                eq(agentWakeupRequests.companyId, thread.companyId),
                eq(agentWakeupRequests.requestedByActorType, "user"),
                eq(agentWakeupRequests.requestedByActorId, input.actor.actorId),
                gte(agentWakeupRequests.requestedAt, windowStart),
                sql`${agentWakeupRequests.idempotencyKey} like ${ANNOTATION_QUESTION_REACTION_KEY_PREFIX + "%"}`,
                sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
                sql`${agentWakeupRequests.payload}->>'mutation' = 'annotation_reaction'`,
              ))
              .limit(ANNOTATION_QUESTION_WAKE_MAX_PER_WINDOW);
          if (existingPending || recentActorWakes.length >= ANNOTATION_QUESTION_WAKE_MAX_PER_WINDOW) {
            questionWakeSuppressed = true;
          } else {
            const wakeRequestId = randomUUID();
            await notifyDeferredExecutionWork(tx, {
              companyId: thread.companyId,
              requestId: wakeRequestId,
            });
            await tx.insert(agentWakeupRequests).values({
              id: wakeRequestId,
              companyId: thread.companyId,
              agentId: issue.assigneeAgentId,
              source: "automation",
              triggerDetail: "system",
              reason: "issue_commented",
              status: "deferred_issue_execution",
              requestedByActorType: "user",
              requestedByActorId: input.actor.actorId,
              idempotencyKey: `${ANNOTATION_QUESTION_REACTION_KEY_PREFIX}${changedRows[0]!.id}`,
              payload: {
                issueId: issue.id,
                annotationCommentId: comment.id,
                annotationThreadId: thread.id,
                annotationReaction: "question",
                mutation: "annotation_reaction",
                executionWait: deferredWorkIntentWait(
                  "wake_lost",
                  "Waiting to deliver annotation question reaction.",
                ),
                _paperclipWakeContext: {
                  issueId: issue.id,
                  taskId: issue.id,
                  annotationCommentId: comment.id,
                  annotationThreadId: thread.id,
                  annotationReaction: "question",
                  annotationReactionUserId: input.actor.actorId,
                  source: "issue.document_annotation_reaction",
                  wakeReason: "issue_commented",
                },
              },
            });
            questionWakeRequestId = wakeRequestId;
            questionWakeAgentId = issue.assigneeAgentId;
          }
        } else {
          questionWakeSuppressed = true;
        }
      }
      const [withSummary] = await withReactions([comment], input.actor, tx);
      return {
        thread,
        comment: withSummary!,
        changed,
        firstAdd,
        questionWakeRequestId,
        questionWakeAgentId,
        questionWakeSuppressed,
      };
    }),

    cleanupForIssueCommentDeletion: async (
      issueId: string,
      issueCommentId: string,
      actor: ActorInput,
      dbOrTx: any = db,
    ) => {
      const runCleanup = async (tx: any) => {
        const linkedComments: Array<Pick<DocumentAnnotationComment, "id" | "threadId">> = await tx
          .select({
            id: documentAnnotationComments.id,
            threadId: documentAnnotationComments.threadId,
          })
          .from(documentAnnotationComments)
          .where(and(
            eq(documentAnnotationComments.issueId, issueId),
            eq(documentAnnotationComments.issueCommentId, issueCommentId),
          ));
        if (linkedComments.length === 0) {
          return { deletedCommentIds: [], resolvedThreadIds: [] };
        }

        const deletedCommentIds = linkedComments.map((comment) => comment.id);
        const threadIds = [...new Set(linkedComments.map((comment) => comment.threadId))];
        const now = new Date();

        await tx
          .delete(documentAnnotationComments)
          .where(inArray(documentAnnotationComments.id, deletedCommentIds));

        const remainingRows: Array<{ threadId: string; count: number }> = await tx
          .select({
            threadId: documentAnnotationComments.threadId,
            count: sql<number>`count(*)::int`,
          })
          .from(documentAnnotationComments)
          .where(inArray(documentAnnotationComments.threadId, threadIds))
          .groupBy(documentAnnotationComments.threadId);
        const remainingByThreadId = new Map(remainingRows.map((row) => [row.threadId, Number(row.count)]));
        const emptyThreadIds = threadIds.filter((threadId) => (remainingByThreadId.get(threadId) ?? 0) === 0);

        if (emptyThreadIds.length > 0) {
          const resolvedRows: Array<{ id: string }> = await tx
            .update(documentAnnotationThreads)
            .set({
              status: "resolved",
              resolvedByAgentId: actor.actorType === "agent" ? actor.agentId ?? null : null,
              resolvedByUserId: actor.actorType === "user" ? actor.userId ?? null : null,
              resolvedAt: now,
              updatedAt: now,
            })
            .where(and(
              inArray(documentAnnotationThreads.id, emptyThreadIds),
              eq(documentAnnotationThreads.status, "open"),
            ))
            .returning({ id: documentAnnotationThreads.id });

          return { deletedCommentIds, resolvedThreadIds: resolvedRows.map((row) => row.id) };
        }

        return { deletedCommentIds, resolvedThreadIds: [] };
      };

      return dbOrTx === db ? db.transaction(runCleanup) : runCleanup(dbOrTx);
    },

    updateThread: async (
      issueId: string,
      key: string,
      threadId: string,
      input: UpdateDocumentAnnotationThread,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const thread = await getThreadForIssue(issueId, key, threadId, tx);
      if (!thread) throw notFound("Annotation thread not found");
      await assertAgentInteraction(tx, { companyId: thread.companyId, actorAgentId: actor.agentId,
        operation: "edit", issueId, lock: true });
      if (!input.status || input.status === thread.status) return thread;

      const now = new Date();
      const [updated] = await tx
        .update(documentAnnotationThreads)
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
        .where(eq(documentAnnotationThreads.id, thread.id))
        .returning(threadSelect);
      return updated;
    }),

    updateRoutineThread: async (
      routineId: string,
      key: string,
      threadId: string,
      input: UpdateDocumentAnnotationThread,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const doc = await getRoutineDocument(routineId, key, tx);
      if (!doc) throw notFound("Document not found");
      const thread = await getThreadForRoutine(routineId, key, threadId, doc.companyId, doc.documentId, tx);
      if (!thread) throw notFound("Annotation thread not found");
      if (!input.status || input.status === thread.status) return thread;

      const now = new Date();
      const [updated] = await tx
        .update(documentAnnotationThreads)
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
        .where(eq(documentAnnotationThreads.id, thread.id))
        .returning(threadSelect);
      return updated;
    }),

    updateCaseThread: async (
      caseId: string,
      key: string,
      threadId: string,
      input: UpdateDocumentAnnotationThread,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const doc = await getCaseDocument(caseId, key, tx);
      if (!doc) throw notFound("Document not found");
      const thread = await getThreadForCase(caseId, key, threadId, doc.companyId, doc.documentId, tx);
      if (!thread) throw notFound("Annotation thread not found");
      if (!input.status || input.status === thread.status) return thread;

      const now = new Date();
      const [updated] = await tx
        .update(documentAnnotationThreads)
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
        .where(eq(documentAnnotationThreads.id, thread.id))
        .returning(threadSelect);
      return updated;
    }),

    remapOpenThreadsForDocument: async (input: {
      issueId: string;
      key: string;
      documentId: string;
      nextRevisionId: string | null;
      nextRevisionNumber: number;
      nextBody: string;
    }) => db.transaction(async (tx) => {
      const threads: DocumentAnnotationThread[] = await tx
        .select(threadSelect)
        .from(documentAnnotationThreads)
        .where(and(
          eq(documentAnnotationThreads.issueId, input.issueId),
          eq(documentAnnotationThreads.documentId, input.documentId),
          eq(documentAnnotationThreads.status, "open"),
        ));
      const changed = [];
      const now = new Date();

      for (const thread of threads) {
        if (thread.currentRevisionId === input.nextRevisionId) continue;
        const previousAnchor = snapshotFromThread(thread);
        const remap = remapDocumentAnchor({
          previousAnchor,
          nextMarkdown: input.nextBody,
        });
        const nextAnchor = remap.anchor;
        const nextSelector = nextAnchor ? anchorSnapshotToSelector(nextAnchor) : thread.anchorSelector;
        const [updated] = await tx
          .update(documentAnnotationThreads)
          .set({
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
          })
          .where(eq(documentAnnotationThreads.id, thread.id))
          .returning(threadSelect);
        const [snapshot] = await tx
          .insert(documentAnnotationAnchorSnapshots)
          .values({
            companyId: thread.companyId,
            threadId: thread.id,
            documentId: thread.documentId,
            fromRevisionId: thread.currentRevisionId,
            fromRevisionNumber: thread.currentRevisionNumber,
            toRevisionId: input.nextRevisionId,
            toRevisionNumber: input.nextRevisionNumber,
            previousAnchor,
            nextAnchor,
            anchorState: remap.anchorState,
            anchorConfidence: remap.confidence,
            failureReason: remap.anchor ? null : remap.reason,
            createdAt: now,
          })
          .returning();
        changed.push({ thread: updated, snapshot });
      }

      return changed;
    }),

    remapOpenThreadsForRoutineDocument: async (input: {
      routineId: string;
      key: string;
      documentId: string;
      nextRevisionId: string | null;
      nextRevisionNumber: number;
      nextBody: string;
    }) => db.transaction(async (tx) => {
      const threads: DocumentAnnotationThread[] = await tx
        .select(threadSelect)
        .from(documentAnnotationThreads)
        .where(and(
          eq(documentAnnotationThreads.routineId, input.routineId),
          eq(documentAnnotationThreads.documentId, input.documentId),
          eq(documentAnnotationThreads.status, "open"),
        ));
      const changed = [];
      const now = new Date();

      for (const thread of threads) {
        if (thread.currentRevisionId === input.nextRevisionId) continue;
        const previousAnchor = snapshotFromThread(thread);
        const remap = remapDocumentAnchor({
          previousAnchor,
          nextMarkdown: input.nextBody,
        });
        const nextAnchor = remap.anchor;
        const nextSelector = nextAnchor ? anchorSnapshotToSelector(nextAnchor) : thread.anchorSelector;
        const [updated] = await tx
          .update(documentAnnotationThreads)
          .set({
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
          })
          .where(eq(documentAnnotationThreads.id, thread.id))
          .returning(threadSelect);
        const [snapshot] = await tx
          .insert(documentAnnotationAnchorSnapshots)
          .values({
            companyId: thread.companyId,
            threadId: thread.id,
            documentId: thread.documentId,
            fromRevisionId: thread.currentRevisionId,
            fromRevisionNumber: thread.currentRevisionNumber,
            toRevisionId: input.nextRevisionId,
            toRevisionNumber: input.nextRevisionNumber,
            previousAnchor,
            nextAnchor,
            anchorState: remap.anchorState,
            anchorConfidence: remap.confidence,
            failureReason: remap.anchor ? null : remap.reason,
            createdAt: now,
          })
          .returning();
        changed.push({ thread: updated, snapshot });
      }

      return changed;
    }),

    remapOpenThreadsForCaseDocument: async (input: {
      caseId: string;
      key: string;
      documentId: string;
      nextRevisionId: string | null;
      nextRevisionNumber: number;
      nextBody: string;
    }) => db.transaction(async (tx) => {
      const threads: DocumentAnnotationThread[] = await tx
        .select(threadSelect)
        .from(documentAnnotationThreads)
        .where(and(
          eq(documentAnnotationThreads.caseId, input.caseId),
          eq(documentAnnotationThreads.documentId, input.documentId),
          eq(documentAnnotationThreads.status, "open"),
        ));
      const changed = [];
      const now = new Date();

      for (const thread of threads) {
        if (thread.currentRevisionId === input.nextRevisionId) continue;
        const previousAnchor = snapshotFromThread(thread);
        const remap = remapDocumentAnchor({
          previousAnchor,
          nextMarkdown: input.nextBody,
        });
        const nextAnchor = remap.anchor;
        const nextSelector = nextAnchor ? anchorSnapshotToSelector(nextAnchor) : thread.anchorSelector;
        const [updated] = await tx
          .update(documentAnnotationThreads)
          .set({
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
          })
          .where(eq(documentAnnotationThreads.id, thread.id))
          .returning(threadSelect);
        const [snapshot] = await tx
          .insert(documentAnnotationAnchorSnapshots)
          .values({
            companyId: thread.companyId,
            threadId: thread.id,
            documentId: thread.documentId,
            fromRevisionId: thread.currentRevisionId,
            fromRevisionNumber: thread.currentRevisionNumber,
            toRevisionId: input.nextRevisionId,
            toRevisionNumber: input.nextRevisionNumber,
            previousAnchor,
            nextAnchor,
            anchorState: remap.anchorState,
            anchorConfidence: remap.confidence,
            failureReason: remap.anchor ? null : remap.reason,
            createdAt: now,
          })
          .returning();
        changed.push({ thread: updated, snapshot });
      }

      return changed;
    }),

    selectorToAnchorSnapshot,
  };
}
