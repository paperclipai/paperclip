import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaceRuntimeLeases,
  executionWorkspaces,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn(async () => ({ allowed: true })) }));
const mockRecordOperation = vi.hoisted(() => vi.fn());
const mockReconcileStaleRuntimeControlOperations = vi.hoisted(() => vi.fn(async () => ({ reconciled: 0, operationIds: [] })));
// The control path recovers stranded operations and then refuses only a genuinely live one
// (PAP-17249). This suite is about the durable lease, so availability always resolves.
const mockAssertRuntimeControlAvailable = vi.hoisted(() => vi.fn(async () => undefined));
const mockWorkspaceOperationService = vi.hoisted(() => ({
  createRecorder: vi.fn(() => ({
    attachExecutionWorkspaceId: vi.fn(),
    recordOperation: mockRecordOperation,
  })),
  assertRuntimeControlAvailable: mockAssertRuntimeControlAvailable,
  reconcileStaleRuntimeControlOperations: mockReconcileStaleRuntimeControlOperations,
  listForExecutionWorkspace: vi.fn(async () => []),
}));
const mockStartRuntimeServices = vi.hoisted(() => vi.fn(async () => []));
const mockStopRuntimeServices = vi.hoisted(() => vi.fn(async () => undefined));
const mockAssertCanManage = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", async () => {
  const leases = await import("../services/workspace-runtime-leases.js");
  return {
    accessService: () => mockAccessService,
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    heartbeatService: () => ({}),
    logActivity: mockLogActivity,
    workspaceOperationService: () => mockWorkspaceOperationService,
    workspaceRuntimeLeaseService: leases.workspaceRuntimeLeaseService,
    LEASED_WORKSPACE_RUNTIME_ACTIONS: leases.LEASED_WORKSPACE_RUNTIME_ACTIONS,
  };
});

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({ destroyReusableSandboxLeases: vi.fn() }),
}));

vi.mock("../services/workspace-runtime.js", () => ({
  buildWorkspaceRuntimeDesiredStatePatch: () => ({ desiredState: "running", serviceStates: null }),
  cleanupExecutionWorkspaceArtifacts: vi.fn(),
  ensurePersistedExecutionWorkspaceAvailable: vi.fn(async () => ({ cwd: "/tmp/lease-route-workspace" })),
  listConfiguredRuntimeServiceEntries: () => [],
  runWorkspaceJobForControl: vi.fn(),
  startRuntimeServicesForWorkspaceControl: mockStartRuntimeServices,
  stopRuntimeServicesForExecutionWorkspace: mockStopRuntimeServices,
}));

vi.mock("../routes/workspace-runtime-service-authz.js", () => ({
  assertCanManageExecutionWorkspaceRuntimeServices: mockAssertCanManage,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping runtime lease route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("execution workspace runtime control lease enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let projectId = "";
  let executionWorkspaceId = "";
  let agentId = "";
  let canaryIssueId = "";
  let competingIssueId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-lease-route-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true } as never);
    mockReconcileStaleRuntimeControlOperations.mockResolvedValue({ reconciled: 0, operationIds: [] } as never);
    mockStartRuntimeServices.mockResolvedValue([] as never);
    // Owner identity is read per-request from a header so concurrent requests cannot
    // observe each other's authorization mock.
    mockAssertCanManage.mockImplementation(async (_db: unknown, req: { get: (name: string) => string | undefined }) => ({
      actorType: "agent",
      agentId,
      runId: null,
      issueId: req.get("x-test-owner-issue") ?? null,
    }));
    mockRecordOperation.mockImplementation(async (input: { run: () => Promise<unknown> }) => {
      await input.run();
      return { id: randomUUID(), status: "succeeded" };
    });

    companyId = randomUUID();
    projectId = randomUUID();
    executionWorkspaceId = randomUUID();
    agentId = randomUUID();
    canaryIssueId = randomUUID();
    competingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Runtime lease route",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Lane", status: "in_progress" });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "git_worktree",
      name: "Shared canary workspace",
      status: "active",
      cwd: "/tmp/lease-route-workspace",
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer" });
    await db.insert(issues).values([
      {
        id: canaryIssueId,
        companyId,
        projectId,
        executionWorkspaceId,
        title: "HTTPS canary",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: competingIssueId,
        companyId,
        projectId,
        executionWorkspaceId,
        title: "Unrelated shared-workspace work",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);

    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: executionWorkspaceId,
      companyId,
      projectId: null,
      projectWorkspaceId: null,
      sourceIssueId: null,
      mode: "shared_workspace",
      strategyType: "git_worktree",
      name: "Shared canary workspace",
      status: "active",
      cwd: "/tmp/lease-route-workspace",
      repoUrl: null,
      baseRef: "main",
      branchName: null,
      providerType: "git_worktree",
      providerRef: null,
      config: { workspaceRuntime: { command: "pnpm dev" } },
      metadata: null,
      runtimeServices: [],
    } as never);
    mockExecutionWorkspaceService.update.mockResolvedValue({ id: executionWorkspaceId } as never);
  });

  afterEach(async () => {
    await db.delete(executionWorkspaceRuntimeLeases);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function createApp() {
    const [{ executionWorkspaceRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/execution-workspaces.js"),
      import("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId,
        companyId,
        source: "agent_key",
        runId: null,
      };
      next();
    });
    app.use("/api", executionWorkspaceRoutes(db as never));
    app.use(errorHandler);
    return app;
  }

  it("lets the lease owner start and restart, and blocks a sequential competing issue without mutating anything", async () => {
    const app = await createApp();

    const started = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .set("x-test-owner-issue", canaryIssueId)
      .send({});
    expect(started.status).toBe(200);
    expect(mockStartRuntimeServices).toHaveBeenCalledTimes(1);

    const restarted = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/restart`)
      .set("x-test-owner-issue", canaryIssueId)
      .send({});
    expect(restarted.status).toBe(200);
    expect(mockStartRuntimeServices).toHaveBeenCalledTimes(2);

    mockRecordOperation.mockClear();
    mockStartRuntimeServices.mockClear();
    mockStopRuntimeServices.mockClear();
    mockReconcileStaleRuntimeControlOperations.mockClear();

    const blocked = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .set("x-test-owner-issue", competingIssueId)
      .send({});

    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("workspace_runtime_lease_conflict");
    expect(blocked.body.details).toMatchObject({
      ownerIssueId: canaryIssueId,
      requestedAction: "start",
    });
    expect(typeof blocked.body.remediation).toBe("string");

    // No workspace operation, no runtime-service mutation, no reconciliation side effect.
    expect(mockRecordOperation).not.toHaveBeenCalled();
    expect(mockStartRuntimeServices).not.toHaveBeenCalled();
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
    expect(mockReconcileStaleRuntimeControlOperations).not.toHaveBeenCalled();

    const rows = await db.select().from(executionWorkspaceRuntimeLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerIssueId).toBe(canaryIssueId);
  });

  it("blocks a competing issue that races the owner concurrently", async () => {
    const app = await createApp();

    const ownerStart = request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .set("x-test-owner-issue", canaryIssueId)
      .send({});
    const competingStart = request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/stop`)
      .set("x-test-owner-issue", competingIssueId)
      .send({});

    const [ownerRes, competingRes] = await Promise.all([ownerStart, competingStart]);

    expect(ownerRes.status).toBe(200);
    expect(competingRes.status).toBe(409);
    expect(competingRes.body.code).toMatch(
      /workspace_runtime_lease_conflict|workspace_runtime_control_in_progress/,
    );
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();

    const rows = await db.select().from(executionWorkspaceRuntimeLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerIssueId).toBe(canaryIssueId);
  });

  it("lets a teardown issue take the lane once the canary issue is terminal", async () => {
    const app = await createApp();

    expect((await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .set("x-test-owner-issue", canaryIssueId)
      .send({})).status).toBe(200);

    const { eq } = await import("drizzle-orm");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, canaryIssueId));

    const teardown = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/stop`)
      .set("x-test-owner-issue", competingIssueId)
      .send({});

    expect(teardown.status).toBe(200);
    expect(mockStopRuntimeServices).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(executionWorkspaceRuntimeLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerIssueId).toBe(competingIssueId);
  });

  it("leaves board actors unleased and unblocked", async () => {
    const [{ executionWorkspaceRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/execution-workspaces.js"),
      import("../middleware/index.js"),
    ]);
    mockAssertCanManage.mockResolvedValue({
      actorType: "board",
      agentId: null,
      runId: null,
      issueId: null,
    } as never);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-1",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", executionWorkspaceRoutes(db as never));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBe(200);
    expect(await db.select().from(executionWorkspaceRuntimeLeases)).toHaveLength(0);
  });
});
