import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  activityLog,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping queued-comment route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue queued-comment routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queued-comments-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.update(issues).set({ executionRunId: null }).catch(() => undefined);
    await db.update(agentWakeupRequests).set({ runId: null }).catch(() => undefined);
    await db.delete(activityLog).catch(() => undefined);
    await db.delete(issueComments).catch(() => undefined);
    await db.delete(heartbeatRunEvents).catch(() => undefined);
    await db.delete(heartbeatRuns).catch(() => undefined);
    await db.delete(agentWakeupRequests).catch(() => undefined);
    await db.delete(issues).catch(() => undefined);
    await db.delete(companyMemberships).catch(() => undefined);
    await db.delete(agents).catch(() => undefined);
    await db.delete(companies).catch(() => undefined);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string, userId = "queue-owner") {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedQueue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeId = randomUUID();
    const commentIds = [randomUUID(), randomUUID()];
    await db.insert(companies).values({
      id: companyId,
      name: "Queue Test Company",
      issuePrefix: "QUE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Paperclip Runner",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: "queue-owner",
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId,
        principalType: "user",
        principalId: "other-operator",
        status: "active",
        membershipRole: "operator",
      },
    ]);
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "issue_comment",
      reason: "Follow-up comments arrived during the active run",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "queue-owner",
      payload: {
        issueId,
        commentId: commentIds[1],
        _paperclipWakeContext: {
          commentId: commentIds[1],
          wakeCommentId: commentIds[1],
          wakeCommentIds: commentIds,
        },
      },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "queue route test",
      status: "running",
      runtimeMode: "native",
      startedAt: new Date("2026-08-22T15:00:00.000Z"),
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "QUE-1",
      title: "Queued steering",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
    });
    await db.insert(issueComments).values(commentIds.map((id, index) => ({
      id,
      companyId,
      issueId,
      authorType: "user" as const,
      authorUserId: "queue-owner",
      body: index === 0 ? "First queued message" : "Second queued message",
      createdAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
      updatedAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
    })));
    return { companyId, agentId, issueId, runId, wakeId, commentIds };
  }

  async function promoteQueue(seeded: Awaited<ReturnType<typeof seedQueue>>) {
    const queueRunId = randomUUID();
    const wake = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    const wakeContext = (wake?.payload as any)?._paperclipWakeContext ?? {};
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date("2026-08-22T15:05:00.000Z") })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db.insert(heartbeatRuns).values({
      id: queueRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "issue_comment",
      triggerDetail: "queue route promotion test",
      status: "queued",
      runtimeMode: "native",
      wakeupRequestId: seeded.wakeId,
      contextSnapshot: {
        issueId: seeded.issueId,
        wakeReason: "issue_reopened_via_comment",
        ...wakeContext,
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ status: "queued", runId: queueRunId })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db
      .update(issues)
      .set({ executionRunId: queueRunId })
      .where(eq(issues.id, seeded.issueId));
    return queueRunId;
  }

  it("returns the authoritative order, preserves full Markdown edits, and rejects stale revisions", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);

    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    expect(initial.body).toMatchObject({
      issueId: seeded.issueId,
      queueId: seeded.wakeId,
      state: "deferred",
      targetRunId: seeded.runId,
      protocol: "paperclip_runner_v1",
      entries: [
        { position: 0, canEdit: true, canDiscard: true, comment: { id: seeded.commentIds[0] } },
        { position: 1, canEdit: true, canDiscard: true, comment: { id: seeded.commentIds[1] } },
      ],
    });

    const markdown = "  Keep **all** Markdown.  \n";
    const edited = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: markdown });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.entries[0].comment.body).toBe(markdown);
    expect(edited.body.revision).not.toBe(initial.body.revision);
    const stored = await db.select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.id, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(stored?.body).toBe(markdown);

    const stale = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "stale" });
    expect(stale.status).toBe(409);
    expect(stale.body.details?.code).toBe("queued_comment_revision_conflict");
  });

  it("preserves reordered messages across promotion and cancels the queued run after final trash", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const reordered = await request(app(seeded.companyId))
      .put(`/api/issues/${seeded.issueId}/queued-comments/order`)
      .send({
        queueId: seeded.wakeId,
        revision: initial.body.revision,
        orderedCommentIds: [...seeded.commentIds].reverse(),
      });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    expect(reordered.body.entries.map((entry: any) => entry.comment.id)).toEqual([...seeded.commentIds].reverse());

    const queueRunId = await promoteQueue(seeded);
    const promoted = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(promoted.body).toMatchObject({
      queueId: seeded.wakeId,
      state: "queued",
      targetRunId: null,
      revision: reordered.body.revision,
    });

    const afterFirstTrash = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[1]}`)
      .send({ queueId: seeded.wakeId, revision: promoted.body.revision });
    expect(afterFirstTrash.status, JSON.stringify(afterFirstTrash.body)).toBe(200);
    expect(afterFirstTrash.body.entries.map((entry: any) => entry.comment.id)).toEqual([seeded.commentIds[0]]);
    const queuedRunAfterFirstTrash = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queueRunId))
      .then((rows) => rows[0]);
    expect((queuedRunAfterFirstTrash?.contextSnapshot as any)?.wakeCommentIds).toEqual([
      seeded.commentIds[0],
    ]);

    const emptied = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: afterFirstTrash.body.revision });
    expect(emptied.status, JSON.stringify(emptied.body)).toBe(200);
    expect(emptied.body.entries).toEqual([]);
    const wake = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    expect(wake?.status).toBe("cancelled");
    const [queueRun, storedIssue] = await Promise.all([
      db.select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queueRunId))
        .then((rows) => rows[0]),
      db.select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, seeded.issueId))
        .then((rows) => rows[0]),
    ]);
    expect(queueRun?.status).toBe("cancelled");
    expect(storedIssue?.executionRunId).toBeNull();
  });

  it("cancels the deferred wake when the final message is discarded before promotion", async () => {
    const seeded = await seedQueue();
    await db.delete(issueComments).where(eq(issueComments.id, seeded.commentIds[1]));
    await db
      .update(agentWakeupRequests)
      .set({
        payload: {
          issueId: seeded.issueId,
          commentId: seeded.commentIds[0],
          _paperclipWakeContext: {
            commentId: seeded.commentIds[0],
            wakeCommentId: seeded.commentIds[0],
            wakeCommentIds: [seeded.commentIds[0]],
          },
        },
      })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const discarded = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision });
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    const [wake, runs] = await Promise.all([
      db.select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, seeded.wakeId))
        .then((rows) => rows[0]),
      db.select({ id: heartbeatRuns.id }).from(heartbeatRuns),
    ]);
    expect(wake?.status).toBe("cancelled");
    expect(runs.map((run) => run.id)).toEqual([seeded.runId]);
  });

  it("routes legacy queued-comment cancellation through the promoted queue", async () => {
    const seeded = await seedQueue();
    const queueRunId = await promoteQueue(seeded);
    const cancelled = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/comments/${seeded.commentIds[0]}?mode=cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.id).toBe(seeded.commentIds[0]);
    const [wake, queueRun] = await Promise.all([
      db.select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, seeded.wakeId))
        .then((rows) => rows[0]),
      db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queueRunId))
        .then((rows) => rows[0]),
    ]);
    expect((wake?.payload as any)?._paperclipWakeContext?.wakeCommentIds).toEqual([
      seeded.commentIds[1],
    ]);
    expect((queueRun?.contextSnapshot as any)?.wakeCommentIds).toEqual([
      seeded.commentIds[1],
    ]);
  });

  it("reports an explicit conflict after queued-run dispatch has begun", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const queueRunId = await promoteQueue(seeded);
    await db
      .update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(heartbeatRuns.id, queueRunId));

    const discard = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision });
    expect(discard.status).toBe(409);
    expect(discard.body.details?.code).toBe("queued_comment_already_dispatching");
    const comment = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.id, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(comment?.id).toBe(seeded.commentIds[0]);
  });

  it("limits edit and trash to the comment owner", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId, "other-operator"))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(initial.status).toBe(200);
    expect(initial.body.entries[0]).toMatchObject({ canEdit: false, canDiscard: false });

    const edit = await request(app(seeded.companyId, "other-operator"))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "not mine" });
    expect(edit.status).toBe(403);
    const discard = await request(app(seeded.companyId, "other-operator"))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision });
    expect(discard.status).toBe(403);
  });

  it("cancels a queued continuation whose comments disappeared before claim", async () => {
    const seeded = await seedQueue();
    const queueRunId = await promoteQueue(seeded);
    await db.delete(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    await heartbeat.resumeQueuedRuns();

    const [queueRun, wake] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queueRunId))
        .then((rows) => rows[0]),
      db.select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, seeded.wakeId))
        .then((rows) => rows[0]),
    ]);
    expect(queueRun).toMatchObject({
      status: "cancelled",
      errorCode: "queued_comment_discarded",
    });
    expect(wake?.status).toBe("cancelled");
  });

  it("serializes discard against queued-run claim", async () => {
    const seeded = await seedQueue();
    await db.delete(issueComments).where(eq(issueComments.id, seeded.commentIds[1]));
    await db
      .update(agentWakeupRequests)
      .set({
        payload: {
          issueId: seeded.issueId,
          commentId: seeded.commentIds[0],
          _paperclipWakeContext: {
            commentId: seeded.commentIds[0],
            wakeCommentId: seeded.commentIds[0],
            wakeCommentIds: [seeded.commentIds[0]],
          },
        },
      })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const queueRunId = await promoteQueue(seeded);
    await db
      .update(agents)
      .set({
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      })
      .where(eq(agents.id, seeded.agentId));
    await db
      .update(heartbeatRuns)
      .set({ runtimeMode: "legacy" })
      .where(eq(heartbeatRuns.id, queueRunId));
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    const [discard] = await Promise.all([
      request(app(seeded.companyId))
        .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
        .send({ queueId: seeded.wakeId, revision: initial.body.revision }),
      heartbeat.resumeQueuedRuns(),
    ]);

    const queueRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queueRunId))
      .then((rows) => rows[0]);
    if (discard.status === 200) {
      expect(queueRun?.status).toBe("cancelled");
    } else {
      expect(discard.status, JSON.stringify(discard.body)).toBe(409);
      expect(discard.body.details?.code).toBe("queued_comment_already_dispatching");
      expect(queueRun?.status).not.toBe("queued");
    }
    await heartbeat.drainActiveRunExecutions();
  }, 30_000);
});
