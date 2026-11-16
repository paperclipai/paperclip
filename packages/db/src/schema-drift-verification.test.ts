import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
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

// These tests exercise the boot-time schema-drift verifier that closes the
// migration-gate journal-trust blind spot behind the AGE-759 outage. The drizzle
// journal (`__drizzle_migrations`) only records *which migration files ran*, so a
// prod journal whose lineage diverges from the committed files can report
// `upToDate` while the recorded DDL is physically absent. Each drift case below
// deliberately mutates the live DDL *without touching the journal*, mirroring
// that real failure mode.

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("boot-time schema-drift verification", () => {
  it("reports ok (and ignores additive drift) when every code-expected object is present", async () => {
    const database = await startEmbeddedPostgresTestDatabase("schema-drift-ok-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      // A freshly migrated database contains everything the drizzle schema
      // defines, so the verifier must report no drift.
      const clean = await verifyLiveSchema(database.connectionString);
      expect(clean.status).toBe("ok");
      if (clean.status !== "ok") throw new Error("unreachable");
      expect(clean.checkedTables).toBeGreaterThan(0);

      // Additive drift is safe: an extra column on a known table and an extra
      // table the code never selects against must NOT be reported as drift.
      await sql`ALTER TABLE companies ADD COLUMN __age778_extra_column text`;
      await sql`CREATE TABLE __age778_extra_table (id uuid PRIMARY KEY)`;
      const additive = await verifyLiveSchema(database.connectionString);
      expect(additive).toEqual({ status: "ok", checkedTables: clean.checkedTables });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("flags code-expected columns and tables that are physically absent despite an intact journal", async () => {
    const database = await startEmbeddedPostgresTestDatabase("schema-drift-missing-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      // Drop a code-expected column (companies.description — the AGE-759 hot
      // table) and a whole code-expected leaf table, WITHOUT removing their
      // journal entries. This is exactly the journal-trust blind spot.
      await sql`ALTER TABLE companies DROP COLUMN description`;
      await sql`DROP TABLE announcement_dismissals CASCADE`;

      // The migration gate is blind to this: the journal still says upToDate
      // because the migration files are all recorded as applied.
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "upToDate",
      });

      // The schema verifier catches the physical absence the gate missed.
      const drift = await verifyLiveSchema(database.connectionString);
      expect(drift.status).toBe("drift");
      if (drift.status !== "drift") throw new Error("unreachable");
      expect(drift.missingTables).toContain("announcement_dismissals");
      expect(drift.missingColumns).toContainEqual({ table: "companies", column: "description" });
      // A fully-absent table is reported once as a missing table, not as each of
      // its columns.
      expect(drift.missingColumns.some((c) => c.table === "announcement_dismissals")).toBe(false);

      const summary = formatSchemaDrift(drift);
      expect(summary).toContain("announcement_dismissals");
      expect(summary).toContain("companies.description");
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});

// Pure-function coverage for the log/error summary — no database needed, so it
// runs everywhere (including where embedded Postgres is unsupported) and pins
// both the combined format and the branch that omits an empty section.
describe("formatSchemaDrift", () => {
  const base = { status: "drift", checkedTables: 10 } as const;

  it("summarizes missing tables and columns on one line", () => {
    const drift: Extract<SchemaVerificationResult, { status: "drift" }> = {
      ...base,
      missingTables: ["company_logos"],
      missingColumns: [{ table: "companies", column: "pause_reason" }],
    };
    expect(formatSchemaDrift(drift)).toBe(
      "missing tables: company_logos; missing columns: companies.pause_reason",
    );
  });

  it("omits the empty section when only columns are missing", () => {
    const drift: Extract<SchemaVerificationResult, { status: "drift" }> = {
      ...base,
      missingTables: [],
      missingColumns: [{ table: "companies", column: "pause_reason" }],
    };
    expect(formatSchemaDrift(drift)).toBe("missing columns: companies.pause_reason");
  });

  it("omits the empty section when only tables are missing", () => {
    const drift: Extract<SchemaVerificationResult, { status: "drift" }> = {
      ...base,
      missingTables: ["company_logos"],
      missingColumns: [],
    };
    expect(formatSchemaDrift(drift)).toBe("missing tables: company_logos");
  });
});
