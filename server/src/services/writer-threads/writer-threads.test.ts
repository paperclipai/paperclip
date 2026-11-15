import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, checkpointDb, closeCheckpointDb, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, nativeRunnerCheckpoints,
  subscribeDatabaseWork } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { nativeRunnerCheckpointWriter } from "../native-runtime/native-runner-checkpoint.js";
import { ROUTINE_CHECKPOINT_SAVE_SQL } from "../native-runtime/native-runner-checkpoint-routine-save.js";
import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";
import { closeWriterThreads, installWriterThreads, readWriterThreadSettings, writerThreadEntry, WriterThreadsClosedError, writerThreadsFor,
  type WriterThreadSettings } from "./writer-threads.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class CountingWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      spawned.count += 1;
    }
  }
  return { ...actual, Worker: CountingWorker };
});

const support = await getEmbeddedPostgresTestSupport();
const settings = (overrides: Partial<WriterThreadSettings> = {}): WriterThreadSettings => ({ threads: 2, poolMax: 2, timeoutMs: 30_000, ...overrides });
type Db = ReturnType<typeof createDb>;

describe("writer thread settings", () => {
  it("is off unless PAPERCLIP_WRITER_THREADS names a thread count", () => {
    expect(readWriterThreadSettings({})).toEqual({ threads: 0, poolMax: 2, timeoutMs: 30_000 });
    expect(readWriterThreadSettings({ PAPERCLIP_WRITER_THREADS: "0" }).threads).toBe(0);
    expect(readWriterThreadSettings({ PAPERCLIP_WRITER_THREADS: "3", PAPERCLIP_WRITER_THREAD_POOL_MAX: "1" }))
      .toEqual({ threads: 3, poolMax: 1, timeoutMs: 30_000 });
    expect(() => readWriterThreadSettings({ PAPERCLIP_WRITER_THREADS: "yes" })).toThrow(/PAPERCLIP_WRITER_THREADS/);
    expect(() => readWriterThreadSettings({ PAPERCLIP_WRITER_THREADS: "9" })).toThrow(/PAPERCLIP_WRITER_THREADS/);
    expect(() => readWriterThreadSettings({ PAPERCLIP_WRITER_THREAD_POOL_MAX: "0" })).toThrow(/PAPERCLIP_WRITER_THREAD_POOL_MAX/);
  });
});

describe("writer thread entry", () => {
  it("runs the source with a loader, the runtime bundle when it exists, and the compiled file otherwise", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paperclip-writer-entry-"));
    try {
      const compiled = pathToFileURL(path.join(root, "server", "dist", "services", "writer-threads", "writer-threads.js")).href;
      expect(writerThreadEntry(compiled)).toEqual({ url: new URL("./writer-thread.js", compiled), source: false });
      mkdirSync(path.join(root, "server", "dist-runtime"), { recursive: true });
      writeFileSync(path.join(root, "server", "dist-runtime", "writer-thread.mjs"), "");
      expect(writerThreadEntry(compiled)).toEqual({ url: pathToFileURL(path.join(root, "server", "dist-runtime", "writer-thread.mjs")), source: false });
      const source = pathToFileURL(path.join(root, "server", "src", "services", "writer-threads", "writer-threads.ts")).href;
      expect(writerThreadEntry(source)).toEqual({ url: new URL("./writer-thread.ts", source), source: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

(support.supported ? describe : describe.skip)("routine checkpoint saves on writer threads", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let observer: Db;
  const opened: Db[] = [];
  const open = () => { const db = createDb(temporary.connectionString); opened.push(db); return db; };
  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY ??= randomBytes(32).toString("base64");
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-writer-threads-");
    observer = open();
  }, 60_000);
  afterEach(async () => {
    for (const db of opened) await closeWriterThreads(db, 1_000);
  });
  afterAll(async () => {
    for (const db of opened) {
      await closeWriterThreads(db, 1_000);
      await closeCheckpointDb(db, 1);
      await db.$client.end({ timeout: 1 });
    }
    await temporary?.cleanup();
  });

  const fixture = async (db: Db, options: { leaseExpiresAt?: Date } = {}) => {
    const [company] = await observer.insert(companies).values({ name: "Writer threads", issuePrefix: `WT${randomUUID().slice(0, 4)}` }).returning();
    const [agent] = await observer.insert(agents).values({ companyId: company!.id, name: "Writer agent", adapterType: "process" }).returning();
    const [issue] = await observer.insert(issues).values({ companyId: company!.id, title: "Writer task" }).returning();
    const runId = randomUUID(), leaseOwner = randomUUID(), bootId = randomUUID();
    await observer.insert(heartbeatRuns).values({ id: runId, companyId: company!.id, agentId: agent!.id, status: "running",
      runtimeMode: "native", nativeIssueId: issue!.id, issueId: issue!.id });
    await observer.insert(nativeRunFinalizations).values({ runId, companyId: company!.id, issueId: issue!.id, phase: "observed", attempt: 0,
      controllerBootId: bootId, controllerPid: process.pid, controllerProcessStartedAt: new Date(), controllerGeneration: 1,
      leaseOwner, leaseExpiresAt: options.leaseExpiresAt ?? new Date(Date.now() + 3_600_000) });
    const owner = { companyId: company!.id, issueId: issue!.id, runId, authorityRunId: runId, bootId, generation: 1, leaseOwner };
    const write = nativeRunnerCheckpointWriter(db, owner);
    const checkpoint = (changed: Map<string, string>, reset = false) => ({
      runId, records: new Map(changed), changedRecords: changed, removedRecords: [], reset, workCommandIds: [], predecessor: null,
      runnerVersion: "test", runnerDigest: `sha256:${"a".repeat(64)}`,
      recoveryEvidence: { runnerInstanceId: "test", normalizedSessionId: "test", authenticatedConnectionCount: 1, highestRecordedSourceSeq: 0 },
      restoreSessionDirectory() {},
    }) as unknown as Parameters<typeof write>[0];
    const step = (seq: number) => checkpoint(new Map([[`event:${seq}`, JSON.stringify({ seq })], ["cursor", JSON.stringify({ ackedSourceSeq: seq })]]));
    return { owner, runId, companyId: company!.id, agentId: agent!.id, write, checkpoint, step };
  };

  const stored = async (runId: string) => {
    const cipher = createLocalEncryptedCipher("read");
    const rows = await observer.select({ part: nativeRunnerCheckpoints.part, material: nativeRunnerCheckpoints.material })
      .from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, runId));
    return new Map(rows.map(row => [row.part, (JSON.parse(cipher.decrypt(row.material)) as { contents: string }).contents]));
  };
  const cursorOf = async (runId: string) => {
    const cursor = (await stored(runId)).get("cursor");
    return cursor === undefined ? null : (JSON.parse(cursor) as { ackedSourceSeq: number }).ackedSourceSeq;
  };
  const routineStatements = (db: Db) => {
    const statements: string[] = [];
    const options = checkpointDb(db).$client.options as { debug?: unknown };
    options.debug = (_connection: number, text: string) => { statements.push(text); };
    return { count: () => statements.filter(text => text === ROUTINE_CHECKPOINT_SAVE_SQL).length, restore: () => { options.debug = undefined; } };
  };
  const writerBackends = async (state?: string) => (await observer.$client.unsafe<{ pid: number; application_name: string; wait_event_type: string | null }[]>(
    "select pid, application_name, wait_event_type from pg_stat_activity where application_name like 'paperclip-writer-%'"))
    .filter(row => state === undefined || row.wait_event_type === state);
  const until = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("condition not reached");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const holdOwnerRow = async (runId: string) => {
    let release!: (expire: boolean) => void;
    const released = new Promise<boolean>(resolve => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>(resolve => { locked = resolve; });
    const transaction = observer.transaction(async tx => {
      await tx.execute(sql`select 1 from native_run_finalizations where run_id = ${runId} for update`);
      locked();
      if (await released) {
        await tx.update(nativeRunFinalizations).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(nativeRunFinalizations.runId, runId));
      }
    });
    await lockTaken;
    return { release: async (expire = false) => { release(expire); await transaction; } };
  };

  it("with the flag off starts no worker and runs today's statement on the checkpoint pool", async () => {
    const db = open();
    const before = spawned.count;
    expect(installWriterThreads(db, temporary.connectionString, readWriterThreadSettings({}))).toBeNull();
    expect(writerThreadsFor(db)).toBeUndefined();
    const f = await fixture(db);
    const statements = routineStatements(db);
    try {
      await f.write(f.step(1));
      await f.write(f.step(2));
    } finally { statements.restore(); }
    expect(statements.count()).toBe(2);
    expect(spawned.count).toBe(before);
    expect(await cursorOf(f.runId)).toBe(2);
  });

  it("commits a routine save on a writer thread before the caller is acknowledged", async () => {
    const db = open();
    const threads = installWriterThreads(db, temporary.connectionString, settings())!;
    const before = spawned.count;
    const f = await fixture(db);
    const statements = routineStatements(db);
    try {
      for (let seq = 1; seq <= 20; seq++) {
        await f.write(f.step(seq));
        const now = await stored(f.runId);
        expect(now.get(`event:${seq}`)).toBe(JSON.stringify({ seq }));
        expect(await cursorOf(f.runId)).toBe(seq);
      }
    } finally { statements.restore(); }
    expect(statements.count()).toBe(0);
    expect(spawned.count).toBe(before + 1);
    expect(threads.stats()).toMatchObject({ submitted: 20, completed: 20, failed: 0, lost: 0 });
  });

  it("keeps each run's saves in submission order while many runs write at once", async () => {
    const db = open();
    const threads = installWriterThreads(db, temporary.connectionString, settings({ threads: 3 }))!;
    const runs = await Promise.all(Array.from({ length: 24 }, () => fixture(db)));
    const settledOrder = new Map<string, number[]>();
    await Promise.all(runs.flatMap(f => Array.from({ length: 12 }, (_, index) => index + 1).map(seq =>
      threads.saveRoutineCheckpoint(f.owner, f.step(seq).changedRecords).then(saved => {
        expect(saved).toEqual({ owned: 1, written: 2 });
        settledOrder.set(f.runId, [...settledOrder.get(f.runId) ?? [], seq]);
      }))));
    await Promise.all(runs.map(async f => {
      for (let seq = 13; seq <= 20; seq++) await f.write(f.step(seq));
    }));
    for (const f of runs) {
      expect(settledOrder.get(f.runId)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
      expect(await cursorOf(f.runId)).toBe(20);
      expect((await stored(f.runId)).size).toBe(21);
    }
  });

  it("delivers the same settled events and hints to main-thread listeners with the flag on and off", async () => {
    const record = async (db: Db) => {
      const f = await fixture(db);
      const events: string[] = [];
      const anonymise = (value: string) => value.replaceAll(f.companyId, "<company>").replaceAll(f.runId, "<run>").replaceAll(f.agentId, "<agent>");
      const unsubscribe = Object.values(DELIVERY_QUEUES).map(topic => subscribeDatabaseWork(db, topic, (event, hints) => {
        events.push(`${topic} ${event} ${anonymise(JSON.stringify([...hints ?? []].sort()))}`);
      }));
      try {
        await f.write(f.checkpoint(new Map([["header", "{}"], ["cursor", JSON.stringify({ ackedSourceSeq: 0 })]]), true));
        for (let seq = 1; seq <= 3; seq++) await f.write(f.step(seq));
        await f.write(f.checkpoint(new Map([["header", "{}"], ["cursor", JSON.stringify({ ackedSourceSeq: 3 })]]), true));
        await f.write(f.step(4));
        await observer.update(nativeRunFinalizations).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(nativeRunFinalizations.runId, f.runId));
        await expect(f.write(f.step(5))).rejects.toThrow("native_runner_checkpoint_owner_lost");
      } finally { for (const stop of unsubscribe) stop(); }
      return { events, cursor: await cursorOf(f.runId), parts: [...(await stored(f.runId)).keys()].sort() };
    };
    const off = await record(open());
    const on = open();
    const threads = installWriterThreads(on, temporary.connectionString, settings())!;
    const withThreads = await record(on);
    expect(threads.stats().completed).toBe(5);
    expect(off.events.length).toBeGreaterThan(0);
    expect(withThreads).toEqual(off);
  });

  it("writes nothing for a save queued behind a revoke, and nothing once the lease is lost", async () => {
    const db = open();
    const threads = installWriterThreads(db, temporary.connectionString, settings({ threads: 1 }))!;
    const f = await fixture(db);
    await f.write(f.step(1));
    const hold = await holdOwnerRow(f.runId);
    const first = threads.saveRoutineCheckpoint(f.owner, f.step(2).changedRecords);
    const second = threads.saveRoutineCheckpoint(f.owner, f.step(3).changedRecords);
    await until(async () => (await writerBackends("Lock")).length === 1);
    threads.revoke();
    await hold.release();
    await expect(first).resolves.toEqual({ owned: 1, written: 2 });
    await expect(second).rejects.toBeInstanceOf(WriterThreadsClosedError);
    expect(await cursorOf(f.runId)).toBe(2);
    expect((await stored(f.runId)).has("event:3")).toBe(false);

    const lost = await holdOwnerRow(f.runId);
    const blocked = f.write(f.step(4));
    await until(async () => (await writerBackends("Lock")).length === 1);
    await lost.release(true);
    await expect(blocked).rejects.toThrow("native_runner_checkpoint_owner_lost");
    expect(await cursorOf(f.runId)).toBe(2);
    expect((await stored(f.runId)).has("event:4")).toBe(false);
  });

  it("flushes in-flight saves at shutdown, refuses later ones, and leaves no writer connection behind", async () => {
    const db = open();
    const threads = installWriterThreads(db, temporary.connectionString, settings())!;
    const runs = await Promise.all(Array.from({ length: 6 }, () => fixture(db)));
    const inFlight = runs.map(f => f.write(f.step(1)));
    await closeWriterThreads(db, 5_000);
    await Promise.all(inFlight);
    for (const f of runs) expect(await cursorOf(f.runId)).toBe(1);
    await expect(runs[0]!.write(runs[0]!.step(2))).rejects.toBeInstanceOf(WriterThreadsClosedError);
    expect(await cursorOf(runs[0]!.runId)).toBe(1);
    expect(threads.stats().completed).toBe(6);
    expect(await writerBackends()).toEqual([]);
  });

  it("finishes a save on the main thread, once and in order, when its writer thread dies mid-save", async () => {
    const db = open();
    const threads = installWriterThreads(db, temporary.connectionString, settings({ threads: 1 }))!;
    const f = await fixture(db);
    await f.write(f.step(1));
    await until(async () => (await writerBackends()).length > 0);
    const hold = await holdOwnerRow(f.runId);
    const save = f.write(f.step(2));
    await until(async () => (await writerBackends("Lock")).length === 1);
    await threads.workerForTests(0)!.terminate();
    await until(async () => (await writerBackends("Lock")).length === 0);
    await hold.release();
    await save;
    expect(await cursorOf(f.runId)).toBe(2);
    await f.write(f.step(3));
    expect(await cursorOf(f.runId)).toBe(3);
    expect([...(await stored(f.runId)).keys()].sort()).toEqual(["cursor", "event:1", "event:2", "event:3"]);
    const [{ rows }] = await observer.$client.unsafe<{ rows: number }[]>(
      "select count(*)::int as rows from native_runner_checkpoints where run_id = $1", [f.runId]);
    expect(rows).toBe(4);
    expect(threads.stats()).toMatchObject({ lost: 1, respawned: 1 });
  });

  it("treats a writer thread that stops answering as lost and finishes the save on the main thread", async () => {
    const db = open();
    const threads = installWriterThreads(db, temporary.connectionString, settings({ threads: 1, timeoutMs: 400 }))!;
    const f = await fixture(db);
    await f.write(f.step(1));
    await until(async () => (await writerBackends()).length > 0);
    const hold = await holdOwnerRow(f.runId);
    const save = f.write(f.step(2));
    await until(async () => threads.stats().lost === 1);
    await hold.release();
    await save;
    expect(await cursorOf(f.runId)).toBe(2);
    expect((await stored(f.runId)).get("event:2")).toBe(JSON.stringify({ seq: 2 }));
  });
});
