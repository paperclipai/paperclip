// Fresh-continuation scheduler queries on a staging-shaped fixture: the
// disposition worker's deadline (`nextFreshContinuationCheckAt`), its backlog
// listing (`heldExecutionsAwaitingFreshContinuation`) and the left-alone count.
// Compares a baseline revision with the working tree on identical data and
// fails on any difference in complete positional rows.
//
//   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-fresh-continuation-deadline.ts \
//     --baseline-ref=<sha> [--context-kib=60] [--samples=7] [--warmups=2] [--print-plans]
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXECUTION_RECONCILIATION_CAUSES } from "../packages/shared/src/index.js";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import * as treatment from "../server/src/services/fresh-continuation-fallback.js";

type Query = { sql: string; params: unknown[] };
const arg = (name: string, fallback: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${arg("baseline-ref", "origin/master")}^{commit}`], { encoding: "utf8" }).trim();
const contextKib = Number(arg("context-kib", "60"));
const sampleCount = Number(arg("samples", "7"));
const warmupCount = Number(arg("warmups", "2"));
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let baselineDir: string | undefined;
let db: Db | undefined;
try {
  database = await startEmbeddedPostgresTestDatabase("fresh-continuation-deadline-benchmark-");
  db = createDb(database.connectionString);
  const sqlClient = db.$client;
  baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".fresh-continuation-baseline-"));
  const modulePath = "server/src/services/fresh-continuation-fallback.ts";
  const original = new URL(`../${modulePath}`, import.meta.url);
  const source = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
  const baselineFile = path.join(baselineDir, "fresh-continuation-fallback.ts");
  await fs.writeFile(baselineFile, source.replace(/from "(\.{1,2}\/[^"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, original)))}`));
  const baseline = await import(pathToFileURL(baselineFile).href) as typeof treatment;

  // Staging shape (2026-11-14): 5.7k issues, 31.4k runs whose rows carry wide
  // context JSON (1.96 GB), 75k recovery records of which ~280 carry a
  // fresh-continuation check deadline.
  const now = new Date(Date.UTC(2026, 10, 14, 5, 0, 0));
  const nowMs = now.getTime();
  const companyId = randomUUID(), decoyCompanyId = randomUUID();
  const agentIds = [randomUUID(), randomUUID(), randomUUID()];
  const fillerSeed = randomBytes(Math.ceil(contextKib * 1024 * 0.75)).toString("base64");
  const started = performance.now();
  await sqlClient.unsafe(`insert into companies (id, name, issue_prefix) values ($1, 'Synthetic', 'FCD'), ($2, 'Decoy', 'FCX')`,
    [companyId, decoyCompanyId]);
  await sqlClient.unsafe(`insert into agents (id, company_id, name, adapter_type)
    select id, $4::uuid, 'Agent ' || n, 'codex_local' from unnest(array[$1, $2, $3]::uuid[]) with ordinality as a(id, n)`,
    [...agentIds, companyId]);
  const decoyAgentId = randomUUID();
  await sqlClient.unsafe(`insert into agents (id, company_id, name, adapter_type) values ($1, $2, 'Decoy', 'codex_local')`, [decoyAgentId, decoyCompanyId]);
  // Issues: 5,400 in the company (60% done), 269 decoys in another company.
  await sqlClient.unsafe(`create temporary table fixture_issue as
    select n, gen_random_uuid() as id, case when n <= 5400 then $1::uuid else $2::uuid end as company_id,
      case when n > 5400 then $3::uuid else (array[$4, $5, $6]::uuid[])[1 + n % 3] end as agent_id,
      case when n % 10 < 6 then 'done' when n % 10 = 6 then 'blocked' when n % 10 = 7 then 'in_progress' else 'todo' end as status
    from generate_series(1, 5669) n`, [companyId, decoyCompanyId, decoyAgentId, ...agentIds]);
  await sqlClient.unsafe(`insert into issues (id, company_id, title, status, assignee_agent_id)
    select id, company_id, 'Fixture task ' || n, status, agent_id from fixture_issue`);
  // Runs: 31,399, about five per task, linked by native id, legacy issue id, or context only.
  await sqlClient.unsafe(`insert into heartbeat_runs (company_id, agent_id, scope_kind, issue_id, native_issue_id, runtime_mode,
      status, error_code, started_at, finished_at, created_at, updated_at, context_snapshot)
    select i.company_id, i.agent_id, case when g.n % 5 = 4 then 'company' else 'issue' end,
      case when g.n % 5 = 4 then null else i.id end, case when g.n % 5 < 2 then i.id end,
      case when g.n % 5 < 2 then 'native' else 'legacy' end,
      case when g.n % 7 = 0 then 'failed' when g.n % 11 = 0 then 'cancelled' else 'succeeded' end,
      case when g.n % 7 = 0 then 'adapter_failed' end,
      $2::timestamptz - (g.n || ' minutes')::interval, $2::timestamptz - (g.n || ' minutes')::interval + interval '30 seconds',
      $2::timestamptz - (g.n || ' minutes')::interval - interval '1 second', $2::timestamptz - (g.n || ' minutes')::interval,
      jsonb_build_object('issueId', i.id::text, 'wakeReason', 'issue_assigned', 'prompt', $1::text)
    from generate_series(1, 31_000) g(n) join fixture_issue i on i.n = 1 + g.n % 5669`, [fillerSeed, now.toISOString()]);

  // Held records with a check deadline (282), in the shapes the predicate distinguishes.
  type Held = { issueN: number; runId: string; evidence: Record<string, unknown>; status: string; ownerUserId?: string;
    cause?: string; recentRun: boolean; errorCode: string; newer?: "native" | "legacy" | "context" | "cancelled_at_dispatch" | "live" };
  const heldRows: Held[] = [];
  let issueN = 7;
  const nextOpenIssue = () => { do issueN += 1; while (issueN % 10 < 6 || issueN > 5400); return issueN; };
  for (let n = 0; n < 282; n += 1) {
    const runId = randomUUID();
    // A third are overdue, so the backlog listing has due work too.
    const check = { kind: "exact_recovery_pending", nextCheckAt: nowMs + (n % 3 === 0 ? -1 : 1) * (n + 1) * 1_000, checks: 1 };
    const kind = n % 12;
    const base = { runId, automaticRecovery: { replay: "blocked" }, freshContinuationCheck: check };
    heldRows.push({
      issueN: nextOpenIssue(), runId,
      evidence: kind === 1 ? { sourceRunId: runId, automaticRecovery: { replay: "blocked" }, freshContinuationCheck: check }
        : kind === 2 ? { ...base, runId: runId.toUpperCase() }
        : kind === 3 ? { ...base, runId: "not-a-run" }
        : base,
      status: kind === 4 ? "active" : "resolved",
      ownerUserId: kind === 5 ? "user-1" : undefined,
      recentRun: kind !== 6 && kind !== 4,
      errorCode: kind === 7 ? "adapter_failed" : "process_lost",
      newer: kind === 8 ? (["native", "legacy", "context"] as const)[n % 3] : kind === 9 ? "cancelled_at_dispatch" : kind === 10 ? "live" : undefined,
    });
  }
  const runsSql: unknown[][] = [];
  for (const held of heldRows) {
    const finished = new Date(nowMs - (held.recentRun ? 2 : 48) * 3_600_000);
    runsSql.push([held.runId, held.issueN, held.errorCode, finished.toISOString(), new Date(finished.getTime() - 600_000).toISOString(), null]);
    if (held.newer) runsSql.push([randomUUID(), held.issueN, held.newer, finished.toISOString(),
      new Date(finished.getTime() + 60_000).toISOString(), held.newer]);
  }
  await sqlClient.unsafe(`insert into heartbeat_runs (id, company_id, agent_id, scope_kind, issue_id, native_issue_id, runtime_mode,
      status, error_code, started_at, finished_at, created_at, updated_at, context_snapshot)
    select r.id, i.company_id, i.agent_id, case when r.link = 'context' then 'company' else 'issue' end,
      case when r.link in ('context', 'native') then null else i.id end, case when r.link = 'native' then i.id end,
      case when r.link = 'native' then 'native' else 'legacy' end,
      case when r.link = 'live' then 'queued' when r.link = 'cancelled_at_dispatch' then 'cancelled'
        when r.link is null then 'failed' else 'succeeded' end,
      case when r.link = 'cancelled_at_dispatch' then 'execution_reconciliation_required' when r.link is null then r.code end,
      case when r.link is null then r.created_at end, case when r.link is null then r.finished_at end, r.created_at, r.created_at,
      jsonb_build_object('issueId', i.id::text, 'wakeReason', 'issue_assigned', 'prompt', $2::text)
    from jsonb_to_recordset($1::jsonb) as r(id uuid, issue_n int, code text, finished_at timestamptz, created_at timestamptz, link text)
    join fixture_issue i on i.n = r.issue_n`,
  [JSON.stringify(runsSql.map(([id, issue_n, code, finished_at, created_at, link]) => ({ id, issue_n, code, finished_at, created_at, link }))), fillerSeed]);
  await sqlClient.unsafe(`insert into issue_recovery_actions (company_id, source_issue_id, kind, status, owner_type, owner_user_id,
      cause, fingerprint, evidence, next_action)
    select i.company_id, i.id, 'active_run_watchdog', h.status, 'board', h.owner_user_id, 'legacy_execution_requires_reconciliation',
      'held:' || h.ord, h.evidence, 'Fixture'
    from jsonb_to_recordset($1::jsonb) as h(ord int, issue_n int, status text, owner_user_id text, evidence jsonb)
    join fixture_issue i on i.n = h.issue_n`,
  [JSON.stringify(heldRows.map((held, ord) => ({ ord, issue_n: held.issueN, status: held.status, owner_user_id: held.ownerUserId ?? null,
    evidence: held.evidence })))]);
  // Historical records (75,003): held-shaped records without a deadline on
  // finished tasks, settled continuations, and records of other causes.
  await sqlClient.unsafe(`insert into issue_recovery_actions (company_id, source_issue_id, kind, status, owner_type, cause,
      fingerprint, evidence, next_action, resolved_at)
    select i.company_id, i.id, case when g.n % 3 = 0 then 'active_run_watchdog' else 'missing_disposition' end, 'resolved', 'agent',
      (case when g.n % 4 = 0 then $1::text[] else array['stranded_assigned_issue', 'missing_disposition'] end)[1 + g.n % 2],
      'history:' || g.n,
      case when g.n % 15 = 0 then jsonb_build_object('runId', r.id::text, 'automaticRecovery', jsonb_build_object('replay', 'blocked'))
        when g.n % 4 = 0 then jsonb_build_object('runId', r.id::text, 'executionReconciliation', jsonb_build_object('runId', r.id::text),
          'freshContinuation', jsonb_build_object('sourceRunId', r.id::text), 'note', repeat('x', 400))
        else jsonb_build_object('runId', r.id::text, 'note', repeat('y', 400)) end,
      'Fixture', $2::timestamptz
    from generate_series(1, 75_003) g(n)
    join fixture_issue i on i.n = 1 + (g.n * 7) % 5669
    join lateral (select id from heartbeat_runs where (issue_id = i.id or native_issue_id = i.id) limit 1) r on true`,
  [[...EXECUTION_RECONCILIATION_CAUSES].slice(0, 2), now.toISOString()]);
  await sqlClient.unsafe("analyze");
  const [sizes] = await sqlClient.unsafe(`select
    (select count(*) from heartbeat_runs)::int as runs, pg_size_pretty(pg_total_relation_size('heartbeat_runs')) as runs_size,
    (select count(*) from issue_recovery_actions)::int as actions, pg_size_pretty(pg_total_relation_size('issue_recovery_actions')) as actions_size,
    (select count(*) from issue_recovery_actions where evidence #>> '{freshContinuationCheck,nextCheckAt}' is not null)::int as with_deadline,
    (select count(*) from issues)::int as issues, current_setting('server_version') as server_version, current_setting('jit') as jit,
    current_setting('shared_buffers') as shared_buffers`);
  const fixtureSeconds = (performance.now() - started) / 1000;

  // Captures the SQL the real service sends, then stops it.
  async function capture(invoke: (captureDb: Db) => Promise<unknown>): Promise<Query> {
    let query: Query | undefined;
    const stop = new Error("captured");
    const captureDb = new Proxy(db!, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const selection = from(...args);
          selection.execute = async () => { query ??= selection.toSQL(); throw stop; };
          return selection;
        }) as typeof builder.from;
        return builder;
      };
    }});
    try { await invoke(captureDb); } catch (error) { if (error !== stop) throw error; }
    assert.ok(query, "no query captured");
    return query;
  }
  const queries = (module: typeof treatment) => ({
    nextCheckAt: () => capture(captureDb => module.nextFreshContinuationCheckAt(captureDb, now)),
    heldListing: async () => module.heldExecutionsAwaitingFreshContinuation(db!, now, 5).toSQL(),
    heldListingProbe: async () => module.heldExecutionsAwaitingFreshContinuation(db!, now, 1).toSQL(),
    leftAloneCount: () => capture(captureDb => { module.resetBacklogContinuationPacingForTests(); return module.continueHeldExecutions(captureDb, now); }),
  });
  async function run(query: Query) {
    const start = performance.now();
    const rows = await sqlClient.unsafe(query.sql, query.params as never[]).values();
    return { ms: performance.now() - start, rows };
  }
  async function plan(query: Query) {
    const [row] = await sqlClient.unsafe(`explain (analyze, buffers, format json) ${query.sql}`, query.params as never[]);
    const root = (row!["QUERY PLAN"] as Array<{ "Execution Time": number; Plan: Record<string, number> }>)[0]!;
    return { executionMs: root["Execution Time"], sharedHit: root.Plan["Shared Hit Blocks"], sharedRead: root.Plan["Shared Read Blocks"] };
  }
  const before = queries(baseline), after = queries(treatment);
  const results = [];
  for (const name of Object.keys(before) as Array<keyof typeof before>) {
    const [baselineQuery, treatmentQuery] = [await before[name](), await after[name]()];
    const baselineSamples: number[] = [], treatmentSamples: number[] = [];
    let baselineRows: unknown[] = [], treatmentRows: unknown[] = [];
    // Warmups each, then alternating timed pairs.
    for (let n = 0; n < warmupCount; n += 1) { await run(baselineQuery); await run(treatmentQuery); }
    for (let n = 0; n < sampleCount; n += 1) {
      const first = n % 2 === 0 ? baselineQuery : treatmentQuery, second = first === baselineQuery ? treatmentQuery : baselineQuery;
      const a = await run(first), b = await run(second);
      const [base, treat] = first === baselineQuery ? [a, b] : [b, a];
      baselineSamples.push(base.ms); treatmentSamples.push(treat.ms);
      baselineRows = base.rows; treatmentRows = treat.rows;
    }
    assert.deepEqual(treatmentRows, baselineRows, `${name}: treatment rows differ from baseline`);
    const median = (samples: number[]) => [...samples].sort((x, y) => x - y)[Math.floor(samples.length / 2)]!;
    results.push({ name, rows: baselineRows.length, firstRow: baselineRows[0] ?? null,
      baselineMedianMs: +median(baselineSamples).toFixed(1), treatmentMedianMs: +median(treatmentSamples).toFixed(1),
      speedup: +(median(baselineSamples) / median(treatmentSamples)).toFixed(1),
      baselineSamplesMs: baselineSamples.map(ms => +ms.toFixed(1)), treatmentSamplesMs: treatmentSamples.map(ms => +ms.toFixed(1)),
      baselinePlan: await plan(baselineQuery), treatmentPlan: await plan(treatmentQuery) });
  }
  if (process.argv.includes("--print-plans")) {
    for (const [label, module] of [["baseline", baseline], ["treatment", treatment]] as const) {
      const query = await queries(module).nextCheckAt();
      const rows = await sqlClient.unsafe(`explain (analyze, buffers) ${query.sql}`, query.params as never[]);
      console.error(`--- ${label} nextFreshContinuationCheckAt plan\n${rows.map(row => row["QUERY PLAN"]).join("\n")}`);
    }
  }
  console.log(JSON.stringify({ baselineRevision, fixture: { ...sizes, contextKib, fixtureSeconds: +fixtureSeconds.toFixed(1) }, results }, null, 2));
} finally {
  try { await db?.$client.end({ timeout: 0 }); await database?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
