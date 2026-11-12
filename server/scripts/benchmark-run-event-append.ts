/**
 * What one appended run event costs: statements, wall time, CPU and allocation.
 *
 * It drives the real append path on a local PostgreSQL:
 *
 * - `native-stream`: one native run. A runner stream appends its events one
 *   after another through `PaperclipControlPlanePort.appendEvent`, which is
 *   what the session runtime calls for every PRP event.
 * - `native-burst`: RUNS native runs streaming at the same time, each one in
 *   order, on one connection pool.
 * - `ordinary`: adapter log events through `appendHeartbeatRunEvent`.
 *
 * Seven of ten native events are text deltas. The other three are progress
 * events (`tool.execution.started`, `tool.execution.completed`,
 * `item.completed`), which also wake the chat progress queue.
 *
 * Statements are counted in the driver, so the count includes BEGIN, COMMIT
 * and SAVEPOINT. CPU is the whole process (`process.cpuUsage`); busy time is
 * the main thread only (event loop utilization). Allocated bytes are V8's
 * `total_allocated_bytes` and are omitted on a Node.js without that counter.
 *
 *   TSX_DISABLE_CACHE=1 pnpm --filter @paperclipai/server exec tsx scripts/benchmark-run-event-append.ts
 *
 * TSX_DISABLE_CACHE keeps tsx from scanning its shared cache directory while
 * the first passes run, which otherwise shows up as allocation and CPU here.
 *
 * To compare with another revision in the same process, in alternating
 * passes, write that revision's two modules next to the current ones first:
 *
 *   git show <base>:server/src/services/heartbeat-run-events.ts \
 *     > server/src/services/heartbeat-run-events.baseline.ts
 *   git show <base>:server/src/services/native-runtime/paperclip-control-plane-port.ts \
 *     | sed 's#"../heartbeat-run-events.js"#"../heartbeat-run-events.baseline.js"#' \
 *     > server/src/services/native-runtime/paperclip-control-plane-port.baseline.ts
 *
 * Optional: EVENTS (default 2000 per pass and scenario), PASSES (3 per
 * implementation), RUNS (8), TEXT_BYTES (96), HISTORY (0 events already
 * retained in each run). Delete the baseline copies afterwards.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { PerformanceObserver, performance, type PerformanceEntry } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { companies, completionContracts, createDb, heartbeatRunEvents, heartbeatRuns, issues,
  startEmbeddedPostgresTestDatabase } from "../../packages/db/src/index.js";
import { createAgentLifecycle } from "../src/services/agent-lifecycle.js";
import * as currentEvents from "../src/services/heartbeat-run-events.js";
import * as currentPort from "../src/services/native-runtime/paperclip-control-plane-port.js";
import type { PrpEvent } from "../src/vendor/paperclip-runner/index.js";

type Implementation = { label: string; events: typeof currentEvents; port: typeof currentPort };
const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const EVENTS = size("EVENTS", 2000), PASSES = size("PASSES", 3), RUNS = size("RUNS", 8);
const TEXT_BYTES = size("TEXT_BYTES", 96), HISTORY = size("HISTORY", 0);
process.env.PAPERCLIP_SECRETS_MASTER_KEY ??= randomBytes(32).toString("base64");

const baselineEvents = fileURLToPath(new URL("../src/services/heartbeat-run-events.baseline.ts", import.meta.url));
const baselinePort = fileURLToPath(new URL("../src/services/native-runtime/paperclip-control-plane-port.baseline.ts", import.meta.url));
const implementations: Implementation[] = [{ label: "current", events: currentEvents, port: currentPort }];
if (existsSync(baselineEvents) && existsSync(baselinePort)) {
  implementations.unshift({ label: "baseline", events: await import(baselineEvents), port: await import(baselinePort) });
}

const keepAlive = setInterval(() => {}, 1_000);
const temporary = await startEmbeddedPostgresTestDatabase("run-event-append-");
const db = createDb(temporary.connectionString);
// postgres.js reads this hook for every statement it sends, on every connection.
const sent = { statements: 0, control: 0 };
(db.$client.options as { debug?: unknown }).debug = (_connection: number, text: string) => {
  sent.statements += 1;
  if (/^\s*(begin|commit|rollback|savepoint|release)\b/i.test(text)) sent.control += 1;
};
// Collections are attributed by their own start time, not by when the
// observer delivers them: delivery is asynchronous and can lag the append.
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
// A full collection before each pass, without a command-line flag, so that
// garbage from the pass before is not collected inside this one.
v8.setFlagsFromString("--expose-gc");
const collectGarbage = vm.runInNewContext("gc") as () => void;

try {
  const [company] = await db.insert(companies).values({ name: "Append", issuePrefix: "APD" }).returning();
  const agent = { id: randomUUID() };
  await createAgentLifecycle(db).requestHire(company!.id, { id: agent.id, name: "Native", role: "engineer", status: "idle",
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { runnerResolved: true });
  const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Streaming task", status: "in_progress",
    assigneeAgentId: agent.id }).returning();
  const contractSha = "run-event-append-benchmark";
  const [contract] = await db.insert(completionContracts).values({ companyId: company!.id, issueId: issue!.id, revision: 1,
    schemaVersion: "paperclip.completion-contract.v1", policyVersion: "benchmark", risk: "standard",
    completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
    contractJson: { revision: "benchmark", objective: "Benchmark", criteria: [{ id: "objective", requirement: "Append" }] },
    canonicalSha256: contractSha, createdByActorType: "system", createdByActorId: "benchmark" }).returning();
  const text = randomBytes(Math.ceil(TEXT_BYTES * 0.75)).toString("base64").slice(0, TEXT_BYTES);

  async function seedHistory(runId: string, sourceInstanceId: string | null) {
    for (let start = 1; start <= HISTORY; start += 500) {
      await db.insert(heartbeatRunEvents).values(Array.from({ length: Math.min(500, HISTORY - start + 1) }, (_, index) => ({
        companyId: company!.id, agentId: agent.id, runId, seq: start + index, eventType: "item.delta",
        ...(sourceInstanceId ? { sourceInstanceId, sourceSeq: start + index, sourceEventId: `${sourceInstanceId}:${start + index}` } : {}),
      })));
    }
    if (HISTORY) await db.update(heartbeatRuns).set({ nextEventSeq: HISTORY + 1 }).where(eq(heartbeatRuns.id, runId));
  }

  async function nativeRun(implementation: Implementation) {
    const runId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: company!.id, agentId: agent.id, status: "running",
      runtimeMode: "native", nativeIssueId: issue!.id, issueId: issue!.id, nativeSessionId: sessionId, runnerInstanceId: runnerId,
      completionContractId: contract!.id, completionContractSha256: contractSha, contextSnapshot: { issueId: issue!.id } });
    await seedHistory(runId, runnerId);
    const identity = { companyId: company!.id, issueId: issue!.id, runId, agentId: agent.id, sessionId };
    const port = new implementation.port.PaperclipControlPlanePort(db, { ...identity, completionContractId: contract!.id,
      completionContractSha256: contractSha, sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `control-${runId}` });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId } as Parameters<typeof port.openRun>[0]);
    const event = (ordinal: number): PrpEvent => {
      const sourceSeq = HISTORY + ordinal, step = ordinal % 10;
      const base = { schema: "paperclip.prp.event.v1" as const, sourceEventId: `${runnerId}:${sourceSeq}`, sourceSeq,
        sourceInstanceId: runnerId, sourceKind: "runner" as const, runId, normalizedSessionId: sessionId,
        turnId: "turn-1", schemaVersion: 1 as const, priority: 1, emittedAt: new Date().toISOString() };
      if (step < 7) return { ...base, itemId: "message-1", eventType: "item.delta", payload: { kind: "agentMessage", text } } as PrpEvent;
      if (step === 9) return { ...base, itemId: `command-${ordinal}`, eventType: "item.completed",
        payload: { kind: "commandExecution", item: { type: "command", id: `command-${ordinal}`, output: text } } } as PrpEvent;
      return { ...base, itemId: `tool-${ordinal}`, eventType: step === 7 ? "tool.execution.started" : "tool.execution.completed",
        payload: { schema: "paperclip.tool.execution.v1", executionId: `tool-${ordinal - (step === 7 ? 0 : 1)}`, transport: "builtin",
          operation: "execute", name: "shell", target: null, namespace: null, readOnly: true,
          status: step === 7 ? "running" : "completed", durationMs: step === 7 ? null : 12, exitCode: step === 7 ? null : 0,
          progress: null, output: text, outputBytes: text.length, outputTruncated: false,
          outputDigest: `sha256:${"a".repeat(64)}` } } as PrpEvent;
    };
    return { runId, append: async (count: number) => {
      for (let ordinal = 1; ordinal <= count; ordinal++) {
        const receipt = await port.appendEvent(event(ordinal));
        assert.equal(receipt.disposition, "committed");
        assert.equal(receipt.highestContiguousSourceSeq, HISTORY + ordinal);
      }
    } };
  }

  async function ordinaryRun(implementation: Implementation) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: company!.id, agentId: agent.id, status: "running" });
    await seedHistory(runId, null);
    return { runId, append: async (count: number) => {
      for (let ordinal = 1; ordinal <= count; ordinal++) {
        const receipt = await implementation.events.appendHeartbeatRunEvent(db, { companyId: company!.id, runId, agentId: agent.id,
          eventType: "adapter.output", stream: "stdout", level: "info", message: text, payload: { chunk: ordinal } });
        assert.equal(receipt.row.seq, HISTORY + ordinal);
      }
    } };
  }

  const scenarios = {
    "native-stream": async (implementation: Implementation) => [{ run: await nativeRun(implementation), events: EVENTS }],
    "native-burst": async (implementation: Implementation) => Promise.all(Array.from({ length: RUNS }, async () =>
      ({ run: await nativeRun(implementation), events: Math.ceil(EVENTS / RUNS) }))),
    ordinary: async (implementation: Implementation) => [{ run: await ordinaryRun(implementation), events: EVENTS }],
  };

  async function measure(name: keyof typeof scenarios, implementation: Implementation) {
    const streams = await scenarios[name](implementation);
    const events = streams.reduce((sum, stream) => sum + stream.events, 0);
    collectGarbage();
    const before = { statements: sent.statements, control: sent.control, cpu: process.cpuUsage(), loop: performance.eventLoopUtilization(),
      bytes: allocated(), at: performance.now() };
    await Promise.all(streams.map(stream => stream.run.append(stream.events)));
    const endedAt = performance.now(), wallMs = endedAt - before.at, cpu = process.cpuUsage(before.cpu);
    const loop = performance.eventLoopUtilization(before.loop), bytes = allocated();
    const statements = sent.statements - before.statements, control = sent.control - before.control;
    // Every measurement stops at endedAt, before the stored rows are read
    // back. Node.js reports a collection from a later immediate, so wait one
    // turn before draining; only collections that began in the window count.
    await new Promise(resolve => setImmediate(resolve));
    const gc = collectionsBetween(before.at, endedAt);
    for (const stream of streams) {
      const rows = await db.select({ seq: heartbeatRunEvents.seq }).from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, stream.run.runId)).orderBy(heartbeatRunEvents.seq);
      assert.deepEqual(rows.map(row => row.seq), Array.from({ length: HISTORY + stream.events }, (_, index) => index + 1),
        "Every event is stored once, in order, without a gap");
    }
    return { events, statementsPerEvent: statements / events, transactionControlPerEvent: control / events,
      wallMsPerEvent: wallMs / events, cpuMsPerEvent: (cpu.user + cpu.system) / 1000 / events,
      mainThreadBusyMsPerEvent: loop.active / events,
      allocatedKbPerEvent: bytes === undefined || before.bytes === undefined ? null : (bytes - before.bytes) / 1024 / events,
      gcPausesPer1000Events: gc.count * 1000 / events, gcMsPer1000Events: gc.ms * 1000 / events };
  }

  const names = Object.keys(scenarios) as Array<keyof typeof scenarios>;
  // One discarded pass per implementation warms the JIT and the connection pool.
  for (const implementation of implementations) for (const name of names) await measure(name, implementation);
  const samples = new Map<string, Array<Awaited<ReturnType<typeof measure>>>>();
  for (let pass = 0; pass < PASSES; pass++) {
    // Alternate the order so machine load drifts over both implementations alike.
    for (const implementation of pass % 2 === 0 ? implementations : [...implementations].reverse()) {
      for (const name of names) {
        const key = `${name}/${implementation.label}`;
        samples.set(key, [...samples.get(key) ?? [], await measure(name, implementation)]);
      }
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const round = (value: number) => Number(value.toFixed(3));
  const results = names.flatMap(name => implementations.map(implementation => {
    const passes = samples.get(`${name}/${implementation.label}`)!;
    const field = (key: keyof (typeof passes)[number]) => passes.every(pass => pass[key] !== null)
      ? round(median(passes.map(pass => pass[key] as number))) : null;
    return { scenario: name, implementation: implementation.label, events: passes[0]!.events,
      statementsPerEvent: field("statementsPerEvent"), transactionControlPerEvent: field("transactionControlPerEvent"),
      wallMsPerEvent: field("wallMsPerEvent"), cpuMsPerEvent: field("cpuMsPerEvent"),
      mainThreadBusyMsPerEvent: field("mainThreadBusyMsPerEvent"), allocatedKbPerEvent: field("allocatedKbPerEvent"),
      gcPausesPer1000Events: field("gcPausesPer1000Events"), gcMsPer1000Events: field("gcMsPer1000Events") };
  }));
  const [{ version }] = await db.execute(drizzleSql`select version() as version`) as unknown as [{ version: string }];
  console.log(JSON.stringify({ node: process.version, postgres: version.split(" ").slice(0, 2).join(" "),
    passes: PASSES, runs: RUNS, textBytes: TEXT_BYTES, history: HISTORY, results }, null, 2));
} finally {
  gcObserver.disconnect();
  clearInterval(keepAlive);
  await temporary.cleanup();
}
