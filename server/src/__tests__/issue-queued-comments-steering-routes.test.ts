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

describeEmbeddedPostgres("issue queued-comment steering routes", () => {
  const h = createIssueQueuedCommentsHarness("paperclip-queued-comments-steering-");
  let db!: QueuedCommentsDb;
  beforeAll(() => { db = h.db; });
  const { testProcesses, app, seedQueue, commitNativeSuccess, promoteQueue, seedDispatchIdentity } = h;

  it.each(["stale revision", "different issue"] as const)(
    "rejects queued interruption for a %s without stopping the run",
    async (scenario) => {
      const seeded = await seedQueue();
      await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, seeded.agentId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, seeded.runId));
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

  it.each(["preparing", "native"] as const)(
    "accepts an explicit interrupt fallback for a %s runner and preserves queued messages",
    async (runtime) => {
      const seeded = await seedQueue();
      if (runtime === "preparing") {
        await db.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: null,
          executionStage: "preparing",
          runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        }).where(eq(heartbeatRuns.id, seeded.runId));
      } else {
        await db.update(heartbeatRuns).set({ nativeIssueId: seeded.issueId })
          .where(eq(heartbeatRuns.id, seeded.runId));
        await db.insert(nativeRunFinalizations).values({ companyId: seeded.companyId,
          issueId: seeded.issueId, runId: seeded.runId, phase: "observed" });
      }
      // Hold the successor in the ordinary queue without launching a provider.
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, seeded.agentId));
      await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
        status: "running", contextSnapshot: { issueId: randomUUID() } });
      const client = app(seeded.companyId);
      const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      expect(queue.body).toMatchObject({ protocol: "paperclip_runner_v1", steeringDisposition: "temporarily_unavailable" });
      const response = await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
        queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      expect(waiting.payload?.queuedCommentInterrupt).toMatchObject({ actorId: "queue-owner", targetRunId: seeded.runId });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toHaveLength(2);
      expect(waiting.status).toBe("deferred_issue_execution");
      // The synthetic preparation owner now confirms that its unwind finished.
      // No provider ran; until this receipt exists, cancellation must hold input.
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      expect(stopped.status).toBe("cancelled");
      await db.update(heartbeatRuns).set({ resultJson: { ...stopped.resultJson,
        startupPreparationSettledAt: new Date().toISOString() } }).where(eq(heartbeatRuns.id, seeded.runId));
      await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      expect(wake.status, JSON.stringify(wake)).toBe("coalesced");
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
      expect(successor.status).toBe("queued");
      expect(successor.contextSnapshot?.wakeCommentIds).toEqual(seeded.commentIds);
      await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
      expect(await db.select().from(heartbeatRuns)).toHaveLength(3);
    },
  );

  async function seedFirstTurnQueue(runtime: "preparing" | "native", queueStartedBy: "user" | "system" = "user") {
    const seeded = await seedQueue();
    // A user's follow-ups, as the comment route saves them behind that user's run.
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agentWakeupRequests).set({ payload: { ...wake!.payload,
      _paperclipWakeContext: { ...(wake!.payload?._paperclipWakeContext as Record<string, unknown>),
        issueId: seeded.issueId, wakeReason: "issue_commented" } },
      // An earlier automatic wake that waited behind the task's execution: the
      // comment route merges the user's message into it and keeps its requester.
      ...(queueStartedBy === "system" ? { source: "automation", reason: "issue_execution_deferred",
        requestedByActorType: "system", requestedByActorId: null } : {}),
    }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(heartbeatRuns).set(runtime === "preparing"
      ? { responsibleUserId: "queue-owner", runtimeMode: "legacy", runtimeModeResolvedAt: null, executionStage: "preparing",
          runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } } }
      : { responsibleUserId: "queue-owner", nativeIssueId: seeded.issueId }).where(eq(heartbeatRuns.id, seeded.runId));
    if (runtime === "native") {
      await db.insert(nativeRunFinalizations).values({ companyId: seeded.companyId,
        issueId: seeded.issueId, runId: seeded.runId, phase: "observed" });
    }
    // Hold any successor in the ordinary queue without launching a provider.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, seeded.agentId));
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() } });
    return seeded;
  }

  it.each(["preparing", "native"] as const)(
    "keeps a %s run that has not started its first turn and gives it the queued messages",
    async (runtime) => {
      const seeded = await seedFirstTurnQueue(runtime);
      const client = app(seeded.companyId);
      const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      const response = await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
        queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.executionWait).toMatchObject({ reason: "first_turn_pending" });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      expect(run!.status).toBe("running");
      expect(run!.errorCode).toBeNull();
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      expect(wake!.status).toBe("deferred_issue_execution");
      expect(wake!.payload?.queuedCommentInterrupt).toBeUndefined();

      // Preparation finishes and the runner seals its first turn's input.
      if (runtime === "preparing") {
        await db.update(heartbeatRuns).set({ runtimeMode: "native", runtimeModeResolvedAt: new Date(),
          nativeIssueId: seeded.issueId }).where(eq(heartbeatRuns.id, seeded.runId));
      }
      const firstTurn = await claimFirstTurnQueuedInput(db, { companyId: seeded.companyId, runId: seeded.runId,
        issueId: seeded.issueId, agentId: seeded.agentId });
      expect(firstTurn).toContain("First queued message");
      expect(firstTurn!.indexOf("First queued message")).toBeLessThan(firstTurn!.indexOf("Second queued message"));
      // The taken messages leave the visible queue; nothing else can claim them.
      const after = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      expect(after.body.entries).toEqual([]);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId)))
        .filter(row => row.status === "queued")).toEqual([]);
    },
  );

  it.each([["preparing", false], ["native", false], ["native", true]] as const)(
    "stops a %s swarm run (turn started: %s) on Interrupt and delivers the queued message as the next request",
    async (runtime, turnStarted) => {
      const seeded = await seedFirstTurnQueue(runtime);
      // A trusted /swarm run: its only instruction is the recorded request, so no queued message joins it.
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...current!.contextSnapshot, antigravitySwarmCommentId: randomUUID() } })
        .where(eq(heartbeatRuns.id, seeded.runId));
      if (turnStarted) {
        await appendHeartbeatRunEvent(db, { companyId: seeded.companyId, runId: seeded.runId, agentId: seeded.agentId,
          eventType: "turn.accepted", stream: "system", level: "info", message: "turn accepted" });
      }
      const client = app(seeded.companyId);
      const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      // Not shown as taken by the first turn: the swarm will never read it.
      expect(queue.body.firstTurnCommentIds ?? []).toEqual([]);
      const response = await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
        queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.executionWait?.reason).not.toBe("first_turn_pending");
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      expect(wake!.payload?.queuedCommentInterrupt).toMatchObject({ actorId: "queue-owner" });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      expect(run!.status).toBe("cancelled");
    },
  );

  it("gives a booting run's first turn the user's message merged into an earlier automatic wake", async () => {
    const seeded = await seedFirstTurnQueue("preparing", "system");
    const client = app(seeded.companyId);
    // Shown as sent: Steer cannot reach a provider that has not started yet.
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.firstTurnCommentIds).toEqual(seeded.commentIds);
    // Interrupt must not cancel the boot and leave the message behind a recovery wait.
    const response = await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
      queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.executionWait).toMatchObject({ reason: "first_turn_pending" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run!.status).toBe("running");
    expect(run!.errorCode).toBeNull();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", runtimeModeResolvedAt: new Date(),
      nativeIssueId: seeded.issueId }).where(eq(heartbeatRuns.id, seeded.runId));
    const firstTurn = await claimFirstTurnQueuedInput(db, { companyId: seeded.companyId, runId: seeded.runId,
      issueId: seeded.issueId, agentId: seeded.agentId });
    expect(firstTurn).toContain("First queued message");
    expect(firstTurn).toContain("Second queued message");
  });

  it.each(["preparing", "native"] as const)(
    "reports the messages a %s run's first turn takes, before and after it seals them",
    async (runtime) => {
      const seeded = await seedFirstTurnQueue(runtime);
      const client = app(seeded.companyId);
      // The sandbox is still booting: the messages are sent, not waiting for Steer.
      const before = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      expect(before.body.firstTurnCommentIds).toEqual(seeded.commentIds);

      if (runtime === "preparing") {
        await db.update(heartbeatRuns).set({ runtimeMode: "native", runtimeModeResolvedAt: new Date(),
          nativeIssueId: seeded.issueId }).where(eq(heartbeatRuns.id, seeded.runId));
      }
      await claimFirstTurnQueuedInput(db, { companyId: seeded.companyId, runId: seeded.runId,
        issueId: seeded.issueId, agentId: seeded.agentId });
      // After the seal the queue hides them; the view still needs to know where they went.
      const after = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      expect(after.body.entries).toEqual([]);
      expect(after.body.firstTurnCommentIds).toEqual(seeded.commentIds);
    },
  );

  it("reports no first-turn messages once the run's turn already started", async () => {
    const seeded = await seedFirstTurnQueue("native");
    await appendHeartbeatRunEvent(db, { companyId: seeded.companyId, runId: seeded.runId, agentId: seeded.agentId,
      eventType: "turn.accepted", stream: "system", level: "info", message: "turn accepted" });
    const queue = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.entries).toHaveLength(2);
    expect(queue.body.firstTurnCommentIds ?? []).toEqual([]);
  });

  it("still interrupts a preparing run when its queue holds another user's message", async () => {
    const seeded = await seedFirstTurnQueue("native");
    // Ordinary comments from two users merge into one wake that keeps the
    // first author as its requester; the first turn would take only that user's.
    await db.update(issueComments).set({ authorUserId: "other-operator" }).where(eq(issueComments.id, seeded.commentIds[1]!));
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    const response = await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
      queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    // The stop is the user's own click: the messages are on their way, not
    // waiting on a recovery the user should read about.
    expect(response.body.executionWait?.reason).toBe("interrupt_handoff");
    const polled = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(polled.body.executionWait?.reason).toBe("interrupt_handoff");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run!.status).toBe("cancelled");
    expect(run!.errorCode).toBe("operator_interrupted");
  });

  it.each(["accepted turn", "sealed first turn"] as const)(
    "still interrupts a run whose %s already started",
    async (state) => {
      const seeded = await seedFirstTurnQueue("native");
      if (state === "accepted turn") {
        // A run saved by the previous release carries no seal; its accepted turn decides.
        await appendHeartbeatRunEvent(db, { companyId: seeded.companyId, runId: seeded.runId, agentId: seeded.agentId,
          eventType: "turn.accepted", stream: "system", level: "info", message: "turn accepted" });
      } else {
        await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: seeded.issueId, firstTurnQueuedInput: {
          schema: "paperclip.first-turn-queued-input.v1", runId: seeded.runId, wakeupRequestIds: [], commentIds: [],
          claimedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, seeded.runId));
      }
      const client = app(seeded.companyId);
      const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      expect(queue.body.entries).toHaveLength(2);
      const response = await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
        queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      expect(run!.status).toBe("cancelled");
      expect(run!.errorCode).toBe("operator_interrupted");
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

  it.each([
    { target: null, runtime: "legacy" }, { target: "stopped-target", runtime: "legacy" },
    { target: "system-receipt", runtime: "legacy" }, { target: null, runtime: "native" },
  ] as const)("sends a stopped $runtime queue once with target $target", async ({ target, runtime }) => {
    const seeded = await seedQueue();
    if (target === "system-receipt") await db.update(agentWakeupRequests).set({
      requestedByActorType: "system", requestedByActorId: "heartbeat",
    }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agents).set({ adapterType: runtime === "native" ? "paperclip_runner" : "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: runtime, status: "succeeded",
      finishedAt: new Date("2026-08-22T15:03:00.000Z"),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    if (runtime === "native") await commitNativeSuccess(seeded);
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

});
