/**
 * Local proof for the GitHub review lookups (migration 0456).
 *
 * Measures the SQL that the services generate: the inherited review-wait lookup
 * by source comment (SQL unchanged; four new indexes) and the review-check
 * fallback that finds the wake run from the delivery's inbound comments (SQL
 * split into two statements). The pre-fix check module is loaded from
 * --baseline-ref. Each version runs with and without the new indexes, and the
 * script fails unless complete rows and service results match.
 *
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-review-lookup-indexes.ts --baseline-ref=<pre-fix commit>
 *
 * Optional sizes: LINKS (default 50000), DELIVERIES (5000), RUNS (4000),
 * RUN_CONTEXT_KIB (12).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase } from "../packages/db/src/index.js";
import { readInheritedGitHubReviewWait } from "../server/src/services/chat-channels/github/review-wait.js";
import { githubReviewCheckState } from "../server/src/services/chat-channels/github/review-check-state.js";
import { captureReviewWaitQueries, seedGitHubReviewCheck, seedGitHubReviewWait,
  type CapturedReviewWaitQuery } from "../server/src/__tests__/helpers/github-review-wait.js";

const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const LINKS = size("LINKS", 50_000), DELIVERIES = size("DELIVERIES", 5_000);
const RUNS = size("RUNS", 4_000), RUN_CONTEXT_KIB = size("RUN_CONTEXT_KIB", 12);
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
const baselineRevision = git("rev-parse", "--verify", `${baselineRef}^{commit}`).trim();
const root = fileURLToPath(new URL("../", import.meta.url));
const checkModule = "server/src/services/chat-channels/github/review-check-state.ts";
const waitModule = "server/src/services/chat-channels/github/review-wait.ts";
assert.equal(git("show", `${baselineRevision}:${waitModule}`), readFileSync(path.join(root, waitModule), "utf8"),
  "The review-wait module must be unchanged; only its indexes differ");
const migration = readFileSync(path.join(root, "packages/db/src/migrations/0456_chat_review_lookup_indexes.sql"), "utf8");
const indexStatements = migration.split("--> statement-breakpoint").map(statement => statement.trim()).filter(Boolean);
const indexNames = indexStatements.map(statement => statement.match(/IF NOT EXISTS "([a-z_]+)"/)![1]!);

type CheckState = typeof githubReviewCheckState;
const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let baselineDir: string | undefined;
try {
  const moduleUrl = pathToFileURL(path.join(root, checkModule));
  baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.review-check-baseline-"));
  const baselineFile = path.join(baselineDir, "review-check-state.ts");
  await fs.writeFile(baselineFile, git("show", `${baselineRevision}:${checkModule}`).replace(/from "(\.{1,2}\/[^"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`));
  const baselineCheck = (await import(pathToFileURL(baselineFile).href) as { githubReviewCheckState: CheckState }).githubReviewCheckState;

  temporary = await startEmbeddedPostgresTestDatabase("review-lookups-benchmark-");
  db = createDb(temporary.connectionString);
  const sql = db.$client;
  const wait = await seedGitHubReviewWait(db);
  const check = await seedGitHubReviewCheck(db);

  // Unrelated chat history: comments, deliveries and links on the same endpoint.
  const loadStart = performance.now();
  await sql.unsafe(`insert into issue_comments (company_id, issue_id, author_user_id, body)
    select $1::uuid, $2::uuid, 'operator', 'noise ' || g from generate_series(1, $3::int) g`,
  [check.companyId, check.issueId, LINKS]);
  await sql.unsafe(`insert into chat_deliveries (company_id, endpoint_id, conversation_id, provider_event_id,
      deduplication_key, event_kind, state, normalized_event)
    select $1::uuid, $2::uuid, $3::uuid, 'noise-' || g, 'noise-' || g, 'message', 'processed',
      jsonb_build_object('githubAutomatic', jsonb_build_object('context', jsonb_build_object(
        'deliveryId', gen_random_uuid()::text,
        'body', (select string_agg(md5(random()::text || s.i || g), '') from generate_series(1, 64) s(i)))))
    from generate_series(1, $4::int) g`, [check.companyId, check.endpointId, check.conversationId, DELIVERIES]);
  await sql.unsafe(`with c as (select id, row_number() over (order by id) rn from issue_comments
        where company_id = $1::uuid and body like 'noise %'),
      d as (select id, row_number() over (order by id) rn from chat_deliveries
        where endpoint_id = $2::uuid and provider_event_id like 'noise-%')
    insert into chat_message_links (company_id, endpoint_id, conversation_id, delivery_id, comment_id,
      provider_message_id, direction)
    select $1::uuid, $2::uuid, $3::uuid, d.id, c.id, 'noise-' || c.rn,
      case when c.rn % 2 = 0 then 'inbound' else 'outbound' end
    from c left join d on d.rn = c.rn`, [check.companyId, check.endpointId, check.conversationId]);
  // Runs of the same agent before and after the wake run; most were woken by
  // some other comment.
  await sql.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, context_snapshot, created_at)
    select $1::uuid, $2::uuid, 'succeeded', jsonb_build_object(
        'wakeCommentId', case when g % 5 <> 0 then gen_random_uuid()::text end,
        'issueId', $3::text,
        'prompt', (select string_agg(md5(random()::text || s.i || g), '') from generate_series(1, $4::int) s(i))),
      now() + make_interval(secs => g - $5::int / 2)
    from generate_series(1, $5::int) g`, [check.companyId, check.agentId, check.issueId, RUN_CONTEXT_KIB * 32, RUNS]);
  const loadMs = performance.now() - loadStart;
  const tableSizes = await sql.unsafe(`select relname as table, n_live_tup::int as rows,
      pg_size_pretty(pg_total_relation_size(relid)) as total_size from pg_stat_user_tables
    where relname in ('chat_message_links', 'chat_deliveries', 'heartbeat_runs', 'issue_comments') order by relname`);
  // A delivery whose inbound comment has no wake run yet.
  const [unmatched] = await sql.unsafe(`select d.normalized_event->'githubAutomatic'->'context'->>'deliveryId' as id
    from chat_deliveries d join chat_message_links l on l.delivery_id = d.id and l.direction = 'inbound'
    where d.endpoint_id = $1::uuid and d.provider_event_id like 'noise-%' order by d.provider_event_id limit 1`, [check.endpointId]);
  assert.ok(unmatched?.id);
  const unmatchedAction = { ...check.action, payload: { ...check.action.payload,
    event: { ...check.event, deliveryId: unmatched.id as string } } };

  const isWakeRead = (query: CapturedReviewWaitQuery) => query.sql.startsWith('select "chat_message_links"."comment_id"') ||
    query.sql.includes('from "chat_deliveries" inner join "chat_message_links"') ||
    (query.sql.startsWith('select "id", "status" from "heartbeat_runs"') && query.sql.includes("wakeCommentId"));
  const rows = async (query: CapturedReviewWaitQuery) =>
    (await sql.unsafe(query.sql, query.params as never[]).values()).map(row => row.map(value => value?.toString() ?? null));
  async function captureCheck(reader: CheckState, action: typeof check.action) {
    const queries: CapturedReviewWaitQuery[] = [];
    const result = await reader(captureReviewWaitQueries(db!, queries), action);
    return { result, wakeReads: queries.filter(isWakeRead) };
  }
  async function captureWait() {
    const queries: CapturedReviewWaitQuery[] = [];
    const result = await readInheritedGitHubReviewWait(captureReviewWaitQueries(db!, queries), wait.run);
    const inherited = queries.find(query => query.sql.includes('join "chat_github_reviews"'));
    assert.ok(inherited);
    return { result, inherited };
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const round = (value: number) => Number(value.toFixed(3));
  async function sample(run: () => Promise<number>) {
    for (let n = 0; n < 2; n++) await run();
    const samples: number[] = [];
    for (let n = 0; n < 9; n++) samples.push(await run());
    return { samplesMs: samples.map(round), medianMs: round(median(samples)),
      minMs: round(Math.min(...samples)), maxMs: round(Math.max(...samples)) };
  }
  // Server execution time from EXPLAIN ANALYZE, summed over a caller's statements.
  async function explain(query: CapturedReviewWaitQuery) {
    const [result] = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
    return (result!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown>; "Execution Time": number }>)[0]!;
  }
  const executionMs = async (queries: CapturedReviewWaitQuery[]) => {
    let total = 0;
    for (const query of queries) total += (await explain(query))["Execution Time"];
    return total;
  };
  const wall = (run: () => Promise<unknown>) => async () => {
    const start = performance.now();
    await run();
    return performance.now() - start;
  };
  async function plans(queries: CapturedReviewWaitQuery[]) {
    return Promise.all(queries.map(async query => {
      const root = await explain(query), nodes: string[] = [];
      const walk = (node: Record<string, unknown>) => {
        if (/Scan|Join|Loop/.test(String(node["Node Type"]))) nodes.push(`${node["Node Type"]}${node["Index Name"] ? ` using ${node["Index Name"]}` : ""}${node["Relation Name"] ? ` on ${node["Relation Name"]}` : ""}`);
        for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
      };
      walk(root.Plan);
      return { executionMs: root["Execution Time"], sharedHitBlocks: root.Plan["Shared Hit Blocks"],
        sharedReadBlocks: root.Plan["Shared Read Blocks"], nodes };
    }));
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
    await sql.unsafe("ANALYZE");
    const waitCapture = await captureWait();
    const versions = { baseline: baselineCheck, treatment: githubReviewCheckState };
    const checks: Record<string, unknown> = {};
    const outputs: Record<string, unknown> = {};
    for (const [version, reader] of Object.entries(versions)) {
      for (const [name, action] of [["matched", check.action], ["noWakeRunYet", unmatchedAction]] as const) {
        const captured = await captureCheck(reader, action);
        const finalRows = captured.wakeReads.length ? await rows(captured.wakeReads.at(-1)!) : [];
        outputs[`${version}.${name}`] = { result: captured.result, finalRows };
        checks[`${version}.${name}`] = {
          statements: captured.wakeReads.length,
          serverExecution: await sample(() => executionMs(captured.wakeReads)),
          serviceWall: await sample(wall(() => reader(db!, action))),
          plans: await plans(captured.wakeReads),
        };
      }
    }
    return {
      indexes, builds, waitCapture, outputs,
      inheritedRows: await rows(waitCapture.inherited),
      inherited: {
        serverExecution: await sample(() => executionMs([waitCapture.inherited])),
        serviceWall: await sample(wall(() => readInheritedGitHubReviewWait(db!, wait.run))),
        plans: await plans([waitCapture.inherited]),
      },
      checks,
    };
  }

  // No indexes, indexes, then no indexes again to expose cache-order bias.
  const runs = [await measure(false), await measure(true), await measure(false)];
  const reference = runs[0]!;
  for (const run of runs) {
    assert.equal(run.waitCapture.inherited.sql, reference.waitCapture.inherited.sql);
    assert.deepEqual(run.inheritedRows, reference.inheritedRows, "Inherited review rows must match");
    assert.deepEqual(run.waitCapture.result, reference.waitCapture.result);
    for (const name of ["matched", "noWakeRunYet"]) {
      for (const version of ["baseline", "treatment"]) {
        assert.deepEqual(run.outputs[`${version}.${name}`], reference.outputs[`baseline.${name}`],
          `${version} ${name} result and final wake-run rows must match the pre-fix module`);
      }
    }
  }
  assert.equal(reference.waitCapture.result?.kind, "published");
  assert.deepEqual((reference.outputs["baseline.matched"] as { finalRows: unknown }).finalRows, [[check.wakeRunId, "running"]]);
  assert.deepEqual((reference.outputs["baseline.noWakeRunYet"] as { finalRows: unknown }).finalRows, []);

  console.log(JSON.stringify({
    baselineRevision, treatmentRevision: git("rev-parse", "HEAD").trim(),
    treatmentDiff: execFileSync("git", ["diff", "HEAD", "--", checkModule], { cwd: root, encoding: "utf8" }),
    postgresVersion: (await sql.unsafe("select version()"))[0]!.version,
    settings: await sql.unsafe("select name, setting from pg_settings where name in ('shared_buffers','work_mem','jit') order by name"),
    fixture: { synthetic: true, links: LINKS, deliveries: DELIVERIES, runs: RUNS, runContextKiB: RUN_CONTEXT_KIB,
      loadMs: Math.round(loadMs), tableSizes },
    correctness: { inheritedSqlUnchanged: true, inheritedRowsEqual: true, checkResultsEqual: true, finalWakeRunRowsEqual: true,
      cases: ["matched", "noWakeRunYet"] },
    results: runs.map(({ waitCapture: _capture, outputs: _outputs, inheritedRows: _rows, ...run }) => run),
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
