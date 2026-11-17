import assert from "node:assert/strict";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, issues } from "../../packages/db/src/index.js";
import { issueReadSqlCondition } from "../src/services/authorization.js";
import { issueService } from "../src/services/issues.js";
import { captureTaskListQuery, seedTaskListProjectionFixture, type ListFilters, type ProjectionQuery } from "../src/__tests__/helpers/task-list-projection-fixture.js";

const started = performance.now();
const host = { availableCpus: availableParallelism(), loadBefore: loadavg() };
const root = fileURLToPath(new URL("../../", import.meta.url));
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const baselineRef = arg("baseline-ref");
assert.ok(baselineRef, "Pass a pinned pre-fix --baseline-ref");
const baselineRevision = git(["rev-parse", `${baselineRef}^{commit}`]).trim();
const modulePaths = ["server/src/services/issues.ts", "server/src/services/slack-conversation-state.ts"];
const proofPaths = [...modulePaths, "server/src/services/authorization.ts", "server/scripts/benchmark-task-list-projection.ts", "server/src/__tests__/helpers/task-list-projection-fixture.ts", "packages/db/src/schema/activity_log.ts", "packages/db/src/client.ts", "packages/db/src/migrations/0414_closed_edwin_jarvis.sql"];
const changedDependencies = git(["diff", "--name-only", baselineRevision, "--", "server/src/services", "packages/db/src", "packages/shared/src"]).trim().split("\n").filter(Boolean);
const indexOnly = Boolean(arg("treatment-db-name") || arg("validate-report"))
  || (process.argv.includes("--seed-only") && process.argv.includes("--pre-index"));
assert.deepEqual(changedDependencies.filter(file => !file.endsWith(".test.ts") && !modulePaths.includes(file) && !(indexOnly && ((file === "packages/db/src/schema/activity_log.ts" || file === "packages/db/src/client.ts") || file.startsWith("packages/db/src/migrations/")))), [], "All imported query dependencies, including authorization, must stay identical");
const baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.task-projection-baseline-"));
for (const modulePath of modulePaths) {
  const source = git(["show", `${baselineRevision}:${modulePath}`]).replace(/from "(\.{1,2}\/[^\"]+)"/g, (_match, specifier: string) => {
    const resolved = fileURLToPath(new URL(specifier, pathToFileURL(path.join(root, modulePath))));
    return `from ${JSON.stringify(resolved.endsWith("/services/slack-conversation-state.js") ? path.join(baselineDir, "slack-conversation-state.ts") : resolved)}`;
  });
  await fs.writeFile(path.join(baselineDir, path.basename(modulePath)), source);
}
function assertPerformance(report: any, baseline = false) {
  const activityNodes = (node: any): any[] => [
    ...(node["Relation Name"] === "activity_log" ? [node] : []),
    ...(node.Plans ?? []).flatMap(activityNodes),
  ];
  for (const result of report.results) {
    const target = report.fixture.options.hostedShape && result.readMode === "scoped" && result.jit === "off"
      && result.filters.limit === 100 && !result.filters.listProjection && result.filters.sortField === "updated"
      && result.filters.sortDir === "desc" && !result.filters.q && !result.filters.offset && !result.filters.issueIds;
    if (target) {
      const oldNodes = activityNodes(result.baseline.plan[0].Plan);
      const newNodes = activityNodes((baseline ? result.baseline : result.treatment).plan[0].Plan);
      assert.ok(oldNodes.some(node => node["Actual Loops"] >= 1000 && node["Actual Rows"] >= 40), "Representative fixture must reproduce full per-task history probes");
      assert.ok(newNodes.every(node => node["Actual Rows"] <= 1), "Latest-activity probes must stop at one qualifying row");
      assert.ok(oldNodes.reduce((sum, node) => sum + node["Shared Hit Blocks"], 0) / newNodes.reduce((sum, node) => sum + node["Shared Hit Blocks"], 0) >= 5, "Activity buffer work must fall at least fivefold");
      if (!baseline) assert.ok(result.baseline.medianMs / result.treatment.medianMs >= 1.5, "Representative SQL must improve at least 1.5x");
    }
    if (!target && !result.baseline.plan[0].JIT) {
      assert.ok(result.treatment.medianMs <= Math.max(result.baseline.medianMs * 1.25, result.baseline.medianMs + 2), "Control SQL must stay within 25% or 2ms of baseline");
    }
  }
}
if (arg("validate-report")) {
  const report = JSON.parse(await fs.readFile(arg("validate-report")!, "utf8"));
  assert.equal(report.baselineRevision, baselineRevision);
  for (const [file, hash] of Object.entries(report.sourceHashes)) assert.equal(createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex"), hash, `Measured source changed: ${file}`);
  try { assertPerformance(report, process.argv.includes("--validate-baseline")); }
  finally { await fs.rm(baselineDir, { recursive: true, force: true }); }
  console.log(JSON.stringify({ status: "performance criteria passed", baselineRevision }));
  process.exit(0);
}
const baseline = await import(pathToFileURL(path.join(baselineDir, "issues.ts")).href) as typeof import("../src/services/issues.js");
const adminUrl = process.env.TASK_PROJECTION_DATABASE_URL;
assert.ok(adminUrl, "Set TASK_PROJECTION_DATABASE_URL to a disposable local PostgreSQL admin database");
const url = new URL(adminUrl);
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Use isolated local PostgreSQL only");
const databaseName = arg("db-name") ?? `task_projection_${randomUUID().replaceAll("-", "")}`;
assert.match(databaseName, /^task_projection_[a-z0-9_]+$/);
const fixtureFile = arg("fixture-file") ?? path.join(tmpdir(), `${databaseName}.fixture.json`);
const admin = createDb(adminUrl, { maxConnections: 1 });
const [existing] = await admin.$client.unsafe("select 1 from pg_database where datname=$1", [databaseName]);
if (!existing) await admin.$client.unsafe(`CREATE DATABASE "${databaseName}"`);
url.pathname = `/${databaseName}`;
if (!process.argv.includes("--reuse")) await applyPendingMigrations(url.href);
const db = createDb(url.href, { maxConnections: 1 });
const treatmentDatabaseName = arg("treatment-db-name") ?? databaseName;
assert.match(treatmentDatabaseName, /^task_projection_[a-z0-9_]+$/);
const treatmentUrl = new URL(url.href);
treatmentUrl.pathname = `/${treatmentDatabaseName}`;
const treatmentDb = treatmentDatabaseName === databaseName ? db : createDb(treatmentUrl.href, { maxConnections: 1 });
if (process.argv.includes("--pre-index")) {
  assert.ok(process.argv.includes("--seed-only") && !process.argv.includes("--reuse") && !arg("treatment-db-name"), "Pre-index restoration is only for a new seed-only fixture");
  const migration = await fs.readFile(path.join(root, "packages/db/src/migrations/0414_closed_edwin_jarvis.sql"));
  const hash = createHash("sha256").update(migration).digest("hex");
  await db.$client.unsafe("drop index activity_log_company_entity_created_idx");
  const removed = await db.$client.unsafe("delete from drizzle.__drizzle_migrations where hash=$1 returning id", [hash]);
  assert.equal(removed.length, 1, "Restore only the new index and its exact migration receipt");
}
const keepAlive = setInterval(() => {}, 1000);
try {
  const workMem = arg("work-mem");
  if (workMem) assert.match(workMem, /^\d+(kB|MB)$/);
  for (const target of new Set([db, treatmentDb])) {
    await target.$client.unsafe("set client_min_messages = warning");
    if (workMem) await target.$client.unsafe("select set_config('work_mem', $1, false)", [workMem]);
  }
  const settingsSql = "select version(), current_setting('shared_buffers') shared_buffers, current_setting('work_mem') work_mem, current_setting('jit_above_cost') jit_above_cost";
  const [settings] = await db.$client.unsafe(settingsSql);
  const [treatmentSettings] = await treatmentDb.$client.unsafe(settingsSql);
  assert.equal(treatmentSettings!.work_mem, settings!.work_mem, "Paired databases must use the same work_mem");
  await issueService(db).list(randomUUID(), { limit: 1 });
  const smokeMs = performance.now() - started;
  const fixture = process.argv.includes("--reuse")
    ? JSON.parse(await fs.readFile(fixtureFile, "utf8")) as Awaited<ReturnType<typeof seedTaskListProjectionFixture>>
    : await seedTaskListProjectionFixture(db, { count: Number(arg("count") ?? 1200), chatCount: Number(arg("chat-count") ?? (process.argv.includes("--hosted-shape") ? 6 : 600)), history: Number(arg("history") ?? 12), payloadBytes: Number(arg("payload-bytes") ?? 3072), liveCount: Number(arg("live-count") ?? 12), activityPerIssue: Number(arg("activity-per-issue") ?? 0), commentsPerIssue: Number(arg("comments-per-issue") ?? 0), activityDecoys: Number(arg("activity-decoys") ?? 0), descriptionBytes: Number(arg("description-bytes") ?? 0), hostedShape: process.argv.includes("--hosted-shape") });
  await fs.writeFile(fixtureFile, JSON.stringify(fixture));
  const seedMs = performance.now() - started - smokeMs;
  const execute = (query: ProjectionQuery, target = db) => target.$client.unsafe(query.sql, query.params as never[]).values();
  const stats = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return { medianMs: sorted[Math.floor(values.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), meanMs: values.reduce((a,b) => a+b,0) / values.length, samplesMs: values }; };
  const results = [];
  const cases: ListFilters[] = process.argv.includes("--seed-only") ? [] : process.argv.includes("--quick") ? [process.argv.includes("--full-projection") ? { limit: 100, sortField: "updated", sortDir: "desc" } : { limit: 100, listProjection: "index" }] : [
    { limit: 1, listProjection: "index" }, { limit: 100, listProjection: "index" }, { limit: 1000, listProjection: "index" },
    { limit: 100, sortField: "updated", sortDir: "desc" },
    { limit: 1000, sortField: "updated", sortDir: "desc" },
    { limit: 1, sortField: "updated", sortDir: "desc" },
    { limit: 100, sortField: "updated", sortDir: "asc" },
    { limit: 100, sortField: "updated", sortDir: "desc", offset: 100 },
    { limit: 100, issueIds: fixture.records.slice(0,2).map(row => row.id), sortField: "updated", sortDir: "desc" },
    { limit: 100, listProjection: "index", q: "Projection" }, { limit: 100, listProjection: "index", offset: 100 },
  ];
  const readModes = process.argv.includes("--scoped") ? ["scoped"] : process.argv.includes("--all-read-modes") ? ["unrestricted", "scoped"] : ["unrestricted"];
  for (const readMode of readModes) for (const jit of arg("jit") ? [arg("jit")!] : process.argv.includes("--quick") ? ["on"] : ["on", "off"]) for (const rawFilters of cases) {
    assert.ok(jit === "on" || jit === "off");
    if (readMode === "scoped" && (rawFilters?.q || rawFilters?.offset || rawFilters?.limit !== 100 || rawFilters?.listProjection === "rows")) continue;
    const filters = readMode === "scoped" ? { ...rawFilters, readCondition: await issueReadSqlCondition(db, {
      type: "board", source: "session", userId: "projection-human", authorizingUserId: "projection-human",
    }) } : { ...rawFilters };
    if (process.argv.includes("--read-one")) filters!.readCondition = sql<boolean>`(${filters!.readCondition ?? sql`true`}) and exists (
      select 1 from jsonb_array_elements_text(${JSON.stringify([fixture.records.at(-1)!.id])}::jsonb) permitted(id)
      where permitted.id = ${issues.id}::text)`;
    await db.$client.unsafe(`set jit=${jit}`);
    if (treatmentDb !== db) await treatmentDb.$client.unsafe(`set jit=${jit}`);
    const before = await captureTaskListQuery(db, baseline.issueService, fixture.companyId, filters);
    const after = await captureTaskListQuery(treatmentDb, issueService, fixture.companyId, filters);
    if (treatmentDb !== db) assert.deepEqual(after, before, "Index-only comparison must generate identical SQL and parameters");
    const beforeRows = await execute(before), afterRows = await execute(after, treatmentDb);
    assert.deepEqual(afterRows, beforeRows, "Every positional SQL column and ordered row must match");
    const samples = { baseline: [] as number[], treatment: [] as number[] };
    const serviceSamples = { baseline: [] as number[], treatment: [] as number[] };
    for (let round = 0; round < 7; round++) for (const arm of round % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const) {
      let start = performance.now();
      await execute(arm === "baseline" ? before : after, arm === "baseline" ? db : treatmentDb);
      if (round >= 2) samples[arm].push(performance.now() - start);
      start = performance.now();
      await (arm === "baseline" ? baseline.issueService : issueService)(arm === "baseline" ? db : treatmentDb).list(fixture.companyId, filters);
      if (round >= 2) serviceSamples[arm].push(performance.now() - start);
    }
    assert.deepEqual(await issueService(treatmentDb).list(fixture.companyId, filters), await baseline.issueService(db).list(fixture.companyId, filters), "Complete list response must match");
    const explain = async (query: ProjectionQuery, target = db) => (await target.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]))[0]!["QUERY PLAN"];
    results.push({ filters: rawFilters, readMode: readMode + (process.argv.includes("--read-one") ? "-one" : ""), jit, rows: afterRows.length, completePositionalEquality: true, serviceEquality: true,
      baseline: { ...stats(samples.baseline), service: stats(serviceSamples.baseline), query: before, plan: await explain(before) },
      treatment: { ...stats(samples.treatment), service: stats(serviceSamples.treatment), query: after, plan: await explain(after, treatmentDb) } });
    if (arg("output")) await fs.writeFile(`${arg("output")}.partial.json`, JSON.stringify({ incomplete: true, baselineRevision, databaseName, treatmentDatabaseName, settings, treatmentSettings, results }, null, 2));
  }
  const report = { baselineRevision, treatmentRevision: git(["rev-parse", "HEAD"]).trim(), sourceHashes: Object.fromEntries(await Promise.all(proofPaths.map(async file => [file, createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex")]))),
    changedDependencies, settings, treatmentSettings, indexes: {
      baseline: await db.$client.unsafe("select indexname,indexdef,pg_relation_size(indexname::regclass)::text bytes from pg_indexes where tablename='activity_log' order by indexname"),
      treatment: await treatmentDb.$client.unsafe("select indexname,indexdef,pg_relation_size(indexname::regclass)::text bytes from pg_indexes where tablename='activity_log' order by indexname"),
    }, node: process.version, host: { ...host, loadAfter: loadavg() }, databaseName, treatmentDatabaseName, fixture: { ...fixture, records: undefined }, smokeMs, seedMs, totalMs: performance.now()-started, warmupsPerArm: 2, measuredSamplesPerArm: 5, results };
  if (arg("output")) await fs.writeFile(arg("output")!, JSON.stringify(report, null, 2));
  if (process.argv.includes("--assert-performance")) assertPerformance(report);
  console.log(JSON.stringify({ ...report, results: results.map(result => ({ ...result, baseline: { ...result.baseline, query: undefined, plan: undefined }, treatment: { ...result.treatment, query: undefined, plan: undefined } })) }, null, 2));
} finally {
  clearInterval(keepAlive);
  if (treatmentDb !== db) await treatmentDb.$client.end({ timeout: 0 });
  await db.$client.end({ timeout: 0 }); await admin.$client.end({ timeout: 0 });
  await fs.rm(baselineDir, { recursive: true, force: true });
}
