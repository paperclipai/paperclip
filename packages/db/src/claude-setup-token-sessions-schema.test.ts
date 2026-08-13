import fs from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { claudeSetupTokenSessions } from "./schema/claude_setup_token_sessions.js";

type PgTable = Parameters<typeof getTableConfig>[0];

function findIndex(table: PgTable, indexName: string) {
  return getTableConfig(table).indexes.find((candidate) => candidate.config.name === indexName);
}

function indexColumns(table: PgTable, indexName: string): string[] {
  const index = findIndex(table, indexName);
  if (!index) return [];
  return index.config.columns.map((column) => (column as { name: string }).name);
}

function column(table: PgTable, columnName: string) {
  return getTableConfig(table).columns.find((candidate) => candidate.name === columnName);
}

function columnIsNotNull(table: PgTable, columnName: string): boolean {
  return column(table, columnName)?.notNull ?? false;
}

const ACTIVE_INDEX = "claude_setup_token_sessions_active_uq";

// The migration that creates the table. The test locates it by content, so a
// later re-generation with a different name does not break the test.
function activeIndexMigrationSql(): string {
  const migrationsDir = new URL("./migrations/", import.meta.url);
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
  for (const name of files) {
    const content = fs.readFileSync(new URL(name, migrationsDir), "utf8");
    if (content.includes(ACTIVE_INDEX)) {
      return content;
    }
  }
  throw new Error(`no migration creates ${ACTIVE_INDEX}`);
}

describe("claude setup token sessions schema", () => {
  it("keeps the scope columns and the deadline non-null", () => {
    expect(columnIsNotNull(claudeSetupTokenSessions, "session_id")).toBe(true);
    expect(columnIsNotNull(claudeSetupTokenSessions, "company_id")).toBe(true);
    expect(columnIsNotNull(claudeSetupTokenSessions, "owner_user_id")).toBe(true);
    expect(columnIsNotNull(claudeSetupTokenSessions, "adapter_type")).toBe(true);
    expect(columnIsNotNull(claudeSetupTokenSessions, "environment_id")).toBe(true);
    expect(columnIsNotNull(claudeSetupTokenSessions, "state")).toBe(true);
    expect(columnIsNotNull(claudeSetupTokenSessions, "deadline_at")).toBe(true);
  });

  it("keeps the claim marker and the lease reference nullable", () => {
    // A row starts with no claim consumption and no lease. The service fills
    // `bound_at` only when the create path consumes the stored claim.
    expect(column(claudeSetupTokenSessions, "bound_at")).toBeDefined();
    expect(columnIsNotNull(claudeSetupTokenSessions, "bound_at")).toBe(false);
    expect(column(claudeSetupTokenSessions, "lease_id")).toBeDefined();
    expect(columnIsNotNull(claudeSetupTokenSessions, "lease_id")).toBe(false);
  });

  it("references the company and the environment", () => {
    const foreignKeys = getTableConfig(claudeSetupTokenSessions).foreignKeys;
    const referencedTables = foreignKeys.map((fk) => fk.reference().foreignTable);
    const referencedNames = referencedTables.map(
      (table) => getTableConfig(table as PgTable).name,
    );
    expect(referencedNames).toContain("companies");
    expect(referencedNames).toContain("environments");
  });

  it("holds no secret-bearing column", () => {
    // The durable store keeps only ids, the state, and the deadlines. It never
    // holds the login URL, the browser code, the token, or a process chunk.
    const names = getTableConfig(claudeSetupTokenSessions).columns.map((c) => c.name);
    const forbidden = ["token", "code", "url", "secret", "credential", "prompt", "output"];
    for (const name of names) {
      for (const needle of forbidden) {
        expect(name.includes(needle)).toBe(false);
      }
    }
  });

  it("serializes the active session over the full owner scope", () => {
    const active = findIndex(claudeSetupTokenSessions, ACTIVE_INDEX);
    expect(active).toBeDefined();
    expect(active?.config.unique).toBe(true);
    expect(indexColumns(claudeSetupTokenSessions, ACTIVE_INDEX)).toEqual([
      "company_id",
      "owner_user_id",
      "adapter_type",
      "environment_id",
    ]);
    // The active index is partial; the where clause is present.
    expect(active?.config.where).toBeDefined();
  });

  it("scopes the active partial unique index to the active states only", () => {
    const sql = activeIndexMigrationSql();
    expect(sql).toContain(`CREATE UNIQUE INDEX "${ACTIVE_INDEX}"`);
    expect(sql).toContain('("company_id","owner_user_id","adapter_type","environment_id")');
    // The active states are in the predicate.
    expect(sql).toContain("'starting'");
    expect(sql).toContain("'awaiting_code'");
    expect(sql).toContain("'submitting'");
    expect(sql).toContain("'persisting'");
    // The stored state and the terminal states stay out of the predicate.
    const predicate = sql.slice(sql.indexOf(ACTIVE_INDEX));
    const whereClause = predicate.slice(predicate.indexOf("WHERE"), predicate.indexOf(";"));
    expect(whereClause).not.toContain("'stored'");
    expect(whereClause).not.toContain("'completed'");
    expect(whereClause).not.toContain("'failed'");
    expect(whereClause).not.toContain("'timed_out'");
    expect(whereClause).not.toContain("'cancelled'");
  });
});
