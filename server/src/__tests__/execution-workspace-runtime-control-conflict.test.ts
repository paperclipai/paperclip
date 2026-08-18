import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({
  assertRuntimeControlAvailable: vi.fn(),
  createRecorder: vi.fn(),
  reconcileStaleRuntimeControlOperations: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({ normalizeEnvBindingsForPersistence: vi.fn() }));
const mockProjectService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAssertCanManageExecutionWorkspaceRuntimeServices = vi.hoisted(() => vi.fn());
const mockAssertCanManageProjectWorkspaceRuntimeServices = vi.hoisted(() => vi.fn());
const mockStartRuntimeServices = vi.hoisted(() => vi.fn());
const mockStopRuntimeServicesForExecutionWorkspace = vi.hoisted(() => vi.fn());
const mockEnsurePersistedExecutionWorkspaceAvailable = vi.hoisted(() => vi.fn());
const mockBuildWorkspaceRuntimeDesiredStatePatch = vi.hoisted(() => vi.fn());
// The integrated control path also takes the durable runtime-control lease (PAP-17205). This
// suite covers the in-flight guard and failed-start reconciliation, so the lease always grants;
// `execution-workspace-runtime-lease-route.test.ts` exercises the lease itself against a real db.
const mockClaimRuntimeLease = vi.hoisted(() => vi.fn(async () => null));
const mockReleaseRuntimeLease = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => mockEnvironmentService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
  workspaceRuntimeLeaseService: () => ({
    claim: mockClaimRuntimeLease,
    release: mockReleaseRuntimeLease,
  }),
  LEASED_WORKSPACE_RUNTIME_ACTIONS: ["start", "stop", "restart"],
}));

vi.mock("../services/workspace-runtime.js", () => ({
  buildWorkspaceRuntimeDesiredStatePatch: mockBuildWorkspaceRuntimeDesiredStatePatch,
  cleanupExecutionWorkspaceArtifacts: vi.fn(),
  ensurePersistedExecutionWorkspaceAvailable: mockEnsurePersistedExecutionWorkspaceAvailable,
  listConfiguredRuntimeServiceEntries: vi.fn(() => []),
  runWorkspaceJobForControl: vi.fn(),
  startRuntimeServicesForWorkspaceControl: mockStartRuntimeServices,
  stopRuntimeServicesForExecutionWorkspace: mockStopRuntimeServicesForExecutionWorkspace,
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

vi.mock("../routes/workspace-runtime-service-authz.js", () => ({
  assertCanManageExecutionWorkspaceRuntimeServices: mockAssertCanManageExecutionWorkspaceRuntimeServices,
  assertCanManageProjectWorkspaceRuntimeServices: mockAssertCanManageProjectWorkspaceRuntimeServices,
}));

const executionWorkspaceId = "33333333-3333-4333-8333-333333333333";

function buildExecutionWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: executionWorkspaceId,
    companyId: "company-1",
    // Left unset so the handler does not need a real `db` for project/policy lookups; the
    // runtime config below is what the control path actually reads.
    projectId: null,
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Lane A",
    status: "active",
    cwd: "/tmp/lane-a",
    repoUrl: null,
    baseRef: "main",
    branchName: "canary/lane-a",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: {
      workspaceRuntime: {
        services: [{ name: "app", command: "pnpm dev", port: { type: "fixed", value: 42003 } }],
      },
      desiredState: "running",
    },
    metadata: null,
    runtimeServices: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

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
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

/**
 * Route-level guarantees for PAP-17249: the competing lane in the PAP-17207 report must get a
 * stable 409 while a control is genuinely live, and a start that fails must leave the workspace
 * stopped and retryable instead of "desired running" with residue.
 */
describe.sequential("execution workspace runtime control conflict and failure reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "runtime:manage",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace());
    mockExecutionWorkspaceService.update.mockResolvedValue(buildExecutionWorkspace());
    mockAssertCanManageExecutionWorkspaceRuntimeServices.mockResolvedValue(undefined);
    mockWorkspaceOperationService.assertRuntimeControlAvailable.mockResolvedValue(undefined);
    mockBuildWorkspaceRuntimeDesiredStatePatch.mockReturnValue({
      desiredState: "stopped",
      serviceStates: { app: "stopped" },
    });
    mockEnsurePersistedExecutionWorkspaceAvailable.mockResolvedValue({
      cwd: "/tmp/lane-a",
      projectId: "project-1",
      workspaceId: null,
      branchName: "canary/lane-a",
      worktreePath: "/tmp/lane-a",
      repoUrl: null,
      repoRef: "main",
    });
    mockStopRuntimeServicesForExecutionWorkspace.mockResolvedValue(undefined);
    mockWorkspaceOperationService.createRecorder.mockReturnValue({
      attachExecutionWorkspaceId: vi.fn(),
      recordOperation: async (input: any) => {
        // Mirror the real recorder: a throwing `run` becomes a terminal failed operation and
        // the error still propagates to the caller.
        try {
          await input.run();
        } catch (error) {
          (error as any).recordedOperationStatus = "failed";
          throw error;
        }
        return { id: "operation-1", status: "succeeded" };
      },
    });
  });

  it("returns a stable 409 while a managed control is genuinely live", async () => {
    const { conflict } = await import("../errors.js");
    mockWorkspaceOperationService.assertRuntimeControlAvailable.mockRejectedValue(
      conflict("A managed runtime control operation is already in progress for this execution workspace.", {
        code: "workspace_runtime_control_in_progress",
        executionWorkspaceId,
        activeAction: "start",
        requestedAction: "stop",
        activeOperationId: "operation-live",
        remediation: "Wait for the active operation to reach a terminal state before retrying.",
      }),
    );
    const app = await createApp();

    const res = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/stop`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.details ?? res.body).toMatchObject({
      code: "workspace_runtime_control_in_progress",
      activeAction: "start",
      requestedAction: "stop",
    });
    // The conflict is decided before any runtime mutation happens.
    expect(mockStopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockStartRuntimeServices).not.toHaveBeenCalled();
  });

  it("checks authorization before recovering or claiming the workspace", async () => {
    const { forbidden } = await import("../errors.js");
    mockAssertCanManageExecutionWorkspaceRuntimeServices.mockRejectedValue(
      forbidden("Missing permission to manage workspace runtime services"),
    );
    const app = await createApp();

    const res = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockWorkspaceOperationService.assertRuntimeControlAvailable).not.toHaveBeenCalled();
  });

  it("tears down residue and records a stopped desired state when a start fails", async () => {
    mockStartRuntimeServices.mockRejectedValue(
      new Error(
        'Runtime service "app" could not start because port 42003 is already in use by pid 4242 (cwd: /tmp/lane-b)',
      ),
    );
    const app = await createApp();

    const res = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    // No exposure/listener residue: the failed lane is stopped through the ordinary teardown.
    expect(mockStopRuntimeServicesForExecutionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ executionWorkspaceId, workspaceCwd: "/tmp/lane-a" }),
    );
    // ...and the workspace is no longer recorded as wanting to run, so it is retryable and a
    // startup reconcile will not resurrect a lane that never came up.
    expect(mockBuildWorkspaceRuntimeDesiredStatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "stop" }),
    );
    expect(mockExecutionWorkspaceService.update).toHaveBeenCalledWith(
      executionWorkspaceId,
      expect.objectContaining({ metadata: expect.anything() }),
    );
  });

  it("reconciles once when the operation's own time budget fails a start that never settles", async () => {
    const { WorkspaceOperationTimeoutError } = await import("../services/workspace-operations.js");
    // The recorder's ceiling fires outside `run`, so only the outer handler can reconcile.
    mockWorkspaceOperationService.createRecorder.mockReturnValue({
      attachExecutionWorkspaceId: vi.fn(),
      recordOperation: async () => {
        throw new WorkspaceOperationTimeoutError(1_000, "start");
      },
    });
    const app = await createApp();

    const res = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockStopRuntimeServicesForExecutionWorkspace).toHaveBeenCalledTimes(1);
    expect(mockBuildWorkspaceRuntimeDesiredStatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "stop" }),
    );
  });

  it("leaves a successful start's desired state untouched by the failure path", async () => {
    mockStartRuntimeServices.mockResolvedValue([{ id: "runtime-1" }]);
    const app = await createApp();

    const res = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBeLessThan(400);
    expect(mockStopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockBuildWorkspaceRuntimeDesiredStatePatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "stop" }),
    );
  });
});
