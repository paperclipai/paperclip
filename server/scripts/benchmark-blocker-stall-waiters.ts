import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PerformanceObserver, performance, type PerformanceEntry } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createDb, startEmbeddedPostgresTestDatabase } from "../../packages/db/src/index.js";
import { markStallWakeDelivered, seedBlockerStall, seedBlockerStallCompany } from "../src/__tests__/helpers/blocker-stall-fixture.js";
import * as current from "../src/services/recovery/blocker-stall-wakeups.js";

const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const baselineRevision = git("rev-parse", "--verify", `${baselineRef}^{commit}`).trim();
const modulePath = "server/src/services/recovery/blocker-stall-wakeups.ts";
const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const STALLS = size("STALLS", 20), ITERATIONS = size("ITERATIONS", 300), PASSES = size("PASSES", 5);
type Wakeups = Pick<typeof current, "wakeWaitersOfStalledIssues">;

const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let baselineDir: string | undefined;
let collections: PerformanceEntry[] = [];
const gcObserver = new PerformanceObserver(list => { collections.push(...list.getEntries()); });
gcObserver.observe({ entryTypes: ["gc"] });
function collectionsBetween(start: number, end: number) {
  collections.push(...gcObserver.takeRecords());
  const within = collections.filter(entry => entry.startTime >= start && entry.startTime <= end);
  collections = collections.filter(entry => entry.startTime > end);
  return { count: within.length, ms: within.reduce((sum, entry) => sum + entry.duration, 0) };
}
const allocated = () => (v8.getHeapStatistics() as { total_allocated_bytes?: number }).total_allocated_bytes;
v8.setFlagsFromString("--expose-gc");
const collectGarbage = vm.runInNewContext("gc") as () => void;

try {
  const moduleUrl = new URL(`../../${modulePath}`, import.meta.url);
  baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.blocker-stall-baseline-"));
  const baselineFile = path.join(baselineDir, "blocker-stall-wakeups.ts");
  await fs.writeFile(baselineFile, git("show", `${baselineRevision}:${modulePath}`).replace(/from "(\.{1,2}\/[^"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`));
  const baseline = await import(pathToFileURL(baselineFile).href) as Wakeups;
  const versions: Array<{ label: "baseline" | "treatment"; wakeups: Wakeups }> = [
    { label: "baseline", wakeups: baseline }, { label: "treatment", wakeups: current }];

  temporary = await startEmbeddedPostgresTestDatabase("blocker-stall-waiters-benchmark-");
  db = createDb(temporary.connectionString);
  const database = db;
  database.$client.options.onnotice = () => {};
  const company = await seedBlockerStallCompany(database);
  const stalls = [];
  for (let index = 0; index < STALLS; index++) {
    const stall = await seedBlockerStall(database, company, { dependents: 1 });
    await markStallWakeDelivered(database, stall, stall.parent!.id);
    await markStallWakeDelivered(database, stall, stall.dependents[0]!.id);
    stalls.push(stall);
  }
  const enqueueWakeup = async () => { throw new Error("Every waiter of the fixture is already woken"); };
  const scenarios = {
    sweep: (wakeups: Wakeups) => wakeups.wakeWaitersOfStalledIssues(database, enqueueWakeup, { companyId: company.companyId }),
    task: (wakeups: Wakeups) => wakeups.wakeWaitersOfStalledIssues(database, enqueueWakeup,
      { companyId: company.companyId, issueId: stalls[0]!.stalled.id }),
  };
  type Scenario = keyof typeof scenarios;
  const names = Object.keys(scenarios) as Scenario[];
  const waiterRead = (text: string) => text.includes("issue_blocker_stalled:");

  let sent: Array<{ text: string; parameters: unknown[] }> | null = null;
  (database.$client.options as { debug?: unknown }).debug = (_connection: number, text: string, parameters: unknown[]) => {
    sent?.push({ text, parameters });
  };
  async function observe(name: Scenario, wakeups: Wakeups) {
    sent = [];
    const result = await scenarios[name](wakeups);
    const statements = sent;
    sent = null;
    return { result, statements };
  }
  const statements: Record<string, { count: number; waiterReads: number; waiterReadBytes: number; waiterReadParameters: number }> = {};
  for (const name of names) {
    const before = await observe(name, baseline), after = await observe(name, current);
    assert.deepEqual(after, before, `${name}: result, statements and parameters must match the baseline`);
    const reads = after.statements.filter(statement => waiterRead(statement.text));
    assert.ok(reads.length > 0, `${name}: the waiter read was sent`);
    statements[name] = { count: after.statements.length, waiterReads: reads.length,
      waiterReadBytes: Buffer.byteLength(reads[0]!.text), waiterReadParameters: reads[0]!.parameters.length };
  }
  assert.equal(statements.sweep!.waiterReads, STALLS);

  const paging = await seedBlockerStallCompany(database, "paused");
  const paged = await seedBlockerStall(database, paging, { dependents: 101 });
  const orphan = await seedBlockerStall(database, paging, { parent: false, dependents: 101 });
  const shapes = {
    companyPages: { companyId: paging.companyId },
    childWaiter: { companyId: paging.companyId, issueId: paged.dependents[0]!.id },
    blockerWaiter: { companyId: paging.companyId, issueId: orphan.dependents[0]!.id },
  };
  const waiterReadTexts = new Set<string>();
  for (const [name, options] of Object.entries(shapes)) {
    const observed = [];
    for (const version of versions) {
      sent = [];
      const { retryAt, ...result } = await version.wakeups.wakeWaitersOfStalledIssues(database, enqueueWakeup, options);
      observed.push({ result, deferredRetry: retryAt !== null, statements: sent });
      sent = null;
    }
    assert.deepEqual(observed[1], observed[0], `${name}: result, statements and parameters must match the baseline`);
    for (const statement of observed[1]!.statements) if (waiterRead(statement.text)) waiterReadTexts.add(statement.text);
  }
  assert.equal(waiterReadTexts.size, 6, "First and later pages of a child and of a blocker stall, and one waiter of each");

  async function measure(name: Scenario, wakeups: Wakeups) {
    const written = PgDialect.prototype.sqlToQuery;
    let writes = 0;
    PgDialect.prototype.sqlToQuery = function (...args: Parameters<typeof written>) {
      const query = written.apply(this, args);
      if (waiterRead(query.sql)) writes += 1;
      return query;
    };
    try {
      collectGarbage();
      const before = { cpu: process.cpuUsage(), bytes: allocated(), at: performance.now() };
      for (let index = 0; index < ITERATIONS; index++) await scenarios[name](wakeups);
      const endedAt = performance.now(), cpu = process.cpuUsage(before.cpu), bytes = allocated();
      await new Promise(resolve => setImmediate(resolve));
      const gc = collectionsBetween(before.at, endedAt);
      return { waiterSqlTextsWrittenPerCall: writes / ITERATIONS, cpuUsPerCall: (cpu.user + cpu.system) / ITERATIONS,
        wallUsPerCall: (endedAt - before.at) * 1000 / ITERATIONS,
        allocatedKbPerCall: bytes === undefined || before.bytes === undefined ? null : (bytes - before.bytes) / 1024 / ITERATIONS,
        gcPausesPer1000Calls: gc.count * 1000 / ITERATIONS, gcMsPer1000Calls: gc.ms * 1000 / ITERATIONS };
    } finally { PgDialect.prototype.sqlToQuery = written; }
  }
  for (const version of versions) for (const name of names) await measure(name, version.wakeups);
  const samples = new Map<string, Array<Awaited<ReturnType<typeof measure>>>>();
  for (let pass = 0; pass < PASSES; pass++) {
    for (const version of pass % 2 === 0 ? versions : [...versions].reverse()) {
      for (const name of names) {
        const key = `${name}/${version.label}`;
        samples.set(key, [...samples.get(key) ?? [], await measure(name, version.wakeups)]);
      }
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const results = names.flatMap(name => versions.map(version => {
    const passes = samples.get(`${name}/${version.label}`)!;
    const field = (key: keyof (typeof passes)[number]) => passes.every(pass => pass[key] !== null)
      ? Number(median(passes.map(pass => pass[key] as number)).toFixed(2)) : null;
    return { scenario: name, version: version.label, statementsPerCall: statements[name]!.count,
      waiterReadsPerCall: statements[name]!.waiterReads, waiterSqlTextsWrittenPerCall: field("waiterSqlTextsWrittenPerCall"),
      allocatedKbPerCall: field("allocatedKbPerCall"), cpuUsPerCall: field("cpuUsPerCall"), wallUsPerCall: field("wallUsPerCall"),
      gcPausesPer1000Calls: field("gcPausesPer1000Calls"), gcMsPer1000Calls: field("gcMsPer1000Calls") };
  }));
  const [{ version }] = await database.$client.unsafe("select version() as version") as unknown as [{ version: string }];
  console.log(JSON.stringify({ baselineRevision, treatmentRevision: git("rev-parse", "HEAD").trim(),
    treatmentDiff: git("diff", "--stat", "HEAD", "--", modulePath).trim() || "none",
    node: process.version, postgres: version.split(" ").slice(0, 2).join(" "), stalls: STALLS, iterations: ITERATIONS, passes: PASSES,
    correctness: { sameResult: true, sameStatementsAndParameters: true, waiterReadShapesCompared: waiterReadTexts.size },
    waiterRead: { sqlBytes: statements.sweep!.waiterReadBytes, parameters: statements.sweep!.waiterReadParameters }, results }, null, 2));
} finally {
  gcObserver.disconnect();
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
