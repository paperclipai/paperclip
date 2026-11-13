import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issueRecoveryActions, issueThreadInteractions, issues } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { heartbeatService } from "./heartbeat.js";
import { requestInterruptedNativeTurnRetry } from "./heartbeat/restart-interrupted-turn.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { taskInterruptionPresentation, taskInterruptionPresentations } from "./task-interruption-presentation.js";
import { pendingContinuationDecisionWaits } from "./explicit-native-continuation.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { reconcileRetainedWorkspaces } from "./workspace-recovery.js";
import { readTaskRetryIntent, requestTaskRetry } from "./task-retry.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { useWorkspaceRecoveryFixture, action, db, run, seed } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("a held task with a pending decision after its remote runner was lost", () => {
  useWorkspaceRecoveryFixture(targets);

  const shapes = {
    parkedQuestion: { wakeReason: "issue_assigned", turnEvents: ["turn.started", "turn.accepted"],
      kind: "ask_user_questions", fromFailedRun: true },
    olderConnectionRequest: { wakeReason: "issue_monitor_due", turnEvents: [],
      kind: "connection_intent", fromFailedRun: false },
  } as const;

  async function lostRunnerWithPendingDecision(shape: keyof typeof shapes) {
    const s = shapes[shape];
    const f = await seed("native");
    const original = await run(f.runId);
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: original.agentId,
      source: "automation", triggerDetail: "system", reason: s.wakeReason, status: "failed", runId: f.runId,
      finishedAt: new Date(), payload: { issueId: f.issueId } }).returning();
    await db.update(heartbeatRuns).set({ errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable", wakeupRequestId: wake.id, responsibleUserId: "local-board",
      startedAt: new Date(Date.now() - 20 * 60_000), contextSnapshot: { issueId: f.issueId, wakeReason: s.wakeReason },
    }).where(eq(heartbeatRuns.id, f.runId));
    for (const eventType of s.turnEvents)
      await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: original.agentId,
        eventType, stream: "system", level: "info", message: eventType });
    const [older] = s.fromFailedRun ? [] : await db.insert(heartbeatRuns).values({ companyId: f.companyId,
      agentId: original.agentId, issueId: f.issueId, status: "succeeded", createdAt: new Date(Date.now() - 2 * 86_400_000),
      finishedAt: new Date(Date.now() - 86_400_000), contextSnapshot: { issueId: f.issueId } }).returning();
    const [decision] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: s.kind, status: "pending", continuationPolicy: "wake_assignee", sourceRunId: older?.id ?? f.runId,
      createdByAgentId: original.agentId, title: "Which default should new agents get?",
      payload: { version: 1, questions: [{ id: "q1", prompt: "Which default?", selectionMode: "single",
        options: [{ id: "a", label: "Read only" }, { id: "b", label: "Full" }] }] } as never }).returning();
    const service = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: original.agentId, status: "running" });
    expect(await requestInterruptedNativeTurnRetry(db, f.runId)).toMatchObject({ requested: false });
    await vi.waitFor(async () => {
      await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, current => service.resumeRemoteStopComments(current)) ?? []);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    }, { timeout: 10_000, interval: 10 });
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    return { ...f, agentId: original.agentId, decision, service };
  }
  const queuedSuccessors = async (companyId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
  const deferredWaits = async (companyId: string) => (await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"))))
    .map(wake => (wake.payload?.executionWait as { reason?: string } | undefined)?.reason);
  type Decision = typeof issueThreadInteractions.$inferSelect;
  const resolve = (decision: Decision, resolvedBy: string) => db.update(issueThreadInteractions).set({ status: "answered",
    resolvedByUserId: resolvedBy, resolvedAt: new Date(), result: { version: 1, answers: [{ questionId: "q1", optionIds: ["a"] }] } as never })
    .where(eq(issueThreadInteractions.id, decision.id));
  const deliverAnswer = (f: Awaited<ReturnType<typeof lostRunnerWithPendingDecision>>, decision: Decision, userId: string) =>
    f.service.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, interactionId: decision.id, interactionKind: decision.kind,
        interactionStatus: "answered", sourceCommentId: null, sourceRunId: decision.sourceRunId, mutation: "interaction" },
      idempotencyKey: `interaction:${decision.id}:answered`,
      requestedByActorType: "user", requestedByActorId: userId,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, interactionId: decision.id,
        interactionKind: decision.kind, interactionStatus: "answered", sourceCommentId: null,
        sourceRunId: decision.sourceRunId, wakeReason: "issue_commented", source: "issue.interaction.resolve" },
    });
  const answer = async (f: Awaited<ReturnType<typeof lostRunnerWithPendingDecision>>, userId: string, resolvedBy = userId) => {
    await resolve(f.decision, resolvedBy);
    await deliverAnswer(f, f.decision, userId);
  };
  const dispatchContinuation = (f: Awaited<ReturnType<typeof lostRunnerWithPendingDecision>>, successor: typeof heartbeatRuns.$inferSelect) =>
    buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      runId: successor.id, context: successor.contextSnapshot ?? {}, summary: null, exposeLowTrustRaw: false });

  it.each(Object.keys(shapes) as Array<keyof typeof shapes>)("%s: Retry starts exactly one run after the sandbox work is saved", async shape => {
    const f = await lostRunnerWithPendingDecision(shape);
    const issue = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId, canRetry: true,
      runError: "runner_remote_process_identity_unavailable", workspaceRecovery: { status: "recovered" } });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true, observedRunId: f.runId });
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
    expect(receipt).toMatchObject({ accepted: true });
    await f.service.resumeTaskRetry(f.companyId, receipt.requestId!);
    expect({ successors: (await queuedSuccessors(f.companyId)).length, deferred: await deferredWaits(f.companyId) })
      .toEqual({ successors: 1, deferred: [] });
    const [successor] = await queuedSuccessors(f.companyId);
    expect(successor.contextSnapshot).toMatchObject({ previousRunId: f.runId, taskRetryRequestId: receipt.requestId, forceFreshSession: true });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.decision.id)))[0].status).toBe("pending");
  }, 60_000);

  it.each(Object.keys(shapes) as Array<keyof typeof shapes>)("%s: the person's answer to the pending decision continues the task", async shape => {
    const f = await lostRunnerWithPendingDecision(shape);
    await answer(f, "local-board");
    expect({ successors: (await queuedSuccessors(f.companyId)).length, deferred: await deferredWaits(f.companyId) })
      .toEqual({ successors: 1, deferred: [] });
    const [successor] = await queuedSuccessors(f.companyId);
    expect(successor.contextSnapshot).toMatchObject({ interactionId: f.decision.id, previousRunId: f.runId, forceFreshSession: true,
      explicitUserContinuation: { previousRunId: f.runId, commentId: null } });
    expect(await action(f.actionId)).toMatchObject({ status: "resolved",
      evidence: { explicitUserContinuation: { actorId: "local-board", interactionId: f.decision.id, previousRunId: f.runId } } });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "issue.execution_recovery_settled"), eq(activityLog.actorId, "local-board")))).toHaveLength(1);
    const envelope = await dispatchContinuation(f, successor);
    expect(envelope).toMatchObject({ trigger: { interactionId: f.decision.id }, interruptedRunId: f.runId });
    expect(envelope.interactionOutcomes).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.decision.id })]));
  }, 60_000);

  it("dispatches the first answer's successor after a second answer coalesces into it", async () => {
    const f = await lostRunnerWithPendingDecision("parkedQuestion");
    const [second] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee", sourceRunId: f.runId,
      createdByAgentId: f.agentId, title: "Which audit level?", payload: f.decision.payload }).returning();
    await resolve(f.decision, "local-board");
    await resolve(second, "local-board");
    await deliverAnswer(f, f.decision, "local-board");
    await deliverAnswer(f, second, "local-board");
    const successors = await queuedSuccessors(f.companyId);
    expect(successors).toHaveLength(1);
    const [secondWake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.idempotencyKey, `interaction:${second.id}:answered`)));
    expect(secondWake).toMatchObject({ status: "deferred_issue_execution", runId: null });
    for (const context of [successors[0].contextSnapshot ?? {},
      { ...successors[0].contextSnapshot, interactionId: second.id, interactionStatus: "answered" }]) {
      const envelope = await dispatchContinuation(f, { ...successors[0], contextSnapshot: context });
      expect(envelope.interactionOutcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: f.decision.id }), expect.objectContaining({ id: second.id })]));
    }
  }, 60_000);

  it.each([
    ["a plan review", "request_confirmation", { version: 1, prompt: "Approve the plan?", target: { type: "issue_document", key: "plan", revisionId: randomUUID() } }],
    ["a governed tool action", "request_confirmation", { version: 1, prompt: "Run it?", toolAction: { tool: "deploy" } }],
    ["a secret proposal", "request_confirmation", { version: 1, prompt: "Store it?", secretProposal: { name: "TOKEN" } }],
    ["a connection authorization", "connection_intent", { version: 1, serviceName: "Sentry", connectionAuthorization: { scope: "read" } }],
  ])("keeps Retry on hold while %s is pending", async (_label, kind, payload) => {
    const f = await lostRunnerWithPendingDecision("parkedQuestion");
    await db.update(issueThreadInteractions).set({ kind, payload: payload as never })
      .where(eq(issueThreadInteractions.id, f.decision.id));
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
    await f.service.resumeTaskRetry(f.companyId, receipt.requestId!);
    expect({ successors: (await queuedSuccessors(f.companyId)).length, deferred: await deferredWaits(f.companyId) })
      .toEqual({ successors: 0, deferred: ["decision_pending"] });
  }, 60_000);

  it("lets a new message supersede a plain question and continue the task", async () => {
    const f = await lostRunnerWithPendingDecision("parkedQuestion");
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "local-board", body: "Please continue." }).returning();
    await f.service.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" },
      requestedByActorType: "user", requestedByActorId: "local-board",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented", wakeCommentId: comment.id },
    });
    expect({ successors: (await queuedSuccessors(f.companyId)).length, deferred: await deferredWaits(f.companyId) })
      .toEqual({ successors: 1, deferred: [] });
  }, 60_000);

  it("keeps a new message waiting while a plan review is pending", async () => {
    const f = await lostRunnerWithPendingDecision("parkedQuestion");
    await db.update(issueThreadInteractions).set({ kind: "request_confirmation",
      payload: { version: 1, prompt: "Approve the plan?", target: { type: "issue_document", key: "plan", revisionId: randomUUID() } } as never })
      .where(eq(issueThreadInteractions.id, f.decision.id));
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "local-board", body: "Please continue." }).returning();
    await f.service.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" },
      requestedByActorType: "user", requestedByActorId: "local-board",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented", wakeCommentId: comment.id },
    });
    expect({ successors: (await queuedSuccessors(f.companyId)).length, deferred: await deferredWaits(f.companyId) })
      .toEqual({ successors: 0, deferred: ["decision_pending"] });
  }, 60_000);

  it("keeps the hold when the wake's user did not give the answer", async () => {
    const f = await lostRunnerWithPendingDecision("parkedQuestion");
    await answer(f, "other-user", "local-board");
    expect(await queuedSuccessors(f.companyId)).toHaveLength(0);
    expect(await deferredWaits(f.companyId)).toEqual(["execution_recovery"]);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].evidence)
      .not.toHaveProperty("explicitUserContinuation");
  }, 60_000);
  describe("a Retry held on a confirmation the person resolves", () => {
    const heldOnConfirmation = async () => {
      const f = await lostRunnerWithPendingDecision("parkedQuestion");
      await db.update(issueThreadInteractions).set({ kind: "request_confirmation",
        payload: { version: 1, prompt: "Review sidebar subtask screenshots" } as never })
        .where(eq(issueThreadInteractions.id, f.decision.id));
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
        actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
      await f.service.resumeTaskRetry(f.companyId, receipt.requestId!);
      expect({ successors: (await queuedSuccessors(f.companyId)).length, deferred: await deferredWaits(f.companyId) })
        .toEqual({ successors: 0, deferred: ["decision_pending"] });
      return { ...f, requestId: receipt.requestId! };
    };
    const savedResolution = (f: Awaited<ReturnType<typeof heldOnConfirmation>>) =>
      db.update(issueThreadInteractions).set({ status: "rejected", resolvedByUserId: "local-board", resolvedAt: new Date(),
        result: { version: 1, outcome: "rejected", reason: "what" } as never })
        .where(eq(issueThreadInteractions.id, f.decision.id));
    const currentIssue = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    const retryReceipt = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0];

    it.each(["accept", "reject"] as const)("releases the held Retry as soon as the person chooses %s", async choice => {
      const f = await heldOnConfirmation();
      const interactions = issueThreadInteractionService(db);
      const issue = await currentIssue(f.issueId);
      if (choice === "accept") await interactions.acceptInteraction(issue, f.decision.id, {}, { userId: "local-board" });
      else await interactions.rejectInteraction(issue, f.decision.id, { reason: "what" }, { userId: "local-board" });
      expect((await retryReceipt(f.requestId)).payload).not.toHaveProperty("executionWait");
      expect(await deferredWaits(f.companyId)).not.toContain("decision_pending");
      await f.service.resumeTaskRetry(f.companyId, f.requestId);
      const [successor] = await queuedSuccessors(f.companyId);
      expect(successor?.contextSnapshot).toMatchObject({ previousRunId: f.runId, taskRetryRequestId: f.requestId });
    }, 60_000);

    it("accepts the confirmation while the held Retry is admitted, without either aborting", async () => {
      const f = await heldOnConfirmation();
      const issue = await currentIssue(f.issueId);
      const outcomes = await Promise.allSettled([
        issueThreadInteractionService(db).acceptInteraction(issue, f.decision.id, {}, { userId: "local-board" }),
        f.service.resumeTaskRetry(f.companyId, f.requestId),
        f.service.resumeTaskRetry(f.companyId, f.requestId),
      ]);
      expect(outcomes.filter(outcome => outcome.status === "rejected")).toEqual([]);
      await f.service.resumeTaskRetry(f.companyId, f.requestId);
      expect({ successors: (await queuedSuccessors(f.companyId)).length, deferred: await deferredWaits(f.companyId) })
        .toEqual({ successors: 1, deferred: [] });
    }, 60_000);

    it("never shows a resolved confirmation as the Retry's wait, and both projections offer the same Retry", async () => {
      const f = await heldOnConfirmation();
      await savedResolution(f);
      await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 5 * 60_000) })
        .where(eq(agentWakeupRequests.id, f.requestId));
      const interruption = await taskInterruptionPresentation(db, await currentIssue(f.issueId));
      const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
      expect(interruption).toMatchObject({ state: "failed", canRetry: true });
      expect(interruption?.retryWait).toBeUndefined();
      expect(blocker?.canRetry).toBe(interruption?.canRetry);
    }, 60_000);

    it("a person's comment starts work and settles the held Retry once nothing is left to answer", async () => {
      const f = await heldOnConfirmation();
      await savedResolution(f);
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: "local-board", body: "answer me" }).returning();
      await f.service.wakeup(f.agentId, {
        source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" },
        requestedByActorType: "user", requestedByActorId: "local-board",
        contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented", wakeCommentId: comment.id },
      });
      expect({ successors: (await queuedSuccessors(f.companyId)).length, deferred: await deferredWaits(f.companyId) })
        .toEqual({ successors: 1, deferred: [] });
      expect(await retryReceipt(f.requestId)).toMatchObject({ status: "skipped", error: "task_retry_superseded" });
    }, 60_000);

    it("starts a Retry at once when the confirmation was already open before the failed turn started", async () => {
      const f = await lostRunnerWithPendingDecision("parkedQuestion");
      const failed = await run(f.runId);
      await db.update(issueThreadInteractions).set({ kind: "request_confirmation",
        payload: { version: 1, prompt: "Review sidebar subtask screenshots" } as never,
        createdAt: new Date(failed.createdAt.getTime() - 6 * 60_000) })
        .where(eq(issueThreadInteractions.id, f.decision.id));
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
        actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
      await f.service.resumeTaskRetry(f.companyId, receipt.requestId!);
      expect({ successors: (await queuedSuccessors(f.companyId)).length, deferred: await deferredWaits(f.companyId) })
        .toEqual({ successors: 1, deferred: [] });
    }, 60_000);

    it("reads every saved decision wait on a task list in one bounded query", async () => {
      const f = await heldOnConfirmation();
      const source = await currentIssue(f.issueId);
      const listed = await db.insert(issues).values(Array.from({ length: 40 }, (_, index) => ({
        ...source, id: randomUUID(), identifier: `${source.identifier}-${index}`, issueNumber: (source.issueNumber ?? 0) + 1000 + index,
        executionRunId: null, checkoutRunId: null,
      }))).returning();
      await db.insert(agentWakeupRequests).values(listed.map(issue => ({ companyId: f.companyId, agentId: f.agentId,
        source: "automation", triggerDetail: "system", reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: "local-board",
        payload: { issueId: issue.id, executionWait: { reason: "decision_pending", message: "held" } } })));
      const open = listed.slice(0, 20);
      await db.insert(issueThreadInteractions).values(open.map(issue => ({ companyId: f.companyId, issueId: issue.id,
        kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee", createdByAgentId: f.agentId,
        payload: { version: 1, prompt: "Review it?" } as never })));
      const statements: string[] = [];
      const client = db.$client.options;
      const previous = client.debug;
      client.debug = (_connection, query) => { if (query.includes("issue_thread_interactions")) statements.push(query); };
      try {
        await taskInterruptionPresentations(db, f.companyId, [source, ...listed]);
      } finally { client.debug = previous; }
      expect(statements.length).toBeLessThanOrEqual(2);
      const waits = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")));
      const held = await pendingContinuationDecisionWaits(db, f.companyId, waits.map(wait => ({ id: wait.id,
        issueId: String(wait.payload?.issueId), actorId: wait.requestedByActorId!,
        taskRetrySourceRunId: readTaskRetryIntent(wait.payload)?.sourceRunId ?? null })));
      const heldIssues = new Set(waits.filter(wait => held.has(wait.id)).map(wait => String(wait.payload?.issueId)));
      expect(heldIssues).toEqual(new Set([f.issueId, ...open.map(issue => issue.id)]));
    }, 60_000);
  });
});
