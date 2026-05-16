/**
 * Export JSON column snapshots for orchestration-plane tables (AI scaffolding).
 * Source of truth: Drizzle definitions under src/schema/.
 *
 * Usage:
 *   pnpm --filter @paperclipai/db schema:snapshot:orchestration
 * or from repo root:
 *   pnpm schema:snapshot:orchestration
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { activityLog } from "../src/schema/activity_log.js";
import { agents } from "../src/schema/agents.js";
import { companies } from "../src/schema/companies.js";
import { heartbeatRunEvents } from "../src/schema/heartbeat_run_events.js";
import { heartbeatRuns } from "../src/schema/heartbeat_runs.js";
import { issueComments } from "../src/schema/issue_comments.js";
import { issues } from "../src/schema/issues.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TABLES: PgTable[] = [
  companies,
  agents,
  issues,
  issueComments,
  activityLog,
  heartbeatRuns,
  heartbeatRunEvents,
];

function columnSnapshot(table: PgTable) {
  const cols = getTableColumns(table);
  return Object.entries(cols).map(([jsName, col]) => {
    const c = col as { name: string; columnType?: string; dataType?: string; notNull?: boolean };
    return {
      jsName,
      dbName: c.name,
      notNull: Boolean(c.notNull),
      drizzleColumnType: c.columnType ?? c.dataType ?? "unknown",
    };
  });
}

function main() {
  const tables = TABLES.map((table) => ({
    pgTable: getTableName(table),
    columns: columnSnapshot(table),
  }));

  const payload = {
    generatedAt: new Date().toISOString(),
    description:
      "Orchestration-plane tables only; column names match Postgres. Regenerate: pnpm schema:snapshot:orchestration",
    schemaSource: "packages/db/src/schema/*.ts",
    tables,
  };

  const outPath = path.join(__dirname, "..", "..", "..", "docs", "项目计划", "执行", "orchestration-schema-snapshot.json");
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

main();
