import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, companyMemberships, createDb, heartbeatRuns, issueComments, issueRecoveryActions,
  issues } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

const admission = vi.hoisted(() => ({ beforeReserve: undefined as ((runId: string) => Promise<void>) | undefined }));
vi.mock("../services/budget-reservations.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/budget-reservations.js")>();
  return {
    ...actual,
    reserveRunBudget: async (...args: Parameters<typeof actual.reserveRunBudget>) => {
      await admission.beforeReserve?.(args[2]);
      return actual.reserveRunBudget(...args);
    },
  };
});

const support = await getRecoveryPostgresSupport({});

function nativeBackend(db: ReturnType<typeof createDb>, opened: string[]):
  NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> {
  const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
  return execution => ({
    descriptor: async () => {
      const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, execution.binding.runId));
      if (!run?.runnerInstanceId) throw new Error("Normal native admission did not persist a runner identity");
      return { kind: "mock", name: "native-stop-before-admission", version: "1", capabilities,
        runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
    },
    openSession: async () => {
      opened.push(execution.binding.runId);
      throw new Error("A stopped run opened a provider session");
    },
    recoverSession: async () => {
      opened.push(execution.binding.runId);
      throw new Error("A stopped run recovered a provider session");
    },
  });
}

describe.skipIf(!support.supported)("heartbeat native Stop before budget admission", () => {
  const fixture = nativeRestartFixture({});

  async function startTask(db: ReturnType<typeof createDb>, heartbeat: ReturnType<typeof heartbeatService>) {
    const { companyId, agentId } = fixture.current;
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex" } }).where(eq(agents.id, agentId));
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    const [issue] = await db.insert(issues).values({ companyId, title: "Stop while preparing", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active" }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue!.id,
      authorType: "user", authorUserId: userId, body: "Start." }).returning();
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
      payload: { issueId: issue!.id, commentId: message!.id },
      contextSnapshot: { issueId: issue!.id, taskKey: issue!.id, wakeCommentId: message!.id } });
    expect(run).not.toBeNull();
    await waitForCondition("the run to settle", () => heartbeat.getTaskDrainStatus().quiescent);
    return { issueId: issue!.id, runId: run!.id };
  }

  async function expectSettledAsStop(db: ReturnType<typeof createDb>, runId: string, issueId: string, opened: string[],
    reason: string) {
    const { companyId } = fixture.current;
    await waitForCondition("the stopped run to settle", async () => {
      const [current] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return current?.status !== "running" && current?.status !== "queued";
    });
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(stopped).toMatchObject({ status: "cancelled", errorCode: "cancelled", error: reason });
    expect(stopped?.resultJson ?? {}).not.toHaveProperty("nativePreDispatchFailure");
    expect(opened).toEqual([]);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.retryOfRunId, runId)))).toHaveLength(0);
    for (const action of await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))
      expect(action.evidence).toMatchObject({ runId, originalFailureCode: "cancelled" });
    return stopped!;
  }

  it("settles an operator Stop recorded before budget admission as that cancellation, not a run failure", async () => {
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const opened: string[] = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, opened) });
    try {
      admission.beforeReserve = async runId => {
        admission.beforeReserve = undefined;
        const recordedAt = new Date().toISOString();
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const intentId = `native-cancellation:${randomUUID()}`;
        const [audit] = await db.insert(activityLog).values({ companyId: run!.companyId, actorType: "system",
          actorId: "native-session-cancellation", action: "native.cancellation_intent_recorded", entityType: "heartbeat_run",
          entityId: runId, agentId: run!.agentId, runId, details: { intentId, scope: "run",
            reasonCode: "cancellation_run_only", effects: ["release_run_resources"] } }).returning();
        await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
          nativeCancellation: { schema: "paperclip.native-cancellation.v1", intentId, intentAuditId: audit!.id,
            companyId: run!.companyId, runId, issueId: run!.nativeIssueId, scope: "run", reasonCode: "cancellation_run_only",
            effects: ["release_run_resources"], dispatchState: "pending", dispatched: false, decisionId: null,
            priorCoordinatorDecisionId: null, recordedAt },
          cancelledByActorType: "user", cancelledByUserId: "operator",
          executionCancellation: { state: "requested", requestedAt: recordedAt },
          cancellation: { reason: "Cancelled by a board operator", source: "operator", expected: true,
            initiator: { id: "operator", type: "user" }, recordedAt },
          startupCancellation: { errorCode: "cancelled", requestedAt: recordedAt, beforeNativeSelection: false },
        })}::jsonb` }).where(eq(heartbeatRuns.id, runId));
      };
      const { issueId, runId } = await startTask(db, heartbeat);
      const stopped = await expectSettledAsStop(db, runId, issueId, opened, "Recovered durable native run cancellation");
      expect(stopped.resultJson?.nativeCancellation).toMatchObject({ dispatchState: "acknowledged", dispatched: false });
    } finally {
      admission.beforeReserve = undefined;
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);

  it("leaves an operator Stop that settles during admission cancelled", async () => {
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const opened: string[] = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, opened) });
    let stop: Promise<unknown> | undefined;
    try {
      admission.beforeReserve = async runId => {
        admission.beforeReserve = undefined;
        stop = heartbeat.cancelRun(runId, "Cancelled by a board operator", {
          resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" },
        });
        await waitForCondition("the Stop to be recorded", async () => {
          const [current] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, runId));
          return Boolean(current?.resultJson?.cancellation || current?.resultJson?.startupCancellation);
        });
      };
      const { issueId, runId } = await startTask(db, heartbeat);
      await expect(stop).resolves.toMatchObject({ id: runId, status: "cancelled" });
      await expectSettledAsStop(db, runId, issueId, opened, "Cancelled by a board operator");
    } finally {
      admission.beforeReserve = undefined;
      await stop?.catch(() => undefined);
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);
});
