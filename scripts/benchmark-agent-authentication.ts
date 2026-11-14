import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { and, eq } = createRequire(new URL("../server/package.json", import.meta.url))("drizzle-orm");
import { agents, companies, createDb, heartbeatRuns, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { agentRunWritesRevoked } from "../server/src/agent-run-cancellation.js";
import { loadAgentRunAuthentication } from "../server/src/middleware/agent-run-authentication.js";

type Query = { sql: string; params: unknown[] };
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Supply an explicit pre-fix --baseline-ref");
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "",
  "Commit benchmark and treatment changes before measuring");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const source = execFileSync("git", ["show", `${baselineRevision}:server/src/middleware/auth.ts`], { encoding: "utf8" });
const expression = source.match(/const \[identityRun\] = await (db\.select\([\s\S]*?);\n      if/)?.[1];
assert.ok(expression, "The baseline must contain the original JWT identity query");
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
try {
  database = await startEmbeddedPostgresTestDatabase("agent-authentication-benchmark-");
  db = createDb(database.connectionString);
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic authentication", issuePrefix: "AUTH" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "process" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running",
    activeIdentityContextId: randomUUID(), responsibleUserId: "fixture-user" });
  const baseline = new Function("db", "heartbeatRuns", "and", "eq", "claims", `return ${expression}`)(
    db, heartbeatRuns, and, eq, { sub: agentId, company_id: companyId, run_id: runId },
  ).toSQL() as Query;
  const treatment = loadAgentRunAuthentication(db, { companyId, agentId, runId }).toSQL();

  function contract(rows: unknown[][]) {
    return rows.map(([activeIdentityContextId, responsibleUserId, status, resultJson, contextSnapshot]) => ({
      activeIdentityContextId, responsibleUserId, status,
      writesRevoked: agentRunWritesRevoked({ status: status as string, resultJson: resultJson as Record<string, unknown> | null }),
      conversation: (contextSnapshot as Record<string, unknown> | null)?.conversationMode === true,
    }));
  }

  const results = [];
  for (const contextBytes of [1024, 96 * 1024]) {
    const context = { prompt: randomBytes(contextBytes * 3 / 4).toString("base64"), conversationMode: true };
    const result = { summary: randomBytes(3 * 1024).toString("base64") };
    await db.update(heartbeatRuns).set({ contextSnapshot: context, resultJson: result }).where(eq(heartbeatRuns.id, runId));
    await db.$client.unsafe("ANALYZE heartbeat_runs");
    const samples: Record<string, number[]> = { baseline: [], treatment: [] };
    const rows: Record<string, unknown[][]> = {};
    for (let iteration = 0; iteration < 12; iteration++) {
      const order = iteration % 2 ? ["treatment", "baseline"] : ["baseline", "treatment"];
      for (const name of order) {
        const query = name === "baseline" ? baseline : treatment;
        const start = performance.now();
        rows[name] = await db.$client.unsafe(query.sql, query.params as never[]).values();
        if (iteration >= 2) samples[name].push(performance.now() - start);
      }
    }
    assert.deepEqual(contract(rows.treatment), contract(rows.baseline));
    const measurements = [];
    for (const [name, query] of Object.entries({ baseline, treatment })) {
      const sorted = [...samples[name]].sort((a, b) => a - b);
      const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
      measurements.push({ name, samplesMs: samples[name], medianMs: sorted[5],
        returnedJsonBytes: Buffer.byteLength(JSON.stringify(rows[name])), plan: plan["QUERY PLAN"] });
    }
    results.push({ contextBytes: Buffer.byteLength(JSON.stringify(context)),
      resultBytes: Buffer.byteLength(JSON.stringify(result)), contractEqual: true, measurements });
  }
  const [version] = await db.$client.unsafe("SELECT version() AS version");
  const settings = await db.$client.unsafe("SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','effective_cache_size','jit') ORDER BY name");
  console.log(JSON.stringify({ baselineRevision, treatmentRevision, node: process.version,
    dependencyLockfileSha256: createHash("sha256").update(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url))).digest("hex"),
    postgres: version.version, settings, fixtureRuns: 1, queries: { baseline, treatment }, results }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  } finally {
    clearInterval(keepAlive);
  }
}
