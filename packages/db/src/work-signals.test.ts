import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, withDedicatedDbConnection } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { DATABASE_WORK_CHANNEL, databaseWorkScopeKey, databaseWorkPending, enableDatabaseWorkNotifications, installDatabaseWorkSignals, notifyDatabaseWorkOnCommit, reconcileDatabaseWork, signalDatabaseWork, subscribeDatabaseWork } from "./work-signals.js";

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

  it("sends an untracked commit-bound hint that leaves nothing to reconcile", async () => {
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, "untracked", event => events.push(event));
    try {
      await expect(db.transaction(async tx => {
        await notifyDatabaseWorkOnCommit(tx, "untracked");
        throw new Error("abort");
      })).rejects.toThrow("abort");
      await db.transaction(async tx => { await notifyDatabaseWorkOnCommit(tx, "untracked"); });
      expect(databaseWorkPending(db, "untracked")).toBe(false);
      expect(events).toEqual([]);
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

  it("coalesces scoped hints and publishes them only when the outer transaction settles", async () => {
    const settled: string[][] = [];
    const unsubscribe = subscribeDatabaseWork(db, "scoped", (event, hints) => {
      if (event === "settled") settled.push([...(hints ?? [])]);
    });
    try {
      await db.transaction(async tx => {
        await signalDatabaseWork(tx, "scoped", "connection-a");
        await tx.transaction(async nested => {
          await signalDatabaseWork(nested, "scoped", "connection-b");
          await signalDatabaseWork(nested, "scoped", "connection-a");
        });
        expect(settled).toEqual([]);
      });
      expect(settled).toEqual([["connection-a", "connection-b"]]);
    } finally { unsubscribe(); }
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
    const settled: string[][] = [];
    const unsubscribe = subscribeDatabaseWork(owner, topic, (event, hints) => {
      if (event === "settled") settled.push([...(hints ?? [])]);
    });
    try {
      await expect(owner.transaction(async tx => {
        await signalDatabaseWork(tx, topic, "connection-late");
        await tx.execute(sql`insert into work_signal_test values (${topic})`);
      })).rejects.toThrow("lost transaction response");
      await reconcileDatabaseWork(owner, topic);
      expect(databaseWorkPending(owner, topic)).toBe(true);
      expect(await db.execute(sql`select * from work_signal_test where id = ${topic}`)).toHaveLength(0);
      settled.length = 0;
      release(); await serverDone.catch(() => {});
      await reconcileDatabaseWork(owner, topic);
      expect(settled).toEqual([["connection-late"]]);
      expect(databaseWorkPending(owner, topic)).toBe(false);
      expect(await db.execute(sql`select * from work_signal_test where id = ${topic}`)).toHaveLength(outcome === "commit" ? 1 : 0);
    } finally { release(); await serverDone?.catch(() => {}); unsubscribe(); }
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


describe("database work scope identity", () => {
  type TestConnection = { execute: () => Promise<unknown[]>; transaction: (callback: (tx: TestConnection) => unknown) => Promise<unknown> };
  function connection(): TestConnection {
    return { execute: vi.fn(async () => []), transaction: async callback => callback(connection()) };
  }
  it("shares owner identity through child pools and nested transactions, but isolates independent owners", async () => {
    const first = installDatabaseWorkSignals(connection());
    const second = installDatabaseWorkSignals(connection());
    const child = installDatabaseWorkSignals(connection(), first);
    const key = databaseWorkScopeKey(first);
    expect(databaseWorkScopeKey(second)).not.toBe(key);
    expect(databaseWorkScopeKey(child)).toBe(key);
    await child.transaction(async tx => {
      expect(databaseWorkScopeKey(tx)).toBe(key);
      await tx.transaction(async nested => { expect(databaseWorkScopeKey(nested)).toBe(key); });
    });
  });
});

(support.supported ? describe : describe.skip)("database work notifications flushed once per transaction", () => {
  let db: ReturnType<typeof createDb>;
  let listener: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const delivered: string[] = [];
  let notifyStatements = 0;
  let sentPayloads: string[] = [];
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("work-signals-notify-");
    db = createDb(temporary.connectionString);
    enableDatabaseWorkNotifications(db);
    listener = createDb(temporary.connectionString, { maxConnections: 1 });
    await listener.$client.listen(DATABASE_WORK_CHANNEL, payload => { delivered.push(payload); });
    db.$client.options.debug = (_connection: number, query: string, parameters: unknown[]) => {
      if (!/pg_notify/.test(query) || parameters.some(value => String(value).includes("fence"))) return;
      notifyStatements += 1;
      sentPayloads.push(...JSON.parse(String(parameters[parameters.length - 1])) as string[]);
    };
  }, 90_000);
  afterAll(async () => {
    await listener?.$client.end({ timeout: 1 });
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });
  const topic = (payload: string) => (JSON.parse(payload) as { topic: string }).topic;
  async function run(action: (root: typeof db) => Promise<unknown>) {
    notifyStatements = 0;
    sentPayloads = [];
    delivered.length = 0;
    let failure: unknown = null;
    await action(db).catch(error => { failure = error; });
    await db.execute(sql`select pg_notify(${DATABASE_WORK_CHANNEL}, ${JSON.stringify({ topic: "fence" })})`);
    await vi.waitFor(() => expect(delivered.some(payload => topic(payload) === "fence")).toBe(true));
    const received = delivered.filter(payload => topic(payload) !== "fence");
    return { statements: notifyStatements, sent: sentPayloads.map(topic), delivered: received.map(topic), payloads: received,
      failure: failure instanceof Error ? failure.message : failure };
  }
  const rollback = () => { throw new Error("rollback"); };

  it("sends every distinct topic of a transaction in one statement at commit, in first-signal order", async () => {
    const result = await run(root => root.transaction(async tx => {
      await signalDatabaseWork(tx, "a", "one");
      await signalDatabaseWork(tx, "b");
      await signalDatabaseWork(tx, "a", "two");
      await notifyDatabaseWorkOnCommit(tx, "c");
      expect(notifyStatements).toBe(0);
    }));
    expect(result).toMatchObject({ statements: 1, sent: ["a", "b", "c"], delivered: ["a", "b", "c"], failure: null });
    expect(result.payloads.map(payload => JSON.parse(payload))).toEqual(["a", "b", "c"].map(name =>
      ({ version: 1, origin: expect.any(String), topic: name })));
  });

  it("sends nothing for a transaction that signals nothing", async () => {
    expect(await run(root => root.transaction(async tx => { await tx.execute(sql`select 1`); })))
      .toMatchObject({ statements: 0, delivered: [] });
  });

  it("keeps a released savepoint's topics, two levels deep, and drops a rolled-back savepoint's topics", async () => {
    expect(await run(root => root.transaction(async tx => {
      await tx.transaction(async first => {
        await first.transaction(async second => { await signalDatabaseWork(second, "kept"); });
        await first.transaction(async second => { await signalDatabaseWork(second, "dropped"); rollback(); }).catch(() => {});
      });
      await tx.transaction(async nested => { await signalDatabaseWork(nested, "dropped-too"); rollback(); }).catch(() => {});
    }))).toMatchObject({ statements: 1, sent: ["kept"], delivered: ["kept"], failure: null });
  });

  it("still sends a topic signalled in a rolled-back savepoint when the outer level signals it again", async () => {
    expect(await run(root => root.transaction(async tx => {
      await tx.transaction(async nested => { await signalDatabaseWork(nested, "a"); rollback(); }).catch(() => {});
      await signalDatabaseWork(tx, "a");
    }))).toMatchObject({ statements: 1, delivered: ["a"] });
    expect(await run(root => root.transaction(async tx => {
      await signalDatabaseWork(tx, "a");
      await tx.transaction(async nested => { await signalDatabaseWork(nested, "a"); rollback(); }).catch(() => {});
    }))).toMatchObject({ statements: 1, delivered: ["a"] });
  });

  it("sends nothing when the callback throws", async () => {
    expect(await run(root => root.transaction(async tx => { await signalDatabaseWork(tx, "a"); rollback(); })))
      .toMatchObject({ statements: 0, delivered: [], failure: "rollback" });
  });

  it("fails and rolls back the transaction when the commit-time send fails", async () => {
    await db.execute(sql`create table if not exists work_signal_flush_test (id text primary key)`);
    const result = await run(root => root.transaction(async tx => {
      await tx.execute(sql`insert into work_signal_flush_test values ('flush')`);
      await signalDatabaseWork(tx, "a");
      await tx.execute(sql`select 1 / 0`).catch(() => {});
    }));
    expect(result.delivered).toEqual([]);
    expect(result.statements).toBe(1);
    expect(result.failure).toMatch(/pg_notify/);
    expect(await db.execute(sql`select id from work_signal_flush_test where id = 'flush'`)).toHaveLength(0);
  });

  it("sends a large number of distinct topics in one bounded statement", async () => {
    const names = Array.from({ length: 500 }, (_, index) => `topic-${index}`);
    const result = await run(root => root.transaction(async tx => { for (const name of names) await signalDatabaseWork(tx, name); }));
    expect(result.statements).toBe(1);
    expect(result.delivered).toEqual(names);
  });

  it("rejects a signal recorded after its transaction or savepoint ended instead of losing it", async () => {
    let outer: Parameters<Parameters<typeof db.transaction>[0]>[0] | undefined;
    let savepoint: typeof outer;
    const result = await run(root => root.transaction(async tx => {
      outer = tx;
      await signalDatabaseWork(tx, "a");
      await tx.transaction(async nested => { savepoint = nested; await signalDatabaseWork(nested, "b"); });
      await expect(signalDatabaseWork(savepoint!, "late-savepoint")).rejects.toThrow("after its transaction or savepoint ended");
      await expect(notifyDatabaseWorkOnCommit(savepoint!, "late-savepoint")).rejects.toThrow("after its transaction or savepoint ended");
    }));
    expect(result).toMatchObject({ statements: 1, delivered: ["a", "b"], failure: null });
    await expect(signalDatabaseWork(outer!, "late-outer")).rejects.toThrow("after its transaction or savepoint ended");
    await expect(notifyDatabaseWorkOnCommit(outer!, "late-outer")).rejects.toThrow("after its transaction or savepoint ended");
  });

  it("starts every transaction clean, including concurrent transactions and a retried callback", async () => {
    expect(await run(async root => {
      await root.transaction(async tx => { await signalDatabaseWork(tx, "a"); });
      await root.transaction(async tx => { await signalDatabaseWork(tx, "a"); });
      await Promise.all([1, 2].map(() => root.transaction(async tx => { await signalDatabaseWork(tx, "b"); })));
      let attempts = 0;
      const callback = async (tx: Parameters<Parameters<typeof root.transaction>[0]>[0]) => {
        attempts += 1;
        await signalDatabaseWork(tx, "c");
        if (attempts === 1) rollback();
      };
      await root.transaction(callback).catch(() => {});
      await root.transaction(callback);
    })).toMatchObject({ statements: 5, delivered: ["a", "a", "b", "b", "c"] });
  });
});
