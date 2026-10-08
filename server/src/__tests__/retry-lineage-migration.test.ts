import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, applyPendingMigrations, companies, createDb, heartbeatRuns, inspectMigrations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

it("upgrades predecessor retry lineage in bounded batches and replays the journal without changing valid ancestors", async () => {
  // The helper bootstraps the complete migration chain into a private cluster.
  const temporary = await startEmbeddedPostgresTestDatabase("retry-lineage-upgrade-");
  const db = createDb(temporary.connectionString);
  try {
    expect((await inspectMigrations(temporary.connectionString)).status).toBe("upToDate");
    const journal = JSON.parse(await readFile(new URL("../../../packages/db/src/migrations/meta/_journal.json", import.meta.url), "utf8"));
    const migration = journal.entries.at(-1);
    expect(migration.tag).toBe("0318_oval_blade");
    // Reconstruct the exact predecessor schema/journal for this additive check.
    await db.execute(sql`alter table heartbeat_runs drop constraint heartbeat_runs_retry_of_run_id_not_self_check`);
    await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = ${migration.when}`);
    expect((await inspectMigrations(temporary.connectionString)).pendingMigrations).toEqual([`${migration.tag}.sql`]);
    const companyId = randomUUID(), agentId = randomUUID(), ancestorId = randomUUID(), childId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Upgrade fixture", issuePrefix: "UPG" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: ancestorId, companyId, agentId, status: "succeeded", continuationAttempt: 2 });
    await db.insert(heartbeatRuns).values({ id: childId, companyId, agentId, status: "failed", retryOfRunId: ancestorId });
    const malformed = Array.from({ length: 1003 }, () => randomUUID());
    await db.insert(heartbeatRuns).values(malformed.map(id => ({ id, companyId, agentId, status: "failed", retryOfRunId: id })));
    const before = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ancestorId));
    await applyPendingMigrations(temporary.connectionString);
    expect((await inspectMigrations(temporary.connectionString)).status).toBe("upToDate");
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(rows.filter(row => malformed.includes(row.id)).every(row => row.retryOfRunId === null)).toBe(true);
    expect(rows.find(row => row.id === childId)?.retryOfRunId).toBe(ancestorId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ancestorId))).toEqual(before);
    await expect(db.update(heartbeatRuns).set({ retryOfRunId: childId }).where(eq(heartbeatRuns.id, childId))).rejects.toMatchObject({ cause: { code: "23514", constraint_name: "heartbeat_runs_retry_of_run_id_not_self_check" } });
    // Re-open the service/client and replay the production migration entrypoint.
    await db.$client.end({ timeout: 0 });
    await applyPendingMigrations(temporary.connectionString);
    const restarted = createDb(temporary.connectionString);
    expect(await restarted.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toEqual(expect.arrayContaining(rows));
    expect((await inspectMigrations(temporary.connectionString)).status).toBe("upToDate");
  } finally { await temporary.cleanup(); }
}, 30_000);
