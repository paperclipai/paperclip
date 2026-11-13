import v8 from "node:v8";
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "./response-capture.js";
import { announcementDismissals, announcementPublications } from "./schema/index.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
import {
  databaseWorkPending, databaseWorkScopeKey, reconcileDatabaseWork, signalDatabaseWork, subscribeDatabaseWork,
} from "./work-signals.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
const allocatedBytes = () => (v8.getHeapStatistics() as { total_allocated_bytes?: number }).total_allocated_bytes;

/** Relational query builders a database object holds without `query` having been read. */
function builtQueryBuilders(connection: object): number {
  const query = Object.getOwnPropertyDescriptor(connection, "query")?.value as object | undefined;
  return query ? Object.keys(query).length : 0;
}

const publication = (tx: Pick<Db, "insert">, announcementId: string) =>
  tx.insert(announcementPublications).values({ announcementId });
const publicationIds = async (connection: Pick<Db, "select">) =>
  (await connection.select().from(announcementPublications)).map(row => row.announcementId).sort();
const backendPid = async (connection: Pick<Db, "execute">) =>
  (await connection.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;

describeEmbeddedPostgres("transactions on the Paperclip database client", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-db-lazy-transaction-queries-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await db.delete(announcementDismissals);
    await db.delete(announcementPublications);
  });
  afterAll(async () => { await database?.cleanup(); });

  describe("relational query builders", () => {
    it("builds none for a transaction or savepoint that never reads tx.query", async () => {
      const schemaTables = Object.keys(db.query).length;
      expect(schemaTables).toBeGreaterThan(100);
      expect(builtQueryBuilders(db)).toBe(schemaTables);
      const built = await db.transaction(async (tx) => {
        await publication(tx, "unread");
        const outer = builtQueryBuilders(tx);
        const savepoint = await tx.transaction(async (nested) => {
          await nested.select().from(announcementPublications);
          return builtQueryBuilders(nested);
        });
        return { outer, savepoint, outerAfterSavepoint: builtQueryBuilders(tx) };
      });
      expect(built).toEqual({ outer: 0, savepoint: 0, outerAfterSavepoint: 0 });
    });

    it.skipIf(allocatedBytes() === undefined)("allocates the same for an empty transaction as a client without the schema", async () => {
      const bareClient = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const bare = drizzle(bareClient);
        const perTransaction = async (connection: { transaction(callback: () => Promise<void>): Promise<void> }) => {
          for (let index = 0; index < 100; index += 1) await connection.transaction(async () => {});
          const before = allocatedBytes()!;
          for (let index = 0; index < 300; index += 1) await connection.transaction(async () => {});
          return (allocatedBytes()! - before) / 300;
        };
        const withoutSchema = await perTransaction(bare);
        const withSchema = await perTransaction(db);
        // Eager builders cost about 100 KB per transaction for 321 tables.
        expect(withSchema - withoutSchema).toBeLessThan(16 * 1024);
      } finally {
        await bareClient.end({ timeout: 1 });
      }
    });

    it("gives tx.query one builder per schema table, the same object on every read", async () => {
      await db.transaction(async (tx) => {
        const query = tx.query;
        expect(tx.query).toBe(query);
        expect(Object.keys(query)).toEqual(Object.keys(db.query));
        expect(builtQueryBuilders(tx)).toBe(Object.keys(db.query).length);
        expect(query.announcementPublications.constructor).toBe(db.query.announcementPublications.constructor);
        expect(query.announcementPublications).not.toBe(db.query.announcementPublications);
        expect(Object.keys(tx)).toContain("query");
        expect(tx._.fullSchema).toBe(db._.fullSchema);
        expect(tx._.schema).toBe(db._.schema);
        expect(tx._.tableNamesMap).toBe(db._.tableNamesMap);
        await tx.transaction(async (nested) => {
          expect(nested.query).not.toBe(query);
          expect(Object.keys(nested.query)).toEqual(Object.keys(db.query));
          expect(nested._.fullSchema).toBe(db._.fullSchema);
        });
      });
    });

    it("reads tx.query through the transaction, as the announcement and decision-training services do", async () => {
      await db.transaction(async (tx) => {
        await publication(tx, "in-transaction");
        await tx.insert(announcementDismissals).values({ userId: "user-1", announcementId: "in-transaction" });
        const known = await tx.query.announcementPublications.findFirst({
          where: eq(announcementPublications.announcementId, "in-transaction"),
        });
        expect(known).toEqual({ announcementId: "in-transaction" });
        const dismissal = await tx.query.announcementDismissals.findFirst({
          where: and(eq(announcementDismissals.userId, "user-1"), eq(announcementDismissals.announcementId, "in-transaction")),
        });
        expect(dismissal).toMatchObject({ userId: "user-1", announcementId: "in-transaction" });
        expect(dismissal!.dismissedAt).toBeInstanceOf(Date);
        expect(await tx.query.announcementPublications.findFirst({
          where: eq(announcementPublications.announcementId, "missing"),
        })).toBeUndefined();
        expect(await tx.query.announcementDismissals.findMany({ columns: { userId: true } })).toEqual([{ userId: "user-1" }]);
        // Another connection must not see the uncommitted rows the transaction's own query read.
        expect(await db.query.announcementPublications.findFirst({
          where: eq(announcementPublications.announcementId, "in-transaction"),
        })).toBeUndefined();
      });
      expect(await db.query.announcementPublications.findFirst({
        where: eq(announcementPublications.announcementId, "in-transaction"), columns: { announcementId: true },
      })).toEqual({ announcementId: "in-transaction" });
    });

    it("reads tx.query inside a savepoint and follows its rollback", async () => {
      await db.transaction(async (tx) => {
        await publication(tx, "outer");
        await expect(tx.transaction(async (nested) => {
          await publication(nested, "savepoint");
          expect((await nested.query.announcementPublications.findMany()).map(row => row.announcementId).sort())
            .toEqual(["outer", "savepoint"]);
          throw new Error("undo the savepoint");
        })).rejects.toThrow("undo the savepoint");
        expect(await tx.query.announcementPublications.findMany()).toEqual([{ announcementId: "outer" }]);
      });
      expect(await db.query.announcementPublications.findMany()).toEqual([{ announcementId: "outer" }]);
    });
  });

  describe("instrumentation of transactions", () => {
    const assignedXid = async (connection: Pick<Db, "execute">) =>
      (await connection.execute<{ xid: string | null }>(sql`select pg_current_xact_id_if_assigned()::text as xid`))[0]!.xid;

    it("registers each transaction and savepoint with the client's work signals", async () => {
      const events: string[] = [];
      const unsubscribe = subscribeDatabaseWork(db, "lazy-transaction-queries", event => events.push(event));
      try {
        await db.transaction(async (tx) => {
          expect(databaseWorkScopeKey(tx)).toBe(databaseWorkScopeKey(db));
          expect(await assignedXid(tx)).toBeNull();
          await tx.transaction(async (nested) => {
            expect(databaseWorkScopeKey(nested)).toBe(databaseWorkScopeKey(db));
            await signalDatabaseWork(nested, "lazy-transaction-queries");
            // The registration asked for the transaction ID on this transaction's connection.
            expect(await assignedXid(nested)).not.toBeNull();
            await publication(nested, "signalled");
          });
          expect(events).toEqual(["intent"]);
          expect(databaseWorkPending(db, "lazy-transaction-queries")).toBe(true);
          expect(await tx.query.announcementPublications.findMany()).toEqual([{ announcementId: "signalled" }]);
          // A released savepoint and a relational read settle nothing before the outer commit.
          expect(events).toEqual(["intent"]);
        });
        expect(events).toEqual(["intent", "settled"]);
        expect(databaseWorkPending(db, "lazy-transaction-queries")).toBe(false);

        await expect(db.transaction(async (tx) => {
          await signalDatabaseWork(tx, "lazy-transaction-queries");
          await publication(tx, "rolled-back");
          throw new Error("rollback");
        })).rejects.toThrow("rollback");
        expect(events).toEqual(["intent", "settled", "intent", "settled"]);
        await reconcileDatabaseWork(db, "lazy-transaction-queries");
        expect(databaseWorkPending(db, "lazy-transaction-queries")).toBe(false);
        expect(await publicationIds(db)).toEqual(["signalled"]);
        await expect(signalDatabaseWork(db, "lazy-transaction-queries")).rejects.toThrow("inside a transaction");
      } finally { unsubscribe(); }
    });

    it("response capture counts every statement of a transaction, a savepoint and tx.query", async () => {
      const events: Array<Record<string, unknown>> = [];
      const now = Date.now();
      const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
      const captured = createDb(database.connectionString, { maxConnections: 2 });
      try {
        installDatabaseResponseCapture(captured, { announcementPublications, announcementDismissals }, capture);
        await captured.transaction(async (tx: Tx) => {
          await publication(tx, "captured");
          await tx.select().from(announcementPublications);
          await tx.transaction(async (nested: Tx) => {
            await nested.update(announcementPublications).set({ announcementId: "captured-renamed" })
              .where(eq(announcementPublications.announcementId, "captured"));
            await nested.query.announcementPublications.findFirst({
              where: eq(announcementPublications.announcementId, "captured-renamed"),
            });
            await nested.delete(announcementDismissals);
          });
          await tx.query.announcementDismissals.findMany();
        });
        capture.flush();
        expect(events.find(event => event.event === "paperclip.db_response_capture.summary.v2"))
          .toMatchObject({ startedQueries: 6, completedQueries: 6, inFlightAtEnd: 0 });
        const calls: Record<string, number> = {};
        for (const event of events.filter(entry => entry.event === "paperclip.db_response_capture.entry.v2")) {
          const key = `${String(event.operation)} ${String(event.table)}`;
          calls[key] = (calls[key] ?? 0) + Number(event.calls);
        }
        expect(calls).toEqual({
          "insert announcement_publications": 1,
          "select announcement_publications": 2,
          "update announcement_publications": 1,
          "delete announcement_dismissals": 1,
          "select announcement_dismissals": 1,
        });
      } finally {
        capture.flush();
        await captured.$client.end({ timeout: 1 });
      }
    });
  });

  describe("transaction semantics", () => {
    it("commits and returns the callback's value", async () => {
      const result = await db.transaction(async (tx) => {
        await publication(tx, "committed");
        const [updated] = await tx.update(announcementPublications).set({ announcementId: "renamed" })
          .where(eq(announcementPublications.announcementId, "committed")).returning();
        await publication(tx, "deleted");
        await tx.delete(announcementPublications).where(eq(announcementPublications.announcementId, "deleted"));
        return updated;
      });
      expect(result).toEqual({ announcementId: "renamed" });
      expect(await publicationIds(db)).toEqual(["renamed"]);
    });

    it("rolls back and rejects with the thrown error", async () => {
      const failure = new Error("abort");
      await expect(db.transaction(async (tx) => {
        await publication(tx, "discarded");
        throw failure;
      })).rejects.toBe(failure);
      await expect(db.transaction(async (tx) => {
        await publication(tx, "discarded");
        tx.rollback();
      })).rejects.toBeInstanceOf(TransactionRollbackError);
      await expect(db.transaction(async (tx) => {
        await publication(tx, "duplicate");
        await publication(tx, "duplicate");
      })).rejects.toMatchObject({ cause: { code: "23505" } });
      expect(await publicationIds(db)).toEqual([]);
    });

    it("keeps the outer transaction usable after a savepoint rolls back", async () => {
      await db.transaction(async (tx) => {
        await publication(tx, "before");
        await expect(tx.transaction(async (nested) => {
          await publication(nested, "undone");
          await publication(nested, "undone");
        })).rejects.toMatchObject({ cause: { code: "23505" } });
        await expect(tx.transaction(async (nested) => {
          await publication(nested, "undone");
          nested.rollback();
        })).rejects.toBeInstanceOf(TransactionRollbackError);
        expect(await publicationIds(tx)).toEqual(["before"]);
        await tx.transaction(async (nested) => {
          await publication(nested, "released");
          await nested.transaction(async (inner) => { await publication(inner, "released-inner"); });
          await expect(nested.transaction(async (inner) => {
            await publication(inner, "undone-inner");
            throw new Error("inner");
          })).rejects.toThrow("inner");
        });
        await publication(tx, "after");
      });
      expect(await publicationIds(db)).toEqual(["after", "before", "released", "released-inner"]);
    });

    it("discards a released savepoint when the outer transaction rolls back", async () => {
      await expect(db.transaction(async (tx) => {
        await tx.transaction(async (nested) => { await publication(nested, "released"); });
        expect(await publicationIds(tx)).toEqual(["released"]);
        throw new Error("outer");
      })).rejects.toThrow("outer");
      expect(await publicationIds(db)).toEqual([]);
    });

    it("applies the isolation level and access mode", async () => {
      const settings = await db.transaction(async (tx) => {
        const [isolation] = await tx.execute<{ transaction_isolation: string }>(sql`show transaction_isolation`);
        const [readOnly] = await tx.execute<{ transaction_read_only: string }>(sql`show transaction_read_only`);
        return { ...isolation, ...readOnly };
      }, { isolationLevel: "serializable", accessMode: "read only" });
      expect(settings).toEqual({ transaction_isolation: "serializable", transaction_read_only: "on" });
      await expect(db.transaction(async (tx) => { await publication(tx, "read-only"); }, { accessMode: "read only" }))
        .rejects.toMatchObject({ cause: { code: "25006" } });
      const [isolation] = await db.transaction(
        async (tx) => tx.execute<{ transaction_isolation: string }>(sql`show transaction_isolation`));
      expect(isolation).toEqual({ transaction_isolation: "read committed" });
    });

    it("runs concurrent transactions on separate reserved connections and releases them", async () => {
      const pooled = createDb(database.connectionString, { maxConnections: 3 });
      let open = 0, mostOpen = 0;
      const pids = new Set<number>();
      const run = (index: number) => pooled.transaction(async (tx: Tx) => {
        open += 1; mostOpen = Math.max(mostOpen, open);
        try {
          const pid = await backendPid(tx);
          pids.add(pid);
          await publication(tx, `concurrent-${index}`);
          await tx.execute(sql`select pg_sleep(0.02)`);
          // Uncommitted rows of the other open transactions are invisible here.
          expect((await publicationIds(tx)).filter(id => id !== `concurrent-${index}` && Number(id.split("-")[1]) % 2 === 1)).toEqual([]);
          expect(await tx.transaction(async (nested: Tx) => backendPid(nested))).toBe(pid);
          expect(await backendPid(tx)).toBe(pid);
          if (index % 2 === 1) throw new Error(`abort ${index}`);
          return index;
        } finally { open -= 1; }
      });
      const settled = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => run(index)));
      expect(settled.map(result => result.status === "fulfilled" ? result.value : (result.reason as Error).message))
        .toEqual(Array.from({ length: 12 }, (_, index) => index % 2 === 1 ? `abort ${index}` : index));
      expect(mostOpen).toBeGreaterThan(1);
      expect(mostOpen).toBeLessThanOrEqual(3);
      expect(pids.size).toBeLessThanOrEqual(3);
      expect(await publicationIds(pooled)).toEqual([0, 10, 2, 4, 6, 8].map(index => `concurrent-${index}`));
      await pooled.$client.end({ timeout: 1 });
    });

    it("returns the only connection to the pool after a commit, a rollback and a failed savepoint", async () => {
      const single = createDb(database.connectionString, { maxConnections: 1 });
      const pid = await backendPid(single);
      await single.transaction(async (tx: Tx) => { await publication(tx, "single"); });
      await expect(single.transaction(async (tx: Tx) => {
        await expect(tx.transaction(async () => { throw new Error("savepoint"); })).rejects.toThrow("savepoint");
        throw new Error("outer");
      })).rejects.toThrow("outer");
      expect(await single.transaction(async (tx: Tx) => backendPid(tx))).toBe(pid);
      expect(await publicationIds(single)).toEqual(["single"]);
      await single.$client.end({ timeout: 1 });
    });

    it("behaves the same with prepared statements enabled", async () => {
      const prepared = createDb(database.connectionString, { prepare: true, maxConnections: 2 });
      await prepared.transaction(async (tx: Tx) => {
        await publication(tx, "prepared");
        await expect(tx.transaction(async (nested: Tx) => {
          await publication(nested, "prepared-undone");
          expect(await nested.query.announcementPublications.findFirst({
            where: eq(announcementPublications.announcementId, "prepared-undone"),
          })).toEqual({ announcementId: "prepared-undone" });
          throw new Error("undo");
        })).rejects.toThrow("undo");
        expect(builtQueryBuilders(tx)).toBe(0);
      });
      expect(await prepared.query.announcementPublications.findMany()).toEqual([{ announcementId: "prepared" }]);
      await prepared.$client.end({ timeout: 1 });
    });
  });
});
