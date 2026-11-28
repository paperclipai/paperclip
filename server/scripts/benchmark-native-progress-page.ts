import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PerformanceObserver, performance, type PerformanceEntry } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";
import { PgDialect } from "drizzle-orm/pg-core";
import { chatPublications, createDb, heartbeatRunEvents, heartbeatRuns, startEmbeddedPostgresTestDatabase } from "../../packages/db/src/index.js";
import { createChatMilestoneFixtures } from "../src/__tests__/helpers/chat-milestone-fixtures.js";
import * as current from "../src/services/chat-native-progress.js";
import { safeNativeChatProgressForEvent } from "../src/services/safe-native-chat-progress.js";

const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const baselineRevision = git("rev-parse", "--verify", `${baselineRef}^{commit}`).trim();
const modulePath = "server/src/services/chat-native-progress.ts";
const ITERATIONS = Number(process.env.ITERATIONS ?? 2000), PASSES = Number(process.env.PASSES ?? 5);
type Progress = Pick<typeof current, "loadNativeChatProgressScopes" | "reconcileNativeChatProgress">;

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
  baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.native-progress-baseline-"));
  const baselineFile = path.join(baselineDir, "chat-native-progress.ts");
  await fs.writeFile(baselineFile, git("show", `${baselineRevision}:${modulePath}`).replace(/from "(\.{1,2}\/[^"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`));
  const baseline = await import(pathToFileURL(baselineFile).href) as Progress;
  const versions: Array<{ label: "baseline" | "treatment"; progress: Progress }> = [
    { label: "baseline", progress: baseline }, { label: "treatment", progress: current }];

  temporary = await startEmbeddedPostgresTestDatabase("native-progress-page-benchmark-");
  db = createDb(temporary.connectionString);
  const database = db;
  const fixtures = createChatMilestoneFixtures(database);
  const chat = await fixtures.create();
  const runId = randomUUID(), baseKey = `run:${runId}:working:${chat.endpointId}`;
  await database.insert(heartbeatRuns).values({ id: runId, companyId: chat.companyId, agentId: chat.agentId, nativeIssueId: chat.issueId,
    runtimeMode: "native", status: "running", contextSnapshot: { issueId: chat.issueId } });
  await database.insert(heartbeatRunEvents).values({ companyId: chat.companyId, agentId: chat.agentId, runId, seq: 1,
    eventType: "item.completed", createdAt: new Date(Date.now() - 60_000) });
  const phase = safeNativeChatProgressForEvent("item.completed", "Maya")!.phase;
  await database.insert(chatPublications).values([
    { companyId: chat.companyId, endpointId: chat.endpointId, conversationId: chat.conversationId, issueId: chat.issueId,
      idempotencyKey: baseKey, payload: { text: "Maya is working…", progressState: "working" }, state: "published",
      createdAt: new Date(Date.now() - 600_000) },
    { companyId: chat.companyId, endpointId: chat.endpointId, conversationId: chat.conversationId, issueId: chat.issueId,
      idempotencyKey: `${baseKey}:native:${phase}:1`, payload: { text: "Maya is making progress…", progressState: "working" },
      state: "published", createdAt: new Date(Date.now() - 30_000) },
  ]);
  const scope = { companyId: chat.companyId, issueId: chat.issueId };
  const since = new Date(Date.now() - 3_600_000);
  const scenarios = {
    page: (progress: Progress) => progress.loadNativeChatProgressScopes(database, scope),
    wake: (progress: Progress) => progress.reconcileNativeChatProgress(database, { scope, since, limit: 100 }),
  };
  type Scenario = keyof typeof scenarios;
  const names = Object.keys(scenarios) as Scenario[];

  let sent: Array<{ text: string; parameters: unknown[] }> | null = null;
  (database.$client.options as { debug?: unknown }).debug = (_connection: number, text: string, parameters: unknown[]) => {
    sent?.push({ text, parameters });
  };
  const comparable = (statements: NonNullable<typeof sent>) => statements.map(statement => ({ text: statement.text,
    parameters: statement.parameters.map(value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) ? "<time>" : value) }));
  async function observe(name: Scenario, progress: Progress) {
    sent = [];
    const result = await scenarios[name](progress);
    const statements = sent;
    sent = null;
    return { result, statements: comparable(statements) };
  }
  const statements: Record<string, { count: number; pageReadBytes: number; pageReadParameters: number }> = {};
  for (const name of names) {
    const before = await observe(name, baseline), after = await observe(name, current);
    assert.deepEqual(after, before, `${name}: result, statements and parameters must match the baseline`);
    const pageRead = after.statements.find(statement => statement.text.includes("safe_native_progress_base_publication"));
    assert.ok(pageRead, `${name}: the page read was sent`);
    statements[name] = { count: after.statements.length, pageReadBytes: Buffer.byteLength(pageRead.text),
      pageReadParameters: pageRead.parameters.length };
  }
  assert.deepEqual((await observe("page", current)).result, [scope], "The fixture has one candidate");

  async function measure(name: Scenario, progress: Progress) {
    const written = PgDialect.prototype.sqlToQuery;
    let writes = 0;
    PgDialect.prototype.sqlToQuery = function (...args: Parameters<typeof written>) {
      writes += 1;
      return written.apply(this, args);
    };
    try {
      collectGarbage();
      const before = { cpu: process.cpuUsage(), bytes: allocated(), at: performance.now() };
      for (let index = 0; index < ITERATIONS; index++) await scenarios[name](progress);
      const endedAt = performance.now(), cpu = process.cpuUsage(before.cpu), bytes = allocated();
      await new Promise(resolve => setImmediate(resolve));
      const gc = collectionsBetween(before.at, endedAt);
      return { sqlTextsWrittenPerCall: writes / ITERATIONS, cpuUsPerCall: (cpu.user + cpu.system) / ITERATIONS,
        wallUsPerCall: (endedAt - before.at) * 1000 / ITERATIONS,
        allocatedKbPerCall: bytes === undefined || before.bytes === undefined ? null : (bytes - before.bytes) / 1024 / ITERATIONS,
        gcPausesPer1000Calls: gc.count * 1000 / ITERATIONS, gcMsPer1000Calls: gc.ms * 1000 / ITERATIONS };
    } finally { PgDialect.prototype.sqlToQuery = written; }
  }
  for (const version of versions) for (const name of names) await measure(name, version.progress);
  const samples = new Map<string, Array<Awaited<ReturnType<typeof measure>>>>();
  for (let pass = 0; pass < PASSES; pass++) {
    for (const version of pass % 2 === 0 ? versions : [...versions].reverse()) {
      for (const name of names) {
        const key = `${name}/${version.label}`;
        samples.set(key, [...samples.get(key) ?? [], await measure(name, version.progress)]);
      }
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const results = names.flatMap(name => versions.map(version => {
    const passes = samples.get(`${name}/${version.label}`)!;
    const field = (key: keyof (typeof passes)[number]) => passes.every(pass => pass[key] !== null)
      ? Number(median(passes.map(pass => pass[key] as number)).toFixed(2)) : null;
    return { scenario: name, version: version.label, statementsPerCall: statements[name]!.count,
      sqlTextsWrittenPerCall: field("sqlTextsWrittenPerCall"), allocatedKbPerCall: field("allocatedKbPerCall"),
      cpuUsPerCall: field("cpuUsPerCall"), wallUsPerCall: field("wallUsPerCall"),
      gcPausesPer1000Calls: field("gcPausesPer1000Calls"), gcMsPer1000Calls: field("gcMsPer1000Calls") };
  }));
  const [{ version }] = await database.$client.unsafe("select version() as version") as unknown as [{ version: string }];
  console.log(JSON.stringify({ baselineRevision, treatmentRevision: git("rev-parse", "HEAD").trim(),
    treatmentDiff: git("diff", "--stat", "HEAD", "--", modulePath).trim() || "none",
    node: process.version, postgres: version.split(" ").slice(0, 2).join(" "), iterations: ITERATIONS, passes: PASSES,
    correctness: { sameResult: true, sameStatementsAndParameters: true },
    pageRead: { sqlBytes: statements.page!.pageReadBytes, parameters: statements.page!.pageReadParameters }, results }, null, 2));
  await fixtures.cleanup();
} finally {
  gcObserver.disconnect();
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
