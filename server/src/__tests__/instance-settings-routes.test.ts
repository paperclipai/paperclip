import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  computeTaskDrain: vi.fn(),
  applyTaskDrain: vi.fn(),
  stopTaskDrain: vi.fn(),
  getTaskDrainStatus: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  findManagedSandboxEnvironment: vi.fn(),
  update: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockPublishActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
    publishActivity: mockPublishActivity,
  }));
  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
}

// Identity object the mocked db.transaction hands to writers; tests assert
// both the marker clear and the settings update receive THIS same tx.
const TX_SENTINEL = { __tx: true };
// Module-scoped (not rebuilt per createApp call) so a test can assert how
// many times a request opened a transaction — the task-drain audit writes
// for every company must share ONE transaction, not one each.
const mockDb = {
  // Runs the callback with a sentinel tx and propagates throws, so a
  // failing write inside rejects the whole request exactly like a real
  // transaction rollback.
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(TX_SENTINEL)),
};

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
  app.use("/api", instanceSettingsRoutes(mockDb as any));
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
    mockHeartbeatService.computeTaskDrain.mockReset();
    mockHeartbeatService.applyTaskDrain.mockReset();
    mockHeartbeatService.stopTaskDrain.mockReset();
    mockHeartbeatService.getTaskDrainStatus.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.findManagedSandboxEnvironment.mockReset();
    mockEnvironmentService.findManagedSandboxEnvironment.mockResolvedValue(null);
    mockEnvironmentService.update.mockReset();
    mockPublishActivity.mockReset();
    mockLogActivity.mockReset();
    // Mirrors the real logActivity: push a publication for the transaction
    // to publish once it commits, so route-level tests can prove publish
    // happens only after every company's write in the same request lands.
    mockLogActivity.mockImplementation((_db: unknown, input: { companyId: string }, postCommitPublications?: unknown[]) => {
      postCommitPublications?.push({ companyId: input.companyId, payload: input, pluginEvent: null });
      return Promise.resolve({ id: `activity-${input.companyId}` });
    });
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
        enableExternalObjects: false,
        enableBuiltInAgents: false,
        enableBetaSkills: false,
        enableGoalsSidebarLink: false,
        enableServerInfoDebugView: false,
        autoRestartDevServerWhenIdle: false,
        enableWorkspaceBranchReconcileForward: true,
        enableWorkspaceDirtyQuarantineRepair: true,
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: null,
        worktreeRunExecutionActivationInstanceId: null,
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
      enableExternalObjects: false,
      enableBuiltInAgents: false,
      enableBetaSkills: false,
      enableGoalsSidebarLink: false,
      enableServerInfoDebugView: false,
      autoRestartDevServerWhenIdle: false,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
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
        enableExternalObjects: false,
        enableBuiltInAgents: false,
        enableBetaSkills: false,
        enableGoalsSidebarLink: false,
        enableServerInfoDebugView: false,
        autoRestartDevServerWhenIdle: false,
        enableWorkspaceBranchReconcileForward: true,
        enableWorkspaceDirtyQuarantineRepair: true,
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: null,
        worktreeRunExecutionActivationInstanceId: null,
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
        enableExternalObjects: false,
        enableBuiltInAgents: true,
        enableGoalsSidebarLink: false,
        enableServerInfoDebugView: true,
        autoRestartDevServerWhenIdle: false,
        enableWorkspaceBranchReconcileForward: true,
        enableWorkspaceDirtyQuarantineRepair: true,
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: null,
        worktreeRunExecutionActivationInstanceId: null,
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
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
      enableExternalObjects: false,
      enableBuiltInAgents: false,
      enableBetaSkills: false,
      enableGoalsSidebarLink: false,
      enableServerInfoDebugView: false,
      autoRestartDevServerWhenIdle: false,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
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

  it("does not expose the retired liveness auto-recovery endpoints", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .post("/api/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview")
      .send({ lookbackHours: 24 })
      .expect(404);
    await request(app)
      .post("/api/instance/settings/experimental/issue-graph-liveness-auto-recovery/run")
      .send({ lookbackHours: 24 })
      .expect(404);
  });

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
    expect(mockInstanceSettingsService.update).toHaveBeenCalledWith(
      { defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" },
      { db: TX_SENTINEL },
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("clears the managed-default stamp marker on an explicit tenant default write", async () => {
    // A tenant write of defaultEnvironmentId reclassifies the default as
    // tenant-chosen: the reconciliation stamp marker on the managed
    // sandbox row must not survive, or a later managed-sandbox-only
    // mode-off pass would mistake the tenant's choice for a stamp.
    mockEnvironmentService.findManagedSandboxEnvironment.mockResolvedValue({
      id: "managed-env-1",
      driver: "sandbox",
      status: "active",
      config: {},
      envVars: {},
      metadata: { managedByPaperclip: true, managedDefaultStamped: true },
    });
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings")
      .send({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });

    expect(patchRes.status).toBe(200);
    expect(mockEnvironmentService.update).toHaveBeenCalledWith(
      "managed-env-1",
      { metadata: { managedByPaperclip: true } },
      { db: TX_SENTINEL },
    );
    // Both writes commit in ONE transaction — each receives the SAME tx —
    // so no partial failure can desync the stamp marker from the default
    // (neither a stale stamp on a tenant choice, nor a reconciliation
    // default that lost its marker and can never revert).
    expect(mockInstanceSettingsService.update).toHaveBeenCalledWith(
      { defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" },
      { db: TX_SENTINEL },
    );
  });

  it("aborts the whole request (no committed settings) when the stamp-marker clear fails inside the transaction", async () => {
    // The marker clear and the settings write share a transaction, so a
    // failure in either rolls the whole thing back — a real DB would
    // discard both; here the settings write is never even reached.
    mockEnvironmentService.findManagedSandboxEnvironment.mockResolvedValue({
      id: "managed-env-1",
      driver: "sandbox",
      status: "active",
      config: {},
      envVars: {},
      metadata: { managedByPaperclip: true, managedDefaultStamped: true },
    });
    mockEnvironmentService.update.mockRejectedValue(new Error("metadata write failed"));
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings")
      .send({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });

    expect(patchRes.status).toBeGreaterThanOrEqual(500);
    expect(mockInstanceSettingsService.update).not.toHaveBeenCalled();
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
      .send({ enableEnvironments: true })
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

  describe("executionMode floor on cloud-managed instances", () => {
    const adminActor = {
      type: "board",
      userId: "owner-1",
      source: "cloud_tenant",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    };

    beforeEach(() => {
      process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
    });
    afterEach(() => {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    });

    it("rejects a write that changes executionMode", async () => {
      mockInstanceSettingsService.getGeneral.mockResolvedValue({
        censorUsernameInLogs: false,
        keyboardShortcuts: false,
        feedbackDataSharingPreference: "prompt",
        executionMode: "kubernetes",
      });
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ executionMode: "any" });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "execution_mode_platform_managed" });
      expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
    });

    it("rejects pinning executionMode when the platform left it unrestricted", async () => {
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ executionMode: "kubernetes" });

      expect(res.status).toBe(403);
      expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
    });

    it("allows a same-value executionMode echo so full-object settings forms keep working", async () => {
      mockInstanceSettingsService.getGeneral.mockResolvedValue({
        censorUsernameInLogs: false,
        keyboardShortcuts: false,
        feedbackDataSharingPreference: "prompt",
        executionMode: "kubernetes",
      });
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ executionMode: "kubernetes", keyboardShortcuts: true });

      expect(res.status).toBe(200);
      expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({
        executionMode: "kubernetes",
        keyboardShortcuts: true,
      });
    });

    it("allows general-settings writes that do not touch executionMode", async () => {
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ keyboardShortcuts: true });

      expect(res.status).toBe(200);
      expect(mockInstanceSettingsService.getGeneral).not.toHaveBeenCalled();
      expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({ keyboardShortcuts: true });
    });

    it("keeps executionMode writable on self-hosted instances", async () => {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
      const app = await createApp({
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
      });

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ executionMode: "kubernetes" });

      expect(res.status).toBe(200);
      expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({ executionMode: "kubernetes" });
    });
  });

  describe("operator-hidden settings floor", () => {
    const adminActor = {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    };

    afterEach(() => {
      delete process.env.PAPERCLIP_HIDDEN_SETTINGS;
    });

    it("rejects a write that changes a hidden general field", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.general.censorUsernameInLogs";
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ censorUsernameInLogs: true });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "settings_operator_managed" });
      expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
    });

    it("allows a same-value echo of a hidden general field", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.general.censorUsernameInLogs";
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ censorUsernameInLogs: false, keyboardShortcuts: true });

      expect(res.status).toBe(200);
      expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({
        censorUsernameInLogs: false,
        keyboardShortcuts: true,
      });
    });

    it("deep-compares hidden backupRetention echoes instead of rejecting them", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.general.backupRetention";
      mockInstanceSettingsService.getGeneral.mockResolvedValue({
        censorUsernameInLogs: false,
        keyboardShortcuts: false,
        feedbackDataSharingPreference: "prompt",
        backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      });
      const app = await createApp(adminActor);

      const echo = await request(app)
        .patch("/api/instance/settings/general")
        .send({ backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } });
      expect(echo.status).toBe(200);

      const change = await request(app)
        .patch("/api/instance/settings/general")
        .send({ backupRetention: { dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 1 } });
      expect(change.status).toBe(403);
      expect(change.body.details).toMatchObject({ code: "settings_operator_managed" });
    });

    it("rejects a write that changes a hidden experimental toggle", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.experimental.enableEnvironments";
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableEnvironments: true });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "settings_operator_managed" });
      expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
    });

    it("allows writes to non-hidden experimental toggles while others are hidden", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS =
        "instance.experimental.enableEnvironments,instance.experimental.enableServerInfoDebugView";
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableIsolatedWorkspaces: true });

      expect(res.status).toBe(200);
      expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
        enableIsolatedWorkspaces: true,
      });
    });

    it("floors every experimental toggle when the whole Experimental page is hidden", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.experimental";
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableIsolatedWorkspaces: true });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "settings_operator_managed" });
      expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
    });

    it("keeps every field writable when the env var is unset", async () => {
      const app = await createApp(adminActor);

      const general = await request(app)
        .patch("/api/instance/settings/general")
        .send({ censorUsernameInLogs: true });
      expect(general.status).toBe(200);

      const experimental = await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableEnvironments: true });
      expect(experimental.status).toBe(200);
    });
  });

  describe("task drain", () => {
    const adminActor = {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    };
    const nonAdminActor = {
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    };
    const idleStatus = {
      draining: false,
      startedAt: null,
      expiresAt: null,
      activeRuns: 0,
      pendingWakes: 0,
      quiescent: true,
    };

    afterEach(() => {
      // A drain the mock left active must not carry over into an unrelated
      // test, so every test starts from the idle status again.
      mockHeartbeatService.getTaskDrainStatus.mockReset();
      mockHeartbeatService.computeTaskDrain.mockReset();
      mockHeartbeatService.applyTaskDrain.mockReset();
      mockHeartbeatService.stopTaskDrain.mockReset();
    });

    it("returns the idle status", async () => {
      mockHeartbeatService.getTaskDrainStatus.mockReturnValue(idleStatus);
      const app = await createApp(nonAdminActor);

      const res = await request(app).get("/api/instance/task-drain");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(idleStatus);
    });

    it("writes an activity record for every company, then applies the same drain values, in one transaction", async () => {
      const drain = { startedAt: "2026-08-29T00:00:00.000Z", expiresAt: "2026-08-29T06:00:00.000Z" };
      mockHeartbeatService.computeTaskDrain.mockReturnValue(drain);
      const app = await createApp(adminActor);

      const res = await request(app)
        .post("/api/instance/task-drain")
        .send({ ttlMs: 21_600_000 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(drain);
      expect(mockHeartbeatService.computeTaskDrain).toHaveBeenCalledWith({ ttlMs: 21_600_000 });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledTimes(2);
      for (const call of mockLogActivity.mock.calls) {
        expect(call[0]).toBe(TX_SENTINEL);
        expect(call[1]).toMatchObject({
          action: "instance.task_drain.started",
          details: { startedAt: drain.startedAt, expiresAt: drain.expiresAt },
        });
      }
      // The mutation applies the same values the audit rows already carry,
      // and only after the shared transaction commits.
      expect(mockHeartbeatService.applyTaskDrain).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.applyTaskDrain).toHaveBeenCalledWith(drain);
      expect(mockPublishActivity).toHaveBeenCalledTimes(2);
    });

    it("starts an indefinite drain when the caller sends no ttlMs", async () => {
      mockHeartbeatService.computeTaskDrain.mockReturnValue({ startedAt: "2026-08-29T00:00:00.000Z", expiresAt: null });
      const app = await createApp(adminActor);

      const res = await request(app).post("/api/instance/task-drain").send({});

      expect(res.status).toBe(200);
      expect(mockHeartbeatService.computeTaskDrain).toHaveBeenCalledWith({ ttlMs: null });
    });

    it("writes an activity record for every company, then stops the drain, using one wasActive value throughout", async () => {
      mockHeartbeatService.getTaskDrainStatus.mockReturnValue({
        draining: true,
        startedAt: new Date(),
        expiresAt: null,
        activeRuns: 0,
        pendingWakes: 0,
        quiescent: true,
      });
      const app = await createApp(adminActor);

      const res = await request(app).delete("/api/instance/task-drain");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ wasActive: true });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledTimes(2);
      for (const call of mockLogActivity.mock.calls) {
        expect(call[0]).toBe(TX_SENTINEL);
        expect(call[1]).toMatchObject({
          action: "instance.task_drain.stopped",
          details: { wasActive: true },
        });
      }
      // The mutation runs only after the shared transaction commits.
      expect(mockHeartbeatService.stopTaskDrain).toHaveBeenCalledWith();
      expect(mockPublishActivity).toHaveBeenCalledTimes(2);
    });

    it("does not apply a drain when the company list read fails", async () => {
      mockInstanceSettingsService.listCompanyIds.mockRejectedValue(new Error("db unavailable"));
      const app = await createApp(adminActor);

      const res = await request(app).post("/api/instance/task-drain").send({});

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(mockHeartbeatService.applyTaskDrain).not.toHaveBeenCalled();
    });

    it("commits no activity record for any company when one company's audit write fails", async () => {
      // company-1 succeeds, company-2 fails. A real transaction rolls both
      // back together; here we prove the route puts both writes in the
      // SAME transaction (rather than firing one independent write per
      // company) and never publishes a record for the company that did
      // succeed before the shared transaction rejected.
      mockHeartbeatService.computeTaskDrain.mockReturnValue({
        startedAt: "2026-08-29T00:00:00.000Z",
        expiresAt: null,
      });
      mockLogActivity.mockImplementation((_db: unknown, input: { companyId: string }) => (
        input.companyId === "company-2"
          ? Promise.reject(new Error("activity insert failed"))
          : Promise.resolve({ id: `activity-${input.companyId}` })
      ));
      const app = await createApp(adminActor);

      const res = await request(app).post("/api/instance/task-drain").send({});

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      for (const call of mockLogActivity.mock.calls) {
        expect(call[0]).toBe(TX_SENTINEL);
      }
      expect(mockPublishActivity).not.toHaveBeenCalled();
    });

    it("does not apply the drain when the audit transaction rejects", async () => {
      mockHeartbeatService.computeTaskDrain.mockReturnValue({
        startedAt: "2026-08-29T00:00:00.000Z",
        expiresAt: null,
      });
      mockLogActivity.mockRejectedValue(new Error("activity insert failed"));
      const app = await createApp(adminActor);

      const res = await request(app).post("/api/instance/task-drain").send({});

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(mockHeartbeatService.applyTaskDrain).not.toHaveBeenCalled();
    });

    it("still reports the started drain when publishing its committed audit record fails", async () => {
      // The audit row already committed by the time publish runs, so a
      // publish failure must not turn the response into a false failure:
      // the caller asked to start a drain, and the drain did start.
      const drain = { startedAt: "2026-08-29T00:00:00.000Z", expiresAt: null };
      mockHeartbeatService.computeTaskDrain.mockReturnValue(drain);
      mockPublishActivity.mockImplementation(() => {
        throw new Error("live event bus unavailable");
      });
      const app = await createApp(adminActor);

      const res = await request(app).post("/api/instance/task-drain").send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual(drain);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledTimes(2);
      expect(mockHeartbeatService.applyTaskDrain).toHaveBeenCalledWith(drain);
    });

    it("does not stop the drain when the company list read fails", async () => {
      mockInstanceSettingsService.listCompanyIds.mockRejectedValue(new Error("db unavailable"));
      const app = await createApp(adminActor);

      const res = await request(app).delete("/api/instance/task-drain");

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(mockHeartbeatService.stopTaskDrain).not.toHaveBeenCalled();
    });

    it("does not stop the drain when the audit transaction rejects", async () => {
      mockHeartbeatService.getTaskDrainStatus.mockReturnValue({
        draining: true,
        startedAt: new Date(),
        expiresAt: null,
        activeRuns: 0,
        pendingWakes: 0,
        quiescent: true,
      });
      mockLogActivity.mockRejectedValue(new Error("activity insert failed"));
      const app = await createApp(adminActor);

      const res = await request(app).delete("/api/instance/task-drain");

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(mockHeartbeatService.stopTaskDrain).not.toHaveBeenCalled();
    });

    it("still reports the stopped drain when publishing its committed audit record fails", async () => {
      mockHeartbeatService.getTaskDrainStatus.mockReturnValue({
        draining: true,
        startedAt: new Date(),
        expiresAt: null,
        activeRuns: 0,
        pendingWakes: 0,
        quiescent: true,
      });
      mockPublishActivity.mockImplementation(() => {
        throw new Error("live event bus unavailable");
      });
      const app = await createApp(adminActor);

      const res = await request(app).delete("/api/instance/task-drain");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ wasActive: true });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledTimes(2);
      expect(mockHeartbeatService.stopTaskDrain).toHaveBeenCalledWith();
    });

    it("still publishes the second company's record when the first company's publish fails", async () => {
      // Each committed audit record publishes independently, so one
      // company's publish failure must not stop the rest from publishing.
      const drain = { startedAt: "2026-08-29T00:00:00.000Z", expiresAt: null };
      mockHeartbeatService.computeTaskDrain.mockReturnValue(drain);
      mockPublishActivity.mockImplementation((publication: { companyId: string }) => {
        if (publication.companyId === "company-1") throw new Error("live event bus unavailable");
      });
      const app = await createApp(adminActor);

      const res = await request(app).post("/api/instance/task-drain").send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual(drain);
      expect(mockPublishActivity).toHaveBeenCalledTimes(2);
      expect(mockPublishActivity.mock.calls.map(([publication]: [{ companyId: string }]) => publication.companyId)).toEqual([
        "company-1",
        "company-2",
      ]);
    });

    it("queues an overlapping DELETE behind a POST whose audit transaction is still pending, so the audit order and the live state always agree", async () => {
      // Model the real drain state instead of a canned return value, so
      // this test can prove the applied state, the audit rows, and the
      // response all agree even when the earlier request's transaction
      // resolves after the later request's would have.
      const liveState = { draining: false };
      mockHeartbeatService.computeTaskDrain.mockReturnValue({
        startedAt: "2026-08-29T00:00:00.000Z",
        expiresAt: null,
      });
      mockHeartbeatService.applyTaskDrain.mockImplementation(() => {
        liveState.draining = true;
      });
      mockHeartbeatService.stopTaskDrain.mockImplementation(() => {
        const wasActive = liveState.draining;
        liveState.draining = false;
        return { wasActive };
      });
      mockHeartbeatService.getTaskDrainStatus.mockImplementation(() => ({
        draining: liveState.draining,
        startedAt: liveState.draining ? "2026-08-29T00:00:00.000Z" : null,
        expiresAt: null,
        activeRuns: 0,
        pendingWakes: 0,
        quiescent: true,
      }));

      // The POST's transaction call blocks until the test releases it. The
      // DELETE's transaction call, if it is ever reached, commits at once —
      // so if the route let the two requests race, the DELETE would commit
      // its audit row, and reach stopTaskDrain, first.
      const transactionCalls: string[] = [];
      let releasePostTransaction: (() => void) | undefined;
      let sawFirstCall = false;
      mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
        if (!sawFirstCall) {
          sawFirstCall = true;
          transactionCalls.push("post-start");
          return new Promise((resolve) => {
            releasePostTransaction = () => {
              transactionCalls.push("post-commit");
              resolve(fn(TX_SENTINEL));
            };
          });
        }
        transactionCalls.push("delete-start-and-commit");
        return fn(TX_SENTINEL);
      });

      const app = await createApp(adminActor);

      // supertest only sends the request once something calls .then() on
      // it, so kick both off eagerly instead of waiting for the final
      // Promise.all below to do it — otherwise neither request would even
      // reach the (still-pending) POST transaction during the wait.
      const postPromise = request(app).post("/api/instance/task-drain").send({});
      postPromise.then(() => {}, () => {});
      const deletePromise = request(app).delete("/api/instance/task-drain");
      deletePromise.then(() => {}, () => {});
      // Give both requests time to reach as far as they can go before the
      // POST's transaction is released.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(transactionCalls).toEqual(["post-start"]);
      expect(mockHeartbeatService.applyTaskDrain).not.toHaveBeenCalled();
      expect(mockHeartbeatService.stopTaskDrain).not.toHaveBeenCalled();

      releasePostTransaction?.();
      const [postRes, deleteRes] = await Promise.all([postPromise, deletePromise]);

      expect(postRes.status).toBe(200);
      expect(deleteRes.status).toBe(200);
      // The DELETE's transaction only starts once the POST's has committed
      // and the POST has already applied its drain — audit order matches
      // application order.
      expect(transactionCalls).toEqual(["post-start", "post-commit", "delete-start-and-commit"]);
      // The DELETE observed the drain the POST applied, so its audit row
      // and its response correctly report an active drain, and the live
      // state ends idle — not stuck "draining" from a stale POST that
      // applied after the DELETE that was meant to be the final word.
      expect(deleteRes.body).toEqual({ wasActive: true });
      expect(liveState.draining).toBe(false);
    });

    it("rejects a board actor without instance admin rights", async () => {
      const app = await createApp(nonAdminActor);

      const res = await request(app).post("/api/instance/task-drain").send({});

      expect(res.status).toBe(403);
      expect(mockHeartbeatService.applyTaskDrain).not.toHaveBeenCalled();
    });

    it("rejects a ttl above the maximum", async () => {
      const app = await createApp(adminActor);

      const res = await request(app)
        .post("/api/instance/task-drain")
        .send({ ttlMs: 24 * 60 * 60 * 1000 + 1 });

      expect(res.status).toBe(400);
      expect(mockHeartbeatService.applyTaskDrain).not.toHaveBeenCalled();
    });

    it("rejects a zero or negative ttl", async () => {
      const app = await createApp(adminActor);

      const zeroRes = await request(app).post("/api/instance/task-drain").send({ ttlMs: 0 });
      expect(zeroRes.status).toBe(400);

      const negativeRes = await request(app).post("/api/instance/task-drain").send({ ttlMs: -1 });
      expect(negativeRes.status).toBe(400);

      expect(mockHeartbeatService.applyTaskDrain).not.toHaveBeenCalled();
    });
  });
});
