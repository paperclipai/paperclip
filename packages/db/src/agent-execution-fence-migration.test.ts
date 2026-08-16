import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const MIGRATION_FILE = "0218_agent_execution_fence.sql";

describe("agent execution fence migration", () => {
  it("locks heartbeat admissions before checking the zero-execution cutover precondition", async () => {
    const sql = await fs.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
    const lockIndex = sql.indexOf('LOCK TABLE "heartbeat_runs" IN ACCESS EXCLUSIVE MODE');
    const preconditionIndex = sql.indexOf("Agent execution fence migration requires zero admitted executions");
    const finalizationColumnIndex = sql.indexOf('ADD COLUMN "execution_finalization_required"');

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(preconditionIndex).toBeGreaterThan(lockIndex);
    expect(finalizationColumnIndex).toBeGreaterThan(preconditionIndex);
  });
});
