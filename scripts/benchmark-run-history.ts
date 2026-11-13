import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { companies, agents, createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { createHeartbeatRunState } from "../server/src/services/heartbeat/run-state.js";

type Query = { sql: string; params: unknown[] };
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15) ?? "origin/master";
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let baselineDir: string | undefined;
let db: Db | undefined;
try {
  database = await startEmbeddedPostgresTestDatabase("run-history-benchmark-");
  db = createDb(database.connectionString);
  const modulePath = "server/src/services/heartbeat/run-state.ts";
  const moduleUrl = new URL(`../${modulePath}`, import.meta.url);
  const oldSource = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
  const rewritten = oldSource.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`);
  baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".run-history-baseline-"));
  const baselineFile = path.join(baselineDir, "run-state.ts");
  await fs.writeFile(baselineFile, rewritten);
  const baseline = await import(pathToFileURL(baselineFile).href) as typeof import("../server/src/services/heartbeat/run-state.js");
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic history", issuePrefix: "BENCH" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "codex_local" });
  const prompt = randomBytes(144 * 1024).toString("base64");
  await db.$client.unsafe(`INSERT INTO heartbeat_runs (company_id, agent_id, status, created_at, context_snapshot, usage_json, result_json)
    SELECT $1::uuid, $2::uuid, 'succeeded', now() + n * interval '1 millisecond',
      jsonb_build_object('issueId', 'synthetic-issue-' || n, 'taskId', 'task-' || n, 'taskKey', 'key-' || n,
        'commentId', 'comment-' || n, 'wakeCommentId', 'wake-' || n, 'wakeReason', 'assignment',
        'wakeSource', 'automation', 'wakeTriggerDetail', 'fixture', 'prompt', $3::text),
      '{"inputTokens":123,"cachedInputTokens":12,"outputTokens":45,"totalTokens":168}'::jsonb,
      '{"summary":"Synthetic result","costUsd":0.03}'::jsonb
    FROM generate_series(1, 1400) n`, [companyId, agentId, prompt]);
  await db.$client.unsafe("ANALYZE heartbeat_runs");

  async function capture(factory: typeof createHeartbeatRunState, summary: boolean): Promise<Query> {
    let query: Query | undefined;
    const stop = new Error("captured");
    const captureDb = new Proxy(db!, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const selection = from(...args);
          selection.execute = async () => { query = selection.toSQL(); throw stop; };
          return selection;
        }) as typeof builder.from;
        return builder;
      };
    }});
    try { await factory(captureDb).listRuns(companyId, undefined, 200, { summary }); }
    catch (error) { if (error !== stop) throw error; }
    assert.ok(query);
    return query;
  }
  async function measure(query: Query) {
    const samples: number[] = [];
    let rows: unknown[] = [];
    for (let n = 0; n < 7; n++) {
      const start = performance.now();
      rows = await db!.$client.unsafe(query.sql, query.params as never[]).values();
      if (n > 1) samples.push(performance.now() - start);
    }
    const [plan] = await db!.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
    samples.sort((a, b) => a - b);
    return { medianMs: samples[2], rows, plan: plan["QUERY PLAN"] };
  }
  const results = [];
  for (const summary of [true, false]) {
    const before = await measure(await capture(baseline.createHeartbeatRunState, summary));
    const after = await measure(await capture(createHeartbeatRunState, summary));
    assert.deepEqual(after.rows, before.rows);
    results.push({ summary, equalRows: after.rows.length, baselineMs: before.medianMs,
      treatmentMs: after.medianMs, speedup: before.medianMs / after.medianMs,
      baselinePlan: before.plan, treatmentPlan: after.plan });
  }
  console.log(JSON.stringify({ baselineRevision, runs: 1400, promptBytes: Buffer.byteLength(prompt), results }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
