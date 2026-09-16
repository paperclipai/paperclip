import fs from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_AUTH_SESSION_ACTIVE_STATES,
  adapterAuthSessions,
} from "./schema/adapter_auth_sessions.js";

type PgTable = Parameters<typeof getTableConfig>[0];

const ACTIVE_INDEX = "adapter_auth_sessions_company_owner_adapter_active_uq";

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

// The migration that re-scopes the active index. The test locates it by content,
// so a later re-generation with a different name does not break the test.
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

describe("adapter auth sessions schema", () => {
  it("serializes the active slot on company, owner, and adapter", () => {
    const active = findIndex(adapterAuthSessions, ACTIVE_INDEX);
    expect(active).toBeDefined();
    expect(active?.config.unique).toBe(true);
    expect(indexColumns(adapterAuthSessions, ACTIVE_INDEX)).toEqual([
      "company_id",
      "started_by_user_id",
      "adapter_type",
    ]);
    // The active index is partial; the where clause is present.
    expect(active?.config.where).toBeDefined();
  });

  it("keeps the owner principal non-null and drops the environment from the key", () => {
    expect(columnIsNotNull(adapterAuthSessions, "started_by_user_id")).toBe(true);
    const activeColumns = indexColumns(adapterAuthSessions, ACTIVE_INDEX);
    expect(activeColumns).toContain("started_by_user_id");
    expect(activeColumns).not.toContain("environment_id");
  });

  it("adds the public session id, non-null and unique", () => {
    expect(column(adapterAuthSessions, "public_session_id")).toBeDefined();
    expect(columnIsNotNull(adapterAuthSessions, "public_session_id")).toBe(true);
    const uniqueOnPublicSessionId = findIndex(
      adapterAuthSessions,
      "adapter_auth_sessions_public_session_id_uq",
    );
    expect(uniqueOnPublicSessionId).toBeDefined();
    expect(uniqueOnPublicSessionId?.config.unique).toBe(true);
    expect(indexColumns(adapterAuthSessions, "adapter_auth_sessions_public_session_id_uq")).toEqual([
      "public_session_id",
    ]);
  });

  it("adds the claim marker, nullable", () => {
    // A row starts with no claim consumption. The service fills `bound_at` only
    // when the create path consumes the stored claim.
    expect(column(adapterAuthSessions, "bound_at")).toBeDefined();
    expect(columnIsNotNull(adapterAuthSessions, "bound_at")).toBe(false);
  });

  it("merges the two state unions and drops the persisting state", () => {
    expect([...ADAPTER_AUTH_SESSION_ACTIVE_STATES]).toEqual([
      "starting",
      "waiting_for_user",
      "promoting",
      "awaiting_code",
      "submitting",
    ]);
    // The removed state stays out of the active set.
    expect([...ADAPTER_AUTH_SESSION_ACTIVE_STATES]).not.toContain("persisting");
    // The one-time claim state and the terminal states do not hold the slot.
    expect([...ADAPTER_AUTH_SESSION_ACTIVE_STATES]).not.toContain("stored");
    expect([...ADAPTER_AUTH_SESSION_ACTIVE_STATES]).not.toContain("completed");
  });

  it("holds no secret-bearing column", () => {
    // The durable store keeps only ids, the state, the lease reference, and the
    // deadlines. It never holds the prompt, the login URL, the browser code, the
    // token, or a process chunk.
    const names = getTableConfig(adapterAuthSessions).columns.map((c) => c.name);
    const forbidden = ["token", "code", "url", "secret", "credential", "prompt", "output"];
    for (const name of names) {
      for (const needle of forbidden) {
        expect(name.includes(needle)).toBe(false);
      }
    }
  });

  it("generates the partial unique index over the merged active states", () => {
    const sql = activeIndexMigrationSql();
    expect(sql).toContain(`CREATE UNIQUE INDEX "${ACTIVE_INDEX}"`);
    expect(sql).toContain('("company_id","started_by_user_id","adapter_type")');
    expect(sql).toContain(
      "'starting', 'waiting_for_user', 'promoting', 'awaiting_code', 'submitting'",
    );
    // The new non-null column and the unique index are in the migration.
    expect(sql).toContain('"public_session_id" varchar(128) NOT NULL');
    expect(sql).toContain(`CREATE UNIQUE INDEX "adapter_auth_sessions_public_session_id_uq"`);
    // The removed state and the non-active states stay out of the predicate.
    const predicate = sql.slice(sql.indexOf(ACTIVE_INDEX));
    const whereClause = predicate.slice(predicate.indexOf("WHERE"), predicate.indexOf(";"));
    expect(whereClause).not.toContain("'persisting'");
    expect(whereClause).not.toContain("'stored'");
    expect(whereClause).not.toContain("'completed'");
    expect(whereClause).not.toContain("'authenticated'");
  });
});
