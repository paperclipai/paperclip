import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEDICATED_CONNECTION_IDLE_MAX,
  closeDedicatedDbConnections,
  createDb,
  withDedicatedDbConnection,
  type Db,
} from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const APPLICATION_NAME = "paperclip-workspace-finalization-lock";

type Session = { pid: number; backendStart: string };

async function session(db: Pick<Db, "execute">): Promise<Session> {
  const [row] = await db.execute<{ pid: number; backend_start: string }>(sql`select pg_backend_pid() as pid,
    (select backend_start::text from pg_stat_activity where pid = pg_backend_pid()) as backend_start`);
  return { pid: Number(row.pid), backendStart: String(row.backend_start) };
}

const key = (value: Session) => `${value.pid}@${value.backendStart}`;

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (accept(value) || Date.now() > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.skipIf(!support.supported)("withDedicatedDbConnection connection reuse", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let observer: Db;
  const owners: Db[] = [];

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("dedicated-pool-");
    observer = createDb(temporary.connectionString, { maxConnections: 1, applicationName: "dedicated-pool-observer" });
  }, 90_000);
  afterEach(async () => {
    for (const db of owners.splice(0)) {
      await closeDedicatedDbConnections(db, 1);
      await db.$client.end({ timeout: 1 });
    }
  });
  afterAll(async () => {
    await observer?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  function owner() {
    const db = createDb(temporary.connectionString, { maxConnections: 2 });
    owners.push(db);
    return db;
  }

  async function openDedicatedSessions(): Promise<Session[]> {
    const rows = await observer.execute<{ pid: number; backend_start: string }>(sql`select pid, backend_start::text as backend_start
      from pg_stat_activity where application_name = ${APPLICATION_NAME} and datname = current_database()`);
    return rows.map(row => ({ pid: Number(row.pid), backendStart: String(row.backend_start) }));
  }

  it("reuses a bounded set of physical connections across 200 sequential calls", async () => {
    const db = owner();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(key(await withDedicatedDbConnection(db, dedicated => dedicated.transaction(tx => session(tx)))));
    }
    expect(seen.size).toBe(1);
    expect(seen.size).toBeLessThanOrEqual(DEDICATED_CONNECTION_IDLE_MAX);
  });

  it("gives concurrent callers exclusive sessions and keeps at most the cap open afterwards", async () => {
    const db = owner();
    const concurrency = DEDICATED_CONNECTION_IDLE_MAX + 3;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived = 0;
    let allArrived!: () => void;
    const everyoneHolding = new Promise<void>(resolve => { allArrived = resolve; });
    const held = Array.from({ length: concurrency }, () => withDedicatedDbConnection(db, dedicated =>
      dedicated.transaction(async tx => {
        const mine = await session(tx);
        await tx.execute(sql`select pg_advisory_xact_lock(${mine.pid})`);
        if (++arrived === concurrency) allArrived();
        await gate;
        expect(await session(tx)).toEqual(mine);
        return mine;
      })));
    await everyoneHolding;
    release();
    const sessions = await Promise.all(held);
    expect(new Set(sessions.map(key)).size).toBe(concurrency);
    expect((await eventually(openDedicatedSessions, open => open.length <= DEDICATED_CONNECTION_IDLE_MAX)).length)
      .toBeLessThanOrEqual(DEDICATED_CONNECTION_IDLE_MAX);
    const retained = new Set(sessions.map(key));
    for (let i = 0; i < 20; i++) {
      expect(retained.has(key(await withDedicatedDbConnection(db, session)))).toBe(true);
    }
  });

  it("discards a connection whose action failed mid-transaction", async () => {
    const db = owner();
    let failed: Session | undefined;
    await expect(withDedicatedDbConnection(db, dedicated => dedicated.transaction(async tx => {
      failed = await session(tx);
      await tx.execute(sql`select 1 / 0`);
    }))).rejects.toThrow();
    expect(failed).toBeDefined();
    const next = await withDedicatedDbConnection(db, session);
    expect(key(next)).not.toBe(key(failed!));
    const open = await eventually(openDedicatedSessions, rows => !rows.map(key).includes(key(failed!)));
    expect(open.map(key)).not.toContain(key(failed!));
  });

  it("discards a connection whose socket broke during the action", async () => {
    const db = owner();
    let broken: Session | undefined;
    await expect(withDedicatedDbConnection(db, async dedicated => {
      broken = await session(dedicated);
      await observer.execute(sql`select pg_terminate_backend(${broken.pid})`);
      await session(dedicated);
    })).rejects.toThrow();
    const next = await withDedicatedDbConnection(db, session);
    expect(next.pid).not.toBe(broken!.pid);
  });

  it("recovers when an idle retained connection is terminated between calls", async () => {
    const db = owner();
    const first = await withDedicatedDbConnection(db, session);
    await observer.execute(sql`select pg_terminate_backend(${first.pid})`);
    await eventually(openDedicatedSessions, rows => !rows.some(row => row.pid === first.pid));
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await withDedicatedDbConnection(db, session);
    expect(second.pid).not.toBe(first.pid);
  });

  it("never reuses a connection the action ended itself", async () => {
    const db = owner();
    const first = await withDedicatedDbConnection(db, async dedicated => {
      const value = await session(dedicated);
      await dedicated.$client.end({ timeout: 0 });
      return value;
    });
    const second = await withDedicatedDbConnection(db, session);
    expect(second.pid).not.toBe(first.pid);
  });

  it("keeps transaction-local settings out of the next action", async () => {
    const db = owner();
    await withDedicatedDbConnection(db, dedicated => dedicated.transaction(tx =>
      tx.execute(sql`select set_config('statement_timeout', '1234', true), set_config('lock_timeout', '567', true)`)));
    const [row] = await withDedicatedDbConnection(db, dedicated => dedicated.execute<{ statement_timeout: string; lock_timeout: string }>(
      sql`select current_setting('statement_timeout') as statement_timeout, current_setting('lock_timeout') as lock_timeout`));
    expect(row).toEqual({ statement_timeout: "0", lock_timeout: "0" });
  });

  it("closes every retained connection on shutdown and stays usable without retaining more", async () => {
    const db = owner();
    await Promise.all(Array.from({ length: DEDICATED_CONNECTION_IDLE_MAX }, () =>
      withDedicatedDbConnection(db, dedicated => dedicated.transaction(async tx => {
        await tx.execute(sql`select pg_sleep(0.05)`);
      }))));
    expect((await openDedicatedSessions()).length).toBeGreaterThan(0);
    await closeDedicatedDbConnections(db, 1);
    expect(await eventually(openDedicatedSessions, rows => rows.length === 0)).toEqual([]);
    await withDedicatedDbConnection(db, session);
    expect(await eventually(openDedicatedSessions, rows => rows.length === 0)).toEqual([]);
  });

  it("closes retained connections when the owner client ends", async () => {
    const db = createDb(temporary.connectionString, { maxConnections: 1 });
    await withDedicatedDbConnection(db, session);
    expect((await openDedicatedSessions()).length).toBe(1);
    await db.$client.end({ timeout: 1 });
    expect(await eventually(openDedicatedSessions, rows => rows.length === 0)).toEqual([]);
  });

  it("shares one retained set with nested dedicated actions without blocking them", async () => {
    const db = owner();
    const [outer, inner] = await withDedicatedDbConnection(db, async dedicated => {
      const mine = await session(dedicated);
      const nested = await withDedicatedDbConnection(dedicated, session);
      return [mine, nested];
    });
    expect(inner.pid).not.toBe(outer.pid);
    const reused = new Set<number>();
    for (let i = 0; i < 10; i++) reused.add((await withDedicatedDbConnection(db, session)).pid);
    expect([...reused].every(pid => pid === outer.pid || pid === inner.pid)).toBe(true);
  });
});
