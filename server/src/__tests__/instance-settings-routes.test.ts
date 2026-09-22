import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";
import { logger } from "../middleware/logger.js";

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
  isTaskDrainGenerationLive: vi.fn(),
  terminateActiveRunsForTaskDrain: vi.fn(),
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
// Runs the callback with a sentinel tx and propagates throws, so a failing
// write inside rejects the whole request exactly like a real transaction
// rollback. This is the default mockDb.transaction implementation; a test
// that installs its own mockImplementation loses this default, so
// beforeEach below reinstalls it before every test.
function defaultTransactionImplementation(fn: (tx: unknown) => Promise<unknown>) {
  return fn(TX_SENTINEL);
}
// Module-scoped (not rebuilt per createApp call) so a test can assert how
// many times a request opened a transaction — the task-drain audit writes
// for every company must share ONE transaction, not one each.
// The termination deadline handler checks for an already-committed outcome
// row before it writes one (see instance-settings.ts), so the mock db needs
// a chainable select().from().where().limit() alongside transaction(). A
// test that wants to model "a prior attempt already committed" overrides
// this default resolved value; every other test keeps the default empty
// result, so the write proceeds exactly as it did before that check existed.
function defaultSelectChain() {
  return {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([] as { id: string }[]),
      }),
    }),
  };
}
// Read the literal string value a drizzle-orm `eq()`/`and()` condition
// binds as a query parameter. A test that must prove which dedup key the
// route actually queried with — not just whether a row came back — walks
// the condition object for its bound `Param` values, since the mock
// `where()` above normally ignores its argument.
function collectBoundParamValues(node: unknown, found: string[]): void {
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record.value === "string") found.push(record.value);
  if (Array.isArray(record.value)) {
    for (const entry of record.value) {
      if (typeof entry === "string") found.push(entry);
    }
  }
  if (Array.isArray(record.queryChunks)) {
    for (const chunk of record.queryChunks) collectBoundParamValues(chunk, found);
  }
}
const mockDb = {
  transaction: vi.fn(defaultTransactionImplementation),
  select: vi.fn(defaultSelectChain),
};

describe("instance settings routes", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ errorHandler }, { instanceSettingsRoutes }] = await Promise.all([
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../routes/instance-settings.js")>("../routes/instance-settings.js"),
    ]);
    return { errorHandler, instanceSettingsRoutes };
  });

  function createApp(actor: any) {
    const { errorHandler, instanceSettingsRoutes } = routeModules.value;
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

  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks() clears recorded calls only; it does not remove a
    // mockImplementation a prior test installed. Reinstall the default here
    // so a stateful implementation from one test can never leak into the
    // next one.
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(defaultTransactionImplementation);
    mockDb.select.mockReset();
    mockDb.select.mockImplementation(defaultSelectChain);
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
    mockHeartbeatService.isTaskDrainGenerationLive.mockReset();
    mockHeartbeatService.terminateActiveRunsForTaskDrain.mockReset();
    mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(new Map());
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

  it.each([true, false])("allows only instance admins to change chat connector visibility (%s)", async (isInstanceAdmin) => {
    const app = createApp({ type: "board", userId: "user-1", source: "session", isInstanceAdmin, companyIds: ["company-1"] });
    const response = await request(app).patch("/api/instance/settings/experimental").send({ enableChatConnectors: true });
    expect(response.status).toBe(isInstanceAdmin ? 200 : 403);
    if (isInstanceAdmin) {
      expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({ enableChatConnectors: true });
      expect(mockLogActivity).toHaveBeenCalled();
    } else {
      expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
    }
  });

  it("accepts the instance-wide Streamlined UI preference", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableStreamlinedUi: false })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableStreamlinedUi: false,
    });
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
      mockHeartbeatService.isTaskDrainGenerationLive.mockReset();
      mockHeartbeatService.terminateActiveRunsForTaskDrain.mockReset();
      mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(new Map());
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
      expect(mockHeartbeatService.computeTaskDrain).toHaveBeenCalledWith({
        ttlMs: 21_600_000,
        terminateActiveTasks: false,
      });
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
      expect(mockHeartbeatService.computeTaskDrain).toHaveBeenCalledWith({
        ttlMs: null,
        terminateActiveTasks: false,
      });
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
      // Resolves the instant the first (blocked) transaction call starts.
      // The test then waits for this real event, not a fixed duration.
      // Under CPU contention the event loop can take far longer than any
      // fixed budget to reach this call, so a timer would flake here.
      let notifyFirstTransactionStarted: (() => void) | undefined;
      const firstTransactionStarted = new Promise<void>((resolve) => {
        notifyFirstTransactionStarted = resolve;
      });
      mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
        if (!sawFirstCall) {
          sawFirstCall = true;
          transactionCalls.push("post-start");
          notifyFirstTransactionStarted?.();
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

      // Each route handler awaits listCompanyIds as its last step before it
      // enters the task-drain transition queue, so a second call proves the
      // DELETE passed authorization and reached the queue — not merely that
      // it has not arrived yet.
      let listCompanyIdsCallCount = 0;
      let notifySecondListCompanyIdsCall: (() => void) | undefined;
      const secondListCompanyIdsCall = new Promise<void>((resolve) => {
        notifySecondListCompanyIdsCall = resolve;
      });
      mockInstanceSettingsService.listCompanyIds.mockImplementation(async () => {
        listCompanyIdsCallCount += 1;
        if (listCompanyIdsCallCount === 2) notifySecondListCompanyIdsCall?.();
        return ["company-1", "company-2"];
      });

      const app = await createApp(adminActor);

      // supertest only sends a request once something calls .then() on it,
      // so force the POST to send now instead of waiting for the final
      // Promise.all below to do it.
      const postPromise = request(app).post("/api/instance/task-drain").send({});
      postPromise.then(() => {}, () => {});
      // Wait for the POST's transaction call to start before the test sends
      // the DELETE. At that point the POST already called listCompanyIds,
      // already entered the task-drain transition queue, and sits blocked
      // inside the mocked db.transaction call — the POST holds the queue.
      // Only a real event proves this; a fixed wait would not, because the
      // event loop can take far longer than any fixed budget under CPU
      // contention. Sending the DELETE only after this event fixes the
      // request order by the queue, not by which socket the operating
      // system happens to service first.
      await firstTransactionStarted;
      const deletePromise = request(app).delete("/api/instance/task-drain");
      deletePromise.then(() => {}, () => {});
      // Wait for the DELETE's own listCompanyIds call. It proves the DELETE
      // passed authorization and reached the transition queue behind the
      // POST — not merely that it has not shown up yet.
      await secondListCompanyIdsCall;
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

    describe("terminateActiveTasks option", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("post_task_drain_rejects_terminate_active_tasks_without_a_ttl", async () => {
        const app = await createApp(adminActor);

        const res = await request(app)
          .post("/api/instance/task-drain")
          .send({ terminateActiveTasks: true });

        expect(res.status).toBe(400);
        expect(mockHeartbeatService.applyTaskDrain).not.toHaveBeenCalled();
      });

      it("post_task_drain_accepts_terminate_active_tasks_with_a_ttl_and_reports_terminate_at", async () => {
        const drain = {
          startedAt: "2026-08-29T00:00:00.000Z",
          expiresAt: "2026-08-29T00:01:00.000Z",
          terminateActiveTasks: true,
          terminateAt: new Date(Date.now() + 60 * 60 * 1000),
        };
        mockHeartbeatService.computeTaskDrain.mockReturnValue(drain);
        const app = await createApp(adminActor);

        const res = await request(app)
          .post("/api/instance/task-drain")
          .send({ ttlMs: 60_000, terminateActiveTasks: true });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ...drain, terminateAt: drain.terminateAt.toISOString() });
        expect(mockHeartbeatService.computeTaskDrain).toHaveBeenCalledWith({
          ttlMs: 60_000,
          terminateActiveTasks: true,
        });
      });

      it("post_task_drain_without_the_option_reports_terminate_active_tasks_false_and_a_null_terminate_at", async () => {
        const drain = {
          startedAt: "2026-08-29T00:00:00.000Z",
          expiresAt: null,
          terminateActiveTasks: false,
          terminateAt: null,
        };
        mockHeartbeatService.computeTaskDrain.mockReturnValue(drain);
        const app = await createApp(adminActor);

        const res = await request(app).post("/api/instance/task-drain").send({});

        expect(res.status).toBe(200);
        expect(res.body).toEqual(drain);
        expect(mockHeartbeatService.computeTaskDrain).toHaveBeenCalledWith({
          ttlMs: null,
          terminateActiveTasks: false,
        });
      });

      it("post_task_drain_accepts_the_option_from_a_cloud_control_actor_without_an_extra_permission", async () => {
        // Supplementary coverage only: the principal pinning test runs the
        // real signed assertion through cloudControlMiddleware and this
        // route, in cloud-control-task-drain.test.ts.
        const drain = {
          startedAt: "2026-08-29T00:00:00.000Z",
          expiresAt: "2026-08-29T00:01:00.000Z",
          terminateActiveTasks: true,
          terminateAt: new Date(Date.now() + 60 * 60 * 1000),
        };
        mockHeartbeatService.computeTaskDrain.mockReturnValue(drain);
        const app = await createApp({
          type: "board",
          userId: "paperclip-cloud",
          source: "cloud_control",
          isInstanceAdmin: true,
        });

        const res = await request(app)
          .post("/api/instance/task-drain")
          .send({ ttlMs: 60_000, terminateActiveTasks: true });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ...drain, terminateAt: drain.terminateAt.toISOString() });
      });

      it("post_task_drain_accepts_the_option_from_a_local_instance_admin", async () => {
        const drain = {
          startedAt: "2026-08-29T00:00:00.000Z",
          expiresAt: "2026-08-29T00:01:00.000Z",
          terminateActiveTasks: true,
          terminateAt: new Date(Date.now() + 60 * 60 * 1000),
        };
        mockHeartbeatService.computeTaskDrain.mockReturnValue(drain);
        const app = await createApp({
          type: "board",
          userId: "local-admin",
          source: "local_implicit",
          isInstanceAdmin: false,
        });

        const res = await request(app)
          .post("/api/instance/task-drain")
          .send({ ttlMs: 60_000, terminateActiveTasks: true });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ...drain, terminateAt: drain.terminateAt.toISOString() });
      });

      it("post_task_drain_rejects_the_option_from_a_non_admin_session_actor", async () => {
        const app = await createApp(nonAdminActor);

        const res = await request(app)
          .post("/api/instance/task-drain")
          .send({ ttlMs: 60_000, terminateActiveTasks: true });

        expect(res.status).toBe(403);
        expect(mockHeartbeatService.applyTaskDrain).not.toHaveBeenCalled();
      });

      it("post_task_drain_records_every_arm_time_audit_field_in_the_start_activity_details", async () => {
        const drain = {
          startedAt: "2026-08-29T00:00:00.000Z",
          expiresAt: "2026-08-29T00:01:00.000Z",
          terminateActiveTasks: true,
          terminateAt: new Date(Date.now() + 60 * 60 * 1000),
        };
        mockHeartbeatService.computeTaskDrain.mockReturnValue(drain);
        const app = await createApp(adminActor);

        const res = await request(app)
          .post("/api/instance/task-drain")
          .send({ ttlMs: 60_000, terminateActiveTasks: true });

        expect(res.status).toBe(200);
        expect(mockLogActivity).toHaveBeenCalledTimes(2);
        for (const call of mockLogActivity.mock.calls) {
          expect(call[1]).toMatchObject({
            action: "instance.task_drain.started",
            details: {
              terminateActiveTasks: true,
              startedAt: drain.startedAt,
              expiresAt: drain.expiresAt,
              terminateAt: drain.terminateAt,
              initiatingActor: expect.objectContaining({
                actorSource: "session",
                cloudControlRequestId: null,
              }),
            },
          });
        }
      });

      it("the_timer_stops_each_cancellable_run_at_the_deadline", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(7);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        const app = await createApp(adminActor);

        const res = await request(app)
          .post("/api/instance/task-drain")
          .send({ ttlMs: 60_000, terminateActiveTasks: true });
        expect(res.status).toBe(200);

        await vi.advanceTimersByTimeAsync(30_000);

        expect(mockHeartbeatService.isTaskDrainGenerationLive).toHaveBeenCalledWith(7);
        expect(mockHeartbeatService.terminateActiveRunsForTaskDrain).toHaveBeenCalledTimes(1);
      });

      it("the_timer_does_not_fire_before_the_deadline", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(7);
        const app = await createApp(adminActor);

        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });

        await vi.advanceTimersByTimeAsync(29_999);

        expect(mockHeartbeatService.isTaskDrainGenerationLive).not.toHaveBeenCalled();
        expect(mockHeartbeatService.terminateActiveRunsForTaskDrain).not.toHaveBeenCalled();
      });

      it("a_repeated_post_replaces_the_timer_and_the_replaced_drain_terminates_no_run", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const app = await createApp(adminActor);

        mockHeartbeatService.computeTaskDrain.mockReturnValueOnce({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt: new Date("2026-01-01T00:00:30.000Z"),
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValueOnce(1);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });

        mockHeartbeatService.computeTaskDrain.mockReturnValueOnce({
          startedAt: new Date("2026-01-01T00:00:05.000Z"),
          expiresAt: new Date("2026-01-01T00:02:00.000Z"),
          terminateActiveTasks: true,
          terminateAt: new Date("2026-01-01T00:01:30.000Z"),
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValueOnce(2);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 115_000, terminateActiveTasks: true });

        // The first drain's deadline passes; the repeated POST already
        // cleared its timer, so nothing fires.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(mockHeartbeatService.terminateActiveRunsForTaskDrain).not.toHaveBeenCalled();

        // The second drain's deadline fires its own timer.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mockHeartbeatService.isTaskDrainGenerationLive).toHaveBeenCalledWith(2);
        expect(mockHeartbeatService.terminateActiveRunsForTaskDrain).toHaveBeenCalledTimes(1);
      });

      it("a_delete_cancels_a_scheduled_termination", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.getTaskDrainStatus.mockReturnValue({
          draining: true,
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
          activeRuns: 0,
          pendingWakes: 0,
          quiescent: true,
        });
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });

        const deleteRes = await request(app).delete("/api/instance/task-drain");
        expect(deleteRes.status).toBe(200);

        await vi.advanceTimersByTimeAsync(30_000);

        expect(mockHeartbeatService.isTaskDrainGenerationLive).not.toHaveBeenCalled();
        expect(mockHeartbeatService.terminateActiveRunsForTaskDrain).not.toHaveBeenCalled();
      });

      it("a_callback_that_the_event_loop_already_queued_terminates_no_run_after_a_delete", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        // Model a callback the event loop already queued the instant a stop
        // landed: clearTimeout cannot revoke it, so this proves the
        // generation check inside the transition queue is the actual
        // control — not the clearTimeout call a DELETE also makes.
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(false);
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });

        await vi.advanceTimersByTimeAsync(30_000);

        expect(mockHeartbeatService.isTaskDrainGenerationLive).toHaveBeenCalledWith(1);
        expect(mockHeartbeatService.terminateActiveRunsForTaskDrain).not.toHaveBeenCalled();
      });

      it("the_termination_writes_an_outcome_activity_row_for_each_company", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });
        mockLogActivity.mockClear();
        mockDb.transaction.mockClear();

        await vi.advanceTimersByTimeAsync(30_000);

        expect(mockDb.transaction).toHaveBeenCalledTimes(1);
        const outcomeCalls = mockLogActivity.mock.calls.filter(
          ([, input]: [unknown, { action: string }]) => input.action === "instance.task_drain.active_tasks_terminated",
        );
        expect(outcomeCalls.map(([, input]: [unknown, { companyId: string }]) => input.companyId).sort()).toEqual([
          "company-1",
          "company-2",
        ]);
      });

      it("the_termination_writes_every_outcome_audit_field", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(
          new Map([["company-1", { attemptedRunIds: ["run-1"], cancelledRunIds: ["run-1"], failedRunIds: [] }]]),
        );
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });
        mockLogActivity.mockClear();

        await vi.advanceTimersByTimeAsync(30_000);

        const [company1Call] = mockLogActivity.mock.calls.filter(
          ([, input]: [unknown, { action: string; companyId: string }]) =>
            input.action === "instance.task_drain.active_tasks_terminated" && input.companyId === "company-1",
        );
        expect(company1Call[1].details).toMatchObject({
          terminateAt,
          attemptedRunIds: ["run-1"],
          attemptedRunCount: 1,
          cancelledRunIds: ["run-1"],
          cancelledRunCount: 1,
          failedRunIds: [],
          failedRunCount: 0,
          initiatingActor: expect.objectContaining({ actorSource: "session" }),
        });
        expect(company1Call[1].details.executedAt).toBeInstanceOf(Date);
      });

      it("the_termination_writes_an_outcome_activity_row_with_empty_lists_when_no_run_is_active", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(new Map());
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });
        mockLogActivity.mockClear();

        await vi.advanceTimersByTimeAsync(30_000);

        const outcomeCalls = mockLogActivity.mock.calls.filter(
          ([, input]: [unknown, { action: string }]) => input.action === "instance.task_drain.active_tasks_terminated",
        );
        expect(outcomeCalls).toHaveLength(2);
        for (const [, input] of outcomeCalls as [unknown, Record<string, unknown>][]) {
          expect(input.details).toMatchObject({
            attemptedRunIds: [],
            attemptedRunCount: 0,
            cancelledRunIds: [],
            cancelledRunCount: 0,
            failedRunIds: [],
            failedRunCount: 0,
          });
        }
      });

      it("the_termination_writes_a_partial_outcome_row_that_holds_both_a_cancelled_run_and_a_failed_run", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(
          new Map([
            [
              "company-1",
              { attemptedRunIds: ["run-1", "run-2"], cancelledRunIds: ["run-1"], failedRunIds: ["run-2"] },
            ],
          ]),
        );
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });
        mockLogActivity.mockClear();

        await vi.advanceTimersByTimeAsync(30_000);

        const [company1Call] = mockLogActivity.mock.calls.filter(
          ([, input]: [unknown, { action: string; companyId: string }]) =>
            input.action === "instance.task_drain.active_tasks_terminated" && input.companyId === "company-1",
        );
        expect(company1Call[1].details).toMatchObject({
          attemptedRunIds: ["run-1", "run-2"],
          attemptedRunCount: 2,
          cancelledRunIds: ["run-1"],
          cancelledRunCount: 1,
          failedRunIds: ["run-2"],
          failedRunCount: 1,
        });
      });

      it("the_outcome_activity_row_holds_no_error_text", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(
          new Map([["company-1", { attemptedRunIds: ["run-2"], cancelledRunIds: [], failedRunIds: ["run-2"] }]]),
        );
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });
        mockLogActivity.mockClear();

        await vi.advanceTimersByTimeAsync(30_000);

        const [company1Call] = mockLogActivity.mock.calls.filter(
          ([, input]: [unknown, { action: string; companyId: string }]) =>
            input.action === "instance.task_drain.active_tasks_terminated" && input.companyId === "company-1",
        );
        expect(company1Call[1].details).not.toHaveProperty("error");
        expect(company1Call[1].details).not.toHaveProperty("errorMessage");
        expect(JSON.stringify(company1Call[1].details)).not.toMatch(/error/i);
      });

      it("the_outcome_activity_row_holds_only_the_run_identifiers_of_its_own_company", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(
          new Map([
            ["company-1", { attemptedRunIds: ["run-a"], cancelledRunIds: ["run-a"], failedRunIds: [] }],
            ["company-2", { attemptedRunIds: ["run-b"], cancelledRunIds: ["run-b"], failedRunIds: [] }],
          ]),
        );
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });
        mockLogActivity.mockClear();

        await vi.advanceTimersByTimeAsync(30_000);

        const outcomeCalls = mockLogActivity.mock.calls.filter(
          ([, input]: [unknown, { action: string }]) => input.action === "instance.task_drain.active_tasks_terminated",
        ) as [unknown, { companyId: string; details: { attemptedRunIds: string[] } }][];
        const company1Details = outcomeCalls.find(([, input]) => input.companyId === "company-1")?.[1].details;
        const company2Details = outcomeCalls.find(([, input]) => input.companyId === "company-2")?.[1].details;
        expect(company1Details?.attemptedRunIds).toEqual(["run-a"]);
        expect(company2Details?.attemptedRunIds).toEqual(["run-b"]);
      });

      // These two tests use the real clock, not vi.useFakeTimers(): a real
      // POST/DELETE HTTP round trip followed by an advanced fake clock is
      // unreliable in this suite (the fake timer queue does not resolve a
      // second supertest request the same way it resolves the first). A
      // short real delay proves the same behavior without that coupling.
      it("re_arms_the_prior_deadline_when_a_replacing_post_fails_after_clearing_the_timer", async () => {
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        const app = await createApp(adminActor);

        const firstTerminateAt = new Date(Date.now() + 100);
        mockHeartbeatService.computeTaskDrain.mockReturnValueOnce({
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 1000),
          terminateActiveTasks: true,
          terminateAt: firstTerminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValueOnce(1);
        const firstRes = await request(app)
          .post("/api/instance/task-drain")
          .send({ ttlMs: 1000, terminateActiveTasks: true });
        expect(firstRes.status).toBe(200);

        // The replacing POST clears the first timer, then its own audit
        // write fails, so the request as a whole fails.
        mockHeartbeatService.computeTaskDrain.mockReturnValueOnce({
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 100_000),
          terminateActiveTasks: true,
          terminateAt: new Date(Date.now() + 100_000),
        });
        mockLogActivity.mockRejectedValueOnce(new Error("activity insert failed"));
        const secondRes = await request(app)
          .post("/api/instance/task-drain")
          .send({ ttlMs: 100_000, terminateActiveTasks: true });
        expect(secondRes.status).toBeGreaterThanOrEqual(500);
        // The second drain never applied, so the first one is still live.
        expect(mockHeartbeatService.applyTaskDrain).toHaveBeenCalledTimes(1);

        // The first drain's original deadline still fires: the failed
        // replacement re-armed the timer it had cleared.
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(mockHeartbeatService.isTaskDrainGenerationLive).toHaveBeenCalledWith(1);
        expect(mockHeartbeatService.terminateActiveRunsForTaskDrain).toHaveBeenCalledTimes(1);
      });

      it("re_arms_the_deadline_when_a_delete_fails_after_clearing_the_timer", async () => {
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        const terminateAt = new Date(Date.now() + 100);
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 1000),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.getTaskDrainStatus.mockReturnValue({
          draining: true,
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 1000),
          terminateActiveTasks: true,
          terminateAt,
          activeRuns: 0,
          pendingWakes: 0,
          quiescent: true,
        });
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 1000, terminateActiveTasks: true });

        // The DELETE clears the timer, then its own audit write fails, so
        // the request as a whole fails and the drain never stops.
        mockLogActivity.mockRejectedValueOnce(new Error("activity insert failed"));
        const deleteRes = await request(app).delete("/api/instance/task-drain");
        expect(deleteRes.status).toBeGreaterThanOrEqual(500);
        expect(mockHeartbeatService.stopTaskDrain).not.toHaveBeenCalled();

        // The deadline still fires: the failed stop re-armed the timer it
        // had cleared.
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(mockHeartbeatService.isTaskDrainGenerationLive).toHaveBeenCalledWith(1);
        expect(mockHeartbeatService.terminateActiveRunsForTaskDrain).toHaveBeenCalledTimes(1);
      });

      it("retries_the_outcome_audit_write_on_a_transient_connection_drop_and_still_records_it", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(
          new Map([["company-1", { attemptedRunIds: ["run-1"], cancelledRunIds: ["run-1"], failedRunIds: [] }]]),
        );
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });
        mockLogActivity.mockClear();

        // The first company-list read after the runs are already cancelled
        // hits a transient closed-connection error; the retry then
        // succeeds, so the outcome still gets written.
        const transientErr = Object.assign(new Error("write CONNECTION_CLOSED db.example.internal:5432"), {
          code: "CONNECTION_CLOSED",
        });
        mockInstanceSettingsService.listCompanyIds.mockRejectedValueOnce(transientErr);

        await vi.advanceTimersByTimeAsync(30_200);

        const outcomeCalls = mockLogActivity.mock.calls.filter(
          ([, input]: [unknown, { action: string }]) => input.action === "instance.task_drain.active_tasks_terminated",
        );
        expect(outcomeCalls).toHaveLength(2);
      });

      it("does_not_duplicate_the_outcome_row_when_a_retry_finds_a_prior_attempt_already_committed", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(
          new Map([["company-1", { attemptedRunIds: ["run-1"], cancelledRunIds: ["run-1"], failedRunIds: [] }]]),
        );
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });
        mockLogActivity.mockClear();
        mockDb.transaction.mockClear();
        mockInstanceSettingsService.listCompanyIds.mockClear();

        // A connection can drop after the server commits the outcome
        // transaction but before the driver reports success back. Model
        // that: an existing row for this exact termination is already in
        // the table when the deadline handler runs, exactly as it would be
        // after that kind of ambiguous failure. The write must not repeat.
        mockDb.select.mockImplementation(() => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ id: "activity-already-written" }]),
            }),
          }),
        }));

        await vi.advanceTimersByTimeAsync(30_000);

        expect(mockDb.transaction).not.toHaveBeenCalled();
        expect(mockLogActivity).not.toHaveBeenCalled();
        expect(mockInstanceSettingsService.listCompanyIds).not.toHaveBeenCalled();
      });

      it("does_not_treat_a_pre_restart_activity_row_as_a_duplicate_of_a_same_numbered_generation", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        // The in-memory generation counter starts at 0 on every process
        // boot, so a fresh process can hand out generation 1 again. Model
        // that here: this run's own generation is 1, standing in for a
        // process restart after an earlier, unrelated termination also
        // held generation 1.
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(
          new Map([["company-1", { attemptedRunIds: ["run-1"], cancelledRunIds: ["run-1"], failedRunIds: [] }]]),
        );

        // A row already sits in the table under the dedup key a
        // generation-only scheme would have used for generation 1. It
        // belongs to that earlier, unrelated termination — a real
        // termination from before the restart — not to this run.
        const preRestartEntityId = "task-drain-termination:1";
        let queriedEntityId: string | null = null;
        mockDb.select.mockImplementation(() => ({
          from: () => ({
            where: (condition: unknown) => ({
              limit: () => {
                const boundValues: string[] = [];
                collectBoundParamValues(condition, boundValues);
                queriedEntityId =
                  boundValues.find((value) => value.startsWith("task-drain-termination:")) ?? null;
                const matchesPreRestartRow = queriedEntityId === preRestartEntityId;
                return Promise.resolve(
                  matchesPreRestartRow ? [{ id: "activity-from-before-restart" }] : [],
                );
              },
            }),
          }),
        }));

        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });
        mockLogActivity.mockClear();
        mockDb.transaction.mockClear();

        await vi.advanceTimersByTimeAsync(30_000);

        // The dedup key this run queried with must not be the plain
        // generation number, and it must not match the pre-restart row —
        // otherwise this run's own outcome audit would be silently
        // skipped as an apparent duplicate of a termination it never ran.
        expect(queriedEntityId).not.toBeNull();
        expect(queriedEntityId).not.toBe(preRestartEntityId);
        expect(mockDb.transaction).toHaveBeenCalledTimes(1);
        expect(mockLogActivity).toHaveBeenCalledWith(
          TX_SENTINEL,
          expect.objectContaining({ action: "instance.task_drain.active_tasks_terminated" }),
          expect.any(Array),
        );
      });

      it("logs_the_full_termination_outcome_when_the_audit_write_cannot_be_retried_into_success", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const terminateAt = new Date("2026-01-01T00:00:30.000Z");
        mockHeartbeatService.computeTaskDrain.mockReturnValue({
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
          terminateActiveTasks: true,
          terminateAt,
        });
        mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
        mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
        mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(
          new Map([["company-1", { attemptedRunIds: ["run-1"], cancelledRunIds: ["run-1"], failedRunIds: [] }]]),
        );
        const app = await createApp(adminActor);
        await request(app).post("/api/instance/task-drain").send({ ttlMs: 60_000, terminateActiveTasks: true });
        mockLogActivity.mockClear();

        const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
        // A non-transient failure (no closed-connection code) is not
        // retried; the runs are already cancelled, so this must not throw
        // out of the deadline handler unlogged.
        mockInstanceSettingsService.listCompanyIds.mockRejectedValue(new Error("permanently unavailable"));

        await vi.advanceTimersByTimeAsync(30_000);

        const recoveryCall = loggerErrorSpy.mock.calls.find(
          ([, message]) =>
            message === "task drain termination ran but its audit record failed to write; recover the outcome from this log entry",
        );
        expect(recoveryCall).toBeDefined();
        expect(recoveryCall?.[0]).toMatchObject({
          generation: 1,
          outcomesByCompany: {
            "company-1": { attemptedRunIds: ["run-1"], cancelledRunIds: ["run-1"], failedRunIds: [] },
          },
        });
        expect(mockLogActivity).not.toHaveBeenCalled();
        loggerErrorSpy.mockRestore();
      });
    });
  });
});
