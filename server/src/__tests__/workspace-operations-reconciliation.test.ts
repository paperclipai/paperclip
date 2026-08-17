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
import { eq } from "drizzle-orm";
import { getWorkspaceOperationLogStore } from "../services/workspace-operation-log-store.js";
import {
  RUNTIME_CONTROL_STALE_AFTER_MS,
  resetWorkspaceRuntimeControlLocksForTests,
  runExclusiveWorkspaceRuntimeControl,
  workspaceOperationService,
} from "../services/workspace-operations.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("workspace runtime control serialization", () => {
  afterEach(() => {
    resetWorkspaceRuntimeControlLocksForTests();
  });

  it("deterministically rejects an overlapping control operation and releases the claim", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = runExclusiveWorkspaceRuntimeControl({
      executionWorkspaceId: "workspace-1",
      action: "start",
      run: async () => {
        await firstGate;
        return "started";
      },
    });

    await expect(runExclusiveWorkspaceRuntimeControl({
      executionWorkspaceId: "workspace-1",
      action: "restart",
      run: async () => "restarted",
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "workspace_runtime_control_in_progress",
        activeAction: "start",
        requestedAction: "restart",
      },
    });

    releaseFirst();
    await expect(first).resolves.toBe("started");
    await expect(runExclusiveWorkspaceRuntimeControl({
      executionWorkspaceId: "workspace-1",
      action: "stop",
      run: async () => "stopped",
    })).resolves.toBe("stopped");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping workspace-operation reconciliation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workspace operation reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let logRoot = "";
  let previousLogRoot: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-operation-reconcile-");
    db = createDb(tempDb.connectionString);
    logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-operation-logs-"));
    previousLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = logRoot;
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousLogRoot === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = previousLogRoot;
    await fs.rm(logRoot, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("terminalizes an orphaned runtime start with an inspectable reconciliation log", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const staleOperationId = randomUUID();
    const unrelatedOperationId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workspace operation reconciliation",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Runtime reconciliation",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Reconciliation workspace",
      status: "active",
      cwd: "/tmp/reconciliation-workspace",
    });

    const logHandle = await getWorkspaceOperationLogStore().begin({
      companyId,
      operationId: staleOperationId,
    });
    await db.insert(workspaceOperations).values([
      {
        id: staleOperationId,
        companyId,
        executionWorkspaceId,
        phase: "workspace_provision",
        command: "workspace command start",
        cwd: "/tmp/reconciliation-workspace",
        status: "running",
        logStore: logHandle.store,
        logRef: logHandle.logRef,
        metadata: { action: "start", executionWorkspaceId },
      },
      {
        id: unrelatedOperationId,
        companyId,
        executionWorkspaceId,
        phase: "workspace_provision",
        command: "bash ./scripts/provision-worktree.sh",
        cwd: "/tmp/reconciliation-workspace",
        status: "running",
        metadata: { created: true },
      },
    ]);

    const service = workspaceOperationService(db);

    // Recovery is bounded and cannot steal a live operation (PAP-17249): a `running` control
    // that has signalled recently is left alone even when it carries no ownership stamp, which
    // is the shape a control recorded by a pre-stamp build has.
    await expect(service.reconcileStaleRuntimeControlOperations(executionWorkspaceId)).resolves.toEqual({
      reconciled: 0,
      operationIds: [],
    });
    expect((await service.getById(staleOperationId))?.status).toBe("running");

    // Once it has gone quiet for longer than the staleness window, it is terminalized.
    await expect(
      service.reconcileStaleRuntimeControlOperations(executionWorkspaceId, {
        now: new Date(Date.now() + RUNTIME_CONTROL_STALE_AFTER_MS + 5_000),
      }),
    ).resolves.toEqual({
      reconciled: 1,
      operationIds: [staleOperationId],
    });

    const stale = await service.getById(staleOperationId);
    expect(stale).toMatchObject({
      status: "failed",
      metadata: {
        action: "start",
        reconciled: true,
        reconciliationReason: "orphaned_runtime_control",
      },
    });
    expect(stale?.finishedAt).toBeInstanceOf(Date);
    expect(stale?.stderrExcerpt).toContain("no live owner has reported progress");
    expect((await service.readLog(staleOperationId)).content).toContain(
      "no live owner has reported progress",
    );

    const unrelated = await db
      .select({ status: workspaceOperations.status })
      .from(workspaceOperations)
      .where(eq(workspaceOperations.id, unrelatedOperationId))
      .then((rows) => rows[0]);
    expect(unrelated?.status).toBe("running");
  });
});
