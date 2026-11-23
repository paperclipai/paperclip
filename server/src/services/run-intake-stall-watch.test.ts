import type { Db } from "@paperclipai/db";
import { agents, closeLivenessDb, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import type { DatabaseSessionWait } from "./database-session-waits.js";
import { allocateHeartbeatRunEventSeq, appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { persistHeartbeatRunProcessMetadata } from "./heartbeat/run-lifecycle.js";
import { beginRunIntake, installRunIntakeStallWatch, stopRunIntakeStallWatch } from "./run-intake-stall-watch.js";

const STALL_MESSAGE = "runner event intake stalled; pending run writes, database sessions and lock waits";
const CLEARED_MESSAGE = "runner event intake stall cleared";

type StallReport = {
  eventLoopLagMs: number;
  operations: Array<{ runId: string; stage: string; label: string; pendingMs: number }>;
  runs: Array<{ runId: string; pending: number; oldestPendingMs: number; stages: Record<string, number> }>;
  pool: { maxConnections: number | null; pendingIntake: number };
  sessions: Array<{ applicationName: string; state: string; sessions: number }>;
  waits: DatabaseSessionWait[];
  databaseReadError?: string;
};

function stallReports(warn: { mock: { calls: unknown[][] } }): StallReport[] {
  return warn.mock.calls.filter(call => call[1] === STALL_MESSAGE).map(call => call[0] as StallReport);
}

afterEach(() => {
  stopRunIntakeStallWatch();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("run intake stall watch", () => {
  it("does nothing until it is installed", () => {
    const done = beginRunIntake("run", "received", "session.started");
    expect(done).toBeTypeOf("function");
    done();
  });

  it("reports a stalled run once, throttles the next report, and logs when the stalled write finishes", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const unreachable = { transaction: () => Promise.reject(new Error("database unreachable")), $client: { options: { max: 7 } } } as unknown as Db;
    installRunIntakeStallWatch(unreachable, { stallMs: 1_000, now: () => Date.now() });
    const first = beginRunIntake("run-a", "process_identity", "native.process_identity_recorded");
    vi.advanceTimersByTime(100);
    const queued = beginRunIntake("run-a", "received", "session.started");
    const healthy = beginRunIntake("run-b", "write", "item.completed");
    vi.advanceTimersByTime(50);
    healthy();
    vi.advanceTimersByTime(50);
    const other = beginRunIntake("run-c", "write", "turn.started");
    await vi.advanceTimersByTimeAsync(950);
    let reports = stallReports(warn);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.operations).toEqual([
      expect.objectContaining({ runId: "run-a", stage: "process_identity", label: "native.process_identity_recorded" }),
    ]);
    expect(reports[0]!.runs[0]).toMatchObject({ runId: "run-a", pending: 2, stages: { process_identity: 1, received: 1 } });
    expect(reports[0]!.pool).toMatchObject({ maxConnections: 7, pendingIntake: 3 });
    expect(reports[0]!.databaseReadError).toBe("database unreachable");

    await vi.advanceTimersByTimeAsync(800);
    expect(stallReports(warn)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    reports = stallReports(warn);
    expect(reports).toHaveLength(2);
    expect(reports[1]!.operations).toEqual([expect.objectContaining({ runId: "run-c", stage: "write" })]);

    queued();
    expect(info.mock.calls.filter(call => call[1] === CLEARED_MESSAGE)).toHaveLength(0);
    first();
    other();
    expect(info.mock.calls.filter(call => call[1] === CLEARED_MESSAGE).map(call => call[0])).toEqual([
      expect.objectContaining({ runId: "run-a", stage: "process_identity" }),
      expect.objectContaining({ runId: "run-c", stage: "write" }),
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stallReports(warn)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports pending writes when the database read hangs, and stops without waiting for it", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const hung = { transaction: () => new Promise(() => undefined), $client: { options: { max: 3 } } } as unknown as Db;
    installRunIntakeStallWatch(hung, { stallMs: 1_000, reportTimeoutMs: 500, now: () => Date.now() });
    const done = beginRunIntake("run-hung", "write", "session.started");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stallReports(warn)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    const [report] = stallReports(warn);
    expect(report!.operations).toEqual([expect.objectContaining({ runId: "run-hung", stage: "write" })]);
    expect(report!.databaseReadError).toBe("database session read timed out after 500 ms");
    done();
    const second = beginRunIntake("run-later", "write", "turn.started");
    await vi.advanceTimersByTimeAsync(1_200);
    stopRunIntakeStallWatch();
    second();
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(0);
    expect(stallReports(warn)).toHaveLength(2);
  });

  it("names every stalled run across reports when more runs stall than one report lists", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const unreachable = { transaction: () => Promise.reject(new Error("database unreachable")), $client: {} } as unknown as Db;
    installRunIntakeStallWatch(unreachable, { stallMs: 1_000, now: () => Date.now() });
    const runIds = Array.from({ length: 25 }, (_, index) => `run-${index}`);
    const pending = runIds.map(runId => beginRunIntake(runId, "write", "item.completed"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stallReports(warn)).toHaveLength(1);
    expect(stallReports(warn)[0]!.operations).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(1_000);
    const reports = stallReports(warn);
    expect(reports).toHaveLength(2);
    expect(reports[1]!.operations).toHaveLength(5);
    expect(reports.flatMap(report => report.operations.map(operation => operation.runId)).sort()).toEqual([...runIds].sort());
    for (const done of pending) done();
  });

  it("keeps no timer once no run write is pending", async () => {
    vi.useFakeTimers();
    installRunIntakeStallWatch({} as Db, { stallMs: 1_000, now: () => Date.now() });
    expect(vi.getTimerCount()).toBe(0);
    beginRunIntake("run", "write", "item.delta")();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_QUEUE_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping run intake stall database tests: ${support.reason}`);
describe.skipIf(!support.supported)("run intake stall watch on a database", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-run-intake-stall");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4, applicationName: "paperclip:stall-test-boot" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (db) await closeLivenessDb(db, 1);
    await db?.$client.end();
    await database?.cleanup();
  });

  async function seedRun(prefix: string) {
    const [company] = await db.insert(companies).values({ name: `Intake ${prefix}`, issuePrefix: prefix }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Runner agent", status: "running",
      adapterType: "paperclip_runner", adapterConfig: {} }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running",
      runtimeMode: "native", invocationSource: "assignment", contextSnapshot: {} }).returning();
    return run!;
  }

  it("names the idle transaction holding a run row when that run's process identity write waits behind it", async () => {
    const run = await seedRun("RIS");
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    installRunIntakeStallWatch(db, { stallMs: 300 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: (pid: number) => void;
    const holderPid = new Promise<number>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.execute(sql.raw(`select id from heartbeat_runs where id = '${run.id}' and next_event_seq >= 0 for update`));
      locked(Number(backend!.pid));
      await held;
    });
    const holderBackend = await holderPid;
    const identity = persistHeartbeatRunProcessMetadata(db, run.id,
      { pid: 563, processGroupId: null, startedAt: new Date().toISOString(), targetKind: "remote" });
    try {
      await vi.waitFor(() => expect(stallReports(warn)).toHaveLength(1), { timeout: 5_000, interval: 20 });
      const [report] = stallReports(warn);
      expect(report!.operations).toEqual([
        expect.objectContaining({ runId: run.id, stage: "process_identity", label: "native.process_identity_recorded" }),
      ]);
      expect(report!.runs[0]).toMatchObject({ runId: run.id, stages: { process_identity: 1, write: 1 } });
      expect(report!.pool.maxConnections).toBe(4);
      expect(report!.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ applicationName: "paperclip:stall-test-boot", state: "idle in transaction" }),
      ]));
      expect(report!.waits).toEqual(expect.arrayContaining([
        expect.objectContaining({ pid: holderBackend, state: "idle in transaction", applicationName: "paperclip:stall-test-boot" }),
        expect.objectContaining({ waitEventType: "Lock", blockedBy: [holderBackend] }),
      ]));
      expect(JSON.stringify(report!.waits)).not.toContain(run.id);
      expect(report!.waits.find(wait => wait.pid === holderBackend)?.query).toContain("where id = ? and next_event_seq >= ? for update");
    } finally {
      release();
      await holder;
    }
    await expect(identity).resolves.toMatchObject({ processPid: 563 });
    expect(info.mock.calls.filter(call => call[1] === CLEARED_MESSAGE).map(call => call[0])).toEqual([
      expect.objectContaining({ runId: run.id, stage: "process_identity" }),
    ]);
  });

  it("reports a direct event sequence reservation that waits behind a held run row", async () => {
    const run = await seedRun("RIQ");
    const warn = vi.spyOn(logger, "warn");
    installRunIntakeStallWatch(db, { stallMs: 300 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.execute(sql.raw(`select id from heartbeat_runs where id = '${run.id}' for update`));
      locked();
      await held;
    });
    await isLocked;
    const reserved = allocateHeartbeatRunEventSeq(db, run.id);
    try {
      await vi.waitFor(() => expect(stallReports(warn)).toHaveLength(1), { timeout: 5_000, interval: 20 });
      expect(stallReports(warn)[0]!.operations).toEqual([
        expect.objectContaining({ runId: run.id, stage: "write", label: "event_sequence" }),
      ]);
    } finally {
      release();
      await holder;
    }
    await expect(reserved).resolves.toBeTypeOf("number");
  });

  it("stays silent while run event writes keep committing", async () => {
    const run = await seedRun("RIH");
    const warn = vi.spyOn(logger, "warn");
    installRunIntakeStallWatch(db, { stallMs: 200 });
    for (let index = 0; index < 5; index += 1) {
      await appendHeartbeatRunEvent(db, { companyId: run.companyId, runId: run.id, agentId: run.agentId,
        eventType: "lifecycle", stream: "system", level: "info", message: `step ${index}` });
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(stallReports(warn)).toHaveLength(0);
  });
});
