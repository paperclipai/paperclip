import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  formatSchemaDrift,
  inspectMigrations,
  verifyLiveSchema,
  type SchemaVerificationResult,
} from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createMigratedDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-schema-drift-");
  cleanups.push(db.cleanup);
  await applyPendingMigrations(db.connectionString);
  // Sanity: the journal-based gate considers this database fully migrated.
  expect((await inspectMigrations(db.connectionString)).status).toBe("upToDate");
  return db.connectionString;
}

async function withSql<T>(url: string, fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

describeEmbeddedPostgres("verifyLiveSchema", () => {
  it(
    "reports ok when the live schema matches the drizzle schema",
    async () => {
      const url = await createMigratedDatabase();
      const result = await verifyLiveSchema(url);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.checkedTables).toBeGreaterThan(0);
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "detects a code-expected column that is physically absent even though the journal says up to date",
    async () => {
      const url = await createMigratedDatabase();
      // Simulate the AGE-759 blind spot: journal lineage is intact, but a
      // code-selected column is missing from the physical schema.
      await withSql(url, (sql) => sql.unsafe('ALTER TABLE "companies" DROP COLUMN "pause_reason"'));

      // The journal-based gate is still happy...
      expect((await inspectMigrations(url)).status).toBe("upToDate");

      // ...but the schema verifier catches the drift.
      const result = await verifyLiveSchema(url);
      expect(result.status).toBe("drift");
      if (result.status === "drift") {
        expect(result.missingTables).toEqual([]);
        expect(result.missingColumns).toContainEqual({ table: "companies", column: "pause_reason" });
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "reports a whole table as missing (not its individual columns) when the table is absent",
    async () => {
      const url = await createMigratedDatabase();
      // Renaming removes the expected table name without cascading FK drops that
      // would perturb other tables; the renamed table shows up as an ignored extra.
      await withSql(url, (sql) =>
        sql.unsafe('ALTER TABLE "company_logos" RENAME TO "company_logos_renamed_for_test"'),
      );

      const result = await verifyLiveSchema(url);
      expect(result.status).toBe("drift");
      if (result.status === "drift") {
        expect(result.missingTables).toContain("company_logos");
        // The whole-table case must not also enumerate the table's columns.
        expect(result.missingColumns.filter((c) => c.table === "company_logos")).toEqual([]);
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "ignores additive drift (extra tables/columns the code does not know about)",
    async () => {
      const url = await createMigratedDatabase();
      await withSql(url, async (sql) => {
        await sql.unsafe('ALTER TABLE "companies" ADD COLUMN "unknown_future_column" text');
        await sql.unsafe('CREATE TABLE "unknown_future_table" (id serial primary key)');
      });

      const result = await verifyLiveSchema(url);
      expect(result.status).toBe("ok");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});

describe("formatSchemaDrift", () => {
  it("summarizes missing tables and columns on one line", () => {
    const drift: Extract<SchemaVerificationResult, { status: "drift" }> = {
      status: "drift",
      checkedTables: 10,
      missingTables: ["company_logos"],
      missingColumns: [{ table: "companies", column: "pause_reason" }],
    };
    expect(formatSchemaDrift(drift)).toBe(
      "missing tables: company_logos; missing columns: companies.pause_reason",
    );
  });

  it("omits the empty section when only columns are missing", () => {
    const drift: Extract<SchemaVerificationResult, { status: "drift" }> = {
      status: "drift",
      checkedTables: 10,
      missingTables: [],
      missingColumns: [{ table: "companies", column: "pause_reason" }],
    };
    expect(formatSchemaDrift(drift)).toBe("missing columns: companies.pause_reason");
  });
});
