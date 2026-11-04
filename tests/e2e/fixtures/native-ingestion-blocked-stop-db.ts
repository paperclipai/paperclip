import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";

export async function ownedDatabase(appRoot: string, name: string) {
  const configuration = process.env.PAPERCLIP_E2E_SERVER_CONFIG;
  if (!configuration) throw new Error("Missing disposable application configuration");
  const config = JSON.parse(await readFile(configuration, "utf8"));
  expect(config.database.mode).toBe("embedded-postgres");
  const home = await realpath(path.resolve(path.dirname(configuration), "../.."));
  const directory = await realpath(config.database.embeddedPostgresDataDir);
  expect(directory.startsWith(`${home}${path.sep}`)).toBe(true);
  const owner = (await readFile(path.join(directory, "postmaster.pid"), "utf8")).split(/\r?\n/);
  expect(await realpath(owner[1])).toBe(directory);
  const port = Number(owner[3]);
  expect(Number.isSafeInteger(port) && port > 0 && port <= 65535).toBe(true);
  const postgres = createRequire(path.join(appRoot, "packages/db/package.json"))("postgres");
  return postgres({ host: "127.0.0.1", port, database: "paperclip", username: "paperclip", password: "paperclip",
    max: 1, connect_timeout: 10, connection: { application_name: name } });
}
export async function cancellationSnapshot(sql: any, companyId: string, runId: string) {
  const startedAtMs = Date.now();
  const rows = await sql`select id as run_id, company_id, native_issue_id as issue_id, status,
    result_json->'nativeCancellation' as intent,
    result_json->'executionCancellation' as shared_execution_cancellation,
    result_json->'cancellation' as run_cancellation,
    (select jsonb_build_object('id', d.id, 'companyId', d.company_id, 'runId', d.run_id, 'issueId', d.issue_id,
      'reasonCode', d.reason_code) from status_decisions d where d.company_id = r.company_id and d.run_id = r.id
      and d.issue_id = r.native_issue_id and d.id::text = r.result_json->'nativeCancellation'->>'decisionId') as shared_decision,
    (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'action', a.action, 'details', a.details)), '[]'::jsonb)
      from activity_log a where a.company_id = r.company_id and a.run_id = r.id
      and a.action in ('native.cancellation_intent_recorded', 'native.cancellation_dispatch_acknowledged')) as audits
    from heartbeat_runs r where r.company_id = ${companyId} and r.id = ${runId}`;
  expect(rows).toHaveLength(1);
  return { ...rows[0], queryStartedAtMs: startedAtMs, observedAtMs: Date.now() };
}
export async function blockers(sql: any, holderPid: number) {
  return sql`select pid, application_name, state, wait_event_type, wait_event, query, query_start,
    pg_blocking_pids(pid) as blocking_pids from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()
    and ${holderPid} = any(pg_blocking_pids(pid))`;
}
