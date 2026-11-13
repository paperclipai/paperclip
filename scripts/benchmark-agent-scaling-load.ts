/**
 * Load model: what N running native agents cost one server process.
 *
 * Each simulated agent drives the real server code at a fixed rate, against an
 * embedded PostgreSQL on loopback, in this one Node process:
 *
 *   deltas  an `item.delta` per text chunk, committed as the server's port
 *           commits them: the first after another event at once, later ones
 *           in one transaction per DELTA_BATCH_MS or 100 deltas
 *           (DELTA_BATCH_MS=0: one transaction per delta, as before batching)
 *   events  appendHeartbeatRunEvent for an `item.completed`, then the real
 *           controller checkpoint save, which overlaps the next append
 *   lease   every LEASE_S, one renewal of all leases through the shared
 *           schedule (LEASE_MODE=single: one transaction per run, as before).
 *           In batch mode LEASE_S is at most 20: the schedule renews a remote
 *           lease on its own 20 s after its last renewal.
 *   api     an HTTP request through actorMiddleware with the run's agent JWT
 *
 * Arrivals are open-loop: operation i of a stream is due at start + i/rate.
 * A stream is serial, like one runner connection, so when the process cannot
 * keep up the lateness (finish time minus due time) grows and the stream
 * finishes fewer operations than were offered in the window.
 *
 * It reports, for the window: event-loop utilization and delay, CPU, memory
 * allocated, statements and transactions, and per source the operations done
 * against those offered with their lateness. An operation that settles after
 * the window (and the bounded wait for the last delta batches) is not done.
 *
 * Not modelled: frame decrypt and validation, redaction, the object run log,
 * live-event delivery to browsers, tool-gateway and route handler bodies,
 * recovery sweeps, and network round-trip time to a hosted database. So the
 * figures are a floor for the modelled sources, not a whole-server prediction.
 *
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-agent-scaling-load.ts
 *
 * Optional: AGENTS (50), SECONDS (20), SOURCES (deltas,events,lease,api),
 * DELTAS_PER_S (20), EVENTS_PER_S (1), API_PER_S (0.3), LEASE_S (20),
 * DELTA_BYTES (120), EVENT_KIB (2), DELTA_BATCH_MS (250), LEASE_MODE (batch),
 * DATABASE_POOL_MAX (driver default 10).
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { agents, checkpointDb, companies, createDb, heartbeatRuns, issues, livenessDb, nativeRunFinalizations,
  startEmbeddedPostgresTestDatabase } from "../packages/db/src/index.js";
import { meterDatabaseStatements } from "../server/src/__tests__/helpers/database-statement-meter.js";
import { createLocalAgentJwt } from "../server/src/agent-auth-jwt.js";
import { actorMiddleware } from "../server/src/middleware/auth.js";
import { appendHeartbeatRunEvent, appendHeartbeatRunEventBatch, type AppendHeartbeatRunEventInput } from "../server/src/services/heartbeat-run-events.js";
import { renewNativeExecutionLeasesNow, renewNativeSessionExecutionLease, startNativeSessionExecutionLeaseRenewal }
  from "../server/src/services/native-runtime/native-execution-lease.js";
import { nativeRunnerCheckpointWriter } from "../server/src/services/native-runtime/native-runner-checkpoint.js";
import { initializeRunIdentity } from "../server/src/services/run-identity.js";

const serverRequire = createRequire(new URL("../server/package.json", import.meta.url));
const express = serverRequire("express") as typeof import("express");

const number = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const AGENTS = number("AGENTS", 50), SECONDS = number("SECONDS", 20);
const RATES = { deltas: number("DELTAS_PER_S", 20), events: number("EVENTS_PER_S", 1), api: number("API_PER_S", 0.3),
  lease: 1 / number("LEASE_S", 20) };
type Source = keyof typeof RATES;
const SOURCES = (process.env.SOURCES ?? "deltas,events,lease,api").split(",").map(value => value.trim()).filter(Boolean) as Source[];
for (const source of SOURCES) assert(source in RATES, `Unknown source ${source}`);
const DELTA_BYTES = number("DELTA_BYTES", 120), EVENT_KIB = number("EVENT_KIB", 2);
const DELTA_BATCH_MS = number("DELTA_BATCH_MS", 250), DELTA_BATCH_MAX = 100;
const LEASE_BATCHED = (process.env.LEASE_MODE ?? "batch") !== "single";
// The shared schedule renews a remote lease on its own 20 s after the last
// renewal. The model drives every renewal itself, so a tick must come sooner,
// or the schedule's own renewals would add work that the model does not count.
assert(!LEASE_BATCHED || !SOURCES.includes("lease") || 1 / RATES.lease <= 20,
  "LEASE_MODE=batch needs LEASE_S of at most 20: the shared schedule renews on its own after 20 s");
process.env.PAPERCLIP_SECRETS_MASTER_KEY ??= randomBytes(32).toString("base64");
process.env.PAPERCLIP_AGENT_JWT_SECRET ??= randomBytes(32).toString("base64");

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));
const quantile = (values: number[], q: number) => values.length === 0 ? null
  : Number([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!.toFixed(1));
const round = (value: number, digits = 1) => Number(value.toFixed(digits));

const temporary = await startEmbeddedPostgresTestDatabase("agent-scaling-load-");
const db = createDb(temporary.connectionString);
// Checkpoint saves and lease renewals use their own pools; meter all three.
const POOLS = ["main", "checkpoint", "lease"] as const;
const meters = [db, checkpointDb(db), livenessDb(db)].map(client => meterDatabaseStatements(client, temporary.connectionString));
const poolStatements = () => meters.map(one => one.read().statements);
const meter = { read: () => meters.map(one => one.read()).reduce((sum, one) => ({ statements: sum.statements + one.statements,
  transactions: sum.transactions + one.transactions, sqlBytes: sum.sqlBytes + one.sqlBytes }), { statements: 0, transactions: 0, sqlBytes: 0 }) };
const controller = { bootId: randomUUID(), pid: process.pid, processStartedAt: new Date() };
let server: import("node:http").Server | undefined;
try {
  const [company] = await db.insert(companies).values({ name: "Scaling load", issuePrefix: "LOAD" }).returning();
  const companyId = company!.id;
  const fleet = [];
  for (let index = 0; index < AGENTS; index++) {
    const [agent] = await db.insert(agents).values({ companyId, name: `Agent ${index}`, adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: `Task ${index}` }).returning();
    const runId = randomUUID(), leaseOwner = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent!.id, status: "running", runtimeMode: "native",
      nativeIssueId: issue!.id, issueId: issue!.id, runnerProfileJson: { padding: randomBytes(3 * 1024).toString("base64") } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId: issue!.id, phase: "observed", attempt: 0,
      controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt,
      controllerGeneration: 1, leaseOwner, leaseExpiresAt: new Date(Date.now() + 3_600_000) });
    if (SOURCES.includes("api")) {
      await initializeRunIdentity(db, { companyId, runId, responsibleUserId: null, issueId: issue!.id, cause: "benchmark" });
    }
    const write = nativeRunnerCheckpointWriter(db, { companyId, issueId: issue!.id, runId, authorityRunId: runId,
      bootId: controller.bootId, generation: 1, leaseOwner });
    const records = new Map([["header", JSON.stringify({ padding: randomBytes(6 * 1024).toString("base64") })],
      ["cursor", JSON.stringify({ ackedSourceSeq: 0 })]]);
    const checkpoint = (changed: Map<string, string>, reset: boolean) => ({
      runId, records: new Map(records), changedRecords: changed, removedRecords: [], reset, workCommandIds: [], predecessor: null,
      runnerVersion: "bench", runnerDigest: `sha256:${"a".repeat(64)}`,
      recoveryEvidence: { runnerInstanceId: "bench", normalizedSessionId: "bench", authenticatedConnectionCount: 1, highestRecordedSourceSeq: 0 },
      restoreSessionDirectory() {},
    }) as unknown as Parameters<typeof write>[0];
    await write(checkpoint(new Map(records), true));
    fleet.push({ agentId: agent!.id, issueId: issue!.id, runId, leaseOwner, write, records, checkpoint, seq: 0,
      checkpointTail: Promise.resolve(), appendTail: Promise.resolve() as Promise<unknown>,
      deltaQueue: [] as Array<{ input: AppendHeartbeatRunEventInput; settle: (error?: unknown) => void }>,
      deltaTimer: null as ReturnType<typeof setTimeout> | null, streamedSinceBoundary: false, token: createLocalAgentJwt(agent!.id, companyId, "process", runId, null)! });
  }

  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.get("/actor", (req, res) => { res.json({ type: (req as unknown as { actor: { type: string } }).actor.type }); });
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server!.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Agent = (typeof fleet)[number];
  let checkpointFailures = 0, firstCheckpointError = "";
  // One runner connection delivers a run's events in order, and the server
  // awaits each append before it reads the next. So deltas and other events
  // of one agent share one queue and never append at the same time.
  const eventInput = (agent: Agent, eventType: string, bytes: number) => {
    const seq = ++agent.seq;
    const event = { sourceSeq: seq, eventType, runId: agent.runId, text: randomBytes(Math.ceil(bytes * 0.75)).toString("base64") };
    const input: AppendHeartbeatRunEventInput = { companyId, agentId: agent.agentId, runId: agent.runId, eventType, stream: "system",
      level: "info", payload: { prpEvent: event }, assertWritable: () => {},
      nativeSource: { sourceInstanceId: "bench-runner", sourceEventId: `event-${seq}`, sourceSeq: seq, protocolSchemaVersion: 1,
        canonicalPayload: event } };
    return { seq, event, input };
  };
  // The queued deltas of an agent commit in one transaction, in order, before
  // anything appended after them.
  const flushDeltas = (agent: Agent) => {
    if (agent.deltaTimer !== null) clearTimeout(agent.deltaTimer);
    agent.deltaTimer = null;
    const batch = agent.deltaQueue;
    if (batch.length === 0) return;
    agent.deltaQueue = [];
    agent.streamedSinceBoundary = true;
    agent.appendTail = agent.appendTail.then(() => appendHeartbeatRunEventBatch(db, batch.map(item => item.input), () => {}))
      .then(() => { for (const item of batch) item.settle(); }, error => { for (const item of batch) item.settle(error); });
  };
  const appendDelta = (agent: Agent) => {
    const { input } = eventInput(agent, "item.delta", DELTA_BYTES);
    if (DELTA_BATCH_MS <= 0) {
      const queued = agent.appendTail.then(() => appendHeartbeatRunEvent(db, input));
      agent.appendTail = queued.catch(() => undefined);
      return queued;
    }
    return new Promise<void>((resolve, reject) => {
      agent.deltaQueue.push({ input, settle: error => error === undefined ? resolve() : reject(error) });
      // The first text after another event never waits for the timer.
      if (!agent.streamedSinceBoundary || agent.deltaQueue.length >= DELTA_BATCH_MAX) flushDeltas(agent);
      else agent.deltaTimer ??= setTimeout(() => flushDeltas(agent), DELTA_BATCH_MS);
    });
  };
  const append = (agent: Agent, eventType: string, bytes: number) => {
    const { seq, event, input } = eventInput(agent, eventType, bytes);
    flushDeltas(agent);
    agent.streamedSinceBoundary = false;
    const queued = agent.appendTail.then(() => appendHeartbeatRunEvent(db, input)).then(() => ({ seq, event }));
    agent.appendTail = queued.catch(() => undefined);
    return queued;
  };
  const operations: Record<Source, (agent: Agent) => Promise<unknown>> = {
    deltas: agent => appendDelta(agent),
    events: async agent => {
      const { seq, event } = await append(agent, "item.completed", EVENT_KIB * 1024);
      const changed = new Map([[`event:${seq}`, JSON.stringify(event)], ["cursor", JSON.stringify({ ackedSourceSeq: seq })]]);
      for (const [key, value] of changed) agent.records.set(key, value);
      // The save is serial per controller and does not block the next frame.
      agent.checkpointTail = agent.checkpointTail.then(() => agent.write(agent.checkpoint(changed, false))).catch(error => {
        checkpointFailures += 1;
        firstCheckpointError ||= String((error as Error)?.message ?? error).slice(0, 200);
      });
    },
    lease: agent => renewNativeSessionExecutionLease({ db, runId: agent.runId, companyId, issueId: agent.issueId,
      leaseOwner: agent.leaseOwner, attempt: 0, controller, leaseTtlMs: 60_000 }),
    api: async agent => {
      const response = await fetch(`${origin}/actor`, { headers: { authorization: `Bearer ${agent.token}`, "x-paperclip-run-id": agent.runId } });
      const body = await response.json() as { type?: string };
      assert.equal(body.type, "agent", `agent request was not authenticated (${response.status})`);
    },
  };

  // One warm pass per source, outside the window.
  for (const source of SOURCES) if (!(LEASE_BATCHED && source === "lease")) await operations[source](fleet[0]!);
  await fleet[0]!.checkpointTail;
  assert.equal(checkpointFailures, 0, `checkpoint save failed during warm-up: ${firstCheckpointError}`);

  const stats = Object.fromEntries(SOURCES.map(source => [source, { done: 0, failed: 0, late: [] as number[], firstError: "" }])) as
    Record<Source, { done: number; failed: number; late: number[]; firstError: string }>;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  const [commitsBefore] = await db.$client.unsafe("select xact_commit::float8 as commits from pg_stat_database where datname = current_database()");
  const poolsBefore = poolStatements(), statementsBefore = { ...meter.read() }, cpuBefore = process.cpuUsage(), loopBefore = performance.eventLoopUtilization();
  const heapBefore = process.memoryUsage().heapUsed;
  let allocated = 0, lastHeap = heapBefore;
  const sampler = setInterval(() => { const heap = process.memoryUsage().heapUsed; if (heap > lastHeap) allocated += heap - lastHeap; lastHeap = heap; }, 20);
  delay.enable();
  const started = performance.now(), deadline = started + SECONDS * 1000;
  // Set when the window closes: an operation that settles later is not done.
  let windowClosed = false;

  // With the shared schedule every lease of the process renews in one tick,
  // so the lease source is one stream for the fleet, not one per agent.
  const pipelined = DELTA_BATCH_MS > 0;
  const inFlight: Promise<void>[] = [];
  const sharedLease = LEASE_BATCHED && SOURCES.includes("lease");
  let leasesLost = 0;
  const renewals = sharedLease ? fleet.map(agent => startNativeSessionExecutionLeaseRenewal({ db, runId: agent.runId, companyId,
    issueId: agent.issueId, leaseOwner: agent.leaseOwner, attempt: 0, controller, remote: true,
    onLost: async () => { leasesLost += 1; } })) : [];
  const leaseTicks = sharedLease ? (async () => {
    const interval = 1000 / RATES.lease, offset = Math.random() * interval, stat = stats.lease;
    for (let index = 0; ; index++) {
      const due = started + offset + index * interval;
      if (due >= deadline) return;
      await sleep(due - performance.now());
      try { await renewNativeExecutionLeasesNow(db); if (!windowClosed) stat.done += fleet.length; }
      catch (error) { if (!windowClosed) stat.failed += fleet.length; stat.firstError ||= String((error as Error)?.message ?? error).slice(0, 200); }
      if (!windowClosed) stat.late.push(performance.now() - due);
      if (performance.now() > deadline) return;
    }
  })() : Promise.resolve();
  await Promise.all([leaseTicks, ...fleet.flatMap(agent => SOURCES.filter(source => !(sharedLease && source === "lease")).map(async source => {
    const interval = 1000 / RATES[source], offset = Math.random() * interval, stat = stats[source];
    for (let index = 0; ; index++) {
      const due = started + offset + index * interval;
      if (due >= deadline) return;
      await sleep(due - performance.now());
      const settled = operations[source](agent).then(() => { if (!windowClosed) stat.done += 1; },
        error => { if (!windowClosed) stat.failed += 1; stat.firstError ||= String((error as Error)?.message ?? error).slice(0, 200); })
        .then(() => { if (!windowClosed) stat.late.push(performance.now() - due); });
      // The runner does not wait for a batched delta's receipt before it
      // sends the next one; every other operation is awaited in turn.
      if (pipelined && source === "deltas") inFlight.push(settled);
      else await settled;
      // A stream that is still behind at the end of the window stops there:
      // `done` below `offered` is the work the process could not keep up with.
      if (performance.now() > deadline) return;
    }
  }))]);
  // Deltas still queued at the end commit with their batch; count only those
  // that settle within one batch time of the window's end.
  for (const agent of fleet) flushDeltas(agent);
  await Promise.race([Promise.all(inFlight), sleep(DELTA_BATCH_MS + 250)]);
  // Freeze the per-source counts with the other measurements below. A delta
  // that commits after this, while the queued work drains, is not done.
  windowClosed = true;
  await Promise.all(renewals.map(renewal => renewal.stop()));
  for (const agent of fleet) if (agent.deltaTimer !== null) clearTimeout(agent.deltaTimer);
  const elapsedMs = performance.now() - started;
  delay.disable();
  clearInterval(sampler);
  const loop = performance.eventLoopUtilization(loopBefore), cpu = process.cpuUsage(cpuBefore), statementsAfter = meter.read(), poolsAfter = poolStatements();
  // Read the commit counter before the checkpoint saves still queued drain,
  // so it covers the same window as the statement totals.
  const [commitsAfter] = await db.$client.unsafe("select xact_commit::float8 as commits from pg_stat_database where datname = current_database()");
  await Promise.all(fleet.map(agent => agent.checkpointTail));
  const seconds = elapsedMs / 1000;

  console.log(JSON.stringify({
    agents: AGENTS, windowSeconds: SECONDS, elapsedSeconds: round(seconds), sources: SOURCES,
    perAgentRatesPerSecond: Object.fromEntries(SOURCES.map(source => [source, round(RATES[source], 3)])),
    process: {
      eventLoopUtilization: round(loop.utilization, 3),
      eventLoopDelayMs: { p50: round(delay.percentile(50) / 1e6), p99: round(delay.percentile(99) / 1e6), max: round(delay.max / 1e6) },
      cpuCores: round((cpu.user + cpu.system) / 1e6 / seconds, 2),
      heapGrowthSampledMBPerSecond: round(allocated / 1e6 / seconds),
    },
    database: {
      meteredStatementsPerSecond: round((statementsAfter.statements - statementsBefore.statements) / seconds),
      meteredStatementsPerSecondByPool: Object.fromEntries(POOLS.map((pool, index) =>
        [pool, round((poolsAfter[index]! - poolsBefore[index]!) / seconds)])),
      meteredTransactionsPerSecond: round((statementsAfter.transactions - statementsBefore.transactions) / seconds),
      meteredSqlKBPerSecond: round((statementsAfter.sqlBytes - statementsBefore.sqlBytes) / 1024 / seconds),
      commitsPerSecondAllPools: round((Number(commitsAfter!.commits) - Number(commitsBefore!.commits)) / seconds),
    },
    bySource: Object.fromEntries(SOURCES.map(source => {
      const stat = stats[source], offered = Math.floor(AGENTS * RATES[source] * SECONDS);
      return [source, { offered, done: stat.done, failed: stat.failed, firstError: stat.firstError || undefined,
        donePerSecond: round(stat.done / seconds), lateMs: { p50: quantile(stat.late, 0.5), p99: quantile(stat.late, 0.99),
          max: stat.late.length ? round(stat.late.reduce((max, value) => Math.max(max, value), -Infinity)) : null } }];
    })),
    deltaBatchMs: DELTA_BATCH_MS, leaseMode: LEASE_BATCHED ? "batch" : "single", leasesLost,
    checkpointSaves: { failed: checkpointFailures, firstError: firstCheckpointError || undefined },
  }, null, 2));
} finally {
  server?.closeAllConnections();
  server?.close();
  // The side pools keep the process alive unless they are ended as well. An
  // end can wait on a connection that is still closing, so it is bounded.
  await Promise.race([sleep(6_000), Promise.all([db, checkpointDb(db), livenessDb(db)]
    .map(client => client.$client.end({ timeout: 5 }).catch(() => undefined)))]);
  await temporary.cleanup();
}
// Metered sockets and keep-alive HTTP agents can outlive the report.
process.exit(process.exitCode ?? 0);
