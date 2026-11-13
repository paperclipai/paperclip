import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  companies,
  agents,
  issues,
  createDb,
  startEmbeddedPostgresTestDatabase
} from "../packages/db/src/index.js";
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8) ?? "baseline";
assert.ok(phase === "baseline" || phase === "treatment", "--phase must be baseline or treatment");
const ANCHOR_MS = Date.parse("2026-10-19T00:00:00.000Z");
const SINCE_MS = ANCHOR_MS - 24 * 60 * 6e4;
const PROMPT_KIB = 144;
function mulberry32(seed2) {
  return () => {
    seed2 |= 0;
    seed2 = seed2 + 1831565813 | 0;
    let t = Math.imul(seed2 ^ seed2 >>> 15, 1 | seed2);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(1346457664);
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(rand() * 4)]}${hex(3)}-${hex(12)}`;
const prompt = Buffer.from(
  Array.from({ length: PROMPT_KIB * 1024 }, () => Math.floor(rand() * 256))
).toString("base64");
const iso = (ms) => new Date(ms).toISOString();
async function seed(db) {
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
  const conversationIssueIds = [];
  const issueIdsA = [];
  for (let n = 0; n < 50; n++) {
    const issueId = uuid();
    if (n < 45) conversationIssueIds.push(issueId);
    issueIdsA.push(issueId);
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: `Fixture issue A${n}` });
  }
  const conversationIssueIdsB = [];
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
  const nativeRunIds = [];
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
  for (let start = 0; start < 2400; start += 400) {
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
function recordingDb(db, sink) {
  return new Proxy(db, {
    get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields) => {
        const builder = target.select(...fields);
        const from = builder.from.bind(builder);
        builder.from = (...args) => {
          const selection = from(...args);
          const execute = selection.execute.bind(selection);
          selection.execute = async () => {
            const captured = selection.toSQL();
            sink.push({ sql: captured.sql, params: captured.params });
            return execute();
          };
          return selection;
        };
        return builder;
      };
    }
  });
}
async function capture(db) {
  const sink = [];
  const module = await import("../server/src/services/chat-run-publications.js");
  await module.enqueueChatRunMilestones(recordingDb(db, sink), {
    since: new Date(SINCE_MS),
    limit: 200
  });
  const milestone = sink.find(
    (q) => q.sql.startsWith('select "heartbeat_runs"."id", "heartbeat_runs"."status"') && q.sql.includes('inner join "chat_conversations"')
  );
  const native = sink.find((q) => q.sql.startsWith('select "heartbeat_run_events"."id", "heartbeat_run_events"."seq"'));
  assert.ok(milestone, "milestone candidate query was not captured");
  assert.ok(native, "native progress candidate query was not captured");
  assert.match(milestone.sql, /chat_conversations/, "milestone query lacks the conversations join");
  assert.match(native.sql, /chat_conversations/, "native query lacks the conversations join");
  return { milestone, native };
}
async function measureOnce(client, query) {
  const start = performance.now();
  const rows = await client.unsafe(query.sql, query.params).values();
  return { ms: performance.now() - start, rows };
}
async function measure(client, query, rounds = 7) {
  const samples = [];
  let rows = [];
  for (let round = 0; round < rounds; round++) {
    const result = await measureOnce(client, query);
    rows = result.rows;
    if (round >= 2) samples.push(result.ms);
  }
  const [plan] = await client.unsafe(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
    query.params
  );
  samples.sort((a, b) => a - b);
  return { samples, rows, plan };
}
const normalize = (value) => value instanceof Date ? { __date: value.toISOString() } : Array.isArray(value) ? value.map(normalize) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)])) : value;
function planSummary(plan) {
  const nodes = [];
  const wrapped = plan?.["QUERY PLAN"];
  const raw = wrapped ?? plan;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  const planNode = root?.["Plan"] ?? root;
  assert.ok(planNode, "explain plan lacks a Plan node");
  const walk = (node) => {
    nodes.push({
      node_type: node["Node Type"],
      actual_rows: node["Actual Rows"],
      loops: node["Actual Loops"] ?? 1,
      shared_hit: node["Shared Hit Blocks"],
      shared_read: node["Shared Read Blocks"]
    });
    for (const child of node["Plans"] ?? []) walk(child);
  };
  walk(planNode);
  return { root_node: planNode?.["Node Type"], node_count: nodes.length, nodes: nodes.slice(0, 12) };
}
const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const keepAlive = setInterval(() => {
}, 1e3);
let database;
const databases = [];
async function withDatabase(fn) {
  database = await startEmbeddedPostgresTestDatabase(`chat-poll-bench-${phase}-`);
  databases.push(database);
  const db = createDb(database.connectionString);
  try {
    return await fn(db);
  } finally {
    await db.$client.end();
    await database.cleanup();
  }
}
try {
  const scratchDir = path.join(fileURLToPath(new URL("../.scratch/", import.meta.url)));
  await fs.mkdir(scratchDir, { recursive: true });
  const baselinePath = path.join(scratchDir, "chat-native-progress-baseline.json");
  const reportPath = path.join(scratchDir, "chat-native-progress-report.json");
  const captured = await withDatabase((db) => seed(db).then(() => capture(db)));
  if (phase === "baseline") {
    const result = await withDatabase(async (db) => {
      await seed(db);
      const milestone = await measure(db.$client, captured.milestone);
      const native = await measure(db.$client, captured.native);
      return { milestone, native };
    });
    const payload = {
      anchor: new Date(ANCHOR_MS).toISOString(),
      since: new Date(SINCE_MS).toISOString(),
      promptKiB: PROMPT_KIB,
      fixture: {
        conversationIssues: 45,
        candidateRunsPerIssue: 2,
        decoyRuns: 2400,
        crossCompanyDecoys: 100,
        nativeRunsWithEvents: 45
      },
      milestone: {
        sql: captured.milestone.sql,
        params: captured.milestone.params,
        samples: result.milestone.samples,
        medianMs: median(result.milestone.samples),
        rows: normalize(result.milestone.rows),
        plan: planSummary(result.milestone.plan),
        fullPlan: result.milestone.plan
      },
      native: {
        sql: captured.native.sql,
        params: captured.native.params,
        samples: result.native.samples,
        medianMs: median(result.native.samples),
        rows: normalize(result.native.rows),
        plan: planSummary(result.native.plan),
        fullPlan: result.native.plan
      }
    };
    await fs.writeFile(baselinePath, JSON.stringify(payload, null, 2));
    console.log(
      JSON.stringify(
        {
          phase,
          milestone: {
            medianMs: payload.milestone.medianMs,
            samples: payload.milestone.samples,
            rows: result.milestone.rows.length,
            plan: payload.milestone.plan.root_node
          },
          native: {
            medianMs: payload.native.medianMs,
            samples: payload.native.samples,
            rows: result.native.rows.length,
            plan: payload.native.plan.root_node
          }
        },
        null,
        2
      )
    );
  } else {
    const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
    const report = await withDatabase(async (db) => {
      await seed(db);
      const client = db.$client;
      const pairs = {
        milestone: { baseline: { sql: baseline.milestone.sql, params: baseline.milestone.params }, treatment: captured.milestone },
        native: { baseline: { sql: baseline.native.sql, params: baseline.native.params }, treatment: captured.native }
      };
      const measurements = {
        milestone: { baseline: [], treatment: [] },
        native: { baseline: [], treatment: [] }
      };
      const rows = {
        milestone: { baseline: [], treatment: [] },
        native: { baseline: [], treatment: [] }
      };
      for (let round = 0; round < 7; round++) {
        for (const name of ["milestone", "native"]) {
          const order = round % 2 === 0 ? ["baseline", "treatment"] : ["treatment", "baseline"];
          for (const side of order) {
            const query = pairs[name][side];
            const result = await measureOnce(client, query);
            rows[name][side] = result.rows;
            if (round >= 2) measurements[name][side].push(result.ms);
          }
        }
      }
      const plans = {
        milestone: { baseline: null, treatment: null },
        native: { baseline: null, treatment: null }
      };
      for (const name of ["milestone", "native"]) {
        for (const side of ["baseline", "treatment"]) {
          const [plan] = await client.unsafe(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${pairs[name][side].sql}`,
            pairs[name][side].params
          );
          plans[name][side] = planSummary(plan);
        }
      }
      return { measurements, rows, plans };
    });
    for (const name of ["milestone", "native"]) {
      assert.deepEqual(
        normalize(report.rows[name].treatment),
        normalize(report.rows[name].baseline),
        `${name} poll rows changed between baseline and treatment`
      );
      assert.equal(
        report.rows[name].baseline.length,
        baseline[name].rows.length,
        `${name} poll baseline cardinality drifted across fixtures`
      );
      if (name === "native") assert.ok(report.rows[name].baseline.length > 0, "native equality must cover actual rows");
    }
    const summary = {};
    for (const name of ["milestone", "native"]) {
      for (const side of ["baseline", "treatment"]) {
        summary[`${name}:${side}`] = {
          medianMs: median(report.measurements[name][side]),
          samples: report.measurements[name][side],
          rows: report.rows[name][side].length
        };
      }
    }
    const output = {
      phase,
      fixture: {
        promptKiB: PROMPT_KIB,
        windowHours: 24,
        decoyRuns: 2400,
        crossCompanyDecoys: 100
      },
      summary,
      plans: report.plans,
      speedup: {
        milestone: summary["milestone:baseline"].medianMs / summary["milestone:treatment"].medianMs,
        native: summary["native:baseline"].medianMs / summary["native:treatment"].medianMs
      },
      equalRows: true
    };
    await fs.writeFile(reportPath, JSON.stringify(output, null, 2));
    console.log(JSON.stringify({ ...output, plans: void 0 }, null, 2));
  }
} finally {
  clearInterval(keepAlive);
  for (const database2 of databases) {
    await database2.cleanup().catch(() => {
    });
  }
}
