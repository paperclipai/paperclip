import { sql } from "drizzle-orm";
import { livenessDb, type Db } from "@paperclipai/db";

export type DatabaseSessionWait = {
  pid: number;
  applicationName: string | null;
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  blockedBy: number[];
  transactionSeconds: number | null;
  stateSeconds: number | null;
  query: string | null;
};

export type DatabaseSessionCount = { applicationName: string; state: string; sessions: number };

const SESSION_WAITS_SQL = sql`
  with sessions as (
    select pid, application_name, state, wait_event_type, wait_event, pg_blocking_pids(pid) as blocked_by,
      xact_start, state_change, query
    from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
  ), blockers as (select distinct unnest(blocked_by) as pid from sessions)
  select pid, application_name, state, wait_event_type, wait_event, blocked_by,
    extract(epoch from clock_timestamp() - xact_start)::int as transaction_seconds,
    extract(epoch from clock_timestamp() - state_change)::int as state_seconds,
    left(regexp_replace(regexp_replace(query, '''(?:[^'']|'''')*''', '?', 'g'), '\\m[0-9][0-9.]*\\M', '?', 'g'), 160) as query
  from sessions
  where cardinality(blocked_by) > 0 or pid in (select pid from blockers)
    or state like 'idle in transaction%'
    or (xact_start is not null and clock_timestamp() - xact_start > interval '30 seconds')
  order by xact_start nulls last
  limit 50`;

function sessionWait(row: Record<string, unknown>): DatabaseSessionWait {
  return {
    pid: Number(row.pid),
    applicationName: (row.application_name as string | null) ?? null,
    state: (row.state as string | null) ?? null,
    waitEventType: (row.wait_event_type as string | null) ?? null,
    waitEvent: (row.wait_event as string | null) ?? null,
    blockedBy: Array.isArray(row.blocked_by) ? row.blocked_by.map(Number) : [],
    transactionSeconds: row.transaction_seconds === null ? null : Number(row.transaction_seconds),
    stateSeconds: row.state_seconds === null ? null : Number(row.state_seconds),
    query: (row.query as string | null) ?? null,
  };
}

export async function readDatabaseSessionWaits(db: Db): Promise<DatabaseSessionWait[]> {
  return livenessDb(db).transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', '5000', true)`);
    const rows = await tx.execute<Record<string, unknown>>(SESSION_WAITS_SQL);
    return rows.map(sessionWait);
  });
}

export async function readDatabaseSessionReport(db: Db, statementTimeoutMs = 5_000): Promise<{
  sessions: DatabaseSessionCount[]; waits: DatabaseSessionWait[];
}> {
  return livenessDb(db).transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`);
    const counts = await tx.execute<Record<string, unknown>>(sql`
      select coalesce(application_name, '') as application_name, coalesce(state, '') as state, count(*)::int as sessions
      from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
      group by 1, 2
      order by 3 desc
      limit 40`);
    const rows = await tx.execute<Record<string, unknown>>(SESSION_WAITS_SQL);
    return {
      sessions: counts.map(row => ({ applicationName: String(row.application_name), state: String(row.state),
        sessions: Number(row.sessions) })),
      waits: rows.map(sessionWait),
    };
  });
}
