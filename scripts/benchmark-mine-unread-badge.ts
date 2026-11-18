import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "../server/node_modules/drizzle-orm/index.js";
import { companies, createDb, applyPendingMigrations, inspectMigrations, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { issueService } from "../server/src/services/issues.js";
import { issueReadSqlCondition } from "../server/src/services/authorization.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryPath = (relative: string) => path.join(repositoryRoot, relative);
const gitOutput = (args: string[]) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass a pinned pre-fix --baseline-ref=<commit>");
const baselineRevision = gitOutput(["rev-parse", `${baselineRef}^{commit}`]).trim();
const diagnostic = process.argv.includes("--diagnostic");
const diagnosticDense = process.argv.includes("--diagnostic-dense");
const fixtureFilter = process.argv.find(arg => arg.startsWith("--fixture="))?.slice(10);
assert.ok(fixtureFilter === undefined || ["small", "dense", "sparse"].includes(fixtureFilter), "--fixture must be small, dense or sparse");
const verifyMigration = process.argv.includes("--verify-migration");
const migrationName = "0395_tranquil_firestar.sql";
const indexName = "activity_log_company_user_issue_actor_idx";
const migrationSql = await fs.readFile(repositoryPath(`packages/db/src/migrations/${migrationName}`), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const holdAfterReport = process.argv.find(arg => arg.startsWith("--hold-after-report="))?.slice(20);
const historyDecoys = Number(process.argv.find(arg => arg.startsWith("--history-decoys="))?.slice(17) ?? 0);
assert.ok(Number.isSafeInteger(historyDecoys) && historyDecoys >= 0, "--history-decoys must be a nonnegative integer");
const treatmentIsBaseline = process.argv.includes("--treatment-is-baseline");
const enforceBudget = process.argv.includes("--assert-performance");
const maxDenseArgument = process.argv.find(arg => arg.startsWith("--max-dense-ms="))?.slice(15);
const maxDenseMs = maxDenseArgument === undefined ? Infinity : Number(maxDenseArgument);
const validateBaseline = process.argv.includes("--validate-baseline");
const validateReport = process.argv.find(arg => arg.startsWith("--validate-report="))?.slice(18);
const sampleGateDir = process.argv.find(arg => arg.startsWith("--sample-gate-dir="))?.slice(18);
const evidenceDir = process.argv.find(arg => arg.startsWith("--evidence-dir="))?.slice(15);
const started = performance.now();
const modulePaths = ["server/src/services/issues.ts", "server/src/services/issue-participation.ts"];
const proofPaths = [...modulePaths, "packages/db/src/client.ts", "packages/db/src/schema/activity_log.ts", `packages/db/src/migrations/${migrationName}`];
const changedDependencies = gitOutput(["diff", "--name-only", baselineRevision, "--", "server/src/services", "packages/db/src", "packages/shared/src"]).trim().split("\n").filter(Boolean);
assert.deepEqual(changedDependencies.filter(file => !modulePaths.includes(file) && file !== "packages/db/src/client.ts" && file !== "packages/db/src/schema/activity_log.ts" && !file.startsWith("packages/db/src/migrations/")), [], "Baseline must use unchanged service dependencies");
type PerformanceCase = {
  jit: string; readMode: string; baseline: { medianMs: number }; treatment: { medianMs: number }; speedup: number;
  plans: Array<{ arm: string; queries: Array<{ plan: Array<{ JIT?: { Options?: { Inlining?: boolean; Optimization?: boolean } } }> }> }>;
};
type PerformanceResult = { fixture: { name: string }; cases: PerformanceCase[] };
function assertPerformance(results: PerformanceResult[], arm: "baseline" | "treatment" = "treatment") {
  const comparisons = results.flatMap(result => result.cases.map(control => ({ fixture: result.fixture.name, ...control })));
  const jitOptions = (result: PerformanceCase, selected: "baseline" | "treatment") => result.plans.find(plan => plan.arm === selected)!.queries[0]!.plan[0]!.JIT?.Options;
  const isCompilationTarget = (result: PerformanceCase) => result.jit === "on" && (jitOptions(result, "baseline")?.Inlining || jitOptions(result, "baseline")?.Optimization);
  const targets = comparisons.filter(isCompilationTarget);
  assert.ok(targets.length > 0, "Fixture must reproduce expensive baseline JIT compilation");
  for (const result of targets) {
    const options = jitOptions(result, arm);
    assert.ok(!options?.Inlining && !options?.Optimization, `${arm} must avoid full JIT compilation passes`);
    if (arm === "treatment") assert.ok(result.speedup >= 1.5, `Default-JIT target requires at least 1.5x improvement, observed ${result.speedup.toFixed(2)}x`);
  }
  if (arm === "baseline") return;
  for (const result of comparisons) {
    if (result.fixture === "dense" && result.jit === "on" && Number.isFinite(maxDenseMs)) assert.ok(result.treatment.medianMs <= maxDenseMs, `Dense default-JIT fixture exceeds ${maxDenseMs} ms local budget: ${result.treatment.medianMs.toFixed(2)} ms`);
    if (result.fixture !== "dense" && !isCompilationTarget(result)) assert.ok(result.treatment.medianMs <= Math.max(result.baseline.medianMs * 1.25, result.baseline.medianMs + 2), `Control regressed beyond 25% and 2 ms allowance: ${result.fixture}/${result.readMode}/${result.jit}`);
  }
}

if (validateReport) {
  const report = JSON.parse(await fs.readFile(validateReport, "utf8"));
  assert.equal(report.baselineRevision, baselineRevision);
  assert.deepEqual(Object.keys(report.sourceHashes).sort(), [...proofPaths].sort(), "Report must include the measured index and runner sources");
  for (const [file, hash] of Object.entries(report.sourceHashes)) assert.equal(createHash("sha256").update(await fs.readFile(repositoryPath(file))).digest("hex"), hash, `Source changed since measured report: ${file}`);
  assertPerformance(report.results, validateBaseline ? "baseline" : "treatment");
  console.log(JSON.stringify({ status: "performance budget passed", report: validateReport, baselineRevision, sourceHashes: report.sourceHashes }));
  process.exit(0);
}
const baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".mine-unread-baseline-"));
const rewrite = (source: string, originalPath: string) => source.replace(/from "(\.{1,2}\/[^\"]+)"/g, (_match, specifier: string) => {
  const resolved = fileURLToPath(new URL(specifier, pathToFileURL(repositoryPath(originalPath))));
  const target = resolved.endsWith("/services/issue-participation.js")
    ? path.join(baselineDir, "issue-participation.ts") : resolved;
  return `from ${JSON.stringify(target)}`;
});
for (const modulePath of modulePaths) {
  const source = gitOutput(["show", `${baselineRevision}:${modulePath}`]);
  await fs.writeFile(path.join(baselineDir, path.basename(modulePath)), rewrite(source, modulePath));
}
const baseline = await import(pathToFileURL(path.join(baselineDir, "issues.ts")).href) as typeof import("../server/src/services/issues.js");
type Query = { sql: string; params: unknown[]; rows: unknown[]; elapsedMs: number };
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let baselineDb: Db | undefined;
let baselineConnectionString: string;
const keepAlive = setInterval(() => {}, 1000);
try {
  database = await startEmbeddedPostgresTestDatabase("mine-unread-benchmark-");
  db = createDb(database.connectionString, { maxConnections: 1 });
  await db.$client.unsafe('CREATE DATABASE "mine_unread_baseline"');
  const baselineUrl = new URL(database.connectionString);
  baselineUrl.pathname = "/mine_unread_baseline";
  baselineConnectionString = baselineUrl.href;
  await applyPendingMigrations(baselineConnectionString);
  baselineDb = createDb(baselineConnectionString, { maxConnections: 1 });
  await baselineDb.$client.unsafe("set client_min_messages = warning");
  await baselineDb.$client.unsafe(`DROP INDEX "${indexName}"`);
  await baselineDb.$client.unsafe("DELETE FROM drizzle.__drizzle_migrations WHERE hash=$1", [migrationHash]);
  const indexDefinitions = async (source: Db) => source.$client.unsafe("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname");
  const baselineIndexes = await indexDefinitions(baselineDb), treatmentIndexes = await indexDefinitions(db);
  assert.deepEqual(treatmentIndexes.filter(index => index.indexname !== indexName), [...baselineIndexes]);
  await db.$client.unsafe("set client_min_messages = warning");
  const [settings] = await db.$client.unsafe("select version(), current_setting('shared_buffers') shared_buffers, current_setting('work_mem') work_mem, current_setting('jit') jit, current_setting('jit_above_cost') jit_above_cost");
  await issueService(db).unreadInboxIssueIds(randomUUID(), "parse-smoke", sql<boolean>`true`);
  const setupMs = performance.now() - started;
  const captured = new Error("Ranking query captured before execution");
  function captureDb(queries: Query[], captureOnly = false, sourceDb = db!): Db {
    function captureBuilder(builder: any) {
      const from = builder.from.bind(builder);
      builder.from = (...args: any[]) => {
        const query = from(...args), execute = query.execute.bind(query);
        query.execute = async () => {
          const statement = query.toSQL(), started = performance.now();
          if (captureOnly) { queries.push({ ...statement, rows: [], elapsedMs: 0 }); throw captured; }
          const rows = await execute();
          queries.push({ ...statement, rows, elapsedMs: performance.now() - started });
          return rows;
        };
        return query;
      };
      return builder;
    }
    return new Proxy(sourceDb, { get(target, key) {
      if (key === "select") return (...fields: any[]) => captureBuilder((target.select as any)(...fields));
      if (key === "with") return (...ctes: any[]) => {
        const builder = (target.with as any)(...ctes), select = builder.select.bind(builder);
        builder.select = (...fields: any[]) => captureBuilder(select(...fields));
        return builder;
      };
      return Reflect.get(target, key);
    } });
  }
  const fixtureSeeds = new Map<string, { companyId: string; ids: string[]; payload: string }>();
  async function seed(name: string, count: number, participatedCount: number, logsPerIssue: number, commentsPerIssue: number, target = db!) {
    const fixtureStart = performance.now();
    const inputs = fixtureSeeds.get(name) ?? { companyId: randomUUID(), ids: Array.from({ length: count }, () => randomUUID()), payload: randomBytes(3072).toString("base64") };
    fixtureSeeds.set(name, inputs);
    const { companyId, ids, payload } = inputs, userId = `synthetic-${name}`;
    await target.insert(companies).values({ id: companyId, name: `Synthetic Mine ${name}`, issuePrefix: name.toUpperCase() });
    await target.$client.unsafe(`insert into issues(id,company_id,title,status,created_by_user_id,created_at,updated_at)
      select id,$2::uuid,'Synthetic '||n,'todo',case when n <= $4 and n%2=0 then $3 else 'unrelated-human' end,
        '2026-01-01'::timestamptz,'2026-01-01'::timestamptz+n*interval '1 second'
      from unnest($1::uuid[]) with ordinality as f(id,n)`, [ids, companyId, userId, participatedCount]);
    await target.$client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
      select $1::uuid,'issue',i.id::text,case when n=1 or n%10=0 then 'user' else 'agent' end,
        case when (n=1 or n%20=0) and i.id=ANY($5::uuid[]) then $4 when n=1 or n%10=0 then 'other-human' else 'synthetic-worker' end,
        case when n=1 or n%10=0 then 'issue.updated' when n%5=0 then 'issue.read_marked' else 'issue.updated' end,
        jsonb_build_object('padding',$2::text),'2026-01-01'::timestamptz+n*interval '1 second'
      from issues i cross join generate_series(1,$3::int)n where company_id=$1::uuid order by n,i.id`, [companyId, payload, logsPerIssue, userId, ids.slice(0, participatedCount)]);
    await target.$client.unsafe(`insert into issue_comments(company_id,issue_id,author_user_id,body,created_at)
      select $1::uuid,id,null,$2,'2026-01-02'::timestamptz+n*interval '1 second'
      from issues cross join generate_series(1,$3::int)n where company_id=$1::uuid order by n,id`, [companyId, payload, commentsPerIssue]);
    if (historyDecoys > 0 && name !== "small") await target.$client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
      select $1::uuid,'heartbeat_run',gen_random_uuid()::text,'agent','synthetic-worker','heartbeat.run.created',
        jsonb_build_object('padding',left($2,256)),'2026-01-01'::timestamptz+n*interval '1 second'
      from generate_series(1,$3::int)n`, [companyId, payload, historyDecoys]);
    await target.$client.unsafe("ANALYZE");
    const [counts] = await target.$client.unsafe(`SELECT count(*)::int participants FROM issues i WHERE company_id=$1 AND
      (created_by_user_id=$2 OR EXISTS(SELECT 1 FROM activity_log a WHERE a.company_id=$1 AND a.entity_type='issue' AND a.entity_id=i.id::text AND a.actor_type='user' AND a.actor_id=$2 AND a.action='issue.updated'))`, [companyId, userId]);
    assert.equal(counts!.participants, participatedCount, "Fixture must include its complete declared personal set");
    const [actorCounts] = await target.$client.unsafe("SELECT count(*)::int rows FROM activity_log WHERE company_id=$1 AND actor_type='user' AND actor_id=$2 AND entity_type='issue'", [companyId, userId]);
    return { name, companyId, userId, issues: count, participatedCount, activityRows: count * logsPerIssue,
      commentRows: count * commentsPerIssue, targetUserActivityRows: actorCounts!.rows, createdParticipation: Math.floor(participatedCount / 2), activityParticipation: Math.ceil(participatedCount / 2), historyDecoys: name === "small" ? 0 : historyDecoys, payloadBytes: Buffer.byteLength(payload), fixtureMs: performance.now() - fixtureStart };
  }
  async function run(factory: typeof issueService, fixture: Awaited<ReturnType<typeof seed>>, readCondition: Awaited<ReturnType<typeof issueReadSqlCondition>>, sourceDb: Db) {
    const queries: Query[] = [], started = performance.now();
    const result = await factory(captureDb(queries, false, sourceDb)).unreadInboxIssueIds(fixture.companyId, fixture.userId, readCondition);
    const elapsedMs = performance.now() - started;
    return { result, queries, elapsedMs, serialSqlMs: queries.reduce((total, query) => total + query.elapsedMs, 0) };
  }
  const stats = (values: number[]) => ({ samplesMs: values, medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)], minMs: Math.min(...values), maxMs: Math.max(...values) });
  let migrationProof: unknown;
  async function measureMigration(fixture: Awaited<ReturnType<typeof seed>>) {
    const pending = await inspectMigrations(baselineConnectionString);
    assert.deepEqual(pending.pendingMigrations, [migrationName]);
    const monitor = createDb(baselineConnectionString, { maxConnections: 2 });
    await monitor.$client.unsafe("SET lock_timeout='1s'");
    await monitor.$client.unsafe("SET statement_timeout='5s'");
    const size = await monitor.$client.unsafe("SELECT reltuples::bigint estimated_rows,pg_relation_size(oid)::text heap_bytes,pg_total_relation_size(oid)::text total_bytes FROM pg_class WHERE oid='activity_log'::regclass");
    let completed = false;
    const reads: number[] = [], writes: number[] = [], progress: unknown[] = [];
    const load = (async () => {
      while (!completed) {
        let start = performance.now();
        await monitor.$client.unsafe("INSERT INTO activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action) VALUES($1,'issue',$2,'user','synthetic-migration-writer','issue.updated')", [fixture.companyId, fixtureSeeds.get(fixture.name)!.ids[0]!]);
        writes.push(performance.now() - start);
        start = performance.now();
        await monitor.$client.unsafe("SELECT id FROM issues WHERE company_id=$1 LIMIT 1", [fixture.companyId]);
        reads.push(performance.now() - start);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();
    const observe = (async () => {
      while (!completed) {
        const rows = await monitor.$client.unsafe("SELECT phase,blocks_done,blocks_total FROM pg_stat_progress_create_index WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database())");
        progress.push(...rows);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();
    let firstRunMs: number;
    try {
      const start = performance.now();
      await applyPendingMigrations(baselineConnectionString);
      firstRunMs = performance.now() - start;
    } finally {
      completed = true;
      await Promise.all([load, observe]);
    }
    assert.ok(reads.length > 0 && writes.length > 0, "Migration proof must overlap real reads and writes");
    const validity = async () => (await monitor.$client.unsafe("SELECT i.indisvalid valid,pg_relation_size(i.indexrelid)::text bytes FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=$1", [indexName]))[0];
    assert.equal((await validity())?.valid, true);
    const rerunStart = performance.now();
    await applyPendingMigrations(baselineConnectionString);
    const rerunMs = performance.now() - rerunStart;
    await monitor.$client.unsafe(`DROP INDEX CONCURRENTLY "${indexName}"`);
    await monitor.$client.unsafe("DELETE FROM drizzle.__drizzle_migrations WHERE hash=$1", [migrationHash]);
    const blocker = await monitor.$client.reserve();
    let interruptionCode: string | undefined;
    try {
      await blocker.unsafe("BEGIN");
      await blocker.unsafe("INSERT INTO activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action) VALUES($1,'issue',$2,'agent','synthetic-blocker','issue.updated')", [fixture.companyId, fixtureSeeds.get(fixture.name)!.ids[0]!]);
      const interrupted = applyPendingMigrations(baselineConnectionString).catch((error: { code?: string }) => { interruptionCode = error.code; });
      const deadline = Date.now() + 10_000;
      let cancelled = false;
      while (Date.now() < deadline) {
        const active = await monitor.$client.unsafe("SELECT p.pid FROM pg_stat_progress_create_index p JOIN pg_class c ON c.oid=p.index_relid WHERE p.datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND c.relname=$1 AND p.phase LIKE 'waiting for writers%'", [indexName]);
        if (active.length) { await monitor.$client.unsafe("SELECT pg_cancel_backend($1)", [active[0]!.pid]); cancelled = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await blocker.unsafe("ROLLBACK");
      await interrupted;
      assert.ok(cancelled, "Observe and cancel only this owned migration's blocked index build");
    } finally {
      await blocker.unsafe("ROLLBACK");
      blocker.release();
    }
    assert.equal(interruptionCode, "57014");
    const interruptedIndex = await validity();
    assert.equal(interruptedIndex?.valid, false);
    assert.deepEqual((await inspectMigrations(baselineConnectionString)).pendingMigrations, [migrationName]);
    const retryStart = performance.now();
    await applyPendingMigrations(baselineConnectionString);
    const retryMs = performance.now() - retryStart;
    const finalIndex = await validity();
    assert.equal(finalIndex?.valid, true);
    assert.equal((await inspectMigrations(baselineConnectionString)).status, "upToDate");
    await monitor.$client.end({ timeout: 0 });
    return { migrationName, migrationSha256: createHash("sha256").update(migrationSql).digest("hex"), statementCount: 1, firstRunMs, rerunMs, retryMs, size, reads: stats(reads), writes: stats(writes), progress, interruptionCode, interruptedIndex, finalIndex };
  }
  const results = [];
  const shapes = diagnostic ? [[diagnosticDense ? "dense" : "sparse", 1200, diagnosticDense ? 1200 : 12, 50, 20] as const] : [
    ["small", 12, 12, 4, 2],
    ["dense", 1200, 1200, 50, 20],
    ["sparse", 1200, 12, 50, 20],
  ] as const;
  const selectedShapes = shapes.filter(shape => fixtureFilter === undefined || shape[0] === fixtureFilter);
  assert.ok(selectedShapes.length, "Selected fixture must exist in this diagnostic mode");
  if (holdAfterReport) assert.equal(selectedShapes.length, 1, "Retain only one explicitly selected diagnostic fixture");
  for (const shape of selectedShapes) {
    const fixture = { ...await seed(...shape), baselineFixtureMs: (await seed(...shape, baselineDb)).fixtureMs };
    if (sampleGateDir) {
      await fs.mkdir(sampleGateDir, { recursive: true });
      const release = path.join(sampleGateDir, `${fixture.name}.release`);
      const scoped = await issueReadSqlCondition(db, { type: "board", source: "session", userId: fixture.userId, authorizingUserId: fixture.userId });
      const estimatedPlans = [];
      await db.$client.unsafe("set jit = on");
      await baselineDb.$client.unsafe("set jit = on");
      for (const [arm, factory] of [["baseline", baseline.issueService], ["treatment", issueService]] as const) {
        const queries: Query[] = [];
        try { await factory(captureDb(queries, true, arm === "baseline" ? baselineDb : db)).unreadInboxIssueIds(fixture.companyId, fixture.userId, scoped); }
        catch (error) { if (error !== captured) throw error; }
        assert.equal(queries.length, 1);
        const query = queries[0]!;
        const [plan] = await (arm === "baseline" ? baselineDb : db).$client.unsafe(`EXPLAIN (FORMAT JSON) ${query.sql}`, query.params as never[]);
        estimatedPlans.push({ arm, plan: plan["QUERY PLAN"] });
      }
      await fs.writeFile(path.join(sampleGateDir, `${fixture.name}.ready.json`), JSON.stringify({ fixture, settings, estimatedPlans }));
      console.error(`Ready for paired samples: ${fixture.name}`);
      const deadline = Date.now() + 600_000;
      while (true) {
        try { await fs.access(release); break; } catch {}
        assert.ok(Date.now() < deadline, `Timed out waiting for ${release}`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      await fs.rm(release);
    }
    const cases = [];
    for (const readMode of ["unrestricted", "scoped"]) {
    const readCondition = readMode === "unrestricted" ? sql<boolean>`true` : await issueReadSqlCondition(db, {
      type: "board", source: "session", userId: fixture.userId, authorizingUserId: fixture.userId,
    });
    for (const jit of ["on", "off"]) {
      await db.$client.unsafe(`set jit = ${jit}`);
      await baselineDb.$client.unsafe(`set jit = ${jit}`);
      const estimatedPlans = [];
      if (diagnostic) {
        for (const [arm, factory] of [["baseline", baseline.issueService], ["treatment", issueService]] as const) {
          const queries: Query[] = [];
          try { await factory(captureDb(queries, true, arm === "baseline" ? baselineDb : db)).unreadInboxIssueIds(fixture.companyId, fixture.userId, readCondition); }
          catch (error) { if (error !== captured) throw error; }
          assert.equal(queries.length, 1);
          const query = queries[0]!;
          const [plan] = await (arm === "baseline" ? baselineDb : db).$client.unsafe(`EXPLAIN (FORMAT JSON) ${query.sql}`, query.params as never[]);
          estimatedPlans.push({ arm, plan: plan["QUERY PLAN"] });
          console.error(JSON.stringify({ diagnostic: fixture.name, jit, arm, estimatedCost: plan["QUERY PLAN"][0].Plan["Total Cost"] }));
        }
      }
      const beforeTimes: number[] = [], afterTimes: number[] = [];
      let beforeResult: string[] | undefined, afterResult: string[] | undefined;
      for (let iteration = diagnostic ? 0 : -2; iteration < (diagnostic ? 1 : 5); iteration++) {
        const order = iteration % 2 === 0 ? ["before", "after"] : ["after", "before"];
        for (const arm of order) {
          const sourceDb = arm === "before" ? baselineDb : db;
          const factory = arm === "before" || treatmentIsBaseline ? baseline.issueService : issueService;
          const start = performance.now();
          const current = await factory(sourceDb).unreadInboxIssueIds(fixture.companyId, fixture.userId, readCondition);
          const elapsedMs = performance.now() - start;
          if (arm === "before") { beforeResult = current; if (iteration >= 0) beforeTimes.push(elapsedMs); }
          else { afterResult = current; if (iteration >= 0) afterTimes.push(elapsedMs); }
        }
        assert.deepEqual(afterResult, beforeResult, `${fixture.name}/${jit}: complete returned ID order`);
      }
      const before = await run(baseline.issueService, fixture, readCondition, baselineDb);
      const after = await run(treatmentIsBaseline ? baseline.issueService : issueService, fixture, readCondition, db);
      assert.deepEqual(before.result, beforeResult, "SQL capture must preserve the measured baseline result");
      assert.deepEqual(after.result, afterResult, "SQL capture must preserve the measured treatment result");
      assert.equal(before!.queries.length, 2);
      assert.equal(after!.queries.length, 2);
      for (let index = 0; index < 2; index++) {
        const oldQuery = before!.queries[index]!, newQuery = after!.queries[index]!;
        const oldRows = await baselineDb.$client.unsafe(oldQuery.sql, oldQuery.params as never[]).values();
        const newRows = await db.$client.unsafe(newQuery.sql, newQuery.params as never[]).values();
        assert.deepEqual(newRows, oldRows, `${fixture.name}/${jit}: full positional SQL results phase ${index + 1}`);
      }
      const plans = [];
      for (const [arm, current] of [["baseline", before!], ["treatment", after!]] as const) {
        const queries = [];
        for (const query of current.queries) {
          const [plan] = await (arm === "baseline" ? baselineDb : db).$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
          queries.push({ sql: query.sql, params: query.params, rows: query.rows.length, plan: plan["QUERY PLAN"] });
        }
        plans.push({ arm, queries });
      }
      const baselineStats = stats(beforeTimes), treatmentStats = stats(afterTimes);
      cases.push({ readMode, jit, baseline: baselineStats, treatment: treatmentStats, speedup: baselineStats.medianMs / treatmentStats.medianMs, equalIds: after!.result.length, estimatedPlans, plans });
    }
    }
    results.push({ fixture, cases });
    if (sampleGateDir) await fs.writeFile(path.join(sampleGateDir, `${fixture.name}.done.json`), JSON.stringify({ fixture, cases }));
    if (verifyMigration && shape === selectedShapes[selectedShapes.length - 1]) migrationProof = await measureMigration(fixture);
    if (!holdAfterReport) await db.$client.unsafe("TRUNCATE activity_log, issues, companies CASCADE");
    if (!holdAfterReport) await baselineDb.$client.unsafe("TRUNCATE activity_log, issues, companies CASCADE");
  }
  const report = { baselineRevision, treatmentRevision: gitOutput(["rev-parse", "HEAD"]).trim(),
    treatmentIsBaseline, diagnostic, migrationProof, baselineIndexes, treatmentIndexes, sourceHashes: Object.fromEntries(await Promise.all(proofPaths.map(async file => [file, createHash("sha256").update(await fs.readFile(repositoryPath(file))).digest("hex")]))),
    checkedInLockSha256: createHash("sha256").update(await fs.readFile(repositoryPath("pnpm-lock.yaml"))).digest("hex"), nodeVersion: process.version, dependencyVersions: Object.fromEntries(await Promise.all(["postgres", "drizzle-orm"].map(async name => [name, JSON.parse(await fs.readFile(repositoryPath(`packages/db/node_modules/${name}/package.json`), "utf8")).version]))), settings, setupMs, totalMs: performance.now() - started, results };
  const json = JSON.stringify(report, null, 2);
  if (evidenceDir) { await fs.mkdir(evidenceDir, { recursive: true }); await fs.writeFile(path.join(evidenceDir, "benchmark.json"), json); }
  console.log(json);
  if (holdAfterReport) {
    await fs.mkdir(holdAfterReport, { recursive: true });
    await fs.writeFile(path.join(holdAfterReport, "ready.json"), JSON.stringify({ baselineConnectionString, treatmentConnectionString: database.connectionString, baselineDir, fixture: results[0]!.fixture }), { mode: 0o600 });
    const deadline = Date.now() + 600_000;
    while (true) {
      try { await fs.access(path.join(holdAfterReport, "release")); await fs.rm(path.join(holdAfterReport, "release")); break; } catch {}
      assert.ok(Date.now() < deadline, "Timed out waiting for retained diagnostic release");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  if (enforceBudget && !diagnostic) assertPerformance(results);
} finally {
  if (holdAfterReport) await fs.rm(path.join(holdAfterReport, "ready.json"), { force: true });
  await baselineDb?.$client.end({ timeout: 0 });
  await db?.$client.end({ timeout: 0 });
  await database?.cleanup();
  await fs.rm(baselineDir, { recursive: true, force: true });
  clearInterval(keepAlive);
}
