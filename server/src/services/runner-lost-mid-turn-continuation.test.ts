import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { heartbeatService } from "./heartbeat.js";
import { requestInterruptedNativeTurnRetry, requestRestartInterruptedTurnRetry } from "./heartbeat/restart-interrupted-turn.js";
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

  async function runnerLostMidTurn(input: { wake: "user" | "user_retry" | "system_retry" | "system_monitor";
    refusal?: "process_not_running" | "process_identity_changed" | null;
    events?: string[]; refusalPayload?: Record<string, unknown> }) {
    const f = await seed("native");
    const original = await run(f.runId);
    const system = input.wake !== "user" && input.wake !== "user_retry";
    const reason = input.wake === "user" ? "issue_assigned" : input.wake === "user_retry" ? "task_retry"
      : input.wake === "system_retry" ? "transient_failure_retry" : "issue_monitor_due";
    const [retryIntent] = input.wake === "user_retry" ? await db.insert(agentWakeupRequests).values({ companyId: f.companyId,
      agentId: original.agentId, source: "on_demand", triggerDetail: "manual", reason: "task_retry", status: "completed",
      idempotencyKey: `task-retry:${randomUUID()}`, requestedByActorType: "user", requestedByActorId: "local-board",
      payload: { issueId: f.issueId } }).returning() : [];
    const [predecessor] = input.wake === "system_retry" ? await db.insert(heartbeatRuns).values({ companyId: f.companyId,
      agentId: original.agentId, issueId: f.issueId, status: "failed", createdAt: new Date(Date.now() - 60 * 60_000),
      finishedAt: new Date(Date.now() - 50 * 60_000),
      errorCode: "environment_provider_unavailable", contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } }).returning() : [];
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: original.agentId,
      source: system ? "automation" : "assignment", triggerDetail: "system", reason, status: "failed", runId: f.runId,
      requestedByActorType: system ? "system" : "user", requestedByActorId: system ? null : "local-board",
      finishedAt: new Date(), payload: { issueId: f.issueId } }).returning();
    await db.update(heartbeatRuns).set({ errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable", wakeupRequestId: wake.id, responsibleUserId: "local-board",
      retryOfRunId: predecessor?.id ?? null, startedAt: new Date(Date.now() - 45 * 60_000),
      contextSnapshot: { issueId: f.issueId, wakeReason: reason, ...(retryIntent ? { taskRetryRequestId: retryIntent.id,
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

  it.each([
    { title: "the refusal did not prove the Runner process gone", wake: "user" as const, refusal: "process_identity_changed" as const,
      reason: "provider_turn_unsettled" },
    { title: "no reattachment refusal was recorded", wake: "user" as const, refusal: null, reason: "provider_turn_unsettled" },
    { title: "the source was a monitor wake, not a retry of owed work", wake: "system_monitor" as const, refusal: "process_not_running" as const,
      reason: "not_user_request" },
  ])("keeps the visible Retry and records nothing when $title", async ({ wake, refusal, reason }) => {
    const f = await runnerLostMidTurn({ wake, refusal });
    expect(await requestRestartInterruptedTurnRetry(db, f.claim)).toEqual({ requested: false, reason });
    expect(await unknownOutcomeEvents(f.runId)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.reason, "task_retry")))).toHaveLength(0);
  }, 30_000);
});
