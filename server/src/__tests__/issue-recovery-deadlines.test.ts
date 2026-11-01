import { createServer } from "node:http";
import { setImmediate as immediate } from "node:timers/promises";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueRecoveryActions, issueRelations, issues, issueWatchdogs, issueComments } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { undeliveredConversationComments } from "../services/agent-conversations.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { issueService } from "../services/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { registerIssueRecoveryWork } from "../services/recovery/work.js";
import { notifyIssueRecovery } from "../services/issue-recovery-notifications.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";

vi.setConfig({ testTimeout: 90_000 });

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ISSUE_RECOVERY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("issue recovery production producers and deadlines", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  let worker: ReturnType<ReturnType<typeof heartbeatService>["registerIssueStateRecoveryWork"]>;
  let dispatch: ReturnType<ReturnType<typeof heartbeatService>["registerRunDispatchWork"]>;
  let cancellation: ReturnType<ReturnType<typeof heartbeatService>["registerScheduledRetryCancellationWork"]>;
  let draining = false;
  const tasks = new Map<string, { nextRunAt?: () => number | null; hasPending: () => Promise<boolean> }>();
  const errors: unknown[] = [];
  const passes = new Set<Promise<unknown>>();
  const extraStops: Array<() => Promise<void>> = [];
  const extraDeadlines: Array<() => number | null> = [];
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("issue-recovery-work-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
  }, 90_000);
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
    heartbeat = heartbeatService(db); draining = false; errors.length = 0;
  });
  afterEach(async () => {
    for (const stop of extraStops.splice(0)) await stop();
    extraDeadlines.length = 0;
    await worker?.stop(); await dispatch?.stop(); await cancellation?.stop(); await coordinator?.stop();
    await heartbeat.drainActiveRunExecutions();
    vi.useRealTimers(); vi.restoreAllMocks();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true,
      onError: error => errors.push(error) });
    tasks.clear();
    const register = coordinator.register.bind(coordinator);
    coordinator.register = (queue, task) => {
      tasks.set(queue, task);
      return register(queue, { ...task, run: signal => {
        const work = task.run(signal); passes.add(work);
        void work.then(() => passes.delete(work), () => passes.delete(work));
        return work;
      } });
    };
    worker = heartbeat.registerIssueStateRecoveryWork(coordinator, () => !draining);
    dispatch = heartbeat.registerRunDispatchWork(coordinator, () => !draining);
    cancellation = heartbeat.registerScheduledRetryCancellationWork(coordinator, () => !draining);
    await Promise.all([worker.ready, dispatch.ready, cancellation.ready]);
  }
  async function compete() {
    const other = heartbeatService(db);
    const competing = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const register = competing.register.bind(competing);
    competing.register = (queue, task) => register(queue, { ...task, run: signal => {
      const pass = task.run(signal); passes.add(pass);
      void pass.then(() => passes.delete(pass), () => passes.delete(pass));
      return pass;
    } });
    const work = other.registerIssueStateRecoveryWork(competing, () => true);
    extraStops.push(() => competing.stop()); extraDeadlines.push(competing.nextWakeAt); await work.ready;
  }
  async function fixture() {
    const companyId = randomUUID();
    await db.insert(authUsers).values({ id: "recovery-user", name: "Recovery operator", email: "recovery-user@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: `R${companyId.slice(0, 7)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "recovery-user" });
    await db.insert(companyMemberships).values({ companyId, principalId: "recovery-user", principalType: "user", status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Recovery process", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "console.log('recovery-proof')"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } },
    }).returning();
    return { companyId, agentId: agent.id };
  }
  async function completingProvider(f: { companyId: string; agentId: string }, beforeComplete?: () => Promise<unknown>) {
    const failures: unknown[] = [];
    const listener = createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        const { runId } = JSON.parse(body) as { runId: string };
        const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
          eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)));
        if (!run?.contextSnapshot?.issueId) throw new Error("Unknown controlled task run");
        await beforeComplete?.();
        await issueService(db).update(String(run.contextSnapshot.issueId), { status: "done" });
        response.end("ok");
      } catch (error) { failures.push(error); response.statusCode = 500; response.end("completion failed"); }
    });
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    extraStops.push(async () => { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); });
    const port = (listener.address() as { port: number }).port;
    const script = `fetch("http://127.0.0.1:${port}/complete", {method:"POST", body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async response=>{if(!response.ok)throw new Error(await response.text());console.log("recovery-proof")}).catch(error=>{console.error(error);process.exitCode=1})`;
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script], cwd: process.cwd() } })
      .where(eq(agents.id, f.agentId));
    return failures;
  }
  async function settled() {
    await vi.waitFor(async () => {
      await Promise.allSettled([...passes]);
      await heartbeat.drainActiveRunExecutions();
      const wake = coordinator.nextWakeAt();
      const detail = wake === null ? "" : JSON.stringify({ now: Date.now(), tasks: await Promise.all([...tasks].map(async ([queue, task]) => ({ queue, at: task.nextRunAt?.(), pending: await task.hasPending() }))),
        runs: (await db.select().from(heartbeatRuns)).map(run => ({ id: run.id, status: run.status, error: run.errorCode, lease: run.controllerLeaseExpiresAt, reason: run.contextSnapshot?.wakeReason })) });
      expect(wake, detail).toBeNull();
      expect(extraDeadlines.map(next => next())).toEqual(extraDeadlines.map(() => null));
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 40_000 });
  }
  async function quiet() {
    await settled();
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.status} in ('queued', 'running')`)).toHaveLength(0);
    const reads = vi.spyOn(db, "select"); const executes = vi.spyOn(db, "execute");
    const selected = reads.mock.calls.length, executed = executes.mock.calls.length;
    const statements: string[] = [], priorDebug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { statements.push(query); };
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(reads).toHaveBeenCalledTimes(selected); expect(executes).toHaveBeenCalledTimes(executed);
      expect(statements).toEqual([]);
    } finally { vi.useRealTimers(); db.$client.options.debug = priorDebug; reads.mockRestore(); executes.mockRestore(); }
  }
  async function finish(issueId: string) {
    const retries = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.status, "scheduled_retry"),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`));
    const before = await retries();
    await issueService(db).update(issueId, { status: "done" });
    // Closing one blocker can legitimately start its dependent. Wait for this
    // task's dispatch and execution; quiet() verifies the whole fixture later.
    await vi.waitFor(async () => {
      await Promise.allSettled([...passes]);
      await heartbeat.drainActiveRunExecutions();
      expect(await db.select().from(heartbeatRuns).where(and(
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
        sql`${heartbeatRuns.status} in ('queued', 'running')`,
      ))).toHaveLength(0);
    }, { timeout: 15_000 });
    const saved = [...new Map([...before, ...await retries()].map(run => [run.id, run])).values()];
    if (saved.length > 0) {
      const trace: unknown[] = [];
      await vi.waitFor(async () => {
        await Promise.allSettled([...passes]);
        await heartbeat.drainActiveRunExecutions();
        const remaining = await retries();
        if (remaining.length > 0) trace.push({ now: Date.now(),
          deadlines: [coordinator.nextWakeAt(), ...extraDeadlines.map(next => next())],
          remaining: remaining.map(run => ({ id: run.id, at: run.scheduledRetryAt })) });
        expect(remaining, JSON.stringify(trace)).toHaveLength(0);
      }, { timeout: Math.max(...saved.map(run => run.scheduledRetryAt!.getTime())) - Date.now() + 30_000 });
      for (const retry of saved) {
        const [settledRetry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id));
        expect(settledRetry.status).toBe("cancelled");
      }
    }
  }
  async function completed(issueId: string) {
    let runId: string | undefined;
    await vi.waitFor(async () => {
      const runs = await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`);
      const run = runs.find(row => row.status === "running" || row.status === "succeeded");
      expect(run).toBeDefined(); runId = run!.id;
    }, { timeout: 15_000 });
    await vi.waitFor(async () => {
      await heartbeat.drainActiveRunExecutions();
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
      expect(current.status, JSON.stringify({ error: current.error, code: current.errorCode, stderr: current.stderrExcerpt })).toBe("succeeded");
    }, { timeout: 15_000 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
    expect(run.stdoutExcerpt).toContain("recovery-proof");
    return run;
  }
  async function savedConversation(withMessage = true) {
    const f = await fixture(), settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAgentChat: true, enableConferenceRoomChat: false });
    const replies: string[] = [], failures: unknown[] = [];
    const listener = createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        const { runId } = JSON.parse(body) as { runId: string };
        const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
          eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)));
        if (!run) throw new Error("Unknown controlled conversation run");
        await issueService(db).addComment(String(run.contextSnapshot?.issueId), "Saved chat delivered", {
          agentId: f.agentId, runId: run.id,
        });
        replies.push(run.id); response.end("ok");
      } catch (error) { failures.push(error); response.statusCode = 500; response.end("controlled reply failed"); }
    });
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    extraStops.push(async () => { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); });
    const port = (listener.address() as { port: number }).port;
    const script = `fetch("http://127.0.0.1:${port}/reply", {method:"POST", body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async response=>{if(!response.ok)throw new Error(await response.text());console.log("recovery-proof")}).catch(error=>{console.error(error);process.exitCode=1})`;
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script], cwd: process.cwd() } })
      .where(eq(agents.id, f.agentId));
    const chat = await issueService(db).create(f.companyId, { title: "Saved conversation", status: "in_review",
      conversationAgentId: f.agentId, conversationUserId: "recovery-user", assigneeAgentId: f.agentId,
      conversationState: "waiting" });
    const message = withMessage ? await issueService(db).addComment(chat.id, "Keep this message", { userId: "recovery-user" }, { clientRequestId: randomUUID() }) : null;
    await settings.updateExperimental({ enableAgentChat: false });
    await start(); await quiet();
    expect(replies).toEqual([]);
    return { ...f, settings, chat, message, replies, failures };
  }
  it("dispatches a saved conversation only from the committed Agent Chat enable transition", async () => {
    const f = await savedConversation();
    expect(await undeliveredConversationComments(db, f.companyId, f.chat.id)).toHaveLength(1);
    await f.settings.updateExperimental({ enableAgentChat: true });
    expect(coordinator.nextWakeAt()).not.toBeNull();
    await vi.waitFor(async () => expect(await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1), { timeout: 40_000 });
    const run = await completed(f.chat.id);
    expect(f.replies).toEqual([run.id]); expect(f.failures).toEqual([]);
    expect(await undeliveredConversationComments(db, f.companyId, f.chat.id)).toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.id, f.chat.id)))[0])
      .toMatchObject({ conversationState: "waiting", executionRunId: null });
    expect(await db.select().from(issueComments).where(and(eq(issueComments.createdByRunId, run.id),
      eq(issueComments.authorAgentId, f.agentId)))).toHaveLength(1);
    await quiet();
    let hints = 0;
    const stop = subscribeDeliveryWork(db, DELIVERY_QUEUES.strandedAssignments, () => { hints++; });
    try { await f.settings.updateExperimental({ enableAgentChat: true }); expect(hints).toBe(0); await quiet(); }
    finally { stop(); }
    expect(f.replies).toEqual([run.id]);
  });
  it("keeps disabled saved conversations parked after rollback, unrelated flags and unchanged values", async () => {
    const f = await savedConversation();
    await expect(db.transaction(async tx => {
      await instanceSettingsService(tx as unknown as typeof db).updateExperimental({ enableAgentChat: true });
      throw new Error("chat flag rollback");
    })).rejects.toThrow("chat flag rollback");
    await quiet();
    expect((await f.settings.getExperimental()).enableAgentChat).toBe(false);
    let hints = 0;
    const stop = subscribeDeliveryWork(db, DELIVERY_QUEUES.strandedAssignments, () => { hints++; });
    try {
      await f.settings.updateExperimental({ enableConferenceRoomChat: true });
      await f.settings.updateExperimental({ enableAgentChat: false });
      expect(hints).toBe(0); await quiet();
    } finally { stop(); }
    expect(f.replies).toEqual([]); expect(f.failures).toEqual([]);
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
    expect(await undeliveredConversationComments(db, f.companyId, f.chat.id)).toHaveLength(1);
  });
  it("does not dispatch an accepted saved message after Agent Chat is disabled", async () => {
    const f = await savedConversation(false);
    await f.settings.updateExperimental({ enableAgentChat: true }); await quiet();
    draining = true;
    await issueService(db).addComment(f.chat.id, "Retain while disabled", { userId: "recovery-user" }, { clientRequestId: randomUUID() });
    let hints = 0;
    const stop = subscribeDeliveryWork(db, DELIVERY_QUEUES.strandedAssignments, () => { hints++; });
    try { await f.settings.updateExperimental({ enableAgentChat: false }); expect(hints).toBe(0); }
    finally { stop(); }
    draining = false; await quiet();
    expect(f.replies).toEqual([]); expect(f.failures).toEqual([]);
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
    expect(await undeliveredConversationComments(db, f.companyId, f.chat.id)).toHaveLength(1);
  });
  it("keeps empty, configured idle, and terminal history quiet", async () => {
    await fixture(); await start(); await quiet();
  });
  it("creates a blocking child through the ordinary root service transaction", async () => {
    const f = await fixture();
    const parent = await issueService(db).create(f.companyId, { title: "Parent", status: "todo" });
    const child = await issueService(db).createChild(parent.id, { title: "Blocking child", status: "todo", blockParentUntilDone: true });
    expect(child.parentBlockerAdded).toBe(true);
    expect(await db.select().from(issueRelations).where(and(eq(issueRelations.companyId, f.companyId),
      eq(issueRelations.issueId, child.issue.id), eq(issueRelations.relatedIssueId, parent.id)))).toHaveLength(1);
  });
  it.each(["startup", "committed"])("restores blocker-only and completed-action debt with no assignment candidates (%s)", async mode => {
    const f = await fixture();
    if (mode === "committed") { await start(); await quiet(); }
    const blocker = await issueService(db).create(f.companyId, { title: "Orphan blocker", status: "blocked", createdByAgentId: f.agentId });
    const dependent = await issueService(db).create(f.companyId, { title: "Blocked dependent", status: "blocked", blockedByIssueIds: [blocker.id] });
    const completedSource = await issueService(db).create(f.companyId, { title: "Completed source", status: "done" });
    const action = await issueRecoveryActionService(db).upsertSourceScoped({ companyId: f.companyId, sourceIssueId: completedSource.id,
      kind: "stranded_assigned_issue", ownerType: "agent", ownerAgentId: f.agentId, cause: "stranded_assigned_issue",
      fingerprint: "source-terminal", nextAction: "Restore work", wakePolicy: { type: "wake_owner" }, evidence: {} });
    if (mode === "startup") await start();
    await vi.waitFor(async () => {
      expect((await db.select().from(issues).where(eq(issues.id, blocker.id)))[0].assigneeAgentId).toBe(f.agentId);
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0].status).toBe("resolved");
    }, { timeout: 40_000 });
    await finish(blocker.id); await finish(dependent.id); await quiet();
  });
  it("bounds subsidiary scans for100 assignment candidates and coalesces repeated company writes", async () => {
    const f = await fixture(), foreign = await fixture();
    await db.update(agents).set({ lifecycleState: "preparing" }).where(eq(agents.id, f.agentId));
    await db.insert(issues).values(Array.from({ length: 100 }, (_, index) => ({ companyId: f.companyId,
      title: `Waiting setup ${index}`, status: "todo", assigneeAgentId: f.agentId })));
    const [source] = await db.insert(issues).values({ companyId: f.companyId, title: "Done source", status: "done" }).returning();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({ companyId: f.companyId, sourceIssueId: source.id,
      kind: "stranded_assigned_issue", ownerType: "agent", ownerAgentId: f.agentId, cause: "stranded_assigned_issue",
      fingerprint: "query-budget", nextAction: "Restore work", wakePolicy: { type: "wake_owner" }, evidence: {} });
    const scans = { blockers: 0, actions: 0, loads: 0 };
    const originalSelect = db.select.bind(db);
    vi.spyOn(db, "select").mockImplementation(((fields?: Record<string, unknown>) => {
      const query = originalSelect(fields as never); const from = query.from.bind(query);
      query.from = ((table: unknown) => {
        if (table === issues && fields?.id === issues.id && fields.companyId === issues.companyId && Object.keys(fields).length === 2) scans.loads++;
        if (table === issueRelations && fields?.createdByAgentId === issues.createdByAgentId) scans.blockers++;
        if (table === issueRecoveryActions && fields?.action === issueRecoveryActions) scans.actions++;
        return from(table as never);
      }) as typeof query.from;
      return query;
    }) as typeof db.select);
    await start(); await settled();
    expect(scans.actions).toBe(1); expect(scans.blockers).toBe(0); expect(scans.loads).toBeLessThanOrEqual(8);
    expect((await originalSelect().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0].status).toBe("resolved");
    const [foreignSource] = await db.insert(issues).values({ companyId: foreign.companyId, title: "Foreign done", status: "done" }).returning();
    const [foreignAction] = await db.insert(issueRecoveryActions).values({ companyId: foreign.companyId, sourceIssueId: foreignSource.id,
      kind: "stranded_assigned_issue", ownerType: "board", cause: "stranded_assigned_issue", fingerprint: "foreign-query-budget", nextAction: "Inspect" }).returning();
    const before = { ...scans };
    for (let index = 0; index < 100; index++) await db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.companyId }));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(scans.loads).toBe(before.loads);
    await settled();
    expect(scans.actions).toBe(before.actions); expect(scans.blockers).toBe(before.blockers);
    expect(scans.loads).toBeLessThanOrEqual(before.loads + 4);
    expect((await originalSelect().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, foreignAction.id)))[0].status).toBe("active");
    expect(await originalSelect().from(heartbeatRuns)).toHaveLength(0); await quiet();
  });
  it("limits an ordinary comment to its issue among one thousand open assignments", async () => {
    const f = await fixture();
    const rows = await db.insert(issues).values(Array.from({ length: 1000 }, (_, index) => ({
      companyId: f.companyId, title: `Open work ${index}`, status: "todo", assigneeAgentId: f.agentId,
    }))).returning({ id: issues.id });
    const checked: string[] = [];
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const register = coordinator.register.bind(coordinator);
    coordinator.register = (queue, task) => register(queue, { ...task, run: signal => {
      const pass = task.run(signal); passes.add(pass);
      void pass.then(() => passes.delete(pass), () => passes.delete(pass));
      return pass;
    } });
    // Observe the actual paged reconstruction boundary without executing one
    // thousand adapters. The producer, transaction, coordinator and SQL are real;
    // the other acceptance cases exercise the resulting recovery decisions.
    worker = registerIssueRecoveryWork(db, coordinator, {
      stranded: async scope => { checked.push(scope.issueId); },
      orphanBlockers: async () => {}, recoveryActions: async () => {},
      dependencies: async () => ({ enqueueFailed: 0 }), locks: async () => {},
      watchdogs: async () => ({ incomplete: 0 }), schedulingSuppressed: async () => false,
    }, () => true);
    await worker.ready;
    async function settleWork() {
      for (let step = 0; step < 120; step++) {
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.allSettled([...passes]); await immediate();
        if (coordinator.nextWakeAt() === null && idleWorkSnapshot().active === 0) return;
      }
      throw new Error("Recovery did not settle its committed work within two virtual minutes");
    }
    await settleWork();
    expect(new Set(checked).size).toBe(1000);
    checked.length = 0;
    await issueService(db).addComment(rows[0].id, "New evidence on this task", { userId: "recovery-user" });
    await settleWork();
    expect(checked).toEqual([rows[0].id]);
    // Company eligibility changes still reconstruct all assignments. Narrowing
    // comment hints must not hide unrelated work after an operator resumes it.
    checked.length = 0;
    await db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.companyId }));
    await settleWork();
    expect(new Set(checked).size).toBe(1000);
    await quiet();
  });
  it("dispatches an ordinary new assignment after commit and returns to quiet after completion", async () => {
    const f = await fixture(); await start(); await quiet();
    const issue = await issueService(db).create(f.companyId, { title: "Recover assignment", status: "todo", assigneeAgentId: f.agentId });
    await completed(issue.id);
    await finish(issue.id); await quiet();
  }, 90_000);
  it("reacts to blocker resolution once and dispatches the durable dependency wake", async () => {
    const f = await fixture();
    const blocker = await issueService(db).create(f.companyId, { title: "Blocker", status: "todo" });
    const dependent = await issueService(db).create(f.companyId, { title: "Dependent", status: "blocked", assigneeAgentId: f.agentId,
      blockedByIssueIds: [blocker.id] });
    const failures = await completingProvider(f);
    await start(); await quiet();
    await compete();
    await issueService(db).update(blocker.id, { status: "done" });
    const run = await completed(dependent.id);
    expect(run.contextSnapshot?.wakeReason).toBe("issue_blockers_resolved");
    expect(failures).toEqual([]);
    await finish(dependent.id); await quiet();
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'issue_blockers_resolved'`))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  }, 90_000);
  it("settles saved disposition debt on its original real-clock timers before measuring idle", async () => {
    const f = await fixture();
    const blocker = await issueService(db).create(f.companyId, { title: "Saved debt blocker", status: "todo" });
    const issue = await issueService(db).create(f.companyId, { title: "Saved disposition debt", status: "blocked",
      assigneeAgentId: f.agentId, blockedByIssueIds: [blocker.id] });
    await start(); await compete();
    await issueService(db).update(blocker.id, { status: "done" });
    await completed(issue.id);
    let retryId: string | undefined;
    await vi.waitFor(async () => {
      const [retry] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.status, "scheduled_retry"),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`));
      expect(retry).toBeDefined(); retryId = retry!.id;
    }, { timeout: 40_000 });
    await finish(issue.id); await quiet();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId!)))[0].status).toBe("cancelled");
  }, 120_000);
  it("uses ordinary watchdog configuration and subtree closure to dispatch a reusable review", async () => {
    const f = await fixture();
    const source = await issueService(db).create(f.companyId, { title: "Finished subtree", status: "done" });
    const failures = await completingProvider(f, () => taskWatchdogService(db).disableForIssue(f.companyId, source.id));
    await start(); await quiet();
    await compete();
    const watchdog = await taskWatchdogService(db).upsertForIssue(f.companyId, source.id, { agentId: f.agentId });
    let reviewId: string | undefined;
    await vi.waitFor(async () => {
      const [row] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, watchdog.watchdog.id));
      expect(row.watchdogIssueId).toBeTruthy(); reviewId = row.watchdogIssueId!;
    }, { timeout: 15_000 });
    await completed(reviewId!);
    expect(failures).toEqual([]);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'task_watchdog_stopped_subtree'`))).toHaveLength(1);
    await finish(reviewId!);
    await taskWatchdogService(db).disableForIssue(f.companyId, source.id);
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); await quiet();
  }, 90_000);
  it("bounds ordinary writes to their company and reconstructs foreign stale debt after restart", async () => {
    const selected = await fixture(); await start(); await quiet();
    const foreign = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: foreign.companyId, agentId: foreign.agentId,
      status: "failed", finishedAt: new Date() }).returning();
    const [stale] = await db.insert(issues).values({ companyId: foreign.companyId, title: "Foreign stale lock", status: "done",
      checkoutRunId: run.id }).returning();
    await issueService(db).create(selected.companyId, { title: "Selected change", status: "done" }); await quiet();
    expect((await db.select().from(issues).where(eq(issues.id, stale.id)))[0].checkoutRunId).toBe(run.id);
    await worker.stop(); await dispatch.stop(); await cancellation.stop(); await coordinator.stop();
    heartbeat = heartbeatService(db); await start(); await quiet();
    expect((await db.select().from(issues).where(eq(issues.id, stale.id)))[0].checkoutRunId).toBeNull();
  });
  it("fences nested assignment writes until outer commit and ignores rollback", async () => {
    const f = await fixture(); await start(); await quiet();
    let committedId = "";
    await db.transaction(async outer => {
      await outer.transaction(async nested => {
        const issue = await issueService(db).create(f.companyId, { title: "Nested commit", status: "todo", assigneeAgentId: f.agentId }, nested);
        committedId = issue.id;
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    });
    await completed(committedId); await finish(committedId); await settled();
    await expect(db.transaction(async outer => {
      await outer.transaction(async nested => {
        await issueService(db).create(f.companyId, { title: "Nested rollback", status: "todo", assigneeAgentId: f.agentId }, nested);
      });
      throw new Error("rollback control");
    })).rejects.toThrow("rollback control");
    await quiet();
    expect(await db.select().from(issues).where(eq(issues.title, "Nested rollback"))).toHaveLength(0);
  }, 90_000);
  it("retains the first committed assignment during drain and executes on resume", async () => {
    const f = await fixture(); await start(); await quiet(); draining = true;
    const issue = await issueService(db).create(f.companyId, { title: "Drained assignment", status: "todo", assigneeAgentId: f.agentId });
    await new Promise(resolve => setTimeout(resolve, 100));
    const reads = vi.spyOn(db, "select");
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try { await vi.advanceTimersByTimeAsync(90_000); expect(reads).not.toHaveBeenCalled(); }
    finally { vi.useRealTimers(); reads.mockRestore(); }
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    draining = false; worker.wake(); dispatch.wake();
    await completed(issue.id); await finish(issue.id); await quiet();
  }, 90_000);
  it("retains a fresh subtree's exact first-run grace then disarms on disable", async () => {
    const f = await fixture();
    const source = await issueService(db).create(f.companyId, { title: "Fresh unassigned subtree", status: "todo" });
    await start(); await quiet();
    await taskWatchdogService(db).upsertForIssue(f.companyId, source.id, { agentId: f.agentId });
    await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBe(source.createdAt.getTime() + 15_000), { timeout: 5_000 });
    expect(await db.select().from(issues).where(eq(issues.originKind, "task_watchdog"))).toHaveLength(0);
    await taskWatchdogService(db).disableForIssue(f.companyId, source.id);
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); await quiet();
  });
  it("waits for a live foreign controller's exact stored lease before clearing a terminal lock", async () => {
    const f = await fixture();
    const source = await issueService(db).create(f.companyId, { title: "Remote owner", status: "done" });
    const lease = new Date(Date.now() + 5_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: lease,
      contextSnapshot: { issueId: source.id }, processPid: 2_000_000_000, startedAt: new Date() }).returning();
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, source.id));
    await start();
    await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBe(lease.getTime()), { timeout: 3_000 });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("running");
    await vi.waitFor(async () => expect((await db.select().from(issues).where(eq(issues.id, source.id)))[0].executionRunId).toBeNull(), { timeout: 12_000 });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("succeeded");
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); await quiet();
  }, 90_000);
});
