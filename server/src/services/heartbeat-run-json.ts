import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

const alias = sql.identifier("heartbeat_run_json");

export const heartbeatRunJsonOnce: SQL = sql`(
  select ${heartbeatRuns.resultJson} || '{}'::jsonb as result_json,
    ${heartbeatRuns.contextSnapshot} || '{}'::jsonb as context_snapshot
  offset 0
) as ${alias}`;

export const heartbeatRunResultJsonOnce: SQL = sql`${alias}.result_json`;
export const heartbeatRunContextSnapshotOnce: SQL = sql`${alias}.context_snapshot`;
