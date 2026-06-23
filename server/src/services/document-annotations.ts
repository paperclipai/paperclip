import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documents,
  issueComments,
  issueDocuments,
  routineDocuments,
} from "@paperclipai/db";
import {
  anchorSnapshotToSelector,
  remapDocumentAnchor,
  selectorToAnchorSnapshot,
  verifyDocumentAnchorSelector,
  type DocumentAnnotationAnchorSnapshot,
  type DocumentAnnotationComment,
  type DocumentAnnotationThread,
  CreateDocumentAnnotationComment,
  CreateDocumentAnnotationThread,
  UpdateDocumentAnnotationThread,
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

const threadSelect = {
  id: documentAnnotationThreads.id,
  companyId: documentAnnotationThreads.companyId,
  issueId: documentAnnotationThreads.issueId,
  routineId: documentAnnotationThreads.routineId,
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
      .where(and(eq(routineDocuments.routineId, routineId), eq(routineDocuments.key, key)))
      .then((rows: RoutineDocumentRow[]) => rows[0] ?? null);
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
    dbOrTx: any = db,
  ): Promise<DocumentAnnotationThread | null> {
    return dbOrTx
      .select(threadSelect)
      .from(documentAnnotationThreads)
      .where(and(
        eq(documentAnnotationThreads.id, threadId),
        eq(documentAnnotationThreads.routineId, routineId),
        eq(documentAnnotationThreads.documentKey, documentKey),
      ))
      .then((rows: DocumentAnnotationThread[]) => rows[0] ?? null);
  }

  async function commentsForThreads(threadIds: string[], dbOrTx: any = db): Promise<DocumentAnnotationComment[]> {
    if (threadIds.length === 0) return [];
    return dbOrTx
      .select(commentSelect)
      .from(documentAnnotationComments)
      .where(inArray(documentAnnotationComments.threadId, threadIds))
      .orderBy(asc(documentAnnotationComments.createdAt), asc(documentAnnotationComments.id));
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
      options: { status?: "open" | "resolved" | "all"; includeComments?: boolean } = {},
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
      const comments = await commentsForThreads(threads.map((thread) => thread.id));
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
      options: { status?: "open" | "resolved" | "all"; includeComments?: boolean } = {},
    ) => {
      const doc = await getRoutineDocument(routineId, key);
      if (!doc) throw notFound("Document not found");
      const conditions = [
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
      const comments = await commentsForThreads(threads.map((thread) => thread.id));
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

    getThreadForIssueDocument: async (issueId: string, key: string, threadId: string) => {
      const thread = await getThreadForIssue(issueId, key, threadId);
      if (!thread) return null;
      const comments = await commentsForThreads([thread.id]);
      return { ...thread, comments };
    },

    getThreadForRoutineDocument: async (routineId: string, key: string, threadId: string) => {
      const thread = await getThreadForRoutine(routineId, key, threadId);
      if (!thread) return null;
      const comments = await commentsForThreads([thread.id]);
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

    addComment: async (
      issueId: string,
      key: string,
      threadId: string,
      input: CreateDocumentAnnotationComment,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const thread = await getThreadForIssue(issueId, key, threadId, tx);
      if (!thread) throw notFound("Annotation thread not found");
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
      const thread = await getThreadForRoutine(routineId, key, threadId, tx);
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
      const thread = await getThreadForRoutine(routineId, key, threadId, tx);
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

    selectorToAnchorSnapshot,
  };
}
