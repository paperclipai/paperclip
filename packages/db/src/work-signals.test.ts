import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, withDedicatedDbConnection } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { databaseWorkPending, installDatabaseWorkSignals, reconcileDatabaseWork, signalDatabaseWork, subscribeDatabaseWork } from "./work-signals.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("database work signals", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("work-signals-");
    db = createDb(temporary.connectionString);
    await db.execute(sql`create table work_signal_test (id text primary key)`);
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it("defers nested savepoint notifications until the outer commit and preserves return values", async () => {
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, "nested", event => events.push(event));
    try {
      const result = await db.transaction(async tx => {
        await tx.transaction(async nested => {
          await signalDatabaseWork(nested, "nested");
          await nested.execute(sql`insert into work_signal_test values ('nested')`);
        });
        expect(events).toEqual(["intent"]);
        expect(databaseWorkPending(db, "nested")).toBe(true);
        expect(await db.execute(sql`select * from work_signal_test where id = 'nested'`)).toHaveLength(0);
        return 123;
      });
      expect(result).toBe(123);
      expect(events).toEqual(["intent", "settled"]);
      expect(databaseWorkPending(db, "nested")).toBe(false);
      expect(await db.execute(sql`select * from work_signal_test where id = 'nested'`)).toHaveLength(1);
    } finally { unsubscribe(); }
  });

  it("reconciles a rollback without leaving a permanent pending flag", async () => {
    await expect(db.transaction(async tx => {
      await signalDatabaseWork(tx, "rollback");
      await tx.execute(sql`insert into work_signal_test values ('rollback')`);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    await reconcileDatabaseWork(db, "rollback");
    expect(databaseWorkPending(db, "rollback")).toBe(false);
    expect(await db.execute(sql`select * from work_signal_test where id = 'rollback'`)).toHaveLength(0);
  });

  it("keeps outer ownership after a caught savepoint rollback", async () => {
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, "savepoint", event => events.push(event));
    try {
      await db.transaction(async tx => {
        await expect(tx.transaction(async nested => {
          await signalDatabaseWork(nested, "savepoint");
          await nested.execute(sql`insert into work_signal_test values ('savepoint')`);
          throw new Error("rollback savepoint");
        })).rejects.toThrow("rollback savepoint");
        expect(databaseWorkPending(db, "savepoint")).toBe(true);
        expect(events).toEqual(["intent"]);
        await signalDatabaseWork(tx, "savepoint");
        await tx.execute(sql`insert into work_signal_test values ('savepoint-retry')`);
      });
      expect(events).toEqual(["intent", "intent", "settled"]);
      expect(databaseWorkPending(db, "savepoint")).toBe(false);
    } finally { unsubscribe(); }
  });

  it.each(["commit", "abort"])("does not clear a late %s until PostgreSQL reports a settled transaction", async outcome => {
    // Inject a lost response at the client boundary while a REAL transaction
    // remains open on PostgreSQL. The status probe and row visibility are real.
    const raw = drizzle(db.$client);
    const transaction = raw.transaction.bind(raw);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let wrote!: () => void;
    const written = new Promise<void>(resolve => { wrote = resolve; });
    let serverDone!: Promise<unknown>;
    raw.transaction = ((callback: any) => {
      serverDone = transaction(async tx => {
        const result = await callback(tx);
        wrote();
        await gate;
        if (outcome === "abort") throw new Error("server abort");
        return result;
      });
      // Observe rejection immediately; tests await the same result below.
      void serverDone.catch(() => {});
      return written.then(() => { throw new Error("lost transaction response"); });
    }) as typeof raw.transaction;
    const owner = installDatabaseWorkSignals(raw);
    const topic = `late-${outcome}`;
    try {
      await expect(owner.transaction(async tx => {
        await signalDatabaseWork(tx, topic);
        await tx.execute(sql`insert into work_signal_test values (${topic})`);
      })).rejects.toThrow("lost transaction response");
      await reconcileDatabaseWork(owner, topic);
      expect(databaseWorkPending(owner, topic)).toBe(true);
      expect(await db.execute(sql`select * from work_signal_test where id = ${topic}`)).toHaveLength(0);
      release(); await serverDone.catch(() => {});
      await reconcileDatabaseWork(owner, topic);
      expect(databaseWorkPending(owner, topic)).toBe(false);
      expect(await db.execute(sql`select * from work_signal_test where id = ${topic}`)).toHaveLength(outcome === "commit" ? 1 : 0);
    } finally { release(); await serverDone?.catch(() => {}); }
  });

  it("recovers after a real backend disconnect without replaying the queue write", async () => {
    await expect(db.transaction(async tx => {
      await signalDatabaseWork(tx, "disconnect");
      await tx.execute(sql`insert into work_signal_test values ('disconnect')`);
      const [{ pid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await db.execute(sql`select pg_terminate_backend(${pid as number})`);
      await tx.execute(sql`select 1`);
    })).rejects.toThrow();
    await reconcileDatabaseWork(db, "disconnect");
    expect(databaseWorkPending(db, "disconnect")).toBe(false);
    expect(await db.execute(sql`select * from work_signal_test where id = 'disconnect'`)).toHaveLength(0);
  });

  it("shares notifications with dedicated child pools but isolates unrelated roots and topics", async () => {
    const listener = vi.fn();
    const other = createDb(temporary.connectionString);
    const unsubscribe = subscribeDatabaseWork(db, "dedicated", listener);
    try {
      await other.transaction(tx => signalDatabaseWork(tx, "dedicated"));
      await db.transaction(tx => signalDatabaseWork(tx, "other"));
      expect(listener).not.toHaveBeenCalled();
      await withDedicatedDbConnection(db, dedicated => dedicated.transaction(tx => signalDatabaseWork(tx, "dedicated")));
      expect(listener.mock.calls.map(([event]) => event)).toEqual(["intent", "settled"]);
    } finally { unsubscribe(); await other.$client.end(); }
  });

  it("never changes transaction success because a listener throws", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const unsubscribe = subscribeDatabaseWork(db, "listener", () => { throw new Error("listener"); });
    try {
      await expect(db.transaction(async tx => { await signalDatabaseWork(tx, "listener"); return 7; })).resolves.toBe(7);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); warn.mockRestore(); }
  });
});

describe("work signal query boundaries", () => {
  it("adds no SQL to transactions which do not register queue work", async () => {
    const execute = vi.fn();
    const connection = installDatabaseWorkSignals({ execute, transaction: async (callback: any) => callback({ execute, transaction: async () => {} }) });
    await expect(connection.transaction(async () => 19)).resolves.toBe(19);
    expect(execute).not.toHaveBeenCalled();
  });
  it("fails before the write if XID acquisition fails, without retaining uncertainty", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("disconnected"));
    const connection = installDatabaseWorkSignals({ execute, transaction: async (callback: any) => callback({ execute, transaction: async () => {} }) });
    const write = vi.fn();
    await expect(connection.transaction(async (tx: any) => { await signalDatabaseWork(tx, "failed"); write(); })).rejects.toThrow("disconnected");
    expect(write).not.toHaveBeenCalled();
    expect(databaseWorkPending(connection, "failed")).toBe(false);
  });
  it("rejects registration on an autocommit root", async () => {
    const connection = installDatabaseWorkSignals({ execute: vi.fn(), transaction: vi.fn() });
    await expect(signalDatabaseWork(connection, "bad")).rejects.toThrow("inside a transaction");
  });
});
