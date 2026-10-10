import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("P6-18 / MIG-01..04 native finalization migration", () => {
  it("repairs only later duplicates and preserves legacy event bytes and cursors", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-migration-");
    const migration = await readFile(
      new URL("../../../packages/db/src/migrations/0227_modern_pandemic.sql", import.meta.url),
      "utf8",
    );
    const migrationHash = createHash("sha256").update(migration).digest("hex");
    const sequenceMigration = await readFile(
      new URL("../../../packages/db/src/migrations/0235_heartbeat_run_event_sequence_uniqueness.sql", import.meta.url),
      "utf8",
    );
    const sequenceMigrationHash = createHash("sha256")
      .update(sequenceMigration)
      .digest("hex");
    const rawDb = createDb(temporary.connectionString);
    try {
      const companyId = "10000000-0000-4000-8000-000000000001";
      const agentId = "10000000-0000-4000-8000-000000000002";
      const runId = "10000000-0000-4000-8000-000000000003";
      // Reconstruct the actual pre-0227 shape rather than extracting selected
      // repair statements from the migration under test.
      await rawDb.execute(sql.raw(`
        DROP TABLE IF EXISTS status_decision_effects, status_decisions, work_assessments,
          native_run_finalizations, native_run_results, completion_contracts CASCADE;
        DROP TRIGGER IF EXISTS paperclip_issue_status_version_trigger ON issues;
        DROP FUNCTION IF EXISTS paperclip_bump_issue_status_version();
        DROP INDEX IF EXISTS heartbeat_run_events_run_seq_uq;
        CREATE INDEX IF NOT EXISTS heartbeat_run_events_run_seq_idx
          ON heartbeat_run_events (run_id, seq);
        DROP INDEX IF EXISTS heartbeat_run_events_run_source_event_uq;
        DROP INDEX IF EXISTS heartbeat_run_events_run_source_seq_uq;
        ALTER TABLE heartbeat_run_events
          DROP COLUMN IF EXISTS source_instance_id,
          DROP COLUMN IF EXISTS source_event_id,
          DROP COLUMN IF EXISTS source_seq,
          DROP COLUMN IF EXISTS source_payload_sha256,
          DROP COLUMN IF EXISTS protocol_schema_version;
        ALTER TABLE heartbeat_run_events ALTER COLUMN seq TYPE integer;
        ALTER TABLE heartbeat_runs
          DROP COLUMN IF EXISTS runtime_mode,
          DROP COLUMN IF EXISTS runtime_mode_resolver_version,
          DROP COLUMN IF EXISTS runtime_mode_reason,
          DROP COLUMN IF EXISTS runtime_mode_resolved_at,
          DROP COLUMN IF EXISTS runner_profile_json,
          DROP COLUMN IF EXISTS runner_instance_id,
          DROP COLUMN IF EXISTS native_session_id,
          DROP COLUMN IF EXISTS driver_kind,
          DROP COLUMN IF EXISTS driver_version,
          DROP COLUMN IF EXISTS completion_contract_id,
          DROP COLUMN IF EXISTS completion_contract_sha256,
          DROP COLUMN IF EXISTS next_event_seq,
          DROP COLUMN IF EXISTS native_phase,
          DROP COLUMN IF EXISTS native_phase_updated_at;
        ALTER TABLE issues
          DROP COLUMN IF EXISTS status_version,
          DROP COLUMN IF EXISTS last_status_decision_id;
      `));
      await rawDb.execute(sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash}`);
      await rawDb.execute(sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${sequenceMigrationHash}`);
      await rawDb.execute(sql`
        INSERT INTO companies (id, name, issue_prefix)
        VALUES (${companyId}, 'Migration fixture', 'MIG')
      `);
      await rawDb.execute(sql`
        INSERT INTO agents (id, company_id, name)
        VALUES (${agentId}, ${companyId}, 'Migration agent')
      `);
      await rawDb.execute(sql`
        INSERT INTO heartbeat_runs (id, company_id, agent_id, status)
        VALUES (${runId}, ${companyId}, ${agentId}, 'succeeded')
      `);
      await rawDb.execute(sql`
        INSERT INTO heartbeat_run_events
          (company_id, run_id, agent_id, seq, event_type, stream, level, message, payload, created_at)
        VALUES
          (${companyId}, ${runId}, ${agentId}, 1, 'legacy.start', 'system', 'info', 'one', ${JSON.stringify({ bytes: "α-1" })}::jsonb, '2026-08-01T00:00:01.000Z'),
          (${companyId}, ${runId}, ${agentId}, 5, 'legacy.log', 'stdout', 'info', 'first-five', ${JSON.stringify({ bytes: "β-5a" })}::jsonb, '2026-08-01T00:00:02.000Z'),
          (${companyId}, ${runId}, ${agentId}, 5, 'legacy.log', 'stderr', 'warn', 'duplicate-five', ${JSON.stringify({ bytes: "γ-5b" })}::jsonb, '2026-08-01T00:00:03.000Z'),
          (${companyId}, ${runId}, ${agentId}, 9, 'legacy.end', 'system', 'info', 'nine', ${JSON.stringify({ bytes: "δ-9" })}::jsonb, '2026-08-01T00:00:04.000Z')
      `);
      const beforeResult = await rawDb.execute(sql`
        SELECT * FROM heartbeat_run_events WHERE run_id = ${runId} ORDER BY id
      `);
      const before = [...beforeResult] as unknown as Record<string, unknown>[];

      await applyPendingMigrations(temporary.connectionString);
      const db = createDb(temporary.connectionString);

      const after = await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId)).orderBy(heartbeatRunEvents.id);
      expect(after.map((row) => row.seq)).toEqual([1, 5, 10, 9]);
      expect((await db.select({ nextEventSeq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId)))[0]?.nextEventSeq).toBe(11);

      // The repaired duplicate's cursor is the only changed byte-equivalent read field.
      const legacyColumns = (row: Record<string, unknown>) => ({
        id: String(row.id),
        companyId: row.companyId ?? row.company_id,
        runId: row.runId ?? row.run_id,
        agentId: row.agentId ?? row.agent_id,
        eventType: row.eventType ?? row.event_type,
        stream: row.stream,
        level: row.level,
        message: row.message,
        payload: row.payload,
        createdAt: new Date(String(row.createdAt ?? row.created_at)).toISOString(),
      });
      expect(after.map((row) => legacyColumns(row))).toEqual(before.map(legacyColumns));
      expect(after[0]?.seq).toBe(Number(before[0]?.seq));
      expect(after[1]?.seq).toBe(Number(before[1]?.seq));
      expect(after[3]?.seq).toBe(Number(before[3]?.seq));
      await expect(db.insert(heartbeatRunEvents).values({
        companyId, runId, agentId, seq: 5, eventType: "must-conflict",
      })).rejects.toThrow();
    } finally {
      await temporary.cleanup();
    }
  }, 60_000);
});
