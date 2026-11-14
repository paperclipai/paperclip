import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, agentTaskSessions, authUsers, companyMemberships, createDb, heartbeatRuns,
  issueComments, issueThreadInteractions, issues, nativeRunResults } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import { describe, expect, it, vi } from "vitest";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { contextCompactionService } from "../services/context-compaction.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

// Only this owner opts into its dedicated database. Importing the fixture core
// avoids the default support facade's embedded-platform probe in that mode.
const dedicatedDatabaseUrl = process.env.PAPERCLIP_CONTEXT_COMPACTION_EXECUTION_TEST_DATABASE_URL;
const databaseOptions = dedicatedDatabaseUrl === undefined ? {} : { dedicatedDatabaseUrl };
const support = await getRecoveryPostgresSupport(databaseOptions);

describe.skipIf(!support.supported)("heartbeat context compaction execution", () => {
  const fixture = nativeRestartFixture(databaseOptions);

  async function conversation() {
    const { companyId, agentId, temporary } = fixture.current;
    const db = createDb(temporary.connectionString, { maxConnections: 4 });
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Conversation owner", email: `${userId}@example.invalid`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex", lifecycleMode: "warm", idleTimeoutMs: 60_000 } })
      .where(eq(agents.id, agentId));
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    const [issue] = await db.insert(issues).values({ companyId, title: "Keep the conversation parked", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active" }).returning();
    return { db, companyId, agentId, userId, issue };
  }

  // The first ordinary conversation turn produces a real idle checkpoint and
  // task-session pointer through the normal owner. Its final text is a provider
  // event, not a seeded result. The second turn uses the existing Runner
  // compaction protocol; result() deliberately never supplies an outcome.
  function conversationBackend(db: ReturnType<typeof createDb>) {
    let identity: NativeRunIdentity;
    let sourceInstanceId = "";
    let activeTurnId: string | null = null;
    let nextTurn = Promise.withResolvers<{ compact: boolean; turnId: string }>();
    const startTurn = vi.fn<NativeSession["startTurn"]>(async input => {
      const turnId = randomUUID();
      activeTurnId = turnId;
      nextTurn.resolve({ compact: input.compact === true, turnId });
      return { turnId };
    });
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity,
      capabilities: async () => capabilities,
      attachRun: async input => { identity = input.identity; },
      startTurn,
      async *events() {
        const turn = await nextTurn.promise;
        const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
          schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
          sourceEventId: `${sourceInstanceId}:${identity.runId}:${sourceSeq}`, sourceSeq,
          runId: identity.runId, normalizedSessionId: identity.sessionId, turnId: turn.turnId,
          schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload,
        });
        yield event(1, "turn.started", {});
        yield turn.compact
          ? event(2, "context.compacted", { schema: "paperclip.context.compacted.v1", compactionId: randomUUID(),
              reason: "provider", preTokens: null, postTokens: null, sameSession: true })
          : event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Ready for your next message." });
        activeTurnId = null;
        nextTurn = Promise.withResolvers<{ compact: boolean; turnId: string }>();
        yield event(3, "turn.completed", { status: "completed" });
      },
      result: async () => null,
      snapshot: async () => ({ backendKind: "mock", sessionId: "compaction-session", identity,
        providerSessionId: "compaction-provider-session", cursor: null, activeTurnId, pendingRuntimeRequests: [], lineage: [] }),
      close: vi.fn(async () => {}),
    };
    const factory: NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> = execution => {
      const backend: NativeSessionBackend = {
        descriptor: async () => {
          const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, execution.binding.runId));
          if (!run?.runnerInstanceId) throw new Error("Normal native admission did not persist a runner identity");
          sourceInstanceId = run.runnerInstanceId;
          return { kind: "mock", name: "conversation-compaction", version: "1", capabilities,
            runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
        },
        openSession: async input => { identity = input.identity; return session; },
        recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
      };
      return backend;
    };
    return { factory, startTurn, session };
  }

  it.each([false, true])("keeps a successfully compacted conversation waiting (pending question: %s)", async pendingQuestion => {
    const f = await conversation();
    const backend = conversationBackend(f.db);
    const heartbeat = heartbeatService(f.db, { nativeSessionBackendFactory: backend.factory });
    try {
      const [message] = await f.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issue.id,
        authorType: "user", authorUserId: f.userId, body: "Start this conversation." }).returning();
      const first = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: f.userId, manualUserWake: true,
        payload: { issueId: f.issue.id, commentId: message.id },
        contextSnapshot: { issueId: f.issue.id, taskKey: f.issue.id, wakeCommentId: message.id } });
      expect(first).not.toBeNull();
      await waitForCondition("normal conversation execution and wakes to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first!.id)))[0])
        .toMatchObject({ status: "succeeded" });
      const [idle] = await f.db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, f.companyId),
        eq(agentTaskSessions.agentId, f.agentId), eq(agentTaskSessions.taskKey, f.issue.id)));
      expect(idle).toMatchObject({ lastRunId: first!.id });
      expect(idle.sessionParamsJson).toBeTruthy();
      const [before] = await f.db.select().from(issues).where(eq(issues.id, f.issue.id));
      expect(before).toMatchObject({ status: "in_review", conversationState: "waiting" });
      const [question] = pendingQuestion ? await f.db.insert(issueThreadInteractions).values({
        companyId: f.companyId, issueId: f.issue.id, createdByAgentId: f.agentId, sourceRunId: first!.id,
        kind: "ask_user_questions", status: "pending", addresseeUserId: f.userId,
        payload: { version: 1, questions: [{ id: "q", prompt: "Which option?", selectionMode: "single",
          options: [{ id: "a", label: "Option A" }] }] },
      }).returning() : [];
      const commentsBefore = await f.db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
      const interactionsBefore = await f.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issue.id));
      const compact = await contextCompactionService(f.db, { wakeup: heartbeat.wakeup }).request({
        companyId: f.companyId, issue: before, userId: f.userId,
      });
      await waitForCondition("normal compaction execution and wakes to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, compact.runId));
      expect(run).toMatchObject({ status: "succeeded", contextSnapshot: { contextCompactionRequestId: compact.requestId } });
      expect(backend.startTurn).toHaveBeenCalledTimes(2);
      expect(backend.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ compact: true, continuation: true }));
      expect(await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, compact.runId)))
        .toEqual([expect.objectContaining({ schemaStatus: "accepted", resultJson: expect.objectContaining({
          result: expect.objectContaining({ summary: "Context compacted on request.", reportedWorkDisposition: "yielded" }),
        }) })]);
      expect((await f.db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]).toMatchObject({
        status: "in_review", conversationState: "waiting", conversationSessionGeneration: before.conversationSessionGeneration,
        conversationBoundaryCommentId: before.conversationBoundaryCommentId,
      });
      expect(await f.db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toEqual(commentsBefore);
      expect(await f.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issue.id))).toEqual(interactionsBefore);
      if (question) expect(question.status).toBe("pending");
      expect(await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue.continuation_recovery",
        requestedByActorType: "system", payload: { issueId: f.issue.id }, contextSnapshot: { issueId: f.issue.id } })).toBeNull();
      expect(backend.startTurn).toHaveBeenCalledTimes(2);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await f.db.$client.end();
    }
  }, 60_000);

  it("still cancels an ordinary continuation while its question awaits an authorized answer", async () => {
    const f = await conversation();
    try {
      await f.db.update(issues).set({ status: "in_review", conversationState: "waiting" }).where(eq(issues.id, f.issue.id));
      await f.db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issue.id,
        createdByAgentId: f.agentId, addresseeUserId: f.userId, kind: "ask_user_questions", status: "pending",
        payload: { version: 1, questions: [{ id: "q", prompt: "Continue?", selectionMode: "single", options: [{ id: "a", label: "Yes" }] }] } });
      const [run] = await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "queued", runtimeMode: "legacy", invocationSource: "automation", triggerDetail: "system", responsibleUserId: f.userId,
        resultJson: { conversationContinuation: "continue_conversation_v1" }, contextSnapshot: { issueId: f.issue.id } }).returning();
      const result = await createRunDispatch(f.db).cancelStaleQueuedRun({ runId: run.id, companyId: f.companyId, expectedStatus: "queued" });
      expect(result).toMatchObject({ outcome: "cancelled", errorCode: "issue_waiting_for_response" });
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0])
        .toMatchObject({ status: "cancelled", errorCode: "issue_waiting_for_response" });
    } finally { await f.db.$client.end(); }
  });
});
