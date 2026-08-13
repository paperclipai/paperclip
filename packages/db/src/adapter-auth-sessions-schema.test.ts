import fs from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { adapterAuthSessions } from "./schema/adapter_auth_sessions.js";

type PgTable = Parameters<typeof getTableConfig>[0];

function findIndex(table: PgTable, indexName: string) {
  return getTableConfig(table).indexes.find((candidate) => candidate.config.name === indexName);
}

function indexColumns(table: PgTable, indexName: string): string[] {
  const index = findIndex(table, indexName);
  if (!index) return [];
  return index.config.columns.map((column) => (column as { name: string }).name);
}

function columnIsNotNull(table: PgTable, columnName: string): boolean {
  const column = getTableConfig(table).columns.find((candidate) => candidate.name === columnName);
  return column?.notNull ?? false;
}

// The migration that creates the table. The test locates it by content, so a
// later re-generation with a different name does not break the test.
function activeIndexMigrationSql(): string {
  const migrationsDir = new URL("./migrations/", import.meta.url);
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
  for (const name of files) {
    const content = fs.readFileSync(new URL(name, migrationsDir), "utf8");
    if (content.includes("adapter_auth_sessions_company_adapter_active_uq")) {
      return content;
    }
  }
  throw new Error("no migration creates adapter_auth_sessions_company_adapter_active_uq");
}

describe("adapter auth sessions schema", () => {
  it("serializes on the company credential slot over the active statuses", () => {
    const active = findIndex(adapterAuthSessions, "adapter_auth_sessions_company_adapter_active_uq");
    expect(active).toBeDefined();
    expect(active?.config.unique).toBe(true);
    expect(indexColumns(adapterAuthSessions, "adapter_auth_sessions_company_adapter_active_uq")).toEqual([
      "company_id",
      "adapter_type",
    ]);
    // The active index is partial; the where clause is present.
    expect(active?.config.where).toBeDefined();
  });

  it("keeps the owner principal non-null and out of the uniqueness key", () => {
    expect(columnIsNotNull(adapterAuthSessions, "started_by_user_id")).toBe(true);
    const activeColumns = indexColumns(
      adapterAuthSessions,
      "adapter_auth_sessions_company_adapter_active_uq",
    );
    expect(activeColumns).not.toContain("started_by_user_id");
    expect(activeColumns).not.toContain("environment_id");
  });

  it("generates a partial unique index over the three active statuses", () => {
    const sql = activeIndexMigrationSql();
    expect(sql).toContain('CREATE UNIQUE INDEX "adapter_auth_sessions_company_adapter_active_uq"');
    expect(sql).toContain('("company_id","adapter_type")');
    expect(sql).toContain("'starting', 'waiting_for_user', 'promoting'");
    expect(sql).toContain('"started_by_user_id" text NOT NULL');
  });
});
