import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  DatabaseBackupTimeoutError,
  applyLocalBackupTimeouts,
  createBufferedTextFileWriter,
  pruneDatabaseBackups,
  runDatabaseBackup,
  runDatabaseRestore,
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

describe("runDatabaseBackup deadline", () => {
  /**
   * Accepts the connection and then answers nothing, ever. This is the shape
   * that broke production: not a backup that *died* — a killed backup already
   * recovers — but one that never settles, so every `finally` waiting on it,
   * including the caller's in-flight guard, waits forever too.
   */
  async function startBlackHolePostgres(): Promise<string> {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      // Read the startup packet and reply with nothing.
      socket.resume();
    });
    await new Promise<void>((resolveListening, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListening);
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("black-hole postgres did not bind a TCP port");
    }
    return `postgres://paperclip:paperclip@127.0.0.1:${address.port}/paperclip`;
  }

  /**
   * Same black hole, but it keeps what the client said first. The startup
   * packet is the only thing a transaction-mode pooler inspects before it
   * decides whether to accept the connection at all, so asserting on these
   * bytes is what actually proves the backup can reach a pooled database.
   */
  async function startStartupPacketRecorder(): Promise<{
    connectionString: string;
    startupPacket: Promise<string>;
  }> {
    const sockets: net.Socket[] = [];
    let resolvePacket: (packet: string) => void = () => {};
    const startupPacket = new Promise<string>((resolve) => {
      resolvePacket = resolve;
    });
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.once("data", (chunk: Buffer) => {
        resolvePacket(chunk.toString("latin1"));
      });
    });
    await new Promise<void>((resolveListening, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListening);
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("startup-packet recorder did not bind a TCP port");
    }
    return {
      connectionString: `postgres://paperclip:paperclip@127.0.0.1:${address.port}/paperclip`,
      startupPacket,
    };
  }

  it("keeps pooler-incompatible parameters out of the startup packet", async () => {
    const { connectionString, startupPacket } = await startStartupPacketRecorder();
    const backupDir = createTempDir("paperclip-db-backup-startup-packet-");

    await expect(
      runDatabaseBackup({
        connectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
        filenamePrefix: "paperclip-startup",
        connectTimeoutSeconds: 120,
        timeoutSeconds: 2,
        statementTimeoutSeconds: 30,
      }),
    ).rejects.toThrow(DatabaseBackupTimeoutError);

    const packet = await startupPacket;

    // pgbouncer and Supavisor track only a small set of startup parameters and
    // refuse the connection outright on any other — so naming the timeouts here
    // does not merely go unapplied, it stops the backup from connecting at all
    // on every deployment that points `DATABASE_URL` at a transaction pooler.
    // They belong in a `set_config` after connect instead.
    expect(packet).toContain("application_name");
    expect(packet).toContain("paperclip-backup");
    expect(packet).not.toContain("statement_timeout");
    expect(packet).not.toContain("idle_in_transaction_session_timeout");
  }, 60_000);

  it("rejects the caller when the backup never settles", async () => {
    const connectionString = await startBlackHolePostgres();
    const backupDir = createTempDir("paperclip-db-backup-deadline-");
    const startedAtMs = Date.now();

    // connect_timeout is deliberately far past the deadline: the point is that
    // the *overall* deadline is what releases the caller, not a bound that only
    // covers connection setup.
    const backup = runDatabaseBackup({
      connectionString,
      backupDir,
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
      filenamePrefix: "paperclip-deadline",
      connectTimeoutSeconds: 120,
      timeoutSeconds: 1,
    });

    await expect(backup).rejects.toThrow(DatabaseBackupTimeoutError);
    await expect(backup).rejects.toMatchObject({ timeoutMs: 1_000 });
    expect(Date.now() - startedAtMs).toBeLessThan(30_000);
  }, 60_000);

  it("applies retention even though the backup never completes", async () => {
    const connectionString = await startBlackHolePostgres();
    const backupDir = createTempDir("paperclip-db-backup-deadline-retention-");
    const ancient = path.join(backupDir, "paperclip-deadline-ancient.sql.gz");
    const corpse = path.join(backupDir, "paperclip-deadline-20260911-015107.sql");

    fs.writeFileSync(ancient, "an archive well past retention");
    fs.writeFileSync(corpse, "a partial dump from a run that never unwound");
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    fs.utimesSync(ancient, longAgo, longAgo);
    fs.utimesSync(corpse, longAgo, longAgo);

    await expect(
      runDatabaseBackup({
        connectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
        filenamePrefix: "paperclip-deadline",
        connectTimeoutSeconds: 120,
        timeoutSeconds: 1,
      }),
    ).rejects.toThrow(DatabaseBackupTimeoutError);

    // Retention that only runs after a successful backup stops running exactly
    // when a stuck backup makes it matter: here the disk keeps filling while
    // nothing is ever pruned again.
    expect(fs.existsSync(ancient)).toBe(false);
    expect(fs.existsSync(corpse)).toBe(false);
  }, 60_000);

  it("leaves no compressed backup behind when the deadline fires", async () => {
    const connectionString = await startBlackHolePostgres();
    const backupDir = createTempDir("paperclip-db-backup-deadline-artifacts-");

    await expect(
      runDatabaseBackup({
        connectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
        filenamePrefix: "paperclip-deadline",
        connectTimeoutSeconds: 120,
        timeoutSeconds: 1,
      }),
    ).rejects.toThrow(DatabaseBackupTimeoutError);

    expect(fs.readdirSync(backupDir).filter((name) => name.endsWith(".sql.gz"))).toEqual([]);
  }, 60_000);
});

describe("pruneDatabaseBackups", () => {
  it("deletes raw .sql files a wedged run left behind, and spares recent ones", () => {
    const backupDir = createTempDir("paperclip-db-backup-orphans-");
    const corpse = path.join(backupDir, "paperclip-20260911-015107.sql");
    const inProgress = path.join(backupDir, "paperclip-20260917-020000.sql");
    const keptArchive = path.join(backupDir, "paperclip-20260917-010000.sql.gz");

    fs.writeFileSync(corpse, "partial dump from a backup that never unwound");
    fs.writeFileSync(inProgress, "a backup running right now, in another process");
    fs.writeFileSync(keptArchive, "a real backup");

    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    fs.utimesSync(corpse, sixDaysAgo, sixDaysAgo);

    const prunedCount = pruneDatabaseBackups({
      backupDir,
      retention: { dailyDays: 30, weeklyWeeks: 4, monthlyMonths: 12 },
      filenamePrefix: "paperclip",
      orphanGraceSeconds: 60 * 60,
    });

    expect(prunedCount).toBe(1);
    expect(fs.existsSync(corpse)).toBe(false);
    // Younger than the grace period: it may well be an active backup.
    expect(fs.existsSync(inProgress)).toBe(true);
    expect(fs.existsSync(keptArchive)).toBe(true);
  });

  it("applies retention without a backup having to succeed first", () => {
    const backupDir = createTempDir("paperclip-db-backup-standalone-prune-");
    const recent = path.join(backupDir, "paperclip-recent.sql.gz");
    const ancient = path.join(backupDir, "paperclip-ancient.sql.gz");
    const foreign = path.join(backupDir, "other-prefix-ancient.sql.gz");

    for (const file of [recent, ancient, foreign]) fs.writeFileSync(file, "backup");
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    fs.utimesSync(ancient, longAgo, longAgo);
    fs.utimesSync(foreign, longAgo, longAgo);

    const prunedCount = pruneDatabaseBackups({
      backupDir,
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
      filenamePrefix: "paperclip",
    });

    expect(prunedCount).toBe(1);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(ancient)).toBe(false);
    // A different prefix belongs to a different instance sharing the directory.
    expect(fs.existsSync(foreign)).toBe(true);
  });
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
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
        fs.writeFileSync(janNewest, "jan-newest");
        fs.writeFileSync(janOlder, "jan-older");
        fs.writeFileSync(decOld, "dec-old");

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
        await sourceSql.unsafe(`
          CREATE FUNCTION "public"."backup_test_mark_done"()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            NEW."state" := 'done';
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER "backup_test_mark_done_trigger"
          BEFORE UPDATE OF "title" ON "public"."backup_test_records"
          FOR EACH ROW
          EXECUTE FUNCTION "public"."backup_test_mark_done"();
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

        await restoreSql.unsafe(`
          UPDATE "public"."backup_test_records"
          SET "title" = 'triggered'
          WHERE "title" = 'row-0'
        `);
        const triggeredRows = await restoreSql.unsafe<{ state: string }[]>(`
          SELECT "state"::text AS "state"
          FROM "public"."backup_test_records"
          WHERE "title" = 'triggered'
        `);
        expect(triggeredRows).toEqual([{ state: "done" }]);
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
      const originalPsqlPath = process.env.PAPERCLIP_PSQL_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";
      process.env.PAPERCLIP_PSQL_PATH = "/bin/false";

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
        expect(backupSql).not.toContain(" FROM stdin;");

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
        if (originalPsqlPath === undefined) {
          delete process.env.PAPERCLIP_PSQL_PATH;
        } else {
          process.env.PAPERCLIP_PSQL_PATH = originalPsqlPath;
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

describeEmbeddedPostgres("runDatabaseBackup streaming COPY path", () => {
  it(
    "streams COPY data from inside the timeout-bounded transaction",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-copy-txn-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."copy_txn_rows" (
            "id" integer PRIMARY KEY,
            "payload" text NOT NULL
          );
          CREATE TABLE "public"."copy_txn_skipped" ("id" integer PRIMARY KEY);
          INSERT INTO "public"."copy_txn_rows" ("id", "payload")
          SELECT g, 'row-' || g FROM generate_series(1, 500) AS g;
        `);

        // `excludeTables` is a transform, so pg_dump is not eligible while the
        // engine still resolves to `auto` — the only combination that reaches
        // the streaming COPY branch, and therefore the only one that exercises
        // the transaction the COPY's `statement_timeout` is scoped to.
        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-txn",
          backupEngine: "auto",
          excludeTables: ["copy_txn_skipped"],
          statementTimeoutSeconds: 30,
        });

        const backupSql = gunzipSync(await fs.promises.readFile(result.backupFile)).toString("utf8");
        // Guards the test itself: without this the assertions below would still
        // pass on the row-cursor path and prove nothing about COPY.
        // Guards the test itself: without this the assertions below would still
        // pass on the row-cursor path and prove nothing about COPY.
        expect(backupSql).toContain(`COPY "public"."copy_txn_rows" ("id", "payload") FROM stdin;`);

        // Every row has to survive the round trip through the transaction, not
        // just the first chunk — a COPY that the transaction cut short would
        // still emit the header and a truncated body.
        const copyBody = backupSql
          .split(`COPY "public"."copy_txn_rows" ("id", "payload") FROM stdin;\n`)[1]
          ?.split("\n\\.")[0] ?? "";
        const copiedRows = copyBody.split("\n").filter((line) => line.length > 0);
        expect(copiedRows).toHaveLength(500);
        expect(copiedRows[0]).toBe("1\trow-1");
        expect(copiedRows.at(-1)).toBe("500\trow-500");
      } finally {
        await sourceSql.end();
      }
    },
    60_000,
  );
});

describeEmbeddedPostgres("applyLocalBackupTimeouts", () => {
  it(
    "binds the backup timeouts to the transaction, not to the session",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1 });
      cleanups.push(async () => {
        await sql.end({ timeout: 5 });
      });

      // `pg_settings.setting` reports the raw value in the GUC's own base unit
      // (ms), so this does not depend on how PostgreSQL chooses to spell the
      // interval back at us the way `current_setting` would.
      const readTimeouts = async (handle: postgres.Sql) =>
        await handle<{ name: string; setting: string }[]>`
          SELECT name, setting
          FROM pg_settings
          WHERE name IN ('statement_timeout', 'idle_in_transaction_session_timeout')
          ORDER BY name
        `;

      const before = await readTimeouts(sql);

      const inside = await sql.begin(async (tx) => {
        await applyLocalBackupTimeouts(tx, 7_000);
        return await readTimeouts(tx as unknown as postgres.Sql);
      });

      // In force on the backend that runs the guarded statement — this is the
      // half that a standalone, session-scoped `set_config` cannot guarantee
      // through a transaction-mode pooler, because the pooler is free to run
      // the protected statement on a different backend.
      expect(inside).toEqual([
        { name: "idle_in_transaction_session_timeout", setting: "7000" },
        { name: "statement_timeout", setting: "7000" },
      ]);

      // ...and gone again the moment the transaction ends. A pooler hands that
      // backend to the next client, so a setting that outlived the transaction
      // would be a cross-tenant leak rather than a backstop.
      const after = await readTimeouts(sql);
      expect(after).toEqual(before);
      expect(after.map((row) => row.setting)).not.toContain("7000");
    },
    20_000,
  );
});
