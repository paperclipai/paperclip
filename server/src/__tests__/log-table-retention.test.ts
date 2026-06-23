import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  runLogTableRetentionSweep,
  sweepLogTable,
} from "../services/log-table-retention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping log-table retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function firstRow<T>(result: unknown): T | undefined {
  const rows = (result as { rows?: T[] })?.rows
    ?? (Array.isArray(result) ? (result as T[]) : undefined);
  return rows?.[0];
}

describeEmbeddedPostgres("log-table retention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("log-table-retention-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Retention Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Retention Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: false, intervalSec: 60, wakeOnDemand: false },
      },
      permissions: {},
    });
  }, 30_000);

  beforeEach(async () => {
    await db.delete(activityLog);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertActivity(createdAt: Date): Promise<void> {
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "test",
      action: "test.event",
      entityType: "test",
      entityId: randomUUID(),
      agentId,
      createdAt,
    });
  }

  it("batched DELETE prunes rows older than the retention window on non-partitioned tables", async () => {
    const now = Date.now();
    await insertActivity(new Date(now - 60 * 24 * 60 * 60 * 1000));
    await insertActivity(new Date(now - 31 * 24 * 60 * 60 * 1000));
    await insertActivity(new Date(now - 5 * 24 * 60 * 60 * 1000));

    const result = await sweepLogTable(db, { table: "activity_log", days: 30 });

    expect(result.partitioned).toBe(false);
    expect(result.rowsDeleted).toBe(2);
    expect(result.partitionsDropped).toBe(0);

    const remaining = await db.select().from(activityLog);
    expect(remaining).toHaveLength(1);
  });

  it("runLogTableRetentionSweep skips entries with non-positive day counts", async () => {
    const now = Date.now();
    await insertActivity(new Date(now - 60 * 24 * 60 * 60 * 1000));

    const results = await runLogTableRetentionSweep(db, [
      { table: "activity_log", days: 0 },
      { table: "activity_log", days: 30 },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].table).toBe("activity_log");
    expect(results[0].rowsDeleted).toBe(1);
  });

  it("partition helpers create monthly partitions and drop expired ones", async () => {
    await db.execute(
      sql`CREATE TABLE retention_demo (created_at timestamptz NOT NULL) PARTITION BY RANGE (created_at)`,
    );

    const isPart = await db.execute(
      sql`SELECT paperclip_is_table_partitioned('retention_demo') AS is_partitioned`,
    );
    expect(firstRow<{ is_partitioned: boolean }>(isPart)?.is_partitioned).toBe(true);

    await db.execute(
      sql`SELECT paperclip_ensure_log_partitions_window('retention_demo', 1, 1)`,
    );

    const partitions = await db.execute(sql`
      SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE p.relname = 'retention_demo'
    `);
    const partitionRows = (partitions as { rows?: Array<{ relname: string }> })?.rows
      ?? (Array.isArray(partitions) ? (partitions as Array<{ relname: string }>) : []);
    expect(partitionRows.length).toBeGreaterThanOrEqual(3);

    const dropped = await db.execute(
      sql`SELECT paperclip_drop_old_log_partitions('retention_demo', now() + interval '10 years') AS dropped`,
    );
    expect(Number(firstRow<{ dropped: number }>(dropped)?.dropped)).toBeGreaterThanOrEqual(3);

    await db.execute(sql`DROP TABLE retention_demo`);
  });
});
