import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
import { chatCompletionDeliveryService, existingChatCompletionReply } from "../chat-completion-delivery.js";
import { instanceSettingsService } from "../instance-settings.js";
import { issueService } from "../issues.js";
import * as nativeResponseNotifications from "../native-response-presentation-notifications.js";

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
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(and(eq(heartbeatRuns.id, f.runId), eq(heartbeatRuns.status, "succeeded")));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, source: "automation", wakeReason: "chat_task_completed",
      conversationMode: true, conversationSessionGeneration: 0, chatCompletionDeliveryIds: [deliveryId], chatCompletionUpdates: [{ taskId }] } })
      .where(eq(heartbeatRuns.id, f.runId));
    const wakeup = vi.fn(async (_agentId: string, options: { idempotencyKey: string }) => {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
        status: "skipped", reason: "heartbeat.daily_run_limit", idempotencyKey: options.idempotencyKey });
      return null;
    });
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      status: "completed", reason: "chat_task_completed", idempotencyKey: `chat-completion:${deliveryId}:0`, runId: f.runId });
    const delivery = async () => (await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.id, deliveryId)))[0];
    return { taskId, deliveryId, wakeup, delivery, service: chatCompletionDeliveryService(db, { wakeup }) };
  }

  it("preserves accepted native callback presentation when outbox retry runs first at the daily cap", async () => {
    const f = await fixture(), outbox = await completion(f);
    const work = nativeResponsePresentationWork(db);
    const [entry] = await work.load(f.input);
    expect(entry).toMatchObject({ id: f.runId });


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
      await quiet();
      const [comment] = await comments(f.runId);
      expect(comment).toMatchObject({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId });
      expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
      expect(await outbox.delivery()).toMatchObject({ status: "delivered", targetRunId: f.runId, attempts: 0, responseCommentId: comment.id });
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

  it.each(["reset-source", "reopened-task"])("keeps %s delivery supersession", async fault => {
    const f = await fixture(), outbox = await completion(f);
    if (fault === "reset-source") await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.issueId));
    else {
      await issueService(db).update(outbox.taskId, { status: "todo" });
      await issueService(db).update(outbox.taskId, { status: "done" });
      expect(await issue(outbox.taskId)).toMatchObject({ status: "done", statusVersion: 4 });
    }
    await outbox.service.deliver(outbox.deliveryId);
    expect(await outbox.delivery()).toMatchObject({ status: "superseded", attempts: 0, responseCommentId: null });
    expect(outbox.wakeup).not.toHaveBeenCalled();
    expect(await comments(f.runId)).toEqual([]);
  });

  it("lets an in-flight presentation acknowledge before expiry can retarget the delivery", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    const f = await fixture(), outbox = await completion(f);
    const suffix = randomUUID().replaceAll("-", ""), lockId = Number.parseInt(suffix.slice(0, 6), 16) + 1;
    const trigger = `completion_reply_hold_${suffix}`;
    let release!: () => void, acquired!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    let blocker: Promise<unknown> | undefined, presentation: Promise<unknown> | undefined, expiry: Promise<unknown> | undefined;
    try {
      await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$
        begin
          if NEW.created_by_run_id = '${f.runId}'::uuid then perform pg_advisory_xact_lock(${lockId}); end if;
          return NEW;
        end $$`));
      await db.execute(sql.raw(`create trigger ${trigger} before insert on issue_comments for each row execute function ${trigger}()`));
      blocker = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(${lockId}::bigint)`); acquired(); await hold; });
      await Promise.race([locked, blocker]);
      const work = nativeResponsePresentationWork(db), [entry] = await work.load(f.input);
      presentation = work.check(entry); void presentation.catch(() => undefined);


      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select exists (select 1 from pg_locks
          where locktype = 'advisory' and classid = 0 and objid = ${lockId}::oid and not granted
            and database = (select oid from pg_database where datname = current_database())) as waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 5000 });
      vi.setSystemTime(started + 300_000);
      let expirySettled = false;
      expiry = outbox.service.deliver(outbox.deliveryId).then(() => { expirySettled = true; });
      void expiry.catch(() => undefined);
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select exists (select 1 from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and query like '%from "issues"%' and query like '%for update%') as waiting`);
        expect(expirySettled || row.waiting).toBe(true);
      }, { timeout: 5000 });
      expect(expirySettled).toBe(false);
      expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0, responseCommentId: null });
      release(); await blocker; await presentation; await expiry;
      const [comment] = await comments(f.runId);
      expect(comment).toMatchObject({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId });
      expect(await comments(f.runId)).toHaveLength(1);
      expect(await outbox.delivery()).toMatchObject({ status: "delivered", targetRunId: f.runId, attempts: 0, responseCommentId: comment.id });
      expect(outbox.wakeup).not.toHaveBeenCalled();
      expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
    } finally {
      release?.(); await Promise.allSettled([blocker, presentation, expiry].filter((value): value is Promise<unknown> => Boolean(value)));
      await db.execute(sql.raw(`drop trigger if exists ${trigger} on issue_comments`));
      await db.execute(sql.raw(`drop function if exists ${trigger}()`));
      vi.useRealTimers();
    }
  });

  it("lets expiry win before presentation and releases the child lock before wake admission", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f), lockErrors: unknown[] = [];
      const work = nativeResponsePresentationWork(db), [entry] = await work.load(f.input);
      vi.setSystemTime(started + 300_000);
      const wakeup = vi.fn(async (agentId: string, options: { idempotencyKey: string }) => {
        try {
          await db.transaction(async tx => {
            await tx.execute(sql`set local lock_timeout = '500ms'`);
            await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
            await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, outbox.taskId)).for("update");
          });
        } catch (error) { lockErrors.push(error); throw error; }
        return outbox.wakeup(agentId, options);
      });
      await chatCompletionDeliveryService(db, { wakeup }).deliver(outbox.deliveryId);
      expect(lockErrors).toEqual([]);
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1, responseCommentId: null });
      await expect(work.check(entry)).rejects.toThrow("chat_completion_superseded");
      expect(await comments(f.runId)).toEqual([]);
      expect(await issue(outbox.taskId)).toMatchObject({ status: "done", statusVersion: 2 });
    } finally { vi.useRealTimers(); }
  });

  it("rolls back an expiry transition without waking or losing the original target", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f);
      vi.setSystemTime(started + 300_000);
      const rollback = new Error("fixture-expiry-rollback");
      const connection = new Proxy(db, { get(target, key) {
        return key === "transaction" ? async (callback: Parameters<Db["transaction"]>[0]) => target.transaction(async tx => {
          await callback(tx); throw rollback;
        }) : Reflect.get(target, key);
      } });
      await chatCompletionDeliveryService(connection, { wakeup: outbox.wakeup }).deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0, responseCommentId: null,
        error: rollback.message });
      expect(outbox.wakeup).not.toHaveBeenCalled();
      expect(await comments(f.runId)).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it.each(["new-claim", "delivered", "retargeted", "superseded"])("respects a %s winner while expiry waits for the child lock", async winner => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    const f = await fixture(), outbox = await completion(f);
    const replacementId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: replacementId, companyId: f.companyId, agentId: f.agentId, status: "queued" });
    let release!: () => void, acquired!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
    const blocker = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, outbox.taskId)).for("update"); acquired(); await hold;
      if (winner === "delivered") await tx.update(chatCompletionDeliveries).set({ status: "delivered" }).where(eq(chatCompletionDeliveries.id, outbox.deliveryId));
      if (winner === "retargeted") await tx.update(chatCompletionDeliveries).set({ targetRunId: replacementId, attempts: 1 })
        .where(eq(chatCompletionDeliveries.id, outbox.deliveryId));
      if (winner === "superseded") {
        await tx.update(issues).set({ status: "todo", statusVersion: 3 }).where(eq(issues.id, outbox.taskId));
        await tx.update(chatCompletionDeliveries).set({ status: "superseded" }).where(eq(chatCompletionDeliveries.id, outbox.deliveryId));
      }
    });
    const waiting = async (count: number) => vi.waitFor(async () => {
      const [row] = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
          and query like '%from "issues"%' and query like '%for update%'`);
      expect(row.waiting).toBeGreaterThanOrEqual(count);
    }, { timeout: 5000 });
    try {
      await Promise.race([locked, blocker]);
      vi.setSystemTime(started + 300_000);
      first = outbox.service.deliver(outbox.deliveryId); void first.catch(() => undefined);
      await waiting(1);
      if (winner === "new-claim") {
        vi.setSystemTime(started + 360_000);
        second = outbox.service.deliver(outbox.deliveryId); void second.catch(() => undefined);
        await waiting(2);
      }
      release(); await blocker; await first; await second;
      if (winner === "new-claim") {
        expect(outbox.wakeup).toHaveBeenCalledTimes(1);
        expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1 });
      } else {
        expect(outbox.wakeup).not.toHaveBeenCalled();
        if (winner === "delivered") expect((await outbox.delivery()).status).toBe("delivered");
        if (winner === "retargeted") expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: replacementId, attempts: 1 });
        if (winner === "superseded") expect((await outbox.delivery()).status).toBe("superseded");
      }
      expect(await comments(f.runId)).toEqual([]);
    } finally {
      release?.(); await Promise.allSettled([blocker, first, second].filter((value): value is Promise<unknown> => Boolean(value)));
      vi.useRealTimers();
    }
  });

  it("rechecks the fresh delivery when retry holds the child lock before presentation reads", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    const f = await fixture(), outbox = await completion(f);
    const suffix = randomUUID().replaceAll("-", ""), lockId = Number.parseInt(suffix.slice(0, 6), 16) + 1;
    const trigger = `completion_retry_hold_${suffix}`;
    let release!: () => void, acquired!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    let blocker: Promise<unknown> | undefined, presentation: Promise<unknown> | undefined, expiry: Promise<unknown> | undefined;
    try {
      await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$
        begin
          if OLD.id = '${outbox.deliveryId}'::uuid and NEW.target_run_id is null then perform pg_advisory_xact_lock(${lockId}); end if;
          return NEW;
        end $$`));
      await db.execute(sql.raw(`create trigger ${trigger} before update of target_run_id on chat_completion_deliveries for each row execute function ${trigger}()`));
      blocker = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(${lockId}::bigint)`); acquired(); await hold; });
      await Promise.race([locked, blocker]);
      const work = nativeResponsePresentationWork(db), [entry] = await work.load(f.input);
      vi.setSystemTime(started + 300_000);
      expiry = outbox.service.deliver(outbox.deliveryId); void expiry.catch(() => undefined);


      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select exists (select 1 from pg_locks
          where locktype = 'advisory' and classid = 0 and objid = ${lockId}::oid and not granted
            and database = (select oid from pg_database where datname = current_database())) as waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 5000 });
      presentation = work.check(entry); void presentation.catch(() => undefined);
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select exists (select 1 from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and query like '%from "issues"%' and query like '%for update%') as waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 5000 });
      release(); await blocker; await expiry;
      const [outcome] = await Promise.allSettled([presentation]);
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason.message).toBe("chat_completion_superseded");
      expect(await comments(f.runId)).toEqual([]);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1, responseCommentId: null });
      expect(outbox.wakeup).toHaveBeenCalledTimes(1);
    } finally {
      release?.(); await Promise.allSettled([blocker, presentation, expiry].filter((value): value is Promise<unknown> => Boolean(value)));
      await db.execute(sql.raw(`drop trigger if exists ${trigger} on chat_completion_deliveries`));
      await db.execute(sql.raw(`drop function if exists ${trigger}()`));
      vi.useRealTimers();
    }
  });

  it.each(["within-grace", "at-expiry"])("preserves a Done reassignment's completion event %s and still retries at expiry", async when => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f), reassignedAgent = randomUUID();
      await db.insert(agents).values({ id: reassignedAgent, companyId: f.companyId, name: "New task owner", adapterType: "paperclip_runner" });
      await db.update(nativeRunResults).set({ canonicalSha256: "invalid-digest" }).where(eq(nativeRunResults.runId, f.runId));
      await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(started + 120_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
      const updated = await issueService(db).update(outbox.taskId, { assigneeAgentId: reassignedAgent });
      expect(updated).toMatchObject({ status: "done", statusVersion: 3, assigneeAgentId: reassignedAgent });
      expect(await outbox.delivery()).toMatchObject({ status: "queued", statusVersion: 2, targetRunId: f.runId, attempts: 0 });
      if (when === "within-grace") {
        await outbox.service.deliver(outbox.deliveryId);
        expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0,
          nextAttemptAt: new Date(started + 120_000) });
        expect(outbox.wakeup).not.toHaveBeenCalled();
      }
      vi.setSystemTime(started + 300_000);
      await outbox.service.deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1, statusVersion: 2 });
      expect(await comments(f.runId)).toEqual([]);
      expect(outbox.wakeup).toHaveBeenCalledTimes(1);
      expect(await issue(outbox.taskId)).toMatchObject({ status: "done", statusVersion: 3, assigneeAgentId: reassignedAgent });
    } finally { vi.useRealTimers(); }
  });

  it("returns the fresh saved reply receipt after waiting for the child lock", async () => {
    const f = await fixture(), outbox = await completion(f);
    const [saved] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorAgentId: f.agentId, createdByRunId: f.runId, body: f.reply }).returning();
    let release!: () => void, acquired!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, outbox.taskId)).for("update"); acquired(); await hold;
      await tx.update(chatCompletionDeliveries).set({ status: "delivered", responseCommentId: saved.id })
        .where(eq(chatCompletionDeliveries.id, outbox.deliveryId));
    });
    let reader: Promise<Awaited<ReturnType<typeof existingChatCompletionReply>>> | undefined;
    try {
      await Promise.race([locked, blocker]);
      reader = db.transaction(tx => existingChatCompletionReply(tx, f.runId, f.issueId)); void reader.catch(() => undefined);
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select exists (select 1 from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and query like '%from "issues"%' and query like '%for update%') as waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 5000 });
      release(); await blocker;
      expect(await reader).toMatchObject({ id: saved.id, body: f.reply, createdByRunId: f.runId });
      expect(await comments(f.runId)).toHaveLength(1);
    } finally { release?.(); await Promise.allSettled([blocker, reader]); }
  });

  it("does not let an old hold shorten a newer claim's lease", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    const f = await fixture(), outbox = await completion(f);
    const notify = nativeResponseNotifications.notifyNativeResponsePresentation;
    let release!: () => void, notified!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { notified = resolve; });
    const spy = vi.spyOn(nativeResponseNotifications, "notifyNativeResponsePresentation").mockImplementationOnce(async (tx, scope) => {
      await notify(tx, scope); notified(); await hold;
    });
    let old: Promise<unknown> | undefined;
    try {


      old = outbox.service.deliver(outbox.deliveryId); void old.catch(() => undefined);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 5000 }); await ready;
      vi.setSystemTime(started + 60_000);
      await outbox.service.deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0,
        nextAttemptAt: new Date(started + 120_000) });
      release(); await old;
      expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0,
        nextAttemptAt: new Date(started + 120_000) });
      expect(outbox.wakeup).not.toHaveBeenCalled();
      expect(await comments(f.runId)).toEqual([]);
    } finally { release?.(); await Promise.allSettled(old ? [old] : []); spy.mockRestore(); vi.useRealTimers(); }
  });

  it("saves a legitimate delayed reply before the fixed limit without another model run", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f);
      for (const elapsed of [0, 60_000, 120_000, 240_000]) {
        vi.setSystemTime(started + elapsed);
        await outbox.service.deliver(outbox.deliveryId);
        expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0, responseCommentId: null });
        expect(outbox.wakeup).not.toHaveBeenCalled();
      }
      vi.setSystemTime(started + 299_999);
      const work = nativeResponsePresentationWork(db), [entry] = await work.load(f.input);
      await expect(work.check(entry)).resolves.toBeNull();
      const [comment] = await comments(f.runId);
      expect(comment).toMatchObject({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId });
      expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
      expect(await outbox.delivery()).toMatchObject({ status: "delivered", targetRunId: f.runId, attempts: 0, responseCommentId: comment.id });
      vi.setSystemTime(started + 300_000);
      await outbox.service.deliver(outbox.deliveryId);
      expect(await comments(f.runId)).toHaveLength(1);
      expect(outbox.wakeup).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("clamps an external native retry deadline to the immutable five-lease presentation limit", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f);
      await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(started + 86_400_000) })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      await outbox.service.deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0,
        nextAttemptAt: new Date(started + 300_000) });
      expect(outbox.wakeup).not.toHaveBeenCalled();
      expect(await comments(f.runId)).toEqual([]);
      vi.setSystemTime(started + 300_000);
      await outbox.service.deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1 });
      expect(outbox.wakeup).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it.each(["digest", "external-context"])("bounds permanent %s declines without sliding, publishing or changing accepted work", async fault => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f);
      if (fault === "digest") await db.update(nativeRunResults).set({ canonicalSha256: "invalid-digest" }).where(eq(nativeRunResults.runId, f.runId));
      else {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot, externalChatContinuation: true } }).where(eq(heartbeatRuns.id, f.runId));
      }
      const [acceptedBefore] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
      const work = nativeResponsePresentationWork(db), [entry] = await work.load(f.input);
      for (const elapsed of [0, 60_000, 120_000, 240_000]) {
        vi.setSystemTime(started + elapsed);
        await outbox.service.deliver(outbox.deliveryId);
        await expect(work.check(entry)).resolves.toBeNull();
        expect(await comments(f.runId)).toEqual([]);
        expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0,
          responseCommentId: null, nextAttemptAt: new Date(started + Math.min(elapsed + 60_000, 300_000)) });
        expect(outbox.wakeup).not.toHaveBeenCalled();
      }
      vi.setSystemTime(started + 299_999);
      await outbox.service.deliver(outbox.deliveryId);
      expect((await outbox.delivery()).nextAttemptAt).toEqual(new Date(started + 300_000));
      vi.setSystemTime(started + 300_000);
      await outbox.service.deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1, responseCommentId: null });
      expect(outbox.wakeup).toHaveBeenCalledTimes(1);
      expect(await comments(f.runId)).toEqual([]);
      expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId)))[0]).toEqual(acceptedBefore);
      expect(await issue(outbox.taskId)).toMatchObject({ status: "done", statusVersion: 2 });
    } finally { vi.useRealTimers(); }
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
