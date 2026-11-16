import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  assertNoSchemaDrift,
  collectExpectedSchema,
  diffSchema,
  inspectSchemaDrift,
  SchemaDriftError,
} from "./schema-drift.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-drift-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres schema-drift tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("collectExpectedSchema", () => {
  it("captures known tables and their database column names", () => {
    const expected = collectExpectedSchema();
    expect(expected.size).toBeGreaterThan(50);
    const companies = expected.get("companies");
    expect(companies).toBeDefined();
    // Real companies columns from the drizzle schema; their absence from the
    // live DB is exactly the AGE-759/AGE-764 drift pattern this gate catches.
    expect(companies?.has("issue_prefix")).toBe(true);
    expect(companies?.has("budget_monthly_cents")).toBe(true);
  });
});

describe("diffSchema", () => {
  it("reports missing tables and columns and is clean when live matches", () => {
    const expected = new Map<string, Set<string>>([
      ["companies", new Set(["id", "attachment_max_bytes", "brand_color"])],
      ["agents", new Set(["id"])],
    ]);

    const clean = diffSchema(expected, new Map([
      ["companies", new Set(["id", "attachment_max_bytes", "brand_color"])],
      ["agents", new Set(["id"])],
    ]));
    expect(clean.drifted).toBe(false);
    expect(clean.checkedTables).toBe(2);

    const drifted = diffSchema(expected, new Map([
      ["companies", new Set(["id"])],
    ]));
    expect(drifted.drifted).toBe(true);
    expect(drifted.missingTables).toEqual(["agents"]);
    expect(drifted.missingColumns).toEqual([
      { table: "companies", column: "attachment_max_bytes" },
      { table: "companies", column: "brand_color" },
    ]);
  });

  it("does not flag extra live columns/tables as drift", () => {
    const expected = new Map<string, Set<string>>([["companies", new Set(["id"])]]);
    const report = diffSchema(expected, new Map([
      ["companies", new Set(["id", "extra_column"])],
      ["extra_table", new Set(["id"])],
    ]));
    expect(report.drifted).toBe(false);
  });
});

describeEmbeddedPostgres("inspectSchemaDrift (live database)", () => {
  it("reports no drift after a full migration", async () => {
    const connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);

    const report = await inspectSchemaDrift(connectionString);
    expect(report.drifted).toBe(false);
    expect(report.missingTables).toEqual([]);
    expect(report.missingColumns).toEqual([]);

    await expect(assertNoSchemaDrift(connectionString)).resolves.toBeDefined();
  }, 120_000);

  it("detects a dropped column even when the migration journal says up to date", async () => {
    const connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);

    // Simulate the AGE-759 drift: the drizzle schema and the fully-applied
    // migration journal both say companies.budget_monthly_cents exists, but the
    // live column is gone.
    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe('ALTER TABLE "companies" DROP COLUMN "budget_monthly_cents"');
    } finally {
      await sql.end();
    }

    const report = await inspectSchemaDrift(connectionString);
    expect(report.drifted).toBe(true);
    expect(report.missingColumns).toContainEqual({
      table: "companies",
      column: "budget_monthly_cents",
    });

    await expect(assertNoSchemaDrift(connectionString)).rejects.toBeInstanceOf(SchemaDriftError);
  }, 120_000);

  it("detects a dropped table", async () => {
    const connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);

    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe('DROP TABLE IF EXISTS "feedback_exports" CASCADE');
    } finally {
      await sql.end();
    }

    const report = await inspectSchemaDrift(connectionString);
    expect(report.drifted).toBe(true);
    expect(report.missingTables).toContain("feedback_exports");
  }, 120_000);
});
