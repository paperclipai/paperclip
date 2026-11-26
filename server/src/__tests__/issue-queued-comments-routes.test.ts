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

describeEmbeddedPostgres("issue queued-comment routes", () => {
  const h = createIssueQueuedCommentsHarness("paperclip-queued-comments-");
  let db!: QueuedCommentsDb;
  let tempDb: typeof h.tempDb = null;
  beforeAll(() => {
    db = h.db;
    tempDb = h.tempDb;
  });
  const { testProcesses, app, seedQueue, commitNativeSuccess, promoteQueue, seedDispatchIdentity } = h;

  it.each([false, true])("polls queued comments without transferring run snapshots (agent fallback: %s)", async fallback => {
    const f = await seedQueue(), payload = "saved-execution-input🙂".repeat(25_000);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, prompt: payload },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner", adapterConfig: { instructions: payload } } },
      stdoutExcerpt: payload, stderrExcerpt: payload,
    }).where(eq(heartbeatRuns.id, f.runId));
    if (fallback) await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const observed = createDb(tempDb!.connectionString), events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createFullDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(observed, { heartbeatRuns }, capture);
    try {
      const response = await request(app(f.companyId, "queue-owner", undefined, observed))
        .get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
      expect(response.body.queueId).toBe(f.wakeId);
      expect(response.body.targetRunId).toBe(f.runId);
      expect(response.body.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual(f.commentIds);
      capture.flush();
      const reads = events.filter(event => event.table === "heartbeat_runs" && event.operation === "select");
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.reduce((bytes, event) => bytes + Number(event.responseValueBytes), 0)).toBeLessThan(2048);
      await request(app(randomUUID(), "queue-owner", undefined, observed))
        .get(`/api/issues/${f.issueId}/queued-comments`).expect(404);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(before);
    } finally { capture.flush(); await observed.$client.end(); }
  });

  it.each(["deferred", "queued"])("reads only queue display inputs from large %s wake payloads", async state => {
    const f = await seedQueue();
    if (state === "queued") await promoteQueue(f);
    const client = app(f.companyId);
    const path = `/api/issues/${f.issueId}/queued-comments`;
    const expected = await request(client).get(path).expect(200);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    const payload = "saved-wake-input🙂".repeat(30_000);
    const context = wake.payload?._paperclipWakeContext as Record<string, unknown>;
    await db.update(agentWakeupRequests).set({ payload: {
      ...wake.payload, prompt: payload,
      _paperclipWakeContext: { ...context, prompt: payload, nativeExecutionInput: { instructions: payload } },
    } }).where(eq(agentWakeupRequests.id, f.wakeId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, prompt: payload },
      runnerProfileJson: { instructions: payload }, resultJson: { output: payload },
    }).where(eq(heartbeatRuns.companyId, f.companyId));
    const [before] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    const observed = createDb(tempDb!.connectionString), events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createFullDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(observed, { agentWakeupRequests, heartbeatRuns }, capture);
    try {
      const response = await request(app(f.companyId, "queue-owner", undefined, observed)).get(path).expect(200);
      expect(response.body).toEqual(expected.body);
      capture.flush();
      const reads = events.filter(event => ["agent_wakeup_requests", "heartbeat_runs"].includes(String(event.table)) && event.operation === "select");
      expect(reads.some(event => event.table === "agent_wakeup_requests")).toBe(true);
      expect(reads.reduce((bytes, event) => bytes + Number(event.responseValueBytes), 0)).toBeLessThan(4096);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId)))[0]).toEqual(before);
      await request(app(randomUUID(), "queue-owner", undefined, observed)).get(path).expect(404);
    } finally { capture.flush(); await observed.$client.end(); }
  });

  it.each(["deferred", "queued"])("filters unrelated task wakes before reading the %s comment queue", async state => {
    const f = await seedQueue();
    if (state === "queued") await promoteQueue(f);
    const path = `/api/issues/${f.issueId}/queued-comments`;
    const expected = await request(app(f.companyId)).get(path).expect(200);
    const unrelated = Array.from({ length: 80 }, (_, index) => ({
      companyId: f.companyId, agentId: f.agentId, source: "issue_comment",
      status: index % 2 ? "queued" : "deferred_issue_execution",
      requestedAt: new Date("2020-01-01T00:00:00Z"),
      payload: { issueId: randomUUID(), _paperclipWakeContext: {
        wakeCommentIds: Array.from({ length: 60 }, () => randomUUID()),
      } },
    }));
    const malformed = [null, [f.issueId], { id: f.issueId }, f.issueId.toUpperCase()];
    await db.insert(agentWakeupRequests).values([
      ...unrelated,
      ...malformed.map(issueId => ({ companyId: f.companyId, agentId: f.agentId,
        source: "issue_comment", status: "deferred_issue_execution",
        requestedAt: new Date("2020-01-01T00:00:00Z"),
        payload: { issueId, _paperclipWakeContext: { wakeCommentIds: f.commentIds } },
      })),
    ]);
    const observed = createDb(tempDb!.connectionString), events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createFullDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(observed, { agentWakeupRequests }, capture);
    try {
      const response = await request(app(f.companyId, "queue-owner", undefined, observed)).get(path).expect(200);
      expect(response.body).toEqual(expected.body);
      capture.flush();
      const reads = events.filter(event => event.table === "agent_wakeup_requests" && event.operation === "select");
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.reduce((bytes, event) => bytes + Number(event.responseValueBytes), 0)).toBeLessThan(4096);
      expect(reads.reduce((rows, event) => rows + Number(event.rows), 0)).toBe(1);
      expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(85);
      await request(app(randomUUID(), "queue-owner", undefined, observed)).get(path).expect(404);
    } finally { capture.flush(); await observed.$client.end(); }
  });

  it.each(["cancelled", "running"])("rejects a late Done from an interrupted %s task run at the write boundary", async status => {
    const seeded = await seedQueue();
    await db.update(heartbeatRuns).set({ status, resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, seeded.runId));
    // Model a request that passed middleware before cancellation and reached
    // the service after the run lost its authority. Recovery may have released
    // checkout and changed the task to Blocked in the meantime.
    await db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await expect(issueService(db).update(seeded.issueId, { status: "done",
      actorAgentId: seeded.agentId, actorRunId: seeded.runId,
    })).rejects.toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
    expect((await db.select().from(issues).where(eq(issues.id, seeded.issueId)))[0].status).toBe("blocked");
    // A board disposition remains authoritative.
    expect(await issueService(db).update(seeded.issueId, { status: "done", actorUserId: "queue-owner" }))
      .toMatchObject({ status: "done" });
  });

  it("delivers a saved Grok interrupt exactly once after remote cleanup, including concurrent restart sweeps", async () => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "grok_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled", errorCode: "operator_interrupted",
      finishedAt: new Date("2026-08-22T15:03:00.000Z"),
      contextSnapshot: { issueId: seeded.issueId, paperclipWorkspace: { remoteExecution: { transport: "sandbox" } } },
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: seeded.companyId, sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: seeded.runId,
      status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
      evidence: { runId: seeded.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    });
    const [lease] = await db.insert(environmentLeases).values({ companyId: seeded.companyId,
      issueId: seeded.issueId, heartbeatRunId: seeded.runId, provider: "daytona", providerLeaseId: randomUUID(),
      status: "active", leasePolicy: "ephemeral",
    }).returning();
    // Occupy the agent's slot on another task so this test never invokes a model.
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() },
    });
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({
      queueId: seeded.wakeId, revision: queue.body.revision, targetRunId: null,
    }).expect(200);
    const interruption = await db.select({ details: activityLog.details }).from(activityLog)
      .where(eq(activityLog.action, "issue.queued_comments_interrupted"));
    expect(interruption).toEqual([{ details: { queueId: seeded.wakeId, targetRunId: null } }]);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status)
      .toBe("deferred_issue_execution");
    // Cleanup timestamps alone are not proof. A mismatched receipt is not proof either.
    await db.update(environmentLeases).set({ status: "expired", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { ...remoteTerminationReceipt(lease, {
        providerLeaseId: lease.providerLeaseId, state: "destroyed",
      }), runId: randomUUID() } },
    }).where(eq(environmentLeases.id, lease.id));
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status)
      .toBe("deferred_issue_execution");
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, {
      providerLeaseId: lease.providerLeaseId, state: "destroyed",
    }) } }).where(eq(environmentLeases.id, lease.id));
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await Promise.all([heartbeatService(db).resumeQueuedRuns(), heartbeatService(db).resumeQueuedRuns()]);
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(delivered.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.runId!));
    expect(successor.contextSnapshot).toMatchObject({ wakeCommentIds: seeded.commentIds, previousRunId: seeded.runId,
      forceFreshSession: true });
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(3);
  });

  it("allows only the exact task mutation that stopped its own run to commit", async () => {
    const seeded = await seedQueue();
    const stopId = randomUUID();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_reassigned",
      resultJson: { reassignmentStopConfirmed: true, issueMutationStopId: stopId },
    }).where(eq(heartbeatRuns.id, seeded.runId));
    const data = { status: "todo", actorAgentId: seeded.agentId, actorRunId: seeded.runId };
    await expect(issueService(db).update(seeded.issueId, { ...data, actorRunStopId: randomUUID() }))
      .rejects.toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
    expect(await issueService(db).update(seeded.issueId, { ...data, actorRunStopId: stopId }))
      .toMatchObject({ status: "todo" });
    await expect(issueService(db).update(seeded.issueId, { ...data, status: "done" }))
      .rejects.toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
  });

  it.each(["questions", "verdicts"] as const)("rejects admitted %s responses after Stop revokes the run", async kind => {
    const seeded = await seedQueue();
    const service = issueThreadInteractionService(db);
    const issue = { id: seeded.issueId, companyId: seeded.companyId };
    const interaction = await service.create(issue, kind === "questions" ? {
      kind: "ask_user_questions", resolverPolicy: "board_or_agents", payload: { version: 1,
        questions: [{ id: "scope", prompt: "Choose scope", selectionMode: "single", options: [{ id: "first", label: "First" }] }],
      },
    } : {
      kind: "request_item_verdicts", resolverPolicy: "board_or_agents", payload: { version: 1,
        prompt: "Review the work",
        items: [{ id: "work", label: "Work" }],
      },
    }, { userId: "queue-owner" });
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, seeded.runId));
    const actor = { agentId: seeded.agentId, runId: seeded.runId };
    const responding = kind === "questions"
      ? service.answerQuestions(issue, interaction.id, { answers: [{ questionId: "scope", optionIds: ["first"] }] }, actor)
      : service.submitItemVerdicts(issue, interaction.id, { verdicts: [{ id: "work", verdict: "approve" }] }, actor);
    await expect(responding).rejects.toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status)
      .toBe("pending");
  });

  it.each((["request_confirmation", "request_checkbox_confirmation", "ask_user_questions"] as const)
    .flatMap(kind => (["legacy", "native"] as const).map(runtime => ({ kind, runtime }))))(
    "queues $kind resolution while its $runtime source run is still running",
    async ({ kind, runtime }) => {
      const seeded = await seedQueue();
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      if (runtime === "legacy") {
        await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, seeded.agentId));
        await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, seeded.runId));
      }
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      testProcesses.set(seeded.runId, child);
      runningProcesses.set(seeded.runId, { child, graceSec: 1, processGroupId: null });
      const interactionId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: interactionId, companyId: seeded.companyId, issueId: seeded.issueId,
        kind, status: "pending", createdByAgentId: seeded.agentId, sourceRunId: seeded.runId,
        continuationPolicy: "wake_assignee", requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit",
        payload: kind === "ask_user_questions"
          ? { version: 1, questions: [{ id: "runtime", prompt: "Which runtime?", selectionMode: "single", required: true,
              options: [{ id: "node", label: "Node.js" }, { id: "python", label: "Python" }] }] }
          : kind === "request_checkbox_confirmation"
            ? { version: 1, prompt: "Accept scope", options: [{ id: "scope", label: "Build the app" }] }
            : { version: 1, prompt: "Build the app?", detailsMarkdown: "Create exactly one child task." },
      });
      const client = app(seeded.companyId);
      await request(client).post(`/api/issues/${seeded.issueId}/interactions/${interactionId}/${kind === "ask_user_questions" ? "respond" : "accept"}`)
        .send(kind === "ask_user_questions" ? { answers: [{ questionId: "runtime", optionIds: ["node"] }] }
          : kind === "request_checkbox_confirmation" ? { selectedOptionIds: ["scope"] } : {}).expect(200);
      await vi.waitFor(async () => {
        const receipts = await db.select().from(agentWakeupRequests);
        expect(receipts.some(row => row.status === "deferred_issue_execution")).toBe(true);
      });
      const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      expect(queue.body.entries).toHaveLength(1);
      expect(queue.body.entries[0]).toMatchObject({
        source: { kind: "interaction", interactionId, interactionKind: kind },
        canEdit: false, canDiscard: false,
      });
      expect(queue.body.targetRunId).toBe(seeded.runId);
      expect(queue.body.entries[0].comment.body).toContain(kind === "ask_user_questions" ? "Node.js" : "Accepted");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0]!.status).toBe("running");
      const wakes = await db.select().from(agentWakeupRequests);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
    },
  );

  async function seedResponseQueue(native = false) {
    const seeded = await seedQueue();
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId: seeded.companyId, issueId: seeded.issueId,
      kind: "request_confirmation", status: "accepted", createdByAgentId: seeded.agentId,
      sourceRunId: seeded.runId, resolvedByUserId: "queue-owner", resolvedAt: new Date(),
      continuationPolicy: "wake_assignee", requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit",
      title: "Build the app", payload: { version: 1, prompt: "Build the app?" },
      result: { version: 1, outcome: "accepted" },
    });
    const context = { issueId: seeded.issueId, interactionId, interactionKind: "request_confirmation",
      interactionStatus: "accepted", planReviewInteraction: { id: interactionId,
        acceptedTargetRevision: { documentId: "plan-1", revisionId: "revision-1" } } };
    await db.update(agentWakeupRequests).set({ payload: { issueId: seeded.issueId,
      mutation: "interaction", interactionId, interactionStatus: "accepted", _paperclipWakeContext: context },
    }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    if (!native) {
      await db.update(agents).set({ adapterType: "claude_local",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      }).where(eq(agents.id, seeded.agentId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, seeded.runId));
    }
    return { ...seeded, interactionId, context };
  }

  it("keeps messages and approvals in separate durable queues in either arrival order", async () => {
    const seeded = await seedResponseQueue();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    testProcesses.set(seeded.runId, child);
    runningProcesses.set(seeded.runId, { child, graceSec: 1, processGroupId: null });
    const client = app(seeded.companyId);
    await request(client).post(`/api/issues/${seeded.issueId}/comments`)
      .send({ body: "Keep this message too" }).expect(201);
    await vi.waitFor(async () => expect(await db.select().from(agentWakeupRequests)).toHaveLength(2));
    let wakes = await db.select().from(agentWakeupRequests);
    expect(wakes.find(w => w.id === seeded.wakeId)?.payload).not.toHaveProperty("commentId");
    // A second resolved card must not overwrite either existing receipt.
    const nextId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: nextId, companyId: seeded.companyId, issueId: seeded.issueId,
      kind: "request_confirmation", status: "pending", createdByAgentId: seeded.agentId,
      sourceRunId: seeded.runId, continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit", payload: { version: 1, prompt: "Second approval?" },
    });
    await request(client).post(`/api/issues/${seeded.issueId}/interactions/${nextId}/accept`).send({}).expect(200);
    wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(3);
    expect(wakes.filter(w => w.payload?.mutation === "interaction").map(w => w.payload?.interactionId).sort())
      .toEqual([seeded.interactionId, nextId].sort());
    expect(wakes.find(w => w.payload?.commentId)?.payload?._paperclipWakeContext).not.toHaveProperty("interactionId");
  });

  it("recovers an approval acknowledged before the steering transaction failed without redelivery", async () => {
    const seeded = await seedResponseQueue(true);
    await seedDispatchIdentity(seeded);
    // Reconstruct the durable state after acknowledgement and HTTP rollback.
    const [pending] = await db.insert(runIdentityContexts).values({
      companyId: seeded.companyId, runId: seeded.runId, revision: 2,
      cause: "steering", correlationId: `interaction:${seeded.interactionId}`,
      messageId: seeded.interactionId, responsibleUserId: "queue-owner", status: "pending",
    }).returning();
    await db.insert(heartbeatRunEvents).values({
      companyId: seeded.companyId, runId: seeded.runId, agentId: seeded.agentId,
      seq: 1, eventType: "item.completed", sourceEventId: randomUUID(),
      payload: { prpEvent: { turnId: "approval-ack", itemId: `approval-ack:steer:${seeded.interactionId}`,
        payload: { kind: "steering_acknowledgement" } } },
    });
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    const body = { queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision };
    const endpoint = `/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}/steer`;
    const count = steerNativeSessionMock.mock.calls.length;
    await request(client).post(endpoint).send(body).expect(200);
    expect(steerNativeSessionMock.mock.calls).toHaveLength(count);
    expect((await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, pending.id)))[0].status).toBe("accepted");
  });

  it("interrupts an active legacy run and delivers the exact approval once", async () => {
    const seeded = await seedResponseQueue();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    testProcesses.set(seeded.runId, child);
    runningProcesses.set(seeded.runId, { child, graceSec: 1, processGroupId: null });
    await db.update(heartbeatRuns).set({ processPid: child.pid }).where(eq(heartbeatRuns.id, seeded.runId));
    // Occupy another task to inspect admission without invoking a paid provider.
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() } });
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision }).expect(200);
    runningProcesses.delete(seeded.runId);
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(["queued", "coalesced"]).toContain(wake.status);
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.status).toBe("queued");
    expect(successor.contextSnapshot).toMatchObject(seeded.context);
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(3);
  });

  // A composer snapshot taken before the card was recognised as a tool action
  // must not steer or interrupt the active turn just to deliver its result.
  it.each([
    { action: "steer", native: true },
    { action: "interrupt", native: false },
  ] as const)("refuses to $action with a tool action's outcome from a stale snapshot", async ({ action, native }) => {
    const seeded = await seedResponseQueue(native);
    const client = app(seeded.companyId);
    const stale = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(stale.body.entries).toHaveLength(1);
    await db.update(issueThreadInteractions).set({ title: "Approve tool action", payload: { version: 1, prompt: "Create the page?",
      toolAction: { toolName: "notebook_create_page", actionRequestId: randomUUID() } } as never })
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    const steerCalls = steerNativeSessionMock.mock.calls.length;
    const body = { queueId: seeded.wakeId, targetRunId: seeded.runId, revision: stale.body.revision };
    const endpoint = action === "steer"
      ? `/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}/steer`
      : `/api/issues/${seeded.issueId}/queued-comments/interrupt`;
    const result = await request(client).post(endpoint).send(body).expect(409);
    expect(result.body.details.code).toBe("queued_comment_not_pending");
    expect(steerNativeSessionMock.mock.calls).toHaveLength(steerCalls);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
    // The result is still owed to the agent after the current turn.
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status)
      .toBe("deferred_issue_execution");
  });

  it("steers a saved approval only on click and acknowledges retries once", async () => {
    const seeded = await seedResponseQueue(true);
    await seedDispatchIdentity(seeded);
    steerNativeSessionMock.mockResolvedValueOnce({ turnId: "approval-turn" });
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    const body = { queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision };
    const endpoint = `/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}/steer`;
    await request(client).post(endpoint).send(body).expect(200);
    const delivered = steerNativeSessionMock.mock.calls.at(-1)![0];
    expect(delivered.message).toContain(seeded.interactionId);
    expect(delivered.message).toContain('"status": "accepted"');
    expect((await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.messageId, seeded.interactionId)))[0])
      .toMatchObject({ status: "accepted", responsibleUserId: "queue-owner", cause: "steering" });
    const callCount = steerNativeSessionMock.mock.calls.length;
    await request(client).post(endpoint).send(body).expect(200);
    expect(steerNativeSessionMock.mock.calls).toHaveLength(callCount);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status).toBe("cancelled");
    expect(await db.select().from(issueComments)).toHaveLength(2); // no forged approval comment
  });

  it.each([false, true])("lets the source run finish review after acceptance, before wake persistence: %s", async (beforeWake) => {
    const seeded = await seedResponseQueue();
    if (beforeWake) await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    const client = app(seeded.companyId, "queue-owner", { agentId: seeded.agentId, runId: seeded.runId });
    const result = await request(client).patch(`/api/issues/${seeded.issueId}`).send({ status: "in_review", reviewInteractionId: seeded.interactionId });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(task.assigneeAgentId).toBe(seeded.agentId);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
  });

  it.each(["legacy", "native"] as const)("resumes a queued plan approval across a stopped %s run only after cleanup", async (runtime) => {
    const seeded = await seedResponseQueue(runtime === "native");
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, seeded.agentId));
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agentWakeupRequests).set({ payload: { ...receipt.payload,
      _paperclipWakeContext: { ...seeded.context, forceFreshSession: true } },
    }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "process_lost", processPid: process.pid })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: seeded.companyId, sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog", cause: runtime === "legacy" ? "legacy_execution_requires_reconciliation" : "native_continuation_requires_reconciliation",
      fingerprint: seeded.runId, status: "resolved", outcome: "blocked", nextAction: "Inspect stopped execution",
      evidence: { runId: seeded.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() } });
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`)
      .send({ queueId: seeded.wakeId, targetRunId: null, revision: queue.body.revision }).expect(200);
    const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(waiting.status).toBe("deferred_issue_execution");
    expect(waiting.payload?.executionWait).toMatchObject({ reason: "process_running" });
    await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, seeded.runId));
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.contextSnapshot).toMatchObject({ ...seeded.context, forceFreshSession: true, previousRunId: seeded.runId });
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId, seeded.wakeId);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(3);
  });

  it("keeps queued approval content immutable through comment mutation endpoints", async () => {
    const seeded = await seedResponseQueue();
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    const body = { queueId: seeded.wakeId, revision: queue.body.revision };
    await request(client).patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}`)
      .send({ ...body, body: "Reject instead" }).expect(409);
    await request(client).delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}`).send(body).expect(409);
    await request(client).put(`/api/issues/${seeded.issueId}/queued-comments/order`)
      .send({ ...body, orderedCommentIds: [seeded.interactionId] }).expect(409);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, seeded.interactionId)))[0].status).toBe("accepted");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId)))[0].status).toBe("deferred_issue_execution");
  });

  it("does not let a viewer steer someone else's approval", async () => {
    const seeded = await seedResponseQueue(true);
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, "queue-owner"));
    const calls = steerNativeSessionMock.mock.calls.length;
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision }).expect(403);
    expect(steerNativeSessionMock.mock.calls).toHaveLength(calls);
  });

  it("keeps a fresh-session approval and its Interrupt in view when another agent's comment queues after it", async () => {
    const seeded = await seedResponseQueue(true);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agentWakeupRequests).set({ payload: { ...receipt.payload,
      _paperclipWakeContext: { ...seeded.context, forceFreshSession: true } } }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    const [ceo] = await db.insert(agents).values({ companyId: seeded.companyId, name: "CEO", role: "ceo", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    const directionId = randomUUID(), later = new Date(Date.now() + 60_000);
    await db.insert(issueComments).values({ id: directionId, companyId: seeded.companyId, issueId: seeded.issueId,
      authorType: "agent", authorAgentId: ceo.id, body: "CEO direction: restart with the approved layout",
      createdAt: later, updatedAt: later });
    const [agentWake] = await db.insert(agentWakeupRequests).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      source: "issue_comment", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "agent", requestedByActorId: ceo.id, requestedAt: later,
      payload: { issueId: seeded.issueId, commentId: directionId,
        _paperclipWakeContext: { commentId: directionId, wakeCommentId: directionId, wakeCommentIds: [directionId] } } }).returning();
    const client = app(seeded.companyId);

    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.queueId).toBe(seeded.wakeId);
    expect(queue.body.entries).toEqual([expect.objectContaining({
      source: expect.objectContaining({ interactionId: seeded.interactionId, requiresFreshSession: true }) })]);

    const personId = randomUUID(), latest = new Date(Date.now() + 120_000);
    await db.insert(issueComments).values({ id: personId, companyId: seeded.companyId, issueId: seeded.issueId,
      authorType: "user", authorUserId: "queue-owner", body: "Also keep the signup button", createdAt: latest, updatedAt: latest });
    await db.update(agentWakeupRequests).set({ payload: { issueId: seeded.issueId, commentId: personId,
      _paperclipWakeContext: { commentId: personId, wakeCommentId: personId, wakeCommentIds: [directionId, personId] } } })
      .where(eq(agentWakeupRequests.id, agentWake.id));
    const withPersonMessage = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(withPersonMessage.body.queueId).toBe(agentWake.id);
  });

  it("does not steer a plan approval that requires a fresh execution session", async () => {
    const seeded = await seedResponseQueue(true);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db.update(agentWakeupRequests).set({ payload: { ...wake.payload,
      _paperclipWakeContext: { ...seeded.context, forceFreshSession: true } } }).where(eq(agentWakeupRequests.id, seeded.wakeId));
    const client = app(seeded.companyId);
    const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.entries[0].source.requiresFreshSession).toBe(true);
    const calls = steerNativeSessionMock.mock.calls.length;
    const result = await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.interactionId}/steer`)
      .send({ queueId: seeded.wakeId, targetRunId: seeded.runId, revision: queue.body.revision }).expect(409);
    expect(result.body.details.code).toBe("queued_response_requires_fresh_session");
    expect(steerNativeSessionMock.mock.calls).toHaveLength(calls);
  });

  it("rejects stale agent handback without cancelling the accepted proposal's run", async () => {
    const seeded = await seedResponseQueue();
    await db.update(issues).set({ createdByUserId: "queue-owner" }).where(eq(issues.id, seeded.issueId));
    const client = app(seeded.companyId, "queue-owner", { agentId: seeded.agentId, runId: seeded.runId });
    const result = await request(client).patch(`/api/issues/${seeded.issueId}`)
      .send({ status: "in_review", assigneeAgentId: null, assigneeUserId: "queue-owner" }).expect(409);
    expect(result.body.details.code).toBe("interaction_response_queued");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].status).toBe("running");
  });

  // N-01: a redundant continuation wake (for example a recovery sweep that raced
  // the response's own wake) carries a receipt the agent already received. It
  // must not sit in the composer queue as an immutable, unremovable item.
  const deliveredReceiptCases = [
    { kind: "ask_user_questions", status: "answered", title: null, label: "Answered: Questions",
      payload: { version: 1, questions: [{ id: "goal", prompt: "What are you building?", selectionMode: "single", required: true,
        options: [{ id: "shop", label: "A shop" }] }] }, result: { version: 1, answers: [{ questionId: "goal", optionIds: ["shop"] }] } },
    { kind: "request_confirmation", status: "accepted", title: "Approve hiring 2 agents", label: "Accepted: Approve hiring 2 agents",
      payload: { version: 1, prompt: "Hire 2 agents?" }, result: { version: 1, outcome: "accepted" } },
    { kind: "request_confirmation", status: "rejected", title: "Approve hiring 2 agents", label: "Rejected: Approve hiring 2 agents",
      payload: { version: 1, prompt: "Hire 2 agents?" }, result: { version: 1, outcome: "rejected" } },
    { kind: "request_checkbox_confirmation", status: "accepted", title: "Approve storefront prototype plan",
      label: "Accepted: Approve storefront prototype plan",
      payload: { version: 1, prompt: "Accept scope", options: [{ id: "scope", label: "Build the app" }] },
      result: { version: 1, outcome: "accepted", selectedOptionIds: ["scope"] } },
    { kind: "connection_intent", status: "accepted", title: "Connect GitHub", label: "Connected: GitHub connection",
      payload: { version: 1, serviceName: "GitHub" }, result: { version: 1, outcome: "connected" } },
    { kind: "connection_intent", status: "rejected", title: "Connect Slack", label: "Declined: Slack connection",
      payload: { version: 1, serviceName: "Slack" }, result: { version: 1, outcome: "declined" } },
  ] as const;

  async function seedDeliveredReceipt(
    c: (typeof deliveredReceiptCases)[number],
    delivering: "succeeded" | "running" | "failed" | "cancelled" | null,
    runContext: "response" | "card_creation" = "response",
  ) {
    const seeded = await seedQueue();
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    const interactionId = randomUUID();
    const resolvedAt = new Date("2026-08-22T15:05:00.000Z");
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId: seeded.companyId, issueId: seeded.issueId,
      kind: c.kind, status: c.status, createdByAgentId: seeded.agentId, sourceRunId: seeded.runId,
      resolvedByUserId: "queue-owner", resolvedAt,
      continuationPolicy: "wake_assignee", requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit",
      // Fixture payloads cover several interaction kinds; the schema types each kind separately.
      title: c.title, payload: c.payload as never, result: c.result as never,
    });
    const context = { issueId: seeded.issueId, interactionId, interactionKind: c.kind, interactionStatus: c.status };
    // The response's own wake already started a run that carries the answer.
    const deliveringRunId = randomUUID();
    if (delivering) {
      await db.insert(heartbeatRuns).values({
        id: deliveringRunId, companyId: seeded.companyId, agentId: seeded.agentId,
        invocationSource: "automation", triggerDetail: "system", status: delivering, runtimeMode: "native",
        startedAt: new Date("2026-08-22T15:05:01.000Z"),
        finishedAt: delivering === "running" ? null : new Date("2026-08-22T15:06:00.000Z"),
        // The card-creation wake carries the same interaction id while the
        // card is still pending, without a resolved status.
        contextSnapshot: runContext === "card_creation"
          ? { issueId: seeded.issueId, interactionId, interactionKind: c.kind, wakeReason: "interaction_pending" }
          : { ...context, source: "issue.interaction.respond", wakeReason: "issue_commented" },
      });
    }
    // The redundant continuation, still deferred behind the issue's active run.
    const staleWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: staleWakeId, companyId: seeded.companyId, agentId: seeded.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      status: "deferred_issue_execution", requestedByActorType: "system", requestedByActorId: "recovery",
      requestedAt: new Date("2026-08-22T15:05:02.000Z"),
      payload: { issueId: seeded.issueId, mutation: "interaction", interactionId, interactionStatus: c.status,
        _paperclipWakeContext: { ...context, source: "issue.interaction_continuation_recovery" } },
    });
    return { ...seeded, interactionId, staleWakeId, deliveringRunId };
  }

  it.each(deliveredReceiptCases.flatMap(c => (["succeeded", "running"] as const).map(delivering => ({ ...c, delivering }))))(
    "clears a $kind $status receipt once a $delivering run already delivered it",
    async (c) => {
      const seeded = await seedDeliveredReceipt(c, c.delivering);
      const client = app(seeded.companyId);
      const queue = await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
      expect(queue.body.entries.map((entry: { source?: { summary?: string } }) => entry.source?.summary)).toEqual([]);
    },
  );

  it.each(deliveredReceiptCases)("keeps a pending $kind $status receipt until a run delivers it", async (c) => {
    const seeded = await seedDeliveredReceipt(c, null);
    const queue = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.entries).toHaveLength(1);
    expect(queue.body.entries[0]).toMatchObject({
      source: { kind: "interaction", interactionId: seeded.interactionId, interactionKind: c.kind, summary: c.label },
      canEdit: false, canDiscard: false,
    });
  });

  it.each([
    { delivering: "failed", runContext: "response" },
    { delivering: "cancelled", runContext: "response" },
    { delivering: "succeeded", runContext: "card_creation" },
    { delivering: "running", runContext: "card_creation" },
  ] as const)("keeps a receipt owed after a $delivering $runContext run", async ({ delivering, runContext }) => {
    const seeded = await seedDeliveredReceipt(deliveredReceiptCases[0], delivering, runContext);
    const queue = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.entries.map((entry: { source?: { summary?: string } }) => entry.source?.summary))
      .toEqual(["Answered: Questions"]);
    expect(await hasQueuedInteractionResponse(db, seeded.companyId, seeded.issueId, seeded.agentId)).toBe(true);
  });

  // Approve = run: the tool already ran (or was declined) when its outcome wake
  // is deferred behind a later turn. That wake hands the recorded result to the
  // agent; it is not a message the person still has to send, so the composer
  // queue must not show it as "Accepted: Approve tool action".
  // The outcome delivery carries the tool action; a recovered continuation
  // carries only the interaction id, so the saved card must decide.
  it.each((["delivery", "recovery"] as const).flatMap(wakeShape => ([
    { status: "accepted", outcome: "executed", wakeShape },
    { status: "rejected", outcome: "rejected", wakeShape },
  ] as const)))("does not queue a $status tool action's outcome ($wakeShape wake) as a message", async ({ status, outcome, wakeShape }) => {
    const toolActionCase = {
      kind: "request_confirmation", status, title: "Approve tool action", label: `${status}`,
      payload: { version: 1, prompt: "Create the page?", toolAction: { toolName: "notebook_create_page", actionRequestId: randomUUID() } },
      result: { version: 1, outcome: status, toolAction: { executionStatus: outcome, resultSummary: "Page created" } },
    } as unknown as (typeof deliveredReceiptCases)[number];
    const seeded = await seedDeliveredReceipt(toolActionCase, null);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.staleWakeId));
    if (wakeShape === "delivery") {
      const toolAction = { toolName: "notebook_create_page", actionRequestId: randomUUID(), executionStatus: outcome };
      await db.update(agentWakeupRequests).set({ requestedByActorType: "user", requestedByActorId: "queue-owner",
        payload: { ...wake.payload, interactionKind: "request_confirmation", toolAction, toolActions: [toolAction],
          toolActionRequestIds: [toolAction.actionRequestId] } }).where(eq(agentWakeupRequests.id, seeded.staleWakeId));
    }
    const queue = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.entries).toEqual([]);
    // Hiding the row must not drop the outcome: the agent still receives it.
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.staleWakeId));
    expect(after.status).toBe("deferred_issue_execution");
    expect(await hasQueuedInteractionResponse(db, seeded.companyId, seeded.issueId, seeded.agentId)).toBe(true);
  });

  it("shows a later undelivered receipt instead of an earlier delivered one", async () => {
    const seeded = await seedDeliveredReceipt(deliveredReceiptCases[3], "succeeded");
    const pendingId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: pendingId, companyId: seeded.companyId, issueId: seeded.issueId,
      kind: "connection_intent", status: "rejected", createdByAgentId: seeded.agentId,
      resolvedByUserId: "queue-owner", resolvedAt: new Date("2026-08-22T15:10:00.000Z"),
      continuationPolicy: "wake_assignee", requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit",
      title: "Connect Slack", payload: { version: 1, serviceName: "Slack" } as never, result: { version: 1, outcome: "declined" } as never,
    });
    await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId, agentId: seeded.agentId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution", requestedAt: new Date("2026-08-22T16:00:00.000Z"),
      payload: { issueId: seeded.issueId, mutation: "interaction", interactionId: pendingId, interactionStatus: "rejected" },
    });
    const queue = await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`).expect(200);
    expect(queue.body.entries.map((entry: { source?: { summary?: string } }) => entry.source?.summary))
      .toEqual(["Declined: Slack connection"]);
  });

  it("does not hold agent handback for a receipt the agent already received", async () => {
    const pending = await seedDeliveredReceipt(deliveredReceiptCases[1], null);
    expect(await hasQueuedInteractionResponse(db, pending.companyId, pending.issueId, pending.agentId)).toBe(true);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    const delivered = await seedDeliveredReceipt(deliveredReceiptCases[1], "succeeded");
    expect(await hasQueuedInteractionResponse(db, delivered.companyId, delivered.issueId, delivered.agentId)).toBe(false);
  });

  it("promotes an approval after normal completion without a click", async () => {
    const seeded = await seedResponseQueue();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, seeded.issueId));
    await db.insert(heartbeatRuns).values({ companyId: seeded.companyId, agentId: seeded.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() } });
    await heartbeatService(db).resumeQueuedRuns();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake.status).toBe("queued");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.contextSnapshot).toMatchObject(seeded.context);
    await heartbeatService(db).resumeQueuedRuns();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(3);
  });

});
