import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPendingMigrations, createDb, startEmbeddedPostgresTestDatabase, type Db } from "../../packages/db/src/index.js";
import { sql } from "drizzle-orm";
import { issueService } from "../src/services/issues.js";
import { issueReadSqlCondition } from "../src/services/authorization.js";
import { recursiveIssueWork, seedPrivacyFixture } from "../src/__tests__/helpers/privacy-query-fixture.js";

const started = performance.now();
const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const maxDenseMs = Number(arg("max-dense-ms") ?? Infinity);
const ref = arg("baseline-ref");
assert.ok(ref, "Pass a pinned --baseline-ref=<pre-fix commit>");
const baselineRevision = git("rev-parse", `${ref}^{commit}`);
const modulePath = "server/src/services/authorization.ts";
const changedRuntime = git("diff", "--name-only", baselineRevision, "--", "server/src/services", "packages/db/src", "packages/shared/src", "pnpm-lock.yaml").split("\n").filter(Boolean);
assert.deepEqual(changedRuntime.filter(file => file !== modulePath), [], "Baseline helpers must be isolated when other runtime dependencies change");
const proofFiles = [modulePath, "server/src/services/issues.ts", "server/src/services/issue-participation.ts"];
const sourceHashes = Object.fromEntries(await Promise.all(proofFiles.map(async file => [file, createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex")])));
const baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.privacy-baseline-"));
const oldSource = git("show", `${baselineRevision}:${modulePath}`);
const rewritten = oldSource.replace(/from "(\.{1,2}\/[^\"]+)"/g, (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, pathToFileURL(path.join(root, modulePath)))))}`);
const oldModule = path.join(baselineDir, "authorization.ts");
await fs.writeFile(oldModule, rewritten);
const baseline = await import(pathToFileURL(oldModule).href) as typeof import("../src/services/authorization.js");
const treatment = process.argv.includes("--treatment-is-baseline") ? baseline.issueReadSqlCondition : issueReadSqlCondition;
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let admin: Db | undefined, db: Db | undefined;
const dbName = `privacy_ancestry_${randomUUID().replaceAll("-", "")}`;
const keepAlive = setInterval(() => {}, 1000);
type Query = { sql: string; params: unknown[] };
function captureDb(target: Db, queries: Query[]): Db {
  function builder(value: any) {
    const from = value.from.bind(value);
    value.from = (...args: any[]) => {
      const query = from(...args), execute = query.execute.bind(query);
      query.execute = async () => { queries.push(query.toSQL()); return execute(); };
      return query;
    };
    return value;
  }
  return new Proxy(target, { get(target, key) {
    if (key === "select") return (...fields: any[]) => builder((target.select as any)(...fields));
    if (key === "with") return (...ctes: any[]) => {
      const value = (target.with as any)(...ctes), select = value.select.bind(value);
      value.select = (...fields: any[]) => builder(select(...fields));
      return value;
    };
    return Reflect.get(target, key);
  } });
}
const stats = (values: number[]) => ({ samplesMs: values, medianMs: [...values].sort((a,b) => a-b)[Math.floor(values.length/2)]!, minMs: Math.min(...values), maxMs: Math.max(...values) });
try {
  if (process.env.PRIVACY_BENCHMARK_ADMIN_URL) {
    const url = new URL(process.env.PRIVACY_BENCHMARK_ADMIN_URL);
    assert.equal(url.hostname, "127.0.0.1", "External benchmark PostgreSQL must be disposable loopback PostgreSQL");
    admin = createDb(url.href, { maxConnections: 1 });
    await admin.$client.unsafe(`CREATE DATABASE "${dbName}"`);
    url.pathname = `/${dbName}`;
    await applyPendingMigrations(url.href);
    db = createDb(url.href, { maxConnections: 1 });
  } else {
    database = await startEmbeddedPostgresTestDatabase("privacy-benchmark-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  }
  await db.$client.unsafe("set client_min_messages=warning");
  const settings = await db.$client.unsafe("select version(),current_setting('shared_buffers') shared_buffers,current_setting('work_mem') work_mem,current_setting('jit_above_cost') jit_above_cost,current_setting('jit_inline_above_cost') jit_inline_above_cost,current_setting('jit_optimize_above_cost') jit_optimize_above_cost");
  const setupMs = performance.now()-started;
  const shapes = [
    { name: "small", count: 20, participated: 20, history: 2, comments: 2, payloadBytes: 512 },
    { name: "dense", count: 1200, participated: 1200, history: 50, comments: 20, decoyHistory: 240000 },
    { name: "sparse", count: 1200, participated: 12, history: 50, comments: 20, decoyHistory: 240000 },
    { name: "deep", count: 64, participated: 64, history: 2, comments: 2, graph: "deep" as const },
    { name: "fanout", count: 1200, participated: 1200, history: 2, comments: 2, graph: "fanout" as const },
    { name: "cycle", count: 32, participated: 32, history: 2, comments: 2, graph: "cycle" as const },
  ].filter(shape => !arg("fixture") || shape.name === arg("fixture"));
  assert.ok(shapes.length, "Unknown fixture");
  const results = [];
  for (const shape of shapes) {
    const seedStart = performance.now();
    const fixture = await seedPrivacyFixture(db, shape);
    const fixtureMs = performance.now()-seedStart;
    const actor = { type: "board" as const, source: "session", userId: fixture.userId, authorizingUserId: fixture.userId };
    const cases = [];
    for (const readMode of ["scoped", "unrestricted"]) {
      if (shape.graph && readMode === "unrestricted") continue;
      const conditions = {
        baseline: readMode === "scoped" ? await baseline.issueReadSqlCondition(db, actor) : sql<boolean>`true`,
        treatment: readMode === "scoped" ? await treatment(db, actor) : sql<boolean>`true`,
      };
      for (const jit of ["on", "off"]) {
        await db.$client.unsafe(`set jit=${jit}`);
        for (const caller of ["badge", "list"] as const) {
          const invoke = (target: Db, arm: "baseline" | "treatment") => caller === "badge"
            ? issueService(target).unreadInboxIssueIds(fixture.companyId, fixture.userId, conditions[arm])
            : issueService(target).list(fixture.companyId, { readCondition: conditions[arm], touchedByUserId: fixture.userId, limit: 100, sortField: "id", sortDir: "asc" });
          const samples = { baseline: [] as number[], treatment: [] as number[] };
          for (let round=0; round<7; round++) {
            let before: unknown, after: unknown;
            for (const arm of round%2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const) {
              const start = performance.now();
              const result = await invoke(db, arm);
              if (round >= 2) samples[arm].push(performance.now()-start);
              if (arm === "baseline") before=result; else after=result;
            }
            assert.deepEqual(after, before, `${shape.name}/${readMode}/${jit}/${caller}: full service output/order`);
          }
          const plans = [];
          let expectedRows: unknown[][] | undefined;
          for (const arm of ["baseline", "treatment"] as const) {
            const queries: Query[] = [];
            await invoke(captureDb(db, queries), arm);
            assert.ok(queries.length >= (caller === "badge" ? 2 : 1), "Capture the complete real caller");
            const rows: unknown[][] = [], queryPlans = [];
            for (const query of queries) {
              rows.push(await db.$client.unsafe(query.sql, query.params as never[]).values());
              const [explain] = await db.$client.unsafe(`explain (analyze,buffers,format json) ${query.sql}`, query.params as never[]);
              queryPlans.push({ ...query, rows: rows.at(-1)!.length, work: recursiveIssueWork(explain["QUERY PLAN"][0].Plan), plan: explain["QUERY PLAN"] });
            }
            if (arm === "baseline") expectedRows = rows;
            else assert.deepEqual(rows, expectedRows, `${shape.name}/${readMode}/${jit}/${caller}: every positional SQL field and order`);
            plans.push({ arm, queries: queryPlans });
          }
          const before = stats(samples.baseline), after = stats(samples.treatment);
          cases.push({ readMode, jit, caller, baseline: before, treatment: after, speedup: before.medianMs/after.medianMs, positionalEquality: true, serviceEquality: true, plans });
          console.error(JSON.stringify({ fixture: shape.name, readMode, jit, caller, baseline: before.medianMs, treatment: after.medianMs }));
        }
      }
    }
    results.push({ fixture, fixtureMs, cases });
    await db.$client.unsafe("truncate companies cascade");
  }
  const dependencyVersions = Object.fromEntries(await Promise.all(["postgres", "drizzle-orm"].map(async name => [name, JSON.parse(await fs.readFile(path.join(root,`packages/db/node_modules/${name}/package.json`),"utf8")).version])));
  const report = { baselineRevision, dependencyVersions, maxDenseMs: Number.isFinite(maxDenseMs) ? maxDenseMs : null, treatmentRevision: git("rev-parse", "HEAD"), sourceHashes, baselineSourceSha256: createHash("sha256").update(oldSource).digest("hex"), changedRuntime, checkedInLockSha256: createHash("sha256").update(await fs.readFile(path.join(root,"pnpm-lock.yaml"))).digest("hex"), nodeVersion: process.version, settings, setupMs, totalMs: performance.now()-started, warmupsPerArm: 2, measuredSamplesPerArm: 5, results };
  const evidence = arg("evidence-dir");
  if (evidence) { await fs.mkdir(evidence,{ recursive: true }); await fs.writeFile(path.join(evidence,"benchmark.json"),JSON.stringify(report,null,2)); }
  console.log(JSON.stringify({ ...report, results: results.map(result => ({ ...result, cases: result.cases.map(({ plans, ...rest }) => rest) })) },null,2));
  if (process.argv.includes("--assert-performance")) {
    for (const result of results) for (const c of result.cases) {
      if (c.readMode === "scoped") {
        for (const query of c.plans.find(p => p.arm === "treatment")!.queries) {
          if (!result.fixture.graph) assert.equal(query.work.inspectedRows, 0, "Absent parent frontiers must not inspect company tasks");
        }
        if (["dense","sparse"].includes(result.fixture.name)) assert.ok(c.speedup >= 2, `Scoped representative ${result.fixture.name}/${c.jit}/${c.caller} requires 2x improvement`);
      }
      if (result.fixture.name === "dense" && c.caller === "badge" && c.readMode === "scoped" && c.jit === "on") assert.ok(c.treatment.medianMs <= maxDenseMs, `Original dense scoped badge target ${maxDenseMs}ms remains unmet: ${c.treatment.medianMs.toFixed(2)}ms`);
      if (result.fixture.name === "small" || c.readMode === "unrestricted") assert.ok(c.treatment.medianMs <= Math.max(c.baseline.medianMs*1.25,c.baseline.medianMs+2), "Small/open controls must stay within 25% or 2ms");
    }
  }
} finally {
  await db?.$client.end({timeout:0});
  await database?.cleanup();
  if (admin) { await admin.$client.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); await admin.$client.end({timeout:0}); }
  await fs.rm(baselineDir,{recursive:true,force:true});
  clearInterval(keepAlive);
}
