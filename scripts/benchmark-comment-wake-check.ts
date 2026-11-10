/**
 * Local red/green proof for the reconciler's user-comment wake check
 * (`checkUserCommentsWithoutWake` in the ownership invariant report).
 *
 * Loads the check from an explicit pre-change revision and from the working
 * tree, runs both against the same synthetic PostgreSQL fixture, and asserts
 * that the complete service result and the complete positional SQL rows are
 * equal before timing anything.
 *
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-comment-wake-check.ts --baseline-ref=<commit>
 *
 * Options: --fixture=<name> (repeatable), --samples=<n>.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SQL } from "drizzle-orm";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";

type Check = (db: Db, now: Date, limit: number, processStartedAt: Date) => Promise<unknown>;
type Query = { sql: string; params: unknown[] };

const baselineRef = process.argv.find(value => value.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-change --baseline-ref=<commit>");
// Run every git command from the repository root: the documented command runs from server/.
const root = fileURLToPath(new URL("../", import.meta.url));
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8", cwd: root }).trim();
const samplesPerArm = Number(process.argv.find(value => value.startsWith("--samples="))?.slice(10) ?? 5);
const sourcePath = "server/src/services/recovery/ownership-invariant-report.ts";
// Every helper the check imports must be unchanged, or the baseline is contaminated.
const changedRuntime = execFileSync("git", ["diff", "--name-only", baselineRevision, "--",
  "server/src/services", "packages/db/src", "packages/shared/src", "pnpm-lock.yaml"], { encoding: "utf8", cwd: root })
  .trim().split("\n").filter(Boolean);
assert.deepEqual(changedRuntime.filter(file => file !== sourcePath), [], "The baseline must not import changed runtime helpers");

const baselineSource = execFileSync("git", ["show", `${baselineRevision}:${sourcePath}`], { encoding: "utf8", cwd: root });
const baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.comment-wake-baseline-"));
const originalUrl = new URL(`../${sourcePath}`, import.meta.url);
const rewritten = baselineSource.replace(/from "(\.{1,2}\/[^"]+)"/g,
  (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, originalUrl)))}`)
  + "\nexport { checkUserCommentsWithoutWake as __benchmarkCheck };\n";
await fs.writeFile(path.join(baselineDir, "ownership-invariant-report.ts"), rewritten);
const baseline = (await import(pathToFileURL(path.join(baselineDir, "ownership-invariant-report.ts")).href) as { __benchmarkCheck: Check }).__benchmarkCheck;
const treatment = (await import("../server/src/services/recovery/ownership-invariant-report.js") as unknown as { checkUserCommentsWithoutWake: Check }).checkUserCommentsWithoutWake;

const fixtures = [
  // `steerWakeLostEvery`: a comment sent to a live run normally has a deferred
  // wake that carries it. Steered comments on issues with n % steerWakeLostEvery = 2
  // lost that wake (a restart), so only the steer check can rule them out.
  // Few comments, shallow history: the check must stay cheap.
  { name: "small", issues: 300, runs: 2_000, eventsPerRun: 6, hotIssues: 20, commentsPerHotIssue: 2, steerEvents: 40, payloadBytes: 1_024, contextBytes: 1_024, steerWakeLostEvery: 6 },
  // A busy instance: deep run history and wide contexts, a few hundred recent comments.
  { name: "representative", issues: 4_000, runs: 60_000, eventsPerRun: 6, hotIssues: 200, commentsPerHotIssue: 3, steerEvents: 400, payloadBytes: 2_048, contextBytes: 8_192, steerWakeLostEvery: 60 },
  // The same instance after a restart lost the wakes of steered comments: more
  // comments reach the run checks.
  { name: "lost-steer-wakes", issues: 4_000, runs: 30_000, eventsPerRun: 10, hotIssues: 200, commentsPerHotIssue: 3, steerEvents: 400, payloadBytes: 2_048, contextBytes: 4_096, steerWakeLostEvery: 6 },
  // Deeper history: twice the runs per company with the same recent traffic.
  { name: "deep-history", issues: 6_000, runs: 120_000, eventsPerRun: 2, hotIssues: 300, commentsPerHotIssue: 3, steerEvents: 200, payloadBytes: 2_048, contextBytes: 8_192, steerWakeLostEvery: 60 },
  // A busy hour: thousands of recent user comments over a deep run history.
  { name: "busy-hour", issues: 6_000, runs: 100_000, eventsPerRun: 2, hotIssues: 1_500, commentsPerHotIssue: 3, steerEvents: 100, payloadBytes: 2_048, contextBytes: 2_048, steerWakeLostEvery: 60 },
  // Stress: every steered comment lost its wake, and each steered run has thousands
  // of large item events after the comment.
  { name: "long-steered-runs", issues: 2_000, runs: 15_000, eventsPerRun: 8, hotIssues: 120, commentsPerHotIssue: 4, steerEvents: 2_000, payloadBytes: 4_096, contextBytes: 4_096, steerWakeLostEvery: 6 },
];

const keepAlive = setInterval(() => {}, 1000);
const started = performance.now();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const multiset = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;

/** Synthetic, incompressible text of about `bytes` characters (md5 hex chain). */
const filler = (bytes: number, seed: string) =>
  `(select string_agg(md5(${seed}::text || ':' || g::text), '') from generate_series(1, ${Math.max(1, Math.ceil(bytes / 32))}) g)`;

async function seed(db: Db, fixture: typeof fixtures[number], now: Date) {
  const run = (text: string, params: unknown[] = []) => db.$client.unsafe(text, params as never[]);
  for (const [company, scale] of [[randomUUID(), 1], [randomUUID(), 0.25]] as const) {
    const prefix = `B${company.slice(0, 6).toUpperCase()}`;
    const issueCount = Math.ceil(fixture.issues * scale), runCount = Math.ceil(fixture.runs * scale);
    const hot = Math.ceil(fixture.hotIssues * scale);
    await run(`insert into companies (id, name, issue_prefix) values ($1::uuid, 'Synthetic', $2)`, [company, prefix]);
    await run(`insert into agents (company_id, name, adapter_type) select $1::uuid, 'agent-' || n, 'codex_local' from generate_series(1, 20) n`, [company]);
    await run(`create temp table if not exists bench_agents (company_id uuid, n int, id uuid)`);
    await run(`insert into bench_agents select company_id, row_number() over (order by id), id from agents where company_id = $1::uuid`, [company]);
    // Issue n: status by n % 10; the first `hot` issues receive recent user comments.
    await run(`insert into issues (company_id, title, status, assignee_agent_id, identifier, issue_number)
      select $1::uuid, 'I-' || s.num, (array['done','done','todo','in_progress','done','cancelled','todo','in_progress','done','todo'])[1 + s.num % 10],
        (select a.id from bench_agents a where a.company_id = $1::uuid and a.n = 1 + s.num % 20), $2 || '-' || s.num, s.num
      from generate_series(1, $3::int) s(num)`, [company, prefix, issueCount]);
    await run(`create temp table if not exists bench_issues (company_id uuid, n int, id uuid, agent_id uuid)`);
    await run(`insert into bench_issues select company_id, issue_number, id, assignee_agent_id from issues where company_id = $1::uuid`, [company]);
    // Run history over 14 days. Legacy runs bind by context, native runs by column, some by both.
    await run(`insert into heartbeat_runs (company_id, agent_id, status, invocation_source, native_issue_id, context_snapshot,
        created_at, started_at, finished_at)
      select $1::uuid, i.agent_id, 'succeeded', 'assignment', case when r % 3 <> 0 then i.id end,
        case when r % 3 = 1 then '{}'::jsonb else jsonb_build_object('issueId', i.id::text, 'prompt', ${filler(fixture.contextBytes, "r")}) end,
        $2::timestamptz - interval '2 hours' - (r * interval '14 days' / $3::int), $2::timestamptz - interval '2 hours' - (r * interval '14 days' / $3::int),
        $2::timestamptz - interval '2 hours' - (r * interval '14 days' / $3::int) + interval '20 minutes'
      from generate_series(1, $3::int) r join bench_issues i on i.company_id = $1::uuid and i.n = 1 + (r * 7919) % $4::int`,
      [company, now.toISOString(), runCount, issueCount]);
    await run(`insert into heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, created_at, payload)
      select r.company_id, r.id, r.agent_id, e, (array['item.started','item.completed','item.started','log','item.completed'])[1 + e % 5],
        r.started_at + e * interval '1 second', jsonb_build_object('prpEvent', jsonb_build_object('itemId', 'item-' || e, 'text', ${filler(fixture.payloadBytes, "r.id::text || e")}))
      from heartbeat_runs r cross join generate_series(1, $2::int) e where r.company_id = $1::uuid`, [company, fixture.eventsPerRun]);
    // Hot issues: one recent run each, then user comments in the last hour. Shape by issue n % 6:
    // 0,1 normal (a wake carries each comment, a later run reads it); 2 steered (the run that
    // was live at comment time acknowledged it in an item event); 3 lost (no wake, no later run:
    // the reported case); 4 live run (queued); 5 carried by a goal wake context list.
    await run(`insert into heartbeat_runs (company_id, agent_id, status, invocation_source, native_issue_id, context_snapshot, created_at, started_at, finished_at)
      select i.company_id, i.agent_id, case when i.n % 6 = 4 then 'queued' else 'succeeded' end, 'assignment',
        case when i.n % 2 = 0 then i.id end, jsonb_build_object('issueId', i.id::text, 'prompt', ${filler(fixture.contextBytes, "i.n")}),
        $2::timestamptz - interval '58 minutes', $2::timestamptz - interval '58 minutes',
        case when i.n % 6 = 2 then $2::timestamptz - interval '1 minute' when i.n % 6 = 4 then null else $2::timestamptz - interval '57 minutes' end
      from bench_issues i where i.company_id = $1::uuid and i.n <= $3::int`, [company, now.toISOString(), hot]);
    await run(`insert into issue_comments (company_id, issue_id, author_user_id, body, created_at)
      select i.company_id, i.id, 'user-1', 'comment ' || k,
        -- Distinct times: the check orders by creation time only.
        $2::timestamptz - interval '55 minutes' + ((k - 1) * $3::int + i.n) * (interval '50 minutes' / ($3::int * $4::int))
          + $5::int * interval '1 millisecond'
      from bench_issues i cross join generate_series(1, $4::int) k where i.company_id = $1::uuid and i.n <= $3::int`,
      [company, now.toISOString(), hot, fixture.commentsPerHotIssue, scale === 1 ? 0 : 500]);
    // Older comment history outside the lookback window.
    await run(`insert into issue_comments (company_id, issue_id, author_user_id, body, created_at)
      select i.company_id, i.id, 'user-1', 'old', $2::timestamptz - interval '2 hours' - (k * interval '3 hours')
      from bench_issues i cross join generate_series(1, 8) k where i.company_id = $1::uuid`, [company, now.toISOString()]);
    await run(`insert into agent_wakeup_requests (company_id, agent_id, source, status, payload, created_at, updated_at)
      select c.company_id, i.agent_id, 'automation', case when i.n % 6 = 2 then 'coalesced' else 'completed' end,
        case when i.n % 6 = 5 then jsonb_build_object('issueId', c.issue_id::text, '_paperclipWakeContext', jsonb_build_object('wakeCommentIds', jsonb_build_array(c.id::text)))
          else jsonb_build_object('issueId', c.issue_id::text, 'commentId', c.id::text) end, c.created_at, c.created_at
      from issue_comments c join bench_issues i on i.id = c.issue_id
      where c.company_id = $1::uuid and (i.n % 6 in (0, 1, 5) or (i.n % 6 = 2 and i.n % $3::int <> 2)
        or c.created_at < $2::timestamptz - interval '2 hours')`, [company, now.toISOString(), fixture.steerWakeLostEvery]);
    // Normal comments get a run after them.
    await run(`insert into heartbeat_runs (company_id, agent_id, status, invocation_source, context_snapshot, created_at, started_at, finished_at)
      select c.company_id, i.agent_id, 'succeeded', 'automation', jsonb_build_object('issueId', c.issue_id::text, 'commentId', c.id::text),
        c.created_at + interval '2 seconds', c.created_at + interval '2 seconds', c.created_at + interval '30 seconds'
      from issue_comments c join bench_issues i on i.id = c.issue_id
      where c.company_id = $1::uuid and i.n % 6 in (0, 1) and c.created_at >= $2::timestamptz - interval '1 hour'`, [company, now.toISOString()]);
    // Steered runs: many large item events after each comment; one acknowledges the comment.
    await run(`insert into heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, created_at, payload)
      select r.company_id, r.id, r.agent_id, 1000 + e, (array['item.started','item.completed'])[1 + e % 2],
        r.started_at + interval '2 minutes' + e * (interval '55 minutes' / $2::int),
        jsonb_build_object('prpEvent', jsonb_build_object('itemId', 'item-' || e, 'text', ${filler(fixture.payloadBytes, "r.id::text || e")}))
      from heartbeat_runs r join bench_issues i on i.company_id = r.company_id
        and (r.native_issue_id = i.id or r.context_snapshot->>'issueId' = i.id::text)
      cross join generate_series(1, $2::int) e
      where r.company_id = $1::uuid and i.n <= $3::int and i.n % 6 = 2 and r.started_at >= $4::timestamptz - interval '1 hour'`,
      [company, fixture.steerEvents, hot, now.toISOString()]);
    await run(`insert into heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, created_at, payload)
      select c.company_id, r.id, r.agent_id, 100000 + row_number() over (partition by r.id order by c.created_at), 'item.completed', c.created_at + interval '3 seconds',
        jsonb_build_object('prpEvent', jsonb_build_object('itemId', 'provider:steer:' || c.id::text, 'payload', jsonb_build_object('kind', 'steering_acknowledgement')))
      from issue_comments c join bench_issues i on i.id = c.issue_id
      join heartbeat_runs r on r.company_id = c.company_id and r.native_issue_id = c.issue_id and r.started_at < c.created_at and r.finished_at >= c.created_at
      where c.company_id = $1::uuid and i.n % 6 = 2 and c.created_at >= $2::timestamptz - interval '1 hour'`, [company, now.toISOString()]);
    // Closures of done tasks: agent closes even n, a person closes odd n.
    await run(`insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
      select i.company_id, case when i.n % 2 = 0 then 'agent' else 'user' end, 'actor', 'issue.updated', 'issue', i.id::text,
        jsonb_build_object('toStatus', 'done'), $2::timestamptz - interval '3 hours'
      from bench_issues i join issues s on s.id = i.id where i.company_id = $1::uuid and s.status = 'done'`, [company, now.toISOString()]);
  }
  await run("analyze");
}

function captureQuery(db: Db, check: Check, now: Date, limit: number, processStartedAt: Date): Promise<{ query: Query; result: unknown }> {
  let query: Query | undefined;
  const dialect = (db as unknown as { dialect: { sqlToQuery(sql: SQL): Query } }).dialect;
  const captureDb = new Proxy(db, { get(target, key) {
    if (key !== "execute") return Reflect.get(target, key);
    return (statement: SQL) => { query = dialect.sqlToQuery(statement); return target.execute(statement); };
  } });
  return check(captureDb, now, limit, processStartedAt).then(result => { assert.ok(query, "query captured"); return { query: query!, result }; });
}

try {
  database = await startEmbeddedPostgresTestDatabase("comment-wake-benchmark-");
  db = createDb(database.connectionString, { maxConnections: 1, idleTimeoutSeconds: 0 });
  await db.$client.unsafe("set client_min_messages = warning");
  const version = await db.$client.unsafe("select version()");
  const settings = await db.$client.unsafe("select name, setting from pg_settings where name in ('shared_buffers', 'work_mem', 'jit', 'random_page_cost') order by name");
  const selectors = process.argv.filter(value => value.startsWith("--fixture=")).map(value => value.slice(10));
  const results = [];
  for (const fixture of fixtures.filter(value => !selectors.length || selectors.includes(value.name))) {
    await db.$client.unsafe("TRUNCATE companies CASCADE");
    await db.$client.unsafe("drop table if exists bench_agents, bench_issues");
    const now = new Date(), processStartedAt = new Date(now.getTime() - 2 * 60 * 60_000), limit = 200;
    const seedStart = performance.now();
    await seed(db, fixture, now);
    const seedMs = performance.now() - seedStart;
    const counts = await db.$client.unsafe(`select (select count(*) from heartbeat_runs) runs, (select count(*) from heartbeat_run_events) events,
      (select count(*) from issue_comments where created_at >= now() - interval '1 hour') recent_comments,
      (select pg_size_pretty(pg_total_relation_size('heartbeat_run_events'))) events_size,
      (select pg_size_pretty(pg_total_relation_size('heartbeat_runs'))) runs_size`);
    const before = await captureQuery(db, baseline, now, limit, processStartedAt);
    const after = await captureQuery(db, treatment, now, limit, processStartedAt);
    assert.deepEqual(after.result, before.result, `${fixture.name}: complete service result differs`);
    const rows = async (query: Query) => db!.$client.unsafe(query.sql, query.params as never[]).values();
    const expected = await rows(before.query), actual = await rows(after.query);
    assert.ok(expected.length > 0, `${fixture.name}: the fixture must report owed comments`);
    // Order is part of the contract: compare positionally, then as multisets.
    assert.deepEqual(actual, expected, `${fixture.name}: complete positional SQL output differs`);
    assert.deepEqual(multiset(actual), multiset(expected));
    const samples = { before: [] as number[], after: [] as number[] };
    for (let iteration = 0; iteration < samplesPerArm + 2; iteration++) {
      for (const arm of iteration % 2 ? ["after", "before"] as const : ["before", "after"] as const) {
        const start = performance.now();
        const result = await (arm === "before" ? baseline : treatment)(db, now, limit, processStartedAt);
        const ms = performance.now() - start;
        assert.deepEqual(result, before.result);
        if (iteration >= 2) samples[arm].push(ms);
      }
    }
    const plans: Record<string, unknown> = {};
    const buffers: Record<string, number> = {};
    for (const [arm, captured] of [["before", before], ["after", after]] as const) {
      const [row] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.query.sql}`, captured.query.params as never[]);
      plans[arm] = row["QUERY PLAN"];
      const plan = (row["QUERY PLAN"] as { Plan: Record<string, number> }[])[0]!.Plan;
      buffers[arm] = Number(plan["Shared Hit Blocks"]) + Number(plan["Shared Read Blocks"]);
    }
    const medians = { before: median(samples.before), after: median(samples.after) };
    // Hash-join plan: without nested loops, PostgreSQL can join the baseline's
    // OR-bound run lookups only by company, testing each comment against every
    // run of its company. The treatment's per-comment probes have no such plan.
    // One sample each, outside the timed interval, with the same result check.
    const hashPlan: Record<string, number | string> = {};
    if (!process.argv.includes("--skip-hash-plan")) {
      await db.$client.unsafe("set enable_nestloop = off");
      await db.$client.unsafe("set statement_timeout = '300s'");
      try {
        for (const [arm, captured] of [["before", before], ["after", after]] as const) {
          const start = performance.now();
          try {
            assert.deepEqual(await rows(captured.query), expected, `${fixture.name}: hash-plan output differs`);
            hashPlan[arm] = performance.now() - start;
          } catch (error) {
            if ((error as { code?: string }).code !== "57014") throw error;
            hashPlan[arm] = "timeout after 300 s";
          }
        }
      } finally {
        await db.$client.unsafe("reset enable_nestloop");
        await db.$client.unsafe("reset statement_timeout");
      }
    }
    results.push({ fixture, counts: counts[0], seedMs, reportedRows: expected.length, queries: { before: before.query.sql, after: after.query.sql },
      samples, medians, buffers, hashPlan, plans });
    process.stderr.write(`${fixture.name}: ${JSON.stringify(counts[0])} owed=${expected.length}; `
      + `median ${medians.before.toFixed(1)} -> ${medians.after.toFixed(1)} ms (${(medians.before / medians.after).toFixed(1)}x); `
      + `buffers ${buffers.before} -> ${buffers.after}; hash plan ${JSON.stringify(hashPlan)}; samples before=${samples.before.map(v => v.toFixed(0)).join(",")} after=${samples.after.map(v => v.toFixed(0)).join(",")}\n`);
  }
  const treatmentSource = await fs.readFile(path.join(root, sourcePath));
  const output = JSON.stringify({ baselineRevision, treatmentRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: root }).trim(),
    sourcePath, baselineSha256: createHash("sha256").update(baselineSource).digest("hex"),
    treatmentSha256: createHash("sha256").update(treatmentSource).digest("hex"), version, settings,
    warmups: 2, timedSamplesPerArm: samplesPerArm, setupAndProofMs: performance.now() - started, results }, null, 2);
  const out = process.argv.find(value => value.startsWith("--out="))?.slice(6);
  if (out) await fs.writeFile(out, output); else console.log(output);
} finally {
  try { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); await fs.rm(baselineDir, { recursive: true, force: true }); }
  finally { clearInterval(keepAlive); }
}
