/**
 * Local proof for the batched chat authorization of external review waits.
 *
 * `listExternalReviewWaits` authorizes the chat conversation of every waiting
 * task on an issue page. The pre-fix module ran one bound-run authorization
 * per wait at the same time, so a page with N waits sent N copies of the
 * message-link statement (and N resource, principal, identity-link and
 * membership reads) on N pool connections at once. The fix reads the
 * messages of all waits with one statement and shares the policy reads.
 *
 * The pre-fix modules are loaded from --baseline-ref. The script fails unless
 * both versions return the same waits.
 *
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-chat-bound-authorization.ts --baseline-ref=<pre-fix commit>
 *
 * Optional sizes: WAITS (default 20), PEOPLE (5), NOISE_DELIVERIES (50000),
 * EVENT_KIB (6), POOL (10), PAIRS (15), CONCURRENT_PAGES (8).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { listExternalReviewWaits } from "../server/src/services/native-runtime/external-review-wait.js";
import { seedBoundChatAuthorization } from "../server/src/__tests__/helpers/bound-chat-authorization.js";

const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const WAITS = size("WAITS", 20), PEOPLE = size("PEOPLE", 5), NOISE_DELIVERIES = size("NOISE_DELIVERIES", 50_000);
const EVENT_KIB = size("EVENT_KIB", 6), POOL = size("POOL", 10), PAIRS = size("PAIRS", 15);
const CONCURRENT_PAGES = size("CONCURRENT_PAGES", 8);
for (const [name, value] of Object.entries({ WAITS, PEOPLE, NOISE_DELIVERIES, EVENT_KIB, POOL, PAIRS, CONCURRENT_PAGES })) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
}
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
const baselineRevision = git("rev-parse", "--verify", `${baselineRef}^{commit}`).trim();
const root = fileURLToPath(new URL("../", import.meta.url));
const modules = ["external-review-wait.ts", "chat-attachment-reuse.ts"];
const moduleDir = path.join(root, "server/src/services/native-runtime");

type List = typeof listExternalReviewWaits;
const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let baselineDir: string | undefined;
try {
  // Pre-fix copies of both modules. Their other relative imports resolve to
  // the current tree, which this change does not touch.
  baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.chat-authorization-baseline-"));
  for (const file of modules) {
    const source = git("show", `${baselineRevision}:server/src/services/native-runtime/${file}`)
      .replace(/from "(\.{1,2}\/[^"]+)"/g, (_match, specifier: string) =>
        specifier === "./chat-attachment-reuse.js" ? `from "./chat-attachment-reuse.ts"`
          : `from ${JSON.stringify(fileURLToPath(new URL(specifier, pathToFileURL(path.join(moduleDir, file)))))}`);
    await fs.writeFile(path.join(baselineDir, file), source);
  }
  const baseline = (await import(pathToFileURL(path.join(baselineDir, modules[0]!)).href) as
    { listExternalReviewWaits: List }).listExternalReviewWaits;

  temporary = await startEmbeddedPostgresTestDatabase("chat-authorization-benchmark-");
  db = createDb(temporary.connectionString, { maxConnections: POOL });
  const sql = db.$client;
  const f = await seedBoundChatAuthorization(db);
  const loadStart = performance.now();
  // People who write in the waiting conversations, each linked and a member.
  await sql.unsafe(`insert into chat_external_principals (id, company_id, provider, provider_account_id, external_id, kind)
    select gen_random_uuid(), $1::uuid, 'slack', 'guild-1', 'person-' || g, 'user' from generate_series(1, $2::int) g`,
  [f.companyId, PEOPLE]);
  await sql.unsafe(`insert into chat_identity_links (company_id, endpoint_id, principal_id, paperclip_user_id, status)
    select $1::uuid, $2::uuid, id, 'user-' || external_id, 'linked' from chat_external_principals
    where company_id = $1::uuid and external_id like 'person-%'`, [f.companyId, f.endpointId]);
  await sql.unsafe(`insert into company_memberships (company_id, principal_type, principal_id, status, membership_role)
    select $1::uuid, 'user', 'user-' || external_id, 'active', 'member' from chat_external_principals
    where company_id = $1::uuid and external_id like 'person-%'`, [f.companyId]);
  // WAITS tasks in review, each waiting for an external chat response.
  // Skip the work-assessment owner chain of the status decisions.
  await sql.begin(tx => tx.unsafe("set local session_replication_role = replica").then(() => tx.unsafe(`with w as (
      select g, gen_random_uuid() issue_id, gen_random_uuid() run_id, gen_random_uuid() decision_id,
        gen_random_uuid() conversation_id, gen_random_uuid() comment_id, gen_random_uuid() delivery_id,
        (select id from chat_external_principals where company_id = $1::uuid and external_id = 'person-' || (1 + g % $5::int)) principal_id
      from generate_series(1, $4::int) g),
    i as (insert into issues (id, company_id, title, status, assignee_agent_id, issue_number, identifier, last_status_decision_id)
      select issue_id, $1::uuid, 'wait ' || g, 'in_review', $2::uuid, 100 + g, 'RCB-' || (100 + g), decision_id from w),
    r as (insert into heartbeat_runs (id, company_id, agent_id, status, native_issue_id, context_snapshot)
      select run_id, $1::uuid, $2::uuid, 'succeeded', issue_id, jsonb_build_object('source', 'chat:slack',
        'paperclipHarnessCheckedOut', true, 'wakeCommentIds', jsonb_build_array(comment_id),
        'prompt', repeat('x', 4096)) from w),
    d as (insert into status_decisions (id, company_id, issue_id, run_id, assessment_id, decision_version, policy_version,
        from_status, to_status, reason_code, decision_json, decision_digest, application_state, applied_at)
      select decision_id, $1::uuid, issue_id, run_id, gen_random_uuid(), 1, 'v1', 'in_progress', 'in_review',
        'external_chat_response_waiting', '{}'::jsonb, md5(g::text), 'applied', now() from w),
    c as (insert into chat_conversations (id, company_id, endpoint_id, resource_id, issue_id, external_conversation_id,
        external_thread_id, external_label, state)
      select conversation_id, $1::uuid, $3::uuid, $6::uuid, issue_id, 'channel-1', 'wait-' || g, 'wait', 'waiting' from w),
    m as (insert into issue_comments (id, company_id, issue_id, author_type, author_user_id, body)
      select comment_id, $1::uuid, issue_id, 'user', 'u', 'Please check' from w),
    l as (insert into chat_deliveries (id, company_id, endpoint_id, conversation_id, principal_id, provider_event_id,
        deduplication_key, event_kind, state, normalized_event, processed_at)
      select delivery_id, $1::uuid, $3::uuid, conversation_id, principal_id, 'wait-' || g, 'wait-' || g, 'message',
        'processed', jsonb_build_object('message', jsonb_build_object('text', repeat('y', $7::int * 1024))), now() from w)
    insert into chat_message_links (company_id, endpoint_id, conversation_id, delivery_id, comment_id, provider_message_id, direction)
    select $1::uuid, $3::uuid, conversation_id, delivery_id, comment_id, 'wait-' || g, 'inbound' from w`,
  [f.companyId, f.agentId, f.endpointId, WAITS, PEOPLE, f.resourceId, EVENT_KIB])));
  // Chat history of the same endpoint on other tasks.
  await sql.unsafe(`insert into issues (company_id, title, status, assignee_agent_id, issue_number, identifier)
    select $1::uuid, 'history ' || g, 'done', $2::uuid, 10000 + g, 'RCB-' || (10000 + g) from generate_series(1, 2000) g`,
  [f.companyId, f.agentId]);
  await sql.unsafe(`insert into chat_conversations (company_id, endpoint_id, resource_id, issue_id, external_conversation_id,
      external_thread_id, external_label, state)
    select $1::uuid, $2::uuid, $3::uuid, i.id, 'channel-1', 'history-' || i.id, 'history', 'completed'
    from issues i where i.company_id = $1::uuid and i.title like 'history %'`, [f.companyId, f.endpointId, f.resourceId]);
  await sql.unsafe(`with c as (select id, issue_id, row_number() over (order by id) rn, count(*) over () n
      from chat_conversations where company_id = $1::uuid and external_label = 'history')
    insert into chat_deliveries (company_id, endpoint_id, conversation_id, principal_id, provider_event_id,
      deduplication_key, event_kind, state, normalized_event, processed_at)
    select $1::uuid, $2::uuid, c.id, $3::uuid, 'history-' || g, 'history-' || g, 'message', 'processed',
      jsonb_build_object('message', jsonb_build_object('text', (select string_agg(md5(random()::text || s.i || g), ' ')
        from generate_series(1, $4::int) s(i)))), now()
    from generate_series(1, $5::int) g join c on c.rn = 1 + (g % c.n)`,
  [f.companyId, f.endpointId, f.principalId, EVENT_KIB * 31, NOISE_DELIVERIES]);
  await sql.unsafe(`insert into issue_comments (id, company_id, issue_id, author_type, author_user_id, body)
    select d.id, $1::uuid, c.issue_id, 'user', 'u', 'history' from chat_deliveries d
    join chat_conversations c on c.id = d.conversation_id where d.provider_event_id like 'history-%'`, [f.companyId]);
  await sql.unsafe(`insert into chat_message_links (company_id, endpoint_id, conversation_id, delivery_id, comment_id,
      provider_message_id, direction)
    select $1::uuid, endpoint_id, conversation_id, id, id, provider_event_id, 'inbound'
    from chat_deliveries where provider_event_id like 'history-%'`, [f.companyId]);
  await sql.unsafe("vacuum analyze");
  const loadMs = performance.now() - loadStart;
  const issueIds = (await sql.unsafe(`select id from issues where company_id = $1::uuid and title like 'wait %' order by title`,
    [f.companyId])).map(row => row.id as string);
  // One waiting task that is no longer authorized: its person lost membership.
  await sql.unsafe(`update company_memberships set status = 'suspended' where company_id = $1::uuid and principal_id = 'user-person-1'`,
    [f.companyId]);

  const round = (value: number) => Number(value.toFixed(2));
  // Statements that one page sends, counted at the driver (prepared
  // templates are counted at each execution).
  const statementCounts = async (list: List) => {
    const client = sql as unknown as { unsafe: (query: string, ...rest: unknown[]) => unknown };
    const original = client.unsafe;
    const counts: Record<string, number> = {};
    let total = 0;
    const links: Array<{ query: string; params: unknown }> = [];
    client.unsafe = function (this: unknown, query: string, ...rest: unknown[]) {
      const table = /^select .*? from "([a-z_]+)"/s.exec(query)?.[1] ?? "other";
      if (table === "chat_message_links") links.push({ query, params: rest[0] });
      counts[table] = (counts[table] ?? 0) + 1;
      total += 1;
      return original.call(this, query, ...rest);
    };
    try { await list(db!, f.companyId, issueIds); } finally { client.unsafe = original; }
    // Server execution of the message-link statements of one page.
    let linkExecutionMs = 0;
    const nodes = new Set<string>();
    for (const statement of links) {
      const [row] = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`, statement.params as never[]);
      const [plan] = row!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown>; "Execution Time": number }>;
      linkExecutionMs += plan!["Execution Time"];
      const walk = (node: Record<string, unknown>) => {
        if (/Scan/.test(String(node["Node Type"]))) nodes.add(`${node["Node Type"]} ${node["Index Name"] ?? ""} on ${node["Relation Name"]}`.replace("  ", " "));
        for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
      };
      walk(plan!.Plan);
    }
    return { total, byTable: counts, linkStatements: { count: links.length,
      summedExecutionMs: round(linkExecutionMs), scans: [...nodes].sort() } };
  };

  const stats = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return { medianMs: round(sorted[Math.floor(sorted.length / 2)]!), minMs: round(sorted[0]!),
      maxMs: round(sorted.at(-1)!), samplesMs: samples.map(round) };
  };
  const time = async (run: () => Promise<unknown>) => {
    const start = performance.now();
    await run();
    return performance.now() - start;
  };
  const versions: Record<string, List> = { baseline, treatment: listExternalReviewWaits };
  const page = (list: List) => () => list(db!, f.companyId, issueIds);
  const pages = (list: List) => () => Promise.all(Array.from({ length: CONCURRENT_PAGES }, page(list)));

  const results = Object.fromEntries(await Promise.all(Object.entries(versions).map(async ([name, list]) =>
    [name, (await list(db!, f.companyId, issueIds)).map(wait => wait.issueId).sort()])));
  assert.deepEqual(results.treatment, results.baseline, "Both versions must return the same waits");
  // Every size works: count the waits of the suspended person from the data.
  const [{ denied }] = await sql.unsafe(`select count(*)::int denied from chat_deliveries d
    join chat_external_principals p on p.id = d.principal_id
    where d.company_id = $1::uuid and d.provider_event_id like 'wait-%' and p.external_id = 'person-1'`, [f.companyId]);
  assert.equal((results.baseline as string[]).length, WAITS - (denied as number),
    "Waits of the suspended person must be excluded");

  for (const list of Object.values(versions)) { await page(list)(); await pages(list)(); }
  const samples: Record<string, { page: number[]; concurrentPages: number[] }> = {
    baseline: { page: [], concurrentPages: [] }, treatment: { page: [], concurrentPages: [] } };
  for (let pair = 0; pair < PAIRS; pair++) {
    const order = pair % 2 === 0 ? ["baseline", "treatment"] : ["treatment", "baseline"];
    for (const name of order) samples[name]!.page.push(await time(page(versions[name]!)));
    for (const name of order) samples[name]!.concurrentPages.push(await time(pages(versions[name]!)));
  }
  const report: Record<string, unknown> = {};
  for (const [name, list] of Object.entries(versions)) {
    report[name] = {
      statements: await statementCounts(list),
      page: stats(samples[name]!.page),
      concurrentPages: stats(samples[name]!.concurrentPages),
    };
  }
  console.log(JSON.stringify({
    baselineRevision, treatmentRevision: git("rev-parse", "HEAD").trim(),
    postgresVersion: (await sql.unsafe("select version()"))[0]!.version,
    fixture: { synthetic: true, waits: WAITS, people: PEOPLE, noiseDeliveries: NOISE_DELIVERIES, eventKiB: EVENT_KIB,
      pool: POOL, concurrentPages: CONCURRENT_PAGES, pairs: PAIRS, loadMs: Math.round(loadMs),
      tableSizes: await sql.unsafe(`select relname as table, n_live_tup::int as rows, pg_size_pretty(pg_total_relation_size(relid)) as size
        from pg_stat_user_tables where relname in ('chat_message_links', 'chat_deliveries', 'chat_conversations') order by relname`) },
    correctness: { sameWaits: true, waits: (results.baseline as string[]).length, deniedWaits: WAITS - (results.baseline as string[]).length },
    results: report,
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
