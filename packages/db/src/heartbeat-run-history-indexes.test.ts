import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const companyHistoryMigrationPath = fileURLToPath(
  new URL("./migrations/0141_heartbeat_runs_company_created_at_index.sql", import.meta.url),
);
const agentHistoryMigrationPath = fileURLToPath(new URL("./migrations/0196_heartbeat_run_history_indexes.sql", import.meta.url));

describe("heartbeat run history indexes", () => {
  it("keeps company_id and created_at aligned for recent company history", () => {
    const migration = readFileSync(companyHistoryMigrationPath, "utf8");

    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_created_at_desc_idx"\n' +
        '  ON "heartbeat_runs" USING btree ("company_id", "created_at" DESC)',
    );
  });

  it("keeps equality keys first for recent agent history", () => {
    const migration = readFileSync(agentHistoryMigrationPath, "utf8");

    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_created_at_desc_idx"\n' +
        '  ON "heartbeat_runs" USING btree ("company_id", "agent_id", "created_at" DESC)',
    );
  });
});
