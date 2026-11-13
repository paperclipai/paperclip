import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, controllerInstances, controllerLeaseDb, createDb, heartbeatRuns } from "@paperclipai/db";
import { DATABASE_WORK_CHANNEL, enableDatabaseWorkNotifications, receiveDatabaseWorkNotification,
  subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { readTaskDrain, startTaskDrain, stopTaskDrain } from "../services/task-admission.js";
import { createRunStartHandover, isRunStartHandoverActive, isYieldingRunStarts, refreshRunStartYieldIfStale,
  registerRunStartHandover, type RunStartHandover } from "../services/run-start-handover.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

// Short timings keep the production order of events while the test waits seconds, not minutes.
const timing = { renewMs: 200, ttlMs: 1_500, recheckMs: 150, staleAwaitMs: 100, skipHintMinMs: 50 };

type Server = {
  name: string;
  db: ReturnType<typeof createDb>;
  handover: RunStartHandover;
  resumed: ReturnType<typeof vi.fn>;
  dispatchHints: number;
  stop: () => Promise<void>;
};

suite("run start hand-over between an old and a new server during a deploy overlap", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let admin!: ReturnType<typeof createDb>;
  let companyId = "";
  let agentId = "";
  const servers: Server[] = [];
  const claims: Array<{ server: string; runId: string }> = [];

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-run-start-handover-");
    admin = createDb(temporary.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await admin.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "RSH", requireBoardApprovalForNewAgents: false });
    await admin.insert(agents).values({ id: agentId, companyId, name: "Builder", adapterType: "codex_local", status: "idle" });
  }, 30_000);

  afterEach(async () => {
    registerRunStartHandover(null);
    for (const server of servers.splice(0)) await server.stop();
    claims.length = 0;
    await admin.delete(heartbeatRuns);
    await admin.delete(controllerInstances);
  });

  afterAll(async () => { await temporary?.cleanup(); });

  /** A server process: its own pool, its own boot id, and the cross-server notification listener. */
  async function bootServer(name: string, options: {
    canDispatch?: () => boolean; listen?: boolean; maxConnections?: number;
    timing?: Partial<typeof timing> & { writeStatementTimeoutMs?: number; readWaitMs?: number };
  } = {}): Promise<Server> {
    const canDispatch = options.canDispatch ?? (() => true);
    const db = createDb(temporary!.connectionString, options.maxConnections ? { maxConnections: options.maxConnections } : undefined);
    enableDatabaseWorkNotifications(db);
    const listener = options.listen === false ? null : createDb(temporary!.connectionString, { maxConnections: 1 }).$client;
    await listener?.listen(DATABASE_WORK_CHANNEL, payload => receiveDatabaseWorkNotification(db, payload));
    const resumed = vi.fn();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const handover = createRunStartHandover({ db, coordinator, canDispatch, onResume: resumed, bootId: `boot-${name}-${randomUUID()}`,
      processSpace: name, pid: 1, timing: { ...timing, ...options.timing } });
    await handover.ready;
    const server: Server = { name, db, handover, resumed, dispatchHints: 0, stop: async () => {} };
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.queuedRunDispatch, event => {
      if (event === "settled") server.dispatchHints += 1;
    });
    server.stop = async () => {
      unsubscribe();
      await handover.stop();
      await coordinator.stop();
      expect(errors).toEqual([]);
      await listener?.end({ timeout: 1 });
      await db.$client.end({ timeout: 1 });
    };
    servers.push(server);
    return server;
  }

  async function queueRun(): Promise<string> {
    const id = randomUUID();
    await admin.insert(heartbeatRuns).values({ id, companyId, agentId, status: "queued", invocationSource: "on_demand" });
    return id;
  }

  /** The queue's start path: refresh a stale answer, read the in-memory flag, then the atomic claim. */
  async function dispatch(server: Server, runId: string): Promise<boolean> {
    const refreshing = server.handover.refreshIfStale();
    if (refreshing) await refreshing;
    if (server.handover.isYielding()) return false;
    const [row] = await server.db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "queued"))).returning({ id: heartbeatRuns.id });
    if (row) claims.push({ server: server.name, runId });
    return Boolean(row);
  }

  async function marker(server: Server) {
    const [row] = await admin.execute(sql`select dispatching_at, dispatch_lease_expires_at > now() as live
      from controller_instances where process_space = ${server.name}`) as unknown as Array<{ dispatching_at: Date | null; live: boolean | null }>;
    return row;
  }

  it("the old server stops starting runs once the new one starts them, and the new one starts the queued run", async () => {
    // The old server booted alone long ago: it recorded its own start and holds no hand-over.
    const old = await bootServer("old");
    await old.handover.begin();
    expect(old.handover.isHandingOver()).toBe(false);
    const before = await queueRun();
    expect(await dispatch(old, before)).toBe(true);

    // The new server boots; while it is still starting up the old one keeps starting runs.
    const next = await bootServer("new");
    const duringStartup = await queueRun();
    expect(await dispatch(old, duringStartup)).toBe(true);

    // Its queued-run dispatch is running: it records that and the old server learns from the notification.
    await next.handover.begin();
    expect(next.handover.isHandingOver()).toBe(true);
    expect(await marker(next)).toMatchObject({ live: true });
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });

    const handedOver = await queueRun();
    const hintsBefore = next.dispatchHints;
    expect(await dispatch(old, handedOver)).toBe(false);
    // The skipped start wakes the new server's queued-run dispatch instead of waiting for a sweep.
    await vi.waitFor(() => expect(next.dispatchHints).toBeGreaterThan(hintsBefore), { timeout: 10_000 });
    expect(await dispatch(next, handedOver)).toBe(true);
    expect(claims.filter(claim => claim.runId === handedOver)).toEqual([{ server: "new", runId: handedOver }]);

    // The old server's SIGTERM ends the hand-over; the new server stops renewing without further writes.
    await admin.update(controllerInstances).set({ stoppedAt: sql`now()` }).where(eq(controllerInstances.processSpace, "old"));
    await vi.waitFor(() => expect(next.handover.isHandingOver()).toBe(false), { timeout: 10_000 });
  });

  it("the old server learns of the hand-over on its next start even without a notification", async () => {
    // The old server cannot hear this replacement: only its own dispatch path can tell it.
    const old = await bootServer("old", { listen: false });
    await old.handover.begin();
    // Its last read saw no replacement; then the replacement takes over while the old server is idle.
    await old.handover.refresh();
    expect(old.handover.isActive()).toBe(false);
    const next = await bootServer("new");
    await next.handover.begin();
    await new Promise(resolve => setTimeout(resolve, timing.staleAwaitMs + 50));
    // The next start waits for one fresh read instead of trusting the stale one.
    const run = await queueRun();
    expect(await dispatch(old, run)).toBe(false);
    expect(old.handover.isActive()).toBe(true);
    expect(await dispatch(next, run)).toBe(true);
  });

  it("a yield the old server cannot confirm in time does not stop it from starting runs", async () => {
    // A small pool that is busy: the old server's read waits for a connection.
    const old = await bootServer("old", { maxConnections: 1, timing: { readWaitMs: 200 } });
    await old.handover.begin();
    const next = await bootServer("new");
    await next.handover.begin();
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });

    // The replacement dies, and the old server's only connection is busy past the wait.
    // A drizzle query runs only once awaited: start it now and let it take the connection.
    const busy = controllerLeaseDb(old.db).execute(sql`select pg_sleep(1.5)`).then(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
    await next.handover.stop();
    expect(await marker(next)).toMatchObject({ live: null });
    await new Promise(resolve => setTimeout(resolve, timing.staleAwaitMs + 50));
    const run = await queueRun();
    const started = Date.now();
    expect(await dispatch(old, run)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    await busy;
  });

  it("a yield ends when the replacement's lease runs out, even while every read waits for a connection", async () => {
    const old = await bootServer("old", { maxConnections: 1 });
    await old.handover.begin();
    // A replacement that recorded its start and then died: its lease is never renewed.
    await admin.execute(sql`insert into controller_instances (boot_id, process_space, pid, lease_expires_at, dispatching_at, dispatch_lease_expires_at)
      values (${`boot-crashed-${randomUUID()}`}, 'crashed', 9, now(), now(), now() + ${`${timing.ttlMs} milliseconds`}::interval)`);
    await old.handover.refresh();
    expect(old.handover.isActive()).toBe(true);

    // The old server's only connection stays busy well past the lease: no read can answer.
    const busy = controllerLeaseDb(old.db).execute(sql`select pg_sleep(${(timing.ttlMs + 3_000) / 1000})`).then(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
    const resumedAt = await vi.waitFor(() => {
      expect(old.resumed).toHaveBeenCalledTimes(1);
      return Date.now();
    }, { timeout: timing.ttlMs + 2_000 });
    let busyDone = false;
    void busy.then(() => { busyDone = true; });
    expect(busyDone).toBe(false);
    expect(old.handover.isYielding()).toBe(false);
    expect(resumedAt).toBeGreaterThan(0);
    await busy;
  });

  it("renewals blocked past the TTL hand starts back once, then the replacement takes them again", async () => {
    const old = await bootServer("old");
    await old.handover.begin();
    const next = await bootServer("new", { timing: { writeStatementTimeoutMs: 300 } });
    await next.handover.begin();
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });

    // Every renewal is cancelled while the replacement's row is held, until its lease lapses.
    let unlock!: () => void;
    const locked = new Promise<void>(resolve => { unlock = resolve; });
    let held!: () => void;
    const holding = new Promise<void>(resolve => { held = resolve; });
    const lock = admin.transaction(async tx => {
      await tx.execute(sql`select 1 from controller_instances where process_space = 'new' for update`);
      held();
      await locked;
    });
    await holding;
    await vi.waitFor(() => expect(old.resumed).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(old.handover.isActive()).toBe(false);
    expect(await dispatch(old, await queueRun())).toBe(true);

    unlock();
    await lock;
    // The first renewal that succeeds again announces the marker, and the old server leaves starts to it.
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });
    expect(old.resumed).toHaveBeenCalledTimes(1);
    const run = await queueRun();
    expect(await dispatch(old, run)).toBe(false);
    expect(await dispatch(next, run)).toBe(true);
  });

  it("with both servers' shared pools blocked past the TTL, the marker is written, renewed and released on time", async () => {
    const old = await bootServer("old", { maxConnections: 1 });
    await old.handover.begin();
    const next = await bootServer("new", { maxConnections: 1 });
    // Every shared-pool connection on both servers is busy for longer than the whole hand-over below.
    const blockMs = timing.ttlMs * 4;
    const busy = Promise.all([old.db, next.db].map(server =>
      server.execute(sql`select pg_sleep(${blockMs / 1000})`).then(() => undefined)));
    await new Promise(resolve => setTimeout(resolve, 50));
    const blockedUntil = Date.now() + blockMs - 100;

    await next.handover.begin();
    expect(await marker(next)).toMatchObject({ live: true });
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 1_000 });
    await new Promise(resolve => setTimeout(resolve, timing.ttlMs * 1.5));
    expect(await marker(next)).toMatchObject({ live: true });
    expect(old.handover.isActive()).toBe(true);
    expect(old.resumed).not.toHaveBeenCalled();

    const started = Date.now();
    await next.handover.release();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await marker(next)).toMatchObject({ live: null });
    await vi.waitFor(() => expect(old.resumed).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    // All of the above happened while both shared pools were still blocked.
    expect(Date.now()).toBeLessThan(blockedUntil);
    await busy;
  });

  it("an older server that outlives the lease TTL keeps leaving starts to the renewing replacement", async () => {
    const old = await bootServer("old");
    await old.handover.begin();
    const next = await bootServer("new");
    await next.handover.begin();
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });
    await new Promise(resolve => setTimeout(resolve, timing.ttlMs * 2));
    expect(next.handover.isHandingOver()).toBe(true);
    expect(await marker(next)).toMatchObject({ live: true });
    expect(old.resumed).not.toHaveBeenCalled();
    const run = await queueRun();
    expect(await dispatch(old, run)).toBe(false);
    expect(await dispatch(next, run)).toBe(true);
  });

  it("a lease clear that fails at shutdown is retried by a later release", async () => {
    const old = await bootServer("old");
    await old.handover.begin();
    const next = await bootServer("new", { timing: { writeStatementTimeoutMs: 300 } });
    await next.handover.begin();
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });

    // The clear cannot take the row while it is held, and its statement timeout cancels it.
    let unlock!: () => void;
    const locked = new Promise<void>(resolve => { unlock = resolve; });
    let held!: () => void;
    const holding = new Promise<void>(resolve => { held = resolve; });
    const lock = admin.transaction(async tx => {
      await tx.execute(sql`select 1 from controller_instances where process_space = 'new' for update`);
      held();
      await locked;
    });
    await holding;
    await next.handover.release();
    unlock();
    await lock;
    expect(await marker(next)).toMatchObject({ live: true });
    expect(old.resumed).not.toHaveBeenCalled();

    await next.handover.release();
    expect(await marker(next)).toMatchObject({ live: null });
    await vi.waitFor(() => expect(old.resumed).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  });

  it("the old server starts runs again within seconds when the new server dies after taking over", async () => {
    const old = await bootServer("old");
    await old.handover.begin();
    // A replacement that recorded its start and then died: its hand-over lease is never renewed.
    await admin.execute(sql`insert into controller_instances (boot_id, process_space, pid, lease_expires_at, dispatching_at, dispatch_lease_expires_at)
      values (${`boot-crashed-${randomUUID()}`}, 'crashed', 9, now(), now(), now() + ${`${timing.ttlMs} milliseconds`}::interval)`);
    await old.handover.refresh();
    expect(old.handover.isActive()).toBe(true);
    const run = await queueRun();
    expect(await dispatch(old, run)).toBe(false);

    // Once the lease lapses the old server resumes and re-runs its queued-run pass.
    await vi.waitFor(() => expect(old.resumed).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(old.handover.isActive()).toBe(false);
    expect(await dispatch(old, run)).toBe(true);
  });

  it("the old server resumes at once when the new server shuts down (rollback or failed deploy)", async () => {
    const old = await bootServer("old");
    await old.handover.begin();
    const next = await bootServer("new");
    await next.handover.begin();
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });

    await next.handover.release();
    expect(await marker(next)).toMatchObject({ live: null });
    await vi.waitFor(() => expect(old.resumed).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const run = await queueRun();
    expect(await dispatch(old, run)).toBe(true);
  });

  it("the new server releases the hand-over while it drains and takes it back when the drain ends", async () => {
    const old = await bootServer("old");
    await old.handover.begin();
    const next = await bootServer("new", { canDispatch: () => readTaskDrain(new Date()) === null });
    await next.handover.begin();
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });

    try {
      startTaskDrain();
      await vi.waitFor(() => expect(old.resumed).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      expect(await marker(next)).toMatchObject({ live: null });
    } finally { stopTaskDrain(); }
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });
  });

  it("a clear that fails when the replacement starts draining is retried well inside the lease", async () => {
    const old = await bootServer("old");
    await old.handover.begin();
    // A long lease, so the old server can only resume early through a retried clear.
    const next = await bootServer("new", { canDispatch: () => readTaskDrain(new Date()) === null,
      timing: { ttlMs: 8_000, writeStatementTimeoutMs: 300 } });
    await next.handover.begin();
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });

    let unlock!: () => void;
    const locked = new Promise<void>(resolve => { unlock = resolve; });
    let held!: () => void;
    const holding = new Promise<void>(resolve => { held = resolve; });
    const lock = admin.transaction(async tx => {
      await tx.execute(sql`select 1 from controller_instances where process_space = 'new' for update`);
      held();
      await locked;
    });
    await holding;
    try {
      startTaskDrain();
      // The first clear is cancelled by its statement timeout while the row is held.
      await new Promise(resolve => setTimeout(resolve, 700));
      expect(await marker(next)).toMatchObject({ live: true });
      unlock();
      await lock;
      const unlockedAt = Date.now();
      await vi.waitFor(() => expect(old.resumed).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      expect(Date.now() - unlockedAt).toBeLessThan(4_000);
      expect(await marker(next)).toMatchObject({ live: null });
    } finally {
      unlock();
      stopTaskDrain();
    }
  });

  it("a replacement that starts up during a drain takes run starts over once the drain ends", async () => {
    const old = await bootServer("old");
    await old.handover.begin();
    const next = await bootServer("new", { canDispatch: () => readTaskDrain(new Date()) === null });
    try {
      startTaskDrain();
      await next.handover.begin();
      expect(await marker(next)).toBeUndefined();
      await old.handover.refresh();
      expect(old.handover.isActive()).toBe(false);
    } finally { stopTaskDrain(); }
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });
    expect(await marker(next)).toMatchObject({ live: true });
  });

  it("a shutdown release during an in-flight renewal is not undone by that renewal", async () => {
    const old = await bootServer("old");
    await old.handover.begin();
    const next = await bootServer("new");
    await next.handover.begin();
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });

    // Hold the replacement's row so its next renewal is in flight when shutdown releases the marker.
    let unlock!: () => void;
    const locked = new Promise<void>(resolve => { unlock = resolve; });
    let held!: () => void;
    const holding = new Promise<void>(resolve => { held = resolve; });
    const lock = admin.transaction(async tx => {
      await tx.execute(sql`select 1 from controller_instances where process_space = 'new' for update`);
      held();
      await locked;
    });
    await holding;
    await new Promise(resolve => setTimeout(resolve, timing.renewMs * 2));
    const release = next.handover.release();
    unlock();
    await lock;
    await release;
    expect(await marker(next)).toMatchObject({ live: null });
    await vi.waitFor(() => expect(old.resumed).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await new Promise(resolve => setTimeout(resolve, timing.renewMs * 3));
    expect(await marker(next)).toMatchObject({ live: null });
    expect(old.handover.isActive()).toBe(false);
  });

  it("an instance from an older release, without the marker, changes nothing", async () => {
    const old = await bootServer("old");
    await old.handover.begin();
    // A newer boot from a release without this code: a lease row, no dispatching_at.
    await admin.insert(controllerInstances).values({ bootId: `boot-legacy-${randomUUID()}`, processSpace: "legacy", pid: 3,
      leaseExpiresAt: sql`now() + interval '90 seconds'` });
    await old.handover.refresh();
    expect(old.handover.isActive()).toBe(false);
    expect(await dispatch(old, await queueRun())).toBe(true);
  });

  it("a server never yields to an older instance or to itself", async () => {
    const older = await bootServer("older");
    await older.handover.begin();
    const current = await bootServer("current");
    await current.handover.begin();
    // The older boot still advertises a live hand-over lease (for example, from its own overlap).
    await admin.update(controllerInstances).set({ dispatchLeaseExpiresAt: sql`now() + interval '1 minute'` });
    await current.handover.refresh();
    expect(current.handover.isActive()).toBe(current.handover.isHandingOver());
    expect(current.handover.isYielding()).toBe(false);
    expect(await dispatch(current, await queueRun())).toBe(true);
  });

  it("a server that has no row of its own never yields", async () => {
    const next = await bootServer("new");
    await next.handover.begin();
    const unknown = await bootServer("unknown");
    await unknown.handover.refresh();
    expect(unknown.handover.isYielding()).toBe(false);
  });

  it("a lone server records its start once and does not renew or read on the start path", async () => {
    const only = await bootServer("only");
    await only.handover.begin();
    expect(only.handover.isHandingOver()).toBe(false);
    const first = await admin.select({ lease: controllerInstances.dispatchLeaseExpiresAt }).from(controllerInstances);
    await new Promise(resolve => setTimeout(resolve, timing.renewMs * 3));
    const later = await admin.select({ lease: controllerInstances.dispatchLeaseExpiresAt }).from(controllerInstances);
    expect(later).toEqual(first);

    // Once read, a start is admitted from memory: nothing to await.
    await only.handover.refresh();
    expect(only.handover.refreshIfStale()).toBeNull();
    expect(await dispatch(only, await queueRun())).toBe(true);
  });

  it("a process without a hand-over (self-hosted, lease off) admits from memory with nothing to await", () => {
    registerRunStartHandover(null);
    expect(isYieldingRunStarts()).toBe(false);
    expect(refreshRunStartYieldIfStale()).toBeNull();
    expect(isRunStartHandoverActive()).toBe(false);
  });
});
