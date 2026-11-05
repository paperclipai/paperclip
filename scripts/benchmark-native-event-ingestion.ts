import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agents, applyPendingMigrations, companies, createDb, heartbeatRuns,
  startEmbeddedPostgresTestDatabase, type Db,
} from "../packages/db/src/index.js";
import { installDatabaseWorkSignals } from "../packages/db/src/work-signals.js";
import type { AppendHeartbeatRunEventInput, AppendHeartbeatRunEventResult } from "../server/src/services/heartbeat-run-events.js";
import { resolveExternalTestDatabaseUrl } from "../server/src/__tests__/helpers/external-test-database.js";
import { nativeSha256 } from "../server/src/services/native-runtime/canonical.js";
import { evaluateServiceRepeatability, noiseExceedingPairedWins } from "./native-ingestion-performance-gates.mjs";

// This measures the real database owner, not browser delivery or a provider.
// The assembled application/browser acceptance is a separate required layer.
const root = fileURLToPath(new URL("../", import.meta.url));
const serverRequire = createRequire(new URL("../server/package.json", import.meta.url));
const { drizzle } = await import(serverRequire.resolve("drizzle-orm/postgres-js"));
const sourcePath = "server/src/services/heartbeat-run-events.ts";
const cursorSourcePath = "server/src/services/heartbeat/native-event-cursors.ts";
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
function assertServiceAcceptance(recorded: any) {
  assert.equal(recorded.cleanupComplete, true, "Owned benchmark resources have not finished cleanup");
  assert.ok(["compare", "batch"].includes(recorded.phase), "A/A calibration is not performance acceptance");
  assert.equal(recorded.workload?.quick, false, "Qualification smoke cannot establish acceptance");
  assert.ok(recorded.workload.pairs >= 5, "Acceptance requires at least five paired samples");
  assert.ok([1000, 10000, 100000].every(history => recorded.workload.histories.includes(history)), "Acceptance requires the complete retained-history matrix");
  assert.ok(["ordered", "replay", "late-gap", "warm-suffix"].every(scenario => recorded.workload.scenarios.includes(scenario)), "Acceptance requires every fixed service scenario");
  assert.ok(recorded.comparison?.length > 0, "Acceptance requires a same-workload A/A noise comparison");
  assert.ok(recorded.comparison.every((entry: { acceptancePassed: boolean | null }) => entry.acceptancePassed !== false), "Service performance gate failed; inspect comparison and retained failures");
}
if (arg("validate-report")) {
  const recorded = JSON.parse(await fs.readFile(arg("validate-report")!, "utf8"));
  assert.equal(recorded.incomplete, false, "Incomplete evidence cannot qualify a revision");
  assert.ok(Object.keys(recorded.candidateSourceHashes ?? {}).length > 0, "Report must include supporting source hashes");
  for (const [file, expected] of Object.entries(recorded.candidateSourceHashes)) {
    assert.equal(createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex"), expected, `Measured source changed: ${file}`);
  }
  if (process.argv.includes("--require-acceptance")) {
    assertServiceAcceptance(recorded);
  }
  if (process.argv.includes("--require-repeatability")) {
    assert.equal(evaluateServiceRepeatability(recorded).passed, true, "A/A repeatability gate failed; retain evidence and diagnose before candidate measurements");
  }
  console.log(JSON.stringify({ valid: true, phase: recorded.phase, baselineRevision: recorded.baselineRevision,
    candidateRevision: recorded.candidateRevision, scope: recorded.scope }));
  process.exit(0);
}
const quick = process.argv.includes("--quick");
const phase = arg("phase") ?? "compare";
assert.ok(["aa", "compare", "batch"].includes(phase), "--phase must be aa, compare, or batch");
if (process.argv.includes("--require-repeatability")) assert.equal(phase, "aa", "Repeatability requires the A/A phase");
const baselineRef = arg("baseline-ref");
assert.ok(baselineRef, "Pass a pinned --baseline-ref=<commit>");
const baselineRevision = git(["rev-parse", "--verify", `${baselineRef}^{commit}`]).trim();
const baselineSource = git(["show", `${baselineRevision}:${sourcePath}`]);
const candidateRevision = git(["rev-parse", "HEAD"]).trim();
const histories = (arg("histories") ?? (quick ? "1000" : "1000,10000,100000")).split(",").map(Number);
const pairs = Number(arg("pairs") ?? (quick ? 1 : 5));
const events = Number(arg("events") ?? (quick ? 8 : 32));
const groups = Number(arg("groups") ?? (quick ? 1 : 16));
assert.ok(histories.every(value => Number.isSafeInteger(value) && value >= 1));
assert.ok(Number.isSafeInteger(pairs) && pairs >= (quick ? 1 : 5), "Acceptance requires at least five paired samples");
assert.ok(Number.isSafeInteger(events) && events >= 2 && events <= 64 && events % 2 === 0);
assert.ok(Number.isSafeInteger(groups) && groups >= 1 && groups <= 128);
const scenarios = quick ? ["ordered"] : ["ordered", "replay", "late-gap", "warm-suffix"];
const workload = { histories, pairs, events, groups, scenarios, payloadTextBytes: 128, warmSourceOffset: 1000,
  seed: "native-event-ingestion-v1", retainedHistory: "vacuum-analyzed", quick };
const workloadSha256 = createHash("sha256").update(JSON.stringify(workload)).digest("hex");
// GNU ps reports CPU time in whole seconds. Read Linux process clock ticks
// directly; resolve their frequency once, outside every measured interval.
const databaseCpuClockTicks = process.platform === "linux"
  ? Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) : null;
if (databaseCpuClockTicks !== null) assert.ok(Number.isFinite(databaseCpuClockTicks) && databaseCpuClockTicks > 0);
const databaseCpuResolutionMillis = databaseCpuClockTicks !== null ? 1000 / databaseCpuClockTicks
  : process.platform === "darwin" ? 10 : null;
const output = arg("output");
const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_EVENT_INGESTION_BENCHMARK_DATABASE_URL");
if (externalUrl) assert.ok(["127.0.0.1", "localhost"].includes(new URL(externalUrl).hostname), "Use a disposable local database");

type Append = (db: Db, input: AppendHeartbeatRunEventInput) => Promise<AppendHeartbeatRunEventResult>;
type AppendBatch = (db: Db, inputs: AppendHeartbeatRunEventInput[]) => Promise<AppendHeartbeatRunEventResult[]>;
type EventModule = { appendHeartbeatRunEvent: Append; appendHeartbeatRunEvents?: AppendBatch };
type Fixture = { companyId: string; agentId: string; runId: string; source: string; history: number; sourceOffset: number; next: number };
type Query = { sql: string; params: unknown[]; elapsedMs?: number; returnedRows?: number };
type Sample = {
  elapsedMs: number; eventsPerSecond: number; newEvents: number; duplicateEvents: number;
  appCpuMicros: number; databaseCpuMillis: number | null; heapDeltaBytes: number; rssBytes: number;
  eventLoopUtilization: number; eventLoopDelayMaxMs: number | null;
  retainedHistoryBefore: number; retainedHistoryAfter: number;
};
type Arm = "baseline" | "candidate";
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const summary = (samples: Sample[]) => ({
  medianMs: median(samples.map(sample => sample.elapsedMs)),
  minMs: Math.min(...samples.map(sample => sample.elapsedMs)), maxMs: Math.max(...samples.map(sample => sample.elapsedMs)),
  medianEventsPerSecond: median(samples.map(sample => sample.eventsPerSecond)),
  medianAppCpuMicrosPerEvent: median(samples.map(sample => sample.appCpuMicros / (sample.newEvents + sample.duplicateEvents))),
  samples,
});
const baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.native-event-baseline-"));
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
const companiesToRemove: string[] = [];
const setupStarted = performance.now();
const loadBefore = loadavg();
const report: Record<string, unknown> = {
  scope: "Real append service / real PostgreSQL; closed-loop service cost, not assembled application, browser, or hosted acceptance",
  phase, baselineRevision, candidateRevision, workload, workloadSha256,
  baselineSourceSha256: createHash("sha256").update(baselineSource).digest("hex"),
  measurement: { warmups: 2, pairedOrder: "alternating", cache: "warm; seed and projection preparation excluded", databaseCpuResolutionMillis,
    databaseCpuSource: databaseCpuClockTicks === null ? "ps process CPU time" : "/proc/PID/stat utime+stime clock ticks" },
  environment: { node: process.version, platform: process.platform, architecture: process.arch, cpus: availableParallelism(), loadBefore },
  results: [], incomplete: true, cleanupComplete: false,
};
let calibratedNoise: any;

async function save() {
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2));
}

function backendCpuMillis(pid: number): number | null {
  if (process.platform === "win32") return null;
  if (databaseCpuClockTicks !== null) {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the parenthesized comm begin at field 3 (state).
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return (Number(fields[11]) + Number(fields[12])) / databaseCpuClockTicks * 1000;
  }
  const value = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const parts = value.split(":").map(Number);
  return parts.length >= 2 && parts.every(Number.isFinite)
    ? parts.reduce((total, part) => total * 60 + part, 0) * 1000 : null;
}

function input(fixture: Fixture, sequence: number): AppendHeartbeatRunEventInput {
  const envelope = {
    schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: fixture.runId,
    normalizedSessionId: fixture.runId, sourceKind: "runner", sourceInstanceId: fixture.source,
    sourceEventId: `${fixture.source}:${sequence}`, sourceSeq: sequence,
    eventType: "item.delta", priority: 1, emittedAt: "2026-11-03T00:00:00.000Z",
    turnId: "benchmark-turn", itemId: "benchmark-item",
    payload: { kind: "agentMessage", channel: "final", text: "x".repeat(workload.payloadTextBytes) },
  };
  return {
    companyId: fixture.companyId, agentId: fixture.agentId, runId: fixture.runId,
    eventType: envelope.eventType, stream: "system", level: "info", payload: { prpEvent: envelope },
    nativeSource: {
      sourceInstanceId: fixture.source, sourceEventId: envelope.sourceEventId, sourceSeq: sequence,
      protocolSchemaVersion: 1, canonicalPayload: envelope,
    },
  };
}

// Query diagnostics run separately from unprofiled timing. Wrapping the actual
// prepared execution captures completed query duration, including transactions.
function diagnosticDb(target: Db, queries: Query[], transactions: Array<{ elapsedMs: number; lockAcquisitionQueryMs?: number; lockHeldThroughCommitMs?: number }>): Db {
  const recorded = installDatabaseWorkSignals(drizzle(target.$client, { schema: target._.fullSchema }), target) as Db;
  type Session = { prepareQuery: (...args: any[]) => { execute: (...args: any[]) => Promise<unknown> } };
  const decorate = (connection: Db, transaction?: { acquisitionMs?: number; acquiredAt?: number }) => {
    const session = (connection as unknown as { session: Session }).session;
    const prepare = session.prepareQuery;
    session.prepareQuery = function (this: Session, ...args: any[]) {
      const prepared = prepare.apply(this, args), execute = prepared.execute;
      const query = args[0] as Query;
      prepared.execute = async function (this: unknown, ...values: any[]) {
        const started = performance.now();
        try {
          const result = await execute.apply(this, values);
          const elapsedMs = performance.now() - started;
          queries.push({ sql: query.sql, params: query.params, elapsedMs, returnedRows: Array.isArray(result) ? result.length : undefined });
          if (transaction && /\bfor update\b/i.test(query.sql)) {
            transaction.acquisitionMs = elapsedMs;
            transaction.acquiredAt = performance.now();
          }
          return result;
        } catch (error) {
          queries.push({ sql: query.sql, params: query.params, elapsedMs: performance.now() - started });
          throw error;
        }
      };
      return prepared;
    };
    const original = connection.transaction.bind(connection);
    connection.transaction = ((callback: (tx: Db) => Promise<unknown>, options?: Parameters<Db["transaction"]>[1]) => {
      const started = performance.now(), state: { acquisitionMs?: number; acquiredAt?: number } = {};
      return original(async tx => callback(decorate(tx as unknown as Db, state)), options).finally(() => {
        transactions.push({ elapsedMs: performance.now() - started, lockAcquisitionQueryMs: state.acquisitionMs,
          lockHeldThroughCommitMs: state.acquiredAt === undefined ? undefined : performance.now() - state.acquiredAt });
      });
    }) as typeof connection.transaction;
    return connection;
  };
  return decorate(recorded);
}

try {
  // Snapshot changed supporting service modules too: a B1→B2 comparison must
  // not accidentally import B2 behavior behind its nominally B1 entry point.
  // The database schema/client intentionally remain the compatible migrated
  // superset for both arms; the benchmark is about the event owner itself.
  const changed = git(["diff", "--name-only", baselineRevision, "--", "server/src/services"])
    .trim().split("\n").filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const snapshots = new Map<string, string>([[sourcePath, baselineSource]]);
  let baselineCursorSource: string | undefined;
  try { baselineCursorSource = git(["show", `${baselineRevision}:${cursorSourcePath}`]); }
  catch { /* The pre-cursor baseline has no projection to prepare. */ }
  if (baselineCursorSource) snapshots.set(cursorSourcePath, baselineCursorSource);
  for (const file of changed) {
    if (snapshots.has(file)) continue;
    try { snapshots.set(file, git(["show", `${baselineRevision}:${file}`])); }
    catch { /* A newly added service cannot have been imported by the baseline. */ }
  }
  for (const [file, source] of snapshots) {
    const destination = path.join(baselineDir, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const sourceUrl = pathToFileURL(path.join(root, file));
    await fs.writeFile(destination, source.replace(/from "(\.{1,2}\/[^\"]+)"/g, (_match, specifier: string) => {
      const actual = fileURLToPath(new URL(specifier, sourceUrl));
      const relative = path.relative(root, actual).replace(/\.js$/, ".ts");
      return `from ${JSON.stringify(snapshots.has(relative) ? path.join(baselineDir, relative) : actual)}`;
    }));
  }
  report.baselineServiceSnapshots = Object.fromEntries([...snapshots].map(([file, source]) => [file, createHash("sha256").update(source).digest("hex")]));
  const baselineFile = path.join(baselineDir, sourcePath);
  const baseline = await import(pathToFileURL(baselineFile).href) as EventModule;
  const candidate = phase === "aa" ? baseline : await import("../server/src/services/heartbeat-run-events.js") as EventModule;
  report.projectionPriming = { baseline: Boolean(baselineCursorSource), candidate: phase === "aa" ? Boolean(baselineCursorSource) : true };
  report.effectiveCandidateRevision = phase === "aa" ? baselineRevision : candidateRevision;
  if (phase === "batch") assert.equal(typeof candidate.appendHeartbeatRunEvents, "function", "Batch phase requires appendHeartbeatRunEvents");
  report.candidateSourceSha256 = createHash("sha256").update(await fs.readFile(path.join(root, sourcePath))).digest("hex");
  const proofFiles = [...new Set([sourcePath, "scripts/benchmark-native-event-ingestion.ts", "scripts/native-ingestion-performance-gates.mjs",
    ...git(["diff", "--name-only", baselineRevision, "--", "server/src/services", "packages/db/src/schema"]).trim().split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard", "--", "server/src/services", "packages/db/src/schema"]).trim().split("\n"),
  ])].filter(file => /\.(?:ts|mjs)$/.test(file) && !file.endsWith(".test.ts"));
  report.candidateSourceHashes = Object.fromEntries(await Promise.all(proofFiles.map(async file => [file,
    createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex")])));
  report.candidateDirtyDiff = git(["diff", "HEAD", "--", sourcePath, "server/src/services/heartbeat", "packages/db/src/schema"]);
  if (arg("noise-report")) {
    calibratedNoise = JSON.parse(await fs.readFile(arg("noise-report")!, "utf8"));
    assert.equal(calibratedNoise.phase, "aa"); assert.equal(calibratedNoise.incomplete, false);
    assert.equal(calibratedNoise.baselineRevision, baselineRevision); assert.equal(calibratedNoise.workloadSha256, workloadSha256);
    for (const file of ["scripts/benchmark-native-event-ingestion.ts", "scripts/native-ingestion-performance-gates.mjs"]) {
      assert.equal(calibratedNoise.candidateSourceHashes[file], (report.candidateSourceHashes as Record<string, string>)[file],
        "Measurement protocol or acceptance gates changed after A/A calibration; rerun calibration");
    }
    assert.equal(evaluateServiceRepeatability(calibratedNoise).passed, true,
      "A/A repeatability must pass before candidate measurements start");
  }
  if (!externalUrl) database = await startEmbeddedPostgresTestDatabase("native-event-ingestion-benchmark-");
  if (externalUrl) await applyPendingMigrations(externalUrl);
  db = createDb(externalUrl ?? database!.connectionString, { maxConnections: 1 });
  const [settings] = await db.$client.unsafe("select version() postgres_version, pg_backend_pid() backend_pid, current_setting('shared_buffers') shared_buffers, current_setting('work_mem') work_mem, current_setting('jit') jit");
  report.database = settings;

  async function fixture(history: number, scenario = "ordered"): Promise<Fixture> {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), source = randomUUID();
    companiesToRemove.push(companyId);
    await db!.insert(companies).values({ id: companyId, name: "Synthetic native event benchmark", issuePrefix: `E${companyId.replaceAll("-", "")}` });
    await db!.insert(agents).values({ id: agentId, companyId, name: "Synthetic event source", adapterType: "paperclip_runner" });
    await db!.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nextEventSeq: history + 1 });
    const sourceOffset = scenario === "late-gap" ? 1 : scenario === "warm-suffix" ? workload.warmSourceOffset : 0;
    await db!.$client.unsafe(`insert into heartbeat_run_events
      (company_id, run_id, agent_id, seq, event_type, stream, level, payload, source_instance_id, source_event_id, source_seq, source_payload_sha256, protocol_schema_version)
      select $1::uuid, $2::uuid, $3::uuid, n, 'item.delta', 'system', 'info', jsonb_build_object('historicalSyntheticText', repeat('x', $5::integer)),
        $4, $4 || ':' || (n + $6::integer)::text, n + $6::integer, repeat('0', 64), 1
      from generate_series(1, $7::integer) n`, [companyId, runId, agentId, source, workload.payloadTextBytes, sourceOffset, history]);
    await db!.$client.unsafe("VACUUM ANALYZE heartbeat_run_events");
    return { companyId, agentId, runId, source, history, sourceOffset, next: history + sourceOffset + 1 };
  }

  async function prepare(f: Fixture, arm: Arm) {
    const usesBaseline = arm === "baseline" || phase === "aa";
    if (usesBaseline && !baselineCursorSource) return;
    // Seed setup is an old-version append. Prime using the real fallback and
    // bounded rebuild before steady-state timing; cold behavior is traced below.
    const module = await import(usesBaseline
      ? pathToFileURL(path.join(baselineDir, cursorSourcePath)).href
      : pathToFileURL(path.join(root, cursorSourcePath)).href) as Record<string, unknown>;
    const rebuild = module.rebuildNativeEventCursorPage as undefined | ((db: Db, binding: { companyId: string; runId: string }) => Promise<{ pending: boolean }>);
    assert.equal(typeof rebuild, "function", "Cursor owner must expose rebuildNativeEventCursorPage for seeded-history preparation");
    await db!.$client.unsafe("update heartbeat_runs set event_cursor_rebuild_pending=true where id=$1::uuid", [f.runId]);
    for (let page = 0; page <= Math.ceil((f.history + 1) / 512) + 2; page++) {
      const result = await rebuild!(db!, { companyId: f.companyId, runId: f.runId });
      if (!result.pending) return;
    }
    throw new Error("Cursor fixture failed to finish bounded rebuild");
  }

  function emittedInputs(f: Fixture, scenario: string, repetitions = 1) {
    if (scenario === "late-gap") return [input(f, 1)];
    const newCount = scenario === "replay" ? events / 2 : events;
    const values: AppendHeartbeatRunEventInput[] = [];
    for (let group = 0; group < repetitions; group++) {
      const unique = Array.from({ length: newCount }, (_, n) => input(f, f.next + n));
      f.next += newCount;
      values.push(...unique);
      if (scenario === "replay") values.push(...unique);
    }
    return values;
  }

  async function invoke(target: Db, arm: Arm, values: AppendHeartbeatRunEventInput[]) {
    const owner = arm === "baseline" ? baseline : candidate;
    const receipts: AppendHeartbeatRunEventResult[] = [];
    if (phase === "batch" && arm === "candidate") {
      for (let offset = 0; offset < values.length; offset += 64) {
        const chunk = values.slice(offset, offset + 64);
        assert.ok(chunk.reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value.nativeSource!.canonicalPayload)), 0) <= 64 * 1024);
        receipts.push(...await owner.appendHeartbeatRunEvents!(target, chunk));
      }
    }
    else for (const value of values) receipts.push(await owner.appendHeartbeatRunEvent(target, value));
    assert.equal(receipts.length, values.length);
    const expectedCursor = Math.max(...values.map(value => value.nativeSource!.sourceSeq));
    assert.ok(receipts.every(receipt => receipt.highestContiguousSourceSeq <= expectedCursor || values.length === 1));
    return receipts;
  }

  async function timed(f: Fixture, arm: Arm, scenario: string): Promise<Sample> {
    const retainedHistoryBefore = f.next - f.sourceOffset - 1;
    const values = emittedInputs(f, scenario, groups);
    const pgBefore = backendCpuMillis(Number(settings!.backend_pid));
    const beforeMemory = process.memoryUsage(), cpuBefore = process.cpuUsage(), eluBefore = performance.eventLoopUtilization();
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const started = performance.now();
    const receipts = await invoke(db!, arm, values);
    const elapsedMs = performance.now() - started;
    loop.disable();
    const cpu = process.cpuUsage(cpuBefore), memory = process.memoryUsage();
    const eventLoopUtilization = performance.eventLoopUtilization(eluBefore).utilization;
    const pgAfter = backendCpuMillis(Number(settings!.backend_pid));
    const newEvents = receipts.filter(receipt => receipt.disposition === "committed").length;
    assert.equal(newEvents, scenario === "replay" ? values.length / 2 : values.length);
    assert.equal(receipts.at(-1)!.highestContiguousSourceSeq,
      scenario === "late-gap" ? f.history + 1 : scenario === "warm-suffix" ? 0 : f.next - 1);
    const expectedRows = scenario === "late-gap" ? f.history + 1 : f.next - f.sourceOffset - 1;
    const [durable] = await db!.$client.unsafe("select count(*)::integer as events, max(seq)::bigint as last from heartbeat_run_events where run_id=$1::uuid", [f.runId]);
    assert.equal(Number(durable!.events), expectedRows, "Independent history read must account for every committed event");
    assert.equal(Number(durable!.last), expectedRows, "Run sequences must not skip or overlap");
    const expectedBySequence = new Map(values.map(value => [value.nativeSource!.sourceSeq, value]));
    const sequences = [...expectedBySequence.keys()];
    const persisted = await db!.$client.unsafe(`select source_instance_id, source_event_id, source_seq,
      source_payload_sha256, protocol_schema_version, payload from heartbeat_run_events
      where run_id=$1::uuid and source_instance_id=$2 and source_seq between $3::bigint and $4::bigint
      order by source_seq`, [f.runId, f.source, Math.min(...sequences), Math.max(...sequences)]);
    assert.equal(persisted.length, expectedBySequence.size);
    for (const row of persisted) {
      const expected = expectedBySequence.get(Number(row.source_seq))!;
      assert.equal(row.source_event_id, expected.nativeSource!.sourceEventId);
      assert.equal(row.source_instance_id, expected.nativeSource!.sourceInstanceId);
      assert.equal(row.protocol_schema_version, expected.nativeSource!.protocolSchemaVersion);
      assert.equal(row.source_payload_sha256, nativeSha256(expected.nativeSource!.canonicalPayload));
      assert.deepEqual(row.payload, expected.payload, "Durable event payload must match independently of its append receipt");
    }
    return { elapsedMs, eventsPerSecond: values.length / elapsedMs * 1000, newEvents,
      duplicateEvents: values.length - newEvents, appCpuMicros: cpu.user + cpu.system,
      databaseCpuMillis: pgBefore === null || pgAfter === null ? null : pgAfter - pgBefore,
      heapDeltaBytes: memory.heapUsed - beforeMemory.heapUsed, rssBytes: memory.rss,
      eventLoopUtilization,
      eventLoopDelayMaxMs: loop.count ? loop.max / 1e6 : null,
      retainedHistoryBefore, retainedHistoryAfter: retainedHistoryBefore + newEvents };
  }

  // Qualify before entering the full benchmark. All comparisons preserve the
  // original append receipts; a failed fixture never becomes a timing sample.
  for (const history of histories) for (const scenario of scenarios) {
    const samples: Record<Arm, Sample[]> = { baseline: [], candidate: [] };
    let a: Fixture | undefined, b: Fixture | undefined;
    if (scenario !== "late-gap") {
      a = await fixture(history, scenario); b = await fixture(history, scenario);
      await prepare(a, "baseline"); await prepare(b, "candidate");
      for (let warmup = 0; warmup < 2; warmup++) {
        await timed(a, "baseline", scenario); await timed(b, "candidate", scenario);
      }
    }
    for (let pair = 0; pair < pairs; pair++) {
      if (scenario === "late-gap") {
        a = await fixture(history, scenario); b = await fixture(history, scenario);
        await prepare(a, "baseline"); await prepare(b, "candidate");
      }
      for (const arm of pair % 2 ? ["candidate", "baseline"] as const : ["baseline", "candidate"] as const) {
        samples[arm].push(await timed(arm === "baseline" ? a! : b!, arm, scenario));
      }
    }
    const diagnostics: Record<string, unknown> = {};
    for (const arm of ["baseline", "candidate"] as const) {
      const f = await fixture(history, scenario); await prepare(f, arm);
      const queries: Query[] = [], transactions: Array<{ elapsedMs: number }> = [];
      const recorded = diagnosticDb(db, queries, transactions);
      const values = emittedInputs(f, scenario), receipts = await invoke(recorded, arm, values);
      const plans: unknown[] = [];
      for (const query of queries) {
        if (plans.length >= 16 || plans.some((plan: any) => plan.sql === query.sql)) continue;
        const read = /^select\b/i.test(query.sql);
        // Never reexecute a mutation merely to profile it. Read plans report
        // actual rows/buffers; mutation plans describe shape without effects.
        const [plan] = await db.$client.unsafe(`EXPLAIN (${read ? "ANALYZE, BUFFERS, " : ""}FORMAT JSON) ${query.sql}`, query.params as never[]);
        plans.push({ sql: query.sql, analyzed: read, plan: plan!["QUERY PLAN"] });
      }
      const scanNodes = (node: any): any[] => [
        ...(node["Relation Name"] === "heartbeat_run_events" ? [node] : []),
        ...(node.Plans ?? []).flatMap(scanNodes),
      ];
      const historyScans = (plans as Array<{ analyzed: boolean; plan: Array<{ Plan: unknown }> }>).filter(plan => plan.analyzed)
        .flatMap(plan => scanNodes(plan.plan[0].Plan));
      const usesProjection = arm === "baseline" || phase === "aa" ? Boolean(baselineCursorSource) : true;
      const examinedRows = (node: any) => (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)
        + (node["Rows Removed by Index Recheck"] ?? 0)) * node["Actual Loops"];
      if (usesProjection) {
        assert.ok(historyScans.every(node => node["Node Type"] !== "Seq Scan" && examinedRows(node) <= 64),
          "A ready cursor must not scan retained event history, including the optimized baseline arm");
        assert.ok(!queries.some(query => /count\(\*\)/i.test(query.sql) && /heartbeat_run_events/.test(query.sql)),
          "A ready cursor unexpectedly used the retained-history aggregate fallback");
      }
      diagnostics[arm] = { sqlCalls: queries.length, transactions: transactions.length, sqlCallsPerEvent: queries.length / values.length,
        transactionsPerEvent: transactions.length / values.length, transactionTimings: transactions,
        lockTimingBoundary: "Acquisition query duration includes network/row-read cost; held interval ends after commit. It is not a measurement of pure lock wait.",
        persistedEvents: receipts.filter(receipt => receipt.disposition === "committed").length,
        usesProjection, structuralCacheBoundPassed: usesProjection ? true : null,
        historyScanRows: historyScans.map(examinedRows), queries, plans };
    }
    const baselineStats = summary(samples.baseline), candidateStats = summary(samples.candidate);
    const relativePairedDifference = samples.baseline.map((sample, n) => (samples.candidate[n]!.elapsedMs - sample.elapsedMs) / sample.elapsedMs);
    (report.results as unknown[]).push({ history, scenario,
      latencyGate: scenario === "late-gap" ? "structural-only" : history >= 10_000 ? "improvement" : "nonregression",
      baseline: baselineStats, candidate: candidateStats, diagnostics,
      pairedCandidateWins: relativePairedDifference.filter(value => value < 0).length,
      medianLatencyChangePercent: 100 * (candidateStats.medianMs / baselineStats.medianMs - 1),
      aaNoiseEnvelopeRelative: phase === "aa" ? Math.max(...relativePairedDifference.map(Math.abs)) : undefined,
    });
    await save();
  }
  report.setupAndExecutionMillis = performance.now() - setupStarted;
  report.loadAfter = loadavg();
  report.incomplete = false;
  report.acceptance = phase === "aa" ? "Baseline repeatability only; this does not establish an improvement" : "Compare against the frozen same-workload A/A report; throughput improvement needs at least four of five paired wins beyond baseline noise. Browser, control and full-app gates remain separate.";
  if (arg("noise-report")) {
    const noise = calibratedNoise;
    report.noiseReport = arg("noise-report");
    report.comparison = (report.results as any[]).map(result => {
      const control = noise.results.find((row: any) => row.history === result.history && row.scenario === result.scenario);
      assert.ok(control);
      const improvement = (result.baseline.medianMs - result.candidate.medianMs) / result.baseline.medianMs;
      const paired = noiseExceedingPairedWins(result.baseline.samples.map((sample: Sample, index: number) =>
        (sample.elapsedMs - result.candidate.samples[index].elapsedMs) / sample.elapsedMs), control.aaNoiseEnvelopeRelative);
      const improvedBeyondNoise = paired.pairedWinRequirementPassed && improvement > control.aaNoiseEnvelopeRelative;
      const noRegressionBeyondNoise = -improvement <= control.aaNoiseEnvelopeRelative;
      return { history: result.history, scenario: result.scenario, pairedCandidateWins: result.pairedCandidateWins,
        noiseExceedingPairedWins: paired.noiseExceedingPairedWins, requiredPairedWins: paired.requiredPairedWins,
        latencyGate: result.latencyGate,
        improvementRelative: improvement, noiseEnvelopeRelative: control.aaNoiseEnvelopeRelative,
        improvedBeyondNoise, noRegressionBeyondNoise,
        acceptancePassed: result.latencyGate === "structural-only" ? null
          : result.latencyGate === "improvement" ? improvedBeyondNoise : noRegressionBeyondNoise };
    });
  }
  await save();
} finally {
  try {
    // The owned cluster is removed as a whole below. Per-company agent deletes
    // would repeatedly scan other fixtures through foreign-key checks. An
    // explicitly supplied test database retains unrelated data, so remove all
    // our event rows first, then their parents in separate phases.
    if (externalUrl) {
      for (const table of ["heartbeat_run_events", "heartbeat_runs", "agents", "companies"]) {
        for (const companyId of companiesToRemove) {
          await db?.$client.unsafe(`delete from ${table} where ${table === "companies" ? "id" : "company_id"}=$1::uuid`, [companyId]);
        }
      }
    }
  } finally {
    try { await db?.$client.end({ timeout: 1 }); }
    finally {
      try { await database?.cleanup(); }
      finally { await fs.rm(baselineDir, { recursive: true, force: true }); }
    }
  }
  report.cleanupComplete = true;
  await save();
}
if (phase === "aa") {
  report.repeatability = evaluateServiceRepeatability(report);
  await save();
}
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--require-acceptance")) assertServiceAcceptance(report);
if (process.argv.includes("--require-repeatability")) {
  assert.equal(evaluateServiceRepeatability(report).passed, true, "A/A repeatability gate failed; retain evidence and diagnose before candidate measurements");
}
