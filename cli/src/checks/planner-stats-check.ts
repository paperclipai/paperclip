import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { openDoctorDb } from "./db-connect.js";

const HOT_TABLES = [
  "activity_log",
  "agent_wakeup_requests",
  "agents",
  "companies",
  "heartbeat_run_events",
  "heartbeat_runs",
  "issues",
] as const;

const HOT_TABLE_SET = new Set<string>(HOT_TABLES);
const STALE_AFTER_DAYS = 7;
const TABLE_LIST = HOT_TABLES.map((tableName) => `'${tableName}'`).join(", ");
const STALE_STATS_QUERY = `
  SELECT relname
  FROM pg_stat_user_tables
  WHERE schemaname = 'public'
    AND relname IN (${TABLE_LIST})
    AND COALESCE(GREATEST(last_autoanalyze, last_analyze), '-infinity'::timestamptz)
      < now() - INTERVAL '${STALE_AFTER_DAYS} days'
  ORDER BY relname
`;

type PlannerStatsCheckOptions = {
  openDb?: typeof openDoctorDb;
};

type PlannerStatsRow = {
  relname: string;
};

export async function plannerStatsCheck(
  config: PaperclipConfig,
  configPath?: string,
  opts: PlannerStatsCheckOptions = {},
): Promise<CheckResult> {
  let db;
  try {
    ({ db } = await (opts.openDb ?? openDoctorDb)(config, configPath));
  } catch {
    return skippedResult();
  }

  let rows: PlannerStatsRow[];
  try {
    rows = Array.from(await db.execute(STALE_STATS_QUERY)) as PlannerStatsRow[];
  } catch {
    return skippedResult();
  }

  const staleTables = rows
    .map((row) => row.relname)
    .filter((tableName) => HOT_TABLE_SET.has(tableName));

  if (staleTables.length === 0) {
    return {
      name: "Planner statistics",
      status: "pass",
      message: `Hot-table planner statistics are less than ${STALE_AFTER_DAYS} days old`,
    };
  }

  return {
    name: "Planner statistics",
    status: "warn",
    message: `Stale planner statistics: ${staleTables.join(", ")}`,
    canRepair: true,
    repairHint: "Run ANALYZE on the listed hot tables",
    repair: async () => {
      for (const tableName of staleTables) {
        await db.execute(`ANALYZE "${tableName}"`);
      }
    },
  };
}

function skippedResult(): CheckResult {
  return {
    name: "Planner statistics",
    status: "warn",
    message: "PostgreSQL is not reachable; planner-statistics check skipped",
    canRepair: false,
    repairHint: "Start the Paperclip server, then re-run `paperclipai doctor`",
  };
}
