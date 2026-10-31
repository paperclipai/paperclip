import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, completionContracts, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues,
  nativeRunFinalizations, nativeRunResults, chatTaskHandoffs, chatCompletionDeliveries, agentWakeupRequests, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { finalizeNativeRun, recoverCommittedNativeChatResponse } from "./native-run-finalizer.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../task-admission.js";
import { chatCompletionDeliveryService } from "../chat-completion-delivery.js";
import { instanceSettingsService } from "../instance-settings.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_CHAT_RESPONSE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("committed Agent Chat reply recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("agent-chat-response-");
    db = createDb(external ?? database!.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(conversation = true, options: { succeed?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID(), runnerId = randomUUID(), userId = `fixture-${randomUUID()}`, wakeId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Conversation owner", email: `${userId}@example.test`,
      createdAt: new Date("2020-01-01T00:00:00Z"), updatedAt: new Date("2020-01-01T00:00:00Z") });
    await db.insert(companies).values({ id: companyId, name: "Reply recovery fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Conversation agent", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Conversation reply", status: "in_progress", assigneeAgentId: agentId,
      ...(conversation ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active", conversationSessionGeneration: 0 } : {}) });
    await db.insert(issueComments).values({ id: wakeId, companyId, issueId, authorUserId: userId, body: "Hire one teammate and tell me when ready.",
      createdAt: new Date("2020-01-01T00:00:00Z") });
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Answer the user", criteria: [] },
      canonicalSha256: "fixture-conversation-contract", createdByActorType: "system", createdByActorId: "test" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      status: "running", runtimeMode: "native", responsibleUserId: userId,
      contextSnapshot: { issueId, source: "issue.comment", wakeCommentId: wakeId, ...(conversation ? { conversationSessionGeneration: 0 } : {}) } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const port = new NativeRunCoordinatorStore(db, { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      completionContractRevision: "test", completionContractCriterionIds: [] });
    const reply = "The teammate is hired and ready for your next instruction.";
    const prpEvent = { runId, normalizedSessionId: sessionId, turnId: "hire-turn", sourceEventId: "fixture-final-answer",
      payload: { kind: "agentMessage", channel: "final", providerPhase: "final", text: reply } };
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 170, eventType: "item.completed", payload: { prpEvent } });
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
      summary: "A completed hire, with its final message preserved separately.", completionClaim: { contractRevision: "test",
        objectiveSatisfied: true, criteria: [], remainingWork: [] }, evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" }, turnId: "hire-turn" });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0].phase).toBe("committed");
    if (options.succeed !== false) await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date("2020-01-01T00:02:00Z") }).where(eq(heartbeatRuns.id, runId));
    const input = { companyId, issueId, runId };
    return { ...input, input, agentId, userId, wakeId, prpEvent, reply };
  }
  const comments = (runId: string) => db.select().from(issueComments).where(eq(issueComments.createdByRunId, runId));
  const issue = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0];

  async function completion(f: Awaited<ReturnType<typeof fixture>>) {
    const taskId = randomUUID(), deliveryId = randomUUID();
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.insert(issues).values({ id: taskId, companyId: f.companyId, title: "Completed review", status: "done", statusVersion: 2 });
    await db.insert(chatTaskHandoffs).values({ companyId: f.companyId, taskId, conversationId: f.issueId,
      agentId: f.agentId, sessionGeneration: 0 });
    await db.insert(chatCompletionDeliveries).values({ id: deliveryId, companyId: f.companyId, taskId,
      statusVersion: 2, status: "queued", targetRunId: f.runId, nextAttemptAt: new Date(0) });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, source: "automation", wakeReason: "chat_task_completed",
      conversationMode: true, conversationSessionGeneration: 0, chatCompletionDeliveryIds: [deliveryId], chatCompletionUpdates: [{ taskId }] } })
      .where(eq(heartbeatRuns.id, f.runId));
    const wakeup = vi.fn(async (_agentId: string, options: { idempotencyKey: string }) => {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
        status: "skipped", reason: "heartbeat.daily_run_limit", idempotencyKey: options.idempotencyKey });
      return null;
    });
    const delivery = async () => (await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.id, deliveryId)))[0];
    return { taskId, deliveryId, wakeup, delivery, service: chatCompletionDeliveryService(db, { wakeup }) };
  }

  it("preserves accepted native callback presentation when outbox retry runs first at the daily cap", async () => {
    const f = await fixture(), outbox = await completion(f);
    const work = nativeResponsePresentationWork(db);
    const [entry] = await work.load(f.input);
    expect(entry).toMatchObject({ id: f.runId });
    // Deterministically order the real due-outbox handler before presentation;
    // the already accepted answer must not require another model admission.
    await outbox.service.deliver(outbox.deliveryId);
    await expect(work.check(entry)).resolves.toBeNull();
    const [comment] = await comments(f.runId);
    expect(comment).toMatchObject({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId });
    expect(await comments(f.runId)).toHaveLength(1);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
    expect(await outbox.delivery()).toMatchObject({ status: "delivered", targetRunId: f.runId, attempts: 0, responseCommentId: comment.id });
    expect(outbox.wakeup).not.toHaveBeenCalled();
  });

  it.each([false, true])("wakes the real reply worker only after outer commit, becomes idle and persists once (rollback=%s)", async rollback => {
    const f = await fixture(true, { succeed: false }), outbox = await completion(f);
    let queries = 0;
    const debug = db.$client.options.debug;
    db.$client.options.debug = () => { queries++; };
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    const quiet = () => vi.waitFor(() => {
      expect(coordinator.nextWakeAt()).toBeNull();
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
    const projectAndDefer = async (abort: boolean) => db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      await chatCompletionDeliveryService(tx as unknown as Db, { wakeup: outbox.wakeup }).deliver(outbox.deliveryId);
      expect(await comments(f.runId)).toEqual([]);
      if (abort) throw new Error("fixture-outbox-rollback");
    });
    try {
      await worker.ready; await quiet();
      if (rollback) {
        await expect(projectAndDefer(true)).rejects.toThrow("fixture-outbox-rollback");
        await quiet();
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
        expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0, nextAttemptAt: new Date(0) });
        expect(await comments(f.runId)).toEqual([]);
      }
      await projectAndDefer(false);
      await vi.waitFor(async () => expect(await comments(f.runId)).toHaveLength(1), { timeout: 5000 });
      const [comment] = await comments(f.runId);
      expect(comment).toMatchObject({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId });
      expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
      expect(await outbox.delivery()).toMatchObject({ status: "delivered", targetRunId: f.runId, attempts: 0, responseCommentId: comment.id });
      await quiet();
      const settledQueries = queries;
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(queries).toBe(settledQueries);
      expect(coordinator.nextWakeAt()).toBeNull();
      vi.useRealTimers();
      await outbox.service.deliver(outbox.deliveryId);
      expect(await comments(f.runId)).toHaveLength(1);
      expect(outbox.wakeup).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers(); worker.stop(); await coordinator.stop(); db.$client.options.debug = debug;
    }
  });

  it.each(["failed", "cancelled", "missing-final", "no-accepted", "old-generation", "foreign-company", "foreign-agent"])(
    "keeps the existing retry path for %s targets", async fault => {
      const f = await fixture(), outbox = await completion(f);
      if (fault === "failed" || fault === "cancelled") await db.update(heartbeatRuns).set({ status: fault }).where(eq(heartbeatRuns.id, f.runId));
      if (fault === "missing-final") await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
      if (fault === "no-accepted") await db.update(nativeRunResults).set({ schemaStatus: "rejected" }).where(eq(nativeRunResults.runId, f.runId));
      if (fault === "old-generation") {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot, conversationSessionGeneration: 1 } }).where(eq(heartbeatRuns.id, f.runId));
      }
      let foreign: Awaited<ReturnType<typeof fixture>> | undefined;
      if (fault === "foreign-company") {
        foreign = await fixture();
        await db.update(chatCompletionDeliveries).set({ targetRunId: foreign.runId }).where(eq(chatCompletionDeliveries.id, outbox.deliveryId));
      }
      if (fault === "foreign-agent") {
        const otherAgent = randomUUID();
        await db.insert(agents).values({ id: otherAgent, companyId: f.companyId, name: "Other agent", adapterType: "paperclip_runner" });
        await db.update(heartbeatRuns).set({ agentId: otherAgent }).where(eq(heartbeatRuns.id, f.runId));
      }
      await outbox.service.deliver(outbox.deliveryId);
      expect(outbox.wakeup).toHaveBeenCalledTimes(1);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1, responseCommentId: null });
      expect(await comments(f.runId)).toEqual([]);
      if (foreign) expect(await comments(foreign.runId)).toEqual([]);
    },
  );

  it.each(["reset-source", "new-task-version"])("keeps %s delivery supersession", async fault => {
    const f = await fixture(), outbox = await completion(f);
    if (fault === "reset-source") await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.issueId));
    else {
      await db.update(issues).set({ statusVersion: 3 }).where(eq(issues.id, outbox.taskId));
      await db.update(chatCompletionDeliveries).set({ status: "superseded" }).where(eq(chatCompletionDeliveries.id, outbox.deliveryId));
    }
    await outbox.service.deliver(outbox.deliveryId);
    expect(await outbox.delivery()).toMatchObject({ status: "superseded", attempts: 0, responseCommentId: null });
    expect(outbox.wakeup).not.toHaveBeenCalled();
    expect(await comments(f.runId)).toEqual([]);
  });

  it("uses the accepted retry deadline without authorizing a reply or a new model run", async () => {
    const f = await fixture(), outbox = await completion(f), nextAttemptAt = new Date(Date.now() + 300_000);
    await db.update(nativeRunFinalizations).set({ nextAttemptAt }).where(eq(nativeRunFinalizations.runId, f.runId));
    await outbox.service.deliver(outbox.deliveryId);
    expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0, nextAttemptAt });
    expect(outbox.wakeup).not.toHaveBeenCalled();
    expect(await comments(f.runId)).toEqual([]);
  });

  it("does not turn candidate deferral into authority for a digest mismatch", async () => {
    const f = await fixture(), outbox = await completion(f);
    await db.update(nativeRunResults).set({ canonicalSha256: "invalid-digest" }).where(eq(nativeRunResults.runId, f.runId));
    await outbox.service.deliver(outbox.deliveryId);
    const work = nativeResponsePresentationWork(db), [entry] = await work.load(f.input);
    await expect(work.check(entry)).resolves.toBeNull();
    expect(await comments(f.runId)).toEqual([]);
    expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0, responseCommentId: null });
    expect(outbox.wakeup).not.toHaveBeenCalled();
  });

  it("finds a committed final Agent Chat turn, persists the exact reply once and only then settles waiting", async () => {
    const f = await fixture();
    expect(await comments(f.runId)).toEqual([]);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_progress", conversationState: "active" });
    const work = nativeResponsePresentationWork(db), entries = await work.load(f.input);
    expect(entries).toEqual([expect.objectContaining({ id: f.runId })]);
    await expect(work.check(entries[0])).resolves.toBeNull();
    expect(await comments(f.runId)).toEqual([expect.objectContaining({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId })]);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
    expect(await work.load(f.input)).toEqual([]);
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
    expect(await comments(f.runId)).toHaveLength(1);
  });
  it("keeps a later user message actionable after recovering the earlier exact reply", async () => {
    const f = await fixture();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorUserId: f.userId, body: "Another instruction",
      createdAt: new Date("2020-01-01T00:01:00Z") });
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(true);
    expect(await comments(f.runId)).toHaveLength(1);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_progress", conversationState: "active" });
  });
  it("does not duplicate a reply under concurrent recovery", async () => {
    const f = await fixture();
    expect((await Promise.all([recoverCommittedNativeChatResponse(db, f.input), recoverCommittedNativeChatResponse(db, f.input)])).sort())
      .toEqual([false, true]);
    expect(await comments(f.runId)).toHaveLength(1);
  });
  it.each(["skip", "generation", "agent", "user", "execution", "waiting", "turn", "event-run", "session", "channel", "kind", "digest", "partial"])(
    "keeps %s mismatches unchanged instead of publishing an unauthorized or incomplete reply", async fault => {
      const f = await fixture();
      if (["skip", "generation"].includes(fault)) await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId,
        source: "issue.comment", wakeCommentId: f.wakeId, conversationSessionGeneration: fault === "generation" ? 1 : 0,
        ...(fault === "skip" ? { skipIssueComment: true } : {}) } }).where(eq(heartbeatRuns.id, f.runId));
      if (fault === "user") await db.update(heartbeatRuns).set({ responsibleUserId: "another-user" }).where(eq(heartbeatRuns.id, f.runId));
      if (fault === "agent") {
        const other = randomUUID(); await db.insert(agents).values({ id: other, companyId: f.companyId, name: "Other agent" });
        await db.update(issues).set({ conversationAgentId: other, assigneeAgentId: other }).where(eq(issues.id, f.issueId));
      }
      if (fault === "execution") {
        const other = randomUUID(); await db.insert(heartbeatRuns).values({ id: other, companyId: f.companyId, agentId: f.agentId });
        await db.update(issues).set({ executionRunId: other }).where(eq(issues.id, f.issueId));
      }
      if (fault === "waiting") await db.update(issues).set({ executionRunId: null, status: "in_review", conversationState: "waiting" }).where(eq(issues.id, f.issueId));
      if (["turn", "event-run", "session", "channel", "kind"].includes(fault)) {
        const event = structuredClone(f.prpEvent);
        if (fault === "turn") event.turnId = "foreign-turn";
        if (fault === "event-run") event.runId = randomUUID();
        if (fault === "session") event.normalizedSessionId = randomUUID();
        if (fault === "channel") event.payload.channel = "analysis";
        if (fault === "kind") event.payload.kind = "reasoning";
        await db.update(heartbeatRunEvents).set({ payload: { prpEvent: event } }).where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 170)));
      }
      if (fault === "digest") await db.update(nativeRunResults).set({ canonicalSha256: "invalid-digest" }).where(eq(nativeRunResults.runId, f.runId));
      if (fault === "partial") await db.update(nativeRunFinalizations).set({ phase: "copying_back" }).where(eq(nativeRunFinalizations.runId, f.runId));
      const before = await issue(f.issueId);
      await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
      expect(await comments(f.runId)).toEqual([]); expect(await issue(f.issueId)).toEqual(before);
    },
  );
  it.each([false, true])("preserves a selected reply without replacing or resurrecting it (deleted=%s)", async deleted => {
    const f = await fixture();
    const [saved] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      createdByRunId: f.runId, body: "Already selected", ...(deleted ? { deletedAt: new Date("2020-01-01T00:03:00Z") } : {}) }).returning();
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentId: saved.id, commentAction: "create" } } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
    expect(await comments(f.runId)).toEqual([saved]);
  });
  it("never crosses company scope and keeps ordinary internal task response recovery intact", async () => {
    const f = await fixture(false);
    await expect(recoverCommittedNativeChatResponse(db, { ...f.input, companyId: randomUUID() })).resolves.toBe(false);
    const work = nativeResponsePresentationWork(db), entries = await work.load(f.input);
    expect(entries).toHaveLength(1); await expect(work.check(entries[0])).resolves.toBeNull();
    expect(await comments(f.runId)).toEqual([expect.objectContaining({ body: f.reply })]);
    expect((await issue(f.issueId)).conversationAgentId).toBeNull();
  });
  it("rolls back a partial reply write without changing the waiting state or consuming recovery", async () => {
    const f = await fixture(), abort = new Error("fixture-commit-aborted");
    const failing = new Proxy(db, { get(target, key) { return key === "transaction"
      ? (callback: Parameters<Db["transaction"]>[0]) => db.transaction(async tx => { await callback(tx); throw abort; })
      : Reflect.get(target, key); } });
    await expect(recoverCommittedNativeChatResponse(failing, f.input)).rejects.toBe(abort);
    expect(await comments(f.runId)).toEqual([]);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_progress", conversationState: "active" });
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(true);
    expect(await comments(f.runId)).toHaveLength(1);
  });
});
