// Local SQL benchmark for the Mine inbox list (GET /api/companies/:id/inbox/mine).
//
//   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-inbox-mine.ts \
//     --baseline-ref=<pre-fix commit> [--issues=30000] [--activity-per-issue=12]
//     [--comments-per-issue=6] [--touch-density=1] [--samples=7] [--evidence-dir=<dir>]
//
// Seeds one disposable embedded-PostgreSQL company with tens of thousands of
// issues (most of them `done`), comments, activity, archives, read states,
// pending interactions and live runs, plus a user who touched a few hundred.
// It then runs the baseline (from --baseline-ref) and the working-tree
// `issueService.list` with the exact Mine filters, asserts the complete row
// payloads are identical, and reports median timings and per-query
// EXPLAIN (ANALYZE, BUFFERS) ranked by execution time.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, applyPendingMigrations, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { INBOX_MINE_ISSUE_STATUS_FILTER } from "../packages/shared/src/index.js";
import { issueService, type IssueFilters } from "../server/src/services/issues.js";
import { issueReadSqlCondition } from "../server/src/services/authorization.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const git = (args: string[]) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const baselineRef = arg("baseline-ref");
assert.ok(baselineRef, "Pass a pinned pre-fix --baseline-ref=<commit>");
const baselineRevision = git(["rev-parse", `${baselineRef}^{commit}`]).trim();
const issueCount = Number(arg("issues") ?? 30000);
const samples = Number(arg("samples") ?? 7);
const activityPerIssue = Number(arg("activity-per-issue") ?? 12);
const commentsPerIssue = Number(arg("comments-per-issue") ?? 6);
// Participation density: 1 touches ~1.4k of 30k issues; 10 touches ~11k.
const density = Number(arg("touch-density") ?? 1);
const every = (modulus: number) => Math.max(2, Math.round(modulus / density));
const evidenceDir = arg("evidence-dir");

// Baseline modules: the Mine list SQL lives in these two files. Every other
// dependency is held constant at the working tree.
const modulePaths = ["server/src/services/issues.ts", "server/src/services/issue-participation.ts"];
const baselineDir = await fs.mkdtemp(path.join(repositoryRoot, "server/scripts/.inbox-mine-baseline-"));
for (const modulePath of modulePaths) {
  const source = git(["show", `${baselineRevision}:${modulePath}`]).replace(/from "(\.{1,2}\/[^"]+)"/g, (_m, specifier: string) => {
    const resolved = fileURLToPath(new URL(specifier, pathToFileURL(path.join(repositoryRoot, modulePath))));
    return `from ${JSON.stringify(resolved.endsWith("/services/issue-participation.js") ? path.join(baselineDir, "issue-participation.ts") : resolved)}`;
  });
  await fs.writeFile(path.join(baselineDir, path.basename(modulePath)), source);
}
const baseline = await import(pathToFileURL(path.join(baselineDir, "issues.ts")).href) as typeof import("../server/src/services/issues.js");

type Captured = { sql: string; params: unknown[] };
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
const keepAlive = setInterval(() => {}, 1000);
try {
  database = await startEmbeddedPostgresTestDatabase("inbox-mine-benchmark-");
  await applyPendingMigrations(database.connectionString);
  // A small pool, like the server's: the list issues enrichment reads in parallel.
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

  const companyId = randomUUID(), userId = "synthetic-mine-user", otherUserId = "synthetic-other-human";
  const seedStart = performance.now();
  await client.unsafe(`insert into companies(id,name,issue_prefix) values($1,'Synthetic Mine','MINE')`, [companyId]);
  const agentIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const agentId of agentIds) await client.unsafe(`insert into agents(id,company_id,name,adapter_type,status) values($1,$2,$3,'process','active')`, [agentId, companyId, `Agent ${agentId.slice(0, 8)}`]);
  // h(n, salt) is a deterministic 0..99 bucket so the fixture is reproducible.
  await client.unsafe(`create or replace function bench_h(n int, salt text) returns int language sql immutable as $$ select abs(hashtext(n::text || salt)) % 100 $$`);
  await client.unsafe(`insert into issues(id,company_id,title,status,created_by_user_id,created_by_agent_id,assignee_user_id,origin_kind,hidden_at,harness_kind,completed_at,created_at,updated_at)
    select gen_random_uuid(),$1::uuid,'Synthetic '||n,
      case when bench_h(n,'s')<55 then 'done' when bench_h(n,'s')<60 then 'cancelled' when bench_h(n,'s')<70 then 'backlog'
           when bench_h(n,'s')<82 then 'todo' when bench_h(n,'s')<90 then 'in_progress' when bench_h(n,'s')<95 then 'in_review' else 'blocked' end,
      case when n%${every(75)}=0 then $2 when bench_h(n,'c')<30 then $3 else null end,
      case when n%${every(75)}<>0 and bench_h(n,'c')>=30 then ($4::uuid[])[1+n%3] else null end,
      case when n%${every(311)}=0 then $2 else null end,
      case when n%997=0 then 'plugin:demo:operation' else 'manual' end,
      case when n%1499=0 then '2026-01-01'::timestamptz else null end,
      case when n%1777=0 then 'synthetic' else null end,
      case when bench_h(n,'s')<55 then '2026-01-01'::timestamptz+n*interval '1 second' else null end,
      '2026-01-01'::timestamptz,'2026-01-01'::timestamptz+n*interval '1 second'
    from generate_series(1,$5::int) n`, [companyId, userId, otherUserId, agentIds, issueCount]);
  await client.unsafe(`create table bench_fixture_issues as select id, row_number() over (order by updated_at)::int n, status from issues where company_id=$1`, [companyId]);
  await client.unsafe(`update issues i set parent_id=p.id from bench_fixture_issues c join bench_fixture_issues p on p.n=c.n/2 where i.id=c.id and c.n>100 and bench_h(c.n,'p')<35`);
  // Agent comments on every issue, an outside human on some, and the user's own direct comments.
  await client.unsafe(`insert into issue_comments(company_id,issue_id,author_agent_id,body,created_at)
    select $1::uuid,f.id,($2::uuid[])[1+k%3],'Agent progress '||f.n||'/'||k,'2026-02-01'::timestamptz+(f.n*$3::int+k)*interval '1 second'
    from bench_fixture_issues f cross join generate_series(0,$3::int-1) k`, [companyId, agentIds, commentsPerIssue]);
  await client.unsafe(`insert into issue_comments(company_id,issue_id,author_user_id,body,created_at)
    select $1::uuid,id,$2,'Outside human note','2026-03-01'::timestamptz+n*interval '1 second' from bench_fixture_issues where n%7=0`, [companyId, otherUserId]);
  await client.unsafe(`insert into issue_comments(company_id,issue_id,author_user_id,body,created_at)
    select $1::uuid,id,$2,'My note','2026-01-15'::timestamptz+n*interval '1 second' from bench_fixture_issues where n%${every(97)}=0`, [companyId, userId]);
  // Mention-only: the user is named in a comment but never participated.
  await client.unsafe(`insert into issue_comments(company_id,issue_id,author_user_id,body,created_at)
    select $1::uuid,id,$2,'@synthetic-mine-user can you look?','2026-03-02'::timestamptz+n*interval '1 second' from bench_fixture_issues where n%113=0`, [companyId, otherUserId]);
  await client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
    select $1::uuid,'issue',f.id::text,'agent',($2::uuid[])[1+k%3]::text,
      case when k%2=0 then 'issue.updated' else 'issue.comment_added' end,
      jsonb_build_object('status',f.status,'_previous',jsonb_build_object('status','todo')),
      '2026-01-20'::timestamptz+(f.n*$3::int+k)*interval '1 second'
    from bench_fixture_issues f cross join generate_series(0,$3::int-1) k`, [companyId, agentIds, activityPerIssue]);
  await client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
    select $1::uuid,'issue',id::text,'user',$2,'issue.updated','{}'::jsonb,'2026-01-25'::timestamptz+n*interval '1 second' from bench_fixture_issues where n%${every(89)}=0`, [companyId, userId]);
  // Reads are audited but are not participation.
  await client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
    select $1::uuid,'issue',id::text,'user',$2,'issue.read_marked','{}'::jsonb,'2026-01-26'::timestamptz+n*interval '1 second' from bench_fixture_issues where n%13=0`, [companyId, userId]);
  await client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
    select $1::uuid,'heartbeat_run',gen_random_uuid()::text,'agent',($2::uuid[])[1],'heartbeat.run.created','{}'::jsonb,'2026-01-01'::timestamptz+n*interval '1 second' from generate_series(1,$3::int) n`, [companyId, agentIds, issueCount * 2]);
  // Archives: some stay archived, some are reactivated by later outside comments (n%7=0).
  await client.unsafe(`insert into issue_inbox_archives(company_id,issue_id,user_id,archived_at)
    select $1::uuid,id,$2,'2026-02-15'::timestamptz from bench_fixture_issues where n%3=0 and (n%${every(75)}=0 or n%${every(89)}=0 or n%${every(97)}=0 or n%${every(311)}=0)`, [companyId, userId]);
  await client.unsafe(`insert into issue_read_states(company_id,issue_id,user_id,last_read_at)
    select $1::uuid,id,$2,'2026-02-20'::timestamptz from bench_fixture_issues where n%40=0`, [companyId, userId]);
  await client.unsafe(`insert into issue_thread_interactions(company_id,issue_id,kind,status,addressee_user_id,payload,created_at)
    select $1::uuid,id,'request_confirmation','pending',$2,'{"version":1,"prompt":"Confirm?"}'::jsonb,'2026-03-05'::timestamptz+n*interval '1 second' from bench_fixture_issues where n%503=0`, [companyId, userId]);
  await client.unsafe(`insert into heartbeat_runs(id,company_id,agent_id,status,context_snapshot)
    select gen_random_uuid(),$1::uuid,($2::uuid[])[1+n%3],case when n%2=0 then 'running' else 'queued' end,
      jsonb_build_object('issueId',(select id from bench_fixture_issues where bench_fixture_issues.n=g.n*97))
    from generate_series(1,150) g(n)`, [companyId, agentIds]);
  await client.unsafe(`insert into heartbeat_runs(company_id,agent_id,status) select $1::uuid,($2::uuid[])[1],'succeeded' from generate_series(1,$3::int)`, [companyId, agentIds, issueCount]);
  await client.unsafe("ANALYZE");
  const [counts] = await client.unsafe(`select
    (select count(*)::int from issues where company_id=$1) issues,
    (select count(*)::int from issues where company_id=$1 and status='done') done,
    (select count(*)::int from issue_comments where company_id=$1) comments,
    (select count(*)::int from activity_log where company_id=$1) activity,
    (select count(*)::int from issue_inbox_archives where company_id=$1) archives,
    (select count(*)::int from issue_read_states where company_id=$1) read_states,
    (select count(*)::int from issue_thread_interactions where company_id=$1) interactions,
    (select count(*)::int from heartbeat_runs where company_id=$1 and status in ('queued','running')) live_runs`, [companyId]);
  const fixtureMs = performance.now() - seedStart;

  const readCondition = await issueReadSqlCondition(db, { type: "board", source: "session", userId, authorizingUserId: userId } as never);
  const filters: IssueFilters = {
    // The route's exact filters. Baselines that predate touchedCandidates ignore it.
    readCondition, touchedByUserId: userId, touchedCandidates: "participation", inboxArchivedByUserId: userId,
    status: INBOX_MINE_ISSUE_STATUS_FILTER, listProjection: "index",
    sortField: "updated", sortDir: "desc", limit: 100,
    includeRoutineExecutions: true, includeLiveDescendantSummary: true,
  };
  const arms = { baseline: baseline.issueService(db), treatment: issueService(db) };
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
      else assert.deepEqual(serialized, reference, `${arm}: complete Mine row payloads must match`);
    }
  }
  const resultIds = (reference as Array<{ id: string }>).map((row) => row.id);

  // Per-phase timing from the list's own phase hook (absent in old baselines).
  const phaseTimes: Record<string, Record<string, number[]>> = { baseline: {}, treatment: {} };
  for (let iteration = 0; iteration < samples; iteration++) {
    for (const arm of ["baseline", "treatment"] as const) {
      await arms[arm].list(companyId, filters, {
        timePhase: async (phase, read) => {
          const started = performance.now();
          try { return await read(); } finally { (phaseTimes[arm]![phase] ??= []).push(performance.now() - started); }
        },
      } as never);
    }
  }
  assert.ok(resultIds.length === 100, `Fixture must fill the 100-row page (got ${resultIds.length})`);

  const plans: Record<string, unknown> = {};
  for (const arm of ["baseline", "treatment"] as const) {
    capture = [];
    await arms[arm].list(companyId, filters);
    const captured = capture;
    capture = null;
    const ranked = [];
    for (const query of captured) {
      const [row] = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params);
      const plan = row["QUERY PLAN"][0];
      ranked.push({ executionMs: plan["Execution Time"], planningMs: plan["Planning Time"],
        sharedHit: plan.Plan["Shared Hit Blocks"], sharedRead: plan.Plan["Shared Read Blocks"],
        sql: query.sql, params: query.params, plan });
    }
    ranked.sort((a, b) => b.executionMs - a.executionMs);
    plans[arm] = ranked;
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: sorted[Math.floor(sorted.length / 2)]!, minMs: sorted[0]!, maxMs: sorted[sorted.length - 1]!, samplesMs: values };
  };
  const summary = (arm: "baseline" | "treatment") => (plans[arm] as Array<{ executionMs: number; sql: string; sharedHit: number; sharedRead: number }>)
    .map((query) => ({ executionMs: Number(query.executionMs.toFixed(2)), buffers: query.sharedHit + query.sharedRead, sql: query.sql.replace(/\s+/g, " ").slice(0, 160) }));
  const report = {
    baselineRevision, treatmentRevision: git(["rev-parse", "HEAD"]).trim(), treatmentDirty: git(["status", "--porcelain", "--", ...modulePaths]).trim() !== "",
    settings, fixture: { ...counts, fixtureMs, resultRows: resultIds.length },
    baseline: stats(times.baseline), treatment: stats(times.treatment),
    phases: Object.fromEntries(Object.entries(phaseTimes).map(([arm, phases]) => [arm,
      Object.fromEntries(Object.entries(phases).map(([phase, values]) => [phase, Number(stats(values).medianMs.toFixed(2))]))])),
    speedup: stats(times.baseline).medianMs / stats(times.treatment).medianMs,
    queries: { baseline: summary("baseline"), treatment: summary("treatment") },
  };
  if (evidenceDir) {
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, "summary.json"), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(evidenceDir, "plans.json"), JSON.stringify(plans, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db?.$client.end({ timeout: 0 });
  await database?.cleanup();
  await fs.rm(baselineDir, { recursive: true, force: true });
  clearInterval(keepAlive);
}
