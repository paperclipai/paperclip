import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { companies, agents, issues, applyPendingMigrations, createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import * as treatment from "../server/src/services/chat-run-publications.js";

type Query = { sql: string; params: unknown[] };
const dockerPostgres = process.argv.includes("--docker-postgres=17");
const correctnessOnly = process.argv.includes("--correctness-only");
const cursorWindow = process.argv.includes("--cursor-window");
const historyRuns = cursorWindow ? 12_000 : 2_400;
const denseChat = process.argv.includes("--dense-chat");
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass a pinned pre-fix --baseline-ref=<commit>");
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const ANCHOR_MS = Date.parse("2026-10-19T00:00:00.000Z");
const SINCE_MS = ANCHOR_MS - 24 * 60 * 6e4;
const PROMPT_KIB = cursorWindow ? 6 : 144;
function mulberry32(seed2: number) {
  return () => {
    seed2 |= 0;
    seed2 = seed2 + 1831565813 | 0;
    let t = Math.imul(seed2 ^ seed2 >>> 15, 1 | seed2);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(1346457664);
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(rand() * 4)]}${hex(3)}-${hex(12)}`;
const prompt = Buffer.from(
  Array.from({ length: PROMPT_KIB * 1024 }, () => Math.floor(rand() * 256))
).toString("base64");
const iso = (ms: number) => new Date(ms).toISOString();
async function seed(db: Db) {
  const companyA = uuid();
  const companyB = uuid();
  const agentA = uuid();
  const agentB = uuid();
  const endpointA = uuid();
  const endpointB = uuid();
  await db.insert(companies).values([
    { id: companyA, name: "Synthetic chat polls A", issuePrefix: "BENCH" },
    { id: companyB, name: "Synthetic chat polls B", issuePrefix: "BNCH" }
  ]);
  await db.insert(agents).values([
    { id: agentA, companyId: companyA, name: "Fixture A", adapterType: "codex_local" },
    { id: agentB, companyId: companyB, name: "Fixture B", adapterType: "codex_local" }
  ]);
  const conversationIssueIds: string[] = [];
  const issueIdsA: string[] = [];
  for (let n = 0; n < 50; n++) {
    const issueId = uuid();
    if (n < 45) conversationIssueIds.push(issueId);
    issueIdsA.push(issueId);
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: `Fixture issue A${n}` });
  }
  const conversationIssueIdsB: string[] = [];
  for (let n = 0; n < 10; n++) {
    const issueId = uuid();
    conversationIssueIdsB.push(issueId);
    await db.insert(issues).values({ id: issueId, companyId: companyB, title: `Fixture issue B${n}` });
  }
  for (const [companyId, endpointId, agentId, ids, label] of [
    [companyA, endpointA, agentA, conversationIssueIds, "A"],
    [companyB, endpointB, agentB, conversationIssueIdsB, "B"]
  ]) {
    const applicationId = uuid();
    const connectionId = uuid();
    await db.$client.unsafe(
      `INSERT INTO tool_applications
        (id, company_id, name, type, status)
       VALUES ($1::uuid, $2::uuid, $3, 'chat', 'active')`,
      [applicationId, companyId, `fixture-app-${label}`]
    );
    await db.$client.unsafe(
      `INSERT INTO tool_connections
        (id, company_id, application_id, name, uid, connection_purpose, transport, status, enabled)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'channel', 'chat_sdk', 'active', true)`,
      [connectionId, companyId, applicationId, `fixture-connection-${label}`, `fixture-conn-${label}`]
    );
    await db.$client.unsafe(
      `INSERT INTO chat_endpoints
        (id, company_id, connection_id, provider, public_id, publication_mode, assigned_agent_id, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'slack', $4, 'automatic', $5::uuid, 'active')`,
      [endpointId, companyId, connectionId, `fixture-endpoint-${label}`, agentId]
    );
    await db.$client.unsafe(
      `INSERT INTO chat_conversations
        (id, company_id, endpoint_id, issue_id, external_conversation_id, external_label, state)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, issue::uuid, 'conv-' || n, 'Conv ${label} ' || n,
         CASE WHEN n % 9 = 0 THEN 'waiting' WHEN n % 11 = 0 THEN 'completed' ELSE 'active' END
       FROM (SELECT issue, row_number() OVER () AS n FROM unnest($3::uuid[]) AS issue) sub`,
      [companyId, endpointId, ids]
    );
  }
  const nativeRunIds: string[] = [];
  const convRowsA = conversationIssueIds.map((issue, n) => ({ issue, n }));
  for (const { issue, n } of convRowsA) {
    const nativeRunId = uuid();
    nativeRunIds.push(nativeRunId);
    const base = ANCHOR_MS - n % 40 * 6e4;
    await db.$client.unsafe(
      `INSERT INTO heartbeat_runs
        (id, company_id, agent_id, scope_kind, issue_id, runtime_mode, status, error_code, created_at, updated_at, context_snapshot, result_json)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'issue', $4::uuid, 'native', 'running', NULL, $5, $5,
         jsonb_build_object('issueId', $4::text, 'source', 'chat:slack:fixture', 'prompt', $6::text), NULL)`,
      [nativeRunId, companyA, agentA, issue, iso(base), prompt]
    );
    await db.$client.unsafe(
      `INSERT INTO heartbeat_runs
        (id, company_id, agent_id, scope_kind, runtime_mode, status, error_code, created_at, updated_at, context_snapshot, result_json)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'company', 'legacy',
         CASE WHEN $4 % 5 = 0 THEN 'failed' WHEN $4 % 7 = 0 THEN 'succeeded' ELSE 'running' END,
         CASE WHEN $4 % 5 = 0 THEN 'execution_reconciliation_required' END, $5, $5,
         jsonb_build_object('issueId', $6::text, 'source', 'chat:slack:fixture', 'prompt', $7::text),
         CASE WHEN $4 % 7 = 0 THEN jsonb_build_object('presentationDecision', jsonb_build_object('kind', 'fixture')) END)`,
      [uuid(), companyA, agentA, n, iso(base), issue, prompt]
    );
    await db.$client.unsafe(
      `INSERT INTO chat_publications
        (company_id, endpoint_id, conversation_id, issue_id, idempotency_key, payload, state, created_at)
       VALUES ($1::uuid, $2::uuid,
         (SELECT id FROM chat_conversations WHERE company_id = $1::uuid AND issue_id = $4::uuid LIMIT 1),
         $4::uuid, 'run:' || $3::text || ':working:' || $2::text,
         jsonb_build_object('classification', 'external', 'source', 'safe_milestone', 'text', 'working'),
         'streaming', $5)`,
      [companyA, endpointA, nativeRunId, issue, iso(base - 12e4)]
    );
    await db.$client.unsafe(
      `INSERT INTO heartbeat_run_events
        (company_id, run_id, agent_id, seq, event_type, message, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'workspace.ready', 'ready', $4),
              ($1::uuid, $2::uuid, $3::uuid, 2, 'tool.execution.started', 'tool', $5)`,
      [companyA, nativeRunId, agentA, iso(base + 3e4), iso(base + 45e3)]
    );
  }
  for (const [n, issue] of conversationIssueIdsB.entries()) {
    const runId = uuid();
    const base = ANCHOR_MS - n % 10 * 6e4;
    await db.$client.unsafe(
      `INSERT INTO heartbeat_runs
        (id, company_id, agent_id, scope_kind, issue_id, runtime_mode, status, error_code, created_at, updated_at, context_snapshot)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'issue', $4::uuid, 'native', 'running', NULL, $5, $5,
         jsonb_build_object('issueId', $4::text, 'source', 'chat:slack:fixture', 'prompt', $6::text))`,
      [runId, companyB, agentB, issue, iso(base), prompt]
    );
  }
  for (let start = 0; start < historyRuns; start += 400) {
    if (cursorWindow) {
      await db.$client.unsafe(`insert into heartbeat_runs
        (company_id, agent_id, scope_kind, issue_id, native_issue_id, runtime_mode, status, created_at, updated_at, context_snapshot)
        select $1::uuid, $2::uuid, 'issue', $3::uuid, $3::uuid, 'native', 'running',
          $4::timestamptz - (12001 - n) * interval '50 milliseconds',
          $4::timestamptz - (12001 - n) * interval '50 milliseconds',
          jsonb_build_object('issueId', $3::text, 'source', 'chat:slack:fixture', 'fixtureHistory', true, 'prompt', $5::text)
        from generate_series(${start + 1}, ${start + 400}) n`,
        [companyA, agentA, conversationIssueIds[0], iso(ANCHOR_MS), prompt]);
      continue;
    }
    await db.$client.unsafe(
      `INSERT INTO heartbeat_runs
        (company_id, agent_id, scope_kind, status, error_code, created_at, updated_at, context_snapshot)
       SELECT $1::uuid, $2::uuid, 'company',
         (ARRAY['queued','running','succeeded','interrupted','failed','timed_out','cancelled'])[(n % 7) + 1],
         NULL,
         make_interval(hours => CASE WHEN n % 3 = 0 THEN -(30 + (n % 100)) ELSE -(n % 16) END, secs => -60) + $4::timestamptz,
         make_interval(hours => CASE WHEN n % 3 = 0 THEN -(30 + (n % 100)) ELSE -(n % 16) END, secs => -60) + $4::timestamptz,
         jsonb_build_object('issueId', gen_random_uuid()::text, 'source', 'chat:slack:fixture', 'prompt', $3::text)
       FROM generate_series(${start + 1}, ${start + 400}) n`,
      [companyA, agentA, prompt, iso(ANCHOR_MS)]
    );
  }
  await db.$client.unsafe(
    `INSERT INTO heartbeat_runs
      (company_id, agent_id, scope_kind, status, error_code, created_at, updated_at, context_snapshot)
     SELECT $1::uuid, $2::uuid, 'company',
       (ARRAY['queued','running','succeeded','interrupted','failed','timed_out','cancelled'])[(n % 7) + 1],
       NULL,
       make_interval(hours => CASE WHEN n % 3 = 0 THEN -(30 + (n % 100)) ELSE -(n % 16) END, secs => -60) + $4::timestamptz,
       make_interval(hours => CASE WHEN n % 3 = 0 THEN -(30 + (n % 100)) ELSE -(n % 16) END, secs => -60) + $4::timestamptz,
       jsonb_build_object('issueId', gen_random_uuid()::text, 'source', 'chat:slack:fixture', 'prompt', $3::text)
     FROM generate_series(1, 100) n`,
    [companyB, agentB, prompt, iso(ANCHOR_MS)]
  );
  await db.$client.unsafe(
    "UPDATE heartbeat_runs SET scope_kind = 'company', issue_id = NULL WHERE id = $1::uuid",
    [nativeRunIds[0]]
  );
  await db.$client.unsafe("ANALYZE heartbeat_runs");
  await db.$client.unsafe("ANALYZE chat_conversations");
  await db.$client.unsafe("ANALYZE heartbeat_run_events");
  await db.$client.unsafe("ANALYZE chat_publications");
  return { companyA, companyB };
}

async function makeDenseNativeChatHistory(db: Db) {
  // Bind the otherwise unrelated history through the first-class issue column.
  // Preserve existing bound/native runs and their progress publications so the
  // unchanged native progress query remains a nonempty control.
  await db.$client.unsafe(`with bindings as (
    select distinct on (company_id) company_id, issue_id
    from chat_conversations where state = 'active' order by company_id, id
  ) update heartbeat_runs r set scope_kind = 'issue', issue_id = b.issue_id,
    context_snapshot = jsonb_set(r.context_snapshot, '{issueId}', to_jsonb(b.issue_id::text))
    from bindings b where r.company_id = b.company_id
      and r.issue_id is null and r.native_issue_id is null and r.runtime_mode = 'legacy'`);
}

// Add real source comments so complete-result equality includes admitted rows,
// and conflicting native/legacy bindings cannot be hidden by an empty result.
async function seedSourceMessages(db: Db) {
  const conversations = await db.$client.unsafe("select id, company_id, endpoint_id, issue_id from chat_conversations");
  for (const conversation of conversations) {
    const commentId = uuid();
    await db.$client.unsafe("insert into issue_comments (id, company_id, issue_id, body) values ($1, $2, $3, 'synthetic inbound')", [commentId, conversation.company_id, conversation.issue_id]);
    await db.$client.unsafe(`insert into chat_message_links (company_id, endpoint_id, conversation_id, comment_id, provider_message_id, direction)
      values ($1, $2, $3, $4::uuid, $4::text, 'inbound')`, [conversation.company_id, conversation.endpoint_id, conversation.id, commentId]);
    await db.$client.unsafe(`update heartbeat_runs set context_snapshot = context_snapshot || jsonb_build_object('wakeCommentId', $1::text)
        || case when $4::boolean then jsonb_build_object('wakeCommentIds', coalesce(context_snapshot->'wakeCommentIds', '[]'::jsonb) || to_jsonb($1::text)) else '{}'::jsonb end
      where company_id = $2 and (issue_id = $3::uuid or context_snapshot->>'issueId' = $3::text)`, [commentId, conversation.company_id, conversation.issue_id, cursorWindow]);
  }
  await db.$client.unsafe("analyze heartbeat_runs");
  await db.$client.unsafe("analyze chat_message_links");
}
async function seedBindingCases(db: Db) {
  const [conversation] = await db.$client.unsafe(`select conversation.*, link.comment_id, endpoint.assigned_agent_id
    from chat_conversations conversation
    join chat_message_links link on link.conversation_id = conversation.id
    join chat_endpoints endpoint on endpoint.id = conversation.endpoint_id
    where conversation.state = 'active' order by conversation.id limit 1`);
  const [otherIssue] = await db.$client.unsafe("select id from issues where company_id = $1 and id <> $2 order by id limit 1", [conversation.company_id, conversation.issue_id]);
  const [foreignIssue] = await db.$client.unsafe("select id from issues where company_id <> $1 order by id limit 1", [conversation.company_id]);
  const issueId = conversation.issue_id as string;
  const context = { source: "chat:slack:fixture", issueId, wakeCommentId: conversation.comment_id };
  const cases = [
    { name: "legacy-issue", context, matches: true },
    { name: "trimmed-issue", context: { ...context, issueId: `  ${issueId}  ` }, matches: true },
    { name: "task-fallback", context: { ...context, issueId: " ", taskId: issueId }, matches: true },
    { name: "numeric-issue-fallback", context: { ...context, issueId: 2, taskId: issueId }, matches: true },
    { name: "object-issue-fallback", context: { ...context, issueId: { id: issueId }, taskId: issueId }, matches: true },
    { name: "array-issue-fallback", context: { ...context, issueId: [issueId], taskId: issueId }, matches: true },
    { name: "uppercase-legacy", context: { ...context, issueId: issueId.toUpperCase() }, matches: false },
    { name: "malformed-legacy", context: { ...context, issueId: "not-a-uuid", taskId: issueId }, matches: false },
    { name: "native-over-legacy", context: { ...context, issueId: "not-a-uuid" }, nativeIssueId: issueId, matches: true },
    { name: "issue-column-over-legacy", context: { ...context, issueId: "not-a-uuid" }, runIssueId: issueId, matches: true },
    { name: "native-over-issue-column", context, nativeIssueId: issueId, runIssueId: otherIssue.id, matches: true },
    { name: "foreign-native-over-local", context, nativeIssueId: foreignIssue.id, matches: false },
    { name: "null-context", context: null, matches: false },
    { name: "scalar-context", context: "chat:slack:fixture", matches: false },
    { name: "array-context", context: [context], matches: false },
  ];
  const expected = [];
  // Preserve stored legacy shapes: the insert trigger otherwise canonicalizes
  // uppercase JSON identifiers into the first-class UUID privacy binding.
  await db.$client.unsafe("alter table heartbeat_runs disable trigger heartbeat_runs_set_scope_kind");
  try { for (const item of cases) {
    const runId = uuid();
    await db.$client.unsafe(`insert into heartbeat_runs
      (id, company_id, agent_id, status, scope_kind, issue_id, native_issue_id, context_snapshot, created_at, updated_at)
      values ($1, $2, $3, 'queued', $4, $5, $6, $7::jsonb, $8, $8)`,
      [runId, conversation.company_id, conversation.assigned_agent_id, "runIssueId" in item ? "issue" : "company",
        "runIssueId" in item ? item.runIssueId : null, "nativeIssueId" in item ? item.nativeIssueId : null,
        JSON.stringify(item.context), iso(ANCHOR_MS - 1000)]);
    expected.push({ name: item.name, runId, matches: item.matches });
  }
  } finally { await db.$client.unsafe("alter table heartbeat_runs enable trigger heartbeat_runs_set_scope_kind"); }
  return expected;
}
async function capture(db: Db, module: typeof treatment): Promise<Record<string, Query>> {
  const queries: Query[] = [];
  const stop = new Error("captured");
  const captureDb = new Proxy(db, { get(target, key) {
    if (key !== "select") return Reflect.get(target, key);
    return (...fields: Parameters<Db["select"]>) => {
      const builder = target.select(...fields), from = builder.from.bind(builder);
      builder.from = ((...args: Parameters<typeof from>) => {
        const selection = from(...args);
        selection.execute = async () => {
          queries.push(selection.toSQL());
          if (queries.length === 2) throw stop;
          return [];
        };
        return selection;
      }) as typeof builder.from;
      return builder;
    };
  }});
  try { await module.enqueueChatRunMilestones(captureDb, { since: new Date(SINCE_MS), limit: cursorWindow ? 1 : 200 }); }
  catch (error) { if (error !== stop) throw error; }
  assert.equal(queries.length, 2, "capture both real candidate queries before any publication writes");
  return { milestone: queries[0], native: queries[1] };
}
type Cursor = { updatedAt: Date; runId: string; conversationId: string };
async function captureCursor(db: Db, module: typeof treatment, cursor: Cursor): Promise<Query> {
  let query: Query | undefined;
  let executions = 0;
  const stop = new Error("captured cursor statement");
  const captureDb = new Proxy(db, { get(target, key) {
    if (key !== "select") return Reflect.get(target, key);
    return (...fields: Parameters<Db["select"]>) => {
      const builder = target.select(...fields), from = builder.from.bind(builder);
      builder.from = ((...args: Parameters<typeof from>) => {
        const selection = from(...args);
        selection.execute = async () => {
          if (++executions === 2) { query = selection.toSQL(); throw stop; }
          // Advance only the real service's keyset loop. This non-publishable
          // placeholder page avoids resolving origins or writing publications.
          return Array.from({ length: 25 }, () => ({ runStatus: "benchmark_skip", runUpdatedAt: cursor.updatedAt,
            runId: cursor.runId, conversationId: cursor.conversationId }));
        };
        return selection;
      }) as typeof builder.from;
      return builder;
    };
  }});
  try { await module.enqueueChatRunMilestones(captureDb, { since: new Date(SINCE_MS), limit: 1 }); }
  catch (error) { if (error !== stop) throw error; }
  assert.ok(query, "real second-page service statement was not captured");
  return query;
}
async function seedCursorSibling(db: Db) {
  const [original] = await db.$client.unsafe(`select conversation.* from chat_conversations conversation
    join heartbeat_runs run on run.company_id = conversation.company_id and run.issue_id = conversation.issue_id
    where run.context_snapshot->>'fixtureHistory' = 'true' order by conversation.id limit 1`);
  await db.$client.unsafe(`insert into chat_conversations
    (id, company_id, endpoint_id, issue_id, external_conversation_id, external_label, state)
    values ($1, $2, $3, $4, 'cursor-sibling', 'Cursor sibling', 'active')`,
    [uuid(), original.company_id, original.endpoint_id, original.issue_id]);
}
async function selectLateCursor(db: Db, fraction = 0.9): Promise<Cursor> {
  const [row] = await db.$client.unsafe(`select chosen.updated_at, chosen.id as run_id, conversation.id as conversation_id
    from (select id, company_id, issue_id, updated_at from heartbeat_runs
      where context_snapshot->>'fixtureHistory' = 'true'
      order by updated_at, id offset ${Math.floor(historyRuns * fraction)} limit 1) chosen
    join chat_conversations conversation on conversation.company_id = chosen.company_id and conversation.issue_id = chosen.issue_id
    where conversation.state = 'active' order by conversation.id limit 1`);
  assert.ok(row);
  return { updatedAt: new Date(row.updated_at), runId: row.run_id, conversationId: row.conversation_id };
}
const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startDatabase>> | undefined;
let db: Db | undefined;
let baselineDir: string | undefined;
async function startDatabase() {
  if (!dockerPostgres) return startEmbeddedPostgresTestDatabase("chat-milestone-benchmark-");
  const container = `paperclip-chat-milestones-${randomUUID()}`;
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  docker("run", "--detach", "--rm", "--name", container, "--label", "paperclip.benchmark=chat-milestones", "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_USER=paperclip", "--env", "POSTGRES_PASSWORD=paperclip", "--env", "POSTGRES_DB=paperclip", "postgres:17");
  const cleanup = async () => { docker("rm", "--force", container); };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { docker("exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "paperclip"); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, "Disposable Docker PostgreSQL did not become ready");
    const port = docker("port", container, "5432/tcp").split(":").at(-1);
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);
    return { connectionString, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
try {
  database = await startDatabase();
  db = createDb(database.connectionString);
  const modulePath = "server/src/services/chat-run-publications.ts";
  const moduleUrl = new URL(`../${modulePath}`, import.meta.url);
  const oldSource = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
  const rewritten = oldSource.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`);
  baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".chat-milestone-baseline-"));
  const baselineFile = path.join(baselineDir, "chat-run-publications.ts");
  await fs.writeFile(baselineFile, rewritten);
  const baseline = await import(pathToFileURL(baselineFile).href) as typeof treatment;
  await seed(db);
  if (denseChat) await makeDenseNativeChatHistory(db);
  if (cursorWindow) await seedCursorSibling(db);
  await seedSourceMessages(db);
  const bindingCases = await seedBindingCases(db);
  const queries = { baseline: await capture(db, baseline), treatment: await capture(db, treatment) };
  const lateCursor = cursorWindow ? await selectLateCursor(db) : undefined;
  const nearTailCursor = cursorWindow ? await selectLateCursor(db, 0.9999) : undefined;
  let emptyCursor: Cursor | undefined;
  if (lateCursor) {
    queries.baseline.cursor = await captureCursor(db, baseline, lateCursor);
    queries.treatment.cursor = await captureCursor(db, treatment, lateCursor);
  }
  if (nearTailCursor) {
    queries.baseline.tail = await captureCursor(db, baseline, nearTailCursor);
    queries.treatment.tail = await captureCursor(db, treatment, nearTailCursor);
    const finalPage = await db.$client.unsafe(queries.baseline.tail.sql, queries.baseline.tail.params as never[]).values();
    assert.ok(finalPage.length > 0 && finalPage.length < 25, "tail cursor must produce a short final page");
    const last = finalPage.at(-1)!;
    emptyCursor = { updatedAt: new Date(last[3]), runId: last[0], conversationId: last[7] };
    queries.baseline.empty = await captureCursor(db, baseline, emptyCursor);
    queries.treatment.empty = await captureCursor(db, treatment, emptyCursor);
  }
  const results = [];
  for (const kind of cursorWindow ? ["milestone", "cursor", "tail", "empty", "native"] : ["milestone", "native"]) {
    const samples = { baseline: [] as number[], treatment: [] as number[] };
    const rows = { baseline: [] as unknown[], treatment: [] as unknown[] };
    for (let round = 0; round < (correctnessOnly ? 1 : 7); round++) {
      const order = round % 2 === 0 ? ["baseline", "treatment"] as const : ["treatment", "baseline"] as const;
      for (const side of order) {
        const query = queries[side][kind], start = performance.now();
        rows[side] = await db.$client.unsafe(query.sql, query.params as never[]).values();
        if (round >= 2) samples[side].push(performance.now() - start);
      }
      assert.deepEqual(rows.treatment, rows.baseline, `${kind}: complete ordered positional rows differ`);
    }
    if (kind === "milestone" && !denseChat && !cursorWindow) {
      const runIds = new Set(rows.treatment.map(row => (row as unknown[])[0]));
      for (const item of bindingCases) assert.equal(runIds.has(item.runId), item.matches, `binding semantics: ${item.name}`);
    }
    const expectedCursor = kind === "cursor" ? lateCursor : kind === "tail" ? nearTailCursor : undefined;
    if (expectedCursor) {
      const first = rows.treatment[0] as unknown[];
      assert.equal(first[0], expectedCursor.runId, "late page must preserve the other conversation for the same run");
      assert.ok(String(first[7]) > expectedCursor.conversationId);
    }
    if (kind === "empty") assert.equal(rows.treatment.length, 0, "finished cursor must produce an empty page");
    else assert.ok(rows.baseline.length > 0, `${kind}: equality must include actual candidates`);
    const plans: Record<string, unknown> = {};
    for (const side of ["baseline", "treatment"] as const) {
      const query = queries[side][kind];
      const [plan] = await db.$client.unsafe(`EXPLAIN (${correctnessOnly ? "" : "ANALYZE, BUFFERS, "}FORMAT JSON) ${query.sql}`, query.params as never[]);
      plans[side] = plan["QUERY PLAN"];
    }
    results.push({ kind, equalRows: rows.baseline.length, baselineMedianMs: median(samples.baseline), treatmentMedianMs: median(samples.treatment),
      speedup: median(samples.baseline) / median(samples.treatment), samples, plans });
  }
  const sourceHashes = Object.fromEntries(await Promise.all([
    "server/src/services/chat-run-publications.ts", "server/src/services/chat-run-milestone-candidates.ts", "scripts/benchmark-chat-milestones.ts",
  ].map(async file => [file, createHash("sha256").update(await fs.readFile(path.join(repositoryRoot, file))).digest("hex")])));
  const output = { sourceHashes, baselineRevision, treatmentRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    candidateSource: await fs.readFile(new URL("../server/src/services/chat-run-milestone-candidates.ts", import.meta.url), "utf8"),
    treatmentDiff: execFileSync("git", ["-C", repositoryRoot, "diff", "--", "server/src/services/chat-run-publications.ts"], { encoding: "utf8" }),
    postgres: await db.$client.unsafe("select version(), current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem"),
    fixture: { runs: historyRuns + 215, bindingCases, bindingCasesChecked: !denseChat && !cursorWindow, denseNativeChat: denseChat,
      cursorWindow, historyRuns, requestedLimit: cursorWindow ? 1 : 200, lateCursor, nearTailCursor, emptyCursor,
      conversationIssues: 55, promptKiB: PROMPT_KIB, windowHours: 24 }, queries, results };
  const reportPath = path.resolve(process.argv.find(arg => arg.startsWith("--report="))?.slice(9) ?? ".scratch/chat-milestones-report.json");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ reportPath, ...output, queries: undefined, treatmentDiff: undefined, candidateSource: undefined, results: results.map(({ plans, ...result }) => result) }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
