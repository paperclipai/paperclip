import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { agentWakeupRequests, chatConversations, chatEndpoints, heartbeatRunEvents, heartbeatRuns, issueComments,
  toolApplications, toolConnections } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { heartbeatService } from "./heartbeat.js";
import { registerInterruptedTurnChatRetry, requestInterruptedNativeTurnRetry, requestRestartInterruptedTurnRetry }
  from "./heartbeat/restart-interrupted-turn.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { reconcileRetainedWorkspaces } from "./workspace-recovery.js";
import { useWorkspaceRecoveryFixture, action, db, run, seed } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

const TURN_ID = "01a1cdcb-8c83-7221-b602-d80d515d1616";

/** The refusal the previous release recorded on staging, byte for byte in shape. */
const stagingRefusal = (reason: "process_not_running" | "process_identity_changed" = "process_not_running") => ({
  remoteRunnerRecovery: { stage: "process_verification", reason,
    ...(reason === "process_not_running" ? { runnerSettled: true, runnerLifecycle: "ready",
      runnerDiagnostics: ["WebSocket peer closed the connection"], runnerExitEvidence: "== runnerd.process-stderr.log" } : {}) },
});

describe("a remote Runner that died in the middle of a provider turn", () => {
  useWorkspaceRecoveryFixture(targets);

  async function runnerLostMidTurn(input: { wake: "user" | "user_retry" | "system_retry" | "system_monitor"
      | "system_assignment" | "system_chat" | "user_chat";
    refusal?: "process_not_running" | "process_identity_changed" | null;
    chatMessage?: "present" | "deleted" | "written_by_run";
    events?: string[]; refusalPayload?: Record<string, unknown> }) {
    const f = await seed("native");
    const original = await run(f.runId);
    const system = input.wake !== "user" && input.wake !== "user_retry" && input.wake !== "user_chat";
    const chat = input.wake === "system_chat" || input.wake === "user_chat";
    const reason = input.wake === "user" || input.wake === "system_assignment" ? "issue_assigned"
      : input.wake === "user_retry" ? "task_retry"
      : chat ? "External chat message received"
      : input.wake === "system_retry" ? "transient_failure_retry" : "issue_monitor_due";
    // The chat bridge stores the inbound message as a task comment before it wakes the agent.
    const [chatComment] = chat ? await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      body: "Can you also check the release notes?", authorType: "system",
      ...(input.chatMessage === "deleted" ? { deletedAt: new Date() } : {}),
      ...(input.chatMessage === "written_by_run" ? { createdByRunId: f.runId } : {}) }).returning() : [];
    const [retryIntent] = input.wake === "user_retry" ? await db.insert(agentWakeupRequests).values({ companyId: f.companyId,
      agentId: original.agentId, source: "on_demand", triggerDetail: "manual", reason: "task_retry", status: "completed",
      idempotencyKey: `task-retry:${randomUUID()}`, requestedByActorType: "user", requestedByActorId: "local-board",
      payload: { issueId: f.issueId } }).returning() : [];
    const [predecessor] = input.wake === "system_retry" ? await db.insert(heartbeatRuns).values({ companyId: f.companyId,
      agentId: original.agentId, issueId: f.issueId, status: "failed", createdAt: new Date(Date.now() - 60 * 60_000),
      finishedAt: new Date(Date.now() - 50 * 60_000),
      errorCode: "environment_provider_unavailable", contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } }).returning() : [];
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: original.agentId,
      source: system && input.wake !== "system_assignment" && !chat ? "automation" : "assignment", triggerDetail: "system",
      reason, status: "failed", runId: f.runId,
      requestedByActorType: system ? "system" : "user", requestedByActorId: system ? null : "local-board",
      finishedAt: new Date(), payload: { issueId: f.issueId, ...(chatComment ? { commentId: chatComment.id } : {}) } }).returning();
    await db.update(heartbeatRuns).set({ errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable", wakeupRequestId: wake.id, responsibleUserId: "local-board",
      retryOfRunId: predecessor?.id ?? null, startedAt: new Date(Date.now() - 45 * 60_000),
      contextSnapshot: { issueId: f.issueId, wakeReason: reason,
        ...(chatComment ? { wakeCommentId: chatComment.id, commentId: chatComment.id, wakeSource: "assignment" } : {}),
        ...(retryIntent ? { taskRetryRequestId: retryIntent.id,
        forceFreshSession: true } : {}), ...(predecessor ? { retryOfRunId: predecessor.id,
        retryReason: "transient_failure", scheduledRetryAttempt: 1 } : {}) },
    }).where(eq(heartbeatRuns.id, f.runId));
    for (const eventType of input.events ?? ["turn.submitted", "turn.started", "tool.execution.started", "turn.accepted", "tool.execution.completed"])
      await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: original.agentId,
        eventType, stream: "system", level: "info", message: eventType,
        payload: { prpEvent: { eventType, turnId: TURN_ID, payload: {} } } });
    if (input.refusal !== null) await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId,
      agentId: original.agentId, eventType: "native.remote_runner_recovery_failed", stream: "system", level: "error",
      message: "Could not verify the existing remote runner.", payload: input.refusalPayload ?? stagingRefusal(input.refusal) });
    const claim = { kind: "reattach_remote_runner" as const, runId: f.runId, leaseOwner: `boot:2:${randomUUID()}`,
      controllerGeneration: 2, providerAttempt: 1, restartKind: "hard" as const, recoveryRequestId: null,
      remote: { providerLeaseId: f.providerLeaseId, remoteCwd: f.remote } };
    const service = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    // Keep the agent's only slot busy so a successor stays observable as queued.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: original.agentId, status: "running" });
    return { ...f, agentId: original.agentId, claim, service, retryIntent };
  }
  const queued = async (companyId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
  const unknownOutcomeEvents = async (runId: string) => db.select().from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, "native.interrupted_turn_outcome_unknown")));

  // Staging: a deploy detached the controller, the restart's reattachment then
  // found the Runner process gone with a turn in flight. The previous release
  // recorded `process_not_running` and the task waited for a person.
  it.each([
    { title: "a user's assignment", wake: "user" as const, viaClaim: true },
    { title: "an automatic retry of the assignment (the staging shape)", wake: "system_retry" as const, viaClaim: true },
    { title: "a same-run retry of a user's assignment", wake: "user" as const, viaClaim: false },
    // Staging after the upgrade fix: a routine's system assignment and an
    // external chat message, neither a retry, stayed blocked for a person.
    { title: "a routine's system assignment", wake: "system_assignment" as const, viaClaim: true },
    { title: "an external chat message from an unlinked sender", wake: "system_chat" as const, viaClaim: true },
    { title: "an external chat message from a linked person", wake: "user_chat" as const, viaClaim: false },
  ])("continues $title once in a fresh session and records that the turn's outcome is unknown", async ({ wake, viaClaim }) => {
    const f = await runnerLostMidTurn({ wake });
    const request = () => viaClaim ? requestRestartInterruptedTurnRetry(db, f.claim) : requestInterruptedNativeTurnRetry(db, f.runId);
    expect(await request()).toEqual({ requested: true, requestId: expect.any(String) });
    expect(await request()).toMatchObject({ requested: true });
    const recorded = await unknownOutcomeEvents(f.runId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ level: "warn", payload: { turnId: TURN_ID, replayed: false,
      runnerExit: { stage: "process_verification", reason: "process_not_running", runnerLifecycle: "ready" } } });
    await vi.waitFor(async () => {
      await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, current => f.service.resumeRemoteStopComments(current)) ?? []);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    }, { timeout: 10_000, interval: 10 });
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    await vi.waitFor(async () => expect(await queued(f.companyId)).toHaveLength(1), { timeout: 10_000, interval: 50 });
    const [successor] = await queued(f.companyId);
    expect(successor.contextSnapshot).toMatchObject({ previousRunId: f.runId, wakeReason: "task_retry", forceFreshSession: true });
    const retries = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.reason, "task_retry")));
    expect(retries.filter(retry => retry.idempotencyKey?.startsWith("task-retry:"))).toEqual([expect.objectContaining({
      idempotencyKey: `task-retry:restart-interrupted-turn:${f.runId}`, requestedByActorType: "user", requestedByActorId: "local-board" })]);
  }, 30_000);

  it("continues a person's Retry whose turn start timed out and whose Runner was gone at the same-run reattachment", async () => {
    const f = await runnerLostMidTurn({ wake: "user_retry", events: ["turn.submitted"], refusalPayload: {
      remoteRunnerRecovery: { stage: "process_verification", reason: "process_not_running", runnerSettled: false,
        runnerLifecycle: "ready", runnerDiagnostics: ["WebSocket peer closed the connection"], providerTurnIssued: false,
        runnerExitEvidence: "== runnerd.process-stderr.log" } } });
    expect(await requestInterruptedNativeTurnRetry(db, f.runId)).toEqual({ requested: true, requestId: expect.any(String) });
    expect(await requestInterruptedNativeTurnRetry(db, f.runId)).toMatchObject({ requested: true });
    expect(await unknownOutcomeEvents(f.runId)).toEqual([expect.objectContaining({ payload: expect.objectContaining({
      lastTurnEvent: "turn.submitted", replayed: false }) })]);
    await vi.waitFor(async () => {
      await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, current => f.service.resumeRemoteStopComments(current)) ?? []);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    }, { timeout: 10_000, interval: 10 });
    await vi.waitFor(async () => expect(await queued(f.companyId)).toHaveLength(1), { timeout: 10_000, interval: 50 });
    const [successor] = await queued(f.companyId);
    expect(successor.contextSnapshot).toMatchObject({ previousRunId: f.runId, wakeReason: "task_retry", forceFreshSession: true });
    const retries = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.reason, "task_retry")));
    expect(retries.filter(retry => retry.id !== f.retryIntent!.id && retry.idempotencyKey?.startsWith("task-retry:"))).toEqual([
      expect.objectContaining({ idempotencyKey: `task-retry:restart-interrupted-turn:${f.runId}`, requestedByActorId: "local-board" })]);
  }, 30_000);

  it.each([
    { title: "inherits the hook's Retry intent", inherit: true },
    { title: "reaches the hook's Retry run through its retry chain", inherit: false },
  ])("gives no second automatic Retry to a system retry that $title and then lost its Runner mid-turn", async ({ inherit }) => {
    const f = await runnerLostMidTurn({ wake: "system_retry" });
    const current = await run(f.runId);
    const [hookIntent] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", triggerDetail: "manual", reason: "task_retry", status: "completed",
      idempotencyKey: `task-retry:restart-interrupted-turn:${randomUUID()}`, requestedByActorType: "user",
      requestedByActorId: "local-board", payload: { issueId: f.issueId } }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...current.contextSnapshot, wakeReason: "task_retry",
      taskRetryRequestId: hookIntent.id } }).where(eq(heartbeatRuns.id, current.retryOfRunId!));
    if (inherit) await db.update(heartbeatRuns).set({ contextSnapshot: { ...current.contextSnapshot,
      taskRetryRequestId: hookIntent.id } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await requestRestartInterruptedTurnRetry(db, f.claim)).toEqual({ requested: false, reason: "automatic_retry_used" });
    expect(await unknownOutcomeEvents(f.runId)).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.reason, "task_retry")))).filter(retry => retry.id !== hookIntent.id)).toHaveLength(0);
  }, 30_000);

  describe("an automatic continuation that the next deploy interrupted", () => {
    async function deployDuringRun(f: { companyId: string; runId: string; agentId: string }) {
      for (const [message, payload] of [
        ["Server shutdown suspended native controller ownership without cancelling provider work", { signal: "SIGTERM",
          processPid: 1048, restartKind: "graceful", processGroupId: null, retryRunCreated: false,
          processStartedAt: "2026-11-13T05:28:12.307Z", runnerDisposition: "awaiting_runner_reattach" }],
        ["Recovering the existing native runner process after server restart", { restartKind: "hard", providerAttempt: 2,
          recoveryRequestId: null, runnerDisposition: "reattach_remote_runner", controllerGeneration: 3 }],
        ["Reattaching to the existing remote runner to resume this run", { trigger: "same_run_retry", restartKind: "hard",
          providerAttempt: 3, recoveryRequestId: null, runnerDisposition: "reattach_remote_runner", controllerGeneration: 4 }],
      ] as const) await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: f.agentId,
        eventType: "native.recovery.transition", stream: "system", level: "info", message, payload });
    }

    async function automaticContinuation(input: { deploy: boolean; earlierContinuations?: number; systemRetries?: boolean }) {
      const f = await runnerLostMidTurn({ wake: "user_retry", events: ["turn.submitted"], refusalPayload: {
        remoteRunnerRecovery: { stage: "process_verification", reason: "process_not_running", runnerSettled: false,
          runnerLifecycle: "ready", runnerDiagnostics: ["WebSocket peer closed the connection"],
          runnerExitEvidence: "== runnerd.process-stderr.log" } } });
      let previousRunId: string | null = null;
      for (let index = 0; index <= (input.earlierContinuations ?? 0); index += 1) {
        const [lost]: Array<typeof heartbeatRuns.$inferSelect> = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
          status: "failed", runtimeMode: "native", error: "runner_remote_process_identity_unavailable",
          createdAt: new Date(Date.now() - (120 - index) * 60_000), finishedAt: new Date(Date.now() - (110 - index) * 60_000),
          errorCode: "native_continuation_requires_reconciliation", contextSnapshot: { issueId: f.issueId,
            wakeReason: index === 0 ? "issue_assigned" : "task_retry", ...(previousRunId ? { previousRunId } : {}) } }).returning();
        if (previousRunId) {
          const [hookIntent]: Array<typeof agentWakeupRequests.$inferSelect> = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
            source: "on_demand", triggerDetail: "manual", reason: "task_retry", status: "completed",
            idempotencyKey: `task-retry:restart-interrupted-turn:${previousRunId}`, requestedByActorType: "user",
            requestedByActorId: "local-board", payload: { issueId: f.issueId } }).returning();
          await db.update(heartbeatRuns).set({ contextSnapshot: { ...lost.contextSnapshot, taskRetryRequestId: hookIntent.id } })
            .where(eq(heartbeatRuns.id, lost.id));
          if (input.systemRetries) {
            const [systemRetry]: Array<typeof heartbeatRuns.$inferSelect> = await db.insert(heartbeatRuns).values({
              companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, status: "failed", runtimeMode: "native",
              retryOfRunId: lost.id, error: "runner_remote_process_identity_unavailable",
              createdAt: new Date(Date.now() - (120 - index) * 60_000 + 30_000),
              finishedAt: new Date(Date.now() - (110 - index) * 60_000 + 30_000),
              errorCode: "native_continuation_requires_reconciliation", contextSnapshot: { issueId: f.issueId,
                wakeReason: "transient_failure_retry", taskRetryRequestId: hookIntent.id, retryOfRunId: lost.id } }).returning();
            previousRunId = systemRetry.id;
            continue;
          }
        }
        previousRunId = lost.id;
      }
      await db.update(agentWakeupRequests).set({ idempotencyKey: `task-retry:restart-interrupted-turn:${previousRunId}` })
        .where(eq(agentWakeupRequests.id, f.retryIntent!.id));
      const current = await run(f.runId);
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...current.contextSnapshot, previousRunId } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (input.deploy) await deployDuringRun(f);
      return f;
    }

    it("continues again in a fresh session when a deploy took the continuation's Runner mid-turn", async () => {
      const f = await automaticContinuation({ deploy: true });
      expect(await requestRestartInterruptedTurnRetry(db, f.claim)).toEqual({ requested: true, requestId: expect.any(String) });
      expect(await requestInterruptedNativeTurnRetry(db, f.runId)).toMatchObject({ requested: true });
      expect(await unknownOutcomeEvents(f.runId)).toEqual([expect.objectContaining({ payload: expect.objectContaining({
        lastTurnEvent: "turn.submitted", replayed: false }) })]);
      await vi.waitFor(async () => {
        await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, current => f.service.resumeRemoteStopComments(current)) ?? []);
        expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
      }, { timeout: 10_000, interval: 10 });
      await vi.waitFor(async () => expect(await queued(f.companyId)).toHaveLength(1), { timeout: 10_000, interval: 50 });
      const [successor] = await queued(f.companyId);
      expect(successor.contextSnapshot).toMatchObject({ previousRunId: f.runId, wakeReason: "task_retry", forceFreshSession: true });
      const retries = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.idempotencyKey, `task-retry:restart-interrupted-turn:${f.runId}`)));
      expect(retries).toEqual([expect.objectContaining({ requestedByActorType: "user", requestedByActorId: "local-board" })]);
    }, 30_000);

    it("continues a system retry of owed work that inherited the continuation when a deploy took its Runner", async () => {
      const f = await runnerLostMidTurn({ wake: "system_retry" });
      const current = await run(f.runId);
      const [hookIntent] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
        source: "on_demand", triggerDetail: "manual", reason: "task_retry", status: "completed",
        idempotencyKey: `task-retry:restart-interrupted-turn:${randomUUID()}`, requestedByActorType: "user",
        requestedByActorId: "local-board", payload: { issueId: f.issueId } }).returning();
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...current.contextSnapshot, taskRetryRequestId: hookIntent.id } })
        .where(eq(heartbeatRuns.id, f.runId));
      await deployDuringRun(f);
      expect(await requestRestartInterruptedTurnRetry(db, f.claim)).toEqual({ requested: true, requestId: expect.any(String) });
      expect(await unknownOutcomeEvents(f.runId)).toHaveLength(1);
    }, 30_000);

    it("never runs out when only deploys interrupted a long chain whose system retries inherit each continuation", async () => {
      const f = await automaticContinuation({ deploy: true, earlierContinuations: 12, systemRetries: true });
      expect(await requestRestartInterruptedTurnRetry(db, f.claim)).toEqual({ requested: true, requestId: expect.any(String) });
      expect(await unknownOutcomeEvents(f.runId)).toHaveLength(1);
    }, 30_000);

    it.each([
      { title: "no deploy interrupted it", earlierContinuations: 0 },
      { title: "no deploy interrupted it after earlier deploy continuations", earlierContinuations: 4 },
    ])("keeps the visible Retry when $title", async ({ earlierContinuations }) => {
      const f = await automaticContinuation({ deploy: false, earlierContinuations, systemRetries: true });
      expect(await requestRestartInterruptedTurnRetry(db, f.claim)).toEqual({ requested: false, reason: "automatic_retry_used" });
      expect(await unknownOutcomeEvents(f.runId)).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.idempotencyKey, `task-retry:restart-interrupted-turn:${f.runId}`)))).toHaveLength(0);
    }, 30_000);
  });

  // The staging chat task runs through a connected Slack conversation, whose
  // endpoint restricts external execution: its Retry goes through the chat service.
  describe("an external chat message in a connected conversation", () => {
    async function connectConversation(f: { companyId: string; issueId: string; agentId: string }) {
      const [application] = await db.insert(toolApplications).values({ companyId: f.companyId, name: "Slack", type: "chat" }).returning();
      const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
        name: "Slack", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
      const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.companyId, connectionId: connection.id,
        provider: "slack", publicId: randomUUID(), assignedAgentId: f.agentId, status: "active" }).returning();
      expect(endpoint.externalExecutionPolicy).toBe("restricted");
      await db.insert(chatConversations).values({ companyId: f.companyId, endpointId: endpoint.id, issueId: f.issueId,
        externalConversationId: "channel", externalThreadId: randomUUID(), externalLabel: "#work", state: "waiting" });
    }

    it("continues through the chat service's Retry", async () => {
      const f = await runnerLostMidTurn({ wake: "system_chat" });
      await connectConversation(f);
      const actionId = randomUUID();
      const prepared: Array<{ failedRunId: string; initiatedByUserId: string }> = [];
      registerInterruptedTurnChatRetry(async (_tx, scope) => { prepared.push(scope); return { actionId }; });
      try {
        const outcome = await requestRestartInterruptedTurnRetry(db, f.claim);
        expect(outcome).toEqual({ requested: true, requestId: expect.any(String) });
        expect(prepared).toEqual([expect.objectContaining({ failedRunId: f.runId, initiatedByUserId: "local-board" })]);
        const [retry] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,
          (outcome as { requestId: string }).requestId));
        expect(retry.payload).toMatchObject({ taskRetry: { chatActionId: actionId } });
        expect(await unknownOutcomeEvents(f.runId)).toHaveLength(1);
      } finally { registerInterruptedTurnChatRetry(undefined); }
    }, 30_000);

    it("keeps the visible Retry when the chat service is not available", async () => {
      const f = await runnerLostMidTurn({ wake: "system_chat" });
      await connectConversation(f);
      expect(await requestRestartInterruptedTurnRetry(db, f.claim)).toEqual({ requested: false, reason: "retry_refused" });
    }, 30_000);
  });

  it.each([
    { title: "the refusal did not prove the Runner process gone", wake: "user" as const, refusal: "process_identity_changed" as const,
      reason: "provider_turn_unsettled" },
    { title: "no reattachment refusal was recorded", wake: "user" as const, refusal: null, reason: "provider_turn_unsettled" },
    { title: "the source was a monitor wake, not a retry of owed work", wake: "system_monitor" as const, refusal: "process_not_running" as const,
      reason: "not_user_request" },
    { title: "a system chat wake's message was deleted", wake: "system_chat" as const, refusal: "process_not_running" as const,
      chatMessage: "deleted" as const, reason: "not_user_request" },
    { title: "a system chat wake's message was written by a run", wake: "system_chat" as const,
      refusal: "process_not_running" as const, chatMessage: "written_by_run" as const, reason: "not_user_request" },
    { title: "a linked person's chat message was deleted", wake: "user_chat" as const, refusal: "process_not_running" as const,
      chatMessage: "deleted" as const, reason: "message_unavailable" },
    { title: "a system assignment's Runner was not proven gone", wake: "system_assignment" as const,
      refusal: "process_identity_changed" as const, reason: "provider_turn_unsettled" },
  ])("keeps the visible Retry and records nothing when $title", async ({ wake, refusal, reason, ...rest }) => {
    const f = await runnerLostMidTurn({ wake, refusal, chatMessage: "chatMessage" in rest ? rest.chatMessage : undefined });
    expect(await requestRestartInterruptedTurnRetry(db, f.claim)).toEqual({ requested: false, reason });
    expect(await unknownOutcomeEvents(f.runId)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.reason, "task_retry")))).toHaveLength(0);
  }, 30_000);
});
