/**
 * Local proof for the native-session run lookup (migration 0457).
 *
 * Runs the real checkpoint-retention pass (dry run) against a synthetic agent
 * history, captures the session-run statement that `sessionRetentionBlocker`
 * sends, and replays that exact SQL with and without
 * `heartbeat_runs_company_native_session_idx`. Order: no index, index, no
 * index, index, to expose cache-order bias. Fails unless every pass returns the
 * same rows and the same service result. Then times the migration through the
 * normal migration runner, including a rerun.
 *
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-native-session-run-index.ts
 *
 * Optional sizes: RUNS (default 50000 runs of the measured agent), OTHER_RUNS
 * (50000 runs of a second agent), RUNS_PER_SESSION (4), PROFILE_KIB (4).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agents, applyPendingMigrations, companies, createDb, issues, nativeRunFinalizations,
  nativeRunnerCheckpoints, startEmbeddedPostgresTestDatabase } from "../packages/db/src/index.js";
import { nativeHarnessBackupExpirationService } from "../server/src/services/native-runtime/native-harness-backup-expiration.js";

const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const RUNS = size("RUNS", 50_000), OTHER_RUNS = size("OTHER_RUNS", 50_000);
const RUNS_PER_SESSION = size("RUNS_PER_SESSION", 4), PROFILE_KIB = size("PROFILE_KIB", 4);
const DAY_MS = 24 * 60 * 60 * 1000;
const migrationName = "0457_native_session_run_index";
const migration = readFileSync(new URL(`../packages/db/src/migrations/${migrationName}.sql`, import.meta.url), "utf8");
const statement = migration.trim();
// The migration runner records each migration by the SHA-256 of its file.
const migrationHash = createHash("sha256").update(migration).digest("hex");
const indexName = statement.match(/IF NOT EXISTS "([a-z_]+)"/)![1]!;

const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let stateBase: string | undefined;
try {
  temporary = await startEmbeddedPostgresTestDatabase("native-session-run-index-");
  db = createDb(temporary.connectionString);
  const sql = db.$client;
  await sql.unsafe("create extension if not exists pgcrypto");
  const now = new Date();
  const finishedAt = new Date(now.getTime() - 10 * DAY_MS);
  const [company] = await db.insert(companies).values({ name: "Index", issuePrefix: "IDX" }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Measured" }).returning();
  const [other] = await db.insert(agents).values({ companyId: company!.id, name: "Other" }).returning();
  const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Closed", status: "done",
    completedAt: finishedAt }).returning();

  const loadStart = performance.now();
  // Incompressible profiles; one run in 100 has an incomplete recovery marker.
  const seedRuns = (agentId: string, count: number) => sql.unsafe(`
    with sessions as (select s, gen_random_uuid() as id from generate_series(0, ($3::int - 1) / $4::int) s)
    insert into heartbeat_runs (company_id, agent_id, status, issue_id, native_issue_id, native_session_id,
      runtime_mode, finished_at, created_at, started_at, runner_profile_json)
    select $1::uuid, $2::uuid, 'succeeded', $5::uuid, $5::uuid, sessions.id, 'native', $6::timestamptz,
      $6::timestamptz - make_interval(secs => g), $6::timestamptz - make_interval(secs => g),
      jsonb_build_object('padding', (select string_agg(encode(gen_random_bytes(768), 'base64'), '')
          from generate_series(1, $7::int) i where g > 0),
        'nativeControllerRecovery', case when g % 100 = 0 then jsonb_build_object(
          'schema', 'paperclip.native-controller-recovery.v1', 'checkpoint', null) end)
    from generate_series(0, $3::int - 1) g join sessions on sessions.s = g / $4::int`,
  [company!.id, agentId, count, RUNS_PER_SESSION, issue!.id, finishedAt.toISOString(), PROFILE_KIB]);
  await seedRuns(agent!.id, RUNS);
  await seedRuns(other!.id, OTHER_RUNS);
  // The retention candidate: one settled run whose session has other runs.
  const [target] = await sql.unsafe(`select id, native_session_id from heartbeat_runs where agent_id = $1::uuid
    order by created_at limit 1 offset $2::int`, [agent!.id, Math.floor(RUNS / 2)]);
  const sessionRuns = await sql.unsafe(`select id from heartbeat_runs where native_session_id = $1::uuid`,
    [target!.native_session_id as string]);
  for (const run of sessionRuns) await db.insert(nativeRunFinalizations).values({ runId: run.id,
    companyId: company!.id, issueId: issue!.id, phase: "committed" });
  await db.insert(nativeRunnerCheckpoints).values({ companyId: company!.id, issueId: issue!.id,
    runId: target!.id as string, part: "header", material: { encrypted: true } });
  await sql.unsafe("vacuum analyze");
  const loadMs = performance.now() - loadStart;
  const tableSizes = await sql.unsafe(`select relname as table, n_live_tup::bigint::text as rows,
      pg_size_pretty(pg_total_relation_size(relid)) as total_size from pg_stat_user_tables
    where relname = 'heartbeat_runs'`);

  stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "native-session-index-state-"));
  const service = nativeHarnessBackupExpirationService(db, { stateBase, closedForDays: 7, now, dryRun: true,
    isSessionBusy: () => false });
  type Captured = { sql: string; params: unknown[] };
  async function runPass() {
    const captured: Captured[] = [];
    const prior = sql.options.debug;
    sql.options.debug = (_connection, query, params) => { captured.push({ sql: query, params: [...params] }); };
    try {
      const result = await service.tickCheckpoints();
      const lookup = captured.filter(query => query.sql.includes("nativeControllerRecovery")
        && query.sql.includes('"heartbeat_runs"."native_session_id" = '));
      assert.equal(lookup.length, 1, "One session-run lookup per retention candidate");
      return { result, lookup: lookup[0]! };
    } finally { sql.options.debug = prior; }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const round = (value: number) => Number(value.toFixed(3));
  async function explain(query: Captured) {
    const [result] = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
    return (result!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown>; "Execution Time": number }>)[0]!;
  }
  async function measure(withIndex: boolean) {
    let buildMs: number | null = null;
    if (withIndex) {
      const start = performance.now();
      await sql.unsafe(statement);
      buildMs = round(performance.now() - start);
    } else await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
    await sql.unsafe("analyze heartbeat_runs");
    const pass = await runPass();
    const rows = (await sql.unsafe(pass.lookup.sql, pass.lookup.params as never[]).values())
      .map(row => row.map(value => value instanceof Date ? value.toISOString() : value?.toString() ?? null))
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    for (let n = 0; n < 3; n++) await explain(pass.lookup);
    const samples: number[] = [];
    for (let n = 0; n < 15; n++) samples.push((await explain(pass.lookup))["Execution Time"]);
    const plan = await explain(pass.lookup);
    const nodes: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      nodes.push(`${node["Node Type"]}${node["Index Name"] ? ` using ${node["Index Name"]}` : ""}`);
      for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
    };
    walk(plan.Plan);
    const wall: number[] = [];
    for (let n = 0; n < 9; n++) {
      const start = performance.now();
      await runPass();
      wall.push(performance.now() - start);
    }
    return { withIndex, buildMs, sql: pass.lookup.sql, rows, result: pass.result,
      executionMs: { median: round(median(samples)), min: round(Math.min(...samples)), max: round(Math.max(...samples)) },
      retentionPassWallMs: { median: round(median(wall)), min: round(Math.min(...wall)), max: round(Math.max(...wall)) },
      sharedHitBlocks: plan.Plan["Shared Hit Blocks"], sharedReadBlocks: plan.Plan["Shared Read Blocks"], nodes };
  }
  const runs = [await measure(false), await measure(true), await measure(false), await measure(true)];
  const reference = runs[0]!;
  for (const run of runs) {
    assert.equal(run.sql, reference.sql, "The service SQL must not change");
    assert.deepEqual(run.rows, reference.rows, "Session-run rows must match");
    assert.deepEqual(run.result, reference.result, "Retention results must match");
  }
  assert.equal(reference.rows.length, RUNS_PER_SESSION);
  assert.equal(reference.result.checkpointCandidates, 1);
  assert.ok(runs[1]!.nodes.some(node => node.includes(indexName)), "The index must serve the lookup");

  async function migrate() {
    const removed = await sql.unsafe(`delete from drizzle.__drizzle_migrations where hash = $1 returning hash`, [migrationHash]);
    assert.equal(removed.length, 1, `Exactly one ${migrationName} receipt`);
    const start = performance.now();
    await applyPendingMigrations(temporary!.connectionString);
    return round(performance.now() - start);
  }
  await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
  const firstRunMs = await migrate();
  const [valid] = await sql.unsafe(`select i.indisvalid, pg_size_pretty(pg_relation_size(c.oid)) as size
    from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = $1`, [indexName]);
  assert.equal(valid?.indisvalid, true);
  const rerunMs = await migrate();

  console.log(JSON.stringify({
    postgresVersion: (await sql.unsafe("select version()"))[0]!.version,
    settings: await sql.unsafe("select name, setting from pg_settings where name in ('shared_buffers','work_mem','jit') order by name"),
    fixture: { synthetic: true, measuredAgentRuns: RUNS, otherAgentRuns: OTHER_RUNS, runsPerSession: RUNS_PER_SESSION,
      profileKiB: PROFILE_KIB, loadMs: Math.round(loadMs), tableSizes },
    correctness: { sqlUnchanged: true, rowsEqual: true, retentionResultEqual: true, rows: reference.rows.length },
    results: runs.map(({ sql: _sql, rows: _rows, result: _result, ...run }) => run),
    sql: reference.sql,
    migration: { firstRunMs, rerunMs, index: valid },
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (stateBase) await fs.rm(stateBase, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}

