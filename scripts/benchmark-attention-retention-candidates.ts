// Measures the attention retention candidate scan before and after it read each
// source kind in its own bounded branch.
// Usage (from the repository root):
//   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-attention-retention-candidates.ts \
//     --baseline-ref=<pre-fix commit> [--companies=12] [--issues=12000] [--runs=20000] \
//     [--events-per-run=20] [--samples=7] [--plans]
// The script starts a disposable embedded PostgreSQL and loads one large company
// plus smaller decoy companies. It loads the baseline service from git, captures
// the candidate SQL that each service generates for the same scopes, and times
// that SQL under custom and generic plans. Baseline and treatment alternate, and
// the script asserts identical positional rows for every scope.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";

type Query = { sql: string; params: unknown[] };
type Scope = Record<string, unknown>;
const arg = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const baselineRef = arg("baseline-ref", "");
if (!baselineRef) throw new Error("Pass --baseline-ref=<pre-fix commit>");
const companyCount = Number(arg("companies", "12"));
const issueCount = Number(arg("issues", "12000"));
const runCount = Number(arg("runs", "20000"));
const eventsPerRun = Number(arg("events-per-run", "20"));
const sampleCount = Number(arg("samples", "7"));
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const baselineSha = git("rev-parse", baselineRef);
const revision = git("rev-parse", "HEAD");
const servicePath = "server/src/services/attention-retention.ts";
const baselineFile = fileURLToPath(new URL("../server/src/services/attention-retention.benchmark-baseline.ts", import.meta.url));
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let timer: Db["$client"] | undefined;

// Sizes scale with `scale`: the main company uses 1, each decoy 1/5.
async function seedCompany(client: Db["$client"], companyId: string, prefix: string, scale: number) {
  const issuesN = Math.max(20, Math.floor(issueCount * scale));
  const runsN = Math.max(20, Math.floor(runCount * scale));
  await client.unsafe(`INSERT INTO companies (id, name, issue_prefix) VALUES ($1, $2, $3)`, [companyId, `Synthetic ${prefix}`, prefix]);
  await client.unsafe(`INSERT INTO agents (id, company_id, name, adapter_type, status)
    SELECT gen_random_uuid(), $1::uuid, 'Agent ' || a, 'codex_local', CASE WHEN a <= 3 THEN 'error' ELSE 'idle' END
    FROM generate_series(1, 40) a`, [companyId]);
  // Status mix: 6% blocked, 6% in review, a few hidden or harness issues among them.
  await client.unsafe(`INSERT INTO issues (id, company_id, title, status, hidden_at, harness_kind, created_at, updated_at)
    SELECT gen_random_uuid(), $1::uuid, 'Issue ' || n,
      CASE WHEN n % 17 = 0 THEN 'blocked' WHEN n % 17 = 1 THEN 'in_review' WHEN n % 5 = 0 THEN 'done' ELSE 'todo' END,
      CASE WHEN n % 97 = 0 THEN timestamptz '2026-09-01' END,
      CASE WHEN n % 89 = 0 THEN 'eval' END,
      timestamptz '2026-09-01' + n * interval '1 minute', timestamptz '2026-09-01' + n * interval '1 minute'
    FROM generate_series(1, $2::int) n`, [companyId, issuesN]);
  await client.unsafe(`CREATE TABLE IF NOT EXISTS bench_issues (company_id uuid, n int, id uuid)`);
  await client.unsafe(`INSERT INTO bench_issues SELECT company_id, row_number() OVER (ORDER BY created_at), id FROM issues WHERE company_id = $1::uuid`, [companyId]);
  await client.unsafe(`CREATE TABLE IF NOT EXISTS bench_runs (company_id uuid, n int, id uuid, agent_id uuid, issue_id uuid)`);
  await client.unsafe(`INSERT INTO bench_runs
    SELECT $1::uuid, g.n, gen_random_uuid(),
      (SELECT id FROM agents WHERE company_id = $1::uuid ORDER BY name OFFSET (g.n % 40) LIMIT 1),
      (SELECT b.id FROM bench_issues b WHERE b.company_id = $1::uuid AND b.n = 1 + g.n % $3::int)
    FROM generate_series(1, $2::int) AS g(n)`, [companyId, runsN, issuesN]);
  // About 10% failed and 3% timed out, with a wide context snapshot.
  await client.unsafe(`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, created_at, updated_at, finished_at, context_snapshot)
    SELECT r.id, r.company_id, r.agent_id,
      CASE WHEN r.n % 10 = 0 THEN 'failed' WHEN r.n % 33 = 0 THEN 'timed_out' ELSE 'succeeded' END,
      timestamptz '2026-10-01' + r.n * interval '1 second', timestamptz '2026-10-01' + r.n * interval '1 second',
      CASE WHEN r.n % 7 <> 0 THEN timestamptz '2026-10-01' + r.n * interval '1 second' + interval '5 minutes' END,
      CASE r.n % 3 WHEN 0 THEN jsonb_build_object('issueId', r.issue_id::text, 'prompt', repeat(md5(r.n::text), 48))
        WHEN 1 THEN jsonb_build_object('taskId', r.issue_id::text) ELSE '{}'::jsonb END
    FROM bench_runs r WHERE r.company_id = $1::uuid`, [companyId]);
  await client.unsafe(`INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, stream, message, created_at)
    SELECT r.company_id, r.id, r.agent_id, s,
      CASE WHEN s % 10 = 1 THEN 'lifecycle' ELSE 'item.completed' END,
      CASE WHEN s % 10 = 1 THEN 'system' ELSE 'stdout' END,
      CASE WHEN s % 10 = 1 THEN 'Run step ' || s ELSE md5(r.n::text || ':' || s) || md5(s::text) END,
      timestamptz '2026-10-01' + r.n * interval '1 second' + s * interval '1 millisecond'
    FROM bench_runs r CROSS JOIN generate_series(1, $2::int) s
    WHERE r.company_id = $1::uuid ORDER BY r.n / 20, s, r.n`, [companyId, eventsPerRun]);
  // Retry-exhaustion receipts on 1 in 23 runs (most are not failed) plus an output decoy.
  await client.unsafe(`INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, stream, message, created_at)
    SELECT r.company_id, r.id, r.agent_id, $2::int + x.k, x.event_type, 'system', x.message, now()
    FROM bench_runs r CROSS JOIN LATERAL (VALUES
      (1, 'lifecycle', 'Bounded retry exhausted after 3 scheduled attempts'),
      (2, 'stdout', 'Bounded retry exhausted quoted in output')) AS x(k, event_type, message)
    WHERE r.company_id = $1::uuid AND (r.n % 23 = 0 OR (x.k = 2 AND r.n % 10 = 0))`, [companyId, eventsPerRun]);
  // Decisions on 1 in 6 issues; a third are open.
  await client.unsafe(`INSERT INTO decisions (company_id, origin_agent_id, origin_issue_id, origin_run_id, title, body, options, status, expires_at, signed_spec, target_snapshots, updated_at)
    SELECT r.company_id, r.agent_id, r.issue_id, r.id, 'Decision', 'Choose', '[]'::jsonb,
      CASE WHEN r.n % 3 = 0 THEN 'open' ELSE 'resolved' END, timestamptz '2026-12-01', 'fixture', '{}'::jsonb,
      timestamptz '2026-10-01' + r.n * interval '1 second'
    FROM bench_runs r WHERE r.company_id = $1::uuid AND r.n % 6 = 0 AND r.n <= $2::int`, [companyId, issuesN]);
  // Thread interactions on 1 in 4 issues; 15% pending, a few addressed to a user.
  await client.unsafe(`INSERT INTO issue_thread_interactions (company_id, issue_id, kind, status, addressee_user_id, payload, updated_at)
    SELECT i.company_id, i.id, 'ask_user_questions', CASE WHEN i.n % 7 = 0 THEN 'pending' ELSE 'answered' END,
      CASE WHEN i.n % 21 = 0 THEN 'board' END, '{"version":1,"questions":[]}'::jsonb, timestamptz '2026-10-01' + i.n * interval '1 second'
    FROM bench_issues i WHERE i.company_id = $1::uuid AND i.n % 4 = 0`, [companyId]);
  // Recovery actions on 1 in 8 issues; a fifth active and human-owned.
  await client.unsafe(`INSERT INTO issue_recovery_actions (company_id, source_issue_id, kind, status, owner_type, cause, fingerprint, next_action, updated_at)
    SELECT i.company_id, i.id, 'execution', CASE WHEN i.n % 5 = 0 THEN 'active' ELSE 'resolved' END,
      CASE WHEN i.n % 3 = 0 THEN 'agent' ELSE 'board' END, 'fixture', 'fp-' || i.n, 'Choose', timestamptz '2026-10-01' + i.n * interval '1 second'
    FROM bench_issues i WHERE i.company_id = $1::uuid AND i.n % 8 = 0`, [companyId]);
  // Retention state for about a third of the candidates: kept, archived, or plain.
  await client.unsafe(`INSERT INTO decision_retention (company_id, source_kind, source_id, source_activity_at, keep, archived_at)
    SELECT company_id, kind, id, now(), n % 3 = 0, CASE WHEN n % 3 = 1 THEN now() END FROM (
      SELECT company_id, 'review' AS kind, id::text AS id, row_number() OVER () AS n FROM issues WHERE company_id = $1::uuid AND status = 'in_review'
      UNION ALL SELECT company_id, 'failed_run', id::text, row_number() OVER () FROM heartbeat_runs WHERE company_id = $1::uuid AND status = 'failed'
      UNION ALL SELECT company_id, 'decision', id::text, row_number() OVER () FROM decisions WHERE company_id = $1::uuid AND status = 'open'
    ) x WHERE n % 2 = 0`, [companyId]);
}

const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
    minMs: Math.round(sorted[0] * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
};

try {
  database = await startEmbeddedPostgresTestDatabase("attention-retention-candidates-benchmark-");
  db = createDb(database.connectionString);
  const client = db.$client;
  const mainCompany = randomUUID();
  const seedStart = performance.now();
  await seedCompany(client, mainCompany, "BENCH", 1);
  for (let index = 1; index < companyCount; index++) await seedCompany(client, randomUUID(), `DEC${index}`, 0.2);
  await client.unsafe(`DROP TABLE bench_runs; DROP TABLE bench_issues`);
  await client.unsafe("VACUUM ANALYZE");
  const seedMs = performance.now() - seedStart;
  const [{ server_version: version }] = await client.unsafe("SHOW server_version");
  const [counts] = await client.unsafe(`SELECT (SELECT count(*) FROM issues)::int AS issues, (SELECT count(*) FROM heartbeat_runs)::int AS runs,
    (SELECT count(*) FROM heartbeat_run_events)::int AS events, (SELECT count(*) FROM decisions)::int AS decisions,
    (SELECT count(*) FROM issue_thread_interactions)::int AS interactions, (SELECT count(*) FROM issue_recovery_actions)::int AS recoveries,
    (SELECT count(*) FROM decision_retention)::int AS retention`);

  // Capture the candidate SQL that each service version issues for a scope.
  await fs.writeFile(baselineFile, git("show", `${baselineSha}:${servicePath}`));
  const captured: Query[] = [];
  const capture = createDb(database.connectionString, { maxConnections: 1 });
  capture.$client.options.debug = (_connection: number, query: string, parameters: unknown[]) => {
    if (query.includes("with source_candidates")) captured.push({ sql: query, params: [...parameters] });
  };
  const failedRun = (await client.unsafe(`SELECT r.id::text AS id FROM heartbeat_runs r WHERE r.company_id = $1::uuid AND r.status = 'failed'
    AND EXISTS (SELECT 1 FROM heartbeat_run_events e WHERE e.run_id = r.id AND e.event_type = 'lifecycle' AND e.message LIKE 'Bounded retry exhausted%')
    ORDER BY r.id LIMIT 1`, [mainCompany]))[0].id as string;
  const blockedIssues = (await client.unsafe(`SELECT id::text AS id FROM issues WHERE company_id = $1::uuid AND status = 'blocked' ORDER BY id LIMIT 3`, [mainCompany]))
    .map((row) => row.id as string);
  const scenarios: Array<{ name: string; scope: Scope; page?: number }> = [
    { name: "company page 1", scope: { companyId: mainCompany } },
    { name: "company page 2", scope: { companyId: mainCompany }, page: 2 },
    { name: "company issue scope", scope: { companyId: mainCompany, issueIds: blockedIssues } },
    { name: "single source (check)", scope: { companyId: mainCompany, sourceKind: "failed_run", sourceId: failedRun } },
    { name: "company failed runs", scope: { companyId: mainCompany, sourceKind: "failed_run" } },
    { name: "all companies page 1", scope: {} },
  ];
  async function queriesFor(modulePath: string) {
    const module = await import(modulePath);
    const result: Query[] = [];
    for (const scenario of scenarios) {
      const service = module.attentionRetentionService(capture);
      for (let page = 1; page <= (scenario.page ?? 1); page++) {
        captured.length = 0;
        await service.load(scenario.scope);
      }
      assert.ok(captured[0], `no candidate query captured for ${scenario.name}`);
      result.push(captured[0]);
    }
    return result;
  }
  const baselineQueries = await queriesFor(baselineFile);
  const treatmentQueries = await queriesFor(fileURLToPath(new URL(`../${servicePath}`, import.meta.url)));
  await fs.rm(baselineFile, { force: true });
  await capture.$client.end({ timeout: 0 });

  // One connection, so the plan_cache_mode setting applies to every sample.
  // Named prepared statements, as the server uses by default: samples reuse
  // the parsed statement and its cached plan, like a busy server.
  timer = createDb(database.connectionString, { maxConnections: 1, prepare: true }).$client;
  timer.options.onnotice = () => {};
  const timeOnce = async (query: Query) => {
    const start = performance.now();
    const rows = await timer!.unsafe(query.sql, query.params as never[], { prepare: true }).values();
    return { ms: performance.now() - start, rows };
  };
  const plan = async (query: Query) => {
    const [row] = await timer!.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
    const root = (row["QUERY PLAN"] as Array<Record<string, any>>)[0];
    return { executionMs: Math.round(root["Execution Time"] * 100) / 100,
      sharedBlocks: root.Plan["Shared Hit Blocks"] + root.Plan["Shared Read Blocks"], plan: process.argv.includes("--plans") ? root.Plan : undefined };
  };
  const report: Record<string, unknown>[] = [];
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await timer.unsafe(`SET plan_cache_mode = ${mode}`);
    for (const [index, scenario] of scenarios.entries()) {
      const baseline = baselineQueries[index], treatment = treatmentQueries[index];
      const before: number[] = [], after: number[] = [];
      let rows = 0;
      for (let warm = 0; warm < 2; warm++) { await timeOnce(baseline); await timeOnce(treatment); }
      const prepared = await timer.unsafe(`SELECT count(*)::int AS n FROM pg_prepared_statements WHERE statement IN ($1, $2)`, [baseline.sql, treatment.sql]);
      assert.equal(prepared[0].n, 2, `${scenario.name}: both queries must run as prepared statements`);
      // Alternate the order in each round to expose cache bias.
      for (let sample = 0; sample < sampleCount; sample++) {
        const order = sample % 2 === 0 ? [baseline, treatment] : [treatment, baseline];
        const results = [];
        for (const query of order) results.push(await timeOnce(query));
        const [b, t] = sample % 2 === 0 ? results : [results[1], results[0]];
        assert.deepEqual(t.rows, b.rows, `${scenario.name}: rows differ`);
        rows = b.rows.length;
        before.push(b.ms); after.push(t.ms);
      }
      const beforeStats = stats(before), afterStats = stats(after);
      report.push({ mode, scenario: scenario.name, rows, before: beforeStats, after: afterStats,
        speedup: Math.round(beforeStats.medianMs / afterStats.medianMs * 10) / 10,
        explainBefore: await plan(baseline), explainAfter: await plan(treatment) });
    }
  }
  console.log(JSON.stringify({ baselineSha, revision, postgresVersion: version, fixture: { companies: companyCount, ...counts,
    seedMs: Math.round(seedMs) }, samples: sampleCount, report }, null, 2));
} finally {
  try {
    await fs.rm(baselineFile, { force: true });
    await timer?.end({ timeout: 0 });
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  } finally { clearInterval(keepAlive); }
}
