import { applyPendingMigrations } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { registerNativeRunnerEvidenceRetentionWork } from "../services/native-runtime/native-runner-evidence-retention-work.js";
import { noteNativeRunnerEvidence } from "../services/native-runtime/native-runner-evidence-signal.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentTaskSessions,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunnerCheckpoints,
} from "@paperclipai/db";
import { recoveryPostgresSupport as embeddedPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { nativeHarnessBackupExpirationService } from "../services/native-runtime/native-harness-backup-expiration.ts";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { logger } from "../middleware/logger.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_RETENTION_TEST_DATABASE_URL");
const describeEmbeddedPostgres = external || embeddedPostgresSupport.supported ? describe : describe.skip;

if (!external && !embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native harness backup expiration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function exists(target: string) {
  return fs.lstat(target).then(() => true, () => false);
}

describeEmbeddedPostgres("native harness backup expiration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startRecoveryPostgres>> | null = null;
  let stateBase = "";
  const now = new Date();

  beforeAll(async () => {
    if (!external) tempDb = await startRecoveryPostgres("paperclip-native-backup-expiration-");
    if (external) await applyPendingMigrations(external);
    db = createDb(external ?? tempDb!.connectionString);
  }, 20_000);

  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<typeof registerNativeRunnerEvidenceRetentionWork> | undefined;
  let admitted = true;
  afterEach(async () => {
    worker?.unsubscribe(); await coordinator?.stop(); coordinator = undefined; worker = undefined; admitted = true;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(agentTaskSessions);
    await db.delete(nativeRunFinalizations);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    if (stateBase) await fs.rm(stateBase, { recursive: true, force: true });
    stateBase = "";
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedSession(input: {
    issueStatus?: string;
    closedDaysAgo?: number;
    runStatus?: string;
    finalization?: { phase: string; recoveryState?: string | null; leaseOwner?: string | null };
    leaseStatus?: string;
    backupAgeDays?: number;
    cleanupActive?: boolean;
  } = {}) {
    if (!stateBase) stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-durable-sessions-"));
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Backups", issuePrefix: `B${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Coder" }).returning();
    const issueStatus = input.issueStatus ?? "done";
    const closedAt = new Date(now.getTime() - (input.closedDaysAgo ?? 10) * DAY_MS);
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Closed work",
      status: issueStatus,
      completedAt: issueStatus === "done" ? closedAt : null,
      cancelledAt: issueStatus === "cancelled" ? closedAt : null,
    }).returning();
    const sessionId = randomUUID();
    const runStatus = input.runStatus ?? "succeeded";
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: runStatus,
      issueId: issue!.id,
      nativeIssueId: issue!.id,
      nativeSessionId: sessionId,
      finishedAt: ["queued", "running"].includes(runStatus) ? null : closedAt,
    }).returning();
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId: agent!.id,
      adapterType: "paperclip_runner",
      taskKey: issue!.id,
      sessionParamsJson: { sessionId },
      lastRunId: run!.id,
    });
    if (input.finalization) {
      await db.insert(nativeRunFinalizations).values({
        runId: run!.id,
        companyId,
        issueId: issue!.id,
        phase: input.finalization.phase,
        recoveryState: input.finalization.recoveryState ?? null,
        leaseOwner: input.finalization.leaseOwner ?? null,
      });
    }
    const scope = createHash("sha256").update(randomUUID()).digest("hex");
    const root = path.join(stateBase, scope);
    const current = path.join(root, "failover-backups", "current");
    await fs.mkdir(path.join(root, "control-plane"), { recursive: true });
    await fs.writeFile(
      path.join(root, "control-plane", "control-plane-state.json"),
      JSON.stringify({ identity: { runId: run!.id, normalizedSessionId: sessionId } }),
    );
    await fs.mkdir(path.join(current, "codex-home"), { recursive: true });
    await fs.writeFile(path.join(current, "codex-home", "history.jsonl"), "x".repeat(64 * 1024));
    await fs.writeFile(path.join(current, "manifest.json"), "{}");
    const backupAt = new Date(now.getTime() - (input.backupAgeDays ?? 9) * DAY_MS);
    await fs.utimes(current, backupAt, backupAt);
    if (input.cleanupActive) await fs.writeFile(path.join(root, "cleanup-activation.json"), "{}");
    if (input.leaseStatus) {
      await db.insert(environmentLeases).values({
        companyId,
        status: input.leaseStatus,
        metadata: { nativeHarnessBackup: { sessionScopeSha256: scope } },
      });
    }
    return { companyId, agentId: agent!.id, issueId: issue!.id, runId: run!.id, sessionId, scope, root, current };
  }

  function service() {
    return nativeHarnessBackupExpirationService(db, {
      stateBase,
      closedForDays: 7,
      now,
      isSessionBusy: () => false,
    });
  }

  async function taskSessionCount(agentId: string) {
    return (await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId))).length;
  }

  async function seedCheckpoint(session: Awaited<ReturnType<typeof seedSession>>) {
    await db.insert(nativeRunnerCheckpoints).values(["header", "cursor", "event:1"].map(part => ({
      companyId: session.companyId, issueId: session.issueId, runId: session.runId, part, material: { encrypted: true },
    })));
  }

  it.each([false, true])("adds no periodic database work after startup (retained history: %s)", async retained => {
    if (retained) {
      const session = await seedSession({ finalization: { phase: "committed" } });
      await seedCheckpoint(session); // Saved resume pointer deliberately protects it.
      await fs.rm(stateBase, { recursive: true, force: true });
    } else {
      stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "empty-checkpoint-retention-"));
    }
    const expiration = service();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    const select = vi.spyOn(db, "select");
    try {
      await expiration.registerCheckpointExpiration(coordinator).ready;
      expect(select).toHaveBeenCalled();
      const reads = select.mock.calls.length;
      expect(coordinator.nextWakeAt()).toBeNull();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
      // The unchanged hourly filesystem sweep must not enumerate DB checkpoints.
      for (let hour = 0; hour < 3; hour++) await expiration.tick();
      expect(select).toHaveBeenCalledTimes(reads);
      expect(coordinator.nextWakeAt()).toBeNull();
    } finally {
      await coordinator.stop();
      select.mockRestore();
      vi.useRealTimers();
    }
    if (retained) {
      expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(3);
      await db.delete(agentTaskSessions);
      const nextStartup = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: vi.fn() });
      try {
        await service().registerCheckpointExpiration(nextStartup).ready;
        expect(await db.select().from(nativeRunnerCheckpoints)).toEqual([]);
        expect(nextStartup.nextWakeAt()).toBeNull();
      } finally { await nextStartup.stop(); }
    }
  });

  it("preserves startup expiration across drain without querying while paused", async () => {
    const session = await seedSession({ finalization: { phase: "committed" } });
    await seedCheckpoint(session);
    await db.delete(agentTaskSessions);
    let draining = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const select = vi.spyOn(db, "select");
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true, onError });
    try {
      await service().registerCheckpointExpiration(coordinator).ready;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(select).not.toHaveBeenCalled();
      draining = false;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
      await coordinator.stop(); // Await the DB transaction before asserting.
      expect(onError).not.toHaveBeenCalled();
      expect(await db.select().from(nativeRunnerCheckpoints)).toEqual([]);
    } finally {
      await coordinator.stop();
      select.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries a failed checkpoint from an earlier page before startup cleanup goes quiet", async () => {
    for (let index = 0; index < 2; index++) {
      const session = await seedSession({ finalization: { phase: "committed" } });
      await seedCheckpoint(session);
    }
    await db.delete(agentTaskSessions);
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("temporary retention failure"));
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: vi.fn() });
    try {
      const expiration = nativeHarnessBackupExpirationService(db, { now, maxEntries: 1 });
      await expiration.registerCheckpointExpiration(coordinator).ready;
      await vi.waitFor(async () => {
        expect(await db.select().from(nativeRunnerCheckpoints)).toEqual([]);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
    } finally {
      await coordinator.stop();
      transaction.mockRestore();
    }
  });

  it.each(["query", "transaction"] as const)("bounds persistent startup %s failures and becomes quiet until the next startup", async fault => {
    const session = await seedSession({ finalization: { phase: "committed" } });
    await seedCheckpoint(session);
    await db.delete(agentTaskSessions);
    const failure = fault === "query"
      ? vi.spyOn(db, "select").mockImplementation(() => { throw new Error("retention candidate query unavailable"); })
      : vi.spyOn(db, "transaction").mockRejectedValue(new Error("retention transaction unavailable"));
    const warning = vi.spyOn(logger, "warn");
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: vi.fn() });
    try {
      await service().registerCheckpointExpiration(coordinator).ready;
      await vi.waitFor(() => {
        // No scheduled deadline can also mean a retry is currently running.
        // Wait for the owner's final deferral before asserting quiet time.
        expect(warning).toHaveBeenCalledWith(expect.objectContaining({ failedPasses: 3 }),
          "startup checkpoint expiration retries exhausted; retained checkpoints deferred to next startup");
        expect(failure).toHaveBeenCalledTimes(3);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      const attempts = failure.mock.calls.length;
      expect(attempts).toBe(3);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
      expect(failure).toHaveBeenCalledTimes(attempts);
    } finally {
      await coordinator.stop(); failure.mockRestore(); warning.mockRestore(); vi.useRealTimers();
    }
    expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(3);
    const nextStartup = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: vi.fn() });
    try {
      await service().registerCheckpointExpiration(nextStartup).ready;
      expect(await db.select().from(nativeRunnerCheckpoints)).toEqual([]);
      expect(nextStartup.nextWakeAt()).toBeNull();
    } finally { await nextStartup.stop(); }
  });

  it("expires unreferenced settled checkpoints even with an empty controller disk and fences old writers", async () => {
    const session = await seedSession({ finalization: { phase: "committed" } });
    await seedCheckpoint(session);
    await db.delete(agentTaskSessions);
    await fs.rm(stateBase, { recursive: true, force: true });
    expect(await service().tickCheckpoints()).toMatchObject({ expiredCheckpoints: 1, checkpointCandidates: 1, failed: 0 });
    expect(await db.select().from(nativeRunnerCheckpoints)).toEqual([]);
    const [authority] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, session.runId));
    expect(authority?.controllerGeneration).toBe(1);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  it.each(["resume", "lease", "lease_stamp", "recovery", "running", "recent", "open", "execution", "dry_run"])(
    "preserves a checkpoint protected by %s without its controller disk", async protection => {
      const session = await seedSession({ finalization: { phase: "committed" } });
      await seedCheckpoint(session);
      await fs.rm(stateBase, { recursive: true, force: true });
      if (protection !== "resume") await db.delete(agentTaskSessions);
      if (protection === "lease") await db.insert(environmentLeases).values({
        companyId: session.companyId, issueId: session.issueId, status: "retained",
      });
      if (protection === "lease_stamp") await db.insert(environmentLeases).values({
        companyId: session.companyId, status: "retained",
        metadata: { nativeHarnessBackup: { normalizedSessionId: session.sessionId } },
      });
      if (protection === "recovery") await db.update(nativeRunFinalizations).set({ recoveryState: "pending" });
      if (protection === "running") await db.update(heartbeatRuns).set({ status: "running" });
      if (protection === "recent") await db.update(issues).set({ completedAt: now });
      if (protection === "open") await db.update(issues).set({ status: "in_progress" });
      if (protection === "execution") await db.update(issues).set({ executionRunId: session.runId });
      expect(await service().tickCheckpoints({ dryRun: protection === "dry_run" })).toMatchObject({ expiredCheckpoints: 0, failed: 0 });
      expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(3);
      const [authority] = await db.select().from(nativeRunFinalizations);
      expect(authority?.controllerGeneration).toBe(0);
      // Break the issue/run reference cycle before the shared teardown.
      if (protection === "execution") await db.update(issues).set({ executionRunId: null });
    },
  );

  it("continues checkpoint expiration past retained sessions within bounded pages", async () => {
    for (let index = 0; index < 3; index++) {
      const session = await seedSession({ finalization: { phase: "committed" } });
      await seedCheckpoint(session);
    }
    await fs.rm(stateBase, { recursive: true, force: true });
    const expiration = service();
    expect(await expiration.tickCheckpoints({ maxEntries: 2 })).toMatchObject({ expiredCheckpoints: 0, truncated: true });
    expect(await expiration.tickCheckpoints({ maxEntries: 2 })).toMatchObject({ expiredCheckpoints: 0, truncated: false });
    await db.delete(agentTaskSessions);
    expect(await expiration.tickCheckpoints({ maxEntries: 2 })).toMatchObject({ expiredCheckpoints: 2, truncated: true });
    expect(await expiration.tickCheckpoints({ maxEntries: 2 })).toMatchObject({ expiredCheckpoints: 1, truncated: false });
  });

  it("expires the backup of a session whose issue closed before the window and clears its resume pointer", async () => {
    const session = await seedSession();
    const result = await service().tick();

    expect(result).toMatchObject({ checked: 1, candidates: 1, expired: 1, clearedTaskSessions: 1, failed: 0 });
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(await exists(session.current)).toBe(false);
    expect(await exists(path.join(session.root, "control-plane", "control-plane-state.json"))).toBe(true);
    expect(await fs.readdir(path.join(session.root, "failover-backups"))).toEqual([]);
    expect(await taskSessionCount(session.agentId)).toBe(0);
  });

  it("expires sessions of cancelled issues", async () => {
    const session = await seedSession({ issueStatus: "cancelled" });
    expect(await service().tick()).toMatchObject({ expired: 1 });
    expect(await exists(session.current)).toBe(false);
  });

  it.each([
    ["issue_open", { issueStatus: "in_progress" }],
    ["recently_closed", { closedDaysAgo: 2 }],
    ["live_run", { runStatus: "running" }],
    ["pending_finalization", { finalization: { phase: "settling" } }],
    ["pending_finalization", { finalization: { phase: "observed", recoveryState: "resuming_session" } }],
    ["pending_finalization", { finalization: { phase: "committed", leaseOwner: "controller" } }],
    ["live_lease", { leaseStatus: "released" }],
    ["recent_backup", { backupAgeDays: 1 }],
    ["cleanup_active", { cleanupActive: true }],
  ] as const)("keeps the backup when %s", async (reason, input) => {
    const session = await seedSession(input);
    const result = await service().tick();

    expect(result).toMatchObject({ checked: 1, candidates: 0, expired: 0, failed: 0 });
    expect(result.skipped[reason]).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("keeps the backup when the session's control-plane state is too large to read", async () => {
    const session = await seedSession();
    const statePath = path.join(session.root, "control-plane", "control-plane-state.json");
    await fs.writeFile(statePath, `${await fs.readFile(statePath, "utf8")}${" ".repeat(5 * 1024 * 1024)}`);

    const result = await service().tick();

    expect(result.skipped.identity_unknown).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("keeps the backup of a session that is executing in this process", async () => {
    const session = await seedSession();
    const result = await nativeHarnessBackupExpirationService(db, {
      stateBase,
      now,
      isSessionBusy: (scope) => scope === session.scope,
    }).tick();

    expect(result.skipped.session_active).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("settled finalizations and expired leases do not block expiry", async () => {
    const session = await seedSession({ finalization: { phase: "committed" }, leaseStatus: "expired" });
    expect(await service().tick()).toMatchObject({ expired: 1 });
    expect(await exists(session.current)).toBe(false);
  });

  it.each([
    ["committed", "resuming_session"],
    ["terminal_failure", "blocked"],
  ] as const)("stale %s recovery state %s does not block expiry once the issue is closed", async (phase, recoveryState) => {
    const session = await seedSession({ finalization: { phase, recoveryState } });
    expect(await service().tick()).toMatchObject({ expired: 1 });
    expect(await exists(session.current)).toBe(false);
  });

  it("reports candidates without deleting anything in dry run", async () => {
    const session = await seedSession();
    const result = await nativeHarnessBackupExpirationService(db, {
      stateBase,
      now,
      dryRun: true,
      isSessionBusy: () => false,
    }).tick();

    expect(result).toMatchObject({ candidates: 1, expired: 0, clearedTaskSessions: 0 });
    expect(result.candidateBytes).toBeGreaterThan(0);
    expect(await exists(session.current)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("continues across ticks when a batch is bounded", async () => {
    const sessions = [await seedSession(), await seedSession(), await seedSession()];
    const expiration = nativeHarnessBackupExpirationService(db, {
      stateBase,
      now,
      maxEntries: 2,
      isSessionBusy: () => false,
    });

    expect(await expiration.tick()).toMatchObject({ checked: 2, expired: 2, truncated: true });
    expect(await expiration.tick()).toMatchObject({ checked: 1, expired: 1, truncated: false });
    for (const session of sessions) expect(await exists(session.current)).toBe(false);
  });

  it("uses the configured clock for the closed window", async () => {
    const session = await seedSession({ closedDaysAgo: 8, backupAgeDays: 20 });
    const early = nativeHarnessBackupExpirationService(db, {
      stateBase,
      now: new Date(now.getTime() - 2 * DAY_MS),
      isSessionBusy: () => false,
    });
    expect((await early.tick()).skipped.recently_closed).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await service().tick()).toMatchObject({ expired: 1 });
  });

  it("restores a backup whose expiry stopped before its final check", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const retiring = path.join(session.root, "failover-backups", `.retiring-${randomUUID()}`);
    await fs.rename(session.current, retiring);

    await service().tick();

    expect(await exists(retiring)).toBe(false);
    expect(await exists(path.join(session.current, "manifest.json"))).toBe(true);
  });

  it("drops an unconfirmed retired backup once a newer backup exists", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const retiring = path.join(session.root, "failover-backups", `.retiring-${randomUUID()}`);
    await fs.mkdir(path.join(retiring, "codex-home"), { recursive: true });

    await service().tick();

    expect(await exists(retiring)).toBe(false);
    expect(await exists(path.join(session.current, "manifest.json"))).toBe(true);
  });

  it("finishes removing a backup left over from an interrupted expiry", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const leftover = path.join(session.root, "failover-backups", `.expired-${randomUUID()}`);
    await fs.mkdir(path.join(leftover, "codex-home"), { recursive: true });

    await service().tick();

    expect(await exists(leftover)).toBe(false);
    expect(await exists(session.current)).toBe(true);
  });
  async function seedArchive(root: string, input: { stampedDaysAgo?: number; mtimeDaysAgo?: number; name?: string } = {}) {
    const stampedAt = now.getTime() - (input.stampedDaysAgo ?? 10) * DAY_MS;
    const archive = path.join(root, "continuity-breaks", input.name ?? `${stampedAt}-${randomUUID()}`);
    await fs.mkdir(path.join(archive, "codex-home"), { recursive: true });
    await fs.writeFile(path.join(archive, "codex-home", "history.jsonl"), "x".repeat(64 * 1024));
    const mtime = new Date(now.getTime() - (input.mtimeDaysAgo ?? input.stampedDaysAgo ?? 10) * DAY_MS);
    await fs.utimes(archive, mtime, mtime);
    return archive;
  }

  async function seedQuarantine(
    scope: string,
    input: { stampedDaysAgo?: number; name?: string } = {},
  ) {
    if (!stateBase) stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-durable-sessions-"));
    const stampedAt = now.getTime() - (input.stampedDaysAgo ?? 10) * DAY_MS;
    const entry = path.join(
      stateBase,
      "quarantine",
      input.name ?? `${scope}.identity_indeterminate.${stampedAt}.4242.${randomUUID()}`,
    );
    await fs.mkdir(path.join(entry, "control-plane"), { recursive: true });
    await fs.writeFile(path.join(entry, "history.jsonl"), "x".repeat(64 * 1024));
    return entry;
  }

  function evidenceService(overrides: Parameters<typeof nativeHarnessBackupExpirationService>[1] = {}) {
    return nativeHarnessBackupExpirationService(db, {
      stateBase,
      now,
      evidenceRetentionDays: 7,
      isSessionBusy: () => false,
      ...overrides,
    });
  }

  async function emptyStateBase() {
    if (!stateBase) stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-durable-sessions-"));
    return createHash("sha256").update(randomUUID()).digest("hex");
  }

  async function startEvidence(options: Parameters<typeof nativeHarnessBackupExpirationService>[1] = {}) {
    if (!vi.isFakeTimers()) {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      vi.setSystemTime(now);
    }
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => true,
      onError: error => { throw error; } });
    worker = registerNativeRunnerEvidenceRetentionWork(coordinator, db, { stateBase, isSessionBusy: () => false, ...options }, () => admitted);
    await worker.ready;
  }
  async function settled(deadline: number | null = null) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBe(deadline);
    }, { timeout: 5000 });
  }
  async function quiet(ms = 3 * 60 * 60_000) {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction"), directories = vi.spyOn(fs, "readdir");
    await vi.advanceTimersByTimeAsync(ms);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(directories).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); directories.mockRestore();
  }

  it("leaves empty evidence and retained backups quiet without invoking backup SQL", async () => {
    const session = await seedSession();
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    await startEvidence(); await settled(); expect(await exists(session.current)).toBe(true);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); await quiet();
  });

  it("reconstructs and replaces the saved evidence deadline after a publication signal", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const first = await seedArchive(session.root, { stampedDaysAgo: 2 });
    const firstDeadline = now.getTime() + 5 * DAY_MS + 1;
    await startEvidence(); await settled(firstDeadline); await quiet();
    const writtenAt = Date.now();
    const next = await seedArchive(session.root, { name: `${writtenAt}-${randomUUID()}` });
    noteNativeRunnerEvidence(writtenAt);
    await settled(firstDeadline);
    await vi.advanceTimersByTimeAsync(firstDeadline - Date.now());
    await settled(writtenAt + 7 * DAY_MS + 1); expect(await exists(first)).toBe(false);
    await vi.advanceTimersByTimeAsync(writtenAt + 7 * DAY_MS + 1 - Date.now()); await settled();
    expect(await exists(next)).toBe(false); expect(await exists(session.current)).toBe(true); await quiet();
  });

  it.each(["session root", "archive directory"])("preserves an evidence inspection failure at %s until its concrete retry succeeds", async location => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root);
    const original = fs.lstat;
    const denied = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (String(args[0]) === (location === "session root" ? session.root : path.join(session.root, "continuity-breaks"))) throw Object.assign(new Error("unavailable"), { code: "EACCES" });
      return original(...args);
    });
    await startEvidence(); expect(coordinator!.nextWakeAt()).not.toBeNull();
    const retryAt = coordinator!.nextWakeAt()!; expect(await exists(archive)).toBe(true);
    denied.mockRestore(); await quiet(5000);
    await vi.advanceTimersByTimeAsync(retryAt - Date.now()); await settled();
    expect(await exists(archive)).toBe(false); await quiet();
  });

  it("retries a busy evidence obligation and disarms after the session releases it", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root); let busy = true;
    await startEvidence({ isSessionBusy: () => busy });
    const retryAt = coordinator!.nextWakeAt()!; expect(retryAt - Date.now()).toBeGreaterThanOrEqual(60 * 60_000);
    await quiet(5000); busy = false;
    await vi.advanceTimersByTimeAsync(retryAt - Date.now()); await settled();
    expect(await exists(archive)).toBe(false); await quiet();
  });

  it("retains the first publication during drain and cleans up on resume", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    await startEvidence(); await settled(); admitted = false;
    const archive = await seedArchive(session.root);
    noteNativeRunnerEvidence(now.getTime() - 10 * DAY_MS);
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); });
    await quiet(60_000); expect(await exists(archive)).toBe(true);
    admitted = true; await settled(); expect(await exists(archive)).toBe(false); await quiet();
  });

  it("reconstructs the same retained deadline after restart", async () => {
    const scope = await emptyStateBase(); await seedQuarantine(scope, { stampedDaysAgo: 6 });
    const deadline = now.getTime() + DAY_MS + 1;
    await startEvidence(); await settled(deadline);
    worker!.unsubscribe(); await coordinator!.stop();
    await startEvidence(); await settled(deadline); await quiet(60_000);
    expect(coordinator!.nextWakeAt()).toBe(deadline);
  });

  it("backs off a failed state-base inspection and lets publication reactivate it", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root), read = fs.readdir;
    const denied = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === stateBase) throw Object.assign(new Error("state base unavailable"), { code: "EACCES" });
      return read(...args);
    });
    await startEvidence(); expect(coordinator!.nextWakeAt()! - Date.now()).toBeGreaterThanOrEqual(60 * 60_000);
    denied.mockRestore(); await quiet(5 * 60_000); expect(await exists(archive)).toBe(true);
    noteNativeRunnerEvidence(now.getTime() - 10 * DAY_MS);
    await settled(); expect(await exists(archive)).toBe(false); await quiet();
  });

  it("lets healthy saved expiry preempt a long-busy evidence retry", async () => {
    const busy = await seedSession({ issueStatus: "in_progress" }), healthy = await seedSession({ issueStatus: "in_progress" });
    const held = await seedArchive(busy.root);
    const dueAt = now.getTime() + 10_001;
    const available = await seedArchive(healthy.root, { name: `${dueAt - 7 * DAY_MS - 1}-${randomUUID()}` });
    await startEvidence({ isSessionBusy: scope => scope === busy.scope }); await settled(dueAt);
    await vi.advanceTimersByTimeAsync(dueAt - Date.now());
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(100);
      expect(await exists(available)).toBe(false);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()! - Date.now()).toBeGreaterThan(59 * 60_000);
    });
    expect(await exists(held)).toBe(true);
    await quiet(60_000);
  });

  it("reports reclaimed evidence bytes and dry-run mode", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root); const reported = vi.spyOn(logger, "info");
    await startEvidence(); await settled();
    expect(reported.mock.calls).toEqual(expect.arrayContaining([[expect.objectContaining({ evidenceCandidates: 1,
      evidenceRemoved: 1, evidenceReclaimedBytes: expect.any(Number), dryRun: false }), "native runner evidence retention"]]));
    expect(await exists(archive)).toBe(false); await quiet();
  });

  it("schedules publication at the first removable instant after its retention boundary", async () => {
    const scope = await emptyStateBase(); await startEvidence(); await settled(); await quiet();
    const writtenAt = Date.now();
    await seedQuarantine(scope, { name: `${scope}.identity_indeterminate.${writtenAt}.4242.${randomUUID()}` });
    noteNativeRunnerEvidence(writtenAt); await settled(writtenAt + 7 * DAY_MS + 1);
  });

  it("uses bounded continuations without recounting an evidence session forever", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archives = [await seedArchive(session.root), await seedArchive(session.root)];
    const quarantine = await seedQuarantine(session.scope);
    await startEvidence({ maxEntries: 1 }); await settled();
    for (const archive of [...archives, quarantine]) expect(await exists(archive)).toBe(false);
    await quiet();
  });

  it("removes continuity archives older than the retention window and keeps recent ones", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const old = await seedArchive(session.root, { stampedDaysAgo: 9 });
    const recent = await seedArchive(session.root, { stampedDaysAgo: 2 });

    const result = await evidenceService().tick();

    expect(result).toMatchObject({ evidenceCandidates: 1, evidenceRemoved: 1, failed: 0 });
    expect(result.evidenceReclaimedBytes).toBeGreaterThan(0);
    expect(result.skipped.recent_evidence).toBe(1);
    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(session.current)).toBe(true);
  });

  it("removes the continuity-breaks folder once its archives are gone", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    await seedArchive(session.root);

    expect(await evidenceService().tick()).toMatchObject({ evidenceRemoved: 1 });
    expect(await exists(path.join(session.root, "continuity-breaks"))).toBe(false);
  });

  it("ages a continuity archive by its name and falls back to mtime for a future stamp", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const stampedRecently = await seedArchive(session.root, { stampedDaysAgo: 1, mtimeDaysAgo: 30 });
    const futureStamp = await seedArchive(session.root, {
      name: `${now.getTime() + DAY_MS}-${randomUUID()}`,
      mtimeDaysAgo: 30,
    });
    const futureRecent = await seedArchive(session.root, {
      name: `${now.getTime() + 2 * DAY_MS}-${randomUUID()}`,
      mtimeDaysAgo: 1,
    });

    expect(await evidenceService().tick()).toMatchObject({ evidenceRemoved: 1 });
    expect(await exists(stampedRecently)).toBe(true);
    expect(await exists(futureStamp)).toBe(false);
    expect(await exists(futureRecent)).toBe(true);
  });

  it("ignores folders that are not continuity archives", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const other = await seedArchive(session.root, { name: "notes", stampedDaysAgo: 30 });

    expect(await evidenceService().tick()).toMatchObject({ evidenceCandidates: 0 });
    expect(await exists(other)).toBe(true);
  });

  it("keeps the evidence of a session that is executing in this process", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root);
    const quarantine = await seedQuarantine(session.scope);

    const result = await evidenceService({ isSessionBusy: (scope) => scope === session.scope }).tick();

    expect(result).toMatchObject({ evidenceCandidates: 0, evidenceRemoved: 0 });
    expect(result.skipped.session_active).toBe(3);
    expect(await exists(archive)).toBe(true);
    expect(await exists(quarantine)).toBe(true);
  });

  it("keeps evidence when its session starts while the removal is being prepared", async () => {
    const scope = await emptyStateBase();
    const root = path.join(stateBase, scope);
    const archive = await seedArchive(root);
    let checks = 0;

    const result = await evidenceService({ isSessionBusy: () => ++checks > 1 }).tick();

    expect(result).toMatchObject({ evidenceCandidates: 1, evidenceRemoved: 0 });
    expect(result.skipped.session_active).toBe(1);
    expect(await exists(archive)).toBe(true);
  });

  it("reports evidence without deleting it in dry run", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root);
    const quarantine = await seedQuarantine(session.scope);
    const leftover = path.join(session.root, "continuity-breaks", `.expired-${randomUUID()}`);
    await fs.mkdir(leftover);

    const result = await evidenceService({ dryRun: true }).tick();

    expect(result).toMatchObject({ evidenceCandidates: 2, evidenceRemoved: 0, evidenceReclaimedBytes: 0 });
    expect(result.evidenceCandidateBytes).toBeGreaterThan(0);
    expect(await exists(archive)).toBe(true);
    expect(await exists(quarantine)).toBe(true);
    expect(await exists(leftover)).toBe(true);
  });

  it("skips symlinked evidence without following it", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-evidence-outside-"));
    try {
      await fs.writeFile(path.join(outside, "keep.txt"), "keep");
      const stampedAt = now.getTime() - 10 * DAY_MS;
      await fs.mkdir(path.join(session.root, "continuity-breaks"), { recursive: true });
      const archiveLink = path.join(session.root, "continuity-breaks", `${stampedAt}-${randomUUID()}`);
      await fs.symlink(outside, archiveLink);
      await fs.mkdir(path.join(stateBase, "quarantine"), { recursive: true });
      const quarantineLink = path.join(
        stateBase,
        "quarantine",
        `${session.scope}.identity_indeterminate.${stampedAt}.4242.${randomUUID()}`,
      );
      await fs.symlink(outside, quarantineLink);

      const result = await evidenceService().tick();

      expect(result).toMatchObject({ evidenceCandidates: 0, evidenceRemoved: 0 });
      expect(result.skipped.unsafe_path).toBe(2);
      expect(await exists(archiveLink)).toBe(true);
      expect(await exists(quarantineLink)).toBe(true);
      expect(await exists(path.join(outside, "keep.txt"))).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("skips symlinked evidence folders without following them", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-evidence-outside-"));
    try {
      const stampedAt = now.getTime() - 10 * DAY_MS;
      const inside = path.join(outside, `${stampedAt}-${randomUUID()}`);
      await fs.mkdir(inside);
      await fs.utimes(inside, new Date(stampedAt), new Date(stampedAt));
      await fs.symlink(outside, path.join(session.root, "continuity-breaks"));
      await fs.symlink(outside, path.join(stateBase, "quarantine"));

      const result = await evidenceService().tick();

      expect(result).toMatchObject({ evidenceCandidates: 0, evidenceRemoved: 0 });
      expect(result.skipped.unsafe_path).toBe(2);
      expect(await exists(inside)).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("removes quarantine entries older than the retention window and keeps recent ones", async () => {
    const scope = await emptyStateBase();
    const old = await seedQuarantine(scope, { stampedDaysAgo: 9 });
    const recent = await seedQuarantine(scope, { stampedDaysAgo: 2 });

    const result = await evidenceService().tick();

    expect(result).toMatchObject({ evidenceCandidates: 1, evidenceRemoved: 1, failed: 0 });
    expect(result.skipped.recent_evidence).toBe(1);
    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await fs.readdir(path.join(stateBase, "quarantine"))).toEqual([path.basename(recent)]);
  });

  it("keeps cleanup source archives in quarantine", async () => {
    const scope = await emptyStateBase();
    const entry = await seedQuarantine(scope, { name: `${scope}.identity_indeterminate.cleanup.${randomUUID()}` });
    const old = new Date(now.getTime() - 30 * DAY_MS);
    await fs.utimes(entry, old, old);

    const result = await evidenceService().tick();

    expect(result.evidenceCandidates).toBe(0);
    expect(result.skipped.cleanup_archive).toBe(1);
    expect(await exists(entry)).toBe(true);
  });

  it("finishes removing evidence left over from an interrupted removal", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root, { stampedDaysAgo: 1 });
    const leftover = path.join(session.root, "continuity-breaks", `.expired-${randomUUID()}`);
    await fs.mkdir(path.join(leftover, "codex-home"), { recursive: true });
    const quarantineLeftover = path.join(stateBase, "quarantine", `.expired-${randomUUID()}`);
    await fs.mkdir(quarantineLeftover, { recursive: true });

    await evidenceService().tick();

    expect(await exists(leftover)).toBe(false);
    expect(await exists(quarantineLeftover)).toBe(false);
    expect(await exists(archive)).toBe(true);
  });

  it.each([false, true])("pages evidence removals across ticks (dry run %s)", async (dryRun) => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archives = [await seedArchive(session.root), await seedArchive(session.root), await seedArchive(session.root)];
    const quarantine = await seedQuarantine(session.scope);
    const retention = evidenceService({ dryRun, maxRemovals: 2 });

    const results = [];
    for (let i = 0; i < 4; i++) {
      const result = await retention.tick();
      results.push(result);
      if (!result.truncated) break;
    }

    expect(results.map((result) => result.evidenceCandidates)).toEqual([2, 2]);
    expect(results.map((result) => result.truncated)).toEqual([true, false]);
    for (const archive of archives) expect(await exists(archive)).toBe(dryRun);
    expect(await exists(quarantine)).toBe(dryRun);
  });

  it("does not recount a session's backup when its archives resume on the next tick", async () => {
    const session = await seedSession();
    await seedArchive(session.root);
    await seedArchive(session.root);
    const retention = evidenceService({ dryRun: true, maxRemovals: 2 });

    const first = await retention.tick();
    const second = await retention.tick();

    expect(first).toMatchObject({ candidates: 1, evidenceCandidates: 1, truncated: true });
    expect(second).toMatchObject({ candidates: 0, evidenceCandidates: 1, truncated: false });
  });
  it("removes old quarantine entries even when their session's issue is still open", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const entry = await seedQuarantine(session.scope);
    await fs.cp(path.join(session.root, "control-plane"), path.join(entry, "control-plane"), { recursive: true });

    expect(await evidenceService().tick()).toMatchObject({ evidenceRemoved: 1 });
    expect(await exists(entry)).toBe(false);
  });

  it("stays quiet until retained evidence is due and wakes when new evidence is written", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const recent = await seedArchive(session.root, { stampedDaysAgo: 2 });
    const retention = evidenceService();
    const at = (days: number) => ({ now: new Date(now.getTime() + days * DAY_MS) });

    expect((await retention.tick()).skipped.recent_evidence).toBe(1);
    expect((await retention.tick(at(4))).skipped.recent_evidence).toBeUndefined();
    expect(await retention.tick(at(6))).toMatchObject({ evidenceRemoved: 1 });
    expect(await exists(recent)).toBe(false);

    const written = await seedArchive(session.root, { stampedDaysAgo: 0 });
    expect(await retention.tick(at(8))).toMatchObject({ evidenceCandidates: 0 });
    retention.noteEvidence(now.getTime());
    expect(await retention.tick(at(8))).toMatchObject({ evidenceRemoved: 1 });
    expect(await exists(written)).toBe(false);
  });

  it("retries evidence of a busy session on the next tick", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const archive = await seedArchive(session.root);
    let busy = true;
    const retention = evidenceService({ isSessionBusy: () => busy });

    expect(await retention.tick()).toMatchObject({ evidenceRemoved: 0 });
    busy = false;
    expect(await retention.tick()).toMatchObject({ evidenceRemoved: 1 });
    expect(await exists(archive)).toBe(false);
  });

  it("reports dry-run evidence once until new evidence is written", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    await seedArchive(session.root);
    const retention = evidenceService({ dryRun: true });

    expect(await retention.tick()).toMatchObject({ evidenceCandidates: 1 });
    expect(await retention.tick()).toMatchObject({ evidenceCandidates: 0 });
    retention.noteEvidence(now.getTime());
    expect(await retention.tick({ now: new Date(now.getTime() + 7 * DAY_MS) })).toMatchObject({ evidenceCandidates: 1 });
  });

  it("counts inspected archives and leftovers against the entry limit", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const archives = [
      await seedArchive(session.root, { stampedDaysAgo: 1 }),
      await seedArchive(session.root, { stampedDaysAgo: 2 }),
      await seedArchive(session.root, { stampedDaysAgo: 3 }),
    ];
    const leftovers = [randomUUID(), randomUUID()].map((id) => path.join(session.root, "continuity-breaks", `.expired-${id}`));
    for (const leftover of leftovers) await fs.mkdir(leftover);
    const retention = evidenceService({ maxEntries: 2 });

    const first = await retention.tick();
    expect(first).toMatchObject({ checked: 2, truncated: true });
    expect(first.skipped.recent_evidence).toBeUndefined();
    expect((await fs.readdir(path.join(session.root, "continuity-breaks"))).filter((name) => name.startsWith(".expired-"))).toHaveLength(1);

    const results = [first];
    for (let i = 0; i < 6 && results.at(-1)!.truncated; i++) results.push(await retention.tick());
    expect(results.at(-1)!.truncated).toBe(false);
    expect(results.every((result) => result.checked <= 2)).toBe(true);
    expect(results.every((result) => (result.skipped.recent_evidence ?? 0) <= 2)).toBe(true);
    expect(results.reduce((sum, result) => sum + (result.skipped.recent_evidence ?? 0), 0)).toBe(3);
    for (const leftover of leftovers) expect(await exists(leftover)).toBe(false);
    for (const archive of archives) expect(await exists(archive)).toBe(true);
  });

  it("stops removing leftovers once the sweep must stop", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    await fs.mkdir(path.join(session.root, "continuity-breaks"));
    const leftover = path.join(session.root, "continuity-breaks", `.expired-${randomUUID()}`);
    await fs.mkdir(leftover);
    let calls = 0;

    const retention = evidenceService({ shouldContinue: () => ++calls !== 2 });

    await retention.tick();
    expect(await exists(leftover)).toBe(true);
    await retention.tick();
    expect(await exists(leftover)).toBe(false);
  });

  it("keeps a due evidence pass pending when drain stops it before any session", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const archive = await seedArchive(session.root);
    let draining = true;
    const retention = evidenceService({ shouldContinue: () => !draining });

    expect(await retention.tick()).toMatchObject({ checked: 0, truncated: true });
    draining = false;
    expect(await retention.tick()).toMatchObject({ evidenceRemoved: 1 });
    expect(await exists(archive)).toBe(false);
  });

  it("finishes one-entry batches without recounting a resumed session", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const archives = [await seedArchive(session.root), await seedArchive(session.root)];
    const quarantine = await seedQuarantine(session.scope);
    const retention = evidenceService({ maxEntries: 1 });

    const results = [];
    for (let i = 0; i < 8; i++) {
      results.push(await retention.tick());
      if (!results.at(-1)!.truncated) break;
    }

    expect(results.at(-1)!.truncated).toBe(false);
    for (const archive of archives) expect(await exists(archive)).toBe(false);
    expect(await exists(quarantine)).toBe(false);
  });
});
