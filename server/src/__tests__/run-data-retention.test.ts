import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  costEvents,
  createDb,
  financeEvents,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pruneRunData, startRunDataRetention, __testing_setSweepInFlight } from "../services/run-data-retention.js";
import type { Config } from "../config.js";
import { paperclipConfigSchema, retentionConfigSchema } from "@paperclipai/shared/config-schema";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbedded = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres retention tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    host: "127.0.0.1",
    port: 3100,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "embedded-postgres",
    databaseUrl: undefined,
    embeddedPostgresDataDir: "/tmp/test",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "/tmp/test/backups",
    databaseBackupExcludeTables: [],
    retentionEnabled: true,
    retentionIntervalMinutes: 60,
    retentionHeartbeatRunEventsDays: 7,
    retentionHeartbeatRunsDays: 14,
    retentionAgentWakeupRequestsDays: 14,
    retentionActivityLogDays: 30,
    retentionCostEventsDays: 90,
    retentionFinanceEventsDays: 90,
    retentionRunLogFilesDays: 14,
    serveUi: false,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/test/key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/test/storage",
    storageS3Bucket: "test",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    feedbackExportBackendUrl: undefined,
    feedbackExportBackendToken: undefined,
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    telemetryEnabled: false,
    ...overrides,
  };
}

describeEmbedded("run-data-retention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-retention-");
    db = createDb(tempDb.connectionString);

    // Seed required parent rows
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co", slug: "test-co" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "test-agent",
      slug: "test-agent",
      executionAdapterType: "local_process",
    });
  }, 30_000);

  afterEach(async () => {
    // Clean up in FK-safe order
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
  });

  afterAll(async () => {
    await db.delete(agents);
    await db.delete(companies);
    await tempDb?.cleanup();
  }, 10_000);

  // T6.2: FK-safe deletion ordering
  it("deletes in FK-safe order without FK violations", async () => {
    const runId = randomUUID();
    const wakeupId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId,
      source: "cron",
      status: "finished",
      createdAt: daysAgo(20),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "completed",
      wakeupRequestId: wakeupId,
      createdAt: daysAgo(20),
      finishedAt: daysAgo(20),
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "log",
      createdAt: daysAgo(20),
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      heartbeatRunId: runId,
      provider: "anthropic",
      model: "claude",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 10,
      occurredAt: daysAgo(100),
    });
    await db.insert(financeEvents).values({
      companyId,
      agentId,
      heartbeatRunId: runId,
      eventKind: "llm_usage",
      biller: "anthropic",
      amountCents: 10,
      occurredAt: daysAgo(100),
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "run.completed",
      entityType: "heartbeat_run",
      entityId: runId,
      runId,
      createdAt: daysAgo(40),
    });

    const config = makeConfig();
    // Should not throw FK violation errors
    await pruneRunData(db, config);

    // Verify all expired rows are gone
    const remainingRuns = await db.select().from(heartbeatRuns);
    expect(remainingRuns).toHaveLength(0);
  });

  // T6.3: Retention age filtering
  it("only prunes rows older than the configured retention periods", async () => {
    // Insert rows at various ages
    const recentRunId = randomUUID();
    const oldRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      { id: recentRunId, companyId, agentId, status: "completed", createdAt: daysAgo(1), finishedAt: daysAgo(1) },
      { id: oldRunId, companyId, agentId, status: "completed", createdAt: daysAgo(20), finishedAt: daysAgo(20) },
    ]);
    await db.insert(heartbeatRunEvents).values([
      { companyId, runId: recentRunId, agentId, seq: 1, eventType: "log", createdAt: daysAgo(1) },
      { companyId, runId: oldRunId, agentId, seq: 1, eventType: "log", createdAt: daysAgo(10) },
    ]);
    await db.insert(activityLog).values([
      { companyId, actorType: "system", actorId: "sys", action: "a", entityType: "t", entityId: "1", createdAt: daysAgo(1) },
      { companyId, actorType: "system", actorId: "sys", action: "a", entityType: "t", entityId: "2", createdAt: daysAgo(40) },
    ]);

    const config = makeConfig();
    await pruneRunData(db, config);

    // Recent run should survive (1 day old, retention is 14 days)
    const runs = await db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(recentRunId);

    // Recent event should survive (1 day old, retention is 7 days)
    const events = await db.select().from(heartbeatRunEvents);
    expect(events).toHaveLength(1);

    // Recent activity should survive (1 day old, retention is 30 days)
    const activity = await db.select().from(activityLog);
    expect(activity).toHaveLength(1);
  });

  // T6.4: NOT EXISTS guard on cost_events
  it("preserves cost_events referenced by finance_events", async () => {
    const costId = randomUUID();
    await db.insert(costEvents).values({
      id: costId,
      companyId,
      agentId,
      provider: "anthropic",
      model: "claude",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 10,
      occurredAt: daysAgo(100),
    });
    // finance_event references this cost_event but is NOT expired
    await db.insert(financeEvents).values({
      companyId,
      agentId,
      costEventId: costId,
      eventKind: "llm_usage",
      biller: "anthropic",
      amountCents: 10,
      occurredAt: daysAgo(1), // recent — won't be pruned
    });

    const config = makeConfig();
    await pruneRunData(db, config);

    // cost_event should survive because finance_event references it
    const remaining = await db.select().from(costEvents);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(costId);
  });

  // T6.5: NOT EXISTS guard on agent_wakeup_requests
  it("preserves wakeup_requests referenced by heartbeat_runs", async () => {
    const wakeupId = randomUUID();
    const runId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId,
      source: "cron",
      status: "finished",
      createdAt: daysAgo(20),
    });
    // Run references this wakeup but is NOT expired
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "completed",
      wakeupRequestId: wakeupId,
      createdAt: daysAgo(1),
      finishedAt: daysAgo(1),
    });

    const config = makeConfig();
    await pruneRunData(db, config);

    // wakeup_request should survive because heartbeat_run references it
    const remaining = await db.select().from(agentWakeupRequests);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(wakeupId);
  });

  // T6.6: CASCADE behavior
  it("cascade-deletes heartbeat_run_events when heartbeat_run is deleted", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "completed",
      createdAt: daysAgo(20),
      finishedAt: daysAgo(20),
    });
    await db.insert(heartbeatRunEvents).values([
      { companyId, runId, agentId, seq: 1, eventType: "log", createdAt: daysAgo(1) },
      { companyId, runId, agentId, seq: 2, eventType: "log", createdAt: daysAgo(1) },
    ]);

    // Delete the run directly (simulating retention) — events should cascade
    const config = makeConfig({ retentionHeartbeatRunsDays: 1 });
    await pruneRunData(db, config);

    const events = await db.select().from(heartbeatRunEvents);
    expect(events).toHaveLength(0);
  });

  // T6.7: SET NULL behavior
  it("nullifies agent_task_session.lastRunId when heartbeat_run is deleted", async () => {
    const runId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "completed",
      createdAt: daysAgo(20),
      finishedAt: daysAgo(20),
    });
    await db.insert(agentTaskSessions).values({
      id: sessionId,
      companyId,
      agentId,
      adapterType: "local_process",
      taskKey: "test-task",
      lastRunId: runId,
    });

    const config = makeConfig({ retentionHeartbeatRunsDays: 1 });
    await pruneRunData(db, config);

    const sessions = await db.select().from(agentTaskSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.lastRunId).toBeNull();
  });

  // T6.12: Terminal-status filter
  it("preserves queued and running runs even when older than cutoff", async () => {
    const queuedRunId = randomUUID();
    const runningRunId = randomUUID();
    const completedRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      { id: queuedRunId, companyId, agentId, status: "queued", createdAt: daysAgo(30) },
      { id: runningRunId, companyId, agentId, status: "running", createdAt: daysAgo(30), startedAt: daysAgo(30) },
      { id: completedRunId, companyId, agentId, status: "completed", createdAt: daysAgo(30), finishedAt: daysAgo(30) },
    ]);

    const config = makeConfig();
    await pruneRunData(db, config);

    const remaining = await db.select().from(heartbeatRuns);
    const ids = remaining.map((r) => r.id).sort();
    expect(ids).toEqual([queuedRunId, runningRunId].sort());
  });

  // T6.13: COALESCE timestamp
  it("uses createdAt when startedAt is NULL for age calculation", async () => {
    const nullStartRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nullStartRunId,
      companyId,
      agentId,
      status: "failed",
      startedAt: null,
      finishedAt: null,
      createdAt: daysAgo(20),
    });

    const config = makeConfig();
    await pruneRunData(db, config);

    // Should be pruned because createdAt (20d) > retentionHeartbeatRunsDays (14d)
    const remaining = await db.select().from(heartbeatRuns);
    expect(remaining).toHaveLength(0);
  });

  // T6.11: Config clamping — test loadConfig behavior via env vars
  it("clamps heartbeatRunEventsDays to heartbeatRunsDays via loadConfig", async () => {
    const origEventsEnv = process.env.PAPERCLIP_RETENTION_HEARTBEAT_RUN_EVENTS_DAYS;
    const origRunsEnv = process.env.PAPERCLIP_RETENTION_HEARTBEAT_RUNS_DAYS;
    const origBind = process.env.PAPERCLIP_BIND;
    try {
      // Set events > runs to trigger clamping
      process.env.PAPERCLIP_RETENTION_HEARTBEAT_RUN_EVENTS_DAYS = "30";
      process.env.PAPERCLIP_RETENTION_HEARTBEAT_RUNS_DAYS = "10";
      // loadConfig validates bind mode — override to loopback so this test is machine-agnostic
      process.env.PAPERCLIP_BIND = "loopback";
      const { loadConfig } = await import("../config.js");
      const config = loadConfig();
      // AD3: events should be clamped to runs value
      expect(config.retentionHeartbeatRunEventsDays).toBe(10);
      expect(config.retentionHeartbeatRunsDays).toBe(10);
    } finally {
      if (origEventsEnv === undefined) delete process.env.PAPERCLIP_RETENTION_HEARTBEAT_RUN_EVENTS_DAYS;
      else process.env.PAPERCLIP_RETENTION_HEARTBEAT_RUN_EVENTS_DAYS = origEventsEnv;
      if (origRunsEnv === undefined) delete process.env.PAPERCLIP_RETENTION_HEARTBEAT_RUNS_DAYS;
      else process.env.PAPERCLIP_RETENTION_HEARTBEAT_RUNS_DAYS = origRunsEnv;
      if (origBind === undefined) delete process.env.PAPERCLIP_BIND;
      else process.env.PAPERCLIP_BIND = origBind;
    }
  });

  // T6.8: Batch bounding — verify multiple batches when many rows exist
  it("handles batch deletion across multiple iterations", async () => {
    // Insert enough activity_log rows to require multiple batches.
    // DELETE_BATCH_SIZE is 5000, so insert 5001 rows to verify >1 batch.
    // Use activity_log (simplest schema, 30d retention).
    const batchSize = 100;
    const totalRows = 5001;
    for (let i = 0; i < totalRows; i += batchSize) {
      const batch = [];
      for (let j = i; j < Math.min(i + batchSize, totalRows); j++) {
        batch.push({
          companyId,
          actorType: "system" as const,
          actorId: "sys",
          action: "batch-test",
          entityType: "test",
          entityId: `batch-${j}`,
          createdAt: daysAgo(40),
        });
      }
      await db.insert(activityLog).values(batch);
    }

    const config = makeConfig();
    // Should not throw and should delete all rows
    await pruneRunData(db, config);

    const remaining = await db.select().from(activityLog);
    expect(remaining).toHaveLength(0);
  }, 120_000);

  // T6.14: DB-driven file deletion (logRef removed when run deleted)
  it("deletes logRef files when heartbeat_runs are pruned", async () => {
    // Set up a temp PAPERCLIP_HOME so pruneRunData resolves file paths there
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "retention-logref-"));
    const instanceDir = path.join(tmpHome, "instances", "default");
    const runLogsDir = path.join(instanceDir, "data", "run-logs");
    await fs.mkdir(runLogsDir, { recursive: true });

    // Create a log file
    const logFileName = "test-run.ndjson";
    const logFilePath = path.join(runLogsDir, logFileName);
    await fs.writeFile(logFilePath, '{"event":"test"}\n');

    // Insert a run with logRef pointing to this file
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "completed",
      logRef: logFileName,
      createdAt: daysAgo(20),
      finishedAt: daysAgo(20),
    });

    const config = makeConfig();
    await pruneRunData(db, config, { runLogBasePath: runLogsDir });

    // Run should be deleted
    const remainingRuns = await db.select().from(heartbeatRuns);
    expect(remainingRuns).toHaveLength(0);

    // Log file should also be deleted
    let fileExists = true;
    try {
      await fs.access(logFilePath);
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);

    // Clean up temp dir
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  // T6.17: Migration validation (CASCADE + SET NULL end-to-end)
  it("CASCADE and SET NULL work end-to-end via retention prune", async () => {
    const runId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "completed",
      createdAt: daysAgo(20),
      finishedAt: daysAgo(20),
    });
    // CASCADE target
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "log",
      createdAt: daysAgo(1), // recent event, but CASCADE doesn't care
    });
    // SET NULL target
    await db.insert(agentTaskSessions).values({
      id: sessionId,
      companyId,
      agentId,
      adapterType: "local_process",
      taskKey: "migration-test-task",
      lastRunId: runId,
    });

    const config = makeConfig({ retentionHeartbeatRunsDays: 1 });
    await pruneRunData(db, config);

    // Run deleted
    const runs = await db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(0);

    // Events cascade-deleted
    const events = await db.select().from(heartbeatRunEvents);
    expect(events).toHaveLength(0);

    // Session preserved with null lastRunId
    const sessions = await db.select().from(agentTaskSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.lastRunId).toBeNull();
  });
});

// T6.9: Orphan file sweep (uses pruneRunData with PAPERCLIP_HOME override)
describeEmbedded("orphan file sweep", () => {
  let sweepDb!: ReturnType<typeof createDb>;
  let sweepTempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tmpHome: string;

  beforeAll(async () => {
    sweepTempDb = await startEmbeddedPostgresTestDatabase("paperclip-sweep-");
    sweepDb = createDb(sweepTempDb.connectionString);
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "retention-sweep-home-"));

    // Seed required parent rows
    const coId = randomUUID();
    const agId = randomUUID();
    await sweepDb.insert(companies).values({ id: coId, name: "Sweep Co", slug: "sweep-co" });
    await sweepDb.insert(agents).values({
      id: agId,
      companyId: coId,
      name: "sweep-agent",
      slug: "sweep-agent",
      executionAdapterType: "local_process",
    });
  }, 30_000);

  afterAll(async () => {
    await sweepTempDb?.cleanup();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }, 10_000);

  it("deletes old ndjson files, preserves recent ones, and cleans empty dirs", async () => {
    const instanceDir = path.join(tmpHome, "instances", "default");
    const runLogsDir = path.join(instanceDir, "data", "run-logs");
    const subDir = path.join(runLogsDir, "company", "agent");
    await fs.mkdir(subDir, { recursive: true });

    // Create old file (should be deleted — 20 days old, retention is 14 days)
    const oldFile = path.join(subDir, "old-run.ndjson");
    await fs.writeFile(oldFile, "old data\n");
    const oldTime = Date.now() - 20 * 24 * 60 * 60 * 1000;
    await fs.utimes(oldFile, oldTime / 1000, oldTime / 1000);

    // Create recent file (should survive)
    const newFile = path.join(subDir, "new-run.ndjson");
    await fs.writeFile(newFile, "new data\n");

    // Create non-ndjson file (should survive)
    const txtFile = path.join(subDir, "notes.txt");
    await fs.writeFile(txtFile, "notes\n");

    const config = makeConfig();
    await pruneRunData(sweepDb, config, { runLogBasePath: runLogsDir });

    // Old ndjson should be deleted
    let oldExists = true;
    try { await fs.access(oldFile); } catch { oldExists = false; }
    expect(oldExists).toBe(false);

    // Recent ndjson should survive
    const newContent = await fs.readFile(newFile, "utf8");
    expect(newContent).toBe("new data\n");

    // Non-ndjson should survive
    const txtContent = await fs.readFile(txtFile, "utf8");
    expect(txtContent).toBe("notes\n");
  });
});

// T6.15: Symlink safety — exercise actual sweep logic via pruneRunData
describeEmbedded("symlink safety during sweep", () => {
  let symlinkDb!: ReturnType<typeof createDb>;
  let symlinkTempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tmpHome: string;

  beforeAll(async () => {
    symlinkTempDb = await startEmbeddedPostgresTestDatabase("paperclip-symlink-");
    symlinkDb = createDb(symlinkTempDb.connectionString);
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "retention-symlink-home-"));

    const coId = randomUUID();
    const agId = randomUUID();
    await symlinkDb.insert(companies).values({ id: coId, name: "Sym Co", slug: "sym-co" });
    await symlinkDb.insert(agents).values({
      id: agId,
      companyId: coId,
      name: "sym-agent",
      slug: "sym-agent",
      executionAdapterType: "local_process",
    });
  }, 30_000);

  afterAll(async () => {
    await symlinkTempDb?.cleanup();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }, 10_000);

  it("sweep skips symlinked ndjson files and preserves their targets", async () => {
    const instanceDir = path.join(tmpHome, "instances", "default");
    const runLogsDir = path.join(instanceDir, "data", "run-logs");
    await fs.mkdir(runLogsDir, { recursive: true });

    // Create a real file that the symlink points to
    const targetFile = path.join(tmpHome, "secret-data.ndjson");
    await fs.writeFile(targetFile, "should survive\n");

    // Create a symlinked ndjson in run-logs (old mtime to trigger deletion attempt)
    const symlinkFile = path.join(runLogsDir, "link.ndjson");
    await fs.symlink(targetFile, symlinkFile);

    // Create a real old ndjson file as control (should be deleted)
    const realOldFile = path.join(runLogsDir, "real-old.ndjson");
    await fs.writeFile(realOldFile, "old data\n");
    const oldTime = Date.now() - 20 * 24 * 60 * 60 * 1000;
    await fs.utimes(realOldFile, oldTime / 1000, oldTime / 1000);

    const config = makeConfig();
    await pruneRunData(symlinkDb, config, { runLogBasePath: runLogsDir });

    // Real old file should be deleted by sweep
    let realOldExists = true;
    try { await fs.access(realOldFile); } catch { realOldExists = false; }
    expect(realOldExists).toBe(false);

    // Symlink itself should still exist (sweep skips non-regular-file entries)
    const symlinkStat = await fs.lstat(symlinkFile);
    expect(symlinkStat.isSymbolicLink()).toBe(true);

    // Symlink target should survive (sweep should skip symlinks)
    const targetContent = await fs.readFile(targetFile, "utf8");
    expect(targetContent).toBe("should survive\n");
  });
});

// T6.16: In-flight guard — verify the guard branch fires and logs a warning
describe("in-flight guard", () => {
  it("logs warning and skips sweep when sweepInFlight is already true", async () => {
    const { logger } = await import("../middleware/logger.js");
    const warnSpy = vi.spyOn(logger, "warn");

    // Pre-set the in-flight flag to simulate a running sweep
    __testing_setSweepInFlight(true);

    try {
      const config = makeConfig({ retentionIntervalMinutes: 999 });
      // Start retention — the immediate sweep() should see in-flight and warn
      const stop = startRunDataRetention({} as any, config);

      // Give the async sweep() a tick to execute the guard check
      await new Promise((r) => setTimeout(r, 50));

      // The sweep should have hit the guard branch and logged the warning
      expect(warnSpy).toHaveBeenCalledWith(
        "Retention sweep already in flight, skipping",
      );

      stop();
    } finally {
      __testing_setSweepInFlight(false);
      warnSpy.mockRestore();
    }
  });
});

// T6.10: Config backward compatibility — parse schema with NO retention or excludeTables
describe("config backward compatibility", () => {
  it("applies all retention defaults when retention section is absent from config", () => {
    // Parse a config object with no retention key — Zod defaults should fill in
    const parsed = retentionConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.intervalMinutes).toBe(60);
    expect(parsed.heartbeatRunEventsDays).toBe(7);
    expect(parsed.heartbeatRunsDays).toBe(14);
    expect(parsed.agentWakeupRequestsDays).toBe(14);
    expect(parsed.activityLogDays).toBe(30);
    expect(parsed.costEventsDays).toBe(90);
    expect(parsed.financeEventsDays).toBe(90);
    expect(parsed.runLogFilesDays).toBe(14);
  });

  it("applies excludeTables and retention defaults from a pre-upgrade config fixture", () => {
    // Simulates a config file written before retention/excludeTables were added:
    // has $meta, database, logging, server — but NO retention and NO backup.excludeTables.
    // This is the fixture-based backward compatibility test per plan T6.10.
    const preUpgradeFixture = {
      $meta: { version: 1, updatedAt: "2025-01-15T00:00:00Z", source: "onboard" as const },
      database: { mode: "embedded-postgres" as const },
      logging: { mode: "file" as const },
      server: { deploymentMode: "local_trusted" as const },
    };
    const parsed = paperclipConfigSchema.parse(preUpgradeFixture);

    // Backup excludeTables should get the 6-table default
    expect(parsed.database.backup.excludeTables).toEqual([
      "heartbeat_runs",
      "heartbeat_run_events",
      "agent_wakeup_requests",
      "cost_events",
      "activity_log",
      "finance_events",
    ]);

    // Retention section should be fully defaulted
    expect(parsed.retention.enabled).toBe(true);
    expect(parsed.retention.intervalMinutes).toBe(60);
    expect(parsed.retention.heartbeatRunEventsDays).toBe(7);
    expect(parsed.retention.heartbeatRunsDays).toBe(14);
  });
});
