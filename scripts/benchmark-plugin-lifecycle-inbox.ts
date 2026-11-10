// Compares the plugin lifecycle inbox page query before and after a change.
// Usage: pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-plugin-lifecycle-inbox.ts \
//   --baseline-ref=<sha> [--agents=40] [--per-agent=2500] [--acked=2000] [--samples=5] [--treatment-only]
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import * as schema from "../packages/db/src/schema/index.js";
import { companies, plugins, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import * as current from "../server/src/services/plugin-lifecycle-inbox.js";

const arg = (name: string, fallback: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${arg("baseline-ref", "origin/master")}^{commit}`], { encoding: "utf8" }).trim();
const agentCount = Number(arg("agents", "40"));
const perAgent = Number(arg("per-agent", "2500"));
const acked = Number(arg("acked", "2000"));
const sampleCount = Number(arg("samples", "5"));
const timeoutMs = Number(arg("timeout-ms", "600000"));
// The baseline is quadratic; at large fixtures time only the treatment.
const treatmentOnly = process.argv.includes("--treatment-only");
// Resolve database drivers through the db package; the scripts folder has no own dependencies.
const dbRequire = createRequire(new URL("../packages/db/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(dbRequire.resolve("postgres")).href)).default as typeof import("postgres").default;
const { drizzle } = await import(pathToFileURL(dbRequire.resolve("drizzle-orm/postgres-js")).href) as typeof import("drizzle-orm/postgres-js");
type Inbox = typeof current.pluginLifecycleInbox;
type Query = { sql: string; params: unknown[] };

const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let client: import("postgres").Sql | undefined;
let baselineDir: string | undefined;
try {
  database = await startEmbeddedPostgresTestDatabase("lifecycle-inbox-benchmark-");
  let recorded: Query[] = [];
  client = postgres(database.connectionString, {
    max: 1, onnotice: () => {}, connection: { statement_timeout: timeoutMs },
    debug: (_connection, query, params) => { recorded.push({ sql: query, params }); },
  });
  const db = drizzle(client, { schema }) as unknown as Db;

  baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".lifecycle-baseline-"));
  const modulePath = "server/src/services/plugin-lifecycle-inbox.ts";
  const original = new URL(`../${modulePath}`, import.meta.url);
  const source = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" })
    .replace(/from "(\.{1,2}\/[^"]+)"/g, (_m, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, original)))}`);
  const target = path.join(baselineDir, "plugin-lifecycle-inbox.ts");
  await fs.writeFile(target, source);
  const baseline = (await import(pathToFileURL(target).href)).pluginLifecycleInbox as Inbox;

  // Fixture: agent_runtime history interleaved across agents. Each agent has `acked`
  // acknowledged revisions followed by a backlog of unacknowledged revisions.
  const companyId = randomUUID(), decoyId = randomUUID();
  await db.insert(companies).values([{ id: companyId, name: "Bench", issuePrefix: "BNCH" }, { id: decoyId, name: "Decoy", issuePrefix: "DCOY" }]);
  const [plugin] = await db.insert(plugins).values({ pluginKey: randomUUID(), packageName: "bench", version: "1.0.0", status: "ready", manifestJson: {} as never }).returning();
  const agentIds = Array.from({ length: agentCount }, () => randomUUID());
  const projectIds = Array.from({ length: 20 }, () => randomUUID());
  await client.unsafe(`INSERT INTO resource_lifecycle_events (company_id, resource_type, resource_id, action)
    SELECT $1::uuid, 'agent', a, 'create' FROM unnest($2::uuid[]) a
    UNION ALL SELECT $1::uuid, 'project', p, 'create' FROM unnest($3::uuid[]) p`, [companyId, agentIds, projectIds]);
  await client.unsafe(`INSERT INTO resource_lifecycle_events (company_id, resource_type, resource_id, action)
    SELECT $1::uuid, 'agent_runtime', ($2::uuid[])[(n % $3) + 1], 'update' FROM generate_series(0, $4::int - 1) n ORDER BY n`,
    [companyId, agentIds, agentCount, agentCount * perAgent]);
  // A few project updates after the agent backlog, so heads are spread across the id range.
  await client.unsafe(`INSERT INTO resource_lifecycle_events (company_id, resource_type, resource_id, action)
    SELECT $1::uuid, 'project', p, 'update' FROM unnest($2::uuid[]) p`, [companyId, projectIds]);
  await client.unsafe(`INSERT INTO resource_lifecycle_events (company_id, resource_type, resource_id, action)
    SELECT $1::uuid, 'agent_runtime', gen_random_uuid(), 'update' FROM generate_series(1, 20000)`, [decoyId]);
  await client.unsafe(`INSERT INTO plugin_lifecycle_acknowledgments (plugin_id, event_id)
    SELECT $1::uuid, id FROM (
      SELECT id, resource_type, row_number() OVER (PARTITION BY resource_type, resource_id ORDER BY id) AS rank
      FROM resource_lifecycle_events WHERE company_id = $2::uuid) e
    WHERE resource_type = 'agent' OR (resource_type = 'project' AND rank = 1) OR (resource_type = 'agent_runtime' AND rank <= $3)`,
    [plugin.id, companyId, acked]);
  await client.unsafe("ANALYZE");
  const [{ events }] = await client.unsafe(`SELECT count(*)::int AS events FROM resource_lifecycle_events`);
  const [{ acks }] = await client.unsafe(`SELECT count(*)::int AS acks FROM plugin_lifecycle_acknowledgments`);
  const [{ server_version: version }] = await client.unsafe(`SHOW server_version`);

  const cases = [
    { name: "page-100-all-types", limit: 100, types: ["agent", "project", "agent_runtime"] },
    { name: "page-100-agent-project", limit: 100, types: ["agent", "project"] },
    // Idle-sleep check: baseline read one listed event; the treatment asks only whether one exists.
    { name: "idle-probe-all-types", limit: 1, types: ["agent", "project", "agent_runtime"], probe: true },
  ] as const;
  async function run(inbox: Inbox, c: (typeof cases)[number]) {
    recorded = [];
    const start = performance.now();
    const service = inbox(db, plugin.id) as ReturnType<Inbox>;
    const rows = "probe" in c
      ? [("hasPending" in service ? await service.hasPending(companyId, [...c.types]) : (await service.list(companyId, 1, undefined, [...c.types])).length > 0)]
      : await service.list(companyId, c.limit, undefined, [...c.types]);
    const ms = performance.now() - start;
    const query = recorded.find(q => q.sql.includes('"resource_lifecycle_events"'));
    return { ms, rows, query };
  }
  const results = [];
  for (const c of cases) {
    const samples = { baseline: [] as number[], treatment: [] as number[] };
    let baseRows: unknown, treatRows: unknown, baseQuery: Query | undefined, treatQuery: Query | undefined;
    // One warmup each, then alternate order per sample to limit cache bias.
    for (let n = 0; n <= sampleCount; n++) {
      const order = n % 2 === 0 ? (["baseline", "treatment"] as const) : (["treatment", "baseline"] as const);
      for (const which of order.filter(w => !treatmentOnly || w === "treatment")) {
        const r = await run(which === "baseline" ? baseline : current.pluginLifecycleInbox, c);
        if (n > 0) samples[which].push(r.ms);
        if (which === "baseline") { baseRows = r.rows; baseQuery = r.query; } else { treatRows = r.rows; treatQuery = r.query; }
      }
    }
    if (!treatmentOnly) assert.deepEqual(treatRows, baseRows, `${c.name}: results differ`);
    const explain = async (q?: Query) => q ? (await client!.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q.sql}`, q.params as never[])).map(r => r["QUERY PLAN"]).join("\n") : "";
    const stats = (s: number[]) => { const v = [...s].sort((a, b) => a - b); return { median: v[Math.floor(v.length / 2)], min: v[0], max: v.at(-1), samples: s.map(x => Math.round(x * 10) / 10) }; };
    const b = treatmentOnly ? undefined : stats(samples.baseline), t = stats(samples.treatment);
    results.push({ case: c.name, rows: (treatRows as unknown[]).length, equal: !treatmentOnly, baselineMs: b, treatmentMs: t, speedup: b ? Math.round(b.median / t.median * 10) / 10 : undefined,
      baselinePlan: await explain(baseQuery), treatmentPlan: await explain(treatQuery) });
  }
  // Control: the agent runtime revision read (plugin-agent-runtime-state.ts, agent-file-store.ts) is unchanged.
  const revisionPlan = (await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT id FROM resource_lifecycle_events
    WHERE company_id = $1 AND resource_type = 'agent_runtime' AND resource_id = $2 ORDER BY id DESC LIMIT 1`, [companyId, agentIds[0]]))
    .map(r => r["QUERY PLAN"]).join("\n");
  console.log(JSON.stringify({ revisionPlan, baselineRevision, postgres: version, agents: agentCount, perAgent, acked, events, acks, samples: sampleCount, results }, null, 2));
} finally {
  try { await client?.end({ timeout: 0 }); await database?.cleanup(); if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true }); }
  finally { clearInterval(keepAlive); }
}
