import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  getExperimental: vi.fn(),
  updateGeneral: vi.fn(),
  updateExperimental: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  buildIssueGraphLivenessAutoRecoveryPreview: vi.fn(),
  reconcileIssueGraphLiveness: vi.fn(),
}));
const mockDataRecoveryService = vi.hoisted(() => ({
  deletePermanent: vi.fn(),
  details: vi.fn(),
  list: vi.fn(),
  renameAgent: vi.fn(),
  restore: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    dataRecoveryService: () => mockDataRecoveryService,
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
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
    mockInstanceSettingsService.getGeneral.mockReset();
    mockInstanceSettingsService.getExperimental.mockReset();
    mockInstanceSettingsService.updateGeneral.mockReset();
    mockInstanceSettingsService.updateExperimental.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockHeartbeatService.buildIssueGraphLivenessAutoRecoveryPreview.mockReset();
    mockHeartbeatService.reconcileIssueGraphLiveness.mockReset();
    mockDataRecoveryService.list.mockReset();
    mockDataRecoveryService.details.mockReset();
    mockDataRecoveryService.restore.mockReset();
    mockDataRecoveryService.renameAgent.mockReset();
    mockDataRecoveryService.deletePermanent.mockReset();
    mockLogActivity.mockReset();
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
      enableCloudSync: false,
      autoRestartDevServerWhenIdle: false,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
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
        enableCloudSync: true,
        autoRestartDevServerWhenIdle: false,
        enableIssueGraphLivenessAutoRecovery: true,
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
    mockDataRecoveryService.list.mockResolvedValue([
      {
        id: "agent-1",
        type: "agent",
        name: "Recovery Test Agent",
        state: "terminated",
        removedAt: "2026-05-15T12:00:00.000Z",
        companyId: "company-1",
        companyName: "Paperclip",
        companyStatus: "active",
        projectId: null,
        projectName: null,
        href: "/PAP/agents/recovery-test-agent",
        restoreBlockedReason: null,
      },
    ]);
    mockDataRecoveryService.restore.mockResolvedValue({
      id: "agent-1",
      type: "agent",
      name: "Recovery Test Agent",
      state: "terminated",
      removedAt: null,
      companyId: "company-1",
      companyName: "Paperclip",
      companyStatus: "active",
      projectId: null,
      projectName: null,
      href: "/PAP/agents/recovery-test-agent",
      restoreBlockedReason: null,
    });
    mockDataRecoveryService.details.mockResolvedValue({
      item: {
        id: "agent-1",
        type: "agent",
        name: "Recovery Test Agent",
        state: "terminated",
        removedAt: "2026-05-15T12:00:00.000Z",
        companyId: "company-1",
        companyName: "Paperclip",
        companyStatus: "active",
        projectId: null,
        projectName: null,
        href: "/PAP/agents/recovery-test-agent",
        restoreBlockedReason: null,
      },
      details: [
        { label: "ID", value: "agent-1" },
        { label: "Name", value: "Recovery Test Agent" },
      ],
    });
    mockDataRecoveryService.deletePermanent.mockResolvedValue({
      id: "agent-1",
      type: "agent",
      name: "Recovery Test Agent",
      state: "terminated",
      removedAt: "2026-05-15T12:00:00.000Z",
      companyId: "company-1",
      companyName: "Paperclip",
      companyStatus: "active",
      projectId: null,
      projectName: null,
      href: "/PAP/agents/recovery-test-agent",
      restoreBlockedReason: null,
    });
    mockDataRecoveryService.renameAgent.mockResolvedValue({
      id: "agent-1",
      type: "agent",
      name: "Recovery Test Agent agent-1",
      state: "terminated",
      removedAt: "2026-05-15T12:00:00.000Z",
      companyId: "company-1",
      companyName: "Paperclip",
      companyStatus: "active",
      projectId: null,
      projectName: null,
      href: "/PAP/agents/recovery-test-agent-agent-1",
      restoreBlockedReason: null,
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
      enableCloudSync: false,
      autoRestartDevServerWhenIdle: false,
      enableIssueGraphLivenessAutoRecovery: true,
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

  it("lists recoverable data for instance admins", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .get("/api/instance/settings/data-recovery")
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: "agent-1",
      type: "agent",
      state: "terminated",
    });
    expect(mockDataRecoveryService.list).toHaveBeenCalledOnce();
  });

  it("restores recoverable data and logs the action", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/instance/settings/data-recovery/agent/agent-1/restore")
      .send({})
      .expect(200);

    expect(res.body.item).toMatchObject({ id: "agent-1", type: "agent" });
    expect(mockDataRecoveryService.restore).toHaveBeenCalledWith("agent", "agent-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "instance.data_recovery.restored",
        entityType: "agent",
        entityId: "agent-1",
      }),
    );
  });

  it("inspects recoverable data details", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .get("/api/instance/settings/data-recovery/agent/agent-1")
      .expect(200);

    expect(res.body.details).toContainEqual({ label: "Name", value: "Recovery Test Agent" });
    expect(mockDataRecoveryService.details).toHaveBeenCalledWith("agent", "agent-1");
  });

  it("rejects unsupported recoverable data types before calling the service", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .get("/api/instance/settings/data-recovery/workspace/workspace-1")
      .expect(422);

    expect(res.body.error).toContain("Unsupported recoverable item type");
    expect(mockDataRecoveryService.details).not.toHaveBeenCalled();
  });

  it("permanently deletes recoverable data and logs the action", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .delete("/api/instance/settings/data-recovery/agent/agent-1")
      .expect(200);

    expect(res.body.item).toMatchObject({ id: "agent-1", type: "agent" });
    expect(mockDataRecoveryService.deletePermanent).toHaveBeenCalledWith("agent", "agent-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "instance.data_recovery.deleted",
        entityType: "agent",
        entityId: "agent-1",
      }),
    );
  });

  it("renames a recoverable terminated agent and logs the action", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/instance/settings/data-recovery/agent/agent-1/rename")
      .send({ name: "Recovery Test Agent agent-1" })
      .expect(200);

    expect(res.body.item).toMatchObject({
      id: "agent-1",
      name: "Recovery Test Agent agent-1",
      restoreBlockedReason: null,
    });
    expect(mockDataRecoveryService.renameAgent).toHaveBeenCalledWith("agent-1", "Recovery Test Agent agent-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "instance.data_recovery.renamed",
        entityType: "agent",
        entityId: "agent-1",
      }),
    );
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
