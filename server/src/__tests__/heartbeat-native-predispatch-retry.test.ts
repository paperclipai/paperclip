import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, authUsers, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns, issueComments,
  issueRecoveryActions, issues } from "@paperclipai/db";
import { NativePredecessorRetirementUnprovenError } from "../services/native-runtime/predecessor-retirement.js";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import { describe, expect, it, vi } from "vitest";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
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

function nativeBackend(db: ReturnType<typeof createDb>, options: { failDescriptorOnce?: { failed: boolean };
  unretiredPredecessorOnce?: { failed: boolean; environmentId: string } } = {}):
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
      startTurn: async () => {
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
    return backend;
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
