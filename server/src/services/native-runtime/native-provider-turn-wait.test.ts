import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, type Db, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { notifyDeferredExecutionWork } from "../deferred-execution-notifications.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../task-admission.js";
import {
  awaitPersonCommentDuringNativeRun, nativeProviderTurnWaitOptions, nativeProviderTurnWaitStartedAt, personCommentedDuringNativeRun,
  registerPersonCommentWaitWork,
} from "./native-provider-turn-wait.js";

const support = await getEmbeddedPostgresTestSupport();
const USER = "provider-turn-user";

describe.skipIf(!support.supported)("native provider-turn wait control-plane hooks", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<typeof registerPersonCommentWaitWork> | undefined;
  const errors: unknown[] = [];
  const controllers: AbortController[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-provider-turn-wait-");
    db = createDb(database.connectionString, { idleTimeoutSeconds: 0, connectTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  beforeEach(() => {
    errors.length = 0;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort(new Error("test ended"));
    worker?.stop(); await coordinator?.stop(); worker = undefined; coordinator = undefined;
    vi.useRealTimers();
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  type Scope = Parameters<typeof personCommentedDuringNativeRun>[1];
  async function start(read: (database: Db, scope: Scope) => Promise<boolean> = personCommentedDuringNativeRun) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => errors.push(error) });
    worker = registerPersonCommentWaitWork(db, coordinator, read);
    await worker.ready;
  }
  const settle = () => vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
  const unavailable = () => new Error("database unavailable");
  function wait(scope: Scope) {
    const abort = new AbortController();
    controllers.push(abort);
    const state = { ended: false, abort, promise: Promise.resolve() };
    state.promise = awaitPersonCommentDuringNativeRun(db, scope, abort.signal).then(() => { state.ended = true; });
    state.promise.catch(() => {});
    return state;
  }

  async function seed(startedAt = new Date()) {
    const [company] = await db.insert(companies).values({ name: "Provider turn", issuePrefix: `P${randomUUID().slice(0, 4)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Claude", adapterType: "paperclip_runner" }).returning();
    const issueId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, status: "running", runtimeMode: "native",
      runtimeModeResolvedAt: new Date(), nativeIssueId: issueId, responsibleUserId: USER, startedAt, contextSnapshot: { issueId } }).returning();
    await db.insert(issues).values({ id: issueId, companyId: company!.id, title: "Install and test", status: "in_progress",
      assigneeAgentId: agent!.id, executionRunId: run!.id });
    return { companyId: company!.id, agentId: agent!.id, issueId, runId: run!.id };
  }

  async function comment(f: Awaited<ReturnType<typeof seed>>, author: "user" | "agent", queued: boolean, createdAt?: Date) {
    const [saved] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      ...(author === "user" ? { authorType: "user", authorUserId: USER } : { authorType: "agent", authorAgentId: f.agentId }),
      body: "The install finished, please continue.", ...(createdAt ? { createdAt } : {}) }).returning();
    if (queued) {
      await db.transaction(async tx => {
        await notifyDeferredExecutionWork(tx, { companyId: f.companyId });
        await tx.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
          triggerDetail: "system", reason: "issue_commented", status: "deferred_issue_execution",
          requestedByActorType: "user", requestedByActorId: USER,
          payload: { issueId: f.issueId, commentId: saved!.id, _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId,
            wakeReason: "issue_commented", source: "issue.comment", wakeCommentId: saved!.id, wakeCommentIds: [saved!.id] } } });
      });
    }
    return saved!.id;
  }

  const prpTerminal = (f: Awaited<ReturnType<typeof seed>>, awaiting: boolean) => appendHeartbeatRunEvent(db, {
    companyId: f.companyId, runId: f.runId, agentId: f.agentId, eventType: "turn.completed", stream: "system", level: "info",
    message: "turn completed", payload: { prpEvent: { eventType: "turn.completed", turnId: "turn-1",
      payload: { status: "completed", error: null, ...(awaiting ? { awaitingProviderTurn: true } : {}) } } } });

  it("restores the wait clock from the first awaited terminal and has none for a previous release's run", async () => {
    const f = await seed();
    await prpTerminal(f, false);
    expect(await nativeProviderTurnWaitStartedAt(db, f)).toBeNull();
    await prpTerminal(f, true);
    const first = await nativeProviderTurnWaitStartedAt(db, f);
    expect(first).toEqual(expect.any(Number));
    await new Promise(resolve => setTimeout(resolve, 20));
    await prpTerminal(f, true);
    expect(await nativeProviderTurnWaitStartedAt(db, f)).toBe(first);
    expect((await nativeProviderTurnWaitOptions(db, f)).startedAtMs).toBe(first);
  });

  it("counts only a person's queued comment made during this run", async () => {
    const f = await seed(new Date(Date.now() - 60_000));
    await comment(f, "user", true, new Date(Date.now() - 120_000));
    await comment(f, "agent", true);
    await comment(f, "user", false);
    expect(await personCommentedDuringNativeRun(db, f)).toBe(false);
    await comment(f, "user", true);
    expect(await personCommentedDuringNativeRun(db, f)).toBe(true);
  });

  it("ends the wait when a person's comment is queued, through the deferred-wake notification", async () => {
    await start();
    const f = await seed();
    const abort = new AbortController();
    let ended = false;
    const waiting = awaitPersonCommentDuringNativeRun(db, f, abort.signal).then(() => { ended = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(ended).toBe(false);
    await comment(f, "user", true);
    await waiting;
    expect(ended).toBe(true);
  });

  it("stops listening when the wait ends for another reason", async () => {
    await start();
    const f = await seed();
    const abort = new AbortController();
    const waiting = awaitPersonCommentDuringNativeRun(db, f, abort.signal);
    abort.abort(new Error("wait ended"));
    await expect(waiting).rejects.toThrow("wait ended");
  });

  it("retries a failed read and finds a comment already queued, with no further notification", async () => {
    const f = await seed();
    await comment(f, "user", true);
    let failures = 1;
    const read = vi.fn(async (database: Db, scope: Scope) => {
      if (failures-- > 0) throw unavailable();
      return personCommentedDuringNativeRun(database, scope);
    });
    await start(read);
    const waiting = wait(f);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(waiting.ended).toBe(false);
    expect(coordinator!.nextWakeAt()! - Date.now()).toBeGreaterThan(4_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(waiting.ended).toBe(true), { timeout: 2_000 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("checks again after a wake that arrives during a failing read", async () => {
    const f = await seed();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = vi.fn(async (database: Db, scope: Scope) => {
      if (read.mock.calls.length === 1) { await gate; throw unavailable(); }
      return personCommentedDuringNativeRun(database, scope);
    });
    await start(read);
    const waiting = wait(f);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await comment(f, "user", true);
    release();
    await vi.waitFor(() => expect(waiting.ended).toBe(true), { timeout: 2_000 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not let one waiter's failing read hold back another, and resolves each only for its own comment", async () => {
    const a = await seed();
    const b = await seed();
    let broken = true;
    let checkedA = 0;
    const read = vi.fn(async (database: Db, scope: Scope) => {
      if (scope.runId === a.runId && broken) throw unavailable();
      const found = await personCommentedDuringNativeRun(database, scope);
      if (scope.runId === a.runId) checkedA += 1;
      return found;
    });
    await start(read);
    const waitingA = wait(a);
    const waitingB = wait(b);
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    await comment(b, "user", true);
    await vi.waitFor(() => expect(waitingB.ended).toBe(true), { timeout: 2_000 });
    expect(waitingA.ended).toBe(false);
    broken = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(checkedA).toBeGreaterThan(0), { timeout: 2_000 });
    expect(waitingA.ended).toBe(false);
    await comment(a, "user", true);
    await vi.waitFor(() => expect(waitingA.ended).toBe(true), { timeout: 2_000 });
  });

  it("checks a waiter that is added while a check is running", async () => {
    const first = await seed();
    const second = await seed();
    await comment(second, "user", true);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = vi.fn(async (database: Db, scope: Scope) => {
      if (scope.runId === first.runId) await gate;
      return personCommentedDuringNativeRun(database, scope);
    });
    await start(read);
    const waitingFirst = wait(first);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const waitingSecond = wait(second);
    release();
    await vi.waitFor(() => expect(waitingSecond.ended).toBe(true), { timeout: 2_000 });
    expect(read.mock.calls.map(([, scope]) => scope.runId)).toEqual([first.runId, second.runId]);
    expect(waitingFirst.ended).toBe(false);
  });

  it("removes an aborted waiter so nothing checks its scope again and no deadline remains", async () => {
    const f = await seed();
    const read = vi.fn(async (_database: Db, _scope: Scope) => { throw unavailable(); });
    await start(read);
    const abort = new AbortController();
    const waiting = awaitPersonCommentDuringNativeRun(db, f, abort.signal);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    const reason = new Error("wait ended");
    abort.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    await comment(f, "user", true);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    await vi.advanceTimersByTimeAsync(3_600_000);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(coordinator!.nextWakeAt()).toBeNull();
  });

  it("holds no deadline and runs no check while no waiter is owed a check", async () => {
    const f = await seed();
    const read = vi.fn(personCommentedDuringNativeRun);
    await start(read);
    expect(coordinator!.nextWakeAt()).toBeNull();
    wait(f);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await settle();
    expect(coordinator!.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(coordinator!.nextWakeAt()).toBeNull();
  });
});
