import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkpointDb, closeCheckpointDb, closeDedicatedDbConnections, createDb, withDedicatedDbConnection, type Db } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

async function sessionsOpened(observer: Db) {
  const [row] = await observer.execute<{ sessions: string }>(sql`select sessions::text as sessions from pg_stat_database where datname = current_database()`);
  return Number(row!.sessions);
}

async function runConcurrently(total: number, concurrency: number, work: () => Promise<unknown>) {
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < total) { next++; await work(); }
  }));
}

describe.skipIf(!support.supported)("connections opened per 1,000 operations", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let observer: Db;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("connection-reuse-");
    observer = createDb(temporary.connectionString, { maxConnections: 1, applicationName: "connection-reuse-observer" });
    await sessionsOpened(observer);
  }, 90_000);
  afterAll(async () => {
    await observer?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  async function measure(open: (db: Db) => Promise<void>) {
    const db = createDb(temporary.connectionString, { maxConnections: 10 });
    await db.execute(sql`select 1`);
    const before = await sessionsOpened(observer);
    try {
      await open(db);
      return await sessionsOpened(observer) - before;
    } finally {
      await closeCheckpointDb(db, 1);
      await closeDedicatedDbConnections(db, 1);
      await db.$client.end({ timeout: 1 });
    }
  }

  it.each([1, 7, 24])("checkpoint saves at concurrency %i reuse the checkpoint pool", async concurrency => {
    const opened = await measure(db => runConcurrently(1_000, concurrency, () =>
      checkpointDb(db).transaction(async tx => { await tx.execute(sql`select 1`); })));
    expect(opened).toBeLessThanOrEqual(3);
  });

  it.each([1, 4, 8, 16])("dedicated connection uses at concurrency %i", async concurrency => {
    const opened = await measure(db => runConcurrently(1_000, concurrency, () =>
      withDedicatedDbConnection(db, connection => connection.transaction(async tx => { await tx.execute(sql`select 1`); }))));
    expect(opened).toBeLessThanOrEqual(concurrency);
  });

  it.each([8, 16])("bursts of %i dedicated connection uses reuse the connections the last burst opened", async width => {
    const opened = await measure(async db => {
      for (let burst = 0; burst < 1_000 / width; burst++) {
        await Promise.all(Array.from({ length: width }, () =>
          withDedicatedDbConnection(db, connection => connection.transaction(async tx => { await tx.execute(sql`select 1`); }))));
      }
    });
    expect(opened).toBeLessThanOrEqual(width);
  });
});
