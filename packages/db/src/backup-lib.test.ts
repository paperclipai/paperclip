import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  createBufferedTextFileWriter,
  pruneOldBackups,
  runDatabaseBackup,
  runDatabaseRestore,
  sweepBackupOrphans,
} from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function createSiblingDatabase(connectionString: string, databaseName: string): Promise<string> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("createBufferedTextFileWriter", () => {
  it("preserves line boundaries across buffered flushes", async () => {
    const tempDir = createTempDir("paperclip-buffered-writer-");
    const outputPath = path.join(tempDir, "backup.sql");
    const writer = createBufferedTextFileWriter(outputPath, 16);
    const lines = [
      "-- header",
      "BEGIN;",
      "",
      "INSERT INTO test VALUES (1);",
      "-- footer",
    ];

    for (const line of lines) {
      writer.emit(line);
    }

    await writer.close();

    expect(fs.readFileSync(outputPath, "utf8")).toBe(lines.join("\n"));
  });
});

describe("sweepBackupOrphans", () => {
  it("removes stale working .sql files and header-only .sql.gz files, sparing healthy and fresh files", () => {
    const backupDir = createTempDir("paperclip-backup-orphan-sweep-");
    const nowMs = Date.UTC(2026, 6, 31, 22, 0, 0);
    const staleTime = new Date(nowMs - 3 * 60 * 60 * 1000);
    const freshTime = new Date(nowMs - 5 * 60 * 1000);

    const orphanSql = path.join(backupDir, "paperclip-20260731-152400.sql");
    const orphanGz = path.join(backupDir, "paperclip-20260731-152400.sql.gz");
    const healthyGz = path.join(backupDir, "paperclip-20260731-092400.sql.gz");
    const liveSql = path.join(backupDir, "paperclip-20260731-215500.sql");
    const freshTinyGz = path.join(backupDir, "paperclip-20260731-215500.sql.gz");
    const foreignSql = path.join(backupDir, "other-20260731-152400.sql");

    fs.writeFileSync(orphanSql, "x".repeat(4096));
    fs.writeFileSync(orphanGz, "x".repeat(20));
    fs.writeFileSync(healthyGz, "x".repeat(4096));
    fs.writeFileSync(liveSql, "x".repeat(64));
    fs.writeFileSync(freshTinyGz, "x".repeat(20));
    fs.writeFileSync(foreignSql, "x".repeat(16));
    for (const file of [orphanSql, orphanGz, healthyGz, foreignSql]) {
      fs.utimesSync(file, staleTime, staleTime);
    }
    for (const file of [liveSql, freshTinyGz]) {
      fs.utimesSync(file, freshTime, freshTime);
    }

    const swept = sweepBackupOrphans(backupDir, "paperclip", { nowMs });

    expect([...swept].sort()).toEqual([orphanGz, orphanSql].sort());
    expect(fs.existsSync(orphanSql)).toBe(false);
    expect(fs.existsSync(orphanGz)).toBe(false);
    expect(fs.existsSync(healthyGz)).toBe(true);
    // Files younger than the age guard may belong to a live run.
    expect(fs.existsSync(liveSql)).toBe(true);
    expect(fs.existsSync(freshTinyGz)).toBe(true);
    // Files outside the configured prefix are not ours to remove.
    expect(fs.existsSync(foreignSql)).toBe(true);
  });

  it("returns an empty list for a missing directory", () => {
    const missingDir = path.join(os.tmpdir(), "paperclip-missing-sweep-dir");
    expect(sweepBackupOrphans(missingDir, "paperclip")).toEqual([]);
  });

  it("never sweeps files whose pid marker names a live process, even past the age guard", () => {
    const backupDir = createTempDir("paperclip-backup-sweep-live-pid-");
    const nowMs = Date.UTC(2026, 6, 31, 22, 0, 0);
    const staleTime = new Date(nowMs - 3 * 60 * 60 * 1000);

    // A stalled-but-alive run in another process: working .sql plus a tiny
    // in-progress .sql.gz, both idle past the age guard, marker pid = us.
    const stalledSql = path.join(backupDir, "paperclip-20260731-152400.sql");
    const stalledGz = path.join(backupDir, "paperclip-20260731-152400.sql.gz");
    const marker = path.join(backupDir, "paperclip-20260731-152400.sql.pid");
    fs.writeFileSync(stalledSql, "x".repeat(4096));
    fs.writeFileSync(stalledGz, "x".repeat(20));
    fs.writeFileSync(marker, `${process.pid}\n`);
    for (const file of [stalledSql, stalledGz, marker]) {
      fs.utimesSync(file, staleTime, staleTime);
    }

    expect(sweepBackupOrphans(backupDir, "paperclip", { nowMs })).toEqual([]);
    expect(fs.existsSync(stalledSql)).toBe(true);
    expect(fs.existsSync(stalledGz)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("sweeps orphans and their marker once the owning process is gone", () => {
    const backupDir = createTempDir("paperclip-backup-sweep-dead-pid-");
    const nowMs = Date.UTC(2026, 6, 31, 22, 0, 0);
    const staleTime = new Date(nowMs - 3 * 60 * 60 * 1000);

    // A real-but-exited pid, so liveness is checked against the OS.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const orphanSql = path.join(backupDir, "paperclip-20260731-152400.sql");
    const orphanGz = path.join(backupDir, "paperclip-20260731-152400.sql.gz");
    const marker = path.join(backupDir, "paperclip-20260731-152400.sql.pid");
    const strayMarker = path.join(backupDir, "paperclip-20260730-092400.sql.pid");
    fs.writeFileSync(orphanSql, "x".repeat(4096));
    fs.writeFileSync(orphanGz, "x".repeat(20));
    fs.writeFileSync(marker, `${deadPid}\n`);
    fs.writeFileSync(strayMarker, "not-a-pid\n");
    for (const file of [orphanSql, orphanGz, marker, strayMarker]) {
      fs.utimesSync(file, staleTime, staleTime);
    }

    const swept = sweepBackupOrphans(backupDir, "paperclip", { nowMs });

    expect([...swept].sort()).toEqual([marker, orphanGz, orphanSql, strayMarker].sort());
    expect(fs.readdirSync(backupDir)).toEqual([]);
  });
});

describe("pruneOldBackups", () => {
  it("ignores bare .sql working files so an orphan cannot displace the last good weekly backup", () => {
    const backupDir = createTempDir("paperclip-backup-prune-orphan-");
    const realDateNow = Date.now;
    Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

    const goodGz = path.join(backupDir, "paperclip-test-20260317-120000.sql.gz");
    const orphanSql = path.join(backupDir, "paperclip-test-20260319-120000.sql");

    try {
      fs.writeFileSync(goodGz, "x".repeat(4096));
      fs.writeFileSync(orphanSql, "x".repeat(64));
      // Same ISO week (2026-W12), orphan newer than the good backup.
      fs.utimesSync(goodGz, new Date("2026-03-17T12:00:00Z"), new Date("2026-03-17T12:00:00Z"));
      fs.utimesSync(orphanSql, new Date("2026-03-19T12:00:00Z"), new Date("2026-03-19T12:00:00Z"));

      const pruned = pruneOldBackups(
        backupDir,
        { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        "paperclip-test",
      );

      expect(pruned).toBe(0);
      expect(fs.existsSync(goodGz)).toBe(true);
      expect(fs.existsSync(orphanSql)).toBe(true);
    } finally {
      Date.now = realDateNow;
    }
  });
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
  it(
    "sweeps crash-orphaned partial files before backing up",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-sweep-");

      const orphanSql = path.join(backupDir, "paperclip-test-20260729-152400.sql");
      const orphanGz = path.join(backupDir, "paperclip-test-20260729-152400.sql.gz");
      const healthyGz = path.join(backupDir, "paperclip-test-20260730-152400.sql.gz");
      fs.writeFileSync(orphanSql, "x".repeat(617));
      fs.writeFileSync(orphanGz, "x".repeat(20));
      fs.writeFileSync(healthyGz, "x".repeat(4096));
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      fs.utimesSync(orphanSql, threeDaysAgo, threeDaysAgo);
      fs.utimesSync(orphanGz, threeDaysAgo, threeDaysAgo);
      fs.utimesSync(healthyGz, twoDaysAgo, twoDaysAgo);

      const result = await runDatabaseBackup({
        connectionString: sourceConnectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        filenamePrefix: "paperclip-test",
      });

      expect([...result.sweptOrphans].sort()).toEqual([orphanGz, orphanSql].sort());
      expect(fs.existsSync(orphanSql)).toBe(false);
      expect(fs.existsSync(orphanGz)).toBe(false);
      expect(fs.existsSync(healthyGz)).toBe(true);
      expect(fs.existsSync(result.backupFile)).toBe(true);
      expect(result.prunedCount).toBe(0);
      // The run's own pid ownership marker must not outlive the run.
      expect(fs.readdirSync(backupDir).filter((name) => name.endsWith(".pid"))).toEqual([]);
    },
    30_000,
  );

  it(
    "keeps the newest backup for each retained calendar month",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-retention-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const janNewest = path.join(backupDir, "paperclip-test-2026-01-28T12-00-00.sql.gz");
      const janOlder = path.join(backupDir, "paperclip-test-2026-01-10T12-00-00.sql.gz");
      const decOld = path.join(backupDir, "paperclip-test-2025-12-15T12-00-00.sql.gz");

      try {
        // Plausible backup sizes so the crash-orphan sweep leaves the fixtures alone.
        fs.writeFileSync(janNewest, "jan-newest".padEnd(2048, "x"));
        fs.writeFileSync(janOlder, "jan-older".padEnd(2048, "x"));
        fs.writeFileSync(decOld, "dec-old".padEnd(2048, "x"));

        fs.utimesSync(janNewest, new Date("2026-01-28T12:00:00Z"), new Date("2026-01-28T12:00:00Z"));
        fs.utimesSync(janOlder, new Date("2026-01-10T12:00:00Z"), new Date("2026-01-10T12:00:00Z"));
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
          filenamePrefix: "paperclip-test",
        });

        expect(result.prunedCount).toBe(2);
        expect(fs.existsSync(janNewest)).toBe(true);
        expect(fs.existsSync(janOlder)).toBe(false);
        expect(fs.existsSync(decOld)).toBe(false);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "backs up and restores large table payloads without materializing one giant string",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-output-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."backup_test_state" AS ENUM ('pending', 'done');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_test_records" (
            "id" serial PRIMARY KEY,
            "title" text NOT NULL,
            "payload" text NOT NULL,
            "state" "public"."backup_test_state" NOT NULL,
            "metadata" jsonb,
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
        `);

        const payload = "x".repeat(8192);
        for (let index = 0; index < 160; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
          await sourceSql`
            INSERT INTO "public"."backup_test_records" (
              "title",
              "payload",
              "state",
              "metadata",
              "created_at"
            )
            VALUES (
              ${`row-${index}`},
              ${payload},
              ${index % 2 === 0 ? "pending" : "done"}::"public"."backup_test_state",
              ${JSON.stringify({ index, even: index % 2 === 0 })}::jsonb,
              ${createdAt}
            )
          `;
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-test",
          backupEngine: "javascript",
        });

        expect(result.backupFile).toMatch(/paperclip-test-.*\.sql\.gz$/);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(fs.existsSync(result.backupFile)).toBe(true);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const counts = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."backup_test_records"
        `);
        expect(counts[0]?.count).toBe(160);

        const sampleRows = await restoreSql.unsafe<{
          title: string;
          payload: string;
          state: string;
          metadata: { index: number; even: boolean } | string;
        }[]>(`
          SELECT "title", "payload", "state"::text AS "state", "metadata"
          FROM "public"."backup_test_records"
          WHERE "title" IN ('row-0', 'row-159')
          ORDER BY "title"
        `);
        expect(sampleRows.map((row) => ({
          ...row,
          metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
        }))).toEqual([
          {
            title: "row-0",
            payload,
            state: "pending",
            metadata: { index: 0, even: true },
          },
          {
            title: "row-159",
            payload,
            state: "done",
            metadata: { index: 159, even: false },
          },
        ]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "backs up and restores non-public database schemas and migration history",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_full_logical_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-full-logical-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS "drizzle";
          CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
            "id" serial PRIMARY KEY,
            "hash" text NOT NULL,
            "created_at" bigint
          );
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('paperclip-migration-history', 1770000000000);
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          INSERT INTO "public"."backup_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "note" text NOT NULL
          );
          CREATE TABLE "public"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          INSERT INTO "public"."plugin_rows" ("note")
          VALUES ('public-collision');
          INSERT INTO "public"."audit_rows" ("secret_note")
          VALUES ('public-secret');
        `);
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_backup_scope";
          CREATE TYPE "plugin_backup_scope"."plugin_status" AS ENUM ('ready', 'done');
          CREATE TABLE "plugin_backup_scope"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."backup_parent_records"("id") ON DELETE CASCADE,
            "status" "plugin_backup_scope"."plugin_status" NOT NULL,
            "note" text NOT NULL
          );
          CREATE TABLE "plugin_backup_scope"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          CREATE UNIQUE INDEX "plugin_rows_note_uq" ON "plugin_backup_scope"."plugin_rows" ("note");
          INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'ready', 'first');
          INSERT INTO "plugin_backup_scope"."audit_rows" ("secret_note")
          VALUES ('plugin-secret');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-full-logical-test",
          backupEngine: "javascript",
          excludeTables: ["plugin_rows"],
          nullifyColumns: {
            audit_rows: ["secret_note"],
          },
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const migrationRows = await restoreSql.unsafe<{ hash: string }[]>(`
          SELECT "hash"
          FROM "drizzle"."__drizzle_migrations"
          WHERE "hash" = 'paperclip-migration-history'
        `);
        expect(migrationRows).toEqual([{ hash: "paperclip-migration-history" }]);

        const pluginRows = await restoreSql.unsafe<{ note: string; status: string; parent_name: string }[]>(`
          SELECT r."note", r."status"::text AS "status", p."name" AS "parent_name"
          FROM "plugin_backup_scope"."plugin_rows" r
          JOIN "public"."backup_parent_records" p ON p."id" = r."parent_id"
        `);
        expect(pluginRows).toEqual([{ note: "first", status: "ready", parent_name: "parent" }]);

        const publicCollisionRows = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."plugin_rows"
        `);
        expect(publicCollisionRows[0]?.count).toBe(0);

        const publicAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "public"."audit_rows"
        `);
        expect(publicAuditRows).toEqual([{ secret_note: null }]);

        const pluginAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "plugin_backup_scope"."audit_rows"
        `);
        expect(pluginAuditRows).toEqual([{ secret_note: "plugin-secret" }]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'done', 'first')
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "preserves composite foreign key column order without duplicate referenced columns",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_composite_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-composite-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_composite_fk";
          CREATE TABLE "plugin_composite_fk"."content_cases" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "title" text NOT NULL,
            CONSTRAINT "content_cases_company_case_unique" UNIQUE ("company_id", "id")
          );
          CREATE TABLE "plugin_composite_fk"."content_case_signals" (
            "company_id" uuid NOT NULL,
            "case_id" uuid NOT NULL,
            "signal" text NOT NULL,
            "scopes" text[] NOT NULL,
            "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
            CONSTRAINT "content_case_signals_company_case"
              FOREIGN KEY ("company_id", "case_id")
              REFERENCES "plugin_composite_fk"."content_cases" ("company_id", "id")
              ON DELETE CASCADE
          );
          INSERT INTO "plugin_composite_fk"."content_cases" ("company_id", "id", "title")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'case'
          );
          INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes", "warnings")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'signal',
            ARRAY['upstream_import:preview', 'scope with space', 'quoted "scope"', 'NULL', 'null'],
            jsonb_build_array('json warning', jsonb_build_object('code', 'quoted "value"'))
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-composite-fk-test",
          backupEngine: "javascript",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{
          signal: string;
          title: string;
          scopes: string[];
          warnings: Array<string | { code: string }>;
        }[]>(`
          SELECT s."signal", c."title", s."scopes", s."warnings"
          FROM "plugin_composite_fk"."content_case_signals" s
          JOIN "plugin_composite_fk"."content_cases" c
            ON c."company_id" = s."company_id"
           AND c."id" = s."case_id"
        `);
        expect(rows).toEqual([
          {
            signal: "signal",
            title: "case",
            scopes: ["upstream_import:preview", "scope with space", 'quoted "scope"', "NULL", "null"],
            warnings: ["json warning", { code: 'quoted "value"' }],
          },
        ]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes")
            VALUES (
              '11111111-1111-4111-8111-111111111111',
              '33333333-3333-4333-8333-333333333333',
              'orphan',
              ARRAY[]::text[]
            )
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores fallback COPY data when child tables are dumped before parent tables",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_copy_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-copy-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."zzz_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          CREATE TABLE "public"."aaa_child_records" (
            "id" uuid PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."zzz_parent_records"("id") ON DELETE CASCADE,
            "note" text NOT NULL
          );
          INSERT INTO "public"."zzz_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
          INSERT INTO "public"."aaa_child_records" ("id", "parent_id", "note")
          VALUES (
            '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
            'child emitted before parent'
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-fk-test",
          backupEngine: "auto",
        });

        const backupSql = gunzipSync(await fs.promises.readFile(result.backupFile)).toString("utf8");
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeGreaterThan(-1);
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeLessThan(
          backupSql.indexOf("-- Data for: public.zzz_parent_records"),
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{ note: string; name: string }[]>(`
          SELECT child."note", parent."name"
          FROM "public"."aaa_child_records" child
          JOIN "public"."zzz_parent_records" parent ON parent."id" = child."parent_id"
        `);
        expect(rows).toEqual([{ note: "child emitted before parent", name: "parent" }]);
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores legacy public-only backups without migration history",
    async () => {
      const restoreConnectionString = await createTempDatabase();
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("paperclip-db-restore-manual-");
      const backupFile = path.join(backupDir, "manual.sql");

      try {
        await fs.promises.writeFile(
          backupFile,
          [
            "-- Paperclip database backup",
            "-- Created: 2026-04-06T00:00:00.000Z",
            "",
            "BEGIN;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "CREATE TABLE public.restore_stream_test (id integer primary key, payload text not null);",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "INSERT INTO public.restore_stream_test (id, payload)",
            "VALUES (1, 'hello');",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "COMMIT;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          ].join("\n"),
          "utf8",
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile,
        });

        const rows = await restoreSql.unsafe<{ payload: string }[]>(`
          SELECT payload
          FROM public.restore_stream_test
        `);
        expect(rows).toEqual([{ payload: "hello" }]);
      } finally {
        await restoreSql.end();
      }
    },
    20_000,
  );
});
