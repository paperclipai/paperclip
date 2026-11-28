import { spawn, type ChildProcess } from "node:child_process";
import { runningProcesses } from "../adapters/index.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { createFullDatabaseResponseCapture, installDatabaseResponseCapture } from "./helpers/full-database-response-capture.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  activityLog,
  companies,
  companyMemberships,
  companySkills,
  completionContracts,
  createDb,
  environmentLeases,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issueThreadInteractions,
  issueRecoveryActions,
  nativeRunFinalizations,
  nativeRunResults,
  issues,
  runIdentityContexts,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { hasQueuedInteractionResponse } from "../services/queued-interaction-response.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { initializeRunIdentity, reconcileSteeredIdentity } from "../services/run-identity.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { claimFirstTurnQueuedInput } from "../services/native-runtime/first-turn-queued-input.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const steerNativeSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../services/native-runtime/native-session-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  steerNativeSessionMock.mockImplementation(actual.steerNativeSession);
  return { ...actual, steerNativeSession: steerNativeSessionMock };
});
const { NativeSessionSteeringError } = await import("../services/native-runtime/native-session-executor.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping queued-comment route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

import { createIssueQueuedCommentsHarness, type QueuedCommentsDb } from "./helpers/issue-queued-comments-harness.js";

describeEmbeddedPostgres("issue queued-comment dispatch routes", () => {
  const h = createIssueQueuedCommentsHarness("paperclip-queued-comments-dispatch-");
  let db!: QueuedCommentsDb;
  beforeAll(() => { db = h.db; });
  const { testProcesses, app, seedQueue, commitNativeSuccess, promoteQueue, seedDispatchIdentity } = h;

  it.each(["discard", "cancel"] as const)("cancels the deferred wake when the final message is discarded before promotion (%s)", async (mode) => {
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
      .delete(mode === "cancel"
          ? `/api/issues/${seeded.issueId}/comments/${seeded.commentIds[0]}?mode=cancel`
          : `/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
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

  it.each([false, true])("routes comment cancellation through the queue (promoted=%s)", async (promoted) => {
    const seeded = await seedQueue();
    const queueRunId = promoted ? await promoteQueue(seeded) : null;
    const cancelled = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/comments/${seeded.commentIds[0]}?mode=cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.id).toBe(seeded.commentIds[0]);
    const [wake, queueRun] = await Promise.all([
      db.select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, seeded.wakeId))
        .then((rows) => rows[0]),
      queueRunId ? db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queueRunId))
        .then((rows) => rows[0]) : null,
    ]);
    expect((wake?.payload as any)?._paperclipWakeContext?.wakeCommentIds).toEqual([
      seeded.commentIds[1],
    ]);
    if (promoted) expect((queueRun?.contextSnapshot as any)?.wakeCommentIds).toEqual([
      seeded.commentIds[1],
    ]);
    expect(await db.select().from(issueComments).where(eq(issueComments.id, seeded.commentIds[0]))).toEqual([]);
    const remaining = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(remaining.body.entries.map((entry: any) => entry.comment.id)).toEqual([seeded.commentIds[1]]);
  });

  it.each(["discard", "cancel"] as const)("reports an explicit conflict after queued-run dispatch has begun (%s)", async (mode) => {
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
      .delete(mode === "cancel"
          ? `/api/issues/${seeded.issueId}/comments/${seeded.commentIds[0]}?mode=cancel`
          : `/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
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

  it.each(["discard", "cancel"] as const)("limits edit and trash to the comment owner (%s)", async (mode) => {
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
      .delete(mode === "cancel"
          ? `/api/issues/${seeded.issueId}/comments/${seeded.commentIds[0]}?mode=cancel`
          : `/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision });
    expect(discard.status).toBe(403);
  });

  it.each(["running", "failed"] as const)("lets the board discard an agent message while the previous run is %s", async (status) => {
    const seeded = await seedQueue();
    await db.update(issueComments).set({ authorType: "agent", authorUserId: null, authorAgentId: seeded.agentId })
      .where(eq(issueComments.id, seeded.commentIds[0]));
    if (status === "failed") {
      await db.update(heartbeatRuns).set({ status, finishedAt: new Date("2026-08-22T15:04:00Z") })
        .where(eq(heartbeatRuns.id, seeded.runId));
      await db.update(issues).set({ executionRunId: null, status: "todo" }).where(eq(issues.id, seeded.issueId));
    }
    const initial = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(initial.status).toBe(200);
    expect(initial.body.entries[0]).toMatchObject({ canEdit: false, canDiscard: true });

    const edit = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "changed author text" });
    expect(edit.status).toBe(403);

    const discarded = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision });
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    expect(discarded.body.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual([seeded.commentIds[1]]);

    const reloaded = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(reloaded.body.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual([seeded.commentIds[1]]);
    const deleted = await db.select().from(issueComments).where(eq(issueComments.id, seeded.commentIds[0]));
    expect(deleted).toHaveLength(0);
    const wake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)).then(rows => rows[0]);
    expect((wake?.payload as any)._paperclipWakeContext.wakeCommentIds).toEqual([seeded.commentIds[1]]);
    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId));
    expect(activity).toEqual(expect.arrayContaining([expect.objectContaining({
      actorType: "user", actorId: "queue-owner", action: "issue.queued_comment_discarded",
    })]));
  });

  it.each(["private task", "other company"] as const)("hides an agent queue from a board user outside its %s access", async (boundary) => {
    const seeded = await seedQueue();
    await db.update(issueComments).set({ authorType: "agent", authorUserId: null, authorAgentId: seeded.agentId })
      .where(eq(issueComments.id, seeded.commentIds[0]));
    const initial = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    let actorCompanyId = seeded.companyId;
    if (boundary === "private task") {
      await db.update(issues).set({ visibility: "private", privacyRootIssueId: seeded.issueId,
        createdByUserId: "queue-owner", responsibleUserId: "queue-owner" }).where(eq(issues.id, seeded.issueId));
    } else {
      actorCompanyId = randomUUID();
      await db.insert(companies).values({ id: actorCompanyId, name: "Other company", issuePrefix: "OTHER" });
      await db.insert(companyMemberships).values({ companyId: actorCompanyId, principalType: "user",
        principalId: "foreign-operator", status: "active", membershipRole: "operator" });
    }

    const response = await request(app(actorCompanyId, boundary === "private task" ? "other-operator" : "foreign-operator"))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision });
    expect(response.status).toBe(404);
    expect(await db.select().from(issueComments).where(eq(issueComments.id, seeded.commentIds[0]))).toHaveLength(1);
    const wake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)).then(rows => rows[0]);
    expect((wake?.payload as any)._paperclipWakeContext.wakeCommentIds).toEqual(seeded.commentIds);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId))).toHaveLength(0);
  });

  it("leaves the selected row queued when no native steering session is attached", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(initial.body.steeringDisposition).toBe("temporarily_unavailable");

    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });

    expect(steered.status).toBe(409);
    expect(steered.body.details).toMatchObject({
      code: "steering_temporarily_unavailable",
      retryable: true,
    });
    const queueAfterFailure = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(queueAfterFailure.body.entries.map((entry: any) => entry.comment.id)).toEqual(seeded.commentIds);
  });

  it("returns the persisted acknowledgement when the final steering response is retried", async () => {
    const seeded = await seedQueue();
    await db.delete(issueComments).where(eq(issueComments.id, seeded.commentIds[1]));
    await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: new Date("2026-08-22T15:04:00.000Z"),
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
    await db
      .update(heartbeatRuns)
      .set({
        resultJson: {
          queuedSteeringAcknowledgements: {
            [seeded.commentIds[0]]: {
              status: "acknowledged",
              queueId: seeded.wakeId,
              turnId: "turn-acknowledged",
              acknowledgedAt: "2026-08-22T15:04:00.000Z",
            },
          },
        },
      })
      .where(eq(heartbeatRuns.id, seeded.runId));

    const retried = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({
        queueId: seeded.wakeId,
        targetRunId: seeded.runId,
        revision: "response-was-lost-before-the-client-stored-the-revision",
      });

    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({
      issueId: seeded.issueId,
      queueId: null,
      state: null,
      entries: [],
    });
    const activity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comment_steered"))
      .then((rows) => rows[0]);
    expect(activity?.details).toMatchObject({
      commentId: seeded.commentIds[0],
      targetRunId: seeded.runId,
      turnId: "turn-acknowledged",
      duplicate: true,
    });
  });

  it("does not reuse an acknowledgement from a different queue", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    await db
      .update(heartbeatRuns)
      .set({
        resultJson: {
          queuedSteeringAcknowledgements: {
            [seeded.commentIds[0]]: {
              status: "acknowledged",
              queueId: randomUUID(),
              turnId: "turn-from-another-queue",
              acknowledgedAt: "2026-08-22T15:04:00.000Z",
            },
          },
        },
      })
      .where(eq(heartbeatRuns.id, seeded.runId));

    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({
        queueId: seeded.wakeId,
        targetRunId: seeded.runId,
        revision: initial.body.revision,
      });

    expect(steered.status).toBe(409);
    expect(steered.body.details).toMatchObject({
      code: "steering_temporarily_unavailable",
      retryable: true,
    });
    const queueAfterFailure = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(queueAfterFailure.body.entries.map((entry: any) => entry.comment.id))
      .toEqual(seeded.commentIds);
  });

  it("keeps queue edits available during handoff but rejects stale same-turn steering", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date("2026-08-22T15:05:00.000Z") })
      .where(eq(heartbeatRuns.id, seeded.runId));

    const edit = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({
        queueId: seeded.wakeId,
        revision: initial.body.revision,
        body: "edited during handoff",
      });

    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const stored = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.id, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(stored?.body).toBe("edited during handoff");
    const steer = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({
        queueId: seeded.wakeId,
        targetRunId: seeded.runId,
        revision: edit.body.revision,
      });
    expect(steer.status).toBe(409);
    expect(steer.body.details?.code).toBe("queued_comment_stale_target");
    const wake = await db
      .select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    expect(wake?.status).toBe("deferred_issue_execution");
    expect((wake?.payload as any)?._paperclipWakeContext?.wakeCommentIds).toEqual(seeded.commentIds);
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

  it("keeps a persisted legacy queue on the legacy protocol after the agent changes adapters", async () => {
    const seeded = await seedQueue();
    const queueRunId = await promoteQueue(seeded);
    await db
      .update(heartbeatRuns)
      .set({ runtimeMode: "legacy" })
      .where(eq(heartbeatRuns.id, queueRunId));

    const queued = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);

    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    expect(queued.body).toMatchObject({
      queueId: seeded.wakeId,
      state: "queued",
      targetRunId: null,
      protocol: "legacy",
      steeringDisposition: "unsupported",
    });
  });

  it.each(["paperclip_runner", "codex_local"])("keeps Steer during native preparation even after agent settings change to %s", async adapterType => {
    const seeded = await seedQueue();
    const steeringCalls = steerNativeSessionMock.mock.calls.length;
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(agents).set({ adapterType }).where(eq(agents.id, seeded.agentId));
    const client = app(seeded.companyId);
    const initial = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(initial.body).toMatchObject({ protocol: "paperclip_runner_v1", steeringDisposition: "temporarily_unavailable" });
    const edited = await request(client).patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "Updated direction" }).expect(200);
    expect(edited.body).toMatchObject({ protocol: "paperclip_runner_v1", steeringDisposition: "temporarily_unavailable" });
    expect(steerNativeSessionMock.mock.calls).toHaveLength(steeringCalls);
  });

  it.each(["discard", "cancel"] as const)("serializes discard against queued-run claim (%s)", async (mode) => {
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
        .delete(mode === "cancel"
          ? `/api/issues/${seeded.issueId}/comments/${seeded.commentIds[0]}?mode=cancel`
          : `/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
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


  it("writes the identity acceptance, the wake payload, the run acknowledgement, and the activity row on a successful steering transaction", async () => {
    const seeded = await seedQueue();
    await seedDispatchIdentity(seeded);
    steerNativeSessionMock.mockResolvedValueOnce({ turnId: "turn-1" });

    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });

    expect(steered.status, JSON.stringify(steered.body)).toBe(200);

    const steeringIdentity = await db
      .select()
      .from(runIdentityContexts)
      .where(eq(runIdentityContexts.messageId, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(steeringIdentity).toMatchObject({
      status: "accepted",
      responsibleUserId: "queue-owner",
      cause: "steering",
    });

    const wake = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    expect((wake?.payload as any)?._paperclipWakeContext?.wakeCommentIds).toEqual([seeded.commentIds[1]]);

    const run = await db
      .select({ resultJson: heartbeatRuns.resultJson, activeIdentityContextId: heartbeatRuns.activeIdentityContextId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId))
      .then((rows) => rows[0]);
    expect((run?.resultJson as any)?.queuedSteeringAcknowledgements?.[seeded.commentIds[0]]).toMatchObject({
      status: "acknowledged",
      queueId: seeded.wakeId,
      turnId: "turn-1",
    });
    expect(run?.activeIdentityContextId).toBe(steeringIdentity!.id);

    const activity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comment_steered"))
      .then((rows) => rows[0]);
    expect(activity?.details).toMatchObject({
      commentId: seeded.commentIds[0],
      targetRunId: seeded.runId,
      turnId: "turn-1",
      duplicate: false,
    });
  });

  it("allows the runner to persist its acknowledgement while steering, preserving concurrent run updates", async () => {
    const seeded = await seedQueue();
    await seedDispatchIdentity(seeded);
    const originalProfile = { adapterDispatch: { adapterType: "paperclip_runner" },
      nativeExecutionInput: { provider: { kind: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium" } } };
    await db.update(heartbeatRuns).set({ runnerProfileJson: originalProfile }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ assigneeAdapterOverrides: { model: "gpt-6-sol", reasoningEffort: "xhigh" } })
      .where(eq(issues.id, seeded.issueId));
    steerNativeSessionMock.mockImplementationOnce(async () => {
      await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '1000ms'`);
        await appendHeartbeatRunEvent(tx as unknown as typeof db, {
          companyId: seeded.companyId, agentId: seeded.agentId, runId: seeded.runId,
          eventType: "item.completed", payload: { kind: "steering_acknowledgement" },
        });
        await tx.update(heartbeatRuns).set({ resultJson: { concurrentProviderReceipt: "preserve" } })
          .where(eq(heartbeatRuns.id, seeded.runId));
      });
      return { turnId: "turn-before-model-change" };
    });
    const initial = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });
    expect(steered.status, JSON.stringify(steered.body)).toBe(200);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run.status).toBe("running");
    expect(run.runnerProfileJson).toEqual(originalProfile);
    expect(steerNativeSessionMock).toHaveBeenCalledWith(expect.objectContaining({ runId: seeded.runId,
      message: "First queued message", correlationId: seeded.commentIds[0] }));
    expect(run.resultJson).toMatchObject({ concurrentProviderReceipt: "preserve", queuedSteeringAcknowledgements: {
      [seeded.commentIds[0]]: { status: "acknowledged", turnId: "turn-before-model-change" },
    } });
    expect(steered.body.entries.map((entry: any) => entry.comment.id)).toEqual([seeded.commentIds[1]]);
  });

  it.each(["cancelled", "failed", "succeeded", "different task"] as const)("preserves queued input when the run stops or changes scope during acknowledgement (%s)", async outcome => {
    const seeded = await seedQueue();
    await seedDispatchIdentity(seeded);
    steerNativeSessionMock.mockImplementationOnce(async () => {
      await db.update(heartbeatRuns).set({
        ...(outcome === "different task" ? { contextSnapshot: { issueId: randomUUID() } } : { status: outcome, finishedAt: new Date() }),
        resultJson: { providerReceipt: "preserve" },
      })
        .where(eq(heartbeatRuns.id, seeded.runId));
      return { turnId: "turn-that-stopped" };
    });
    const initial = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    const response = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });
    expect(response.status).toBe(409);
    expect(response.body.details).toMatchObject({ code: "queued_comment_stale_target" });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("deferred_issue_execution");
    expect((wake.payload as any)._paperclipWakeContext.wakeCommentIds).toEqual(seeded.commentIds);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run.resultJson).toEqual({ providerReceipt: "preserve" });
    const [identity] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.messageId, seeded.commentIds[0]));
    expect(identity?.status).toBe("pending");
    const activity = await db.select().from(activityLog).where(eq(activityLog.action, "issue.queued_comment_steered"));
    expect(activity).toHaveLength(0);
  });

  it("keeps the identity pending after a steering timeout, then reconciles it on a later acknowledgement", async () => {
    const seeded = await seedQueue();
    await seedDispatchIdentity(seeded);
    steerNativeSessionMock.mockRejectedValueOnce(
      new NativeSessionSteeringError("steering_timeout", "The provider did not acknowledge steering in time."),
    );

    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });

    expect(steered.status).toBe(409);
    expect(steered.body.details).toMatchObject({ code: "steering_timeout", retryable: true });

    const pending = await db
      .select()
      .from(runIdentityContexts)
      .where(eq(runIdentityContexts.messageId, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(pending?.status).toBe("pending");

    await reconcileSteeredIdentity(db, pending!);

    const reconciled = await db
      .select({ status: runIdentityContexts.status })
      .from(runIdentityContexts)
      .where(eq(runIdentityContexts.id, pending!.id))
      .then((rows) => rows[0]);
    expect(reconciled?.status).toBe("accepted");
    const run = await db
      .select({ activeIdentityContextId: heartbeatRuns.activeIdentityContextId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId))
      .then((rows) => rows[0]);
    expect(run?.activeIdentityContextId).toBe(pending!.id);
  });

  it("sets the identity to rejected on a definite steering rejection", async () => {
    const seeded = await seedQueue();
    await seedDispatchIdentity(seeded);
    steerNativeSessionMock.mockRejectedValueOnce(
      new NativeSessionSteeringError("steering_rejected", "The provider rejected the steering message."),
    );

    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: initial.body.revision });

    expect(steered.status).toBe(409);
    expect(steered.body.details).toMatchObject({ code: "steering_rejected", retryable: true });

    const rejected = await db
      .select({ status: runIdentityContexts.status })
      .from(runIdentityContexts)
      .where(eq(runIdentityContexts.messageId, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(rejected?.status).toBe("rejected");
  });

  it("throws queued_comment_order_mismatch and changes no row for an invalid reorder set", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);

    const invalid = await request(app(seeded.companyId))
      .put(`/api/issues/${seeded.issueId}/queued-comments/order`)
      .send({
        queueId: seeded.wakeId,
        revision: initial.body.revision,
        orderedCommentIds: [seeded.commentIds[0], randomUUID()],
      });

    expect(invalid.status, JSON.stringify(invalid.body)).toBe(409);
    expect(invalid.body.details?.code).toBe("queued_comment_order_mismatch");

    const wake = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    expect((wake?.payload as any)?._paperclipWakeContext?.wakeCommentIds).toEqual(seeded.commentIds);
    const after = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(after.body.entries.map((entry: any) => entry.comment.id)).toEqual(seeded.commentIds);
  });
  // BUG-08: a declined connection request (Slack) queued its read-only receipt
  // ahead of the user's next message. The receipt showed raw JSON, could not be
  // edited or discarded, and the next message never appeared in the queue.
  async function seedDeclinedConnectionReceipt(runState: "running" | "legacy" | "stopped") {
    const seeded = await seedQueue();
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId: seeded.companyId, issueId: seeded.issueId,
      kind: "connection_intent", status: "rejected", createdByAgentId: seeded.agentId,
      sourceRunId: seeded.runId, resolvedByUserId: "queue-owner", resolvedAt: new Date(),
      continuationPolicy: "wake_assignee", requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit",
      title: "Connect Slack", summary: "The agent needs this connection to continue.",
      payload: { version: 1, serviceSlug: "slack", serviceName: "Slack", phase: "requested",
        requestingAgentId: seeded.agentId, requestingAgentName: "Paperclip Runner" },
      result: { version: 1, outcome: "declined", reason: null },
    });
    // Same receipt shape as wakeConnectionIntentAfterResolution.
    await db.update(agentWakeupRequests).set({ payload: { issueId: seeded.issueId,
      mutation: "interaction", interactionId, interactionKind: "connection_intent", interactionStatus: "rejected",
      _paperclipWakeContext: { issueId: seeded.issueId, interactionId, interactionKind: "connection_intent",
        interactionStatus: "rejected", mutation: "interaction", refreshTools: true } },
    }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    if (runState === "legacy") {
      // A busy legacy run defers each new message behind the issue execution.
      await db.update(agents).set({ adapterType: "claude_local",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, seeded.agentId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, seeded.runId));
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      testProcesses.set(seeded.runId, child);
      runningProcesses.set(seeded.runId, { child, graceSec: 1, processGroupId: null });
    }
    if (runState === "stopped") {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "workspace_busy" })
        .where(eq(heartbeatRuns.id, seeded.runId));
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
      // Occupy the agent on another task so admission holds new work without
      // invoking a provider (the staging agent was busy on ONB-2/ONB-3).
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, seeded.agentId));
      await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
        status: "running", contextSnapshot: { issueId: randomUUID() } });
    }
    return { ...seeded, interactionId };
  }

  it("shows a declined connection receipt as a readable status, not its JSON", async () => {
    const seeded = await seedDeclinedConnectionReceipt("running");
    const queue = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.entries).toHaveLength(1);
    const [entry] = queue.body.entries;
    expect(entry.source).toMatchObject({ kind: "interaction", interactionKind: "connection_intent",
      summary: "Declined: Slack connection" });
    // The agent still receives the typed receipt in the steering body.
    expect(entry.comment.body).toContain('"outcome": "declined"');
  });

  it.each(["running", "stopped"] as const)(
    "keeps the next message visible and actionable after a declined connection (%s run)",
    async (runState) => {
      const seeded = await seedDeclinedConnectionReceipt(runState);
      const client = app(seeded.companyId);
      const sent = await request(client).post(`/api/issues/${seeded.issueId}/comments`)
        .send({ body: "Skip Slack for now and continue" }).expect(201);
      await vi.waitFor(async () => expect(await db.select().from(agentWakeupRequests)).toHaveLength(2));
      const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      const next = queue.body.entries.find((entry: any) => entry.comment.id === sent.body.id);
      expect(next, JSON.stringify(queue.body.entries.map((entry: any) => entry.comment.body.split("\n")[0])))
        .toMatchObject({ canEdit: true, canDiscard: true });
      expect(next.source).toBeUndefined();
      expect(queue.body.queueId).not.toBe(seeded.wakeId);
      // The message is the user's own queue entry, so its controls work.
      await request(client).delete(`/api/issues/${seeded.issueId}/queued-comments/${sent.body.id}`)
        .send({ queueId: queue.body.queueId, revision: queue.body.revision }).expect(200);
      // Declining the connection still reaches the agent on its own receipt.
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      expect(receipt.status).toBe("deferred_issue_execution");
      await new Promise(resolve => setTimeout(resolve, 250));
    },
  );

  it.each(["legacy", "stopped"] as const)(
    "queues every later message together after a declined connection (%s run)",
    async (runState) => {
      const seeded = await seedDeclinedConnectionReceipt(runState);
      const client = app(seeded.companyId);
      const first = await request(client).post(`/api/issues/${seeded.issueId}/comments`)
        .send({ body: "Skip Slack for now" }).expect(201);
      await vi.waitFor(async () => expect(await db.select().from(agentWakeupRequests)).toHaveLength(2));
      const second = await request(client).post(`/api/issues/${seeded.issueId}/comments`)
        .send({ body: "Use email updates instead" }).expect(201);
      await vi.waitFor(async () => {
        const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
        expect(queue.body.entries.map((entry: any) => entry.comment.id)).toEqual([first.body.id, second.body.id]);
      });
      const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      expect(queue.body.entries.every((entry: any) => entry.canEdit && entry.canDiscard)).toBe(true);
      // The receipt is never merged with user input; it keeps its own wake.
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      expect(receipt.status).toBe("deferred_issue_execution");
      expect(receipt.payload?._paperclipWakeContext).not.toHaveProperty("wakeCommentIds");
      await new Promise(resolve => setTimeout(resolve, 250));
    },
  );

  // N-06: the composer offers "Send" for a deferred queue with no running
  // turn. The issue's own run can still be waiting to start (queued) or to
  // retry (scheduled_retry); that Send must be accepted and delivered next.
  it.each([
    { runtime: "native", status: "queued" }, { runtime: "native", status: "scheduled_retry" },
    { runtime: "legacy", status: "queued" }, { runtime: "legacy", status: "scheduled_retry" },
  ] as const)("accepts Send while the previous $runtime run is $status and delivers it once that run stops", async ({ runtime, status }) => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: runtime === "native" ? "paperclip_runner" : "codex_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: runtime, status, startedAt: null })
      .where(eq(heartbeatRuns.id, seeded.runId));
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    // This is the state in which the UI renders the "Send" button.
    expect(queue.body).toMatchObject({ state: "deferred", targetRunId: null, queueId: seeded.wakeId });
    const sent = await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
      queueId: seeded.wakeId, revision: queue.body.revision, targetRunId: null,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toMatchObject({ state: "deferred", queueId: seeded.wakeId });
    expect(sent.body.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual(seeded.commentIds);
    // The previous run is not cancelled: it has not started any work to stop.
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0]!.status).toBe(status);
    const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(saved.status).toBe("deferred_issue_execution");
    expect(saved.payload?.queuedCommentInterrupt).toMatchObject({ actorId: "queue-owner" });

    // The previous run then finishes. Occupy the agent on another task so the
    // successor stays queued and the test never launches a provider.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, seeded.runId));
    if (runtime === "native") await commitNativeSuccess(seeded);
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.status).toBe("queued");
    expect(successor.contextSnapshot?.wakeCommentIds).toEqual(seeded.commentIds);
  });
});
