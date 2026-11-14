import { randomUUID } from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setImmediate as immediate } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, authUsers, closeCheckpointDb, closeLivenessDb, companies, companyMemberships,
  controllerInstances, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { heartbeatService } from "../services/heartbeat.js";
import { notifyLiveRunRecovery } from "../services/live-run-recovery-notifications.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { persistHeartbeatRunProcessMetadata } from "../services/heartbeat/run-lifecycle.js";
import { discoverSettledNativeRunProcesses } from "../services/native-local-process-stop.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 180_000 });

describe("settled native process re-checks", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let meter: ReturnType<typeof meterDatabaseStatements>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  const errors: unknown[] = [];
  const passes = new Set<Promise<unknown>>();
  const children: number[] = [];
  const checks = new Map<string, number>();
  const stops: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_SETTLED_RECHECK_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("settled-recheck-");
    else await applyPendingMigrations(external);
    const url = external ?? temporary!.connectionString;
    db = createDb(url, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    meter = meterDatabaseStatements(db, url);
    await Promise.all(Array.from({ length: 4 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    db.$client.options.debug = (_connection, query, parameters) => {
      if (!/for update/i.test(query) || !query.includes("sessionCheckpoint")) return;
      const runId = (parameters as unknown[]).find(value => typeof value === "string" && checks.has(value)) as string | undefined;
      if (runId) checks.set(runId, checks.get(runId)! + 1);
    };
  });
  beforeEach(async () => {
    await db.execute(sql`truncate companies, controller_instances cascade`);
    errors.length = 0; checks.clear();
    heartbeat = heartbeatService(db);
    coordinator = newCoordinator();
  });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await coordinator.stop(); await heartbeat.drainActiveRunExecutions();
    for (const pid of children.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { } }
    vi.useRealTimers(); vi.restoreAllMocks(); expect(errors).toEqual([]);
  });
  afterAll(async () => {
    meter?.uninstall();
    if (db) { await closeLivenessDb(db, 1); await closeCheckpointDb(db, 1); }
    await db?.$client.end({ timeout: 1 }); await temporary?.cleanup();
  });

  function newCoordinator() {
    const created = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => errors.push(error) });
    const register = created.register.bind(created);
    created.register = (queue, task) => register(queue, { ...task, run: signal => {
      const pass = Promise.resolve(task.run(signal)); passes.add(pass);
      void pass.finally(() => passes.delete(pass)); return pass;
    } });
    return created;
  }

  async function fixture() {
    const companyId = randomUUID(), actorId = "settled-recheck-user";
    await db.insert(authUsers).values({ id: actorId, name: "Owner", email: `${actorId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Settled", issuePrefix: `SR${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: actorId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actorId,
      status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Worker", status: "idle", adapterType: "process",
      adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Work", status: "done", assigneeAgentId: agent.id }).returning();
    return { companyId, agentId: agent.id, issueId: issue.id };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function exitedPid() {
    const child = spawn(process.execPath, ["-e", "0"], { detached: true, stdio: "ignore" });
    const pid = child.pid!; await once(child, "exit"); return pid;
  }
  function livePid() {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    child.unref(); children.push(child.pid!); return child.pid!;
  }
  async function kill(pid: number) {
    try { process.kill(-pid, "SIGKILL"); } catch { }
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  type Seed = { host?: { hostname: string; hash: string | null }; phase?: string | null; checkpoint?: boolean; live?: boolean;
    birthMismatch?: boolean; remote?: "stopped" | "unconfirmed" };
  async function seed(f: Fixture, options: Seed = {}) {
    const pid = options.live ? livePid() : await exitedPid();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, runtimeMode: "native",
      nativeIssueId: f.issueId, status: "running", invocationSource: "assignment", triggerDetail: "system",
      runnerProfileJson: options.checkpoint === false ? {} : { sessionCheckpoint: { providerSessionId: "thread" } } }).returning();
    if (options.host || options.birthMismatch) {
      const startedAt = new Date();
      const host = options.host ?? { hostname: os.hostname(), hash: null };
      await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: run.id, agentId: f.agentId,
        eventType: "native.process_identity_recorded", stream: "system", level: "info", message: "identity",
        payload: { targetKind: options.remote ? "remote" : "local", hostname: host.hostname, processPid: pid, processGroupId: pid,
          processStartedAt: new Date(startedAt.getTime() - (options.birthMismatch ? 5_000 : 0)).toISOString() },
        runUpdate: { processPid: pid, processGroupId: pid, processStartedAt: startedAt, processHostHash: host.hash } });
    } else {
      await persistHeartbeatRunProcessMetadata(db, run.id, { pid, processGroupId: pid, startedAt: new Date().toISOString(), targetKind: "local" });
    }
    if (options.phase !== null) await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId,
      runId: run.id, phase: options.phase ?? "committed", controllerBootId: randomUUID() });
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: run.id,
      provider: options.remote ? "daytona" : "local", providerLeaseId: options.remote ? randomUUID() : null, leasePolicy: "ephemeral",
      status: "released", releasedAt: new Date(), cleanupStatus: "success" }).returning();
    if (options.remote === "stopped") await db.update(environmentLeases).set({ metadata: {
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }),
    } }).where(eq(environmentLeases.id, lease.id));
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    checks.set(run.id, 0);
    return { runId: run.id, pid };
  }

  async function start(target = coordinator) {
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await heartbeat.registerResidualRecoveryWork(target, () => true).ready;
    await advance(2_000);
  }
  async function advance(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await vi.advanceTimersByTimeAsync(Math.min(1_000, until - Date.now()));
      await Promise.allSettled([...passes]); await immediate();
    }
  }
  const companyHint = (companyId: string) => db.transaction(tx => notifyLiveRunRecovery(tx, { companyId }));
  const runHint = (companyId: string, runId: string) => db.transaction(tx => notifyLiveRunRecovery(tx, { companyId, runId }));
  async function hints(companyId: string, count: number) {
    for (let index = 0; index < count; index++) { await companyHint(companyId); await advance(31_000); }
  }
  const processPid = async (id: string) => (await db.select({ pid: heartbeatRuns.processPid }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, id)))[0]!.pid;
  const stopReceipts = async (id: string) => (await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, id), eq(heartbeatRunEvents.eventType, "native.local_process_stopped")))).length;

  it.each([
    ["recorded by a replaced container", { host: { hostname: "replaced-container", hash: "replaced-container-space" } }],
    ["whose coordinator phase is unsettled", { phase: "workspace_finalizing" }],
    ["without a checkpoint or provider evidence", { checkpoint: false }],
  ] as const)("never re-reads a terminal run %s on company hints", async (_name, options) => {
    const f = await fixture();
    const { runId, pid } = await seed(f, options as Seed);
    await start();
    await hints(f.companyId, 4);
    expect(checks.get(runId)).toBe(0);
    expect(await processPid(runId)).toBe(pid);
  });

  it.each(["live", "stopped"] as const)("leaves a %s older server's runs to that server", async state => {
    const f = await fixture();
    const bootId = randomUUID();
    await db.insert(controllerInstances).values({ bootId, processSpace: "older-server-space", pid: 4242,
      leaseExpiresAt: new Date(Date.now() + (state === "live" ? 60_000 : -600_000)),
      stoppedAt: state === "stopped" ? new Date() : null });
    const { runId, pid } = await seed(f, { host: { hostname: "older-server", hash: "older-server-space" } });
    await db.update(nativeRunFinalizations).set({ controllerBootId: bootId, controllerHostHash: "older-server-space" })
      .where(eq(nativeRunFinalizations.runId, runId));
    const own = await seed(f);
    await start();
    expect(await processPid(own.runId)).toBeNull();
    await hints(f.companyId, 2);
    expect(checks.get(runId)).toBe(0);
    expect(await processPid(runId)).toBe(pid);
    expect(await stopReceipts(runId)).toBe(0);
  });

  it("re-admits a run once its coordinator phase settles", async () => {
    const f = await fixture();
    const { runId } = await seed(f, { phase: "workspace_finalizing" });
    await start();
    await hints(f.companyId, 1);
    expect(await processPid(runId)).not.toBeNull();
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, runId));
    await hints(f.companyId, 1);
    expect(await processPid(runId)).toBeNull();
    expect(checks.get(runId)).toBe(1);
    expect(await stopReceipts(runId)).toBe(1);
  });

  it("re-admits a run once late provider evidence arrives", async () => {
    const f = await fixture();
    const { runId } = await seed(f, { checkpoint: false });
    await start();
    await hints(f.companyId, 1);
    expect(await processPid(runId)).not.toBeNull();
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId, agentId: f.agentId, eventType: "harness.ready",
      stream: "system", level: "info", message: "ready" });
    await hints(f.companyId, 1);
    expect(await processPid(runId)).toBeNull();
    expect(checks.get(runId)).toBe(1);
  });

  it("releases legacy rows without a PID-space hash only when this host recorded them", async () => {
    const f = await fixture();
    const own = await seed(f, { host: { hostname: os.hostname(), hash: null } });
    const foreign = await seed(f, { host: { hostname: "legacy-other-host", hash: null } });
    await start();
    expect(await processPid(own.runId)).toBeNull();
    await hints(f.companyId, 2);
    expect(checks.get(foreign.runId)).toBe(0);
    expect(await processPid(foreign.runId)).toBe(foreign.pid);
  });

  it("releases a sandbox run from any server once its termination receipt exists", async () => {
    const f = await fixture();
    const pending = await seed(f, { host: { hostname: "replaced-container", hash: "remote" }, remote: "unconfirmed" });
    const stopped = await seed(f, { host: { hostname: "replaced-container", hash: "remote" }, remote: "stopped" });
    await start();
    expect(await processPid(stopped.runId)).toBeNull();
    expect(await processPid(pending.runId)).not.toBeNull();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, pending.runId));
    await db.update(environmentLeases).set({ metadata: {
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }),
    } }).where(eq(environmentLeases.id, lease.id));
    await runHint(f.companyId, pending.runId);
    await advance(2_000);
    expect(await processPid(pending.runId)).toBeNull();
  });

  it("backs off a live local process and releases it on the next run-scoped hint after it exits", async () => {
    const f = await fixture();
    const { runId, pid } = await seed(f, { live: true });
    await start();
    expect(checks.get(runId)).toBe(1);
    await hints(f.companyId, 8);
    expect(checks.get(runId)).toBeLessThanOrEqual(4);
    expect(await processPid(runId)).toBe(pid);
    await kill(pid);
    await runHint(f.companyId, runId);
    await advance(2_000);
    expect(await processPid(runId)).toBeNull();
    expect(await stopReceipts(runId)).toBe(1);
  });

  it("checks a same-host skip once with one locking statement, then only on its own trigger", async () => {
    const f = await fixture();
    const { runId } = await seed(f, { birthMismatch: true, host: { hostname: os.hostname(), hash: null } });
    meter.startLog();
    await start();
    const log = meter.stopLog();
    expect(checks.get(runId)).toBe(1);
    const inCheck = log.filter(entry => entry.inTransaction || /^\s*begin/i.test(entry.sql));
    expect(inCheck.filter(entry => /for update/i.test(entry.sql))).toHaveLength(1);
    expect(inCheck.length).toBeLessThanOrEqual(3);
    await hints(f.companyId, 3);
    expect(checks.get(runId)).toBe(1);
    await runHint(f.companyId, runId);
    await advance(2_000);
    expect(checks.get(runId)).toBe(2);
  });

  it("checks a pending run at most once after a restart and discovers no excluded run at startup", async () => {
    const f = await fixture();
    const { runId } = await seed(f, { live: true });
    for (let index = 0; index < 50; index++) await seed(f, { host: { hostname: "replaced-container", hash: "replaced-container-space" } });
    await start();
    expect(checks.get(runId)).toBe(1);
    await coordinator.stop();
    const restarted = newCoordinator();
    stops.push(() => restarted.stop());
    await start(restarted);
    expect(checks.get(runId)).toBe(2);
    vi.useRealTimers();
    const before = meter.read();
    const counted = [...checks.values()].reduce((sum, value) => sum + value, 0);
    await discoverSettledNativeRunProcesses(db, { skip: id => id === runId });
    expect(meter.read().statements - before.statements).toBe(1);
    expect([...checks.values()].reduce((sum, value) => sum + value, 0)).toBe(counted);
  });
});
