import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { readNativeRunWakeRequestedAtMs } from "./native-run-wake-anchor.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("native run wake anchor against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let locker!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const wakeupRequestId = randomUUID();
  const runId = randomUUID();
  const requestedAt = new Date("2026-11-07T10:00:00.000Z");

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-wake-anchor-");
    // One connection: a read left running after the timeout would starve the next query.
    db = createDb(database.connectionString, { maxConnections: 1 });
    locker = createDb(database.connectionString, { maxConnections: 2 });
    await db.insert(companies).values({ id: companyId, name: "Anchor", issuePrefix: `A${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Anchor agent", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "assignment", status: "claimed", requestedAt });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, wakeupRequestId, status: "running" });
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("reads requested_at through the run's wake request", async () => {
    await expect(readNativeRunWakeRequestedAtMs(db, runId)).resolves.toBe(requestedAt.getTime());
    await expect(readNativeRunWakeRequestedAtMs(db, randomUUID())).resolves.toBeNull();
  });

  it("cancels a blocked read on the server and returns its connection to the pool", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const holder = locker.transaction(async (tx) => {
      await tx.execute(sql`lock table agent_wakeup_requests in access exclusive mode`);
      locked();
      await gate;
    });
    try {
      await lockHeld;
      const startedAt = Date.now();
      await expect(readNativeRunWakeRequestedAtMs(db, runId, 300)).resolves.toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      // The lock is still held. The single pooled connection must already be free,
      // and PostgreSQL must not still be waiting on the anchor read.
      const probeStartedAt = Date.now();
      const [probe] = await db.execute<{ ok: number }>(sql`select 1 as ok`);
      expect(Number(probe?.ok)).toBe(1);
      expect(Date.now() - probeStartedAt).toBeLessThan(1_000);
      const waiting = await locker.execute<{ count: string }>(sql`
        select count(*)::text as count from pg_stat_activity
        where state = 'active' and wait_event_type = 'Lock' and query ilike '%agent_wakeup_requests%'`);
      expect(Number(waiting[0]?.count ?? 0)).toBe(0);
    } finally {
      release();
      await holder;
    }
  }, 20_000);
});
