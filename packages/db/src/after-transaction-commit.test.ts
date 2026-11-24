import { afterAll, describe, expect, it } from "vitest";
import { afterTransactionCommit, createDb, type Db } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("afterTransactionCommit", () => {
  let db: Db;
  let cleanup: (() => Promise<void>) | undefined;

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await cleanup?.();
  });

  async function database() {
    if (db) return db;
    const started = await startEmbeddedPostgresTestDatabase("paperclip-db-after-commit-");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
    return db;
  }

  it("runs a callback only after the enclosing transaction commits", async () => {
    const client = await database();
    const order: string[] = [];
    await client.transaction(async (tx) => {
      afterTransactionCommit(() => order.push("callback"));
      await tx.execute("select 1");
      order.push("transaction body");
    });
    order.push("returned");
    expect(order).toEqual(["transaction body", "callback", "returned"]);
  }, 30_000);

  it("drops the callback when the transaction rolls back", async () => {
    const client = await database();
    const calls: string[] = [];
    await expect(client.transaction(async () => {
      afterTransactionCommit(() => calls.push("callback"));
      throw new Error("rolled back");
    })).rejects.toThrow("rolled back");
    expect(calls).toEqual([]);
  }, 30_000);

  it("registers callbacks from a savepoint on the outer transaction", async () => {
    const client = await database();
    const order: string[] = [];
    await client.transaction(async (tx) => {
      await tx.transaction(async () => {
        afterTransactionCommit(() => order.push("savepoint callback"));
      });
      order.push("outer body");
    });
    expect(order).toEqual(["outer body", "savepoint callback"]);
  }, 30_000);

  it("drops callbacks from a savepoint that rolls back while the outer transaction commits", async () => {
    const client = await database();
    const order: string[] = [];
    await client.transaction(async (tx) => {
      await tx.transaction(async () => {
        afterTransactionCommit(() => order.push("rolled back savepoint"));
        throw new Error("savepoint failed");
      }).catch(() => order.push("savepoint caught"));
      await tx.transaction(async (inner) => {
        await inner.transaction(async () => {
          afterTransactionCommit(() => order.push("nested savepoint"));
        });
      });
      afterTransactionCommit(() => order.push("outer"));
    });
    expect(order).toEqual(["savepoint caught", "nested savepoint", "outer"]);
  }, 30_000);

  it("drops callbacks from a committed savepoint when the outer transaction rolls back", async () => {
    const client = await database();
    const calls: string[] = [];
    await expect(client.transaction(async (tx) => {
      await tx.transaction(async () => {
        afterTransactionCommit(() => calls.push("savepoint"));
      });
      throw new Error("outer rolled back");
    })).rejects.toThrow("outer rolled back");
    expect(calls).toEqual([]);
  }, 30_000);

  it("runs at once outside a transaction and isolates a throwing callback", async () => {
    await database();
    const calls: string[] = [];
    afterTransactionCommit(() => { throw new Error("observer failed"); });
    afterTransactionCommit(() => calls.push("outside"));
    expect(calls).toEqual(["outside"]);
  }, 30_000);
});
