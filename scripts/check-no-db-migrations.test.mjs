import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findBlockedPaths, runCheck } from "./check-no-db-migrations.mjs";

describe("findBlockedPaths", () => {
  it("flags migration SQL files", () => {
    const result = findBlockedPaths(["packages/db/src/migrations/0095_new_migration.sql"]);
    assert.deepStrictEqual(result, ["packages/db/src/migrations/0095_new_migration.sql"]);
  });

  it("flags migration snapshot JSON files", () => {
    const result = findBlockedPaths(["packages/db/src/migrations/meta/0095_snapshot.json"]);
    assert.deepStrictEqual(result, ["packages/db/src/migrations/meta/0095_snapshot.json"]);
  });

  it("flags schema definition files", () => {
    const result = findBlockedPaths(["packages/db/src/schema/new_table.ts"]);
    assert.deepStrictEqual(result, ["packages/db/src/schema/new_table.ts"]);
  });

  it("flags drizzle config", () => {
    const result = findBlockedPaths(["packages/db/drizzle.config.ts"]);
    assert.deepStrictEqual(result, ["packages/db/drizzle.config.ts"]);
  });

  it("allows non-database files", () => {
    const result = findBlockedPaths([
      "server/src/routes/issues.ts",
      "ui/src/components/Board.tsx",
      "packages/shared/src/types.ts",
      "packages/db/src/client.ts",
      "packages/db/package.json",
    ]);
    assert.deepStrictEqual(result, []);
  });

  it("returns multiple blocked files", () => {
    const result = findBlockedPaths([
      "server/src/routes/issues.ts",
      "packages/db/src/schema/agents.ts",
      "packages/db/src/migrations/0095_new.sql",
    ]);
    assert.strictEqual(result.length, 2);
  });

  it("handles empty input", () => {
    assert.deepStrictEqual(findBlockedPaths([]), []);
  });

  it("normalises backslash paths", () => {
    const result = findBlockedPaths(["packages\\db\\src\\schema\\agents.ts"]);
    assert.deepStrictEqual(result, ["packages/db/src/schema/agents.ts"]);
  });
});

describe("runCheck", () => {
  it("returns 0 when no blocked files", () => {
    const code = runCheck(["server/src/index.ts"], { log: () => {}, error: () => {} });
    assert.strictEqual(code, 0);
  });

  it("returns 1 when blocked files found", () => {
    const code = runCheck(["packages/db/src/schema/agents.ts"], { log: () => {}, error: () => {} });
    assert.strictEqual(code, 1);
  });
});
