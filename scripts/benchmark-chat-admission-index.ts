/**
 * Local proof for the chat-admission lookup index (migration 0458).
 *
 * `unadmittedChatWakeupCondition` decides whether an issue holds external chat
 * input that was never admitted. Recovery reads one issue with the condition
 * negated, and manual task start reads one issue with it as an `exists` check.
 * The SQL does not change; this script runs both statements with and without
 * the new index and fails unless the complete rows match.
 *
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-chat-admission-index.ts
 *
 * Optional sizes: OTHER_ACTIONS (default 60000), OTHER_PAYLOAD_KIB (6),
 * ISSUES (2000), WAKEUPS_PER_ISSUE (20), WAKEUP_PAYLOAD_KIB (3), RETRIES (1000).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { caseHandoffs, createDb, issues, startEmbeddedPostgresTestDatabase } from "../packages/db/src/index.js";
import { unadmittedChatWakeupCondition } from "../server/src/services/durable-chat-wakeup.js";
import { seedGitHubReviewWait } from "../server/src/__tests__/helpers/github-review-wait.js";

const { and, eq, inArray, isNull, not, notExists, or, sql: dsql } = createRequire(
  new URL("../server/package.json", import.meta.url))("drizzle-orm") as typeof import("drizzle-orm");

const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const OTHER_ACTIONS = size("OTHER_ACTIONS", 60_000), OTHER_PAYLOAD_KIB = size("OTHER_PAYLOAD_KIB", 6);
const ISSUES = size("ISSUES", 2_000), WAKEUPS_PER_ISSUE = size("WAKEUPS_PER_ISSUE", 20);
const WAKEUP_PAYLOAD_KIB = size("WAKEUP_PAYLOAD_KIB", 3), RETRIES = size("RETRIES", 1_000);
const migration = readFileSync(new URL("../packages/db/src/migrations/0458_chat_admission_issue_index.sql", import.meta.url), "utf8");
const indexStatements = migration.split("--> statement-breakpoint").map(statement => statement.trim()).filter(Boolean);
const indexNames = indexStatements.map(statement => statement.match(/IF NOT EXISTS "([a-z_]+)"/)![1]!);
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
try {
  temporary = await startEmbeddedPostgresTestDatabase("chat-admission-index-benchmark-");
  db = createDb(temporary.connectionString);
  const sql = db.$client;
  await sql.unsafe("create extension if not exists pgcrypto");
  const f = await seedGitHubReviewWait(db);
  const decoy = await seedGitHubReviewWait(db);
  const blob = (kib: string) => `(select string_agg(encode(gen_random_bytes(768), 'base64'), '')
    from generate_series(1, ${kib}) s(i) where g > 0)`;

  const loadStart = performance.now();
  // Conversations the inbound actions belong to.
  await sql.unsafe(`insert into chat_conversations (company_id, endpoint_id, resource_id, issue_id,
      external_conversation_id, external_thread_id, external_label)
    select $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'load', 'load-' || g, 'Load' from generate_series(1, 200) g`,
  [f.companyId, f.endpointId, f.resourceId, f.issueId]);
  await sql.unsafe(`insert into issues (company_id, title, assignee_agent_id, status)
    select $1::uuid, 'Load ' || g, $2::uuid, 'in_progress' from generate_series(1, $3::int) g`,
  [f.companyId, f.agentId, ISSUES]);
  // Unrelated chat history with wide incompressible payloads (GitHub checks and replies).
  await sql.unsafe(`insert into chat_actions (company_id, endpoint_id, kind, provider_action_id, status, payload)
    select $1::uuid, $2::uuid, case when g % 2 = 0 then 'github_review_check' else 'github_response_comment' end,
      'other-' || g, 'processed', jsonb_build_object('event', jsonb_build_object('body', ${blob("$3::int")}))
    from generate_series(1, $4::int) g`, [f.companyId, f.endpointId, OTHER_PAYLOAD_KIB, OTHER_ACTIONS]);
  // Inbound wakeups: every issue has a history of admitted messages.
  await sql.unsafe(`with i as (select id, row_number() over (order by id) rn from issues
        where company_id = $1::uuid and title like 'Load %'),
      c as (select id, row_number() over (order by id) - 1 rn from chat_conversations
        where company_id = $1::uuid and external_conversation_id = 'load')
    insert into chat_actions (company_id, endpoint_id, conversation_id, kind, provider_action_id, status, payload, created_at)
    select $1::uuid, $2::uuid, c.id, 'inbound_wakeup', 'wake-' || i.rn || '-' || g, 'processed',
      jsonb_build_object('issueId', i.id::text, 'agentId', $3::text, 'sessionGeneration', 1,
        'text', ${blob("$4::int")}), now() - make_interval(secs => g)
    from i join c on c.rn = i.rn % 200, generate_series(1, $5::int) g`,
  [f.companyId, f.endpointId, f.agentId, WAKEUP_PAYLOAD_KIB, WAKEUPS_PER_ISSUE]);
  await sql.unsafe(`insert into agent_wakeup_requests (id, company_id, agent_id, source, status)
    select id, company_id, $2::uuid, 'automation', 'finished' from chat_actions
    where company_id = $1::uuid and kind = 'inbound_wakeup'`, [f.companyId, f.agentId]);
  // Failed-run retries that skipped some older input.
  await sql.unsafe(`with w as (select id, conversation_id, payload->>'issueId' issue_id,
        row_number() over (order by id) rn from chat_actions where company_id = $1::uuid and kind = 'inbound_wakeup')
    insert into chat_actions (company_id, endpoint_id, conversation_id, kind, provider_action_id, status, payload)
    select $1::uuid, $2::uuid, w.conversation_id, 'failed_run_retry', 'retry-' || w.rn, 'processed',
      jsonb_build_object('issueId', w.issue_id, 'agentId', $3::text,
        'taskRetryInput', jsonb_build_object('skippedActionIds', jsonb_build_array(w.id::text)))
    from w where w.rn <= $4::int`, [f.companyId, f.endpointId, f.agentId, RETRIES]);
  await sql.unsafe(`insert into agent_wakeup_requests (id, company_id, agent_id, source, status)
    select id, company_id, $2::uuid, 'automation', 'finished' from chat_actions
    where company_id = $1::uuid and kind = 'failed_run_retry'`, [f.companyId, f.agentId]);

  // Cases on fresh issues. Each issue has its own conversation slice.
  const issueRows = await sql.unsafe(`select id from issues where company_id = $1::uuid and title like 'Load %'
    order by id limit 6`, [f.companyId]);
  const [quiet, admitted, unadmitted, supersededFailure, retried, decoyOnly] = issueRows.map(row => row.id as string);
  // Remove the shared history from the quiet issue so it has no chat input.
  await sql.unsafe(`delete from agent_wakeup_requests where id in (select id from chat_actions
    where payload->>'issueId' = $1)`, [quiet]);
  await sql.unsafe(`delete from chat_actions where payload->>'issueId' = $1`, [quiet]);
  const [conversation] = await sql.unsafe(`select id from chat_conversations where company_id = $1::uuid
    and external_conversation_id = 'load' order by id limit 1`, [f.companyId]);
  const addAction = async (issueId: string, status: string, kind = "inbound_wakeup", extra = {}, at = "now()") =>
    (await sql.unsafe(`insert into chat_actions (company_id, endpoint_id, conversation_id, kind, provider_action_id,
        status, payload, created_at)
      values ($1::uuid, $2::uuid, $3::uuid, $4, gen_random_uuid()::text, $5, $6::jsonb, ${at}) returning id`,
    [f.companyId, f.endpointId, conversation!.id, kind, status,
      JSON.stringify({ issueId, agentId: f.agentId, sessionGeneration: 1, ...extra })]))[0]!.id as string;
  const admit = (id: string, status = "queued") => sql.unsafe(`insert into agent_wakeup_requests
    (id, company_id, agent_id, source, status) values ($1::uuid, $2::uuid, $3::uuid, 'automation', $4)`,
  [id, f.companyId, f.agentId, status]);
  await admit(await addAction(admitted, "processing"));
  await addAction(unadmitted, "preparing");
  await addAction(supersededFailure, "failed", "inbound_wakeup", {}, "now() - interval '1 minute'");
  await admit(await addAction(supersededFailure, "processing"));
  const skipped = await addAction(retried, "issued");
  await admit(await addAction(retried, "processed", "failed_run_retry",
    { taskRetryInput: { skippedActionIds: [skipped] } }));
  // Same issue id under another company does not hold this issue.
  await sql.unsafe(`insert into chat_actions (company_id, endpoint_id, kind, provider_action_id, status, payload)
    values ($1::uuid, $2::uuid, 'inbound_wakeup', 'decoy', 'preparing', $3::jsonb)`,
  [decoy.companyId, decoy.endpointId, JSON.stringify({ issueId: decoyOnly, agentId: decoy.agentId })]);
  await sql.unsafe("vacuum analyze");
  const loadMs = performance.now() - loadStart;
  const tableSizes = await sql.unsafe(`select relname as table, n_live_tup::int as rows,
      pg_size_pretty(pg_total_relation_size(relid)) as total_size from pg_stat_user_tables
    where relname in ('chat_actions', 'agent_wakeup_requests', 'issues') order by relname`);

  // Recovery: reconcileStrandedAssignedIssues({ companyId, issueId }) candidate read (where clause as in
  // server/src/services/recovery/service.ts). Manual start: the held-input check in heartbeat/queue.ts.
  const recoveryQuery = (issueId: string) => db!.select({ id: issues.id, companyId: issues.companyId,
    status: issues.status, assigneeAgentId: issues.assigneeAgentId }).from(issues).where(and(
    eq(issues.companyId, f.companyId), eq(issues.id, issueId), isNull(issues.assigneeUserId),
    inArray(issues.status, ["todo", "in_progress", "in_review"]),
    or(dsql`${issues.assigneeAgentId} is not null`, eq(issues.status, "in_review")),
    isNull(issues.hiddenAt), not(unadmittedChatWakeupCondition(issues.id, issues.companyId)),
    notExists(db!.select({ id: caseHandoffs.id }).from(caseHandoffs).where(and(
      eq(caseHandoffs.companyId, issues.companyId), eq(caseHandoffs.issueId, issues.id),
      eq(caseHandoffs.destinationKind, "agent"), inArray(caseHandoffs.state, ["awaiting_release", "pending_dispatch"]),
    ))))).toSQL();
  const heldQuery = (issueId: string) => db!.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, issueId), eq(issues.companyId, f.companyId),
    unadmittedChatWakeupCondition(issues.id, issues.companyId))).limit(1).toSQL();
  const cases = { quiet, admitted, unadmitted, supersededFailure, retried, decoyOnly } as Record<string, string>;
  const expectedHeld: Record<string, boolean> = { quiet: false, admitted: false, unadmitted: true,
    supersededFailure: false, retried: false, decoyOnly: false };

  const round = (value: number) => Number(value.toFixed(3));
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const values = async (query: { sql: string; params: unknown[] }) =>
    (await sql.unsafe(query.sql, query.params as never[]).values()).map(row => row.map(value => value?.toString() ?? null));
  async function explain(query: { sql: string; params: unknown[] }) {
    const [result] = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
    return (result!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown>; "Execution Time": number }>)[0]!;
  }
  async function sample(query: { sql: string; params: unknown[] }) {
    for (let n = 0; n < 2; n++) await explain(query);
    const samples: number[] = [];
    for (let n = 0; n < 9; n++) samples.push((await explain(query))["Execution Time"]);
    return { medianMs: round(median(samples)), minMs: round(Math.min(...samples)), maxMs: round(Math.max(...samples)),
      samplesMs: samples.map(round) };
  }
  async function plan(query: { sql: string; params: unknown[] }) {
    const root = await explain(query), nodes: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      if (/Scan|Join|Loop/.test(String(node["Node Type"]))) nodes.push(`${node["Node Type"]}${node["Index Name"] ? ` using ${node["Index Name"]}` : ""}${node["Relation Name"] ? ` on ${node["Relation Name"]}` : ""}`);
      for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
    };
    walk(root.Plan);
    return { sharedHitBlocks: root.Plan["Shared Hit Blocks"], sharedReadBlocks: root.Plan["Shared Read Blocks"], nodes };
  }

  async function measure(indexes: boolean) {
    const builds: Array<{ index: string; ms: number }> = [];
    if (!indexes) {
      for (const name of indexNames) await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    } else {
      for (const [n, statement] of indexStatements.entries()) {
        const start = performance.now();
        await sql.unsafe(statement);
        builds.push({ index: indexNames[n]!, ms: round(performance.now() - start) });
      }
    }
    await sql.unsafe("ANALYZE chat_actions");
    const rows: Record<string, unknown> = {}, timings: Record<string, unknown> = {};
    for (const [name, issueId] of Object.entries(cases)) {
      for (const [caller, query] of [["recovery", recoveryQuery(issueId)], ["manualStartHeld", heldQuery(issueId)]] as const) {
        rows[`${caller}.${name}`] = await values(query);
        timings[`${caller}.${name}`] = { serverExecution: await sample(query), ...(await plan(query)) };
      }
    }
    return { indexes, builds, rows, timings };
  }

  // No index, index, then no index again to expose cache-order bias.
  const runs = [await measure(false), await measure(true), await measure(false), await measure(true)];
  const reference = runs[0]!;
  for (const run of runs) assert.deepEqual(run.rows, reference.rows, "Complete rows must match with and without the index");
  for (const [name, held] of Object.entries(expectedHeld)) {
    assert.equal((reference.rows[`manualStartHeld.${name}`] as unknown[]).length, held ? 1 : 0, `${name} held`);
    assert.equal((reference.rows[`recovery.${name}`] as unknown[]).length, held ? 0 : 1, `${name} recovery candidate`);
  }

  console.log(JSON.stringify({
    treatmentRevision: git("rev-parse", "HEAD"),
    postgresVersion: (await sql.unsafe("select version()"))[0]!.version,
    settings: await sql.unsafe("select name, setting from pg_settings where name in ('shared_buffers','work_mem','jit') order by name"),
    indexDefinitions: indexStatements,
    fixture: { synthetic: true, otherActions: OTHER_ACTIONS, otherPayloadKiB: OTHER_PAYLOAD_KIB, issues: ISSUES,
      wakeupsPerIssue: WAKEUPS_PER_ISSUE, wakeupPayloadKiB: WAKEUP_PAYLOAD_KIB, retries: RETRIES,
      loadMs: Math.round(loadMs), tableSizes },
    sql: { recovery: recoveryQuery(quiet!).sql, manualStartHeld: heldQuery(quiet!).sql },
    correctness: { rowsEqualAcrossRuns: true, expectedHeld },
    results: runs.map(({ rows: _rows, ...run }) => run),
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  } finally { clearInterval(keepAlive); }
}
