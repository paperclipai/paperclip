import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  activityLog,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  runIdentityContexts,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { initializeRunIdentity, reconcileSteeredIdentity } from "../services/run-identity.js";
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
    // Each case owns the entire disposable database. Clear the full company
    // graph, including attribution rows and constraints added by migrations.
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
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

  it.each(["stale revision", "native run", "different issue"] as const)(
    "rejects queued interruption for a %s without stopping the run",
    async (scenario) => {
      const seeded = await seedQueue();
      if (scenario !== "native run") {
        await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, seeded.agentId));
        await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, seeded.runId));
      }
      const client = app(seeded.companyId);
      const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      if (scenario === "different issue") {
        await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } }).where(eq(heartbeatRuns.id, seeded.runId));
      }
      await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
        queueId: seeded.wakeId, targetRunId: seeded.runId,
        revision: scenario === "stale revision" ? "stale" : queue.body.revision,
      }).expect(409);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0]!.status).toBe("running");
    },
  );

  it("does not accept interruption authority from an agent wake payload", async () => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, seeded.runId));
    await heartbeatService(db).wakeup(seeded.agentId, {
      source: "on_demand", reason: "issue_commented",
      requestedByActorType: "agent", requestedByActorId: seeded.agentId,
      payload: { issueId: seeded.issueId, commentId: seeded.commentIds[1],
        queuedCommentInterrupt: { actorId: "other-operator", requestedAt: new Date().toISOString() } },
      contextSnapshot: { issueId: seeded.issueId, wakeCommentId: seeded.commentIds[1] },
    });
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seeded.companyId));
    expect(wakes.length).toBeGreaterThan(0);
    expect(wakes.every(wake => !wake.payload?.queuedCommentInterrupt)).toBe(true);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId));
    expect(runs.find(run => run.id === seeded.runId)?.status).toBe("running");
    expect(runs.every(run => !run.contextSnapshot?.explicitUserContinuation)).toBe(true);
  });

  it("denies a viewer's interrupt before persisting intent or cancelling a run", async () => {
    const seeded = await seedQueue();
    await db.update(companyMemberships).set({ membershipRole: "viewer" })
      .where(eq(companyMemberships.principalId, "other-operator"));
    const client = app(seeded.companyId, "other-operator");
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
      queueId: seeded.wakeId, revision: queue.body.revision, targetRunId: seeded.runId,
    }).expect(403);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.payload?.queuedCommentInterrupt).toBeUndefined();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
  });

  it.each([null, "stopped-target", "system-receipt"])("sends a stopped legacy queue once with target %s", async (target) => {
    const seeded = await seedQueue();
    if (target === "system-receipt") await db.update(agentWakeupRequests).set({
      requestedByActorType: "system", requestedByActorId: "heartbeat",
    }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "succeeded",
      finishedAt: new Date("2026-08-22T15:03:00.000Z"),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    // Occupy this agent on a different task so the actual successor remains
    // queued and the test never launches a provider.
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    const client = app(seeded.companyId, "other-operator");
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.targetRunId).toBeNull();
    const body = { queueId: seeded.wakeId, revision: queue.body.revision,
      targetRunId: target === "stopped-target" ? seeded.runId : null };
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send(body).expect(200);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.status).toBe("queued");
    expect(successor.responsibleUserId).toBe("other-operator");
    const identity = await initializeRunIdentity(db, {
      companyId: seeded.companyId, issueId: seeded.issueId,
      runId: successor.id, messageIds: seeded.commentIds, responsibleUserId: "queue-owner", cause: "dispatch",
    });
    expect(identity.responsibleUserId).toBe("other-operator");
    expect(identity.cause).toBe("queued_comment_interrupt");
    expect(successor.contextSnapshot?.wakeCommentIds).toEqual(seeded.commentIds);
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(3);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send(body).expect(409);
  });

  it.each([
    ["other", "running"], ["other", "queued"], ["other", "scheduled_retry"],
    ["same", "running"], ["same", "queued"], ["same", "scheduled_retry"],
  ] as const)("scopes interrupted queue successors to its agent: %s agent %s", async (owner, status) => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "succeeded",
      finishedAt: new Date("2026-08-22T15:03:00.000Z"),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agentWakeupRequests).set({ payload: { ...wake.payload,
      queuedCommentInterrupt: { actorId: "other-operator", requestedAt: new Date().toISOString() },
    } }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    // Keep this agent at capacity so successful delivery queues a successor
    // without launching a provider. The independent run shares only the task.
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    const successorAgentId = owner === "same" ? seeded.agentId : randomUUID();
    if (owner === "other") await db.insert(agents).values({ id: successorAgentId,
      companyId: seeded.companyId, name: "Independent agent", role: "engineer",
      status: "idle", adapterType: "claude_local",
    });
    const [existingRun] = await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: successorAgentId,
      status, contextSnapshot: { issueId: seeded.issueId },
    }).returning();

    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId, { retryCleanup: true });
    if (owner === "other" && status !== "scheduled_retry") {
      // Another agent is not this queue's successor, but ordinary admission
      // must still preserve the task execution lock until its work stops.
      const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(waiting.status).toBe("deferred_issue_execution");
      expect(task.executionRunId).toBe(existingRun.id);
      expect(waiting.payload?.queuedCommentInterrupt).toMatchObject({ actorId: "other-operator" });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, existingRun.id));
      await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId, { retryCleanup: true });
    }
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(receipt.status).toBe(owner === "same" ? "deferred_issue_execution" : "coalesced");
    if (owner === "other") {
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!));
      expect(successor).toMatchObject({ agentId: seeded.agentId, status: "queued", responsibleUserId: "other-operator" });
      expect(successor.contextSnapshot?.wakeCommentIds).toEqual(seeded.commentIds);
    }
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId, { retryCleanup: true });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId)))
      .toHaveLength(owner === "same" ? 3 : 4);
  });

  it.each(["user", "system"])("keeps stopped-run interruption intent on a %s receipt across restart until the process stops, then delivers once", async (actorType) => {
    const seeded = await seedQueue();
    await db.update(agentWakeupRequests).set({ requestedByActorType: actorType })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "failed",
      processPid: process.pid, errorCode: "process_lost",
      finishedAt: new Date("2026-08-22T15:03:00.000Z"),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: seeded.companyId, sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: seeded.runId,
      status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
      evidence: { runId: seeded.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    });
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    const client = app(seeded.companyId, "other-operator");
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
      queueId: seeded.wakeId, revision: queue.body.revision, targetRunId: null,
    }).expect(200);
    const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(waiting.status).toBe("deferred_issue_execution");
    expect(waiting.payload?.queuedCommentInterrupt).toMatchObject({ actorId: "other-operator" });
    expect(waiting.payload?.executionWait).toMatchObject({ reason: "process_running" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(2);
    await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    // New service instances have no memory of the HTTP request. Concurrent
    // periodic workers must consume its durable receipt exactly once.
    await Promise.all([heartbeatService(db).resumeQueuedRuns(), heartbeatService(db).resumeQueuedRuns()]);
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(delivered.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.runId!));
    expect(successor.contextSnapshot).toMatchObject({ wakeCommentIds: seeded.commentIds,
      previousRunId: seeded.runId, forceFreshSession: true });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(3);
  });

  it.each(["user", "system", "manual_receipt_other_actor", "rejected_admission", "consumed_first", "consumed_last", "deleted_first", "agent_first", "cancelled_queued"])("delivers saved user messages on a %s queue after automatic recovery stopped, without another click", async (actorType) => {
    const seeded = await seedQueue();
    await db.update(agentWakeupRequests).set({ requestedByActorType: actorType === "user" ? "user" : "system" })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    if (actorType === "manual_receipt_other_actor") {
      const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      await db.update(agentWakeupRequests).set({ requestedByActorType: "user", requestedByActorId: "other-operator",
        payload: { ...saved.payload, manualUserWake: true },
      }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    }
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "failed",
      processPid: process.pid, errorCode: "process_lost", finishedAt: new Date("2026-08-22T15:03:00.000Z"),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: seeded.companyId, sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: seeded.runId,
      status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
      evidence: { runId: seeded.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    });
    // Leave the agent's only slot occupied on another task so dispatch stays queued.
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    await heartbeatService(db).resumeQueuedRuns();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status)
      .toBe("deferred_issue_execution");
    await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, seeded.runId));
    const excludedIndex = actorType === "consumed_last" ? 1 : 0;
    const filtersInput = ["consumed_first", "consumed_last", "deleted_first", "agent_first"].includes(actorType);
    if (actorType.startsWith("consumed_")) await db.update(heartbeatRuns).set({
      contextSnapshot: { issueId: seeded.issueId, wakeCommentIds: [seeded.commentIds[excludedIndex]] },
    }).where(eq(heartbeatRuns.id, seeded.runId));
    if (actorType === "deleted_first") await db.update(issueComments).set({ deletedAt: new Date() })
      .where(eq(issueComments.id, seeded.commentIds[0]));
    if (actorType === "agent_first") await db.update(issueComments).set({
      authorType: "agent", authorUserId: null, authorAgentId: seeded.agentId,
    }).where(eq(issueComments.id, seeded.commentIds[0]));
    const expectedIds = seeded.commentIds.filter((_, index) => !filtersInput || index !== excludedIndex);
    if (actorType === "cancelled_queued") await db.insert(heartbeatRuns).values({
      companyId: seeded.companyId, agentId: seeded.agentId, status: "cancelled", runtimeMode: "legacy",
      errorCode: "agent_paused", createdAt: new Date(0), finishedAt: new Date(1),
      contextSnapshot: { issueId: seeded.issueId, wakeCommentIds: [seeded.commentIds[0]] },
    });
    if (actorType === "rejected_admission") {
      await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
        status: "cancelled", runtimeMode: "legacy", errorCode: "execution_reconciliation_required",
        contextSnapshot: { issueId: seeded.issueId }, finishedAt: new Date(),
      });
    }
    await Promise.all([heartbeatService(db).resumeQueuedRuns(), heartbeatService(db).resumeQueuedRuns()]);
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(delivered.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.runId!));
    expect(successor.contextSnapshot).toMatchObject({ wakeCommentIds: expectedIds,
      previousRunId: seeded.runId, forceFreshSession: true });
    if (actorType === "manual_receipt_other_actor") {
      const [dispatch] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, successor.wakeupRequestId!));
      expect(dispatch.requestedByActorId).toBe("queue-owner");
      expect(dispatch.payload?.manualUserWake).toBeUndefined();
      expect(successor.responsibleUserId).toBe("queue-owner");
    }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(["rejected_admission", "cancelled_queued"].includes(actorType) ? 4 : 3);
    const [recovery] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId));
    expect(recovery.evidence.automaticRecovery).toMatchObject({ actionOutcome: "unknown" });
  });

  it("recovers a message deferred after legacy finalization released the task lock", async () => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "succeeded",
      finishedAt: new Date("2026-08-22T15:03:00.000Z"),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    await heartbeatService(db).resumeQueuedRuns();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("queued");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.contextSnapshot?.wakeCommentIds).toEqual(seeded.commentIds);
    await heartbeatService(db).resumeQueuedRuns();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(3);
  });

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

  it("projects the recovery wait reason only while the message is deferred", async () => {
    const seeded = await seedQueue();
    const executionWait = { reason: "remote_cleanup", message: "Waiting for the previous environment to stop." };
    await db.update(agentWakeupRequests).set({
      payload: sql`coalesce(${agentWakeupRequests.payload}, '{}'::jsonb) || ${JSON.stringify({ executionWait })}::jsonb`,
    }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    const waiting = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(waiting.status).toBe(200);
    expect(waiting.body.executionWait).toEqual(executionWait);
    await promoteQueue(seeded);
    const admitted = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(admitted.status).toBe(200);
    expect(admitted.body.executionWait).toBeUndefined();
  });

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

  it("writes one activity log row for each successful queue mutation, and none for a rejected one", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);

    const edited = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "edited body" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);

    const staleEdit = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "stale" });
    expect(staleEdit.status).toBe(409);

    const editRows = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comment_edited"));
    expect(editRows).toHaveLength(1);
    expect(editRows[0]?.details).toMatchObject({
      commentId: seeded.commentIds[0],
      queueId: seeded.wakeId,
      revision: edited.body.revision,
    });

    const reordered = await request(app(seeded.companyId))
      .put(`/api/issues/${seeded.issueId}/queued-comments/order`)
      .send({
        queueId: seeded.wakeId,
        revision: edited.body.revision,
        orderedCommentIds: [...seeded.commentIds].reverse(),
      });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    const reorderRow = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comments_reordered"))
      .then((rows) => rows[0]);
    expect(reorderRow?.details).toMatchObject({
      queueId: seeded.wakeId,
      revision: reordered.body.revision,
      orderedCommentIds: [...seeded.commentIds].reverse(),
    });

    const discarded = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[1]}`)
      .send({ queueId: seeded.wakeId, revision: reordered.body.revision });
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    const discardRow = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comment_discarded"))
      .then((rows) => rows[0]);
    expect(discardRow?.details).toMatchObject({
      commentId: seeded.commentIds[1],
      queueId: seeded.wakeId,
      revision: discarded.body.revision,
      cancelledRunId: null,
    });
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

    // Two discards happen in this scenario (the first trash, then the final
    // one that empties the queue), so match the row by its own commentId
    // instead of assuming insertion order.
    const discardRows = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comment_discarded"));
    const finalDiscardRow = discardRows.find(
      (row) => (row.details as { commentId?: string } | null)?.commentId === seeded.commentIds[0],
    );
    expect(finalDiscardRow?.details).toMatchObject({
      commentId: seeded.commentIds[0],
      cancelledRunId: queueRunId,
    });
  });

  it("keeps a mutation response's steering disposition in step with a fresh GET after promotion", async () => {
    const seeded = await seedQueue();
    await promoteQueue(seeded);
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(initial.body.steeringDisposition).toBe("temporarily_unavailable");

    const edited = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "edited during promotion" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const afterEdit = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(edited.body.steeringDisposition).toBe(afterEdit.body.steeringDisposition);

    const reordered = await request(app(seeded.companyId))
      .put(`/api/issues/${seeded.issueId}/queued-comments/order`)
      .send({
        queueId: seeded.wakeId,
        revision: edited.body.revision,
        orderedCommentIds: [...seeded.commentIds].reverse(),
      });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    const afterReorder = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(reordered.body.steeringDisposition).toBe(afterReorder.body.steeringDisposition);
  });

  it("returns entry objects with the same keys as the GET endpoint", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const edited = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ queueId: seeded.wakeId, revision: initial.body.revision, body: "edited body" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(Object.keys(edited.body.entries[0]).sort()).toEqual(Object.keys(initial.body.entries[0]).sort());
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

  async function seedDispatchIdentity(seeded: Awaited<ReturnType<typeof seedQueue>>) {
    const [identity] = await db.insert(runIdentityContexts).values({
      companyId: seeded.companyId,
      runId: seeded.runId,
      revision: 1,
      cause: "dispatch",
      correlationId: "dispatch",
      status: "accepted",
      acceptedAt: new Date("2026-08-22T15:00:00.000Z"),
    }).returning();
    await db.update(heartbeatRuns)
      .set({ activeIdentityContextId: identity!.id })
      .where(eq(heartbeatRuns.id, seeded.runId));
    return identity!;
  }

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
});
