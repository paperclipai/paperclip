import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { readGitHubResponseRun } from "../server/src/services/chat-channels/github/response-run-state.js";

const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const number = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const fixture = {
  agents: number("BENCH_AGENTS", 4),
  runsPerAgent: number("BENCH_RUNS_PER_AGENT", 7_750),
  issues: number("BENCH_ISSUES", 2_000),
  requests: number("BENCH_REQUESTS", 300),
  contextPadBytes: number("BENCH_CONTEXT_PAD_BYTES", 61_440),
};
const iterations = number("BENCH_ITERATIONS", 7);
const sampleInputs = number("BENCH_SAMPLE_INPUTS", 20);
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const modulePath = "server/src/services/chat-channels/github/response-run-state.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let baselineDir: string | undefined;
type Input = Parameters<typeof readGitHubResponseRun>[1];

async function seed(db: Db) {
  const sql = db.$client;
  const [{ company }] = await sql.unsafe(`insert into companies (name, issue_prefix) values ('Bench', 'BN') returning id as company`);
  const agentRows = await sql.unsafe(`insert into agents (company_id, name) select $1, 'Agent ' || n from generate_series(1, ${fixture.agents}) n
    returning id`, [company]);
  const agentIds = agentRows.map(row => row.id as string);
  const [{ application }] = await sql.unsafe(`insert into tool_applications (company_id, application_key, name, type)
    values ($1, 'github', 'GitHub', 'chat') returning id as application`, [company]);
  const [{ connection }] = await sql.unsafe(`insert into tool_connections (company_id, application_id, name, uid, transport, connection_purpose)
    values ($1, $2, 'GitHub', 'github-bench', 'chat_sdk', 'channel') returning id as connection`, [company, application]);
  const [{ endpoint }] = await sql.unsafe(`insert into chat_endpoints (company_id, connection_id, provider, public_id, assigned_agent_id, status)
    values ($1, $2, 'github', 'bench', $3, 'active') returning id as endpoint`, [company, connection, agentIds[0]]);
  await sql.unsafe(`create unlogged table bench_issue (n int primary key, id uuid)`);
  await sql.unsafe(`with created as (insert into issues (company_id, title, status)
      select $1, 'Issue ' || n, 'in_progress' from generate_series(1, ${fixture.issues}) n returning id, title)
    insert into bench_issue select (regexp_replace(title, '\\D', '', 'g'))::int, id from created`, [company]);
  await sql.unsafe(`insert into chat_conversations (company_id, endpoint_id, issue_id, external_conversation_id, external_label, external_thread_id)
    select $1, $2, i.id, 'github:paperclipai/paperclip:' || i.n, 'PR #' || i.n, 'github:paperclipai/paperclip:' || i.n
    from bench_issue i where i.n <= ${fixture.requests}`, [company, endpoint]);
  await sql.unsafe(`insert into chat_deliveries (company_id, endpoint_id, provider_event_id, deduplication_key, event_kind,
      normalized_event, conversation_id, state)
    select $1, $2, 'event-' || i.n, 'dedupe-' || i.n, 'message', '{}', c.id, 'processed'
    from bench_issue i join chat_conversations c on c.issue_id = i.id`, [company, endpoint]);
  await sql.unsafe(`insert into issue_comments (company_id, issue_id, body)
    select $1, i.id, 'Request ' || i.n from bench_issue i where i.n <= ${fixture.requests}`, [company]);
  await sql.unsafe(`insert into chat_message_links (company_id, endpoint_id, conversation_id, delivery_id, comment_id, provider_message_id, direction)
    select $1, $2, c.id, d.id, ic.id, 'IC_in_' || i.n, 'inbound'
    from bench_issue i join chat_conversations c on c.issue_id = i.id join chat_deliveries d on d.conversation_id = c.id
      join issue_comments ic on ic.issue_id = i.id`, [company, endpoint]);
  await sql.unsafe(`create unlogged table bench_agent (n int primary key, id uuid)`);
  for (const [index, id] of agentIds.entries()) await sql.unsafe(`insert into bench_agent values ($1, $2)`, [index, id]);
  for (let batch = 0; batch < fixture.agents * fixture.runsPerAgent; batch += 1_000) {
    await sql.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, scope_kind, issue_id, native_issue_id, context_snapshot, created_at)
      select $1, a.id, case when r % 9 = 0 then 'running' else 'succeeded' end,
        case when abs(hashint4(r + 31)::bigint) % 2 = 0 then 'issue' else 'company' end,
        case when abs(hashint4(r + 31)::bigint) % 2 = 0 then i.id end, case when abs(hashint4(r + 31)::bigint) % 2 = 0 then i.id end,
        jsonb_build_object('issueId', i.id::text,
          'wakeCommentId', (select ic.id::text from issue_comments ic where ic.issue_id = i.id and r % 3 = 0),
          'wakeCommentIds', case when r % 5 = 0 then (select jsonb_agg(ic.id::text) from issue_comments ic where ic.issue_id = i.id) end,
          'pad', (select string_agg(md5(random()::text || g::text || r::text), '') from generate_series(1, ${Math.ceil(fixture.contextPadBytes / 32)}) g)),
        timestamptz '2026-01-01' + r * interval '1 minute'
      from generate_series($2::int, $3::int) r
        join bench_agent a on a.n = abs(hashint4(r + 17)::bigint) % ${fixture.agents}
        join bench_issue i on i.n = 1 + abs(hashint4(r)::bigint) % ${fixture.issues}`,
    [company, batch, Math.min(batch + 999, fixture.agents * fixture.runsPerAgent - 1)]);
  }
  const requests = await sql.unsafe(`select i.id as issue, d.id as delivery, ic.id as comment from bench_issue i
    join chat_conversations c on c.issue_id = i.id join chat_deliveries d on d.conversation_id = c.id
    join issue_comments ic on ic.issue_id = i.id order by i.n`);
  await sql.unsafe("drop table bench_issue; drop table bench_agent");
  const inputs: Input[] = requests.flatMap(row => agentIds.slice(0, 2).map(agentId => ({ companyId: company as string,
    endpointId: endpoint as string, agentId, issueId: row.issue as string, deliveryId: row.delivery as string,
    sourceMessageId: row.comment as string })));
  return { company, inputs };
}

try {
  const oldSource = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
  const moduleUrl = new URL(`../${modulePath}`, import.meta.url);
  baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.response-run-state-baseline-"));
  const baselineFile = path.join(baselineDir, "response-run-state.ts");
  await fs.writeFile(baselineFile, oldSource.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`));
  const baseline = await import(pathToFileURL(baselineFile).href) as typeof import("../server/src/services/chat-channels/github/response-run-state.js");
  temporary = await startEmbeddedPostgresTestDatabase("github-response-run-state-benchmark-");
  db = createDb(temporary.connectionString);
  const seedStart = performance.now();
  const { company, inputs } = await seed(db);
  await db.$client.unsafe("ANALYZE");
  const seedMs = performance.now() - seedStart;

  const before = [], after = [];
  for (const input of inputs) {
    before.push(await baseline.readGitHubResponseRun(db, input));
    after.push(await readGitHubResponseRun(db, input));
  }
  assert.deepEqual(after, before, "Every input must return the same latest run and ownership");
  const outcomes = { owns: before.filter(result => result.ownsLatestRequest).length,
    latestNotOwned: before.filter(result => result.latestRun && !result.ownsLatestRequest).length,
    noRun: before.filter(result => !result.latestRun).length };

  const withRuns = inputs.filter((_, index) => before[index]!.latestRun);
  const sample = withRuns.filter((_, index) => index % Math.max(1, Math.floor(withRuns.length / sampleInputs)) === 0).slice(0, sampleInputs);
  const sampledAgents = new Set(sample.map(input => input.agentId)).size;
  const versions = { baseline: baseline.readGitHubResponseRun, treatment: readGitHubResponseRun };
  async function timed(version: keyof typeof versions) {
    const start = performance.now();
    for (const input of sample) await versions[version](db!, input);
    return (performance.now() - start) / sample.length;
  }
  const samples = { baseline: [] as number[], treatment: [] as number[] };
  for (let n = 0; n < iterations + 2; n++) {
    const order = n % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const;
    for (const version of order) {
      const elapsed = await timed(version);
      if (n >= 2) samples[version].push(elapsed);
    }
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { perCallMs: values.map(value => Math.round(value * 100) / 100), medianMs: sorted[Math.floor(sorted.length / 2)],
      minMs: sorted[0], maxMs: sorted.at(-1) };
  };

  const captured: Record<keyof typeof versions, Array<{ sql: string; params: unknown[] }>> = { baseline: [], treatment: [] };
  for (const version of Object.keys(versions) as Array<keyof typeof versions>) {
    const proxy = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const selection = from(...args), execute = selection.execute.bind(selection);
          selection.execute = (async () => { captured[version].push(selection.toSQL()); return execute(); }) as typeof selection.execute;
          return selection;
        }) as typeof builder.from;
        return builder;
      };
    } });
    await versions[version](proxy as Db, sample[0]!);
  }
  async function plan(query: { sql: string; params: unknown[] }) {
    return (await db!.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${query.sql}`, query.params as never[]).values()).map(row => row[0]);
  }
  const counts = (await db.$client.unsafe(`select (select count(*) from heartbeat_runs)::int runs,
    pg_size_pretty(pg_total_relation_size('heartbeat_runs')) runs_size,
    (select count(*) from heartbeat_runs where agent_id = $1)::int runs_of_sampled_agent`, [sample[0]!.agentId]))[0];
  console.log(JSON.stringify({ baselineRevision, treatmentRevision,
    postgresVersion: (await db.$client.unsafe("SELECT version()"))[0]!.version,
    fixture: { ...fixture, ...counts, seedMs: Math.round(seedMs), company, synthetic: true },
    correctness: { completeOutputEqual: true, inputs: inputs.length, outcomes },
    timings: { warmups: 2, samples: iterations, inputsPerSample: sample.length, sampledAgents, order: "alternating", unit: "ms per readGitHubResponseRun call",
      baseline: stats(samples.baseline), treatment: stats(samples.treatment) },
    statementsPerCall: { baseline: captured.baseline.length, treatment: captured.treatment.length },
    plans: { baseline: await Promise.all(captured.baseline.map(plan)), treatment: await Promise.all(captured.treatment.map(plan)) },
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
