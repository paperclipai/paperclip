import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { nativeWorkspaceFinalizationLockKey } from "../services/native-runtime/native-workspace-finalization-ownership.ts";
import {
  NATIVE_WORKSPACE_SYNC_RETENTION_RETRY_MS,
  nativeWorkspaceSyncRetentionService,
  registerNativeWorkspaceSyncRetentionWork,
} from "../services/native-runtime/native-workspace-sync-retention.ts";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.ts";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.ts";
import {
  nativeWorkspaceSyncInternals,
  nativeWorkspaceSyncStateRoot,
} from "../services/native-runtime/native-workspace-sync.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native workspace sync retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function exists(target: string) {
  return fs.lstat(target).then(() => true, () => false);
}

type SeedInput = {
  runStatus?: string;
  finishedDaysAgo?: number | null;
  folderAgeDays?: number;
  reference?: boolean;
  owner?: boolean;
  processPid?: number | null;
  processGroupId?: number | null;
  processStartedAt?: Date | null;
  leaseProvider?: string | null;
  controllerLeaseDaysFromNow?: number | null;
  finalization?: {
    phase: string;
    recoveryState?: string | null;
    leaseOwner?: string | null;
    nextAttemptDaysFromNow?: number | null;
  } | null;
  leaseMetadata?: Record<string, unknown>;
  leasePolicy?: string;
  recoveryAction?: { cause?: string; status?: string; evidence?: Record<string, unknown> };
  resultJson?: Record<string, unknown>;
};

describeEmbeddedPostgres("native workspace sync retention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let stateRoot = "";
  const now = new Date();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-workspace-sync-retention-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    livePids = new Map();
    await db.delete(issueRecoveryActions);
    await db.delete(nativeRunFinalizations);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true });
    stateRoot = "";
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function root() {
    if (!stateRoot) stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-native-workspace-sync-"));
    return stateRoot;
  }

  async function writeFolder(name: string, ageDays: number) {
    const folder = path.join(await root(), name);
    await fs.mkdir(folder, { recursive: true });
    const files = ["descriptor.json", "manifest.sqlite", "workspace-seed.tar", "git-seed.tar"];
    for (const file of files) await fs.writeFile(path.join(folder, file), "x".repeat(4096));
    const at = new Date(now.getTime() - ageDays * DAY_MS);
    for (const file of files) await fs.utimes(path.join(folder, file), at, at);
    await fs.utimes(folder, at, at);
    return folder;
  }

  async function seed(input: SeedInput = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Sync", issuePrefix: `S${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Coder" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Work", status: "done" }).returning();
    const runId = randomUUID();
    const leaseId = randomUUID();
    const runStatus = input.runStatus ?? "succeeded";
    const finishedDaysAgo = input.finishedDaysAgo === undefined ? 10 : input.finishedDaysAgo;
    const profile: Record<string, unknown> = {};
    if (input.reference ?? true) {
      profile.nativeWorkspaceSync = {
        schema: "paperclip.native-workspace-sync/v3",
        state: "finalized",
        descriptorSha256: "a".repeat(64),
        baselineSha256: "b".repeat(64),
        finalHostSha256: null,
        workspaceId: randomUUID(),
        leaseId,
        providerLeaseId: "provider-lease",
        remoteCwd: "/workspace",
      };
    }
    if (input.owner) profile.nativeWorkspaceFinalizationOwner = { token: randomUUID() };
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: agent!.id,
      status: runStatus,
      issueId: issue!.id,
      nativeIssueId: issue!.id,
      finishedAt: finishedDaysAgo === null ? null : new Date(now.getTime() - finishedDaysAgo * DAY_MS),
      processPid: input.processPid ?? null,
      processGroupId: input.processGroupId ?? null,
      processStartedAt: input.processStartedAt ?? null,
      controllerLeaseExpiresAt: input.controllerLeaseDaysFromNow == null
        ? null
        : new Date(now.getTime() + input.controllerLeaseDaysFromNow * DAY_MS),
      runnerProfileJson: profile,
      resultJson: input.resultJson ?? null,
    });
    const finalization = input.finalization === undefined ? { phase: "committed" } : input.finalization;
    if (finalization) {
      await db.insert(nativeRunFinalizations).values({
        runId,
        companyId,
        issueId: issue!.id,
        phase: finalization.phase,
        recoveryState: finalization.recoveryState ?? null,
        leaseOwner: finalization.leaseOwner ?? null,
        nextAttemptAt: finalization.nextAttemptDaysFromNow == null
          ? null
          : new Date(now.getTime() + finalization.nextAttemptDaysFromNow * DAY_MS),
      });
    }
    if (input.leaseMetadata || input.leasePolicy || input.leaseProvider !== undefined) {
      await db.insert(environmentLeases).values({
        id: leaseId,
        companyId,
        heartbeatRunId: runId,
        status: "released",
        provider: input.leaseProvider ?? null,
        leasePolicy: input.leasePolicy ?? "ephemeral",
        metadata: input.leaseMetadata ?? {},
      });
    }
    if (input.recoveryAction) {
      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issue!.id,
        kind: "active_run_watchdog",
        ownerType: "system",
        cause: input.recoveryAction.cause ?? "native_continuation_requires_reconciliation",
        fingerprint: randomUUID(),
        status: input.recoveryAction.status ?? "active",
        nextAction: "Recover",
        evidence: { runId, systemRecovery: { state: "complete" }, ...input.recoveryAction.evidence },
      });
    }
    const folder = await writeFolder(runId, input.folderAgeDays ?? 9);
    return { companyId, runId, folder };
  }

  const processStart = new Date(now.getTime() - 20 * DAY_MS);
  let livePids = new Map<number, string | null>();

  const processProbe = {
    mayBeAlive: (pid: number) => livePids.has(pid),
    startedAt: async (pid: number) => livePids.get(pid) ?? null,
  };

  function service() {
    return nativeWorkspaceSyncRetentionService(db, { stateRoot, now: () => now, processProbe });
  }

  async function expectKept(input: SeedInput, reason: string) {
    const { folder } = await seed(input);
    const result = await service().tick();
    expect(result.expired).toBe(0);
    expect(result.skipped[reason]).toBe(1);
    expect(await exists(folder)).toBe(true);
  }

  it("deletes a settled committed run's folder after the retention window", async () => {
    const { folder } = await seed();
    const result = await service().tick();
    expect(result).toMatchObject({ checked: 1, candidates: 1, expired: 1, failed: 0 });
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(await exists(folder)).toBe(false);
    expect((await fs.readdir(stateRoot)).filter((name) => name.startsWith(".expired-"))).toEqual([]);
  });

  it("deletes committed runs whose recovery state was left behind without a lease", async () => {
    const { folder } = await seed({ finalization: { phase: "committed", recoveryState: "resuming_session" } });
    expect((await service().tick()).expired).toBe(1);
    expect(await exists(folder)).toBe(false);
  });

  it("deletes blocked terminal failures with no recovery owner", async () => {
    const { folder } = await seed({
      runStatus: "failed",
      finalization: { phase: "terminal_failure", recoveryState: "blocked" },
      recoveryAction: { status: "resolved", cause: "native_workspace_sync_out_unrecoverable" },
    });
    expect((await service().tick()).expired).toBe(1);
    expect(await exists(folder)).toBe(false);
  });

  it("deletes orphaned folders and unreferenced settled runs", async () => {
    const orphan = await writeFolder(randomUUID(), 9);
    const { folder } = await seed({ reference: false, finalization: { phase: "observed" } });
    const result = await service().tick();
    expect(result.expired).toBe(2);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(folder)).toBe(false);
  });

  it("keeps folders with recent files or recently finished runs", async () => {
    const recentFiles = await seed({ folderAgeDays: 2 });
    const recentRun = await seed({ finishedDaysAgo: 3 });
    const result = await service().tick();
    expect(result.expired).toBe(0);
    expect(result.skipped).toMatchObject({ recent_files: 1, recently_finished: 1 });
    expect(await exists(recentFiles.folder)).toBe(true);
    expect(await exists(recentRun.folder)).toBe(true);
  });

  it("keeps runs that are not settled", async () => {
    await expectKept({ runStatus: "running", finishedDaysAgo: null }, "run_unsettled");
  });

  it("keeps runs whose local process is still alive", async () => {
    livePids.set(1234, processStart.toISOString());
    await expectKept({ processPid: 1234, processStartedAt: processStart, leaseProvider: "local" }, "process_live");
  });

  it("keeps runs whose local process is alive with an unreadable start time", async () => {
    livePids.set(1234, null);
    await expectKept({ processPid: 1234, processStartedAt: processStart }, "process_live");
  });

  it("keeps runs whose local process group is still alive", async () => {
    livePids.set(-4321, null);
    await expectKept({ processPid: 4321, processGroupId: 4321 }, "process_live");
  });

  it("keeps a running run that still records a process", async () => {
    livePids.set(1234, processStart.toISOString());
    await expectKept({ runStatus: "running", finishedDaysAgo: null, processPid: 1234 }, "run_unsettled");
  });

  it("deletes a terminal run whose recorded local process has exited", async () => {
    const { folder } = await seed({
      runStatus: "failed",
      finalization: { phase: "terminal_failure" },
      processPid: 1234,
      processGroupId: 1234,
      processStartedAt: processStart,
      leaseProvider: "local",
    });
    expect((await service().tick()).expired).toBe(1);
    expect(await exists(folder)).toBe(false);
  });

  it("deletes a terminal run whose recorded pid was recycled by another process", async () => {
    livePids.set(1234, new Date(now.getTime() - DAY_MS).toISOString());
    const { folder } = await seed({ processPid: 1234, processStartedAt: processStart });
    expect((await service().tick()).expired).toBe(1);
    expect(await exists(folder)).toBe(false);
  });

  it("deletes a terminal run whose stale pid came from a destroyed sandbox", async () => {
    livePids.set(1234, processStart.toISOString());
    livePids.set(-1234, null);
    const { folder } = await seed({
      runStatus: "cancelled",
      finalization: { phase: "terminal_failure" },
      processPid: 1234,
      processGroupId: 1234,
      processStartedAt: processStart,
      leaseProvider: "daytona",
      leaseMetadata: { remoteExecutionTermination: { state: "destroyed" } },
    });
    expect((await service().tick()).expired).toBe(1);
    expect(await exists(folder)).toBe(false);
  });

  it("keeps runs with a live controller lease", async () => {
    await expectKept({ controllerLeaseDaysFromNow: 1 }, "controller_live");
  });

  it("keeps runs with a finalization owner receipt, even without a reference", async () => {
    await expectKept({ owner: true, reference: false }, "finalization_owner");
  });

  it("keeps unsettled finalization phases", async () => {
    await expectKept({ finalization: { phase: "observed" } }, "finalization_unsettled");
  });

  it("keeps retryable failures without a result", async () => {
    await expectKept({ finalization: { phase: "retryable_failure" } }, "finalization_unsettled");
  });

  it("keeps finalizations with a live lease owner", async () => {
    await expectKept({ finalization: { phase: "committed", leaseOwner: "controller" } }, "finalization_leased");
  });

  it("keeps finalizations with a scheduled retry", async () => {
    await expectKept(
      { finalization: { phase: "terminal_failure", nextAttemptDaysFromNow: 1 } },
      "finalization_retry_scheduled",
    );
  });

  it.each(["awaiting_evidence", "awaiting_runner_reattach", "resuming_session", "bootstrap_incomplete"])(
    "keeps terminal failures in recovery state %s",
    async (recoveryState) => {
      await expectKept({ finalization: { phase: "terminal_failure", recoveryState } }, "finalization_recovering");
    },
  );

  it.each(["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"])(
    "keeps runs with an open %s recovery action",
    async (cause) => {
      await expectKept({ recoveryAction: { cause, status: "escalated" } }, "export_recovery");
    },
  );

  it("keeps runs with an open owner-unverified recovery action", async () => {
    await expectKept(
      { recoveryAction: { cause: "native_workspace_finalization_owner_unverified" } },
      "owner_unverified",
    );
  });

  it("keeps runs whose export resume is recorded on the lease", async () => {
    await expectKept({ leaseMetadata: { nativeWorkspaceExportResume: { attempt: 1 } } }, "export_resume");
  });

  it("keeps runs whose lease cleanup is in flight", async () => {
    await expectKept({ leaseMetadata: { pendingCleanupInFlight: true } }, "export_resume");
  });

  it.each([
    { systemRecovery: { state: "scheduled" } },
    { systemRecovery: { state: "running" } },
    { systemRecovery: { state: "awaiting_evidence" } },
    { workspaceRecovery: { status: "queued" } },
    { workspaceRecovery: { status: "recovering" } },
  ])("keeps retained recovery %j on a lease that was not destroyed", async (evidence) => {
    await expectKept(
      { leaseMetadata: { systemRecoveryAdoption: {} }, recoveryAction: { status: "resolved", evidence } },
      "retained_recovery",
    );
  });

  it("deletes when the retained lease was destroyed", async () => {
    const { folder } = await seed({
      leaseMetadata: { remoteExecutionTermination: { state: "destroyed" } },
      recoveryAction: { status: "resolved", evidence: { systemRecovery: { state: "scheduled" } } },
    });
    expect((await service().tick()).expired).toBe(1);
    expect(await exists(folder)).toBe(false);
  });

  it("keeps runs that historical recovery adoption has not reached", async () => {
    await expectKept({ leasePolicy: "retain_on_failure" }, "recovery_backfill_pending");
  });

  it("keeps runs with an unadopted export recovery action", async () => {
    const { runId, folder } = await seed({
      recoveryAction: { status: "resolved", cause: "native_workspace_sync_out_unrecoverable" },
    });
    await db.execute(sql`update issue_recovery_actions set evidence = evidence - 'systemRecovery'
      where evidence->>'runId' = ${runId}`);
    const result = await service().tick();
    expect(result.skipped.recovery_backfill_pending).toBe(1);
    expect(await exists(folder)).toBe(true);
  });

  it("never touches generations, non-UUID names, symlinks, or files", async () => {
    const base = await root();
    const generations = await writeFolder("generations", 30);
    const other = await writeFolder("not-a-run", 30);
    const target = await writeFolder(".outside", 30);
    const linkName = randomUUID();
    await fs.symlink(target, path.join(base, linkName));
    const fileName = randomUUID();
    await fs.writeFile(path.join(base, fileName), "x");
    const old = new Date(now.getTime() - 30 * DAY_MS);
    await fs.utimes(path.join(base, fileName), old, old);
    const result = await service().tick();
    expect(result.expired).toBe(0);
    expect(result.skipped.unsafe_path).toBe(2);
    for (const entry of [generations, other, target, path.join(base, linkName), path.join(base, fileName)]) {
      expect(await exists(entry)).toBe(true);
    }
  });

  it("deletes nothing during a dry run", async () => {
    const { folder } = await seed();
    const leftover = await writeFolder(`.expired-${randomUUID()}`, 1);
    const result = await nativeWorkspaceSyncRetentionService(db, { stateRoot, now: () => now, dryRun: true }).tick();
    expect(result).toMatchObject({ candidates: 1, expired: 0, leftoversRemoved: 0 });
    expect(await exists(folder)).toBe(true);
    expect(await exists(leftover)).toBe(true);
  });

  it("bounds leftover removal by the batch limits", async () => {
    const leftovers: string[] = [];
    for (let index = 0; index < 3; index++) leftovers.push(await writeFolder(`.expired-${randomUUID()}`, 0));
    const folder = await writeFolder(randomUUID(), 9);
    expect(await service().tick({ shouldContinue: () => false })).toMatchObject({ leftoversRemoved: 0, truncated: true });
    const retention = service();
    const first = await retention.tick({ maxRemovals: 2 });
    expect(first).toMatchObject({ leftoversRemoved: 2, expired: 1, truncated: true });
    expect(await exists(folder)).toBe(false);
    const rest = await retention.tick({ maxRemovals: 2 });
    expect(rest).toMatchObject({ leftoversRemoved: 1, expired: 0, truncated: false });
    for (const leftover of leftovers) expect(await exists(leftover)).toBe(false);
  });

  it("keeps expiring run folders and moves past leftovers that cannot be removed", async () => {
    const stuck: string[] = [];
    for (let index = 0; index < 2; index++) {
      const leftover = await writeFolder(`.expired-${randomUUID()}`, 0);
      await fs.chmod(leftover, 0o500);
      stuck.push(leftover);
    }
    const folder = await writeFolder(randomUUID(), 9);
    const retention = service();
    try {
      const first = await retention.tick({ maxRemovals: 1 });
      expect(first).toMatchObject({ failed: 1, expired: 1, truncated: true });
      expect(await exists(folder)).toBe(false);
      const second = await retention.tick({ maxRemovals: 1 });
      expect(second).toMatchObject({ failed: 1, truncated: false });
    } finally {
      for (const leftover of stuck) await fs.chmod(leftover, 0o700);
    }
  });

  it("removes leftover expired folders", async () => {
    const leftover = await writeFolder(`.expired-${randomUUID()}`, 0);
    const retiring = await writeFolder(`.retiring-${randomUUID()}`, 30);
    const result = await service().tick();
    expect(result.leftoversRemoved).toBe(1);
    expect(await exists(leftover)).toBe(false);
    expect(await exists(retiring)).toBe(true);
  });

  it("skips a run while its finalization ownership lock is held", async () => {
    const { companyId, runId, folder } = await seed();
    let result: Awaited<ReturnType<ReturnType<typeof service>["tick"]>> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${nativeWorkspaceFinalizationLockKey(companyId, runId)}, 0))`);
      result = await service().tick();
    });
    expect(result?.skipped.finalization_locked).toBe(1);
    expect(await exists(folder)).toBe(true);
    expect((await service().tick()).expired).toBe(1);
  });

  it("bounds each tick and resumes from its cursor", async () => {
    const first = await writeFolder(randomUUID(), 9);
    const second = await writeFolder(randomUUID(), 9);
    const retention = service();
    const initial = await retention.tick({ maxRemovals: 1 });
    expect(initial).toMatchObject({ expired: 1, truncated: true });
    const rest = await retention.tick({ maxRemovals: 1 });
    expect(rest).toMatchObject({ expired: 1, truncated: false });
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(false);
  });

  it("stops when asked to", async () => {
    const folder = await writeFolder(randomUUID(), 9);
    const result = await service().tick({ shouldContinue: () => false });
    expect(result).toMatchObject({ checked: 0, truncated: true });
    expect(await exists(folder)).toBe(true);
  });

  describe("scheduled worker", () => {
    function register() {
      let queue = "";
      let task!: { run: (signal: AbortSignal) => Promise<unknown>; nextRunAt?: () => number | null };
      const coordinator = {
        register: (registeredQueue: string, registered: typeof task) => {
          queue = registeredQueue;
          task = registered;
          return { ready: Promise.resolve(), wake: () => {} };
        },
      };
      const onResult = vi.fn();
      registerNativeWorkspaceSyncRetentionWork(coordinator as never, service(), { onResult });
      return { queue: () => queue, task: () => task, onResult };
    }

    it("goes quiet with no folders and schedules the next real deadline", async () => {
      await root();
      const worker = register();
      expect(worker.queue()).toBe(DELIVERY_QUEUES.nativeWorkspaceSyncRetention);
      await worker.task().run(new AbortController().signal);
      expect(worker.task().nextRunAt?.()).toBeNull();
      await seed({ finishedDaysAgo: 3, folderAgeDays: 4 });
      await worker.task().run(new AbortController().signal);
      expect(worker.task().nextRunAt?.()).toBe(now.getTime() + 4 * DAY_MS);
      expect(worker.onResult).toHaveBeenCalledTimes(2);
    });

    it("waits the retry delay when a leftover cannot be removed", async () => {
      const base = await root();
      const leftover = await writeFolder(`.expired-${randomUUID()}`, 0);
      await fs.writeFile(path.join(leftover, "nested"), "x");
      await fs.chmod(leftover, 0o500);
      try {
        const worker = register();
        await worker.task().run(new AbortController().signal);
        expect(worker.onResult.mock.calls[0]![0]).toMatchObject({ failed: 1 });
        expect(worker.task().nextRunAt?.()).toBeGreaterThanOrEqual(now.getTime() + NATIVE_WORKSPACE_SYNC_RETENTION_RETRY_MS);
      } finally {
        await fs.chmod(leftover, 0o700);
      }
      expect(await exists(base)).toBe(true);
    });

    it("wakes the quiet coordinator when a run creates its folder", async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sync-home-"));
      const originalHome = process.env.PAPERCLIP_HOME;
      const originalInstance = process.env.PAPERCLIP_INSTANCE_ID;
      process.env.PAPERCLIP_HOME = home;
      process.env.PAPERCLIP_INSTANCE_ID = "retention";
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
      const onResult = vi.fn();
      const worker = registerNativeWorkspaceSyncRetentionWork(
        coordinator,
        nativeWorkspaceSyncRetentionService(db, { stateRoot: nativeWorkspaceSyncStateRoot() }),
        { onResult },
      );
      try {
        await worker.ready;
        expect(onResult).toHaveBeenCalledTimes(1);
        expect(coordinator.nextWakeAt()).toBeNull();
        await nativeWorkspaceSyncInternals.writeDescriptor({
          schema: "paperclip.native-workspace-sync/v3",
          state: "prepared",
          baselineSha256: "b".repeat(64),
          finalHostSha256: null,
          binding: { runId: randomUUID(), workspaceId: randomUUID(), leaseId: randomUUID(), providerLeaseId: "lease", remoteCwd: "/workspace" },
        } as never);
        await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(coordinator.nextWakeAt()).not.toBeNull());
        const wakeAt = coordinator.nextWakeAt()!;
        expect(wakeAt).toBeGreaterThan(Date.now() + 6 * DAY_MS);
      } finally {
        worker.unsubscribe();
        await coordinator.stop();
        if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
        else process.env.PAPERCLIP_HOME = originalHome;
        if (originalInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
        else process.env.PAPERCLIP_INSTANCE_ID = originalInstance;
        await fs.rm(home, { recursive: true, force: true });
      }
    });

    it("retries soon when the finalization lock was held", async () => {
      const { companyId, runId } = await seed();
      const worker = register();
      const before = Date.now();
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${nativeWorkspaceFinalizationLockKey(companyId, runId)}, 0))`);
        await worker.task().run(new AbortController().signal);
      });
      const next = worker.task().nextRunAt?.() ?? 0;
      expect(next).toBeGreaterThanOrEqual(before + NATIVE_WORKSPACE_SYNC_RETENTION_RETRY_MS);
      expect(next).toBeLessThanOrEqual(Date.now() + NATIVE_WORKSPACE_SYNC_RETENTION_RETRY_MS);
    });
  });

  describe("nextDeadlineAt", () => {
    it("is null without folders", async () => {
      await root();
      await writeFolder("generations", 0);
      expect(await service().nextDeadlineAt()).toBeNull();
    });

    it("is null when the state root does not exist", async () => {
      expect(await nativeWorkspaceSyncRetentionService(db, {
        stateRoot: path.join(os.tmpdir(), `missing-${randomUUID()}`),
        now: () => now,
      }).nextDeadlineAt()).toBeNull();
    });

    it("retries leftover expired folders after the retry delay", async () => {
      await writeFolder(`.expired-${randomUUID()}`, 0);
      expect(await service().nextDeadlineAt()).toBe(now.getTime() + NATIVE_WORKSPACE_SYNC_RETENTION_RETRY_MS);
    });

    it("stops scanning when asked to and retries later", async () => {
      await writeFolder(randomUUID(), 1);
      expect(await service().nextDeadlineAt({ shouldContinue: () => false }))
        .toBe(now.getTime() + NATIVE_WORKSPACE_SYNC_RETENTION_RETRY_MS);
    });

    it("carries the earliest deadline across batches", async () => {
      for (let index = 0; index < 205; index++) await writeFolder(randomUUID(), 1);
      await writeFolder("ffffffff-ffff-4fff-8fff-ffffffffffff", 6);
      const deadline = await service().nextDeadlineAt();
      expect(Math.abs(deadline! - (now.getTime() + DAY_MS))).toBeLessThan(1000);
    });

    it("is the earliest settled run finish plus the retention window", async () => {
      await seed({ finishedDaysAgo: 3, folderAgeDays: 4 });
      await seed({ finishedDaysAgo: 2, folderAgeDays: 4 });
      expect(await service().nextDeadlineAt()).toBe(now.getTime() + 4 * DAY_MS);
    });

    it("uses the folder's newest file for orphans", async () => {
      await writeFolder(randomUUID(), 5);
      const deadline = await service().nextDeadlineAt();
      expect(Math.abs(deadline! - (now.getTime() + 2 * DAY_MS))).toBeLessThan(1000);
    });

    it("rechecks unsettled or kept folders one retention window later", async () => {
      await seed({ runStatus: "running", finishedDaysAgo: null, folderAgeDays: 30 });
      await seed({ finalization: { phase: "observed" } });
      expect(await service().nextDeadlineAt()).toBe(now.getTime() + 7 * DAY_MS);
    });
  });
});
