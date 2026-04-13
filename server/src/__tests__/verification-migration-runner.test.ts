import { describe, it, expect, vi } from "vitest";
import { runMigrationSpec } from "../services/verification/runners/migration-runner.js";

// Minimal mock db that records all SQL statements and returns configured results for each query.
function makeMockDb(
  execResults: Array<
    | { rows: unknown[] }
    | { length: number }
    | { throw: string }
  > = [],
) {
  const statements: string[] = [];
  let callIndex = 0;
  const db = {
    execute: vi.fn(async (sqlOrRaw: unknown) => {
      const s =
        typeof sqlOrRaw === "string"
          ? sqlOrRaw
          : // drizzle's sql.raw returns a SQL object; in the mock we stringify it loosely
            String((sqlOrRaw as { queryChunks?: unknown[] })?.queryChunks ?? sqlOrRaw);
      statements.push(s);
      const result = execResults[callIndex];
      callIndex += 1;
      if (result && "throw" in result) throw new Error(result.throw);
      if (result) return result as unknown;
      // Default: return a length-1 array (post-condition found)
      return [{ "?column?": 1 }] as unknown;
    }),
  };
  return { db: db as unknown as Parameters<typeof runMigrationSpec>[0]["db"], statements };
}

function readFileFrom(body: string) {
  return vi.fn(async () => body);
}

const validSpecPath = "skills/acceptance-migrations/tests/DLD-1.migration.spec.json";

describe("runMigrationSpec", () => {
  it("rejects invalid spec_path", async () => {
    const { db } = makeMockDb();
    const result = await runMigrationSpec({
      issueId: "i1",
      specPath: "bogus",
      db,
      readFileImpl: readFileFrom("{}"),
    });
    expect(result.status).toBe("unavailable");
  });

  it("rejects spec missing migrationSql", async () => {
    const { db } = makeMockDb();
    const result = await runMigrationSpec({
      issueId: "i1",
      specPath: validSpecPath,
      db,
      readFileImpl: readFileFrom(JSON.stringify({ expectSchema: [] })),
    });
    expect(result.status).toBe("unavailable");
  });

  it("rejects migrationSql without SCHEMA placeholder", async () => {
    const spec = {
      migrationSql: "CREATE TABLE foo (id uuid PRIMARY KEY);",
      expectSchema: [{ type: "table_exists", table: "foo" }],
    };
    const { db } = makeMockDb();
    const result = await runMigrationSpec({
      issueId: "i1",
      specPath: validSpecPath,
      db,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.unavailableReason).toContain("SCHEMA");
    }
  });

  it("rejects migrationSql containing DROP SCHEMA", async () => {
    const spec = {
      migrationSql: "DROP SCHEMA public CASCADE; CREATE TABLE SCHEMA.foo (id uuid PRIMARY KEY);",
      expectSchema: [{ type: "table_exists", table: "foo" }],
    };
    const { db } = makeMockDb();
    const result = await runMigrationSpec({
      issueId: "i1",
      specPath: validSpecPath,
      db,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
    });
    expect(result.status).toBe("unavailable");
  });

  it("passes with post-condition satisfied", async () => {
    const spec = {
      migrationSql: "CREATE TABLE SCHEMA.foo (id uuid PRIMARY KEY);",
      expectSchema: [{ type: "table_exists", table: "foo" }],
    };
    // call sequence: create schema, run migration, check table_exists (return 1 row), drop schema
    const { db } = makeMockDb([
      { rows: [] }, // CREATE SCHEMA
      { rows: [] }, // migration
      [{ "?column?": 1 }] as unknown as { length: number }, // SELECT 1 table_exists (array with length 1)
      { rows: [] }, // DROP SCHEMA
    ]);
    const result = await runMigrationSpec({
      issueId: "issue-abc",
      specPath: validSpecPath,
      db,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
    });
    expect(result.status).toBe("passed");
  });

  it("fails when migration SQL throws", async () => {
    const spec = {
      migrationSql: "CREATE TABLE SCHEMA.foo (id uuid);",
      expectSchema: [{ type: "table_exists", table: "foo" }],
    };
    const { db } = makeMockDb([
      { rows: [] }, // CREATE SCHEMA
      { throw: "syntax error near 'uuid'" }, // migration fails
      { rows: [] }, // DROP SCHEMA (cleanup)
    ]);
    const result = await runMigrationSpec({
      issueId: "i1",
      specPath: validSpecPath,
      db,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureSummary).toContain("syntax error");
    }
  });

  it("fails when post-condition not found (empty query result)", async () => {
    const spec = {
      migrationSql: "SELECT 1; -- SCHEMA reference",
      expectSchema: [{ type: "column_exists", table: "nonexistent", column: "col" }],
    };
    const { db } = makeMockDb([
      { rows: [] }, // CREATE SCHEMA
      { rows: [] }, // migration
      [] as unknown as { length: number }, // column_exists SELECT returns empty
      { rows: [] }, // DROP SCHEMA (cleanup)
    ]);
    const result = await runMigrationSpec({
      issueId: "i1",
      specPath: validSpecPath,
      db,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureSummary).toContain("column_exists");
    }
  });

  it("calls execute the expected number of times for a passing migration", async () => {
    const spec = {
      migrationSql: "CREATE TABLE SCHEMA.bar (id uuid);",
      expectSchema: [
        { type: "table_exists", table: "bar" },
        { type: "column_exists", table: "bar", column: "id" },
      ],
    };
    const { db } = makeMockDb([
      { rows: [] }, // CREATE SCHEMA
      { rows: [] }, // migration
      [{ "?column?": 1 }] as unknown as { length: number }, // table_exists
      [{ "?column?": 1 }] as unknown as { length: number }, // column_exists
      { rows: [] }, // DROP SCHEMA
    ]);
    const result = await runMigrationSpec({
      issueId: "abc-def-ghi",
      specPath: validSpecPath,
      db,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
    });
    expect(result.status).toBe("passed");
    if (result.status === "passed") {
      expect(result.postConditionsChecked).toBe(2);
    }
    // 1 CREATE SCHEMA + 1 migration + 2 post-condition SELECTs + 1 DROP SCHEMA = 5 calls
    expect((db as unknown as { execute: { mock: { calls: unknown[] } } }).execute.mock.calls).toHaveLength(5);
  });
});
