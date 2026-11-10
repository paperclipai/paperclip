// Local SQL benchmark for the task page "Created from this task" list
// (GET /api/companies/:id/issues?createdFromIssueId=…&includeRoutineExecutions=true,
// which the UI pages with sortField=id, sortDir=asc and limit=500).
//
//   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-created-from-issues.ts \
//     --baseline-ref=<pre-fix commit> [--issues=30000] [--runs=60000] [--samples=9]
//     [--evidence-dir=<dir>]
//
// Seeds one disposable embedded-PostgreSQL company with tens of thousands of
// tasks: about a third with a recorded origin task, a third with only a legacy
// origin run, and a third manual. Runs carry a realistic context snapshot and
// every agent-created task has creation activity. The source task has
// created tasks through each of the three provenance paths, plus decoys.
// The script runs the baseline (from --baseline-ref) and the working-tree
// `issueService.list` with the route's filters, for several source tasks,
// asserts identical complete row payloads, and reports alternating timings and
// EXPLAIN (ANALYZE, BUFFERS) of the list statement.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, applyPendingMigrations, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { issueService, type IssueFilters } from "../server/src/services/issues.js";
import { issueReadSqlCondition } from "../server/src/services/authorization.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const git = (args: string[]) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const baselineRef = arg("baseline-ref");
assert.ok(baselineRef, "Pass a pinned pre-fix --baseline-ref=<commit>");
const baselineRevision = git(["rev-parse", `${baselineRef}^{commit}`]).trim();
const issueCount = Number(arg("issues") ?? 30000);
const runCount = Number(arg("runs") ?? 60000);
const samples = Number(arg("samples") ?? 9);
const evidenceDir = arg("evidence-dir");

// Baseline modules: the created-from condition and the list that embeds it.
// Every other dependency is held constant at the working tree.
const modulePaths = ["server/src/services/issues.ts", "server/src/services/issue-creation-origin.ts"];
const baselineDir = await fs.mkdtemp(path.join(repositoryRoot, "server/scripts/.created-from-baseline-"));
for (const modulePath of modulePaths) {
  const source = git(["show", `${baselineRevision}:${modulePath}`]).replace(/from "(\.{1,2}\/[^"]+)"/g, (_m, specifier: string) => {
    const resolved = fileURLToPath(new URL(specifier, pathToFileURL(path.join(repositoryRoot, modulePath))));
    return `from ${JSON.stringify(resolved.endsWith("/services/issue-creation-origin.js") ? path.join(baselineDir, "issue-creation-origin.ts") : resolved)}`;
  });
  await fs.writeFile(path.join(baselineDir, path.basename(modulePath)), source);
}
const baseline = await import(pathToFileURL(path.join(baselineDir, "issues.ts")).href) as typeof import("../server/src/services/issues.js");

type Captured = { sql: string; params: unknown[] };
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
const keepAlive = setInterval(() => {}, 1000);
try {
  database = await startEmbeddedPostgresTestDatabase("created-from-benchmark-");
  await applyPendingMigrations(database.connectionString);
  db = createDb(database.connectionString, { maxConnections: 8 });
  const client = db.$client as any;
  let capture: Captured[] | null = null;
  const unsafe = client.unsafe.bind(client);
  client.unsafe = (query: string, params?: unknown[], options?: unknown) => {
    if (capture && /^\s*(select|with)\b/i.test(query)) capture.push({ sql: query, params: params ?? [] });
    return unsafe(query, params, options);
  };
  await client.unsafe("set client_min_messages = warning");
  const [settings] = await client.unsafe("select version(), current_setting('shared_buffers') shared_buffers, current_setting('work_mem') work_mem, current_setting('jit') jit");

  const seedStart = performance.now();
  const companyId = randomUUID(), otherCompanyId = randomUUID();
  await client.unsafe(`insert into companies(id,name,issue_prefix) values($1,'Synthetic Origin','ORG'),($2,'Synthetic Other','OTH')`, [companyId, otherCompanyId]);
  const agentIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const agentId of agentIds) await client.unsafe(`insert into agents(id,company_id,name,adapter_type,status) values($1,$2,$3,'process','active')`, [agentId, companyId, `Agent ${agentId.slice(0, 8)}`]);
  const otherAgentId = randomUUID();
  await client.unsafe(`insert into agents(id,company_id,name,adapter_type,status) values($1,$2,'Other','process','active')`, [otherAgentId, otherCompanyId]);
  await client.unsafe(`create or replace function bench_h(n int, salt text) returns int language sql immutable as $$ select abs(hashtext(n::text || salt)) % 100 $$`);
  // Tasks first (no origins), then runs on those tasks, then origins.
  await client.unsafe(`insert into issues(id,company_id,title,description,status,identifier,issue_number,created_by_agent_id,origin_kind,created_at,updated_at)
    select gen_random_uuid(),$1::uuid,'Synthetic '||n,repeat('Task description. ',40),
      case when bench_h(n,'s')<55 then 'done' when bench_h(n,'s')<62 then 'cancelled' when bench_h(n,'s')<72 then 'backlog'
           when bench_h(n,'s')<84 then 'todo' when bench_h(n,'s')<92 then 'in_progress' when bench_h(n,'s')<96 then 'in_review' else 'blocked' end,
      'ORG-'||n,n,
      case when bench_h(n,'o')<70 then ($2::uuid[])[1+n%3] else null end,
      case when n%41=0 then 'routine_execution' else 'manual' end,
      '2026-01-01'::timestamptz+n*interval '1 minute','2026-01-01'::timestamptz+n*interval '1 minute'
    from generate_series(1,$3::int) n`, [companyId, agentIds, issueCount]);
  await client.unsafe(`insert into issues(company_id,title,status,identifier,issue_number)
    select $1::uuid,'Other '||n,'todo','OTH-'||n,n from generate_series(1,$2::int) n`, [otherCompanyId, Math.round(issueCount / 3)]);
  await client.unsafe(`create table bench_fixture_issues as select id, issue_number n, identifier from issues where company_id=$1`, [companyId]);
  await client.unsafe(`create unique index on bench_fixture_issues(n)`);
  // Runs: legacy context snapshots (issueId / taskId / taskKey) and native runs,
  // with a wide snapshot like real wakes.
  await client.unsafe(`insert into heartbeat_runs(id,company_id,agent_id,status,runtime_mode,native_issue_id,context_snapshot,created_at)
    select gen_random_uuid(),$1::uuid,($2::uuid[])[1+g%3],'succeeded',
      case when g%4=0 then 'native' else 'legacy' end,
      case when g%4=0 then f.id else null end,
      jsonb_build_object(
        case when g%7=0 then 'taskKey' when g%5=0 then 'taskId' else 'issueId' end,
        case when g%7=0 then f.identifier else f.id::text end,
        'wakeReason','issue_assigned','source','assignment','prompt',repeat('context ',120)),
      '2026-01-01'::timestamptz+g*interval '30 seconds'
    from generate_series(1,$3::int) g join bench_fixture_issues f on f.n = 1 + (g * 7919) % $4::int`, [companyId, agentIds, runCount, issueCount]);
  await client.unsafe(`insert into heartbeat_runs(company_id,agent_id,status,context_snapshot)
    select $1::uuid,$2::uuid,'succeeded',jsonb_build_object('issueId',gen_random_uuid()::text) from generate_series(1,$3::int)`, [otherCompanyId, otherAgentId, Math.round(runCount / 3)]);
  // Origins for agent-created tasks: an earlier task (recorded) or a run (legacy).
  await client.unsafe(`update issues i set
      origin_issue_id = case when bench_h(f.n,'p')<50 then p.id else null end,
      origin_run_id = (select r.id::text from heartbeat_runs r where r.company_id=$1 and r.created_at <= '2026-01-01'::timestamptz+f.n*interval '1 minute' order by r.created_at desc limit 1)
    from bench_fixture_issues f join bench_fixture_issues p on p.n = greatest(1, f.n - 1 - (f.n * 31) % 500)
    where i.id=f.id and i.created_by_agent_id is not null and f.n > 1`, [companyId]);
  // Creation activity for every agent-created task, plus ordinary activity.
  await client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,run_id,details,created_at)
    select $1::uuid,'issue',i.id::text,'agent',i.created_by_agent_id::text,
      case when i.parent_id is null then 'issue.created' else 'issue.child_created' end,
      case when i.origin_run_id is not null then i.origin_run_id::uuid else null end,'{}'::jsonb,i.created_at
    from issues i where i.company_id=$1 and i.created_by_agent_id is not null`, [companyId]);
  await client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
    select $1::uuid,'issue',f.id::text,'agent',($2::uuid[])[1+k%3]::text,
      case when k%2=0 then 'issue.updated' else 'issue.comment_added' end,'{"status":"todo"}'::jsonb,
      '2026-01-20'::timestamptz+(f.n*8+k)*interval '1 second'
    from bench_fixture_issues f cross join generate_series(0,7) k`, [companyId, agentIds]);

  // The source tasks: a busy one with every provenance path, and a quiet one
  // with only recorded origins.
  const [busy] = await client.unsafe(`select id, identifier from bench_fixture_issues where n = $1`, [Math.floor(issueCount / 2)]);
  const [quiet] = await client.unsafe(`select id from bench_fixture_issues where n = $1`, [Math.floor(issueCount / 3)]);
  const sourceRuns: string[] = [];
  for (let k = 0; k < 30; k++) {
    const runId = randomUUID();
    sourceRuns.push(runId);
    await client.unsafe(`insert into heartbeat_runs(id,company_id,agent_id,status,runtime_mode,native_issue_id,context_snapshot)
      values($1,$2,$3,'succeeded',$4,$5,$6::jsonb)`, [runId, companyId, agentIds[k % 3], k % 3 === 0 ? "native" : "legacy", k % 3 === 0 ? busy.id : null,
      JSON.stringify(k % 3 === 1 ? { taskKey: busy.identifier, prompt: "x".repeat(800) } : { issueId: busy.id, prompt: "x".repeat(800) })]);
  }
  const pick = async (limit: number, offset: number) => (await client.unsafe(
    `select id from bench_fixture_issues where n > 100 order by n limit $1 offset $2`, [limit, offset])).map((row: { id: string }) => row.id);
  const recorded = await pick(40, 0);
  await client.unsafe(`update issues set origin_issue_id=$1 where id = any($2::uuid[])`, [busy.id, recorded]);
  const legacyRun = await pick(15, 40);
  await client.unsafe(`update issues set origin_issue_id=null, origin_run_id=$1 where id = any($2::uuid[])`, [sourceRuns[1], legacyRun]);
  const activityOnly = await pick(8, 55);
  await client.unsafe(`update issues set origin_issue_id=null, origin_run_id=null where id = any($1::uuid[])`, [activityOnly]);
  await client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,run_id)
    select $1::uuid,'issue',id::text,'agent','agent','issue.child_created',$2::uuid from unnest($3::uuid[]) id`, [companyId, sourceRuns[2], activityOnly]);
  // Decoys: a recorded origin elsewhere wins over a source run; a source-run
  // comment is not creation; another task's run.
  const decoys = await pick(6, 70);
  await client.unsafe(`update issues set origin_issue_id=$1, origin_run_id=$2 where id = any($3::uuid[])`, [quiet.id, sourceRuns[3], decoys.slice(0, 3)]);
  await client.unsafe(`update issues set origin_issue_id=null, origin_run_id=null where id = any($1::uuid[])`, [decoys.slice(3)]);
  await client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,run_id)
    select $1::uuid,'issue',id::text,'agent','agent','issue.comment_added',$2::uuid from unnest($3::uuid[]) id`, [companyId, sourceRuns[4], decoys.slice(3)]);
  await client.unsafe("ANALYZE");
  const [counts] = await client.unsafe(`select
    (select count(*)::int from issues where company_id=$1) issues,
    (select count(*)::int from issues where company_id=$1 and origin_issue_id is not null) recorded_origin,
    (select count(*)::int from issues where company_id=$1 and origin_issue_id is null and origin_run_id is not null) legacy_run_origin,
    (select count(*)::int from heartbeat_runs where company_id=$1) runs,
    (select count(*)::int from activity_log where company_id=$1) activity,
    (select pg_size_pretty(pg_total_relation_size('heartbeat_runs'))) runs_size,
    (select pg_size_pretty(pg_total_relation_size('issues'))) issues_size`, [companyId]);
  const fixtureMs = performance.now() - seedStart;

  const readCondition = await issueReadSqlCondition(db, { type: "board", source: "session", userId: "board-user", isInstanceAdmin: true } as never);
  // The UI's listAll page: route filters with sortField=id, asc, limit 500.
  const filtersFor = (sourceIssueId: string): IssueFilters => ({
    readCondition, createdFromIssueId: sourceIssueId, includeRoutineExecutions: true,
    sortField: "id", sortDir: "asc", limit: 500,
  });
  const cases = { busy: busy.id as string, quiet: quiet.id as string };
  const arms = { baseline: baseline.issueService(db), treatment: issueService(db) };
  const results: Record<string, unknown> = {};
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(2)), minMs: Number(sorted[0]!.toFixed(2)),
      maxMs: Number(sorted[sorted.length - 1]!.toFixed(2)), samplesMs: values.map((value) => Number(value.toFixed(2))) };
  };
  for (const [name, sourceIssueId] of Object.entries(cases)) {
    const filters = filtersFor(sourceIssueId);
    const times = { baseline: [] as number[], treatment: [] as number[] };
    let reference: unknown;
    for (let iteration = -2; iteration < samples; iteration++) {
      for (const arm of (iteration % 2 === 0 ? ["baseline", "treatment"] : ["treatment", "baseline"]) as Array<keyof typeof arms>) {
        const started = performance.now();
        const rows = await arms[arm].list(companyId, filters);
        const elapsed = performance.now() - started;
        if (iteration >= 0) times[arm].push(elapsed);
        const serialized = JSON.parse(JSON.stringify(rows));
        if (reference === undefined) reference = serialized;
        else assert.deepEqual(serialized, reference, `${name}/${arm}: complete row payloads must match`);
      }
    }
    const resultIds = new Set((reference as Array<{ id: string }>).map((row) => row.id));
    if (name === "busy") {
      for (const id of [...recorded, ...legacyRun, ...activityOnly]) assert.ok(resultIds.has(id), `busy source must list ${id}`);
      for (const id of decoys) assert.ok(!resultIds.has(id), `busy source must not list decoy ${id}`);
    }
    const plans: Record<string, unknown> = {};
    for (const arm of ["baseline", "treatment"] as const) {
      capture = [];
      await arms[arm].list(companyId, filters);
      const listStatement = capture.find((query) => /"creation_source_issue"/.test(query.sql));
      capture = null;
      assert.ok(listStatement, `${arm}: list statement captured`);
      const [row] = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${listStatement.sql}`, listStatement.params);
      const plan = row["QUERY PLAN"][0];
      plans[arm] = { executionMs: plan["Execution Time"], planningMs: plan["Planning Time"],
        sharedBuffers: plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"], plan };
    }
    results[name] = {
      resultRows: resultIds.size,
      baseline: stats(times.baseline), treatment: stats(times.treatment),
      speedup: Number((stats(times.baseline).medianMs / stats(times.treatment).medianMs).toFixed(1)),
      listStatement: Object.fromEntries(Object.entries(plans).map(([arm, value]) => {
        const { executionMs, planningMs, sharedBuffers } = value as { executionMs: number; planningMs: number; sharedBuffers: number };
        return [arm, { executionMs, planningMs, sharedBuffers }];
      })),
    };
    if (evidenceDir) {
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(path.join(evidenceDir, `plans-${name}.json`), JSON.stringify(plans, null, 2));
    }
  }
  const report = {
    baselineRevision, treatmentRevision: git(["rev-parse", "HEAD"]).trim(), treatmentDirty: git(["status", "--porcelain", "--", ...modulePaths]).trim() !== "",
    settings, fixture: { ...counts, fixtureMs: Math.round(fixtureMs) }, cases: results,
  };
  if (evidenceDir) await fs.writeFile(path.join(evidenceDir, "summary.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db?.$client.end({ timeout: 0 });
  await database?.cleanup();
  await fs.rm(baselineDir, { recursive: true, force: true });
  clearInterval(keepAlive);
}
