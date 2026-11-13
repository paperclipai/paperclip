/**
 * Load model: what N running native agents cost one server process.
 *
 * Each simulated agent drives the real server code at a fixed rate, against an
 * embedded PostgreSQL on loopback, in this one Node process:
 *
 *   deltas  appendHeartbeatRunEvent for an `item.delta` (one per text chunk)
 *   events  appendHeartbeatRunEvent for an `item.completed`, then the real
 *           controller checkpoint save, which overlaps the next append
 *   lease   renewNativeSessionExecutionLease (remote runs renew every 20 s)
 *   api     an HTTP request through actorMiddleware with the run's agent JWT
 *
 * Arrivals are open-loop: operation i of a stream is due at start + i/rate.
 * A stream is serial, like one runner connection, so when the process cannot
 * keep up the lateness (finish time minus due time) grows and the stream
 * finishes fewer operations than were offered in the window.
 *
 * It reports, for the window: event-loop utilization and delay, CPU, memory
 * allocated, statements and transactions, and per source the operations done
 * against those offered with their lateness.
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
 * DELTA_BYTES (120), EVENT_KIB (2), DATABASE_POOL_MAX (driver default 10).
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
import { appendHeartbeatRunEvent } from "../server/src/services/heartbeat-run-events.js";
import { renewNativeSessionExecutionLease } from "../server/src/services/native-runtime/native-execution-lease.js";
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
process.env.PAPERCLIP_SECRETS_MASTER_KEY ??= randomBytes(32).toString("base64");
process.env.PAPERCLIP_AGENT_JWT_SECRET ??= randomBytes(32).toString("base64");

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));
const quantile = (values: number[], q: number) => values.length === 0 ? null
  : Number([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!.toFixed(1));
const round = (value: number, digits = 1) => Number(value.toFixed(digits));

const temporary = await startEmbeddedPostgresTestDatabase("agent-scaling-load-");
const db = createDb(temporary.connectionString);
// Checkpoint saves and lease renewals use their own pools; meter all three.
const meters = [db, checkpointDb(db), livenessDb(db)].map(client => meterDatabaseStatements(client, temporary.connectionString));
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
      checkpointTail: Promise.resolve(), appendTail: Promise.resolve() as Promise<unknown>, token: createLocalAgentJwt(agent!.id, companyId, "process", runId, null)! });
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
  const append = (agent: Agent, eventType: string, bytes: number) => {
    const queued = agent.appendTail.then(() => appendNow(agent, eventType, bytes));
    agent.appendTail = queued.catch(() => undefined);
    return queued;
  };
  const appendNow = (agent: Agent, eventType: string, bytes: number) => {
    const seq = ++agent.seq;
    const event = { sourceSeq: seq, eventType, runId: agent.runId, text: randomBytes(Math.ceil(bytes * 0.75)).toString("base64") };
    return appendHeartbeatRunEvent(db, { companyId, agentId: agent.agentId, runId: agent.runId, eventType, stream: "system",
      level: "info", payload: { prpEvent: event }, assertWritable: () => {},
      nativeSource: { sourceInstanceId: "bench-runner", sourceEventId: `event-${seq}`, sourceSeq: seq, protocolSchemaVersion: 1,
        canonicalPayload: event } }).then(() => ({ seq, event }));
  };
  const operations: Record<Source, (agent: Agent) => Promise<unknown>> = {
    deltas: agent => append(agent, "item.delta", DELTA_BYTES),
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
  for (const source of SOURCES) await operations[source](fleet[0]!);
  await fleet[0]!.checkpointTail;
  assert.equal(checkpointFailures, 0, `checkpoint save failed during warm-up: ${firstCheckpointError}`);

  const stats = Object.fromEntries(SOURCES.map(source => [source, { done: 0, failed: 0, late: [] as number[], firstError: "" }])) as
    Record<Source, { done: number; failed: number; late: number[]; firstError: string }>;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  const [commitsBefore] = await db.$client.unsafe("select xact_commit::float8 as commits from pg_stat_database where datname = current_database()");
  const statementsBefore = { ...meter.read() }, cpuBefore = process.cpuUsage(), loopBefore = performance.eventLoopUtilization();
  const heapBefore = process.memoryUsage().heapUsed;
  let allocated = 0, lastHeap = heapBefore;
  const sampler = setInterval(() => { const heap = process.memoryUsage().heapUsed; if (heap > lastHeap) allocated += heap - lastHeap; lastHeap = heap; }, 20);
  delay.enable();
  const started = performance.now(), deadline = started + SECONDS * 1000;

  await Promise.all(fleet.flatMap(agent => SOURCES.map(async source => {
    const interval = 1000 / RATES[source], offset = Math.random() * interval, stat = stats[source];
    for (let index = 0; ; index++) {
      const due = started + offset + index * interval;
      if (due >= deadline) return;
      await sleep(due - performance.now());
      try { await operations[source](agent); stat.done += 1; }
      catch (error) { stat.failed += 1; stat.firstError ||= String((error as Error)?.message ?? error).slice(0, 200); }
      stat.late.push(performance.now() - due);
      // A stream that is still behind at the end of the window stops there:
      // `done` below `offered` is the work the process could not keep up with.
      if (performance.now() > deadline) return;
    }
  })));
  const elapsedMs = performance.now() - started;
  delay.disable();
  clearInterval(sampler);
  const loop = performance.eventLoopUtilization(loopBefore), cpu = process.cpuUsage(cpuBefore), statementsAfter = meter.read();
  await Promise.all(fleet.map(agent => agent.checkpointTail));
  const [commitsAfter] = await db.$client.unsafe("select xact_commit::float8 as commits from pg_stat_database where datname = current_database()");
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
