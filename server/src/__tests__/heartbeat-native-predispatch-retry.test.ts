import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { activityLog, agents, authUsers, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns, issueComments,
  issueRecoveryActions, issues } from "@paperclipai/db";
import { NativePredecessorRetirementUnprovenError } from "../services/native-runtime/predecessor-retirement.js";
import { NativeProviderArtifactTransferTimeoutError } from "../services/native-runtime/native-provider-artifacts.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { describe, expect, it, vi } from "vitest";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { closeIdleWarmNativeSessionsForRestart, scopedRunnerdStateRoot } from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

// Budget admission is the last database write before the dispatch gate enters
// the native executor. Exhausted serialization retries there fail the run with
// no provider work started.
const admissionFaults = vi.hoisted(() => ({ remaining: 0 }));
vi.mock("../services/budget-reservations.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/budget-reservations.js")>();
  const { AccountingContentionError } = await import("../services/accounting-transaction.js");
  return {
    ...actual,
    reserveRunBudget: async (...args: Parameters<typeof actual.reserveRunBudget>) => {
      if (admissionFaults.remaining > 0) {
        admissionFaults.remaining -= 1;
        throw new AccountingContentionError(Object.assign(new Error("could not serialize access due to concurrent update"),
          { name: "PostgresError", code: "40001" }), 4);
      }
      return actual.reserveRunBudget(...args);
    },
  };
});

const support = await getRecoveryPostgresSupport({});

type AdmissionFailure = { remaining: number; turnNeverIssued: boolean; environmentId: string; provider: string;
  providerLeaseId: string; leasePolicy: "reuse_by_environment" | "reuse_by_execution_workspace"; failedRuns: string[];
  sessionRoots: string[] };

function nativeBackend(db: ReturnType<typeof createDb>, options: { failDescriptorOnce?: { failed: boolean };
  unretiredPredecessorOnce?: { failed: boolean; environmentId: string }; turnMessages?: Map<string, string>;
  admissionFailure?: AdmissionFailure } = {}):
  NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> {
  return execution => {
    let identity: NativeRunIdentity;
    let sourceInstanceId = "";
    let turn = Promise.withResolvers<string>();
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity,
      capabilities: async () => capabilities,
      attachRun: async input => { identity = input.identity; },
      startTurn: async input => {
        options.turnMessages?.set(identity.runId, JSON.stringify(input.message));
        const turnId = randomUUID();
        turn.resolve(turnId);
        return { turnId };
      },
      async *events() {
        const turnId = await turn.promise;
        const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
          schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
          sourceEventId: `${sourceInstanceId}:${identity.runId}:${sourceSeq}`, sourceSeq,
          runId: identity.runId, normalizedSessionId: identity.sessionId, turnId,
          schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload,
        });
        yield event(1, "turn.started", {});
        yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Done." });
        turn = Promise.withResolvers<string>();
        yield event(3, "turn.completed", { status: "completed" });
      },
      result: async () => null,
      snapshot: async () => ({ backendKind: "mock", sessionId: "predispatch-session", identity,
        providerSessionId: "predispatch-provider-session", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
      close: async () => {},
    };
    const backend: NativeSessionBackend = {
      descriptor: async () => {
        if (options.failDescriptorOnce && !options.failDescriptorOnce.failed) {
          options.failDescriptorOnce.failed = true;
          throw Object.assign(new Error("could not serialize access due to concurrent update"), { name: "PostgresError", code: "40001" });
        }
        const unretired = options.unretiredPredecessorOnce;
        if (unretired && !unretired.failed) {
          // Staging: this run resumed the task's reused sandbox, where
          // the previous run's warm Runner could not be retired before any
          // provider work. The executor reports that after its coordinator claim.
          unretired.failed = true;
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, execution.binding.runId));
          await db.insert(environmentLeases).values({ companyId: run!.companyId, environmentId: unretired.environmentId,
            issueId: execution.binding.issueId, heartbeatRunId: run!.id, provider: "daytona", providerLeaseId: "sandbox-reused",
            leasePolicy: "reuse_by_environment", status: "active", metadata: { remoteCwd: "/workspace" } });
          throw new NativePredecessorRetirementUnprovenError("previous-run", "sandbox-reused",
            new Error("Controller journal drain timed out; preserve the session before replacing its writer."));
        }
        const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, execution.binding.runId));
        if (!run?.runnerInstanceId) throw new Error("Normal native admission did not persist a runner identity");
        sourceInstanceId = run.runnerInstanceId;
        return { kind: "mock", name: "native-predispatch-retry", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: async input => { identity = input.identity; return session; },
      recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
    };
    const failure = options.admissionFailure;
    if (!failure) return backend;
    return Object.assign(backend, {
      providerTurnNeverIssued: () => failure.turnNeverIssued,
      providerAdmissionPersisted: async () => {
        if (failure.remaining <= 0) return;
        failure.remaining -= 1;
        const runId = execution.binding.runId;
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        await db.insert(environmentLeases).values({ companyId: run!.companyId, environmentId: failure.environmentId,
          issueId: execution.binding.issueId, heartbeatRunId: runId, provider: failure.provider,
          providerLeaseId: `${failure.providerLeaseId}-${failure.failedRuns.length}`, leasePolicy: failure.leasePolicy,
          status: "active", metadata: { remoteCwd: "/workspace" } });
        failure.failedRuns.push(runId);
        const root = scopedRunnerdStateRoot(execution);
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(join(root, "failed-attempt"), runId);
        failure.sessionRoots.push(root);
        throw new NativeProviderArtifactTransferTimeoutError("upload", 120_000, 512 * 1024 * 1024);
      },
    });
  };
}

describe.skipIf(!support.supported)("heartbeat native pre-dispatch failure retry", () => {
  const fixture = nativeRestartFixture({});

  async function startTask(db: ReturnType<typeof createDb>, heartbeat: ReturnType<typeof heartbeatService>) {
    const { companyId, agentId } = fixture.current;
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex" } }).where(eq(agents.id, agentId));
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    const [issue] = await db.insert(issues).values({ companyId, title: "Survive a database fault", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active" }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue!.id,
      authorType: "user", authorUserId: userId, body: "Start." }).returning();
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
      payload: { issueId: issue!.id, commentId: message!.id },
      contextSnapshot: { issueId: issue!.id, taskKey: issue!.id, wakeCommentId: message!.id } });
    expect(run).not.toBeNull();
    await waitForCondition("the first run to settle", () => heartbeat.getTaskDrainStatus().quiescent);
    return { issueId: issue!.id, runId: run!.id };
  }

  it("re-queues a native run that failed at budget admission and completes it without a Retry", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db) });
    try {
      admissionFaults.remaining = 1;
      const { issueId, runId } = await startTask(db, heartbeat);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed).toMatchObject({ status: "failed", runtimeMode: "native", errorCode: "adapter_failed",
        resultJson: expect.objectContaining({ failureCause: "40001",
          nativePreDispatchFailure: { version: 1, providerWorkStarted: false } }) });
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(successors).toEqual([expect.objectContaining({ scheduledRetryReason: "interrupted_preparation",
        scheduledRetryAttempt: 1 })]);
      expect(successors[0]!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status).not.toBe("blocked");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);

      // The first attempt is due at once; the scheduler promotes it and the
      // queue starts it, exactly once.
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the retry to succeed", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]?.status === "succeeded");
      await waitForCondition("the retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)))).toHaveLength(1);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
    } finally {
      admissionFaults.remaining = 0;
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);

  it("re-queues a run whose predecessor could not be retired onto a fresh sandbox without a Retry", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `reused-${randomUUID()}`, driver: "sandbox" }).returning();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db,
      { unretiredPredecessorOnce: { failed: false, environmentId: environment!.id } }) });
    try {
      const { issueId, runId } = await startTask(db, heartbeat);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed).toMatchObject({ status: "failed", runtimeMode: "native", errorCode: "adapter_failed",
        resultJson: expect.objectContaining({ failureCause: "native_predecessor_retirement_unproven",
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          predecessorRetirementFallback: expect.objectContaining({ version: 1, providerWorkStarted: false,
            predecessorRunId: "previous-run", replacedProviderLeaseIds: ["sandbox-reused"] }) }) });
      // The reused sandbox is replaced at the next acquisition, not resumed.
      const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, runId),
        eq(environmentLeases.providerLeaseId, "sandbox-reused")));
      expect(lease?.metadata).toMatchObject({ replaceBeforeReuse: { schema: "paperclip.replace-before-reuse.v1", runId,
        predecessorRunId: "previous-run" } });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, runId),
        eq(activityLog.action, "environment.lease_replacement_requested")))).toHaveLength(1);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(successors).toEqual([expect.objectContaining({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 })]);
      expect(successors[0]!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status).not.toBe("blocked");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);

      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the retry to succeed", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]?.status === "succeeded");
      await waitForCondition("the retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);

  it("delivers the monitor check to the automatic retry of a monitor run that failed before provider work", async () => {
    const { companyId, agentId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `reused-${randomUUID()}`, driver: "sandbox" }).returning();
    const turnMessages = new Map<string, string>();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db,
      { unretiredPredecessorOnce: { failed: false, environmentId: environment!.id }, turnMessages }) });
    try {
      await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex" } }).where(eq(agents.id, agentId));
      await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`,
        createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
      const [issue] = await db.insert(issues).values({ companyId, title: "Phase 2 on the monitor check", status: "in_progress",
        assigneeAgentId: agentId, responsibleUserId: userId, monitorNotes: "Phase 2 check" }).returning();
      const run = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_monitor_due",
        payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, taskKey: issue!.id,
          source: "issue.monitor", wakeReason: "issue_monitor_due", monitorNotes: "Phase 2 check" } });
      expect(run).not.toBeNull();
      await waitForCondition("the monitor run to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(failed).toMatchObject({ status: "failed", resultJson: expect.objectContaining({
        failureCause: "native_predecessor_retirement_unproven" }) });
      const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, run!.id)));
      expect(successor).toMatchObject({ scheduledRetryReason: "interrupted_preparation" });

      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the retry to start its provider turn", () => turnMessages.has(successor!.id));
      await waitForCondition("the retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      const [retried] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor!.id));
      const continuation = retried!.contextSnapshot?.executionContinuation as ExecutionContinuationEnvelope;
      expect(continuation.trigger).toMatchObject({ sourceRunId: run!.id, retriedReason: "issue_monitor_due" });
      expect(renderPaperclipWakePrompt(retried!.contextSnapshot?.paperclipWake)).toContain("- retried wake: issue_monitor_due");
      expect(turnMessages.get(successor!.id)).toContain("- retried wake: issue_monitor_due");
      expect(turnMessages.has(run!.id)).toBe(false);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);

  it.each([
    { target: "remote sandbox", provider: "e2b", leasePolicy: "reuse_by_execution_workspace" as const },
    { target: "plugin-task sandbox", provider: "daytona", leasePolicy: "reuse_by_environment" as const },
  ])("continues on a fresh $target when the provider artifacts fail to save before any turn", async ({ provider, leasePolicy }) => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `capture-${randomUUID()}`, driver: "sandbox" }).returning();
    const turnMessages = new Map<string, string>();
    const failure: AdmissionFailure = { remaining: 1, turnNeverIssued: true, environmentId: environment!.id, provider,
      providerLeaseId: `sandbox-${provider}`, leasePolicy, failedRuns: [], sessionRoots: [] };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { admissionFailure: failure, turnMessages }) });
    try {
      const { issueId, runId } = await startTask(db, heartbeat);
      expect(failure.failedRuns).toEqual([runId]);
      expect(turnMessages.has(runId)).toBe(false);
      expect(existsSync(failure.sessionRoots[0]!)).toBe(false);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed).toMatchObject({ status: "failed", runtimeMode: "native",
        resultJson: expect.objectContaining({ failureCause: "native_failed_before_provider_turn",
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          predecessorRetirementFallback: expect.objectContaining({ version: 1, providerWorkStarted: false,
            predecessorRunId: null, replacedProviderLeaseIds: [`sandbox-${provider}-0`] }) }) });
      expect(failed!.error).toBe("Setting up the computer took too long, so the task is continuing on a fresh one.");
      expect(failed!.error).not.toMatch(/[a-z0-9]+_[a-z0-9_]+|\d|\(|\)/i);
      expect(failed!.runnerProfileJson).toMatchObject({ failedBeforeProviderTurn: {
        cause: "native_failed_before_provider_turn", technicalCause: "native_provider_artifacts_transfer_timeout" } });
      const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, runId),
        eq(environmentLeases.providerLeaseId, `sandbox-${provider}-0`)));
      expect(lease?.metadata).toMatchObject({ replaceBeforeReuse: { schema: "paperclip.replace-before-reuse.v1", runId } });
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(successors).toEqual([expect.objectContaining({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 })]);
      expect(successors[0]!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue!.status).not.toBe("blocked");
      expect(await taskInterruptionPresentation(db, issue!)).toMatchObject({ state: "working", canRetry: false });
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);

      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the continuation to succeed", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]?.status === "succeeded");
      await waitForCondition("the continuation to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect(turnMessages.has(successors[0]!.id)).toBe(true);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)))).toHaveLength(1);
      const [settled] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(await taskInterruptionPresentation(db, settled!)).toMatchObject({ state: "resolved", canRetry: false });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 90_000);

  it("keeps today's ambiguous hold when the Runner ledger cannot prove no turn was sent", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `capture-${randomUUID()}`, driver: "sandbox" }).returning();
    const failure: AdmissionFailure = { remaining: 1, turnNeverIssued: false, environmentId: environment!.id, provider: "daytona",
      providerLeaseId: "sandbox-turn-maybe-sent", leasePolicy: "reuse_by_environment", failedRuns: [], sessionRoots: [] };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { admissionFailure: failure }) });
    try {
      const { runId } = await startTask(db, heartbeat);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed?.status).toBe("failed");
      expect(failed?.resultJson ?? {}).not.toHaveProperty("predecessorRetirementFallback");
      expect(failed?.resultJson?.failureCause).not.toBe("native_failed_before_provider_turn");
      const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, runId),
        eq(environmentLeases.providerLeaseId, "sandbox-turn-maybe-sent-0")));
      expect(lease?.metadata ?? {}).not.toHaveProperty("replaceBeforeReuse");
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId), eq(heartbeatRuns.scheduledRetryReason, "interrupted_preparation")))).toHaveLength(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 90_000);

  it("backs off a lasting pre-turn failure and stops at the shared lane cap without hammering", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `capture-${randomUUID()}`, driver: "sandbox" }).returning();
    const failure: AdmissionFailure = { remaining: Number.POSITIVE_INFINITY, turnNeverIssued: true, environmentId: environment!.id,
      provider: "daytona", providerLeaseId: "sandbox-lasting", leasePolicy: "reuse_by_environment", failedRuns: [], sessionRoots: [] };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { admissionFailure: failure }) });
    const successorOf = async (runId: string) => (await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId))));
    const runToEnd = async (runId: string) => {
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the attempt to end", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status === "failed");
      await waitForCondition("the attempt to settle", () => heartbeat.getTaskDrainStatus().quiescent);
    };
    try {
      const { issueId, runId } = await startTask(db, heartbeat);
      const [first] = await successorOf(runId);
      expect(first).toMatchObject({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 });
      expect((await heartbeat.promoteDueScheduledRetries()).runIds).toEqual([first!.id]);
      const secondStartedAt = Date.now();
      await runToEnd(first!.id);
      const [second] = await successorOf(first!.id);
      expect(second).toMatchObject({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 2 });
      expect(second!.scheduledRetryAt!.getTime() - secondStartedAt).toBeGreaterThanOrEqual(15_000);
      expect((await heartbeat.promoteDueScheduledRetries()).runIds).not.toContain(second!.id);
      expect(failure.failedRuns).toHaveLength(2);
      const [waiting] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(await taskInterruptionPresentation(db, waiting!)).toMatchObject({ state: "working", canRetry: false });

      await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 12, scheduledRetryAt: new Date(Date.now() - 1_000),
        contextSnapshot: { ...second!.contextSnapshot, executionRetryAccounting: {
          ...(second!.contextSnapshot?.executionRetryAccounting as Record<string, unknown>), interruptedPreparations: 12 } } })
        .where(eq(heartbeatRuns.id, second!.id));
      expect((await heartbeat.promoteDueScheduledRetries()).runIds).toEqual([second!.id]);
      await runToEnd(second!.id);
      expect(await successorOf(second!.id)).toHaveLength(0);
      expect(failure.failedRuns).toHaveLength(3);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(await taskInterruptionPresentation(db, issue!)).toMatchObject({ state: "failed", canRetry: true });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 120_000);

  it("keeps the hold when the failure follows entry into the native executor", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { failDescriptorOnce: { failed: false } }) });
    try {
      const { runId } = await startTask(db, heartbeat);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed?.status).toBe("failed");
      expect(failed?.resultJson ?? {}).not.toHaveProperty("nativePreDispatchFailure");
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId), eq(heartbeatRuns.scheduledRetryReason, "interrupted_preparation")))).toHaveLength(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);
});
