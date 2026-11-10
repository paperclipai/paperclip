// Measures the attention scan for retry-exhausted runs with and without the
// partial index from migration 0454. This is an index-only change: both sides
// run the same SQL that the service generates.
// Usage (from the repository root):
//   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-exhausted-run-attention.ts \
//     [--runs=30000] [--events-per-run=100] [--samples=9] [--plans]
// The script starts a disposable embedded PostgreSQL and loads a synthetic
// company plus a decoy company. It times the query without the index, times the
// migration's CREATE INDEX CONCURRENTLY, and times the query again. It repeats
// the cycle in reverse order to expose cache bias, asserts identical positional
// rows, and prints medians, spread, build times, and plan summaries as JSON.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { listAttentionExhaustedRuns } from "../server/src/services/attention-exhausted-runs.js";

type Query = { sql: string; params: unknown[] };
const arg = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runCount = Number(arg("runs", "30000"));
const eventsPerRun = Number(arg("events-per-run", "100"));
const sampleCount = Number(arg("samples", "9"));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const migrationPath = "packages/db/src/migrations/0454_lumpy_ronan.sql";
const indexName = "heartbeat_run_events_retry_exhausted_idx";
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;

async function seedCompany(client: Db["$client"], companyId: string, prefix: string, runs: number) {
  await client.unsafe(`INSERT INTO companies (id, name, issue_prefix) VALUES ($1, $2, $3)`, [companyId, `Synthetic ${prefix}`, prefix]);
  // 40 agents; two are terminated so their exhausted runs must stay hidden.
  await client.unsafe(`INSERT INTO agents (id, company_id, name, adapter_type, status)
    SELECT gen_random_uuid(), $1::uuid, 'Agent ' || a, 'codex_local', CASE WHEN a <= 2 THEN 'terminated' ELSE 'idle' END
    FROM generate_series(1, 40) a`, [companyId]);
  await client.unsafe(`WITH numbered AS (
      SELECT n, gen_random_uuid() AS id,
        (SELECT id FROM agents WHERE company_id = $1::uuid ORDER BY name OFFSET (n % 40) LIMIT 1) AS agent_id
      FROM generate_series(1, $2::int) n)
    INSERT INTO bench_runs SELECT $1::uuid, n, id, agent_id FROM numbered`, [companyId, runs]);
  // Status mix: about 10% failed, 3% timed out, the rest succeeded or cancelled.
  // Pairs of runs share created_at so the event-id tie-breaker is exercised.
  await client.unsafe(`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, error, error_code, created_at, updated_at, finished_at, context_snapshot)
    SELECT r.id, r.company_id, r.agent_id,
      CASE WHEN r.n % 10 = 0 THEN 'failed' WHEN r.n % 33 = 0 THEN 'timed_out' WHEN r.n % 50 = 0 THEN 'cancelled' ELSE 'succeeded' END,
      CASE WHEN r.n % 10 = 0 THEN 'adapter exited with code 1' END,
      CASE WHEN r.n % 10 = 0 THEN 'adapter_failed' END,
      timestamptz '2026-10-01T00:00:00Z' + (r.n / 2) * interval '1 second',
      timestamptz '2026-10-01T00:00:00Z' + (r.n / 2) * interval '1 second' + interval '5 minutes',
      timestamptz '2026-10-01T00:00:00Z' + (r.n / 2) * interval '1 second' + interval '5 minutes',
      CASE r.n % 4
        WHEN 0 THEN jsonb_build_object('issueId', 'issue-' || r.n, 'prompt', repeat(md5(r.n::text), 64))
        WHEN 1 THEN jsonb_build_object('taskId', 'task-' || r.n)
        WHEN 2 THEN jsonb_build_object('issueId', null, 'taskId', 'task-' || r.n)
        ELSE '{}'::jsonb END
    FROM bench_runs r WHERE r.company_id = $1::uuid`, [companyId]);
  // Run output: interleave events from groups of 20 concurrent runs, as live
  // heartbeats do. About 5% are lifecycle events.
  await client.unsafe(`INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, stream, message, payload, created_at)
    SELECT r.company_id, r.id, r.agent_id, s,
      CASE WHEN s % 20 = 1 THEN 'lifecycle' ELSE 'item.completed' END,
      CASE WHEN s % 20 = 1 THEN 'system' ELSE 'stdout' END,
      CASE WHEN s % 20 = 1 THEN 'Run step ' || s ELSE md5(r.n::text || ':' || s) || md5(s::text) END,
      jsonb_build_object('chunk', md5(r.id::text || s) || md5(s::text || r.n)),
      timestamptz '2026-10-01T00:00:00Z' + (r.n / 2) * interval '1 second' + s * interval '1 millisecond'
    FROM bench_runs r CROSS JOIN generate_series(1, $2::int) s
    WHERE r.company_id = $1::uuid
    ORDER BY r.n / 20, s, r.n`, [companyId, eventsPerRun]);
  // Retry-exhaustion receipts on 1 in 23 runs (most of those are not failed),
  // a second receipt on some, plus an output decoy that must not match.
  await client.unsafe(`INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, stream, message, created_at)
    SELECT r.company_id, r.id, r.agent_id, $2::int + x.k, x.event_type, 'system', x.message || ' (' || r.n || ')', now()
    FROM bench_runs r
    CROSS JOIN LATERAL (VALUES
      (1, 'lifecycle', 'Bounded retry exhausted after 3 scheduled attempts; no further automatic retry will be queued'),
      (2, 'stdout', 'Bounded retry exhausted quoted in output'),
      (3, 'lifecycle', 'Bounded retry exhausted after 4 scheduled attempts; second receipt')
    ) AS x(k, event_type, message)
    WHERE r.company_id = $1::uuid AND r.n % 23 = 0 AND (x.k = 1 OR r.n % 46 = 0)`, [companyId, eventsPerRun]);
}

async function timeOnce(query: Query) {
  const start = performance.now();
  const rows = await db!.$client.unsafe(query.sql, query.params as never[]).values();
  return { ms: performance.now() - start, rows };
}

async function planSummary(query: Query) {
  const [plan] = await db!.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
  const root = (plan["QUERY PLAN"] as Array<Record<string, any>>)[0];
  return {
    executionMs: root["Execution Time"],
    sharedHitBlocks: root.Plan["Shared Hit Blocks"],
    sharedReadBlocks: root.Plan["Shared Read Blocks"],
    plan: root.Plan,
  };
}

const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    samplesMs: samples.map((value) => Math.round(value * 10) / 10),
  };
};

try {
  database = await startEmbeddedPostgresTestDatabase("exhausted-run-attention-benchmark-");
  db = createDb(database.connectionString);
  const client = db.$client;
  const createIndexSql = (await fs.readFile(fileURLToPath(new URL(`../${migrationPath}`, import.meta.url)), "utf8")).trim();
  const dropIndex = () => client.unsafe(`DROP INDEX IF EXISTS "${indexName}"`);
  const buildIndex = async () => {
    const start = performance.now();
    await client.unsafe(createIndexSql);
    const ms = performance.now() - start;
    await client.unsafe("ANALYZE heartbeat_run_events");
    return ms;
  };

  const companyId = randomUUID();
  const decoyCompanyId = randomUUID();
  const seedStart = performance.now();
  await dropIndex();
  // A regular table: pooled connections do not share temporary tables.
  await client.unsafe(`CREATE TABLE bench_runs (company_id uuid, n int, id uuid, agent_id uuid)`);
  await seedCompany(client, companyId, "BENCH", runCount);
  await seedCompany(client, decoyCompanyId, "DECOY", Math.max(1, Math.floor(runCount / 6)));
  await client.unsafe(`DROP TABLE bench_runs`);
  await client.unsafe("ANALYZE companies, agents, heartbeat_runs, heartbeat_run_events");
  const seedMs = performance.now() - seedStart;
  const [{ events, totalEvents, failed, tableBytes }] = await client.unsafe(`SELECT
    (SELECT count(*) FROM heartbeat_run_events WHERE company_id = $1::uuid)::int AS events,
    (SELECT count(*) FROM heartbeat_run_events)::int AS "totalEvents",
    pg_total_relation_size('heartbeat_run_events')::bigint AS "tableBytes",
    (SELECT count(*) FROM heartbeat_runs WHERE company_id = $1::uuid AND status IN ('failed', 'timed_out'))::int AS failed`, [companyId]);
  const [{ server_version: version }] = await client.unsafe("SHOW server_version");

  const query = listAttentionExhaustedRuns(db, companyId).toSQL() as Query;
  const measure = async () => {
    for (let warm = 0; warm < 2; warm++) await timeOnce(query);
    const samples: number[] = [];
    let rows: unknown[] = [];
    for (let sample = 0; sample < sampleCount; sample++) {
      const result = await timeOnce(query);
      samples.push(result.ms);
      rows = result.rows;
    }
    return { samples, rows, plan: await planSummary(query) };
  };

  // Cycle 1: without the index, then with it. Cycle 2: with it, then without.
  const without1 = await measure();
  const build1Ms = await buildIndex();
  const with1 = await measure();
  const with2 = await measure();
  await dropIndex();
  const without2 = await measure();
  const build2Ms = await buildIndex();
  const [{ indexBytes }] = await client.unsafe(`SELECT pg_relation_size('${indexName}')::bigint AS "indexBytes"`);

  assert.ok(without1.rows.length > 0, "fixture must return exhausted runs");
  for (const result of [with1, with2, without2]) assert.deepEqual(result.rows, without1.rows);
  assert.ok(JSON.stringify(with1.plan.plan).includes(indexName), "query must use the partial index");
  const before = stats([...without1.samples, ...without2.samples]);
  const after = stats([...with1.samples, ...with2.samples]);
  const verbose = process.argv.includes("--plans");
  const brief = (plan: Awaited<ReturnType<typeof planSummary>>) => ({ ...plan, plan: verbose ? plan.plan : undefined });
  console.log(JSON.stringify({
    revision,
    postgresVersion: version,
    fixture: {
      runs: runCount, eventsPerRun, companyEvents: events, totalEvents, tableBytes: Number(tableBytes),
      failedOrTimedOutRuns: failed, seedMs: Math.round(seedMs),
    },
    equalRows: without1.rows.length,
    withoutIndex: { ...before, explain: brief(without1.plan) },
    withIndex: { ...after, explain: brief(with1.plan) },
    speedup: before.medianMs / after.medianMs,
    indexBuild: { firstMs: Math.round(build1Ms), secondMs: Math.round(build2Ms), indexBytes: Number(indexBytes) },
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  } finally { clearInterval(keepAlive); }
}
