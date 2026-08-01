import { describe, expect, it, vi } from "vitest";

import { PLUGIN_RPC_ERROR_CODES } from "../src/protocol.js";
import { createTestHarness } from "../src/testing.js";
import type { TestHarnessDatabaseTransactionDriver } from "../src/testing.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";

function manifest(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.database-harness-test",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Database harness test",
    description: "Exercises the plugin database test harness.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: {},
    database: { migrationsDir: "migrations" },
  };
}

describe("plugin SDK database test harness", () => {
  it("records one atomic batch and delegates it to the configured driver", async () => {
    const execute = vi.fn(async () => ({ rowCount: 1 }));
    const transaction = vi.fn(async function transactionImpl<T>(
      run: (driver: TestHarnessDatabaseTransactionDriver) => Promise<T>,
    ): Promise<T> {
      return run({ execute });
    });
    const harness = createTestHarness({
      manifest: manifest(["database.namespace.write"]),
      database: { transaction },
    });
    const input = {
      steps: [
        { sql: "INSERT INTO plugin_test.rows (id) VALUES ($1)", params: ["one"], expectRowCount: 1 },
        { sql: "DELETE FROM plugin_test.locks WHERE id = $1", params: ["one"], expectRowCount: 1 },
      ],
    };

    await expect(harness.ctx.db.executeTransaction(input)).resolves.toEqual({
      results: [{ rowCount: 1 }, { rowCount: 1 }],
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenNthCalledWith(1, input.steps[0]);
    expect(execute).toHaveBeenNthCalledWith(2, input.steps[1]);
    expect(harness.dbTransactions).toEqual([input]);
    expect(harness.dbExecutes).toEqual([]);
  });

  it("checks row-count conditions before the test driver commits state", async () => {
    let committedRows: string[] = [];
    const harness = createTestHarness({
      manifest: manifest(["database.namespace.write"]),
      database: {
        async transaction(run) {
          const pendingRows = [...committedRows];
          const result = await run({
            async execute(step) {
              if (step.sql.startsWith("INSERT")) {
                pendingRows.push(String(step.params?.[0]));
                return { rowCount: 1 };
              }
              return { rowCount: 0 };
            },
          });
          committedRows = pendingRows;
          return result;
        },
      },
    });

    await expect(harness.ctx.db.executeTransaction({
      steps: [
        {
          sql: "INSERT INTO plugin_test.rows (id) VALUES ($1)",
          params: ["tentative"],
          expectRowCount: 1,
        },
        {
          sql: "UPDATE plugin_test.rows SET claimed = true WHERE id = $1",
          params: ["missing"],
          expectRowCount: 1,
        },
      ],
    })).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CONDITION_FAILED });
    expect(committedRows).toEqual([]);
  });

  it("surfaces deterministic CONDITION_FAILED semantics without a driver", async () => {
    const harness = createTestHarness({
      manifest: manifest(["database.namespace.write"]),
    });

    await expect(harness.ctx.db.executeTransaction({
      steps: [{
        sql: "UPDATE plugin_test.rows SET claimed = true WHERE id = $1",
        params: ["missing"],
        expectRowCount: 1,
      }],
    })).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.CONDITION_FAILED,
      message: expect.stringContaining("CONDITION_FAILED"),
    });
  });

  it("requires database.namespace.write for atomic batches", async () => {
    const harness = createTestHarness({ manifest: manifest([]) });

    await expect(harness.ctx.db.executeTransaction({
      steps: [{ sql: "DELETE FROM plugin_test.rows", expectRowCount: 0 }],
    })).rejects.toThrow(/database\.namespace\.write/);
    expect(harness.dbTransactions).toEqual([]);
  });
});
