/**
 * Tests for the plugin tables migration (0026_plugin_tables).
 *
 * These tests validate the migration artifacts without requiring a live
 * database connection:
 *   - Migration SQL file structure and correctness
 *   - _journal.json entry for the migration
 *   - Schema export completeness
 *   - SQL statement splitting (the custom breakpoint parser)
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "../schema/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIGRATION_FILE = new URL(
  "../migrations/0026_plugin_tables.sql",
  import.meta.url,
).pathname;

const JOURNAL_FILE = new URL(
  "../migrations/meta/_journal.json",
  import.meta.url,
).pathname;

/** Split a Drizzle migration SQL file into individual statements. */
function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function readMigrationSql(): Promise<string> {
  return readFile(MIGRATION_FILE, "utf8");
}

async function readJournal(): Promise<{ version: string; dialect: string; entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }> }> {
  const raw = await readFile(JOURNAL_FILE, "utf8");
  return JSON.parse(raw);
}

// ===========================================================================
// Migration SQL file — existence and basic structure
// ===========================================================================

describe("0026_plugin_tables.sql — file structure", () => {
  it("the migration file exists and is readable", async () => {
    const content = await readMigrationSql();
    expect(content.length).toBeGreaterThan(0);
  });

  it("contains at least one statement-breakpoint separator", async () => {
    const content = await readMigrationSql();
    expect(content).toContain("--> statement-breakpoint");
  });

  it("splits into multiple individual SQL statements", async () => {
    const content = await readMigrationSql();
    const statements = splitMigrationStatements(content);
    expect(statements.length).toBeGreaterThan(1);
  });
});

// ===========================================================================
// CREATE TABLE statements
// ===========================================================================

describe("0026_plugin_tables.sql — CREATE TABLE statements", () => {
  const expectedTables = [
    "plugins",
    "plugin_config",
    "plugin_state",
    "plugin_entities",
    "plugin_jobs",
    "plugin_job_runs",
    "plugin_webhook_deliveries",
  ] as const;

  for (const tableName of expectedTables) {
    it(`contains CREATE TABLE "${tableName}"`, async () => {
      const content = await readMigrationSql();
      expect(content).toContain(`CREATE TABLE "${tableName}"`);
    });
  }

  it("creates exactly 7 tables (no extra, no missing)", async () => {
    const content = await readMigrationSql();
    const createTableMatches = content.match(/CREATE TABLE "[^"]+"/g) ?? [];
    expect(createTableMatches).toHaveLength(7);
  });
});

// ===========================================================================
// plugins table — column definitions
// ===========================================================================

describe("plugins table — column definitions", () => {
  it("has a uuid primary key column 'id'", async () => {
    const content = await readMigrationSql();
    expect(content).toContain('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()');
  });

  it("has a non-null 'plugin_key' text column", async () => {
    const content = await readMigrationSql();
    expect(content).toContain('"plugin_key" text NOT NULL');
  });

  it("has a non-null 'package_name' text column", async () => {
    const content = await readMigrationSql();
    expect(content).toContain('"package_name" text NOT NULL');
  });

  it("has an 'api_version' integer column defaulting to 1", async () => {
    const content = await readMigrationSql();
    expect(content).toContain('"api_version" integer DEFAULT 1 NOT NULL');
  });

  it("has a 'categories' jsonb column defaulting to empty array", async () => {
    const content = await readMigrationSql();
    expect(content).toContain("\"categories\" jsonb DEFAULT '[]'::jsonb NOT NULL");
  });

  it("has a 'status' text column defaulting to 'installed'", async () => {
    const content = await readMigrationSql();
    expect(content).toContain("\"status\" text DEFAULT 'installed' NOT NULL");
  });

  it("has a nullable 'install_order' integer column", async () => {
    const content = await readMigrationSql();
    // nullable (no NOT NULL) install_order
    expect(content).toContain('"install_order" integer');
    // Confirm it is not erroneously marked NOT NULL
    expect(content).not.toContain('"install_order" integer NOT NULL');
  });

  it("has 'installed_at' and 'updated_at' timestamptz columns", async () => {
    const content = await readMigrationSql();
    expect(content).toContain('"installed_at" timestamp with time zone DEFAULT now() NOT NULL');
    expect(content).toContain('"updated_at" timestamp with time zone DEFAULT now() NOT NULL');
  });
});

// ===========================================================================
// plugin_state table — unique constraint form
// ===========================================================================

describe("plugin_state table — unique constraint", () => {
  it("uses an inline CONSTRAINT rather than a separate CREATE UNIQUE INDEX", async () => {
    const content = await readMigrationSql();
    // The constraint must appear inline in the CREATE TABLE DDL
    expect(content).toContain('CONSTRAINT "plugin_state_unique_entry_idx" UNIQUE NULLS NOT DISTINCT');
  });

  it("NULLS NOT DISTINCT constraint covers the correct 5 columns", async () => {
    const content = await readMigrationSql();
    expect(content).toContain(
      'CONSTRAINT "plugin_state_unique_entry_idx" UNIQUE NULLS NOT DISTINCT("plugin_id","scope_kind","scope_id","namespace","state_key")',
    );
  });

  it("does NOT create a separate CREATE UNIQUE INDEX for plugin_state_unique_entry_idx", async () => {
    const content = await readMigrationSql();
    expect(content).not.toContain(
      'CREATE UNIQUE INDEX "plugin_state_unique_entry_idx"',
    );
  });

  it("plugin_state_plugin_scope_idx is a regular CREATE INDEX (not unique)", async () => {
    const content = await readMigrationSql();
    expect(content).toContain(
      'CREATE INDEX "plugin_state_plugin_scope_idx" ON "plugin_state"',
    );
    expect(content).not.toContain(
      'CREATE UNIQUE INDEX "plugin_state_plugin_scope_idx"',
    );
  });
});

// ===========================================================================
// Foreign keys — cascade delete
// ===========================================================================

describe("0026_plugin_tables.sql — foreign key constraints", () => {
  const expectedForeignKeys = [
    { constraint: "plugin_config_plugin_id_plugins_id_fk", table: "plugin_config", references: "plugins" },
    { constraint: "plugin_state_plugin_id_plugins_id_fk", table: "plugin_state", references: "plugins" },
    { constraint: "plugin_entities_plugin_id_plugins_id_fk", table: "plugin_entities", references: "plugins" },
    { constraint: "plugin_jobs_plugin_id_plugins_id_fk", table: "plugin_jobs", references: "plugins" },
    { constraint: "plugin_job_runs_job_id_plugin_jobs_id_fk", table: "plugin_job_runs", references: "plugin_jobs" },
    { constraint: "plugin_job_runs_plugin_id_plugins_id_fk", table: "plugin_job_runs", references: "plugins" },
    { constraint: "plugin_webhook_deliveries_plugin_id_plugins_id_fk", table: "plugin_webhook_deliveries", references: "plugins" },
  ];

  for (const { constraint, table, references } of expectedForeignKeys) {
    it(`adds foreign key constraint "${constraint}" with ON DELETE cascade`, async () => {
      const content = await readMigrationSql();
      expect(content).toContain(`ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" FOREIGN KEY`);
      expect(content).toContain(`REFERENCES "public"."${references}"("id") ON DELETE cascade`);
    });
  }
});

// ===========================================================================
// Unique indexes — uniqueIndex() columns
// ===========================================================================

describe("0026_plugin_tables.sql — CREATE UNIQUE INDEX statements", () => {
  const expectedUniqueIndexes = [
    { name: "plugins_plugin_key_idx", table: "plugins", columns: '"plugin_key"' },
    { name: "plugin_config_plugin_id_idx", table: "plugin_config", columns: '"plugin_id"' },
    { name: "plugin_entities_external_idx", table: "plugin_entities", columns: '"plugin_id","entity_type","external_id"' },
    { name: "plugin_jobs_unique_idx", table: "plugin_jobs", columns: '"plugin_id","job_key"' },
  ];

  for (const { name, table, columns } of expectedUniqueIndexes) {
    it(`creates unique index "${name}" on "${table}" (${columns})`, async () => {
      const content = await readMigrationSql();
      expect(content).toContain(`CREATE UNIQUE INDEX "${name}" ON "${table}" USING btree (${columns})`);
    });
  }
});

// ===========================================================================
// Regular indexes
// ===========================================================================

describe("0026_plugin_tables.sql — CREATE INDEX statements (non-unique)", () => {
  const expectedIndexes = [
    { name: "plugins_status_idx", table: "plugins", columns: '"status"' },
    { name: "plugin_entities_plugin_idx", table: "plugin_entities", columns: '"plugin_id"' },
    { name: "plugin_entities_type_idx", table: "plugin_entities", columns: '"entity_type"' },
    { name: "plugin_entities_scope_idx", table: "plugin_entities", columns: '"scope_kind","scope_id"' },
    { name: "plugin_jobs_plugin_idx", table: "plugin_jobs", columns: '"plugin_id"' },
    { name: "plugin_jobs_next_run_idx", table: "plugin_jobs", columns: '"next_run_at"' },
    { name: "plugin_job_runs_job_idx", table: "plugin_job_runs", columns: '"job_id"' },
    { name: "plugin_job_runs_plugin_idx", table: "plugin_job_runs", columns: '"plugin_id"' },
    { name: "plugin_job_runs_status_idx", table: "plugin_job_runs", columns: '"status"' },
    { name: "plugin_webhook_deliveries_plugin_idx", table: "plugin_webhook_deliveries", columns: '"plugin_id"' },
    { name: "plugin_webhook_deliveries_status_idx", table: "plugin_webhook_deliveries", columns: '"status"' },
    { name: "plugin_webhook_deliveries_key_idx", table: "plugin_webhook_deliveries", columns: '"webhook_key"' },
    { name: "plugin_state_plugin_scope_idx", table: "plugin_state", columns: '"plugin_id","scope_kind"' },
  ];

  for (const { name, table, columns } of expectedIndexes) {
    it(`creates regular index "${name}" on "${table}"`, async () => {
      const content = await readMigrationSql();
      expect(content).toContain(`CREATE INDEX "${name}" ON "${table}" USING btree (${columns})`);
    });
  }
});

// ===========================================================================
// _journal.json — entry for migration 0026
// ===========================================================================

describe("_journal.json — migration 0026_plugin_tables entry", () => {
  it("has a valid journal file", async () => {
    const journal = await readJournal();
    expect(journal.version).toBe("7");
    expect(journal.dialect).toBe("postgresql");
    expect(Array.isArray(journal.entries)).toBe(true);
  });

  it("includes an entry for 0026_plugin_tables", async () => {
    const journal = await readJournal();
    const entry = journal.entries.find((e) => e.tag === "0026_plugin_tables");
    expect(entry).toBeDefined();
  });

  it("entry has idx 26", async () => {
    const journal = await readJournal();
    const entry = journal.entries.find((e) => e.tag === "0026_plugin_tables");
    expect(entry?.idx).toBe(26);
  });

  it("entry has version '7'", async () => {
    const journal = await readJournal();
    const entry = journal.entries.find((e) => e.tag === "0026_plugin_tables");
    expect(entry?.version).toBe("7");
  });

  it("entry has breakpoints: true", async () => {
    const journal = await readJournal();
    const entry = journal.entries.find((e) => e.tag === "0026_plugin_tables");
    expect(entry?.breakpoints).toBe(true);
  });

  it("entry 'when' timestamp is after migration 0025 (chronological order)", async () => {
    const journal = await readJournal();
    const entry0025 = journal.entries.find((e) => e.tag === "0025_nasty_salo");
    const entry0026 = journal.entries.find((e) => e.tag === "0026_plugin_tables");
    expect(entry0025).toBeDefined();
    expect(entry0026).toBeDefined();
    expect(entry0026!.when).toBeGreaterThan(entry0025!.when);
  });

  it("entry 'when' is a finite positive integer", async () => {
    const journal = await readJournal();
    const entry = journal.entries.find((e) => e.tag === "0026_plugin_tables");
    expect(typeof entry?.when).toBe("number");
    expect(Number.isFinite(entry?.when)).toBe(true);
    expect(entry!.when).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Schema exports — all plugin tables exported from schema/index.ts
// ===========================================================================

describe("schema/index.ts — plugin table exports", () => {
  it("exports 'plugins' table", () => {
    expect(schema.plugins).toBeDefined();
    expect(typeof schema.plugins).toBe("object");
  });

  it("exports 'pluginConfig' table", () => {
    expect(schema.pluginConfig).toBeDefined();
    expect(typeof schema.pluginConfig).toBe("object");
  });

  it("exports 'pluginCompanySettings' table", () => {
    expect(schema.pluginCompanySettings).toBeDefined();
    expect(typeof schema.pluginCompanySettings).toBe("object");
  });

  it("exports 'pluginState' table", () => {
    expect(schema.pluginState).toBeDefined();
    expect(typeof schema.pluginState).toBe("object");
  });

  it("exports 'pluginEntities' table", () => {
    expect(schema.pluginEntities).toBeDefined();
    expect(typeof schema.pluginEntities).toBe("object");
  });

  it("exports 'pluginJobs' table", () => {
    expect(schema.pluginJobs).toBeDefined();
    expect(typeof schema.pluginJobs).toBe("object");
  });

  it("exports 'pluginJobRuns' table", () => {
    expect(schema.pluginJobRuns).toBeDefined();
    expect(typeof schema.pluginJobRuns).toBe("object");
  });

  it("exports 'pluginWebhookDeliveries' table", () => {
    expect(schema.pluginWebhookDeliveries).toBeDefined();
    expect(typeof schema.pluginWebhookDeliveries).toBe("object");
  });
});

// ===========================================================================
// Drizzle schema object structure — column and table name validation
// ===========================================================================

describe("Drizzle schema objects — table name correctness", () => {
  it("plugins table has the SQL name 'plugins'", () => {
    expect(getTableName(schema.plugins)).toBe("plugins");
  });

  it("pluginConfig table has the SQL name 'plugin_config'", () => {
    expect(getTableName(schema.pluginConfig)).toBe("plugin_config");
  });

  it("pluginCompanySettings table has the SQL name 'plugin_company_settings'", () => {
    expect(getTableName(schema.pluginCompanySettings)).toBe("plugin_company_settings");
  });

  it("pluginCompanySettings exposes an explicit enabled override column", () => {
    expect(schema.pluginCompanySettings.enabled).toBeDefined();
  });

  it("pluginState table has the SQL name 'plugin_state'", () => {
    expect(getTableName(schema.pluginState)).toBe("plugin_state");
  });

  it("pluginEntities table has the SQL name 'plugin_entities'", () => {
    expect(getTableName(schema.pluginEntities)).toBe("plugin_entities");
  });

  it("pluginJobs table has the SQL name 'plugin_jobs'", () => {
    expect(getTableName(schema.pluginJobs)).toBe("plugin_jobs");
  });

  it("pluginJobRuns table has the SQL name 'plugin_job_runs'", () => {
    expect(getTableName(schema.pluginJobRuns)).toBe("plugin_job_runs");
  });

  it("pluginWebhookDeliveries table has the SQL name 'plugin_webhook_deliveries'", () => {
    expect(getTableName(schema.pluginWebhookDeliveries)).toBe("plugin_webhook_deliveries");
  });
});

// ===========================================================================
// splitMigrationStatements — statement parsing logic
// ===========================================================================

describe("splitMigrationStatements — statement parsing", () => {
  it("returns an empty array for empty input", () => {
    expect(splitMigrationStatements("")).toEqual([]);
  });

  it("returns a single statement when no breakpoints are present", () => {
    const sql = "CREATE TABLE foo (id int)";
    const statements = splitMigrationStatements(sql);
    expect(statements).toEqual(["CREATE TABLE foo (id int)"]);
  });

  it("splits on --> statement-breakpoint into two statements", () => {
    const sql = "CREATE TABLE foo (id int);--> statement-breakpointCREATE TABLE bar (id int);";
    const statements = splitMigrationStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe("CREATE TABLE foo (id int);");
    expect(statements[1]).toBe("CREATE TABLE bar (id int);");
  });

  it("trims surrounding whitespace from each statement", () => {
    const sql = "  CREATE TABLE foo (id int);  --> statement-breakpoint  CREATE TABLE bar (id int);  ";
    const statements = splitMigrationStatements(sql);
    expect(statements[0]).toBe("CREATE TABLE foo (id int);");
    expect(statements[1]).toBe("CREATE TABLE bar (id int);");
  });

  it("filters out empty segments (e.g. trailing breakpoint)", () => {
    const sql = "CREATE TABLE foo (id int);--> statement-breakpoint";
    const statements = splitMigrationStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toBe("CREATE TABLE foo (id int);");
  });

  it("the plugin migration produces the correct number of statements", async () => {
    const content = await readMigrationSql();
    const statements = splitMigrationStatements(content);
    // 7 CREATE TABLE + 7 ALTER TABLE ADD CONSTRAINT (FK) + 17 CREATE INDEX (4 unique + 13 regular)
    // Total = 7 + 7 + 17 = 31
    expect(statements.length).toBe(31);
  });
});
