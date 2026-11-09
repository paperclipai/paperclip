import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { companies, agents, issues, heartbeatRuns, issueRecoveryActions, createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import * as conversation from "../server/src/services/conversation-continuation.js";
import * as blocker from "../server/src/services/execution-blocker.js";
import * as delivery from "../server/src/services/execution-status-delivery.js";
type Query = { sql: string; params: unknown[] };
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15) ?? "origin/master";
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let baselineDir: string | undefined;
let db: Db | undefined;
try {
  database = await startEmbeddedPostgresTestDatabase("recovery-query-benchmark-");
  db = createDb(database.connectionString);
  baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".recovery-baseline-"));
  async function loadBaseline(name: string) {
    const modulePath = `server/src/services/${name}.ts`;
    const original = new URL(`../${modulePath}`, import.meta.url);
    const source = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
    const rewritten = source.replace(/from "(\.{1,2}\/[^\"]+)"/g,
      (_match, specifier: string) => `from ${JSON.stringify(name === "execution-blocker" && specifier === "./conversation-continuation.js" ? path.join(baselineDir!, "conversation-continuation.ts") : fileURLToPath(new URL(specifier, original)))}`);
    const target = path.join(baselineDir!, `${name}.ts`);
    await fs.writeFile(target, rewritten);
    return import(pathToFileURL(target).href);
  }
  const oldConversation = await loadBaseline("conversation-continuation") as typeof conversation;
  const oldBlocker = await loadBaseline("execution-blocker") as typeof blocker;
  const oldDelivery = await loadBaseline("execution-status-delivery") as typeof delivery;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic recovery", issuePrefix: "BENCH" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "codex_local" });
  await db.insert(issues).values([{ id: issueId, companyId, title: "Target" }, { id: otherIssueId, companyId, title: "Other" }]);
  const prompt = randomBytes(144 * 1024).toString("base64");
  await db.$client.unsafe(`INSERT INTO heartbeat_runs (company_id, agent_id, status, runtime_mode, native_issue_id, created_at,
      context_snapshot, runner_profile_json, process_pid, error_code, execution_status_delivery_id)
    SELECT $1::uuid, $2::uuid, 'failed', 'legacy', case when n = 2 then $3::uuid when n = 3 then $4::uuid end,
      now() + n * interval '1 millisecond', jsonb_build_object('issueId', case when n in (1,3) then $3::text else $4::text end, 'prompt', $5::text),
      '{"adapterDispatch":{"adapterType":"codex_local"}}'::jsonb, 999999999, 'process_lost',
      case when n <= 100 then gen_random_uuid() end
    FROM generate_series(1, 1400) n`, [companyId, agentId, issueId, otherIssueId, prompt]);
  const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).orderBy(heartbeatRuns.createdAt);
  await db.insert(issueRecoveryActions).values(runs.slice(0, 350).map(run => ({ companyId, sourceIssueId: issueId,
    kind: "active_run_watchdog", status: "resolved", ownerType: "board", cause: "legacy_execution_requires_reconciliation",
    fingerprint: run.id, evidence: { runId: run.id, automaticRecovery: { replay: "blocked" }, workspaceRestoreFailure: "restore_unsafe_archive" }, updatedAt: new Date(Date.UTC(2026, 0, 1) + runs.indexOf(run) * 1000), nextAction: "Fixture" })));
  await db.$client.unsafe("ANALYZE");
  async function capture(invoke: (captureDb: Db) => Promise<unknown>, actionQuery = false): Promise<Query> {
    let query: Query | undefined;
    const stop = new Error("captured");
    const captureDb = new Proxy(db!, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const selection = from(...args);
          selection.execute = async () => {
            const candidate = selection.toSQL();
            if (actionQuery && !candidate.sql.includes('from "issue_recovery_actions"')) return [];
            query = candidate; throw stop;
          };
          return selection;
        }) as typeof builder.from;
        return builder;
      };
    }});
    try { await invoke(captureDb); } catch (error) { if (error !== stop) throw error; }
    assert.ok(query);
    return query;
  }
  async function measure(query: Query) {
    const samples: number[] = []; let rows: unknown[] = [];
    for (let n = 0; n < 7; n++) {
      const start = performance.now();
      rows = await db!.$client.unsafe(query.sql, query.params as never[]).values();
      if (n > 1) samples.push(performance.now() - start);
    }
    const [plan] = await db!.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
    samples.sort((a, b) => a - b);
    return { medianMs: samples[2], rows, plan: plan["QUERY PLAN"] };
  }
  const pairs = [
    { name: "ownership", before: (d: Db) => oldConversation.getConversationOwnershipBlocker(d, companyId, issueId),
      after: (d: Db) => conversation.getConversationOwnershipBlocker(d, companyId, issueId) },
    { name: "recoveryActions", before: (d: Db) => oldBlocker.getExecutionBlocker(d, companyId, issueId),
      after: (d: Db) => blocker.getExecutionBlocker(d, companyId, issueId) },
    { name: "statusDelivery", before: (d: Db) => oldDelivery.deliverExecutionStatuses(d), after: (d: Db) => delivery.deliverExecutionStatuses(d) },
  ];
  const results = [];
  for (const pair of pairs) {
    const before = await measure(await capture(pair.before, pair.name === "recoveryActions")), after = await measure(await capture(pair.after, pair.name === "recoveryActions"));
    const normalize = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
    assert.deepEqual(normalize(after.rows), normalize(before.rows));
    results.push({ name: pair.name, equalRows: after.rows.length, baselineMs: before.medianMs, treatmentMs: after.medianMs,
      speedup: before.medianMs / after.medianMs, baselinePlan: before.plan, treatmentPlan: after.plan });
  }
  console.log(JSON.stringify({ baselineRevision, runs: 1400, actions: 350, promptBytes: Buffer.byteLength(prompt), results }, null, 2));
} finally {
  try { await db?.$client.end({ timeout: 0 }); await database?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
