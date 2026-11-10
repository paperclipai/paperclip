import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

// Run only against an explicitly disposable, otherwise idle Postgres cluster.
// pg_stat_statements must be preloaded; CPU/memory measurements use its cgroup.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
function required(name: string) {
  const value = process.env[name];
  assert(value, `Set ${name}`);
  return value;
}
const baselineRoot = path.resolve(required("BENCH_BASELINE_ROOT"));
const root = path.resolve(required("BENCH_REPORT_ROOT"));
const url = required("BENCH_DATABASE_URL");
const parsedUrl = new URL(url);
assert(
  ["postgres:", "postgresql:"].includes(parsedUrl.protocol) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(parsedUrl.hostname),
  "Use an explicit loopback Postgres URL",
);
assert.equal(process.env.BENCH_DISPOSABLE_POSTGRES, "1", "The whole cluster must be owned by this benchmark");
const mode = process.argv[2] ?? "steady";
assert(["pilot", "steady", "burst"].includes(mode));
const pgCgroup = required("BENCH_POSTGRES_CGROUP");
const [cpuQuota, cpuPeriod] = fs.readFileSync(path.join(pgCgroup, "cpu.max"), "utf8").trim().split(/\s+/).map(Number);
assert.equal(cpuQuota / cpuPeriod, 2, "The reference workload requires two Postgres CPUs");
assert.equal(
  Number(fs.readFileSync(path.join(pgCgroup, "memory.max"), "utf8")),
  1536 * 1024 * 1024,
  "The reference workload requires a 1536 MiB Postgres memory limit",
);
const load = (base: string, file: string) => import(pathToFileURL(path.join(base, file)).href);
const {
  completionContracts,
  createDb,
  livenessDb,
  checkpointDb,
  closeRegisteredClients,
  migratePostgresIfEmpty,
  companies,
  agents,
  issues,
  heartbeatRuns,
  nativeRunFinalizations,
} = await load(repoRoot, "packages/db/src/index.ts");
const { nativeRunnerCheckpointWriter: CandidateWriter } = await load(
  repoRoot,
  "server/src/services/native-runtime/native-runner-checkpoint.ts",
);
const { nativeRunnerCheckpointWriter: BaselineWriter } = await load(
  baselineRoot,
  "server/src/services/native-runtime/native-runner-checkpoint.ts",
);
const { startNativeSessionExecutionLeaseRenewal } = await load(
  repoRoot,
  "server/src/services/native-runtime/native-execution-lease.ts",
);
const { loadAgentRunAuthentication } = await load(repoRoot, "server/src/middleware/agent-run-authentication.ts");
const { DurablePrpControlPlane: CandidateCore } = await load(
  repoRoot,
  "packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts",
);
const { DurablePrpControlPlane: BaselineCore } = await load(
  baselineRoot,
  "packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts",
);
const { PaperclipControlPlanePort: CandidatePort } = await load(
  repoRoot,
  "server/src/services/native-runtime/paperclip-control-plane-port.ts",
);
const { PaperclipControlPlanePort: BaselinePort } = await load(
  baselineRoot,
  "server/src/services/native-runtime/paperclip-control-plane-port.ts",
);
const require = createRequire(path.join(repoRoot, "server/package.json"));
const postgres = createRequire(path.join(repoRoot, "packages/db/package.json"))("postgres");
const { and, eq, desc } = require("drizzle-orm");
const pressure = (base: string, name: string) => {
  const file = path.join(base, name + ".pressure");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
};
const pgResources = () => {
  const raw = fs.readFileSync(path.join(pgCgroup, "cpu.stat"), "utf8");
  return {
    cpuUsec: Number(raw.match(/usage_usec (\d+)/)![1]),
    throttledUsec: Number(raw.match(/throttled_usec (\d+)/)?.[1] ?? 0),
    throttledPeriods: Number(raw.match(/nr_throttled (\d+)/)?.[1] ?? 0),
    cpuPressure: pressure(pgCgroup, "cpu"),
    memoryPressure: pressure(pgCgroup, "memory"),
    memoryBytes: Number(fs.readFileSync(path.join(pgCgroup, "memory.current"), "utf8")),
  };
};
const revision = (directory: string) =>
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
const provenance = {
  harnessSha256: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
  lockObserver: { intervalMs: 25, nominalQueriesPerSecond: 40, includedInPostgresCpu: true },
  baselineRevision: process.env.BENCH_BASELINE_REVISION ?? revision(baselineRoot),
  candidateRevision: process.env.BENCH_CANDIDATE_REVISION ?? revision(repoRoot),
  candidateDiff:
    process.env.BENCH_CANDIDATE_DIFF ??
    execFileSync("git", ["diff", "HEAD", "--", "server/src/services/native-runtime", "packages/db/src"], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
};
await mkdir(root); // Refuse to overwrite earlier measurements.
await writeFile(path.join(root, "provenance.json"), JSON.stringify(provenance, null, 2));
const admin = postgres(url, {
  max: 1,
  onnotice: () => {},
  connection: { application_name: "benchmark-observer" },
});
const ownedPrefix = "native_recovery_bench_" + randomUUID().replaceAll("-", "");
const templateName = ownedPrefix + "_template";
const databaseUrl = (name: string) => {
  const value = new URL(url);
  value.pathname = "/" + name;
  return value.toString();
};
process.env.PAPERCLIP_HOME = root + "/home";
process.env.PAPERCLIP_SECRETS_MASTER_KEY = randomBytes(32).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const summary = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y);
  return {
    n: b.length,
    p50: b[Math.floor(b.length * 0.5)] ?? 0,
    p95: b[Math.floor(b.length * 0.95)] ?? 0,
    p99: b[Math.floor(b.length * 0.99)] ?? 0,
    max: b.at(-1) ?? 0,
  };
};
// Sampling reports bounded estimates for observed episodes, never exact lock time.
// A wait shorter than a polling gap can be missed entirely. Query text is excluded.
function observeLockWaits(monitor: any, intervalMs = 25) {
  const active = new Map<string, any>();
  const episodes: any[] = [];
  const gaps: number[] = [];
  const errors: string[] = [];
  let previous = performance.now(), stopped = false;
  let poll: Promise<void> | undefined;
  let samples = 0;
  const collect = async () => {
    const rows = await monitor`select a.pid,a.application_name,a.query_start::text as query_start,a.wait_event,l.waitstart::text as wait_start,extract(epoch from clock_timestamp()-l.waitstart)*1000 as wait_age_ms from pg_stat_activity a join pg_locks l on l.pid=a.pid and not l.granted and l.waitstart is not null where a.datname=current_database() and a.application_name!='benchmark-observer' and a.wait_event_type='Lock'`;
    const now = performance.now(), gap = now - previous;
    gaps.push(gap);
    samples++;
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.pid}/${row.query_start}/${row.wait_start}/${row.wait_event}`;
      seen.add(key);
      const old = active.get(key);
      if (old) { old.lastMs = now; old.wait_age_ms = Number(row.wait_age_ms); }
      else active.set(key, { ...row, firstMs: now, lastMs: now, precedingGapMs: gap });
    }
    for (const [key, episode] of active) {
      if (seen.has(key)) continue;
      episodes.push({ ...episode, observedLowerMs: Number(episode.wait_age_ms),
        estimatedUpperMs: Number(episode.wait_age_ms) + now - episode.lastMs, rightCensored: false });
      active.delete(key);
    }
    previous = now;
  };
  const timer = setInterval(() => {
    if (stopped || poll) return;
    poll = collect().catch((e: any) => errors.push(e.message)).finally(() => { poll = undefined; });
  }, intervalMs);
  return { async stop() {
    stopped = true;
    clearInterval(timer);
    await poll;
    await collect().catch((e: any) => errors.push(e.message));
    for (const episode of active.values()) episodes.push({ ...episode,
      observedLowerMs: Number(episode.wait_age_ms), estimatedUpperMs: null, rightCensored: true });
    const byPool = Object.fromEntries(["benchmark-application", "paperclip-controller-lease", "paperclip-runner-checkpoint"].map(pool => {
      const selected = episodes.filter(e => e.application_name === pool);
      return [pool, { observedEpisodes: selected.length,
        observedLowerMs: summary(selected.map(e => e.observedLowerMs)),
        estimatedUpperMs: summary(selected.filter(e => e.estimatedUpperMs !== null).map(e => e.estimatedUpperMs)) }];
    }));
    return { intervalMs, samples, gapsMs: summary(gaps), errors, byPool, episodes,
      limits: "Episodes use PostgreSQL pg_locks.waitstart identity. Lower bounds are server-reported wait age at the last observation; estimated upper bounds add the next client polling gap. Waits shorter than polling gaps can be missed; network/event-loop delay widens upper bounds. Observer nominally adds 40 queries/second, included in database CPU. SQL execution statistics include lock time and are not lock-exclusive." };
  } };
}
async function setup() {
  await admin.unsafe(`create database ${templateName}`);
  const u = databaseUrl(templateName);
  await migratePostgresIfEmpty(u);
  const db = createDb(u);
  await db.$client.unsafe("create extension if not exists pg_stat_statements");
  const companyId = randomUUID(),
    agentId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Synthetic normal-operation benchmark",
    issuePrefix: "BENCH",
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Benchmark fixture",
    adapterType: "paperclip_runner",
    adapterConfig: { provider: "codex" },
    status: "active",
  });
  for (let batch = 0; batch < 20; batch++)
    await db.insert(issues).values(
      Array.from({ length: 500 }, (_, j) => ({
        companyId,
        title: `Historical task ${batch * 500 + j}`,
        status: j % 3 ? "done" : "backlog",
        identifier: `BENCH-${batch * 500 + j + 1}`,
        issueNumber: batch * 500 + j + 1,
        description: "Synthetic context ".repeat(80),
      })),
    );
  await db.$client.unsafe("analyze");
  await writeFile(root + "/seed.json", JSON.stringify({ companyId, agentId }));
  await closeRegisteredClients(u);
}
async function sampleStats(dbName: string) {
  const [stat] =
    await admin`select xact_commit,xact_rollback,deadlocks,blks_read,blks_hit,tup_inserted,tup_updated,tup_deleted,temp_bytes from pg_stat_database where datname=${dbName}`;
  const [wal] = await admin`select pg_current_wal_insert_lsn()::text as lsn`;
  const statements =
    await admin`select query,calls,total_exec_time,rows,shared_blks_hit,shared_blks_read,wal_bytes from pg_stat_statements where dbid=(select oid from pg_database where datname=${dbName}) order by calls desc`;
  return { stat, wal: wal.lsn, statements };
}
async function run(variant: string, n: number, trial: number, durationMs: number) {
  const label = `${String(trial).padStart(2, "0")}_${variant}_${n}`,
    dbName = ownedPrefix + "_" + trial;
  await admin.unsafe(`create database ${dbName} template ${templateName}`);
  const u = databaseUrl(dbName),
    db = createDb(u, {
      maxConnections: 10,
      applicationName: "benchmark-application",
    });
  const seed = JSON.parse(await readFile(root + "/seed.json", "utf8"));
  const owner = {
    bootId: randomUUID(),
    pid: process.pid,
    processStartedAt: new Date(),
  };
  const items: any[] = [],
    metrics: any = {
      label,
      variant,
      n,
      durationMs,
      setupMs: 0,
      errors: [],
      dropped: 0,
      renewalLosses: 0,
      controls: 0,
      changedRows: 0,
      changedBytes: 0,
      checkpointTransactions: 0,
      sqlCount: 0,
      sqlCategories: {},
      normalRead: [],
      normalWrite: [],
      databaseAdmission: [],
      controlLatency: [],
      checkpointLatency: [],
      normalSchedulingLag: [],
      controlSchedulingLag: [],
      normalOffered: 0,
      normalCompleted: 0,
      normalWritesOffered: 0,
      normalWritesCompleted: 0,
      admissionsOffered: 0,
      admissionsCompleted: 0,
      peakPending: 0,
      samples: [],
    };
  // postgres.js calls onexecute after selecting a connection and encoding BEGIN.
  // Preserve that callback. Queue/admission and BEGIN response time are separate;
  // SQL execution/lock waits are reported independently by Postgres statistics.
  metrics.poolAdmission = [];
  metrics.beginResponse = [];
  metrics.poolQueueByPool = {};
  metrics.transactionLatencyByPool = {};
  for (const [pool, client] of [
    ["request", db.$client],
    ["liveness", livenessDb(db).$client],
    ["checkpoint", checkpointDb(db).$client],
  ] as const) {
    metrics.poolQueueByPool[pool] = [];
    metrics.transactionLatencyByPool[pool] = [];
    const originalBegin = client.begin,
      originalUnsafe = client.unsafe;
    let entering: { start: number; sent?: number } | null = null;
    client.unsafe = (query, parameters, options) => {
      const admission = entering;
      if (!admission || !/^begin\b/i.test(query)) return originalUnsafe(query, parameters, options);
      return originalUnsafe(query, parameters, {
        ...options,
        onexecute: (connection) => {
          admission.sent = performance.now();
          if (measuring) metrics.poolQueueByPool[pool].push(admission.sent - admission.start);
          return options.onexecute(connection);
        },
      });
    };
    client.begin = (...args) => {
      const admission = {
        start: performance.now(),
        sent: undefined as number | undefined,
      };
      const index = args.length - 1,
        work = args[index];
      args[index] = async (connection) => {
        if (measuring) {
          metrics.poolAdmission.push(performance.now() - admission.start);
          if (admission.sent !== undefined) metrics.beginResponse.push(performance.now() - admission.sent);
        }
        return work(connection);
      };
      entering = admission;
      try {
        return originalBegin(...args).finally(() => {
          if (measuring) metrics.transactionLatencyByPool[pool].push(performance.now() - admission.start);
        });
      } finally {
        entering = null;
      }
    };
  }
  metrics.snapshotLatency = [];
  metrics.snapshotTransactions = 0;
  let measuring = false;
  const originalFsync = fs.fsyncSync;
  metrics.fsyncDurations = [];
  fs.fsyncSync = function (fd) {
    const t = performance.now();
    try {
      return originalFsync(fd);
    } finally {
      if (measuring) metrics.fsyncDurations.push(performance.now() - t);
    }
  };
  syncBuiltinESMExports();
  db.$client.options.debug = (_conn: any, query: string) => {
    if (!measuring) return;
    metrics.sqlCount++;
    const c = /native_runner_checkpoints/.test(query)
      ? "checkpoint"
      : /native_run_finalizations/.test(query)
        ? "ownership"
        : /heartbeat_runs/.test(query)
          ? "run"
          : /issues/.test(query)
            ? "task"
            : "other";
    metrics.sqlCategories[c] = (metrics.sqlCategories[c] ?? 0) + 1;
  };
  metrics.livenessSqlCount = 0;
  metrics.livenessSqlKinds = {};
  {
    const live = livenessDb(db);
    live.$client.options.debug = (_connection, query) => {
      if (!measuring) return;
      metrics.livenessSqlCount++;
      const kind = query.trim().split(/\s+/)[0].toLowerCase();
      metrics.livenessSqlKinds[kind] = (metrics.livenessSqlKinds[kind] ?? 0) + 1;
    };
  }
  metrics.checkpointSqlCount = 0;
  {
    checkpointDb(db).$client.options.debug = (_conn, query) => {
      if (measuring) metrics.checkpointSqlCount++;
    };
  }
  const tSetup = performance.now(),
    runNonce = randomUUID();
  for (let i = 0; i < n; i++) {
    const runId = randomUUID(),
      issueId = randomUUID(),
      leaseOwner = randomUUID(),
      runnerId = randomUUID(),
      sessionId = randomUUID(),
      contractId = randomUUID();
    await db.transaction(async (tx: any) => {
      await tx.insert(issues).values({
        id: issueId,
        companyId: seed.companyId,
        title: "Active fixture " + i,
        status: "in_progress",
        assigneeAgentId: seed.agentId,
      });
      await tx.insert(completionContracts).values({
        id: contractId,
        companyId: seed.companyId,
        issueId,
        revision: 1,
        schemaVersion: "fixture",
        policyVersion: "fixture",
        risk: "low",
        completionAuthority: "agent",
        incompleteCriteriaPolicy: "allow",
        contractJson: {},
        canonicalSha256: "fixture",
        createdByActorType: "system",
        createdByActorId: "benchmark",
      });
      await tx.insert(heartbeatRuns).values({
        id: runId,
        companyId: seed.companyId,
        agentId: seed.agentId,
        status: "running",
        runtimeMode: "native",
        nativeIssueId: issueId,
        nativeSessionId: sessionId,
        runnerInstanceId: runnerId,
        completionContractId: contractId,
        completionContractSha256: "fixture",
        contextSnapshot: {
          issueId,
          fixture: "normal-load",
          prompt: "x".repeat(4096),
        },
      });
      await tx.insert(nativeRunFinalizations).values({
        runId,
        companyId: seed.companyId,
        issueId,
        phase: "observed",
        attempt: 1,
        leaseOwner,
        controllerBootId: owner.bootId,
        controllerPid: owner.pid,
        controllerProcessStartedAt: owner.processStartedAt,
        controllerGeneration: 1,
        leaseExpiresAt: new Date(Date.now() + 1200000),
      });
      await tx.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    });
    const stateDirectory = (process.env.BENCH_STATE_ROOT ?? root + "/states") + "/" + label + "/" + runNonce + "/" + i;
    const Core = variant === "candidate" ? CandidateCore : BaselineCore;
    const core = new Core({
      stateDirectory,
      identity: {
        runnerInstanceId: runnerId,
        environmentLeaseId: randomUUID(),
        runId,
        normalizedSessionId: sessionId,
        turnId: randomUUID(),
        itemId: randomUUID(),
      },
      expectedRunnerVersion: "fixture-v1",
      expectedRunnerDigest: "sha256:" + "a".repeat(64),
    });
    {
      const writer = (variant === "candidate" ? CandidateWriter : BaselineWriter)(db, {
        runId,
        issueId,
        companyId: seed.companyId,
        authorityRunId: runId,
        bootId: owner.bootId,
        generation: 1,
        leaseOwner,
      });
      core.setCheckpointPersistence(async (cp: any) => {
        const start = performance.now();
        await writer(cp);
        if (measuring) {
          metrics.checkpointTransactions++;
          metrics.changedRows += cp.changedRecords.size;
          metrics.changedBytes += [...cp.changedRecords.values()].reduce(
            (s: number, v: any) => s + Buffer.byteLength(v),
            0,
          );
          metrics.checkpointLatency.push(performance.now() - start);
        }
      });
      await core.flushCheckpoint();
    }
    const identity = {
      companyId: seed.companyId,
      agentId: seed.agentId,
      issueId,
      runId,
      sessionId,
    };
    const snapshot = {
      backendKind: "codex",
      sessionId,
      identity,
      driverKind: "codex_app_server",
      driverSessionId: "thread_" + runId,
      providerSessionId: "thread_" + runId,
      activeTurnId: null,
      terminalTurns: [],
      pendingRuntimeRequests: [],
    };
    const Port = variant === "candidate" ? CandidatePort : BaselinePort;
    const port = new Port(
      db,
      {
        ...identity,
        sourceInstanceId: runnerId,
        controlPlaneSourceInstanceId: "controller",
        completionContractId: contractId,
        completionContractSha256: "fixture",
      },
      variant === "candidate"
        ? {
            nativeRecovery: {
              compatibility: {
                configDigest: "sha256:" + "a".repeat(64),
                processConfigDigest: null,
              },
              owner: {
                companyId: seed.companyId,
                issueId,
                runId,
                authorityRunId: runId,
                bootId: owner.bootId,
                generation: 1,
                leaseOwner,
              },
            },
          }
        : {},
    );
    await port.openRun({
      identity,
      backendKind: "codex",
      sourceInstanceId: runnerId,
    });
    items.push({
      core,
      port,
      snapshot,
      runId,
      issueId,
      leaseOwner,
      companyId: seed.companyId,
      agentId: seed.agentId,
    });
  }
  metrics.setupMs = performance.now() - tSetup;
  const monitor = postgres(u, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "benchmark-observer" },
  });
  if (mode === "pilot") {
    // Verify the observer against one deliberately held row lock before measured work.
    const calibration = observeLockWaits(monitor);
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>(r => { locked = r; });
    const held = new Promise<void>(r => { release = r; });
    const blocker = db.$client.begin(async (tx: any) => {
      await tx`select 1 from native_run_finalizations where run_id=${items[0].runId} for update`;
      locked();
      await held;
    });
    await acquired;
    const waiterStarted = performance.now();
    const waiter = checkpointDb(db).$client.begin(async (tx: any) => {
      await tx`select 1 from native_run_finalizations where run_id=${items[0].runId} for update`;
    });
    // postgres.js BEGIN returns a lazy Promise; observing it starts the contender.
    const waiting = Promise.resolve(waiter);
    await sleep(250);
    const releasedAtMs = performance.now() - waiterStarted;
    release();
    await Promise.all([blocker, waiting]);
    await sleep(50);
    const observed = await calibration.stop();
    metrics.lockCalibration = { intentionalHoldMs: 250, releasedAtMs,
      transactionElapsedMs: performance.now() - waiterStarted, observed };
    assert(observed.episodes.some((e: any) => e.application_name === "paperclip-runner-checkpoint" && e.observedLowerMs >= 100), "Lock observer did not detect the deliberate row wait");
  }
  await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 60000) });
  await db.$client.unsafe("analyze");
  // Warm normal queries before measuring, identical in each arm.
  for (let i = 0; i < 100; i++) await loadAgentRunAuthentication(db, items[i % n]);
  await admin.unsafe("select pg_stat_statements_reset()");
  const pgBefore = pgResources();
  const before = await sampleStats(dbName),
    cpuBefore = process.cpuUsage(),
    el = monitorEventLoopDelay({ resolution: 10 });
  el.enable();
  const pending = new Set<Promise<any>>(),
    renewals: any[] = [],
    timers: any[] = [];
  function offer(action: () => Promise<any>, out: number[], scheduled = performance.now()) {
    if (pending.size >= 500) {
      metrics.dropped++;
      return;
    }
    const task = Promise.resolve()
      .then(action)
      .then(() => out.push(performance.now() - scheduled))
      .catch((e) => metrics.errors.push({ message: e.message, code: e.code }))
      .finally(() => pending.delete(task));
    pending.add(task);
    metrics.peakPending = Math.max(metrics.peakPending, pending.size);
  }
  measuring = true;
  const lockWaitObserver = observeLockWaits(monitor);
  const started = performance.now(),
    startedAt = new Date().toISOString();
  await writeFile(
    root + "/phase.json",
    JSON.stringify({
      label,
      phase: "running",
      startedAt,
      n,
      variant,
      durationMs,
    }),
  );
  console.log(
    JSON.stringify({
      phase: "started",
      label,
      setupMs: metrics.setupMs,
      startedAt,
    }),
  );
  for (const item of items) {
    const input = { db, ...item, attempt: 1, controller: owner };
    renewals.push(
      startNativeSessionExecutionLeaseRenewal({
        ...input,
        remote: true,
        onLost: async () => {
          metrics.renewalLosses++;
        },
      }),
    );
  }
  // Both arms receive the same offered workload. No await-before-next-tick pacing.
  let tick = 0;
  const offerNormal = () => {
    const due = Math.min(Math.floor(durationMs / 100), Math.floor((performance.now() - started) / 100));
    while (tick < due) {
      tick++;
      metrics.normalSchedulingLag.push(Math.max(0, performance.now() - started - tick * 100));
      for (let k = 0; k < (mode === "burst" ? 10 : 50); k++) {
        const idx = (tick * 50 + k) % n,
          item = items[idx];
        metrics.normalOffered++;
        offer(
          async () => {
            if (k % 10 < 7) {
              const rows = await loadAgentRunAuthentication(db, item);
              assert.equal(rows.length, 1);
              assert.equal(rows[0].status, "running");
            } else if (k % 10 < 9) {
              const rows = await db
                .select({
                  id: issues.id,
                  title: issues.title,
                  status: issues.status,
                })
                .from(issues)
                .where(and(eq(issues.companyId, seed.companyId), eq(issues.status, "backlog")))
                .orderBy(desc(issues.createdAt))
                .limit(50);
              assert.equal(rows.length, 50);
            } else {
              const rows = await db
                .select({
                  runId: nativeRunFinalizations.runId,
                  phase: nativeRunFinalizations.phase,
                })
                .from(nativeRunFinalizations)
                .where(eq(nativeRunFinalizations.runId, item.runId));
              assert.equal(rows[0]?.phase, "observed");
            }
            metrics.normalCompleted++;
          },
          metrics.normalRead,
          started + tick * 100,
        );
      }
      for (let k = 0; k < (mode === "burst" ? 2 : 10); k++) {
        const item = items[(tick * 10 + k) % n];
        metrics.normalWritesOffered++;
        offer(
          async () => {
            await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, item.issueId));
            metrics.normalWritesCompleted++;
          },
          metrics.normalWrite,
          started + tick * 100,
        );
      }
      if (tick % 50 === 0) {
        metrics.admissionsOffered++;
        offer(
          async () => {
            const runId = randomUUID(),
              issueId = randomUUID();
            await db.transaction(async (tx: any) => {
              await tx.insert(issues).values({
                id: issueId,
                companyId: seed.companyId,
                title: "Fresh admission database probe",
                status: "in_progress",
              });
              await tx.insert(heartbeatRuns).values({
                id: runId,
                companyId: seed.companyId,
                agentId: seed.agentId,
                status: "queued",
                runtimeMode: "native",
                nativeIssueId: issueId,
              });
              await tx.insert(nativeRunFinalizations).values({
                runId,
                companyId: seed.companyId,
                issueId,
                phase: "observed",
              });
              await tx.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
            });
            metrics.admissionsCompleted++;
          },
          metrics.databaseAdmission,
          started + tick * 100,
        );
      }
    }
  };
  const normal = setInterval(offerNormal, 100);
  timers.push(normal);
  // Same aggregate control rate, spread evenly across sessions for normal operation.
  let offeredControls = 0;
  const offerControl = () => {
    const elapsed = performance.now() - started;
    const due = Math.min(
      Math.floor((durationMs * n) / 5000),
      mode === "burst" ? Math.floor(elapsed / 5000) * n : Math.floor((elapsed * n) / 5000),
    );
    while (offeredControls < due) {
      const index = offeredControls++,
        item = items[index % n],
        seq = Math.floor(index / n) + 1;
      const scheduled = started + (mode === "burst" ? seq * 5000 : ((index + 1) * 5000) / n);
      metrics.controlSchedulingLag.push(Math.max(0, performance.now() - scheduled));
      offer(
        async () => {
          item.core.queueCommand(
            "semantic_tool.result",
            {
              callId: `fixture_call_${seq}`,
              operationId: "fixture_read",
              result: { body: "x".repeat(4096) },
              isError: false,
            },
            `control_${seq}`,
          );
          await item.core.flushCheckpoint();
          const snapshotStarted = performance.now();
          await item.port.checkpointSession(item.snapshot);
          metrics.snapshotLatency.push(performance.now() - snapshotStarted);
          metrics.snapshotTransactions++;
          metrics.controls++;
        },
        metrics.controlLatency,
        scheduled,
      );
    }
  };
  const control = setInterval(offerControl, 10);
  timers.push(control);
  const sampler = setInterval(() => {
    void (async () => {
      const m = process.memoryUsage();
      const activity =
        await monitor`select count(*)::int as connections,count(*) filter(where state='active')::int as active,count(*) filter(where wait_event_type='Lock')::int as locks from pg_stat_activity where datname=current_database() and application_name!='benchmark-observer'`;
      metrics.samples.push({
        elapsedMs: performance.now() - started,
        rss: m.rss,
        heapUsed: m.heapUsed,
        postgresMemoryBytes: pgResources().memoryBytes,
        ...activity[0],
      });
    })().catch((e) => metrics.errors.push({ observer: e.message }));
  }, 1000);
  timers.push(sampler);
  await sleep(durationMs);
  offerNormal();
  offerControl();
  for (const t of timers) clearInterval(t);
  const drainStart = performance.now();
  await Promise.allSettled([...pending]);
  await Promise.allSettled(renewals.map((r) => r.stop()));
  metrics.drainMs = performance.now() - drainStart;
  metrics.lockWait = await lockWaitObserver.stop();
  metrics.elapsedMs = performance.now() - started;
  metrics.startedAt = startedAt;
  metrics.endedAt = new Date().toISOString();
  measuring = false;
  fs.fsyncSync = originalFsync;
  syncBuiltinESMExports();
  metrics.fsyncTotalMs = metrics.fsyncDurations.reduce((a, b) => a + b, 0);
  el.disable();
  metrics.nodeCpu = process.cpuUsage(cpuBefore);
  metrics.eventLoopDelay = {
    p95Ms: el.percentile(95) / 1e6,
    p99Ms: el.percentile(99) / 1e6,
    maxMs: el.max / 1e6,
  };
  // Flush PG statistics after all application activity; observer SQL is tagged/excluded below.
  await sleep(1100);
  const after = await sampleStats(dbName);
  const [wal] = await admin`select pg_wal_lsn_diff(${after.wal}::pg_lsn,${before.wal}::pg_lsn)::text as bytes`;
  metrics.walBytes = Number(wal.bytes);
  const pgAfter = pgResources();
  metrics.postgresCpuUsec = pgAfter.cpuUsec - pgBefore.cpuUsec;
  metrics.postgresResources = { before: pgBefore, after: pgAfter, throttledUsec: pgAfter.throttledUsec - pgBefore.throttledUsec, throttledPeriods: pgAfter.throttledPeriods - pgBefore.throttledPeriods };
  metrics.postgresMemoryBytes = pgAfter.memoryBytes;
  metrics.postgresPeakSampledMemoryBytes = Math.max(
    pgBefore.memoryBytes,
    pgAfter.memoryBytes,
    ...metrics.samples.map((s) => s.postgresMemoryBytes),
  );
  metrics.platform = {
    node: process.version,
    os: process.platform,
    arch: process.arch,
  };
  metrics.databaseStats = Object.fromEntries(
    Object.keys(after.stat).map((k) => [k, Number(after.stat[k]) - Number(before.stat[k])]),
  );
  metrics.statements = after.statements;
  metrics.lockObserverSql = after.statements.filter((s: any) => /pg_locks.*waitstart|waitstart.*pg_locks/.test(s.query));
  metrics.tableStats =
    await monitor`select relname,n_tup_ins,n_tup_upd,n_tup_del,n_dead_tup from pg_stat_user_tables where relname in ('native_runner_checkpoints','native_run_finalizations','heartbeat_runs','issues') order by relname`;
  const [storage] =
    await monitor`select count(*)::int as rows,coalesce(sum(pg_column_size(material)),0)::bigint::text as encrypted_bytes,pg_total_relation_size('native_runner_checkpoints')::text as relation_bytes from native_runner_checkpoints`;
  metrics.checkpointStorage = storage;
  for (const name of [
    "poolAdmission",
    "beginResponse",
    "snapshotLatency",
    "normalRead",
    "normalWrite",
    "databaseAdmission",
    "controlLatency",
    "checkpointLatency",
    "normalSchedulingLag",
    "controlSchedulingLag",
    "fsyncDurations",
  ]) {
    metrics[name + "Summary"] = summary(metrics[name]);
    delete metrics[name];
  }
  for (const pool of Object.keys(metrics.poolQueueByPool)) {
    metrics.poolQueueByPool[pool] = summary(metrics.poolQueueByPool[pool]);
    metrics.transactionLatencyByPool[pool] = summary(metrics.transactionLatencyByPool[pool]);
  }
  metrics.nodeCpuAverageOneCorePercent =
    ((metrics.nodeCpu.user + metrics.nodeCpu.system) / 1000 / metrics.elapsedMs) * 100;
  metrics.correctnessPassed =
    metrics.errors.length === 0 &&
    metrics.lockWait.errors.length === 0 &&
    metrics.renewalLosses === 0 &&
    metrics.dropped === 0 &&
    metrics.normalCompleted === metrics.normalOffered &&
    metrics.normalWritesCompleted === metrics.normalWritesOffered &&
    metrics.admissionsCompleted === metrics.admissionsOffered;
  metrics.absoluteGates = {
    requestP99: metrics.normalReadSummary.p99 < 250,
    drain: metrics.drainMs < 1000,
    throughput: metrics.normalCompleted / metrics.normalOffered >= 0.99,
    postgresCpu: metrics.postgresCpuUsec / 1000 / metrics.elapsedMs / 2 < 0.75,
    postgresMemory: metrics.postgresPeakSampledMemoryBytes < 1382.4 * 1024 * 1024,
  };
  metrics.passed = metrics.correctnessPassed && Object.values(metrics.absoluteGates).every(Boolean);
  await writeFile(root + "/" + label + ".json", JSON.stringify(metrics, null, 2) + "\n");
  console.log(
    JSON.stringify({
      phase: "complete",
      label,
      passed: metrics.passed,
      reads: metrics.normalReadSummary,
      writes: metrics.normalWriteSummary,
      control: metrics.controlLatencySummary,
      renewalLosses: metrics.renewalLosses,
      dropped: metrics.dropped,
      cpu: metrics.nodeCpuAverageOneCorePercent,
      errors: metrics.errors.slice(0, 3),
    }),
  );
  await monitor.end();
  await closeRegisteredClients(u);
  await admin.unsafe(`drop database ${dbName}`);
  return metrics;
}
try {
  await admin.unsafe("create extension if not exists pg_stat_statements");
  await setup();
  if (mode === "pilot") {
    if (!(await run("candidate", 10, 9, 25000)).passed) process.exitCode = 1;
  } else {
    const profile = [
      ["baseline", 300],
      ["candidate", 300],
      ["candidate", 300],
      ["baseline", 300],
    ] as const;
    const result = [];
    for (const [variant, n] of profile) result.push(await run(variant, n, result.length + 1, 65000));
    const report = {
      schema: "paperclip.normal-recovery-load/v1",
      ...provenance,
      scope:
        "Paired baseline/candidate, including real PaperclipControlPlanePort snapshot persistence on every control checkpoint. Database/control-plane component stress; real production checkpoint writer and natural remote lease timers. Same synthetic DB request load. Not full HTTP, harness or hosted capacity qualification.",
      hardware: {
        postgresCpuLimit: 2,
        postgresMemoryLimitMiB: 1536,
        mainPool: 10,
        livenessPool: 2,
        candidateCheckpointPool: 3,
      },
      workload: {
        mode,
        normalReadsPerSecond: mode === "burst" ? 100 : 500,
        normalWritesPerSecond: mode === "burst" ? 20 : 100,
        databaseAdmissionEverySeconds: 5,
        checkpointControlEverySeconds: 5,
        controlPayloadBytes: 4096,
        phaseSeconds: 65,
        snapshotTransactionsPerControl: 1,
        baselineCheckpointPool: 3,
        baselinePoolPolicy: "Controlled baseline uses the common current DB factory's checkpoint cap of 3; this is not the unmodified historical cap-2 baseline.",
        baselineRenewalIntervalSeconds: 20,
        candidateRenewalIntervalSeconds: 20,
        historicalIssues: 10000,
      },
      results: result,
    };
    const perOperation = (r: any, key: string) =>
      r[key] / (r.normalCompleted + r.normalWritesCompleted + r.controls + r.admissionsCompleted);
    const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const comparable =
      result.every((r) => r.correctnessPassed) &&
      result.every(
        (r) =>
          r.controls === result[0].controls &&
          r.normalCompleted === result[0].normalCompleted &&
          r.normalWritesCompleted === result[0].normalWritesCompleted,
      );
    const relative = {};
    for (const key of ["postgresCpuUsec", "walBytes", "requestP99"]) {
      const value = (r: any) => (key === "requestP99" ? r.normalReadSummary.p99 : perOperation(r, key));
      const baseline = average(result.filter((r) => r.variant === "baseline").map(value));
      const candidate = average(result.filter((r) => r.variant === "candidate").map(value));
      relative[key] = {
        baseline,
        candidate,
        increasePercent: comparable ? 100 * (candidate / baseline - 1) : null,
        passed: comparable ? candidate <= baseline * 1.1 : null,
      };
    }
    Object.assign(report, {
      relative,
      comparable,
      passed: result.every((r) => r.passed) && Object.values(relative).every((r: any) => r.passed),
      measurementLimits: [
        "Database request latency is not HTTP latency",
        "Pool queue includes client encoding; BEGIN response includes network time",
        "pg_stat_statements execution includes lock waits; lock episodes report sampled duration bounds, with short waits potentially missed",
        "Peak memory is sampled once a second",
        "Use an otherwise idle cluster and host; WAL and cgroup CPU are cluster-wide",
      ],
    });
    await writeFile(root + "/report.json", JSON.stringify(report, null, 2) + "\n");
    if (!(report as typeof report & { passed: boolean }).passed) process.exitCode = 1;
  }
} finally {
  await admin.end({ timeout: 1 });
}
// On failure, retain owned databases for diagnosis. Successful trials are dropped;
// the random template remains available for fixture inspection until cluster cleanup.
