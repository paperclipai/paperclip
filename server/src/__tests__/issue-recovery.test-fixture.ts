import { createServer } from "node:http";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";

vi.setConfig({ testTimeout: 90_000 });

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ISSUE_RECOVERY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
export const describeIssueRecovery: ReturnType<typeof describe.skipIf> = describe.skipIf(!support.supported);

export function issueRecoveryFixture() {
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
  return {
    start, compete, fixture, completingProvider, settled, quiet, finish, completed, savedConversation,
    get db() { return db; },
    get heartbeat() { return heartbeat; },
    set heartbeat(value: typeof heartbeat) { heartbeat = value; },
    get coordinator() { return coordinator; },
    set coordinator(value: typeof coordinator) { coordinator = value; },
    get worker() { return worker; },
    set worker(value: typeof worker) { worker = value; },
    get dispatch() { return dispatch; },
    get cancellation() { return cancellation; },
    get draining() { return draining; },
    set draining(value: typeof draining) { draining = value; },
    get errors() { return errors; },
    get passes() { return passes; },
  };
}
