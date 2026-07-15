import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getGeneral: vi.fn(),
  getExperimental: vi.fn(),
  update: vi.fn(),
  updateGeneral: vi.fn(),
  updateExperimental: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  buildIssueGraphLivenessAutoRecoveryPreview: vi.fn(),
  reconcileIssueGraphLiveness: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
}

async function createApp(actor: any) {
  const [{ errorHandler }, { instanceSettingsRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/instance-settings.js")>("../routes/instance-settings.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("instance settings routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/instance-settings.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.getGeneral.mockReset();
    mockInstanceSettingsService.getExperimental.mockReset();
    mockInstanceSettingsService.update.mockReset();
    mockInstanceSettingsService.updateGeneral.mockReset();
    mockInstanceSettingsService.updateExperimental.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockHeartbeatService.buildIssueGraphLivenessAutoRecoveryPreview.mockReset();
    mockHeartbeatService.reconcileIssueGraphLiveness.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockLogActivity.mockReset();
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      defaultEnvironmentId: null,
      general: {
        censorUsernameInLogs: false,
        keyboardShortcuts: false,
        feedbackDataSharingPreference: "prompt",
      },
      experimental: {
        enableEnvironments: false,
        enableIsolatedWorkspaces: false,
        enableIssuePlanDecompositions: false,
        enableExperimentalFileViewer: false,
        enableCloudSync: false,
        enableExternalObjects: false,
        enableBuiltInAgents: false,
        enableGoalsSidebarLink: false,
        enableServerInfoDebugView: false,
        autoRestartDevServerWhenIdle: false,
        enableIssueGraphLivenessAutoRecovery: true,
        enableWorkspaceBranchReconcileForward: true,
        enableWorkspaceDirtyQuarantineRepair: true,
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: null,
        worktreeRunExecutionActivationInstanceId: null,
        issueGraphLivenessAutoRecoveryLookbackHours: 24,
      },
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableEnvironments: false,
      enableIsolatedWorkspaces: false,
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableTaskWatchdogs: false,
      enableCloudSync: false,
      enableExternalObjects: false,
      enableBuiltInAgents: false,
      enableGoalsSidebarLink: false,
      enableServerInfoDebugView: false,
      autoRestartDevServerWhenIdle: false,
      enableIssueGraphLivenessAutoRecovery: true,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
    mockInstanceSettingsService.update.mockResolvedValue({
      id: "instance-settings-1",
      defaultEnvironmentId: "env-1",
      general: {
        censorUsernameInLogs: false,
        keyboardShortcuts: false,
        feedbackDataSharingPreference: "prompt",
      },
      experimental: {
        enableEnvironments: true,
        enableIsolatedWorkspaces: true,
        enableIssuePlanDecompositions: true,
        enableExperimentalFileViewer: true,
        enableCloudSync: true,
        enableExternalObjects: false,
        enableBuiltInAgents: false,
        enableGoalsSidebarLink: false,
        enableServerInfoDebugView: false,
        autoRestartDevServerWhenIdle: false,
        enableIssueGraphLivenessAutoRecovery: true,
        enableWorkspaceBranchReconcileForward: true,
        enableWorkspaceDirtyQuarantineRepair: true,
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: null,
        worktreeRunExecutionActivationInstanceId: null,
        issueGraphLivenessAutoRecoveryLookbackHours: 24,
      },
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T01:00:00.000Z",
    });
    mockInstanceSettingsService.updateGeneral.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: true,
        keyboardShortcuts: true,
        feedbackDataSharingPreference: "allowed",
      },
    });
    mockInstanceSettingsService.updateExperimental.mockResolvedValue({
      id: "instance-settings-1",
      experimental: {
        enableEnvironments: true,
        enableIsolatedWorkspaces: true,
        enableIssuePlanDecompositions: true,
        enableExperimentalFileViewer: true,
        enableTaskWatchdogs: true,
        enableCloudSync: true,
        enableExternalObjects: false,
        enableBuiltInAgents: true,
        enableGoalsSidebarLink: false,
        enableServerInfoDebugView: true,
        autoRestartDevServerWhenIdle: false,
        enableIssueGraphLivenessAutoRecovery: true,
        enableWorkspaceBranchReconcileForward: true,
        enableWorkspaceDirtyQuarantineRepair: true,
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: null,
        worktreeRunExecutionActivationInstanceId: null,
        issueGraphLivenessAutoRecoveryLookbackHours: 24,
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
    mockHeartbeatService.buildIssueGraphLivenessAutoRecoveryPreview.mockResolvedValue({
      lookbackHours: 24,
      cutoff: "2026-04-26T12:00:00.000Z",
      generatedAt: "2026-04-27T12:00:00.000Z",
      findings: 1,
      recoverableFindings: 1,
      skippedOutsideLookback: 0,
      items: [],
    });
    mockHeartbeatService.reconcileIssueGraphLiveness.mockResolvedValue({
      findings: 1,
      autoRecoveryEnabled: true,
      lookbackHours: 24,
      cutoff: "2026-04-26T12:00:00.000Z",
      escalationsCreated: 1,
      existingEscalations: 0,
      skipped: 0,
      skippedAutoRecoveryDisabled: 0,
      skippedOutsideLookback: 0,
      escalationIssueIds: ["issue-2"],
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: "env-1",
      driver: "local",
      status: "active",
      config: {},
    });
  });

  it("allows local board users to read and update experimental settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings/experimental");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      enableEnvironments: false,
      enableIsolatedWorkspaces: false,
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableTaskWatchdogs: false,
      enableCloudSync: false,
      enableExternalObjects: false,
      enableBuiltInAgents: false,
      enableGoalsSidebarLink: false,
      enableServerInfoDebugView: false,
      autoRestartDevServerWhenIdle: false,
      enableIssueGraphLivenessAutoRecovery: true,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableIsolatedWorkspaces: true });

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableIsolatedWorkspaces: true,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("strips server-managed worktree run execution fields before updating experimental settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "copied-instance",
      })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableWorktreeRunExecution: true,
    });
  });

  it("allows local board users to read and update the instance default environment", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings");
    expect(getRes.status).toBe(200);
    expect(getRes.body.defaultEnvironmentId).toBeNull();

    const patchRes = await request(app)
      .patch("/api/instance/settings")
      .send({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.update).toHaveBeenCalledWith({
      defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown defaultEnvironmentId values with 422", async () => {
    mockEnvironmentService.getById.mockResolvedValue(null);
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .patch("/api/instance/settings")
      .send({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Environment not found");
    expect(mockInstanceSettingsService.update).not.toHaveBeenCalled();
  });

  it("allows local board users to update guarded dev-server auto-restart", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ autoRestartDevServerWhenIdle: true })
      .expect(200);

    expect(
      mockInstanceSettingsService.updateExperimental.mock.calls.some(
        ([patch]) => patch?.autoRestartDevServerWhenIdle === true,
      ),
    ).toBe(true);
  });

  it("allows local board users to update external object detection", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableExternalObjects: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableExternalObjects: true,
    });
  });

  it("allows local board users to update built-in agents", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableBuiltInAgents: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableBuiltInAgents: true,
    });
  });

  it("allows local board users to update the goals sidebar link", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableGoalsSidebarLink: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableGoalsSidebarLink: true,
    });
  });

  it("allows local board users to update the server info debug view", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableServerInfoDebugView: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableServerInfoDebugView: true,
    });
  });

  it("allows local board users to update issue graph liveness auto-recovery", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({
        enableIssueGraphLivenessAutoRecovery: true,
        issueGraphLivenessAutoRecoveryLookbackHours: 12,
      })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 12,
    });
  });

  it("previews issue graph liveness recovery candidates before enabling", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview")
      .send({ lookbackHours: 12 })
      .expect(200);

    expect(res.body).toMatchObject({ lookbackHours: 24, recoverableFindings: 1 });
    expect(mockHeartbeatService.buildIssueGraphLivenessAutoRecoveryPreview).toHaveBeenCalledWith({
      lookbackHours: 12,
    });
  });

  it("kicks off issue graph liveness recovery on demand", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .post("/api/instance/settings/experimental/issue-graph-liveness-auto-recovery/run")
      .send({ lookbackHours: 12 })
      .expect(200);

    expect(mockHeartbeatService.reconcileIssueGraphLiveness).toHaveBeenCalledWith({
      runId: null,
      force: true,
      lookbackHours: 12,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("allows local board users to update environment controls", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableEnvironments: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableEnvironments: true,
    });
  });

  it("allows local board users to update task watchdog controls", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableTaskWatchdogs: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableTaskWatchdogs: true,
    });
  });

  it("allows non-admin board users with company access to read but not update experimental settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    await request(app).get("/api/instance/settings/experimental").expect(200);

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableTaskWatchdogs: true })
      .expect(403);

    expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
  });

  it("allows local board users to read and update general settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings/general");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings/general")
      .send({
        censorUsernameInLogs: true,
        keyboardShortcuts: true,
        feedbackDataSharingPreference: "allowed",
      });

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({
      censorUsernameInLogs: true,
      keyboardShortcuts: true,
      feedbackDataSharingPreference: "allowed",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("allows non-admin board users to read general settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/instance/settings/general");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
    });
  });

  it("rejects signed-in users without company access from reading general settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-2",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [],
      memberships: [],
    });

    const res = await request(app).get("/api/instance/settings/general");

    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.getGeneral).not.toHaveBeenCalled();
  });

  it("rejects non-admin board users from updating general settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .patch("/api/instance/settings/general")
      .send({ censorUsernameInLogs: true, keyboardShortcuts: true });

    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app)
      .patch("/api/instance/settings/general")
      .send({ feedbackDataSharingPreference: "not_allowed" });

    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
  });
});
