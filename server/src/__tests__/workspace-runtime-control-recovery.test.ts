import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  executionWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import {
  RUNTIME_CONTROL_STALE_AFTER_MS,
  WorkspaceOperationTimeoutError,
  resetWorkspaceRuntimeControlStateForTests,
  workspaceOperationService,
  workspaceRuntimeControlOwnerIdForTests,
} from "../services/workspace-operations.js";
import { getWorkspaceOperationLogStore } from "../services/workspace-operation-log-store.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping runtime-control recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Regression coverage for PAP-17249. The adverse report on PAP-17207 left an execution
 * workspace with a `running` managed start that no owner was driving, so every managed
 * cleanup was rejected with `409 workspace_runtime_control_in_progress` forever.
 *
 * These cases run against real Postgres because the recovery guarantee is a
 * compare-and-swap over `workspace_operations`, not an in-process lock.
 */
describeEmbeddedPostgres("managed runtime-control operation recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  let logRoot = "";
  let previousLogRoot: string | undefined;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-runtime-control-recovery-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-control-logs-"));
    previousLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = logRoot;
  }, 60_000);

  afterEach(async () => {
    resetWorkspaceRuntimeControlStateForTests();
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousLogRoot === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = previousLogRoot;
    await fs.rm(logRoot, { recursive: true, force: true });
    if (stopDb) await stopDb();
  });

  async function seedWorkspace() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Runtime control recovery",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Runtime control recovery",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Lane A",
      status: "active",
      cwd: "/tmp/runtime-control-lane-a",
    });
    return { companyId, projectId, executionWorkspaceId };
  }

  /** Wait for a managed control to have actually persisted its claim row. */
  async function waitForRunningOperation(executionWorkspaceId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = await db
        .select({ id: workspaceOperations.id })
        .from(workspaceOperations)
        .where(
          and(
            eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId),
            eq(workspaceOperations.status, "running"),
          ),
        )
        .then((rows) => rows[0]);
      if (row) return row.id;
      await delay(20);
    }
    throw new Error("timed out waiting for the managed control operation row");
  }

  /** Insert a `running` start the way an abandoned request or dead server process leaves one. */
  async function seedRunningStart(input: {
    companyId: string;
    executionWorkspaceId: string;
    owner?: { ownerId: string; pid: number; heartbeatAt: Date };
    withLog?: boolean;
    startedAt?: Date;
    /**
     * Let Postgres stamp `started_at`/`updated_at` from the column defaults, at the
     * microsecond precision the driver truncates on the way back into JS. This is how every
     * row written before managed controls stamped their own timestamps looks.
     */
    columnDefaultTimestamps?: boolean;
  }) {
    const id = randomUUID();
    const handle = input.withLog
      ? await getWorkspaceOperationLogStore().begin({ companyId: input.companyId, operationId: id })
      : null;
    const startedAt = input.startedAt ?? new Date();
    await db.insert(workspaceOperations).values({
      id,
      companyId: input.companyId,
      executionWorkspaceId: input.executionWorkspaceId,
      phase: "workspace_provision",
      command: "workspace command start",
      cwd: "/tmp/runtime-control-lane-a",
      status: "running",
      logStore: handle?.store ?? null,
      logRef: handle?.logRef ?? null,
      metadata: {
        action: "start",
        executionWorkspaceId: input.executionWorkspaceId,
        ...(input.owner
          ? {
              runtimeControlOwner: {
                ownerId: input.owner.ownerId,
                pid: input.owner.pid,
                action: "start",
                heartbeatAt: input.owner.heartbeatAt.toISOString(),
              },
            }
          : {}),
      },
      ...(input.columnDefaultTimestamps ? {} : { startedAt, updatedAt: startedAt }),
    });
    return id;
  }

  it("recovers a start abandoned by a dead server process and frees managed control", async () => {
    const { companyId, executionWorkspaceId } = await seedWorkspace();
    const service = workspaceOperationService(db);
    // pid 2^22-1 is above every Linux/macOS pid ceiling, so it can never be alive.
    const deadPid = 4_194_303;
    const staleId = await seedRunningStart({
      companyId,
      executionWorkspaceId,
      owner: { ownerId: randomUUID(), pid: deadPid, heartbeatAt: new Date() },
      withLog: true,
    });

    await expect(service.reconcileStaleRuntimeControlOperations(executionWorkspaceId)).resolves.toEqual({
      reconciled: 1,
      operationIds: [staleId],
    });

    const recovered = await service.getById(staleId);
    expect(recovered).toMatchObject({
      status: "failed",
      metadata: {
        action: "start",
        reconciled: true,
        reconciliationReason: "orphaned_runtime_control",
      },
    });
    expect(recovered?.finishedAt).toBeInstanceOf(Date);
    expect(recovered?.stderrExcerpt).toContain(`the owning server process (pid ${deadPid}) is gone`);
    expect((await service.readLog(staleId)).content).toContain("is gone");

    // The workspace is controllable again through the ordinary managed path.
    await expect(
      service.assertRuntimeControlAvailable({ executionWorkspaceId, action: "stop" }),
    ).resolves.toBeUndefined();
  });

  it("refuses to steal a start whose owning process is still alive inside the staleness window", async () => {
    const { companyId, executionWorkspaceId } = await seedWorkspace();
    const service = workspaceOperationService(db);
    const liveId = await seedRunningStart({
      companyId,
      executionWorkspaceId,
      // A different server instance, but its pid is this very test process: genuinely alive.
      owner: { ownerId: randomUUID(), pid: process.pid, heartbeatAt: new Date() },
    });

    await expect(service.reconcileStaleRuntimeControlOperations(executionWorkspaceId)).resolves.toEqual({
      reconciled: 0,
      operationIds: [],
    });
    expect((await service.getById(liveId))?.status).toBe("running");

    // ...and a competing control gets the stable conflict, not a silent steal.
    await expect(
      service.assertRuntimeControlAvailable({ executionWorkspaceId, action: "start" }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "workspace_runtime_control_in_progress",
        activeAction: "start",
        requestedAction: "start",
        activeOperationId: liveId,
      },
    });
  });

  it("bounds recovery: the same live owner is reclaimed once its heartbeat lapses", async () => {
    const { companyId, executionWorkspaceId } = await seedWorkspace();
    const service = workspaceOperationService(db);
    const staleId = await seedRunningStart({
      companyId,
      executionWorkspaceId,
      owner: { ownerId: randomUUID(), pid: process.pid, heartbeatAt: new Date() },
    });

    const afterWindow = new Date(Date.now() + RUNTIME_CONTROL_STALE_AFTER_MS + 1_000);
    await expect(
      service.reconcileStaleRuntimeControlOperations(executionWorkspaceId, { now: afterWindow }),
    ).resolves.toEqual({ reconciled: 1, operationIds: [staleId] });
    expect((await service.getById(staleId))?.status).toBe("failed");
  });

  it("recovers a legacy start with no ownership stamp only after the staleness window", async () => {
    const { companyId, executionWorkspaceId } = await seedWorkspace();
    const service = workspaceOperationService(db);
    const legacyId = await seedRunningStart({ companyId, executionWorkspaceId });

    await expect(service.reconcileStaleRuntimeControlOperations(executionWorkspaceId)).resolves.toEqual({
      reconciled: 0,
      operationIds: [],
    });
    await expect(
      service.reconcileStaleRuntimeControlOperations(executionWorkspaceId, {
        now: new Date(Date.now() + RUNTIME_CONTROL_STALE_AFTER_MS + 1_000),
      }),
    ).resolves.toEqual({ reconciled: 1, operationIds: [legacyId] });
  });

  it("recovers a start whose timestamps came from the column defaults", async () => {
    const { companyId, executionWorkspaceId } = await seedWorkspace();
    const service = workspaceOperationService(db);
    // Regression guard for the compare-and-swap: `updated_at` written by `defaultNow()` keeps
    // microsecond precision, while the driver hands JS a millisecond-truncated Date. An `=`
    // CAS against that read never matches, which would make recovery silently no-op on exactly
    // the rows it exists to clear — the ones a previous build left `running`.
    const legacyId = await seedRunningStart({
      companyId,
      executionWorkspaceId,
      owner: { ownerId: randomUUID(), pid: 4_194_303, heartbeatAt: new Date() },
      columnDefaultTimestamps: true,
      withLog: true,
    });

    await expect(service.reconcileStaleRuntimeControlOperations(executionWorkspaceId)).resolves.toEqual({
      reconciled: 1,
      operationIds: [legacyId],
    });
    expect((await service.getById(legacyId))?.status).toBe("failed");
  });

  it("terminalizes exactly once when two recovery sweeps race the same operation", async () => {
    const { companyId, executionWorkspaceId } = await seedWorkspace();
    const service = workspaceOperationService(db);
    const staleId = await seedRunningStart({
      companyId,
      executionWorkspaceId,
      owner: { ownerId: randomUUID(), pid: 4_194_303, heartbeatAt: new Date() },
    });

    const [a, b] = await Promise.all([
      service.reconcileStaleRuntimeControlOperations(executionWorkspaceId),
      service.reconcileStaleRuntimeControlOperations(executionWorkspaceId),
    ]);
    expect(a.reconciled + b.reconciled).toBe(1);
    expect((await service.getById(staleId))?.status).toBe("failed");
  });

  it("leaves non-runtime-control operations alone", async () => {
    const { companyId, executionWorkspaceId } = await seedWorkspace();
    const service = workspaceOperationService(db);
    const provisionId = randomUUID();
    await db.insert(workspaceOperations).values({
      id: provisionId,
      companyId,
      executionWorkspaceId,
      phase: "workspace_provision",
      command: "bash ./scripts/provision-worktree.sh",
      cwd: "/tmp/runtime-control-lane-a",
      status: "running",
      metadata: { created: true },
      startedAt: new Date(Date.now() - 60 * 60_000),
      updatedAt: new Date(Date.now() - 60 * 60_000),
    });

    await expect(service.reconcileStaleRuntimeControlOperations()).resolves.toEqual({
      reconciled: 0,
      operationIds: [],
    });
    const row = await db
      .select({ status: workspaceOperations.status })
      .from(workspaceOperations)
      .where(eq(workspaceOperations.id, provisionId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("running");
  });

  it("keeps a company's recovery inside its own scope", async () => {
    const laneA = await seedWorkspace();
    const laneB = await seedWorkspace();
    const service = workspaceOperationService(db);
    const staleA = await seedRunningStart({
      companyId: laneA.companyId,
      executionWorkspaceId: laneA.executionWorkspaceId,
      owner: { ownerId: randomUUID(), pid: 4_194_303, heartbeatAt: new Date() },
    });
    const staleB = await seedRunningStart({
      companyId: laneB.companyId,
      executionWorkspaceId: laneB.executionWorkspaceId,
      owner: { ownerId: randomUUID(), pid: 4_194_303, heartbeatAt: new Date() },
    });

    await expect(
      service.reconcileStaleRuntimeControlOperations(laneA.executionWorkspaceId),
    ).resolves.toEqual({ reconciled: 1, operationIds: [staleA] });
    expect((await service.getById(staleB))?.status).toBe("running");
  });

  it("holds the workspace while a start is genuinely live in this process, then releases it", async () => {
    const { companyId, executionWorkspaceId } = await seedWorkspace();
    const service = workspaceOperationService(db);
    const recorder = service.createRecorder({ companyId, executionWorkspaceId });

    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const inFlight = recorder.recordOperation({
      phase: "workspace_provision",
      command: "workspace command start",
      metadata: { action: "start", executionWorkspaceId },
      run: async () => {
        await startGate;
        return { status: "succeeded" as const, exitCode: 0 };
      },
    });

    // The claim exists once the operation row lands, which is the point at which a competing
    // control could observe it.
    const liveOperationId = await waitForRunningOperation(executionWorkspaceId);

    // The live claim is visible to another service instance on the same database, and a
    // recovery sweep must not steal it even though this operation has not heartbeated yet.
    const competitor = workspaceOperationService(db);
    await expect(
      competitor.assertRuntimeControlAvailable({ executionWorkspaceId, action: "restart" }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "workspace_runtime_control_in_progress",
        requestedAction: "restart",
        activeOperationId: liveOperationId,
      },
    });
    await expect(
      competitor.reconcileStaleRuntimeControlOperations(executionWorkspaceId),
    ).resolves.toEqual({ reconciled: 0, operationIds: [] });

    releaseStart();
    const completed = await inFlight;
    expect(completed.status).toBe("succeeded");
    expect(completed.metadata).toMatchObject({
      runtimeControlOwner: { ownerId: workspaceRuntimeControlOwnerIdForTests() },
    });

    // Terminal operation, so the next managed control proceeds.
    await expect(
      competitor.assertRuntimeControlAvailable({ executionWorkspaceId, action: "stop" }),
    ).resolves.toBeUndefined();
  });

  it("protects an in-process start from recovery even with the staleness window collapsed", async () => {
    const { companyId, executionWorkspaceId } = await seedWorkspace();
    const service = workspaceOperationService(db);
    const recorder = service.createRecorder({ companyId, executionWorkspaceId });
    const sweeper = workspaceOperationService(db);

    let sweeping = true;
    let reconciled = 0;
    // `staleAfterMs: 0` removes the heartbeat grace period, so the only thing that can keep
    // this start alive is the in-process ownership claim. Sweeping continuously across the
    // whole recordOperation lifetime also covers the row-insert window.
    const sweeps = (async () => {
      while (sweeping) {
        const result = await sweeper.reconcileStaleRuntimeControlOperations(executionWorkspaceId, {
          staleAfterMs: 0,
        });
        reconciled += result.reconciled;
        await delay(2);
      }
    })();

    const operation = await recorder.recordOperation({
      phase: "workspace_provision",
      command: "workspace command start",
      metadata: { action: "start", executionWorkspaceId },
      run: async () => {
        await delay(120);
        return { status: "succeeded" as const, exitCode: 0 };
      },
    });
    sweeping = false;
    await sweeps;

    expect(reconciled).toBe(0);
    expect(operation.status).toBe("succeeded");
    expect((await service.getById(operation.id))?.status).toBe("succeeded");
  });

  it("fails a hung start on its own time budget so no active operation is left behind", async () => {
    const { companyId, executionWorkspaceId } = await seedWorkspace();
    const service = workspaceOperationService(db);
    const recorder = service.createRecorder({ companyId, executionWorkspaceId });

    await expect(
      recorder.recordOperation({
        phase: "workspace_provision",
        command: "workspace command start",
        metadata: { action: "start", executionWorkspaceId },
        timeoutMs: 150,
        // A start that never settles: the readiness probe that parked on a foreign listener.
        run: () => new Promise(() => {}),
      }),
    ).rejects.toBeInstanceOf(WorkspaceOperationTimeoutError);

    const rows = await db
      .select()
      .from(workspaceOperations)
      .where(eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed" });
    expect(rows[0]?.finishedAt).toBeInstanceOf(Date);
    expect(rows[0]?.metadata).toMatchObject({ failureReason: "runtime_control_timeout" });
    expect(rows[0]?.stderrExcerpt).toContain("time budget");

    // No orphan active operation: a managed stop or retry goes straight through.
    await expect(
      service.assertRuntimeControlAvailable({ executionWorkspaceId, action: "stop" }),
    ).resolves.toBeUndefined();
    await expect(service.reconcileStaleRuntimeControlOperations(executionWorkspaceId)).resolves.toEqual({
      reconciled: 0,
      operationIds: [],
    });
  });

  it("lets a managed retry succeed immediately after a failed start", async () => {
    const { companyId, executionWorkspaceId } = await seedWorkspace();
    const service = workspaceOperationService(db);
    const recorder = service.createRecorder({ companyId, executionWorkspaceId });

    await expect(
      recorder.recordOperation({
        phase: "workspace_provision",
        command: "workspace command start",
        metadata: { action: "start", executionWorkspaceId },
        run: async () => {
          throw new Error("Runtime service \"app\" could not start because port 42003 is already in use by pid 1234");
        },
      }),
    ).rejects.toThrow(/already in use/);

    await expect(
      service.assertRuntimeControlAvailable({ executionWorkspaceId, action: "start" }),
    ).resolves.toBeUndefined();

    const retry = await recorder.recordOperation({
      phase: "workspace_provision",
      command: "workspace command start",
      metadata: { action: "start", executionWorkspaceId },
      run: async () => ({ status: "succeeded" as const, exitCode: 0 }),
    });
    expect(retry.status).toBe("succeeded");

    const statuses = await db
      .select({ status: workspaceOperations.status })
      .from(workspaceOperations)
      .where(eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId));
    expect(statuses.map((row) => row.status).sort()).toEqual(["failed", "succeeded"]);
  });
});
