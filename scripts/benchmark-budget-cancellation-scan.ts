// Measures the committed budget Stop scans with and without the partial index
// `heartbeat_runs_pending_budget_cancellation_idx`. The SQL is the same in both
// treatments; only that index is toggled, in a disposable database.
//
//   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-budget-cancellation-scan.ts [--runs=20000] [--payload-kib=16] [--reverse]
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { agents, companies, createDb, heartbeatRuns, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import {
  listPendingBudgetCancellationScopes,
  pendingBudgetRunCancellationExistsQuery,
  pendingBudgetRunIdsForScopeQuery,
} from "../server/src/services/heartbeat/budget-cancellation.js";

const { sql } = createRequire(new URL("../server/package.json", import.meta.url))("drizzle-orm") as typeof import("drizzle-orm");
const arg = (name: string, fallback: number) => Number(process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const runCount = arg("runs", 20_000);
const payloadKib = arg("payload-kib", 16);
const samples = arg("samples", 7);
const indexName = "heartbeat_runs_pending_budget_cancellation_idx";
const migrationDir = fileURLToPath(new URL("../packages/db/src/migrations/", import.meta.url));
const migrationFile = readdirSync(migrationDir).find(file => file.endsWith(".sql")
  && readFileSync(`${migrationDir}${file}`, "utf8").includes(`"${indexName}"`));
assert.ok(migrationFile, "The index migration was not found");
const createIndexSql = readFileSync(`${migrationDir}${migrationFile}`, "utf8").trim();

type Query = { sql: string; params: unknown[] };
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
try {
  database = await startEmbeddedPostgresTestDatabase("budget-cancellation-scan-benchmark-");
  db = createDb(database.connectionString);
  const [version] = await db.$client.unsafe("select version()");

  // Two tenants. Most runs carry an incompressible result JSON, so a scan must
  // read TOAST. A few runs carry committed Stops: pending, delivered, decoys.
  const companyIds = [randomUUID(), randomUUID()];
  const agentIds = [randomUUID(), randomUUID(), randomUUID()];
  await db.insert(companies).values(companyIds.map((id, n) => ({ id, name: `Budget scan ${n}`, issuePrefix: `BS${n}` })));
  await db.insert(agents).values(agentIds.map((id, n) => ({ id, companyId: companyIds[n % 2]!, name: `Agent ${n}`, adapterType: "process" })));
  const payload = randomBytes(payloadKib * 768).toString("base64");
  await db.$client.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, runtime_mode, created_at, updated_at, result_json)
    select case when n % 2 = 0 then $1::uuid else $2::uuid end, case when n % 2 = 0 then $3::uuid else $4::uuid end,
      (array['succeeded','failed','cancelled','timed_out'])[1 + n % 4], 'legacy',
      timestamptz '2026-10-01' + n * interval '1 second', timestamptz '2026-10-01' + n * interval '1 second',
      jsonb_build_object('summary', $5::text, 'stdoutExcerpt', left($5::text, 512))
    from generate_series(1, $6::int) n`, [companyIds[0], companyIds[1], agentIds[0], agentIds[1], payload, runCount]);
  const policyId = randomUUID();
  const intent = (companyId: string, scopeType: string, scopeId: string, extra: Record<string, unknown> = {}) =>
    ({ companyId, scopeType, scopeId, policyId, version: 3, ...extra });
  const special: Array<{ companyId: string; agentId: string; status: string; updatedAt: Date; resultJson: Record<string, unknown> }> = [];
  for (let n = 0; n < 40; n++) {
    const companyId = companyIds[n % 2]!, agentId = n % 2 === 0 ? agentIds[0]! : agentIds[1]!;
    const scopes: Array<[string, string]> = [["company", companyId], ["agent", agentId], ["agent", agentIds[2]!]];
    const [scopeType, scopeId] = scopes[n % 3]!;
    const extra = n % 5 === 0 ? { lastAttemptAt: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString() } : {};
    special.push({ companyId, agentId, status: n % 4 === 0 ? "cancelled" : "running", updatedAt: new Date(Date.UTC(2026, 10, 2, 0, n)),
      resultJson: { summary: payload, startupCancellation: {
        ...(n % 7 === 0 ? {} : { requestedAt: new Date(Date.UTC(2026, 10, 1, 1, 40 - n)).toISOString() }),
        budgetEnforcement: intent(companyId, scopeType, scopeId, extra) } } });
  }
  // Delivered Stops and malformed intents are not pending.
  for (let n = 0; n < 200; n++) special.push({ companyId: companyIds[n % 2]!, agentId: agentIds[n % 2]!, status: "cancelled",
    updatedAt: new Date(Date.UTC(2026, 10, 3, 0, 0, n)), resultJson: { summary: payload, startupCancellation: {
      budgetEnforcement: n % 10 === 0 ? "legacy-string" : intent(companyIds[n % 2]!, "company", companyIds[n % 2]!,
        { deliveredAt: new Date(Date.UTC(2026, 10, 3)).toISOString() }) } } });
  // An intent whose company does not match its run is returned by SQL and
  // filtered by the service; it must stay visible to both treatments.
  special.push({ companyId: companyIds[0]!, agentId: agentIds[0]!, status: "running", updatedAt: new Date(Date.UTC(2026, 10, 4)),
    resultJson: { startupCancellation: { budgetEnforcement: intent(companyIds[1]!, "company", companyIds[1]!) } } });
  await db.insert(heartbeatRuns).values(special.map(row => ({ ...row, runtimeMode: "legacy" })));
  await db.$client.unsafe("vacuum analyze heartbeat_runs");
  const [{ total_bytes: tableBytes }] = await db.$client.unsafe(`select pg_total_relation_size('heartbeat_runs')::bigint as total_bytes`);

  // Capture the SQL that the real service and its callers send.
  const captured: Query[] = [];
  let capturing = true;
  const session = Reflect.get(db, "session");
  const logger = { logQuery(query: string, params: unknown[]) { if (capturing) captured.push({ sql: query, params }); } };
  session.logger = logger; session.options.logger = logger;
  const queries: Array<{ name: string; query: Query }> = [];
  const captureOne = async (name: string, invoke: () => Promise<unknown>) => {
    captured.length = 0; await invoke();
    assert.equal(captured.length, 1, `${name} sent ${captured.length} statements`);
    queries.push({ name, query: captured[0]! });
  };
  await captureOne("hasPendingBudgetEnforcement(limit 1)", () => listPendingBudgetCancellationScopes(db!, 1));
  await captureOne("deliverBudgetEnforcement(limit 100)", () => listPendingBudgetCancellationScopes(db!));
  await captureOne("runControl.cancelBudgetScopeWork", async () => pendingBudgetRunIdsForScopeQuery(db!,
    { companyId: companyIds[0]!, scopeType: "agent", scopeId: agentIds[2]! }));
  await captureOne("idleSleep.budget_cancellation", () => db!.execute(sql`select exists (${pendingBudgetRunCancellationExistsQuery()}) as pending`));
  capturing = false;

  async function measure(query: Query) {
    const timings: number[] = []; let rows: unknown[] = [];
    for (let n = 0; n < samples + 2; n++) {
      const start = performance.now();
      rows = await db!.$client.unsafe(query.sql, query.params as never[]).values();
      if (n > 1) timings.push(performance.now() - start);
    }
    const [plan] = await db!.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
    const root = plan["QUERY PLAN"][0];
    const nodes: string[] = [];
    (function walk(node: Record<string, unknown>) { nodes.push(String(node["Node Type"]) + (node["Index Name"] ? `(${node["Index Name"]})` : ""));
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child); })(root.Plan);
    timings.sort((a, b) => a - b);
    return { medianMs: timings[Math.floor(timings.length / 2)]!, minMs: timings[0]!, maxMs: timings.at(-1)!, rows,
      sharedBuffers: Number(root.Plan["Shared Hit Blocks"] ?? 0) + Number(root.Plan["Shared Read Blocks"] ?? 0), nodes };
  }
  const indexed = async (present: boolean) => {
    const existing = await db!.$client.unsafe(`select 1 from pg_indexes where indexname = $1`, [indexName]);
    if (existing.length) await db!.$client.unsafe(`drop index "${indexName}"`);
    if (present) {
      const start = performance.now();
      await db!.$client.unsafe(createIndexSql);
      await db!.$client.unsafe("analyze heartbeat_runs");
      return performance.now() - start;
    }
    return null;
  };
  const order: Array<"baseline" | "treatment"> = process.argv.includes("--reverse") ? ["treatment", "baseline"] : ["baseline", "treatment"];
  const results: Record<string, Record<string, Awaited<ReturnType<typeof measure>>>> = {};
  let indexBuildMs: number | null = null;
  for (const variant of order) {
    const built = await indexed(variant === "treatment");
    if (built !== null) indexBuildMs = built;
    for (const { name, query } of queries) (results[name] ??= {})[variant] = await measure(query);
  }
  const report = Object.entries(results).map(([name, { baseline, treatment }]) => {
    // Run control's scoped read has no ORDER BY; its caller treats the rows as a
    // set. Every other read promises its order, so compare it exactly.
    const comparable = (rows: unknown[]) => name === "runControl.cancelBudgetScopeWork"
      ? rows.map(row => JSON.stringify(row)).sort() : rows;
    assert.deepEqual(comparable(treatment!.rows), comparable(baseline!.rows), `${name} returned different rows`);
    if (name !== "idleSleep.budget_cancellation") assert.ok(treatment!.nodes.some(node => node.includes(indexName)), `${name} did not use the index`);
    return { name, equalRows: baseline!.rows.length, baselineMs: baseline!.medianMs, baselineRangeMs: [baseline!.minMs, baseline!.maxMs],
      treatmentMs: treatment!.medianMs, treatmentRangeMs: [treatment!.minMs, treatment!.maxMs],
      speedup: Number((baseline!.medianMs / treatment!.medianMs).toFixed(1)),
      baselineBuffers: baseline!.sharedBuffers, treatmentBuffers: treatment!.sharedBuffers,
      baselinePlan: baseline!.nodes.join(" > "), treatmentPlan: treatment!.nodes.join(" > ") };
  });
  // The service's own post-processing must agree too.
  const scopes = await listPendingBudgetCancellationScopes(db);
  assert.ok(scopes.length > 0);
  console.log(JSON.stringify({ postgres: version.version, runs: runCount + special.length, payloadKib, tableBytes: Number(tableBytes),
    order, samples, indexBuildMs, createIndexSql, servicesScopes: scopes.length, report }, null, 2));
} finally {
  try { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); }
  finally { clearInterval(keepAlive); }
}
