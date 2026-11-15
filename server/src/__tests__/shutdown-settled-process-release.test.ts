import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, authUsers, closeCheckpointDb, closeLivenessDb, companies, companyMemberships,
  createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { persistHeartbeatRunProcessMetadata } from "../services/heartbeat/run-lifecycle.js";
import { currentProcessSpaceHash } from "../services/controller-process-identity.js";
import {
  discoverSettledNativeRunProcesses,
  hasNativeLocalProcessStop,
  releaseOwnedSettledNativeRunProcessesAtShutdown,
  withReleasedNativeRunProcess,
} from "../services/native-local-process-stop.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 180_000 });

const SETTLED = ["failed", "cancelled", "timed_out", "interrupted"] as const;

describe("graceful shutdown releases the process identity of settled native runs", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let meter: ReturnType<typeof meterDatabaseStatements>;
  const children: number[] = [];

  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_SHUTDOWN_PROCESS_RELEASE_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("shutdown-process-release-");
    else await applyPendingMigrations(external);
    const url = external ?? temporary!.connectionString;
    db = createDb(url, { maxConnections: 2, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    meter = meterDatabaseStatements(db, url);
  });
  beforeEach(async () => {
    await db.execute(sql`truncate companies, controller_instances cascade`);
  });
  afterEach(() => {
    for (const pid of children.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { } }
  });
  afterAll(async () => {
    meter?.uninstall();
    if (db) { await closeLivenessDb(db, 1); await closeCheckpointDb(db, 1); }
    await db?.$client.end({ timeout: 1 }); await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), actorId = "shutdown-release-user";
    await db.insert(authUsers).values({ id: actorId, name: "Owner", email: `${actorId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Shutdown", issuePrefix: `SD${companyId.slice(0, 6)}`,
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

  type Seed = { pid: number; status?: string; foreign?: boolean; remote?: boolean; phase?: string;
    leasePending?: boolean };
  async function seed(f: Fixture, options: Seed) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, runtimeMode: "native",
      nativeIssueId: f.issueId, status: "running", invocationSource: "assignment", triggerDetail: "system",
      runnerProfileJson: { sessionCheckpoint: { providerSessionId: "thread" } } }).returning();
    const startedAt = new Date(Date.now() - 60_000);
    if (options.foreign || options.remote) {
      await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: run.id, agentId: f.agentId,
        eventType: "native.process_identity_recorded", stream: "system", level: "info", message: "identity",
        payload: { targetKind: options.remote ? "remote" : "local", hostname: "replaced-container",
          processPid: options.pid, processGroupId: options.pid, processStartedAt: startedAt.toISOString() },
        runUpdate: { processPid: options.pid, processGroupId: options.pid, processStartedAt: startedAt,
          processHostHash: options.remote ? "remote" : "replaced-container-space" } });
    } else {
      await persistHeartbeatRunProcessMetadata(db, run.id, { pid: options.pid, processGroupId: options.pid,
        startedAt: startedAt.toISOString(), targetKind: "local" });
    }
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: run.id,
      phase: options.phase ?? (options.status === "running" ? "observed" : "committed"), controllerBootId: randomUUID() });
    await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: run.id,
      provider: options.remote ? "daytona" : "local", providerLeaseId: options.remote ? randomUUID() : null,
      leasePolicy: "ephemeral", status: options.leasePending ? "active" : "released",
      releasedAt: options.leasePending ? null : new Date(), cleanupStatus: options.leasePending ? null : "success" });
    if (options.status !== "running") {
      await db.update(heartbeatRuns).set({ status: options.status ?? "failed", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, run.id));
    }
    return run.id;
  }

  const strandedSettledRuns = async (companyId: string) => (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.runtimeMode, "native"),
    inArray(heartbeatRuns.status, [...SETTLED]), sql`${heartbeatRuns.finishedAt} is not null`,
    sql`(${heartbeatRuns.processPid} is not null or ${heartbeatRuns.processGroupId} is not null)`))).map(row => row.id).sort();
  const processFields = async (id: string) => (await db.select({ pid: heartbeatRuns.processPid, group: heartbeatRuns.processGroupId,
    startedAt: heartbeatRuns.processStartedAt, hostHash: heartbeatRuns.processHostHash })
    .from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  const stopReceipts = async (id: string) => db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, id), eq(heartbeatRunEvents.eventType, "native.local_process_stopped")));

  async function seedDeploy(f: Fixture, owned: number) {
    const exited = await exitedPid();
    const ownedRuns: string[] = [];
    for (let index = 0; index < owned; index++) {
      ownedRuns.push(await seed(f, { pid: exited, status: SETTLED[index % SETTLED.length] }));
    }
    const kept = {
      suspendedRunning: await seed(f, { pid: livePid(), status: "running" }),
      settledButAlive: await seed(f, { pid: livePid() }),
      remoteSandbox: await seed(f, { pid: 77, remote: true }),
      otherContainer: await seed(f, { pid: exited, foreign: true }),
      coordinatorUnsettled: await seed(f, { pid: exited, phase: "workspace_finalizing" }),
      leaseCleanupPending: await seed(f, { pid: exited, leasePending: true }),
    };
    return { exited, ownedRuns, kept };
  }

  it("leaves no stranded identity on the settled runs it ran, in a fixed number of statements, and touches nothing else", async () => {
    const f = await fixture();
    const { exited, ownedRuns, kept } = await seedDeploy(f, 40);
    const keptBefore = Object.fromEntries(await Promise.all(Object.entries(kept)
      .map(async ([name, id]) => [name, await processFields(id)] as const)));
    expect(await strandedSettledRuns(f.companyId)).toHaveLength(ownedRuns.length + 5);

    const before = meter.read();
    const release = await releaseOwnedSettledNativeRunProcessesAtShutdown(db);
    const statements = meter.read().statements - before.statements;

    expect(release).toEqual({ candidates: ownedRuns.length + 1, stillRunning: 1, released: ownedRuns.length });
    expect(statements).toBeLessThanOrEqual(7);
    expect(await strandedSettledRuns(f.companyId)).toEqual([kept.settledButAlive, kept.remoteSandbox, kept.otherContainer,
      kept.coordinatorUnsettled, kept.leaseCleanupPending].sort());
    for (const [name, id] of Object.entries(kept)) expect(await processFields(id)).toEqual(keptBefore[name]);
    for (const [name, id] of Object.entries(kept)) expect({ name, receipts: (await stopReceipts(id)).length }).toEqual({ name, receipts: 0 });

    for (const runId of ownedRuns) {
      const fields = await processFields(runId);
      expect(fields).toMatchObject({ pid: null, group: null, startedAt: null, hostHash: currentProcessSpaceHash() });
      const receipts = await stopReceipts(runId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.payload).toMatchObject({ processPid: exited, processGroupId: exited });
      expect(await hasNativeLocalProcessStop(db, f.companyId, runId)).toBe(true);
      const restored = await withReleasedNativeRunProcess(db, { id: runId, companyId: f.companyId,
        processPid: null, processGroupId: null, processStartedAt: null });
      expect(restored).toMatchObject({ processPid: exited, processGroupId: exited });
    }

    const again = await releaseOwnedSettledNativeRunProcessesAtShutdown(db);
    expect(again).toEqual({ candidates: 1, stillRunning: 1, released: 0 });
  });

  it("leaves the next server on this host nothing to release, where an abrupt stop leaves it every run", async () => {
    const graceful = await fixture();
    const gracefulDeploy = await seedDeploy(graceful, 40);
    await releaseOwnedSettledNativeRunProcessesAtShutdown(db);
    const skipKept = (id: string) => Object.values(gracefulDeploy.kept).includes(id);
    let before = meter.read();
    const afterGraceful = await discoverSettledNativeRunProcesses(db, { skip: skipKept });
    const gracefulStatements = meter.read().statements - before.statements;

    await db.execute(sql`truncate companies, controller_instances cascade`);
    const abrupt = await fixture();
    const abruptDeploy = await seedDeploy(abrupt, 40);
    const strandedAfterAbruptStop = await strandedSettledRuns(abrupt.companyId);
    before = meter.read();
    const afterAbrupt = await discoverSettledNativeRunProcesses(db,
      { skip: id => Object.values(abruptDeploy.kept).includes(id) });
    const abruptStatements = meter.read().statements - before.statements;

    expect(afterGraceful.released).toBe(0);
    expect(gracefulStatements).toBe(1);
    expect(strandedAfterAbruptStop).toHaveLength(abruptDeploy.ownedRuns.length + 5);
    expect(afterAbrupt.released).toBe(abruptDeploy.ownedRuns.length);
    expect(abruptStatements).toBeGreaterThan(abruptDeploy.ownedRuns.length * 5);
  });

  it("releases nothing when the server is killed before its shutdown step, so a successor in another container sees today's rows", async () => {
    const f = await fixture();
    const { ownedRuns } = await seedDeploy(f, 12);
    const snapshot = await Promise.all(ownedRuns.map(processFields));
    expect(await strandedSettledRuns(f.companyId)).toHaveLength(ownedRuns.length + 5);
    expect(await Promise.all(ownedRuns.map(processFields))).toEqual(snapshot);
    for (const runId of ownedRuns) expect(await stopReceipts(runId)).toHaveLength(0);
  });

  it("never releases a run whose recorded identity changed after it was read", async () => {
    const f = await fixture();
    const exited = await exitedPid();
    const runId = await seed(f, { pid: exited });
    const replacement = livePid();
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce((async (run: Parameters<typeof db.transaction>[0]) => {
      await db.update(heartbeatRuns).set({ processPid: replacement, processGroupId: replacement }).where(eq(heartbeatRuns.id, runId));
      return transaction(run);
    }) as typeof db.transaction);
    try {
      const release = await releaseOwnedSettledNativeRunProcessesAtShutdown(db);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(release).toEqual({ candidates: 1, stillRunning: 0, released: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(await processFields(runId)).toMatchObject({ pid: replacement, group: replacement });
    expect(await stopReceipts(runId)).toHaveLength(0);
  });
});
