import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("environment_leases reaper partial index migration", () => {
  it("applies the migration and the sweep queries use the new partial indexes", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap6499-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'environment_leases'`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("environment_leases_active_updated_at_idx");
    expect(names).toContain("environment_leases_pending_cleanup_updated_at_idx");

    // The reaper sweeps page an empty result set on a fresh table just as
    // easily as a populated one, so `enable_seqscan = off` forces the planner
    // to reveal which index it would pick, instead of a trivial seq scan on
    // zero rows.
    await sql.unsafe("SET enable_seqscan = off");

    // Mirrors `sweepOrphanedActiveLeases` in server/src/services/heartbeat.ts:
    // filter on status = 'active', order by updated_at ascending, page the
    // oldest rows first.
    const activePlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM environment_leases WHERE status = 'active' ORDER BY updated_at ASC LIMIT 20",
    );
    const activePlanText = activePlan.map((r) => Object.values(r)[0]).join("\n");
    expect(activePlanText).toContain("environment_leases_active_updated_at_idx");

    // Mirrors `sweepPendingCleanupLeases`: filter on status = 'pending_cleanup',
    // order by updated_at ascending, page the oldest rows first.
    const pendingCleanupPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM environment_leases WHERE status = 'pending_cleanup' ORDER BY updated_at ASC LIMIT 20",
    );
    const pendingCleanupPlanText = pendingCleanupPlan.map((r) => Object.values(r)[0]).join("\n");
    expect(pendingCleanupPlanText).toContain("environment_leases_pending_cleanup_updated_at_idx");

    // A third status must not match either partial index, because each index
    // covers only its own status predicate.
    const retainedPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM environment_leases WHERE status = 'retained' ORDER BY updated_at ASC LIMIT 20",
    );
    const retainedPlanText = retainedPlan.map((r) => Object.values(r)[0]).join("\n");
    expect(retainedPlanText).not.toContain("environment_leases_active_updated_at_idx");
    expect(retainedPlanText).not.toContain("environment_leases_pending_cleanup_updated_at_idx");
  }, 90_000);
});
