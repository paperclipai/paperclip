import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { getExecutionBlocker } from "../server/src/services/execution-blocker.js";
import { captureQueuedCommentQuery, planNodes, seedQueuedCommentConsumption, type BlockerFactory, type CapturedCommentQuery } from "../server/src/__tests__/helpers/queued-comment-consumption-fixture.js";

const baselineRef = process.argv.find(value => value.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-change --baseline-ref=<commit>");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const root = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = "server/src/services/execution-blocker.ts";
const changedRuntime = execFileSync("git", ["diff", "--name-only", baselineRevision, "--", "server/src/services", "packages/db/src", "packages/shared/src", "pnpm-lock.yaml"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
assert.deepEqual(changedRuntime.filter(source => source !== sourcePath), [], "The baseline must not import changed runtime helpers");
const baselineSource = execFileSync("git", ["show", `${baselineRevision}:${sourcePath}`], { encoding: "utf8" });
const baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.queued-comment-baseline-"));
const rewritten = baselineSource.replace(/from "(\.{1,2}\/[^\"]+)"/g, (_match, specifier: string) => `from ${JSON.stringify(path.resolve(root, "server/src/services", specifier))}`);
await fs.writeFile(path.join(baselineDir, "execution-blocker.ts"), rewritten);
const old = await import(pathToFileURL(path.join(baselineDir, "execution-blocker.ts")).href) as { getExecutionBlocker: BlockerFactory };
const targetUrl = process.env.QUEUED_COMMENT_BENCHMARK_DATABASE_URL;
if (targetUrl) assert.ok(new URL(targetUrl).pathname.startsWith("/queued_comments_"), "Use a disposable queued_comments_ database");
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
const keepAlive = setInterval(() => {}, 1000);
const started = performance.now();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const multiset = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
const fixtureDefinitions = [
  { name: "no-comments", comments: 0, history: 0, payloadBytes: 0, matched: 0 },
  { name: "empty-history", comments: 8, history: 0, payloadBytes: 0, matched: 0 },
  { name: "small", comments: 8, history: 2, payloadBytes: 27 * 1024, matched: 0 },
  { name: "moderate-eleven", comments: 8, history: 11, payloadBytes: 72 * 1024, matched: 0 },
  { name: "representative-eight", comments: 8, history: 40, payloadBytes: 72 * 1024, matched: 0 },
  { name: "wide-tail", comments: 8, history: 69, payloadBytes: 200 * 1024, matched: 0 },
  { name: "one-unconsumed", comments: 1, history: 40, payloadBytes: 72 * 1024, matched: 0 },
  { name: "eight-consumed-first", comments: 8, history: 40, payloadBytes: 72 * 1024, matched: 8 },
  { name: "eight-mixed", comments: 8, history: 40, payloadBytes: 72 * 1024, matched: 4 },
  { name: "large-queue", comments: 64, history: 40, payloadBytes: 72 * 1024, matched: 0 },
  { name: "deep-stress", comments: 8, history: 1400, payloadBytes: 32 * 1024, matched: 0 },
  { name: "deep-consumed-first", comments: 8, history: 1400, payloadBytes: 32 * 1024, matched: 8 },
];
try {
  if (!targetUrl) database = await startEmbeddedPostgresTestDatabase("queued-comment-benchmark-");
  db = createDb(targetUrl ?? database!.connectionString, { maxConnections: 1, idleTimeoutSeconds: 0 });
  await db.$client.unsafe("set client_min_messages = warning");
  if (process.argv.includes("--jit-off")) await db.$client.unsafe("set jit = off");
  const version = await db.$client.unsafe("select version()");
  const settings = await db.$client.unsafe("select name, setting from pg_settings where name in ('shared_buffers', 'work_mem', 'jit', 'jit_above_cost', 'jit_inline_above_cost', 'jit_optimize_above_cost', 'random_page_cost') order by name");
  await db.$client.unsafe("TRUNCATE companies CASCADE");
  const results = [];
  const budgetFailures: string[] = [];
  let waitedForSlot = false;
  const fixtureSelectors = process.argv.filter(value => value.startsWith("--fixture=")).map(value => value.slice(10));
  const selectedFixtures = fixtureDefinitions.filter(value => (!fixtureSelectors.length || fixtureSelectors.includes(value.name)) &&
    (!process.argv.includes("--representative-only") || value.name === "representative-eight"));
  assert.ok(selectedFixtures.length, "No benchmark fixtures match the requested selectors");
  for (const fixture of selectedFixtures) {
    const f = await seedQueuedCommentConsumption(db, { ...fixture, unrelatedHistory: fixture.history ? 1400 : 0 });
    const before = await captureQueuedCommentQuery(db, f, old.getExecutionBlocker), after = await captureQueuedCommentQuery(db, f);
    assert.deepEqual(after.result, before.result, `${fixture.name}: complete execution blocker differs`);
    assert.equal(before.result?.savedMessageCount, fixture.comments - fixture.matched);
    const queryRows = async (query: CapturedCommentQuery | undefined) => query ? db!.$client.unsafe(query.sql, query.params as never[]).values() : [];
    const expected = await queryRows(before.query), actual = await queryRows(after.query);
    assert.deepEqual(multiset(actual), multiset(expected), `${fixture.name}: complete positional SQL output differs`);
    if (process.argv.includes("--wait-for-slot") && !waitedForSlot) {
      waitedForSlot = true;
      process.stderr.write(`READY ${fixture.name}: seeded and captured real service queries; press Enter to time\n`);
      await new Promise<void>(resolve => { process.stdin.once("data", () => { process.stdin.pause(); resolve(); }); process.stdin.resume(); });
    }
    const samples = { sqlBefore: [] as number[], sqlAfter: [] as number[], serviceBefore: [] as number[], serviceAfter: [] as number[] };
    for (let iteration = 0; iteration < 7; iteration++) {
      for (const arm of iteration % 2 ? ["after", "before"] as const : ["before", "after"] as const) {
        const sqlStart = performance.now();
        const rows = await queryRows(arm === "before" ? before.query : after.query);
        const sqlMs = performance.now() - sqlStart;
        assert.deepEqual(multiset(rows), multiset(expected));
        const serviceStart = performance.now();
        const result = await (arm === "before" ? old.getExecutionBlocker : getExecutionBlocker)(db, f.companyId, f.issueId);
        const serviceMs = performance.now() - serviceStart;
        assert.deepEqual(result, before.result);
        if (iteration >= 2) {
          samples[arm === "before" ? "sqlBefore" : "sqlAfter"].push(sqlMs);
          samples[arm === "before" ? "serviceBefore" : "serviceAfter"].push(serviceMs);
        }
      }
    }
    const plans: Record<string, unknown> = {};
    const runScanLoops: Record<string, number> = {};
    for (const [arm, captured] of [["before", before], ["after", after]] as const) {
      if (!captured.query) continue;
      const [row] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.query.sql}`, captured.query.params as never[]);
      plans[arm] = row["QUERY PLAN"];
      runScanLoops[arm] = planNodes(row["QUERY PLAN"][0].Plan).filter(node => node["Relation Name"] === "heartbeat_runs")
        .reduce((total, node) => total + Number(node["Actual Loops"]), 0);
    }
    const medians = Object.fromEntries(Object.entries(samples).map(([arm, values]) => [arm, median(values)]));
    if (fixture.name === "representative-eight" && medians.sqlBefore! < medians.sqlAfter! * 1.5) budgetFailures.push(`${fixture.name}: SQL gain below 1.5x`);
    if (["no-comments", "empty-history", "small", "one-unconsumed", "eight-consumed-first", "deep-consumed-first"].includes(fixture.name) &&
      medians.serviceAfter! > Math.max(medians.serviceBefore! * 1.25, medians.serviceBefore! + 2)) budgetFailures.push(`${fixture.name}: service overhead exceeds 25% or 2 ms`);
    if (fixture.name === "deep-consumed-first") {
      const buffers = (arm: string) => {
        const plan = (plans[arm] as { Plan: Record<string, number> }[])[0]!.Plan;
        return Number(plan["Shared Hit Blocks"]) + Number(plan["Shared Read Blocks"]);
      };
      if (buffers("after") > buffers("before") * 1.25 + 32) budgetFailures.push(`${fixture.name}: lost early-exit buffer work`);
    }
    const equality = { completePositionalSqlRows: expected.length, completeServiceResult: before.result };
    results.push({ fixture, before: before.query, after: after.query, equality, samples, medians, runScanLoops, plans });
    process.stderr.write(`${fixture.name}: SQL ${medians.sqlBefore!.toFixed(2)} -> ${medians.sqlAfter!.toFixed(2)} ms; service ${medians.serviceBefore!.toFixed(2)} -> ${medians.serviceAfter!.toFixed(2)} ms; history scan loops ${JSON.stringify(runScanLoops)}\n`);
    await db.$client.unsafe("TRUNCATE companies CASCADE");
  }
  const treatmentSource = await fs.readFile(path.join(root, sourcePath));
  console.log(JSON.stringify({ baselineRevision, treatmentRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourcePath, baselineSha256: createHash("sha256").update(baselineSource).digest("hex"), treatmentSha256: createHash("sha256").update(treatmentSource).digest("hex"),
    baselineDependenciesHeldConstant: true, version, settings, jitOff: process.argv.includes("--jit-off"), warmups: 2, timedSamplesPerArm: 5,
    budgetFailures, setupAndProofMs: performance.now() - started, results }, null, 2));
  if (process.argv.includes("--require-budget")) assert.deepEqual(budgetFailures, [], "Local performance acceptance failed");
} finally {
  try { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); await fs.rm(baselineDir, { recursive: true, force: true }); }
  finally { clearInterval(keepAlive); }
}
