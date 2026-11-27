import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { registerGitHubTerminalResponseWork } from "../server/src/services/chat-channels/github/terminal-response-work.js";
import { captureReviewWaitQueries, type CapturedReviewWaitQuery } from "../server/src/__tests__/helpers/github-review-wait.js";

// Measures the GitHub terminal-response discovery page against a synthetic
// history: many agent runs with incompressible legacy contexts and a set of
// acknowledged (processed, non-final) response comments.
//   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-github-terminal-response-sweep.ts --baseline-ref=<pre-fix commit>
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const number = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const fixture = {
  issues: number("BENCH_ISSUES", 1_500),
  runsPerIssue: number("BENCH_RUNS_PER_ISSUE", 8),
  contextPadBytes: number("BENCH_CONTEXT_PAD_BYTES", 4_096),
  candidates: number("BENCH_CANDIDATES", 150),
  blockedEvery: 10,
  decoyCompanies: 1,
};
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const modulePath = "server/src/services/chat-channels/github/terminal-response-work.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let baselineDir: string | undefined;

async function seed(db: Db, companyIndex: number) {
  const sql = db.$client;
  const [{ company }] = await sql.unsafe(`insert into companies (name, issue_prefix) values ($1, $2) returning id as company`,
    [`Bench ${companyIndex}`, `BN${companyIndex}`]);
  const [{ agent }] = await sql.unsafe(`insert into agents (company_id, name) values ($1, 'GitHub agent') returning id as agent`, [company]);
  const [{ application }] = await sql.unsafe(`insert into tool_applications (company_id, application_key, name, type)
    values ($1, 'github', 'GitHub', 'chat') returning id as application`, [company]);
  const [{ connection }] = await sql.unsafe(`insert into tool_connections (company_id, application_id, name, uid, transport, connection_purpose)
    values ($1, $2, 'GitHub', $3, 'chat_sdk', 'channel') returning id as connection`, [company, application, `github-${companyIndex}`]);
  const [{ endpoint }] = await sql.unsafe(`insert into chat_endpoints (company_id, connection_id, provider, public_id, assigned_agent_id, status)
    values ($1, $2, 'github', $3, $4, 'active') returning id as endpoint`, [company, connection, `bench-${companyIndex}`, agent]);
  const [{ resource }] = await sql.unsafe(`insert into chat_endpoint_resources (company_id, endpoint_id, type, provider_resource_id, label, metadata)
    values ($1, $2, 'repository', 'R_1', 'paperclipai/paperclip', '{"providerRepositoryId":"R_1"}') returning id as resource`, [company, endpoint]);
  // Issue numbers are 1..N; every tenth issue is blocked.
  await sql.unsafe(`insert into issues (company_id, title, status)
    select $1, 'Issue ' || n, case when n % ${fixture.blockedEvery} = 0 then 'blocked' else 'in_progress' end
    from generate_series(1, ${fixture.issues}) n`, [company]);
  await sql.unsafe(`create unlogged table if not exists bench_issue (n int, id uuid, company uuid)`);
  await sql.unsafe(`delete from bench_issue`);
  await sql.unsafe(`insert into bench_issue select (regexp_replace(title, '\\D', '', 'g'))::int, id, company_id from issues where company_id = $1`, [company]);
  await sql.unsafe(`insert into chat_conversations (company_id, endpoint_id, issue_id, external_conversation_id, external_label,
      external_thread_id, resource_id)
    select $1, $2, i.id, 'github:paperclipai/paperclip:' || i.n, 'PR #' || i.n, 'github:paperclipai/paperclip:' || i.n, $3
    from bench_issue i`, [company, endpoint, resource]);
  await sql.unsafe(`insert into chat_deliveries (company_id, endpoint_id, provider_event_id, deduplication_key, event_kind,
      normalized_event, conversation_id, state)
    select $1, $2, 'event-' || i.n, 'dedupe-' || i.n, 'message', '{}', c.id, 'processed'
    from bench_issue i join chat_conversations c on c.issue_id = i.id`, [company, endpoint]);
  // One response comment per issue. The first N issues are acknowledged and
  // not final; the rest finished long ago with a final response.
  await sql.unsafe(`insert into chat_actions (company_id, endpoint_id, delivery_id, conversation_id, kind, provider_action_id, status, result)
    select $1, $2, d.id, c.id, 'github_response_comment', 'response-' || i.n, 'processed',
      case when i.n <= ${fixture.candidates} then jsonb_build_object('id', 'IC_' || i.n, 'final', false)
        else jsonb_build_object('id', 'IC_' || i.n, 'final', true) end
    from bench_issue i join chat_conversations c on c.issue_id = i.id join chat_deliveries d on d.conversation_id = c.id`, [company, endpoint]);
  await sql.unsafe(`insert into chat_message_links (company_id, endpoint_id, conversation_id, delivery_id, provider_message_id, direction)
    select $1, $2, c.id, d.id, 'IC_in_' || i.n, 'inbound'
    from bench_issue i join chat_conversations c on c.issue_id = i.id join chat_deliveries d on d.conversation_id = c.id`, [company, endpoint]);
  // Runs: odd issues are legacy (context_snapshot only), even issues are native.
  // Legacy contexts carry incompressible padding like real prompt context.
  await sql.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, native_issue_id, context_snapshot, created_at)
    select $1, $2, case when r = ${fixture.runsPerIssue} and i.n % 3 = 0 then 'running' else 'succeeded' end,
      case when i.n % 2 = 0 then i.id end,
      jsonb_build_object('issueId', i.id::text, 'pad',
        (select string_agg(md5(random()::text || g::text || i.n::text || r::text), '') from generate_series(1, ${Math.ceil(fixture.contextPadBytes / 32)}) g)),
      timestamptz '2026-01-01' + (i.n * ${fixture.runsPerIssue} + r) * interval '1 second'
    from bench_issue i cross join generate_series(1, ${fixture.runsPerIssue}) r`, [company, agent]);
  // Precedence decoys: a newer active run natively bound to another issue whose
  // legacy context still names this issue. It must not count for this issue.
  await sql.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, native_issue_id, context_snapshot, created_at)
    select $1, $2, 'running', gen_random_uuid(), jsonb_build_object('issueId', i.id::text),
      timestamptz '2026-01-01' + (i.n * ${fixture.runsPerIssue} + ${fixture.runsPerIssue} + 1) * interval '1 second'
    from bench_issue i where i.n % 7 = 0`, [company, agent]);
  // Ordering ties: an active run with the latest creation time of the issue's
  // other runs (native and legacy). The id decides which run is latest.
  await sql.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, native_issue_id, context_snapshot, created_at)
    select $1, $2, 'running', case when i.n % 2 = 1 then i.id end, jsonb_build_object('issueId', i.id::text),
      timestamptz '2026-01-01' + (i.n * ${fixture.runsPerIssue} + ${fixture.runsPerIssue}) * interval '1 second'
    from bench_issue i where i.n % 11 = 0`, [company, agent]);
  // Another agent's newer active runs on the same issues.
  const [{ other }] = await sql.unsafe(`insert into agents (company_id, name) values ($1, 'Other agent') returning id as other`, [company]);
  await sql.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, native_issue_id, context_snapshot, created_at)
    select $1, $2, 'running', case when i.n % 2 = 0 then i.id end, jsonb_build_object('issueId', i.id::text), timestamptz '2027-01-01'
    from bench_issue i where i.n % 5 = 0`, [company, other]);
  return { company, agent, endpoint };
}

try {
  const oldSource = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
  const moduleUrl = new URL(`../${modulePath}`, import.meta.url);
  baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.terminal-response-baseline-"));
  const baselineFile = path.join(baselineDir, "terminal-response-work.ts");
  await fs.writeFile(baselineFile, oldSource.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`));
  const baseline = await import(pathToFileURL(baselineFile).href) as typeof import("../server/src/services/chat-channels/github/terminal-response-work.js");
  temporary = await startEmbeddedPostgresTestDatabase("github-terminal-response-benchmark-");
  db = createDb(temporary.connectionString);
  const seedStart = performance.now();
  const main = await seed(db, 0);
  for (let n = 1; n <= fixture.decoyCompanies; n++) await seed(db, n);
  await db.$client.unsafe("DROP TABLE bench_issue");
  await db.$client.unsafe("ANALYZE");
  const seedMs = performance.now() - seedStart;

  const stop = new Error("captured");
  async function capture(register: typeof registerGitHubTerminalResponseWork) {
    const queries: CapturedReviewWaitQuery[] = [];
    const proxy = captureReviewWaitQueries(db!, queries);
    let task: { run(signal: AbortSignal): Promise<unknown> } | undefined;
    const coordinator = { register: (_queue: unknown, value: typeof task) => { task = value; return { wake() {}, stop: async () => {} }; } };
    register(new Proxy(proxy, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "select") return value;
      return (...args: unknown[]) => {
        if (queries.some(query => query.sql.includes("github-publication:"))) throw stop;
        return (value as (...args: unknown[]) => unknown)(...args);
      };
    } }), coordinator as never, async () => {}, () => true);
    await task!.run(new AbortController().signal).catch(() => {});
    const query = queries.find(query => query.sql.includes("github-publication:"));
    assert.ok(query, "Capture the real discovery page query");
    return query;
  }
  const queries = {
    baseline: await capture(baseline.registerGitHubTerminalResponseWork),
    treatment: await capture(registerGitHubTerminalResponseWork),
  };

  // Compare every candidate, not only the first page: lift the page limit.
  async function rows(query: CapturedReviewWaitQuery) {
    assert.match(query.sql, /limit \$\d+$/);
    const params = [...query.params.slice(0, -1), 1_000_000];
    return (await db!.$client.unsafe(query.sql, params as never[]).values()).map(row => row.map(value =>
      value === null ? null : typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : String(value)));
  }
  const before = await rows(queries.baseline), after = await rows(queries.treatment);
  assert.deepEqual(after, before, "Every returned column and row order must match");
  assert.ok(before.length > 0, "The fixture must return terminal candidates");

  async function timed(query: CapturedReviewWaitQuery) {
    const start = performance.now();
    await db!.$client.unsafe(query.sql, query.params as never[]).values();
    return performance.now() - start;
  }
  const iterations = number("BENCH_ITERATIONS", 7);
  const samples = { baseline: [] as number[], treatment: [] as number[] };
  for (let n = 0; n < iterations + 2; n++) {
    const versions = n % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const;
    for (const version of versions) {
      const elapsed = await timed(queries[version]);
      if (n >= 2) samples[version].push(elapsed);
    }
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { samplesMs: values.map(value => Math.round(value * 10) / 10), medianMs: sorted[Math.floor(sorted.length / 2)],
      minMs: sorted[0], maxMs: sorted.at(-1) };
  };
  async function plan(query: CapturedReviewWaitQuery) {
    return (await db!.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${query.sql}`, query.params as never[]).values()).map(row => row[0]);
  }
  const counts = (await db.$client.unsafe(`select (select count(*) from heartbeat_runs)::int runs,
    (select count(*) from chat_actions)::int actions, pg_size_pretty(pg_total_relation_size('heartbeat_runs')) runs_size`))[0];
  console.log(JSON.stringify({ baselineRevision, treatmentRevision,
    treatmentDiff: execFileSync("git", ["diff", "HEAD", "--", modulePath], { cwd: root, encoding: "utf8" }),
    postgresVersion: (await db.$client.unsafe("SELECT version()"))[0]!.version,
    fixture: { ...fixture, ...counts, seedMs: Math.round(seedMs), mainCompany: main.company, synthetic: true },
    correctness: { completeOutputEqual: true, rows: before.length },
    timings: { warmups: 2, samples: iterations, order: "alternating", baseline: stats(samples.baseline), treatment: stats(samples.treatment) },
    plans: { baseline: await plan(queries.baseline), treatment: await plan(queries.treatment) },
    generatedQueries: { baseline: queries.baseline, treatment: queries.treatment },
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
