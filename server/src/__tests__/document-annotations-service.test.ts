import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documentAnnotationAnchorSnapshots,
  documentAnnotationCommentReactions,
  documentAnnotationComments,
  documentAnnotationThreads,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { documentAnnotationService } from "../services/document-annotations.js";
import { documentService } from "../services/documents.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { buildDocumentReviewContext, buildPlanReviewContext, PLAN_REVIEW_CONTEXT_LIMITS } from "../services/plan-review-context.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres document annotation service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describeEmbeddedPostgres("documentAnnotationService", () => {
  let db!: ReturnType<typeof createDb>;
  let annotations!: ReturnType<typeof documentAnnotationService>;
  let docs!: ReturnType<typeof documentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-document-annotations-");
    db = createDb(tempDb.connectionString);
    annotations = documentAnnotationService(db);
    docs = documentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentAnnotationAnchorSnapshots);
    await db.delete(documentAnnotationCommentReactions);
    await db.delete(documentAnnotationComments);
    await db.delete(documentAnnotationThreads);
    await db.delete(issueThreadInteractions);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.update(issues).set({ executionRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createIssueWithDocument(workMode: "planning" | "standard" = "planning") {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `PAP-${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      title: "Annotation race",
      description: "Validate annotation revision guards",
      status: "in_progress",
      workMode,
      priority: "high",
    });

    const created = await docs.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "Alpha selected text omega",
    });

    return { companyId, issueId, document: created.document };
  }

  it("fails closed when a concurrent document update wins before annotation thread creation commits", async () => {
    const { companyId, issueId, document } = await createIssueWithDocument();
    const concurrentUpdateCanCommit = deferred<void>();
    const concurrentUpdateHasWritten = deferred<void>();

    const concurrentUpdate = db.transaction(async (tx) => {
      const now = new Date();
      const [revision] = await tx
        .insert(documentRevisions)
        .values({
          companyId,
          documentId: document.id,
          revisionNumber: document.latestRevisionNumber + 1,
          title: "Plan",
          format: "markdown",
          body: "Alpha changed text omega",
          changeSummary: "Concurrent edit",
          createdAt: now,
        })
        .returning();

      await tx
        .update(documents)
        .set({
          latestBody: "Alpha changed text omega",
          latestRevisionId: revision.id,
          latestRevisionNumber: document.latestRevisionNumber + 1,
          updatedAt: now,
        })
        .where(eq(documents.id, document.id));

      concurrentUpdateHasWritten.resolve();
      await concurrentUpdateCanCommit.promise;
    });

    await concurrentUpdateHasWritten.promise;

    let annotationSettled = false;
    const annotationResult = annotations
      .createThread(
        issueId,
        "plan",
        {
          baseRevisionId: document.latestRevisionId!,
          baseRevisionNumber: document.latestRevisionNumber,
          selector: {
            quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
            position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
          },
          body: "Please review this text",
        },
        { actorType: "user", actorId: "board-user", userId: "board-user" },
      )
      .then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      )
      .finally(() => {
        annotationSettled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(annotationSettled).toBe(false);

    concurrentUpdateCanCommit.resolve();
    await concurrentUpdate;

    const result = await annotationResult;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toMatchObject({
        status: 409,
        message: "Annotation anchor requires the current document revision",
        details: {
          currentRevisionNumber: 2,
        },
      });
    }

    const threads = await db.select().from(documentAnnotationThreads);
    expect(threads).toHaveLength(0);
  });

  it("removes linked annotation comments and resolves empty threads when an issue comment is deleted", async () => {
    const { companyId, issueId, document } = await createIssueWithDocument();
    const [issueComment] = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorType: "user",
        authorUserId: "board-user",
        body: "Delete this linked comment",
      })
      .returning();

    const thread = await annotations.createThread(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        selector: {
          quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
          position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
        },
        body: "Linked annotation body",
        issueCommentId: issueComment.id,
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );

    const cleanup = await annotations.cleanupForIssueCommentDeletion(
      issueId,
      issueComment.id,
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );

    expect(cleanup.deletedCommentIds).toEqual([thread.comments[0]!.id]);
    expect(cleanup.resolvedThreadIds).toEqual([thread.id]);
    await expect(
      db.select().from(documentAnnotationComments).where(eq(documentAnnotationComments.id, thread.comments[0]!.id)),
    ).resolves.toHaveLength(0);
    const [updatedThread] = await db
      .select()
      .from(documentAnnotationThreads)
      .where(eq(documentAnnotationThreads.id, thread.id));
    expect(updatedThread?.status).toBe("resolved");
    expect(updatedThread?.resolvedByUserId).toBe("board-user");
  });

  it("rejects annotation comments linked to already-deleted issue comments", async () => {
    const { companyId, issueId, document } = await createIssueWithDocument();
    const [issueComment] = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorType: "user",
        authorUserId: "board-user",
        body: "",
        deletedAt: new Date("2026-06-05T03:00:00.000Z"),
        deletedByType: "user",
        deletedByUserId: "board-user",
      })
      .returning();

    await expect(
      annotations.createThread(
        issueId,
        "plan",
        {
          baseRevisionId: document.latestRevisionId!,
          baseRevisionNumber: document.latestRevisionNumber,
          selector: {
            quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
            position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
          },
          body: "Do not link this annotation to a deleted comment",
          issueCommentId: issueComment.id,
        },
        { actorType: "user", actorId: "board-user", userId: "board-user" },
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: "Linked issue comment must belong to this issue",
    });

    await expect(db.select().from(documentAnnotationComments)).resolves.toHaveLength(0);
  });

  it("does not report already-resolved empty threads as newly resolved during linked comment cleanup", async () => {
    const { companyId, issueId, document } = await createIssueWithDocument();
    const [issueComment] = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorType: "user",
        authorUserId: "board-user",
        body: "Delete this linked comment from a resolved thread",
      })
      .returning();

    const thread = await annotations.createThread(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        selector: {
          quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
          position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
        },
        body: "Linked annotation body",
        issueCommentId: issueComment.id,
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );

    await db
      .update(documentAnnotationThreads)
      .set({ status: "resolved", resolvedByUserId: "board-user", resolvedAt: new Date("2026-06-05T03:05:00.000Z") })
      .where(eq(documentAnnotationThreads.id, thread.id));

    const cleanup = await annotations.cleanupForIssueCommentDeletion(
      issueId,
      issueComment.id,
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );

    expect(cleanup.deletedCommentIds).toEqual([thread.comments[0]!.id]);
    expect(cleanup.resolvedThreadIds).toEqual([]);
  });

  it("builds compact open plan review context and excludes resolved threads", async () => {
    const { companyId, issueId, document } = await createIssueWithDocument();
    const longBody = "x".repeat(PLAN_REVIEW_CONTEXT_LIMITS.maxBodyChars + 25);
    const openThread = await annotations.createThread(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        selector: {
          quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
          position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
        },
        body: longBody,
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );
    const resolvedThread = await annotations.createThread(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        selector: {
          quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
          position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
        },
        body: "Already resolved",
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );
    await db
      .update(documentAnnotationThreads)
      .set({
        status: "resolved",
        anchorState: "stale",
        anchorConfidence: "fuzzy",
        resolvedByUserId: "board-user",
        resolvedAt: new Date("2026-06-05T03:05:00.000Z"),
      })
      .where(eq(documentAnnotationThreads.id, resolvedThread.id));

    const context = await buildPlanReviewContext({
      db,
      companyId,
      issueId,
      issueWorkMode: "planning",
    });

    expect(context).toMatchObject({
      documentKey: "plan",
      issueId,
      latestRevisionId: document.latestRevisionId,
      latestRevisionNumber: document.latestRevisionNumber,
      totals: {
        openThreadCount: 1,
        includedThreadCount: 1,
        omittedThreadCount: 0,
        commentCount: 1,
        includedCommentCount: 1,
        omittedCommentCount: 0,
      },
      truncated: true,
    });
    expect(context?.threads.map((thread) => thread.id)).toEqual([openThread.id]);
    expect(context?.threads[0]).toMatchObject({
      status: "open",
      anchorState: "active",
      anchorConfidence: "exact",
      selectedText: "selected text",
      prefixText: "Alpha ",
      suffixText: " omega",
      comments: [
        expect.objectContaining({
          body: "x".repeat(PLAN_REVIEW_CONTEXT_LIMITS.maxBodyChars),
          bodyTruncated: true,
          author: { type: "user", id: "board-user" },
        }),
      ],
    });
  });

  it("infers an omitted target issue id while rejecting cross-issue interaction context", async () => {
    const { companyId, issueId, document } = await createIssueWithDocument();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      identifier: "PAP-9443",
      title: "Other planning task",
      description: null,
      status: "in_progress",
      workMode: "planning",
      priority: "medium",
    });
    const [interaction] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        payload: {
          version: 1,
          prompt: "Approve this plan?",
          target: {
            type: "issue_document",
            documentId: document.id,
            key: "plan",
            revisionId: document.latestRevisionId,
            revisionNumber: document.latestRevisionNumber,
          },
        },
        result: {
          version: 1,
          outcome: "accepted",
          reason: null,
        },
        resolvedAt: new Date("2026-06-05T03:10:00.000Z"),
      })
      .returning();

    const context = await buildPlanReviewContext({
      db,
      companyId,
      issueId,
      issueWorkMode: "standard",
      interactionId: interaction.id,
    });
    expect(context?.interaction).toMatchObject({
      id: interaction.id,
      status: "accepted",
      target: {
        issueId,
        documentId: document.id,
        key: "plan",
        revisionId: document.latestRevisionId,
        revisionNumber: document.latestRevisionNumber,
      },
      acceptedTargetRevision: {
        revisionId: document.latestRevisionId,
        revisionNumber: document.latestRevisionNumber,
      },
      result: {
        outcome: "accepted",
        reason: null,
      },
    });

    await expect(buildPlanReviewContext({
      db,
      companyId,
      issueId: otherIssueId,
      issueWorkMode: "standard",
      interactionId: interaction.id,
    })).resolves.toBeNull();
  });

  it("includes open plan annotations for standard-mode issue comment wakes", async () => {
    const { companyId, issueId, document } = await createIssueWithDocument("standard");
    const thread = await annotations.createThread(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        selector: {
          quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
          position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
        },
        body: "Please incorporate this plan annotation in standard mode.",
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );
    const [comment] = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorUserId: "board-user",
        body: "Please continue with the plan feedback above.",
      })
      .returning();

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        wakeCommentIds: [comment.id],
        wakeReason: "issue_commented",
      },
    });

    expect(payload?.comments).toMatchObject([
      expect.objectContaining({
        id: comment.id,
        body: "Please continue with the plan feedback above.",
      }),
    ]);
    expect(payload?.planReviewContext).toMatchObject({
      issueId,
      totals: {
        openThreadCount: 1,
        includedCommentCount: 1,
      },
      threads: [
        expect.objectContaining({
          id: thread.id,
          comments: [
            expect.objectContaining({
              id: thread.comments[0]!.id,
              body: "Please incorporate this plan annotation in standard mode.",
            }),
          ],
        }),
      ],
    });
  });

  it("includes accepted plan annotations in the structured wake payload", async () => {
    const { companyId, issueId, document } = await createIssueWithDocument();
    const thread = await annotations.createThread(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        selector: {
          quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
          position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
        },
        body: "Please split this plan step before creating child issues.",
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );
    const [interaction] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        payload: {
          version: 1,
          prompt: "Approve this plan?",
          target: {
            type: "issue_document",
            issueId,
            documentId: document.id,
            key: "plan",
            revisionId: document.latestRevisionId,
            revisionNumber: document.latestRevisionNumber,
          },
        },
        result: {
          version: 1,
          outcome: "accepted",
        },
        resolvedAt: new Date("2026-06-05T03:10:00.000Z"),
      })
      .returning();

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        interactionId: interaction.id,
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        wakeReason: "issue_commented",
      },
    });

    expect(payload?.planReviewContext).toMatchObject({
      interaction: {
        id: interaction.id,
        status: "accepted",
        acceptedTargetRevision: {
          issueId,
          documentId: document.id,
          key: "plan",
          revisionId: document.latestRevisionId,
          revisionNumber: document.latestRevisionNumber,
        },
        result: {
          outcome: "accepted",
        },
      },
      totals: {
        openThreadCount: 1,
        includedCommentCount: 1,
      },
      threads: [
        expect.objectContaining({
          id: thread.id,
          selectedText: "selected text",
          comments: [
            expect.objectContaining({
              body: "Please split this plan step before creating child issues.",
            }),
          ],
        }),
      ],
    });
  });

  async function createAnnotatedIssue() {
    const created = await createIssueWithDocument("standard");
    const thread = await annotations.createThread(
      created.issueId,
      "plan",
      {
        baseRevisionId: created.document.latestRevisionId!,
        baseRevisionNumber: created.document.latestRevisionNumber,
        selector: {
          quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
          position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
        },
        body: "Is this step ready?",
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );
    return { ...created, thread, comment: thread.comments[0]! };
  }

  it("adds, repeats safely, and removes comment reactions with counts and reacted-by-me", async () => {
    const { companyId, issueId, thread, comment } = await createAnnotatedIssue();
    const user = { actorType: "user" as const, actorId: "board-user", userId: "board-user" };
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "worker", adapterType: "process", adapterConfig: {} });
    const agent = { actorType: "agent" as const, actorId: agentId, agentId };
    const target = { kind: "issue" as const, issueId, key: "plan" };
    const react = (actor: typeof user | typeof agent, reaction: "done" | "question", present: boolean) =>
      annotations.setCommentReaction({ target, threadId: thread.id, commentId: comment.id, reaction, present, actor });

    const added = await react(user, "question", true);
    expect(added.changed).toBe(true);
    expect(added.firstAdd).toBe(true);
    expect(added.comment.reactions).toEqual([
      { reaction: "question", count: 1, reactedByMe: true, actors: [{ actorType: "user", agentId: null, userId: "board-user" }] },
    ]);
    expect((await react(user, "question", true)).changed).toBe(false);
    await react(agent, "question", true);
    await react(agent, "done", true);

    const [listed] = await annotations.listThreadsForIssueDocument(issueId, "plan", {
      includeComments: true,
      viewer: { actorType: "user", actorId: "board-user" },
    }) as unknown as Array<{ comments: Array<{ reactions?: unknown[] }> }>;
    expect(listed!.comments[0]!.reactions).toEqual([
      { reaction: "done", count: 1, reactedByMe: false, actors: [{ actorType: "agent", agentId, userId: null }] },
      expect.objectContaining({ reaction: "question", count: 2, reactedByMe: true }),
    ]);
    const asAgent = await annotations.getThreadForIssueDocument(issueId, "plan", thread.id, { actorType: "agent", actorId: agentId });
    expect(asAgent!.comments[0]!.reactions).toEqual([
      expect.objectContaining({ reaction: "done", reactedByMe: true }),
      expect.objectContaining({ reaction: "question", count: 2, reactedByMe: true }),
    ]);

    const removed = await react(user, "question", false);
    expect(removed.changed).toBe(true);
    expect(removed.comment.reactions).toEqual([
      expect.objectContaining({ reaction: "done", count: 1, reactedByMe: false }),
      expect.objectContaining({ reaction: "question", count: 1, reactedByMe: false }),
    ]);
    expect((await react(user, "question", false)).changed).toBe(false);

    const readded = await react(user, "question", true);
    expect(readded.changed).toBe(true);
    expect(readded.firstAdd).toBe(false);
    expect(readded.comment.reactions).toEqual([
      expect.objectContaining({ reaction: "done", count: 1 }),
      expect.objectContaining({ reaction: "question", count: 2, reactedByMe: true }),
    ]);
  });

  it("rejects a reaction on a comment that belongs to another issue's thread", async () => {
    const { issueId, thread } = await createAnnotatedIssue();
    const other = await createAnnotatedIssue();

    await expect(annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: other.comment.id,
      reaction: "done",
      present: true,
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    })).rejects.toMatchObject({ status: 404 });
    await expect(annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: other.thread.id,
      commentId: other.comment.id,
      reaction: "done",
      present: true,
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    })).rejects.toMatchObject({ status: 404 });
  });

  it("marks a question reaction wake on the annotation delta", async () => {
    const { companyId, issueId, thread, comment } = await createAnnotatedIssue();

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        annotationCommentId: comment.id,
        annotationThreadId: thread.id,
        annotationReaction: "question",
        annotationReactionUserId: "board-user",
        wakeReason: "issue_commented",
      },
    });

    expect(payload?.annotationDeltas).toMatchObject([
      expect.objectContaining({
        id: comment.id,
        threadId: thread.id,
        reaction: { name: "question", author: { type: "user", id: "board-user" } },
      }),
    ]);
  });

  async function setupAssignedAnnotatedIssue(opts: { waitingChat?: boolean } = {}) {
    const created = await createAnnotatedIssue();
    const agentId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Reviewer",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: created.companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    const [agent] = await db.insert(agents).values({
      id: agentId,
      companyId: created.companyId,
      name: "Reviewer Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true } },
    }).returning();
    await db.update(issues).set({
      assigneeAgentId: agentId,
      ...(opts.waitingChat
        ? {
            status: "in_review",
            conversationAgentId: agentId,
            conversationUserId: userId,
            conversationState: "waiting",
          }
        : { status: "in_progress" }),
    }).where(eq(issues.id, created.issueId));

    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(agent!);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false } as never);
    deps.issuesSvc.getDependencyReadiness.mockResolvedValue({
      issueId: created.issueId,
      isDependencyBlocked: false,
      unresolvedBlockerCount: 0,
      unresolvedBlockers: [],
      blockedBy: [],
      blocking: [],
    } as never);
    const queue = createHeartbeatQueue(db, deps);
    return { ...created, agentId, userId, queue };
  }

  it("saves a recoverable wake request with a person's first question and resumes it if immediate wakeup fails", async () => {
    const { companyId, issueId, thread, comment, agentId, userId, queue } = await setupAssignedAnnotatedIssue();
    const actor = { actorType: "user" as const, actorId: userId, userId };

    const added = await annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: comment.id,
      reaction: "question",
      present: true,
      actor,
    });
    expect(added.firstAdd).toBe(true);
    expect(added.questionWakeRequestId).toEqual(expect.any(String));

    // Removing and re-adding must not create a second durable wake request.
    await annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: comment.id,
      reaction: "question",
      present: false,
      actor,
    });
    const readded = await annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: comment.id,
      reaction: "question",
      present: true,
      actor,
    });
    expect(readded.firstAdd).toBe(false);
    expect(readded.questionWakeRequestId).toBeNull();

    const savedWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(savedWakes).toHaveLength(1);
    expect(savedWakes[0]).toMatchObject({
      id: added.questionWakeRequestId,
      agentId,
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: userId,
    });

    // Simulate the route crashing or wakeup failing before dispatch: recovery promotes the saved receipt once.
    await queue.resumeDeferredExecutionReceipts({ companyId, requestId: added.questionWakeRequestId! });
    await queue.resumeDeferredExecutionReceipts({ companyId, requestId: added.questionWakeRequestId! });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(["queued", "running"]).toContain(runs[0]!.status);
    expect(runs[0]).toMatchObject({
      agentId,
      issueId,
      responsibleUserId: userId,
      contextSnapshot: expect.objectContaining({
        issueId,
        annotationCommentId: comment.id,
        annotationThreadId: thread.id,
        annotationReaction: "question",
        annotationReactionUserId: userId,
        source: "issue.document_annotation_reaction",
      }),
    });
    const [recoveredReceipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, added.questionWakeRequestId!));
    expect(recoveredReceipt).toMatchObject({ status: "coalesced", runId: runs[0]!.id });
  });

  it("wakes an idle waiting agent chat when a person adds a question reaction", async () => {
    const { companyId, issueId, thread, comment, agentId, userId, queue } = await setupAssignedAnnotatedIssue({ waitingChat: true });

    const added = await annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: comment.id,
      reaction: "question",
      present: true,
      actor: { actorType: "user", actorId: userId, userId },
    });
    expect(added.questionWakeRequestId).toEqual(expect.any(String));

    const run = await queue.trackWakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        annotationCommentId: comment.id,
        annotationThreadId: thread.id,
        annotationReaction: "question",
        mutation: "annotation_reaction",
      },
      allowRunCoalescing: false,
      executionWaitRequestId: added.questionWakeRequestId!,
      requestedByActorType: "user",
      requestedByActorId: userId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        annotationCommentId: comment.id,
        annotationThreadId: thread.id,
        annotationReaction: "question",
        annotationReactionUserId: userId,
        source: "issue.document_annotation_reaction",
        wakeReason: "issue_commented",
      },
    });

    expect(run).not.toBeNull();
    expect(run).toMatchObject({
      agentId,
      issueId,
      status: "queued",
      contextSnapshot: expect.objectContaining({
        annotationCommentId: comment.id,
        annotationReaction: "question",
      }),
    });
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, added.questionWakeRequestId!));
    expect(receipt).toMatchObject({ status: "coalesced", runId: run!.id });
    const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(allRuns).toHaveLength(1);
  });

  it("defers a question reaction behind a running turn without coalescing or duplicating the saved receipt", async () => {
    const { companyId, issueId, thread, comment, agentId, userId, queue } = await setupAssignedAnnotatedIssue();
    const activeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      scopeKind: "issue",
      issueId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: activeRunId }).where(eq(issues.id, issueId));

    const added = await annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: comment.id,
      reaction: "question",
      present: true,
      actor: { actorType: "user", actorId: userId, userId },
    });
    const result = await queue.trackWakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        annotationCommentId: comment.id,
        annotationThreadId: thread.id,
        annotationReaction: "question",
        mutation: "annotation_reaction",
      },
      allowRunCoalescing: false,
      executionWaitRequestId: added.questionWakeRequestId!,
      requestedByActorType: "user",
      requestedByActorId: userId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        annotationCommentId: comment.id,
        annotationThreadId: thread.id,
        annotationReaction: "question",
        annotationReactionUserId: userId,
        source: "issue.document_annotation_reaction",
        wakeReason: "issue_commented",
      },
    });

    expect(result).toBeNull();
    const deferredRows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(deferredRows).toHaveLength(1);
    expect(deferredRows[0]).toMatchObject({
      id: added.questionWakeRequestId,
      status: "deferred_issue_execution",
      runId: null,
    });
    expect(deferredRows[0]!.payload?.executionWait).toBeUndefined();
  });

  it("refuses to wake another user's agent chat from a non-owner question reaction", async () => {
    const { companyId, issueId, thread, comment, agentId, queue } = await setupAssignedAnnotatedIssue({ waitingChat: true });
    const otherUserId = `other-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: otherUserId,
      name: "Other Member",
      email: `${otherUserId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: otherUserId,
      status: "active",
      membershipRole: "member",
    });

    const added = await annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: comment.id,
      reaction: "question",
      present: true,
      actor: { actorType: "user", actorId: otherUserId, userId: otherUserId },
    });
    expect(added.changed).toBe(true);
    expect(added.questionWakeRequestId).toBeNull();
    expect(added.questionWakeSuppressed).toBe(true);

    const savedWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(savedWakes).toHaveLength(0);

    // Even direct wake admission as a non-owner is rejected by preflight and locked admission.
    const directRun = await queue.trackWakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        annotationCommentId: comment.id,
        annotationThreadId: thread.id,
        annotationReaction: "question",
        mutation: "annotation_reaction",
      },
      allowRunCoalescing: false,
      requestedByActorType: "user",
      requestedByActorId: otherUserId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        annotationCommentId: comment.id,
        annotationThreadId: thread.id,
        annotationReaction: "question",
        annotationReactionUserId: otherUserId,
        source: "issue.document_annotation_reaction",
        wakeReason: "issue_commented",
      },
    });
    expect(directRun).toBeNull();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(0);
  });

  it("bounds question reaction wakes across many distinct comments by pending backlog and per-window cap", async () => {
    const { companyId, issueId, thread, comment, agentId, userId, queue } = await setupAssignedAnnotatedIssue();
    const actor = { actorType: "user" as const, actorId: userId, userId };
    const comments = [comment];
    for (let i = 0; i < 4; i += 1) {
      comments.push(await annotations.addComment(issueId, "plan", thread.id, { body: `Follow-up ${i + 1}` }, actor));
    }

    async function admitAndFinishQuestionWake(commentId: string, requestId: string) {
      const run = await queue.trackWakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: {
          issueId,
          annotationCommentId: commentId,
          annotationThreadId: thread.id,
          annotationReaction: "question",
          mutation: "annotation_reaction",
        },
        allowRunCoalescing: false,
        executionWaitRequestId: requestId,
        requestedByActorType: "user",
        requestedByActorId: userId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          annotationCommentId: commentId,
          annotationThreadId: thread.id,
          annotationReaction: "question",
          annotationReactionUserId: userId,
          source: "issue.document_annotation_reaction",
          wakeReason: "issue_commented",
        },
      });
      expect(run).not.toBeNull();
      await db.update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, run!.id));
      await db.update(agentWakeupRequests)
        .set({ status: "completed", finishedAt: new Date() })
        .where(eq(agentWakeupRequests.runId, run!.id));
      await db.update(issues)
        .set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
        .where(eq(issues.id, issueId));
    }

    // While the first question wake is still pending, questioning additional distinct comments creates no extra wakes.
    const first = await annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: comments[0]!.id,
      reaction: "question",
      present: true,
      actor,
    });
    expect(first.questionWakeRequestId).toEqual(expect.any(String));
    const secondWhilePending = await annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: comments[1]!.id,
      reaction: "question",
      present: true,
      actor,
    });
    expect(secondWhilePending.changed).toBe(true);
    expect(secondWhilePending.questionWakeRequestId).toBeNull();
    expect(secondWhilePending.questionWakeSuppressed).toBe(true);

    // Normal admission coalesces the original receipt into a new primary wake row; both rows must count as ONE wake
    // so the rolling 3-per-10-minute allowance still permits 3 full question wakes before suppressing the 4th.
    await admitAndFinishQuestionWake(comments[0]!.id, first.questionWakeRequestId!);
    const secondWake = await annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: comments[2]!.id,
      reaction: "question",
      present: true,
      actor,
    });
    expect(secondWake.questionWakeRequestId).toEqual(expect.any(String));
    await admitAndFinishQuestionWake(comments[2]!.id, secondWake.questionWakeRequestId!);

    const thirdWake = await annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: comments[3]!.id,
      reaction: "question",
      present: true,
      actor,
    });
    expect(thirdWake.questionWakeSuppressed).toBe(false);
    expect(thirdWake.questionWakeRequestId).toEqual(expect.any(String));
    await admitAndFinishQuestionWake(comments[3]!.id, thirdWake.questionWakeRequestId!);

    const fourthCapped = await annotations.setCommentReaction({
      target: { kind: "issue", issueId, key: "plan" },
      threadId: thread.id,
      commentId: comments[4]!.id,
      reaction: "question",
      present: true,
      actor,
    });
    expect(fourthCapped.changed).toBe(true);
    expect(fourthCapped.questionWakeRequestId).toBeNull();
    expect(fourthCapped.questionWakeSuppressed).toBe(true);

    const originalReceipts = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .filter((row) => row.idempotencyKey?.startsWith("annotation-question-reaction:"));
    expect(originalReceipts).toHaveLength(3);
  });

  it("fails closed when an annotation delta comment id points at a different issue", async () => {
    const { companyId, issueId, document } = await createIssueWithDocument("standard");
    const { issueId: otherIssueId, document: otherDocument } = await createIssueWithDocument("standard");
    const otherThread = await annotations.createThread(
      otherIssueId,
      "plan",
      {
        baseRevisionId: otherDocument.latestRevisionId!,
        baseRevisionNumber: otherDocument.latestRevisionNumber,
        selector: {
          quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
          position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
        },
        body: "Different issue annotation comment.",
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        annotationCommentId: otherThread.comments[0]!.id,
        wakeReason: "issue_commented",
      },
    });

    expect(payload?.annotationDeltas).toEqual([]);
    expect(payload?.planReviewContext).toBeNull();
  });

  it("includes plan review context for same-issue annotation deltas on standard issues", async () => {
    const { companyId, issueId, document } = await createIssueWithDocument("standard");
    const thread = await annotations.createThread(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        selector: {
          quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
          position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
        },
        body: "Direct same-issue annotation comment.",
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        annotationCommentId: thread.comments[0]!.id,
        wakeReason: "issue_commented",
      },
    });

    expect(payload?.annotationDeltas).toMatchObject([
      expect.objectContaining({
        id: thread.comments[0]!.id,
        issueId,
        threadId: thread.id,
        body: "Direct same-issue annotation comment.",
      }),
    ]);
    expect(payload?.planReviewContext).toMatchObject({
      issueId,
      totals: {
        openThreadCount: 1,
        includedCommentCount: 1,
      },
      threads: [
        expect.objectContaining({
          id: thread.id,
          comments: [
            expect.objectContaining({
              id: thread.comments[0]!.id,
              body: "Direct same-issue annotation comment.",
            }),
          ],
        }),
      ],
    });
  });

  it("includes rejection result with an omitted target issue id even when the reason is empty", async () => {
    const { companyId, issueId, document } = await createIssueWithDocument();
    await annotations.createThread(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        selector: {
          quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
          position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
        },
        body: "The plan needs a concrete QA owner.",
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );
    const [interaction] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "rejected",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Approve this plan?",
          target: {
            type: "issue_document",
            documentId: document.id,
            key: "plan",
            revisionId: document.latestRevisionId,
            revisionNumber: document.latestRevisionNumber,
          },
        },
        result: {
          version: 1,
          outcome: "rejected",
          reason: "",
        },
        resolvedAt: new Date("2026-06-05T03:10:00.000Z"),
      })
      .returning();

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        interactionId: interaction.id,
        interactionKind: "request_confirmation",
        interactionStatus: "rejected",
        wakeReason: "issue_commented",
      },
    });

    expect(payload?.planReviewContext).toMatchObject({
      interaction: {
        id: interaction.id,
        status: "rejected",
        result: {
          outcome: "rejected",
          reason: null,
        },
      },
      totals: {
        openThreadCount: 1,
        includedCommentCount: 1,
      },
      threads: [
        expect.objectContaining({
          selectedText: "selected text",
          comments: [
            expect.objectContaining({
              body: "The plan needs a concrete QA owner.",
            }),
          ],
        }),
      ],
    });
  });

  it("groups non-plan annotations by most recently updated document and applies global caps", async () => {
    const { companyId, issueId } = await createIssueWithDocument("standard");
    const older = (await docs.upsertIssueDocument({
      issueId,
      key: "qa-evidence",
      title: "QA evidence",
      format: "markdown",
      body: "Alpha selected text omega",
    })).document;
    const newer = (await docs.upsertIssueDocument({
      issueId,
      key: "run-summary",
      title: "Run summary",
      format: "markdown",
      body: "Alpha selected text omega",
    })).document;
    await db.update(issueDocuments)
      .set({ updatedAt: new Date("2026-06-01T00:00:00.000Z") })
      .where(eq(issueDocuments.documentId, older.id));
    await db.update(issueDocuments)
      .set({ updatedAt: new Date("2026-06-02T00:00:00.000Z") })
      .where(eq(issueDocuments.documentId, newer.id));

    for (let index = 0; index < PLAN_REVIEW_CONTEXT_LIMITS.maxThreads + 1; index += 1) {
      await annotations.createThread(
        issueId,
        index === 0 ? "run-summary" : "qa-evidence",
        {
          baseRevisionId: index === 0 ? newer.latestRevisionId! : older.latestRevisionId!,
          baseRevisionNumber: index === 0 ? newer.latestRevisionNumber : older.latestRevisionNumber,
          selector: {
            quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
            position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
          },
          body: `Annotation ${index}`,
        },
        { actorType: "user", actorId: "board-user", userId: "board-user" },
      );
    }

    const context = await buildDocumentReviewContext({
      db,
      companyId,
      issueId,
      includeForIssueComment: true,
    });

    expect(context?.documents.map((document) => document.documentKey)).toEqual(["run-summary", "qa-evidence"]);
    expect(context?.totals).toMatchObject({
      openThreadCount: PLAN_REVIEW_CONTEXT_LIMITS.maxThreads + 1,
      includedThreadCount: PLAN_REVIEW_CONTEXT_LIMITS.maxThreads,
      omittedThreadCount: 1,
    });
    expect(context?.documents[1]).toMatchObject({ truncated: true });
    expect(context?.truncated).toBe(true);
  });
});
