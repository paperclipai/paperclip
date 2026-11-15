import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEDICATED_CONNECTION_IDLE_MAX,
  DEFAULT_DEDICATED_CONNECTION_MAX,
  PRIVATE_POOL_MAX_CONNECTIONS,
  checkpointDb,
  closeCheckpointDb,
  closeDedicatedDbConnections,
  closeFileStorageDb,
  closeLivenessDb,
  controllerInstanceLeaseDb,
  controllerLeaseDb,
  createDb,
  databaseConnectionBudget,
  dedicatedDbConnectionStats,
  fileStorageDb,
  livenessDb,
  withDedicatedDbConnection,
  type DatabaseClientOptions,
  type Db,
} from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const APPLICATION_NAME = "paperclip-workspace-finalization-lock";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! : 0;
}

describe.skipIf(!support.supported)("withDedicatedDbConnection admission", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let observer: Db;
  const owners: Db[] = [];

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("dedicated-admission-");
    observer = createDb(temporary.connectionString, { maxConnections: 1, applicationName: "dedicated-admission-observer" });
    await observer.execute(sql`create table admission_rows (id int primary key)`);
    await observer.execute(sql`insert into admission_rows values (1)`);
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

  function owner(options: DatabaseClientOptions = {}) {
    const db = createDb(temporary.connectionString, { maxConnections: 2, ...options });
    owners.push(db);
    return db;
  }

  async function openDedicatedSessions(): Promise<number> {
    const [row] = await observer.execute<{ open: number }>(sql`select count(*)::int as open from pg_stat_activity
      where application_name = ${APPLICATION_NAME} and datname = current_database()`);
    return Number(row?.open ?? 0);
  }

  async function restartBurst(db: Db, runs: number, holdMs: number) {
    const waits: number[] = [];
    let failures = 0;
    let peakSessions = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        peakSessions = Math.max(peakSessions, await openDedicatedSessions());
        await sleep(20);
      }
    })();
    const startedAt = performance.now();
    await Promise.all(Array.from({ length: runs }, (_, index) => {
      const requestedAt = performance.now();
      return withDedicatedDbConnection(db, source => source.transaction(async tx => {
        waits.push(performance.now() - requestedAt);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`burst-source:${index}`}, 0))`);
        await withDedicatedDbConnection(db, lifecycle => lifecycle.transaction(async nested => {
          await nested.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`burst-lifecycle:${index}`}, 0))`);
          await sleep(holdMs / 2);
        }));
        await sleep(holdMs / 2);
      })).catch(() => { failures++; });
    }));
    const elapsedMs = performance.now() - startedAt;
    sampling = false;
    await sampler;
    return { runs, failures, peakSessions, peakInUse: dedicatedDbConnectionStats(db)!.peakInUse,
      waitP50Ms: Math.round(percentile(waits, 0.5)), waitP99Ms: Math.round(percentile(waits, 0.99)), elapsedMs: Math.round(elapsedMs) };
  }

  it("never queues a caller while fewer than the limit are in use", async () => {
    const db = owner();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waits: number[] = [];
    const holders = Array.from({ length: 20 }, () => {
      const requestedAt = performance.now();
      return withDedicatedDbConnection(db, async dedicated => {
        waits.push(performance.now() - requestedAt);
        await dedicated.execute(sql`select 1`);
        await gate;
      });
    });
    await expect.poll(() => waits.length).toBe(20);
    release();
    await Promise.all(holders);
    expect(dedicatedDbConnectionStats(db)).toMatchObject({ limit: DEFAULT_DEDICATED_CONNECTION_MAX, queued: 0, overLimit: 0, inUse: 0, peakInUse: 20 });
  });

  it.each([200, 1_000])("bounds the sessions of a %i-run restart burst whose source lock nests a lifecycle lock", async runs => {
    const limit = DEFAULT_DEDICATED_CONNECTION_MAX;
    const db = owner();
    const result = await restartBurst(db, runs, 40);
    console.info(JSON.stringify({ metric: "dedicated_connection_restart_burst", limit, ...result }));
    expect(result.failures).toBe(0);
    expect(result.peakInUse).toBeLessThanOrEqual(2 * limit);
    expect(result.peakSessions).toBeLessThanOrEqual(2 * limit + DEDICATED_CONNECTION_IDLE_MAX);
    expect(dedicatedDbConnectionStats(db)).toMatchObject({ inUse: 0, waiting: 0, overLimit: 0 });
  }, 120_000);

  it("admits queued callers in arrival order as slots free one at a time", async () => {
    const db = owner({ dedicatedConnectionMax: 1 });
    const releases: Array<() => void> = [];
    const admitted: string[] = [];
    const hold = (label: string) => withDedicatedDbConnection(db, async dedicated => {
      admitted.push(label);
      await dedicated.execute(sql`select 1`);
      await new Promise<void>(resolve => { releases.push(resolve); });
    });
    const first = hold("first");
    await expect.poll(() => releases.length).toBe(1);
    const queued = ["a", "b", "c", "d"].map(label => hold(label));
    await expect.poll(() => dedicatedDbConnectionStats(db)!.waiting).toBe(4);
    for (let expected = 2; expected <= 5; expected++) {
      releases.shift()!();
      await expect.poll(() => releases.length).toBe(1);
      expect(admitted).toHaveLength(expected);
      expect(dedicatedDbConnectionStats(db)!.inUse).toBe(1);
    }
    releases.shift()!();
    await Promise.all([first, ...queued]);
    expect(admitted).toEqual(["first", "a", "b", "c", "d"]);
    expect(dedicatedDbConnectionStats(db)).toMatchObject({ inUse: 0, waiting: 0, queued: 4, overLimit: 0 });
  });

  it("lets every holder take its nested connection while the limit is full and others queue", async () => {
    const db = owner({ dedicatedConnectionMax: 2 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let holding = 0;
    const holders = Array.from({ length: 2 }, (_, index) => withDedicatedDbConnection(db, outer => outer.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(${1000 + index})`);
      holding++;
      await gate;
      return withDedicatedDbConnection(db, inner => inner.transaction(async nested => {
        await nested.execute(sql`select pg_advisory_xact_lock(${2000 + index})`);
        return index;
      }));
    })));
    await expect.poll(() => holding).toBe(2);
    const queued = withDedicatedDbConnection(db, dedicated => dedicated.execute(sql`select 1`));
    await expect.poll(() => dedicatedDbConnectionStats(db)!.waiting).toBe(1);
    release();
    await expect(Promise.race([Promise.all(holders), sleep(5_000).then(() => "deadlocked")])).resolves.toEqual([0, 1]);
    await queued;
    expect(dedicatedDbConnectionStats(db)).toMatchObject({ inUse: 0, waiting: 0, queued: 1, overLimit: 0, nestedOverLimit: 2 });
  });

  it("admits a caller inside an open transaction without waiting, so a holder blocked on its row lock finishes", async () => {
    const db = owner({ dedicatedConnectionMax: 1 });
    let rowLocked!: () => void;
    const locked = new Promise<void>(resolve => { rowLocked = resolve; });
    let holderStarted!: () => void;
    const started = new Promise<void>(resolve => { holderStarted = resolve; });
    const writer = db.transaction(async tx => {
      await tx.execute(sql`select id from admission_rows where id = 1 for update`);
      rowLocked();
      await started;
      await sleep(50);
      return withDedicatedDbConnection(db, dedicated => dedicated.execute(sql`select 'writer' as owner`));
    });
    await locked;
    const holder = withDedicatedDbConnection(db, dedicated => dedicated.transaction(async tx => {
      holderStarted();
      await tx.execute(sql`select id from admission_rows where id = 1 for update`);
      return "holder";
    }));
    await expect(Promise.race([Promise.all([writer, holder]), sleep(10_000).then(() => "deadlocked")]))
      .resolves.toEqual([[{ owner: "writer" }], "holder"]);
    expect(dedicatedDbConnectionStats(db)).toMatchObject({ inUse: 0, overLimit: 0, nestedOverLimit: 1 });
  });

  it("admits a caller that holds a resource the slot holder needs without waiting", async () => {
    const db = owner({ dedicatedConnectionMax: 1, dedicatedConnectionWaitMs: 60_000 });
    let releasePermit!: () => void;
    const permit = new Promise<void>(resolve => { releasePermit = resolve; });
    let holding!: () => void;
    const slotTaken = new Promise<void>(resolve => { holding = resolve; });
    const holder = withDedicatedDbConnection(db, async dedicated => {
      holding();
      await permit;
      return dedicated.execute(sql`select 'holder' as owner`);
    });
    await slotTaken;
    const reader = (async () => {
      try {
        return await withDedicatedDbConnection(db, dedicated => dedicated.execute(sql`select 'reader' as owner`), { admitWithoutWaiting: true });
      } finally { releasePermit(); }
    })();
    await expect(Promise.race([Promise.all([reader, holder]), sleep(5_000).then(() => "deadlocked")]))
      .resolves.toEqual([[{ owner: "reader" }], [{ owner: "holder" }]]);
    expect(dedicatedDbConnectionStats(db)).toMatchObject({ inUse: 0, waiting: 0, overLimit: 0 });
  });

  it("admits a queued caller over the limit after the wait bound instead of waiting forever", async () => {
    const db = owner({ dedicatedConnectionMax: 1, dedicatedConnectionWaitMs: 100 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = withDedicatedDbConnection(db, async () => { await gate; });
    const requestedAt = performance.now();
    await withDedicatedDbConnection(db, dedicated => dedicated.execute(sql`select 1`));
    const waitedMs = performance.now() - requestedAt;
    release();
    await holder;
    expect(waitedMs).toBeGreaterThanOrEqual(90);
    expect(dedicatedDbConnectionStats(db)).toMatchObject({ inUse: 0, waiting: 0, queued: 1, overLimit: 1 });
  });

  it("states a connection budget equal to the sum of every pool's maximum", async () => {
    const db = owner({ maxConnections: 7, dedicatedConnectionMax: 5 });
    const pools = [livenessDb(db), controllerLeaseDb(db), controllerInstanceLeaseDb(db), checkpointDb(db), fileStorageDb(db)];
    const poolMax = (client: Db) => Number((client.$client as unknown as { options: { max: number } }).options.max);
    try {
      const budget = databaseConnectionBudget({ maxConnections: 7, dedicatedConnectionMax: 5 });
      expect(budget.main).toBe(poolMax(db));
      expect(budget.privatePools).toBe(pools.reduce((sum, client) => sum + poolMax(client), 0));
      expect(budget.privatePools).toBe(Object.values(PRIVATE_POOL_MAX_CONNECTIONS).reduce((sum, value) => sum + value, 0));
      expect(budget.dedicated).toBe(2 * 5 + DEDICATED_CONNECTION_IDLE_MAX);
      expect(budget.total).toBe(7 + budget.privatePools + budget.listeners + budget.dedicated);
      expect(databaseConnectionBudget()).toEqual({ main: 10, privatePools: 9, listeners: 2,
        dedicatedLimit: DEFAULT_DEDICATED_CONNECTION_MAX, dedicated: 2 * DEFAULT_DEDICATED_CONNECTION_MAX + DEDICATED_CONNECTION_IDLE_MAX,
        total: 10 + 9 + 2 + 2 * DEFAULT_DEDICATED_CONNECTION_MAX + DEDICATED_CONNECTION_IDLE_MAX });
    } finally {
      await closeLivenessDb(db, 1);
      await closeCheckpointDb(db, 1);
      await closeFileStorageDb(db, 1);
    }
  });
});
