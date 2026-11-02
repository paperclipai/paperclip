import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("native runner recovery migration", () => {
  it(
    "repairs a partial application and can be replayed without changing the schema",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-native-recovery-migration-",
      );
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
      });
      cleanups.push(async () => sql.end());

      const migration = await readFile(
        new URL(
          "./migrations/0238_graceful_infant_terrible.sql",
          import.meta.url,
        ),
        "utf8",
      );
      const statements = migration
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);

      // Model an interrupted migration: earlier statements committed, but one of
      // the later columns did not. Reapplying must skip completed work and repair
      // only the missing portion.
      await sql`ALTER TABLE "native_run_finalizations" DROP COLUMN "recovery_request_id"`;
      for (const statement of statements) await sql.unsafe(statement);

      const columnsAfterRepair = await sql<
        {
          columnName: string;
          dataType: string;
          isNullable: "YES" | "NO";
          columnDefault: string | null;
        }[]
      >`
      SELECT
        column_name AS "columnName",
        udt_name AS "dataType",
        is_nullable AS "isNullable",
        column_default AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'native_run_finalizations'
        AND column_name IN (
          'controller_boot_id',
          'controller_pid',
          'controller_process_started_at',
          'controller_generation',
          'recovery_state',
          'recovery_request_id',
          'recovery_history'
        )
      ORDER BY column_name
    `;

      for (const statement of statements) await sql.unsafe(statement);
      const columnsAfterReplay = await sql<
        {
          columnName: string;
          dataType: string;
          isNullable: "YES" | "NO";
          columnDefault: string | null;
        }[]
      >`
      SELECT
        column_name AS "columnName",
        udt_name AS "dataType",
        is_nullable AS "isNullable",
        column_default AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'native_run_finalizations'
        AND column_name IN (
          'controller_boot_id',
          'controller_pid',
          'controller_process_started_at',
          'controller_generation',
          'recovery_state',
          'recovery_request_id',
          'recovery_history'
        )
      ORDER BY column_name
    `;

      expect(columnsAfterReplay).toEqual(columnsAfterRepair);
      expect(columnsAfterReplay).toEqual([
        {
          columnName: "controller_boot_id",
          dataType: "text",
          isNullable: "YES",
          columnDefault: null,
        },
        {
          columnName: "controller_generation",
          dataType: "int4",
          isNullable: "NO",
          columnDefault: "0",
        },
        {
          columnName: "controller_pid",
          dataType: "int4",
          isNullable: "YES",
          columnDefault: null,
        },
        {
          columnName: "controller_process_started_at",
          dataType: "timestamptz",
          isNullable: "YES",
          columnDefault: null,
        },
        {
          columnName: "recovery_history",
          dataType: "jsonb",
          isNullable: "NO",
          columnDefault: "'[]'::jsonb",
        },
        {
          columnName: "recovery_request_id",
          dataType: "text",
          isNullable: "YES",
          columnDefault: null,
        },
        {
          columnName: "recovery_state",
          dataType: "text",
          isNullable: "YES",
          columnDefault: null,
        },
      ]);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
