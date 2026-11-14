import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

// A test that tears down a shared database awaits drainActiveRunExecutions()
// first. A native resume dispatch whose timer already fired is still reading
// and writing run state; the drain must wait for it, or the teardown's
// TRUNCATE deadlocks against it.
suite("draining run executions", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-drain-native-resume-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  it("waits for a native resume dispatch whose timer has already fired", async () => {
    const heartbeat = heartbeatService(db);
    let release!: () => void, locked!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<number>(resolve => { locked = resolve; });
    // Hold the tables the dispatch reads, so its work stays observably in flight.
    const holding = db.transaction(async tx => {
      await tx.execute(sql`lock table instance_settings, heartbeat_runs in access exclusive mode`);
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      locked(row.pid); await gate;
    });
    const pid = await acquired;
    try {
      heartbeat.scheduleNativeSessionResumeDispatch(randomUUID(), new Date(), "restart");
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`);
        expect(row.count).toBeGreaterThan(0);
      }, { timeout: 10_000 });

      let drained = false;
      const draining = heartbeat.drainActiveRunExecutions().then(() => { drained = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(drained).toBe(false);

      release(); await holding;
      await draining;
      expect(drained).toBe(true);
    } finally { release(); await holding; }
  }, 30_000);
});
