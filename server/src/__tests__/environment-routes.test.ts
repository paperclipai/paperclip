import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentRoutes } from "../routes/environments.js";
import { errorHandler } from "../middleware/index.js";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  decide: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
  getGeneral: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  removeIfDeletable: vi.fn(),
  getDeleteBlastRadius: vi.fn(),
  listLeases: vi.fn(),
  getLeaseById: vi.fn(),
}));

const mockEnvironmentCustomImageService = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getActiveTemplate: vi.fn(),
  getSessionById: vi.fn(),
  startSetupSession: vi.fn(),
  refreshSetupSession: vi.fn(),
  finishSetupSession: vi.fn(),
  cancelSetupSession: vi.fn(),
  rollbackTemplate: vi.fn(),
  disableTemplate: vi.fn(),
  cleanupExpiredSetupSessions: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockProbeEnvironment = vi.hoisted(() => vi.fn());
const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  normalizeEnvBindingsForPersistence: vi.fn(),
  listBindingCompanyIdsForTarget: vi.fn(),
  resolveSecretValue: vi.fn(),
  resolveSecretValueForEphemeralAccess: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(),
  syncSecretRefsForTarget: vi.fn(),
  remove: vi.fn(),
}));
const mockValidatePluginEnvironmentDriverConfig = vi.hoisted(() => vi.fn());
const mockValidatePluginSandboxProviderConfig = vi.hoisted(() => vi.fn());
const mockListReadyPluginEnvironmentDrivers = vi.hoisted(() => vi.fn());
const mockResolvePluginSandboxProviderDriverByKey = vi.hoisted(() => vi.fn());
const mockStartPluginEnvironmentInteractiveSetup = vi.hoisted(() => vi.fn());
const mockGetPluginEnvironmentInteractiveSetup = vi.hoisted(() => vi.fn());
const mockCapturePluginEnvironmentTemplate = vi.hoisted(() => vi.fn());
const mockCancelPluginEnvironmentInteractiveSetup = vi.hoisted(() => vi.fn());
const mockDeletePluginEnvironmentTemplate = vi.hoisted(() => vi.fn());
const mockExecutionWorkspaceService = vi.hoisted(() => ({
  clearEnvironmentSelection: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  instanceSettingsService: () => mockInstanceSettingsService,
  environmentCustomImageService: () => mockEnvironmentCustomImageService,
  environmentService: () => mockEnvironmentService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
}));

vi.mock("../services/environment-probe.js", () => ({
  probeEnvironment: mockProbeEnvironment,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

vi.mock("../services/plugin-environment-driver.js", () => ({
  listReadyPluginEnvironmentDrivers: mockListReadyPluginEnvironmentDrivers,
  resolvePluginSandboxProviderDriverByKey: mockResolvePluginSandboxProviderDriverByKey,
  startPluginEnvironmentInteractiveSetup: mockStartPluginEnvironmentInteractiveSetup,
  getPluginEnvironmentInteractiveSetup: mockGetPluginEnvironmentInteractiveSetup,
  capturePluginEnvironmentTemplate: mockCapturePluginEnvironmentTemplate,
  cancelPluginEnvironmentInteractiveSetup: mockCancelPluginEnvironmentInteractiveSetup,
  deletePluginEnvironmentTemplate: mockDeletePluginEnvironmentTemplate,
  validatePluginEnvironmentDriverConfig: mockValidatePluginEnvironmentDriverConfig,
  validatePluginSandboxProviderConfig: mockValidatePluginSandboxProviderConfig,
}));

function createEnvironment() {
  const now = new Date("2026-04-16T05:00:00.000Z");
  return {
    id: "env-1",
    companyId: "company-1",
    name: "Local",
    description: "Current development machine",
    driver: "local",
    status: "active" as const,
    config: { shell: "zsh" },
    envVars: {},
    metadata: { source: "manual" },
    createdAt: now,
    updatedAt: now,
  };
}

function createDeleteBlastRadius(overrides: Partial<{
  isManagedLocal: boolean;
  isInstanceDefault: boolean;
  agentDefaultCount: number;
  executionWorkspaceSelectionCount: number;
  issueSelectionCount: number;
  projectSelectionCount: number;
  secretBindingCount: number;
  activeLeaseCount: number;
  activeCustomImageSetupSessionCount: number;
}> = {}) {
  const staticReferences = {
    isManagedLocal: overrides.isManagedLocal ?? false,
    isInstanceDefault: overrides.isInstanceDefault ?? false,
    agentDefaultCount: overrides.agentDefaultCount ?? 0,
    executionWorkspaceSelectionCount: overrides.executionWorkspaceSelectionCount ?? 0,
    issueSelectionCount: overrides.issueSelectionCount ?? 0,
    projectSelectionCount: overrides.projectSelectionCount ?? 0,
    secretBindingCount: overrides.secretBindingCount ?? 0,
  };
  const activeRuntimeUse = {
    activeLeaseCount: overrides.activeLeaseCount ?? 0,
    activeCustomImageSetupSessionCount: overrides.activeCustomImageSetupSessionCount ?? 0,
    hasActiveRuntimeUse:
      (overrides.activeLeaseCount ?? 0) > 0
      || (overrides.activeCustomImageSetupSessionCount ?? 0) > 0,
  };
  const deleteBlockedReasons = [
    ...(staticReferences.isManagedLocal ? ["managed_local" as const] : []),
    ...(staticReferences.isInstanceDefault ? ["instance_default" as const] : []),
  ];
  return {
    environmentId: "env-1",
    canDelete: deleteBlockedReasons.length === 0,
    deleteBlockedReasons,
    staticReferences,
    activeRuntimeUse,
  };
}

let server: Server | null = null;
let currentActor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  source: "local_implicit",
};
const routeOptions: Record<string, unknown> = {};
const originalSecretsProviderEnv = process.env.PAPERCLIP_SECRETS_PROVIDER;

function createApp(actor: Record<string, unknown>, options: Record<string, unknown> = {}) {
  currentActor = actor;
  for (const key of Object.keys(routeOptions)) {
    delete routeOptions[key];
  }
  Object.assign(routeOptions, options);
  if (server) return server;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = currentActor;
    next();
  });
  app.use("/api", environmentRoutes({} as any, routeOptions as any));
  app.use(errorHandler);
  server = app.listen(0);
  return server;
}

describe("environment routes", () => {
  afterAll(async () => {
    if (originalSecretsProviderEnv === undefined) {
      delete process.env.PAPERCLIP_SECRETS_PROVIDER;
    } else {
      process.env.PAPERCLIP_SECRETS_PROVIDER = originalSecretsProviderEnv;
    }
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    server = null;
  });

  beforeEach(() => {
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAccessService.decide.mockReset();
    mockAgentService.getById.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockProjectService.getById.mockReset();
    mockProjectService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockInstanceSettingsService.getGeneral.mockReset();
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockEnvironmentService.list.mockReset();
    mockEnvironmentService.list.mockResolvedValue([]);
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.create.mockReset();
    mockEnvironmentService.update.mockReset();
    mockEnvironmentService.removeIfDeletable.mockReset();
    mockEnvironmentService.getDeleteBlastRadius.mockReset();
    mockEnvironmentService.listLeases.mockReset();
    mockEnvironmentService.getLeaseById.mockReset();
    mockExecutionWorkspaceService.clearEnvironmentSelection.mockReset();
    Object.values(mockEnvironmentCustomImageService).forEach((mock) => mock.mockReset());
    mockEnvironmentCustomImageService.getOverview.mockResolvedValue({
      activeTemplate: null,
      activeSession: null,
      latestSession: null,
    });
    mockEnvironmentCustomImageService.getActiveTemplate.mockResolvedValue(null);
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(null);
    mockLogActivity.mockReset();
    mockProbeEnvironment.mockReset();
    mockSecretService.create.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockReset();
    mockSecretService.listBindingCompanyIdsForTarget.mockReset();
    mockSecretService.resolveSecretValue.mockReset();
    mockSecretService.resolveSecretValueForEphemeralAccess.mockReset();
    mockSecretService.syncEnvBindingsForTarget.mockReset();
    mockSecretService.syncSecretRefsForTarget.mockReset();
    mockSecretService.remove.mockReset();
    mockSecretService.create.mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111",
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockIssueService.clearExecutionWorkspaceEnvironmentSelection.mockResolvedValue(0);
    mockProjectService.clearExecutionWorkspaceEnvironmentSelection.mockResolvedValue(0);
    mockExecutionWorkspaceService.clearEnvironmentSelection.mockResolvedValue(0);
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env ?? {});
    mockSecretService.listBindingCompanyIdsForTarget.mockResolvedValue([]);
    mockSecretService.syncEnvBindingsForTarget.mockResolvedValue([]);
    mockSecretService.syncSecretRefsForTarget.mockResolvedValue([]);
    mockSecretService.remove.mockResolvedValue(null);
    mockSecretService.resolveSecretValueForEphemeralAccess.mockResolvedValue("resolved-provider-key");
    delete process.env.PAPERCLIP_SECRETS_PROVIDER;
    mockValidatePluginEnvironmentDriverConfig.mockReset();
    mockValidatePluginEnvironmentDriverConfig.mockImplementation(async ({ config }) => config);
    mockValidatePluginSandboxProviderConfig.mockReset();
    mockValidatePluginSandboxProviderConfig.mockImplementation(async ({ provider, config }) => ({
      normalizedConfig: config,
      pluginId: `plugin-${provider}`,
      pluginKey: `plugin.${provider}`,
      driver: {
        driverKey: provider,
        kind: "sandbox_provider",
        displayName: provider,
        configSchema: { type: "object" },
      },
    }));
    mockResolvePluginSandboxProviderDriverByKey.mockReset();
    mockResolvePluginSandboxProviderDriverByKey.mockImplementation(async ({ driverKey }) => (
      driverKey === "secure-plugin"
        ? {
            pluginId: "plugin-secure",
            pluginKey: "acme.secure-sandbox-provider",
            driver: {
              driverKey: "secure-plugin",
              kind: "sandbox_provider",
              displayName: "Secure Sandbox",
              configSchema: {
                type: "object",
                properties: {
                  template: { type: "string" },
                  apiKey: { type: "string", format: "secret-ref" },
                  timeoutMs: { type: "number" },
                  reuseLease: { type: "boolean" },
                },
              },
            },
          }
        : null
    ));
    mockListReadyPluginEnvironmentDrivers.mockReset();
    mockListReadyPluginEnvironmentDrivers.mockResolvedValue([]);
    mockStartPluginEnvironmentInteractiveSetup.mockReset();
    mockGetPluginEnvironmentInteractiveSetup.mockReset();
    mockCapturePluginEnvironmentTemplate.mockReset();
    mockCancelPluginEnvironmentInteractiveSetup.mockReset();
    mockDeletePluginEnvironmentTemplate.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      explanation: "Allowed by test harness",
    });
  });

  it("lists instance-scoped environments through the company route alias", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/environments?driver=local");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockEnvironmentService.list).toHaveBeenCalledWith({
      status: undefined,
      driver: "local",
    });
  });

  it("redacts environment config for non-admin board readers", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "user-2",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/companies/company-1/environments");

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      id: "env-1",
      name: "Local",
      config: {},
      envVars: {},
      metadata: null,
    });
  });

  it("redacts environment detail config for non-admin board readers", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    const app = createApp({
      type: "board",
      userId: "user-2",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/environments/env-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "env-1",
      config: {},
      envVars: {},
      metadata: null,
    });
  });

  describe("platform-provisioned environment floor on cloud-managed instances", () => {
    function createPlatformSandboxEnvironment() {
      const now = new Date("2026-04-16T05:00:00.000Z");
      return {
        id: "env-managed-1",
        companyId: "company-1",
        name: "Daytona",
        description: "Managed sandbox environment",
        driver: "sandbox",
        status: "active" as const,
        config: {
          provider: "daytona",
          image: "custom-image:latest",
          target: "us",
          apiKey: "must-never-echo",
        },
        envVars: { DAYTONA_API_KEY: "must-never-echo" },
        metadata: { managedByPaperclip: true, managedSandboxProvider: "daytona" },
        createdAt: now,
        updatedAt: now,
      };
    }

    const ownerAdminActor = {
      type: "board",
      userId: "owner-1",
      source: "cloud_tenant",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "owner" }],
      isInstanceAdmin: true,
    };

    // A minimal valid managed-config document whose `environments` entry makes
    // the managed-sandbox provisioner own the marked sandbox slot row.
    const MANAGED_CONFIG_WITH_SANDBOX_ENTRY = JSON.stringify({
      v: 1,
      mode: "cloud",
      catalogVersion: "2026.720.0",
      features: {},
      plugins: { autoInstall: [] },
      environments: [{ name: "Sandbox", provider: "daytona" }],
    });

    beforeEach(() => {
      process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
    });
    afterEach(() => {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    });

    it("never echoes env vars or credential-shaped config keys to instance admins", async () => {
      mockEnvironmentService.getById.mockResolvedValue(createPlatformSandboxEnvironment());
      const app = createApp(ownerAdminActor);

      const res = await request(app).get("/api/environments/env-managed-1");

      expect(res.status).toBe(200);
      expect(res.body.envVars).toEqual({});
      expect(res.body.config).toEqual({
        provider: "daytona",
        image: "custom-image:latest",
        target: "us",
      });
      expect(res.body.metadata).toMatchObject({ managedByPaperclip: true });
      expect(JSON.stringify(res.body)).not.toContain("must-never-echo");
    });

    it("exposes structural config to restricted company readers instead of blanking it", async () => {
      mockEnvironmentService.list.mockResolvedValue([createPlatformSandboxEnvironment()]);
      const app = createApp({
        type: "board",
        userId: "user-2",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
        isInstanceAdmin: false,
      });

      const res = await request(app).get("/api/companies/company-1/environments");

      expect(res.status).toBe(200);
      expect(res.body[0].config).toEqual({
        provider: "daytona",
        image: "custom-image:latest",
        target: "us",
      });
      expect(res.body[0].envVars).toEqual({});
      expect(res.body[0].metadata).toMatchObject({ managedByPaperclip: true });
    });

    it("rejects updates to platform-provisioned rows, including for instance admins", async () => {
      mockEnvironmentService.getById.mockResolvedValue(createPlatformSandboxEnvironment());
      const app = createApp(ownerAdminActor);

      const res = await request(app).patch("/api/environments/env-managed-1").send({ name: "Renamed" });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "environment_platform_managed" });
      expect(mockEnvironmentService.update).not.toHaveBeenCalled();
    });

    it("allows a marker-clear-only patch to unblock a row with a stale legacy kubernetes marker", async () => {
      // A sandbox row carrying only the legacy wrapper marker does not hold
      // the managed sandbox slot (`environments_managed_sandbox_idx` keys on
      // `managedByPaperclip`), and with the persisted execution mode not
      // forcing kubernetes nothing selects rows by that marker either — so
      // the marker is a stale leftover, not live platform state.
      const staleRow = {
        ...createPlatformSandboxEnvironment(),
        id: "env-legacy-1",
        metadata: { managedKubernetesSandbox: true },
      };
      mockEnvironmentService.getById.mockResolvedValue(staleRow);
      mockEnvironmentService.update.mockResolvedValue({ ...staleRow, metadata: {} });
      const app = createApp(ownerAdminActor);

      const res = await request(app)
        .patch("/api/environments/env-legacy-1")
        .send({ metadata: { managedKubernetesSandbox: false } });

      expect(res.status).toBe(200);
      expect(mockEnvironmentService.update).toHaveBeenCalled();
    });

    it("allows a marker-clear-only patch on a non-slot driver with a stale platform marker", async () => {
      const staleRow = {
        ...createPlatformSandboxEnvironment(),
        id: "env-stale-ssh-1",
        driver: "ssh",
        metadata: { managedByPaperclip: true },
      };
      mockEnvironmentService.getById.mockResolvedValue(staleRow);
      mockEnvironmentService.update.mockResolvedValue({ ...staleRow, metadata: {} });
      const app = createApp(ownerAdminActor);

      const res = await request(app)
        .patch("/api/environments/env-stale-ssh-1")
        .send({ metadata: { managedByPaperclip: false, managedKubernetesSandbox: false } });

      expect(res.status).toBe(200);
      expect(mockEnvironmentService.update).toHaveBeenCalled();
    });

    it("refuses the marker-clear patch on the sandbox slot row while managed provisioning is configured", async () => {
      // With a managed-config `environments` entry, driver=sandbox +
      // managedByPaperclip is THE provisioner-owned slot row, adopted and
      // refreshed on every boot — clearing its markers would reclassify it
      // tenant-managed and let the next PATCH/DELETE bypass the write floor.
      process.env.PAPERCLIP_MANAGED_CONFIG = MANAGED_CONFIG_WITH_SANDBOX_ENTRY;
      try {
        mockEnvironmentService.getById.mockResolvedValue(createPlatformSandboxEnvironment());
        const app = createApp(ownerAdminActor);

        const res = await request(app)
          .patch("/api/environments/env-managed-1")
          .send({ metadata: { managedByPaperclip: false, managedKubernetesSandbox: false } });

        expect(res.status).toBe(403);
        expect(res.body.details).toMatchObject({ code: "environment_platform_managed" });
        expect(mockEnvironmentService.update).not.toHaveBeenCalled();
      } finally {
        delete process.env.PAPERCLIP_MANAGED_CONFIG;
      }
    });

    it("refuses the marker-clear patch on the sandbox slot row under the forced kubernetes execution mode", async () => {
      // PAPERCLIP_EXECUTION_MODE=kubernetes is the other bootstrap path that
      // owns (adopts and refreshes) the single marked sandbox row.
      process.env.PAPERCLIP_EXECUTION_MODE = "kubernetes";
      try {
        mockEnvironmentService.getById.mockResolvedValue(createPlatformSandboxEnvironment());
        const app = createApp(ownerAdminActor);

        const res = await request(app)
          .patch("/api/environments/env-managed-1")
          .send({ metadata: { managedByPaperclip: false, managedKubernetesSandbox: false } });

        expect(res.status).toBe(403);
        expect(res.body.details).toMatchObject({ code: "environment_platform_managed" });
        expect(mockEnvironmentService.update).not.toHaveBeenCalled();
      } finally {
        delete process.env.PAPERCLIP_EXECUTION_MODE;
      }
    });

    it("refuses the marker-clear patch on a kubernetes-marked row while the persisted execution mode forces kubernetes", async () => {
      // `findKubernetesEnvironment` selects sandbox rows by the legacy
      // marker alone whenever the persisted executionMode forces kubernetes
      // — including when the bootstrap env that seeded the setting is gone
      // (rollback / config drift, which the heartbeat handles explicitly).
      // Clearing the marker would declassify the live runtime row.
      mockInstanceSettingsService.getGeneral.mockResolvedValue({ executionMode: "kubernetes" });
      mockEnvironmentService.getById.mockResolvedValue({
        ...createPlatformSandboxEnvironment(),
        id: "env-legacy-1",
        metadata: { managedKubernetesSandbox: true },
      });
      const app = createApp(ownerAdminActor);

      const res = await request(app)
        .patch("/api/environments/env-legacy-1")
        .send({ metadata: { managedKubernetesSandbox: false } });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "environment_platform_managed" });
      expect(mockEnvironmentService.update).not.toHaveBeenCalled();
    });

    it("refuses the marker-clear patch on the kubernetes-managed row when only the persisted execution mode remains forced", async () => {
      // Drift variant with the fully-stamped managed row: no managed-config
      // entry and no bootstrap env, but the persisted executionMode still
      // forces kubernetes, so the marker keeps selecting this row for runs.
      mockInstanceSettingsService.getGeneral.mockResolvedValue({ executionMode: "kubernetes" });
      mockEnvironmentService.getById.mockResolvedValue({
        ...createPlatformSandboxEnvironment(),
        metadata: {
          managedByPaperclip: true,
          managedSandboxProvider: "kubernetes",
          managedKubernetesSandbox: true,
        },
      });
      const app = createApp(ownerAdminActor);

      const res = await request(app)
        .patch("/api/environments/env-managed-1")
        .send({ metadata: { managedByPaperclip: false, managedKubernetesSandbox: false } });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "environment_platform_managed" });
      expect(mockEnvironmentService.update).not.toHaveBeenCalled();
    });

    it("allows the marker-clear patch on a marked sandbox row when no provisioning path is configured", async () => {
      // Without a managed-config `environments` entry or a forced execution
      // mode, nothing on this instance provisions a sandbox environment, so a
      // platform marker on a sandbox row can only be a stale leftover of the
      // old unrestricted API — the recovery hatch must apply or the row is
      // locked forever.
      const staleRow = createPlatformSandboxEnvironment();
      mockEnvironmentService.getById.mockResolvedValue(staleRow);
      mockEnvironmentService.update.mockResolvedValue({ ...staleRow, metadata: {} });
      const app = createApp(ownerAdminActor);

      const res = await request(app)
        .patch("/api/environments/env-managed-1")
        .send({ metadata: { managedByPaperclip: false, managedKubernetesSandbox: false } });

      expect(res.status).toBe(200);
      expect(mockEnvironmentService.update).toHaveBeenCalled();
    });

    it("refuses the marker-clear patch on the managed local row", async () => {
      // The local slot needs no configuration check: on a cloud-managed
      // instance `ensureLocalEnvironment` adopts and stamps the single local
      // row from every caller, so its markers are always live platform state.
      mockEnvironmentService.getById.mockResolvedValue({
        ...createPlatformSandboxEnvironment(),
        id: "env-local-1",
        driver: "local",
        metadata: { managedByPaperclip: true, defaultForInstance: true },
      });
      const app = createApp(ownerAdminActor);

      const res = await request(app)
        .patch("/api/environments/env-local-1")
        .send({ metadata: { managedByPaperclip: false } });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "environment_platform_managed" });
      expect(mockEnvironmentService.update).not.toHaveBeenCalled();
    });

    it("rejects non-marker-only patches to platform-provisioned rows even from instance admins", async () => {
      mockEnvironmentService.getById.mockResolvedValue(createPlatformSandboxEnvironment());
      const app = createApp(ownerAdminActor);

      const res = await request(app)
        .patch("/api/environments/env-managed-1")
        .send({ name: "Renamed", metadata: { managedByPaperclip: false } });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "environment_platform_managed" });
      expect(mockEnvironmentService.update).not.toHaveBeenCalled();
    });

    it("rejects deletes of platform-provisioned rows, including for instance admins", async () => {
      mockEnvironmentService.getById.mockResolvedValue(createPlatformSandboxEnvironment());
      const app = createApp(ownerAdminActor);

      const res = await request(app).delete("/api/environments/env-managed-1");

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "environment_platform_managed" });
      expect(mockEnvironmentService.getDeleteBlastRadius).not.toHaveBeenCalled();
      expect(mockEnvironmentService.removeIfDeletable).not.toHaveBeenCalled();
    });

    it("rejects creates that stamp platform markers so tenants cannot self-lock rows", async () => {
      const app = createApp(ownerAdminActor);

      const res = await request(app)
        .post("/api/companies/company-1/environments")
        .send({
          name: "Fake managed",
          driver: "sandbox",
          config: { provider: "daytona" },
          metadata: { managedByPaperclip: true },
        });

      expect(res.status).toBe(422);
      expect(res.body.details).toMatchObject({ code: "environment_platform_marker_reserved" });
      expect(mockEnvironmentService.create).not.toHaveBeenCalled();
    });

    it("rejects tenant patches that stamp platform markers so the row cannot become locked", async () => {
      const tenantEnvironment = {
        ...createPlatformSandboxEnvironment(),
        id: "env-tenant-1",
        metadata: { source: "manual" },
      };
      mockEnvironmentService.getById.mockResolvedValue(tenantEnvironment);
      const app = createApp(ownerAdminActor);

      const res = await request(app)
        .patch("/api/environments/env-tenant-1")
        .send({ metadata: { source: "manual", managedKubernetesSandbox: true } });

      expect(res.status).toBe(422);
      expect(res.body.details).toMatchObject({ code: "environment_platform_marker_reserved" });
      expect(mockEnvironmentService.update).not.toHaveBeenCalled();
    });

    it("accepts platform markers in client payloads on self-hosted instances", async () => {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
      const existing = {
        ...createPlatformSandboxEnvironment(),
        id: "env-tenant-1",
        metadata: { source: "manual" },
      };
      mockEnvironmentService.getById.mockResolvedValue(existing);
      mockEnvironmentService.update.mockResolvedValue({
        ...existing,
        metadata: { source: "manual", managedByPaperclip: true },
      });
      const app = createApp({
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
      });

      const res = await request(app)
        .patch("/api/environments/env-tenant-1")
        .send({ metadata: { source: "manual", managedByPaperclip: true } });

      expect(res.status).toBe(200);
      expect(mockEnvironmentService.update).toHaveBeenCalled();
    });

    it("still updates tenant-created environments for instance admins on cloud-managed instances", async () => {
      const tenantEnvironment = {
        ...createPlatformSandboxEnvironment(),
        id: "env-tenant-1",
        metadata: { source: "manual" },
      };
      mockEnvironmentService.getById.mockResolvedValue(tenantEnvironment);
      mockEnvironmentService.update.mockResolvedValue({ ...tenantEnvironment, name: "Renamed" });
      const app = createApp(ownerAdminActor);

      const res = await request(app).patch("/api/environments/env-tenant-1").send({ name: "Renamed" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Renamed");
      expect(mockEnvironmentService.update).toHaveBeenCalled();
    });

    it("does not floor writes to platform-marked rows on self-hosted instances", async () => {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
      const existing = createPlatformSandboxEnvironment();
      mockEnvironmentService.getById.mockResolvedValue(existing);
      mockEnvironmentService.update.mockResolvedValue({ ...existing, name: "Renamed" });
      const app = createApp({
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
      });

      const res = await request(app).patch("/api/environments/env-managed-1").send({ name: "Renamed" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Renamed");
    });

    it("leaves tenant-created environments unfloored for instance admins", async () => {
      const tenantEnvironment = {
        ...createPlatformSandboxEnvironment(),
        id: "env-tenant-1",
        metadata: { source: "manual" },
      };
      mockEnvironmentService.getById.mockResolvedValue(tenantEnvironment);
      const app = createApp(ownerAdminActor);

      const res = await request(app).get("/api/environments/env-tenant-1");

      expect(res.status).toBe(200);
      expect(res.body.envVars).toEqual({ DAYTONA_API_KEY: "must-never-echo" });
      expect(res.body.config.apiKey).toBe("must-never-echo");
    });

    it("does not floor platform-marked rows on self-hosted instances", async () => {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
      mockEnvironmentService.getById.mockResolvedValue(createPlatformSandboxEnvironment());
      const app = createApp({
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
      });

      const res = await request(app).get("/api/environments/env-managed-1");

      expect(res.status).toBe(200);
      expect(res.body.envVars).toEqual({ DAYTONA_API_KEY: "must-never-echo" });
      expect(res.body.config.apiKey).toBe("must-never-echo");
    });
  });

  it("rejects non-admin blast-radius reads for instance-scoped environments", async () => {
    const app = createApp({
      type: "board",
      userId: "user-2",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/environments/env-1/delete-blast-radius");

    expect(res.status).toBe(403);
    expect(mockEnvironmentService.getDeleteBlastRadius).not.toHaveBeenCalled();
  });

  it("returns delete blast radius counts for instance admins", async () => {
    mockEnvironmentService.getDeleteBlastRadius.mockResolvedValue(createDeleteBlastRadius({
      agentDefaultCount: 2,
      secretBindingCount: 3,
      activeLeaseCount: 1,
    }));
    const app = createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      companyIds: ["company-1"],
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/environments/env-1/delete-blast-radius");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      environmentId: "env-1",
      canDelete: true,
      deleteBlockedReasons: [],
      staticReferences: {
        isManagedLocal: false,
        isInstanceDefault: false,
        agentDefaultCount: 2,
        executionWorkspaceSelectionCount: 0,
        issueSelectionCount: 0,
        projectSelectionCount: 0,
        secretBindingCount: 3,
      },
      activeRuntimeUse: {
        activeLeaseCount: 1,
        activeCustomImageSetupSessionCount: 0,
        hasActiveRuntimeUse: true,
      },
    });
    expect(res.body).not.toHaveProperty("config");
    expect(res.body).not.toHaveProperty("envVars");
    expect(res.body).not.toHaveProperty("metadata");
  });

  it("returns 404 for missing delete blast radius targets", async () => {
    mockEnvironmentService.getDeleteBlastRadius.mockResolvedValue(null);
    const app = createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      companyIds: ["company-1"],
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/environments/missing/delete-blast-radius");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Environment not found");
  });

  it("returns provider capabilities for the company", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/environments/capabilities");

    expect(res.status).toBe(200);
    expect(res.body.drivers.ssh).toBe("supported");
    expect(res.body.sandboxProviders.fake.supportsRunExecution).toBe(false);
    expect(res.body.sandboxProviders).not.toHaveProperty("fake-plugin");
  });

  it("returns installed plugin-backed sandbox capabilities for environment creation", async () => {
    mockListReadyPluginEnvironmentDrivers.mockResolvedValue([
      {
        pluginId: "plugin-1",
        pluginKey: "acme.secure-sandbox-provider",
        driverKey: "secure-plugin",
        displayName: "Secure Sandbox",
        description: "Provisions schema-driven cloud sandboxes.",
        supportsInteractiveSetup: true,
        interactiveSetupConnectionTypes: ["ssh"],
        supportsTemplateCapture: true,
        templateRefKind: "snapshot",
        templateConfigBinding: {
          field: "template",
          unsetFields: ["image"],
        },
        supportsTemplateDelete: true,
        configSchema: {
          type: "object",
          properties: {
            template: { type: "string" },
            apiKey: { type: "string", format: "secret-ref" },
          },
        },
      },
    ]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/environments/capabilities");

    expect(res.status).toBe(200);
    expect(res.body.sandboxProviders["secure-plugin"]).toMatchObject({
      status: "supported",
      supportsRunExecution: true,
      supportsReusableLeases: true,
      supportsInteractiveSetup: true,
      interactiveSetupConnectionTypes: ["ssh"],
      supportsTemplateCapture: true,
      templateRefKind: "snapshot",
      templateConfigBinding: {
        field: "template",
        unsetFields: ["image"],
      },
      supportsTemplateDelete: true,
      displayName: "Secure Sandbox",
      source: "plugin",
      pluginKey: "acme.secure-sandbox-provider",
      pluginId: "plugin-1",
      configSchema: {
        type: "object",
        properties: {
          template: { type: "string" },
          apiKey: { type: "string", format: "secret-ref" },
        },
      },
    });
    expect(res.body.adapters.find((row: any) => row.adapterType === "codex_local").sandboxProviders["secure-plugin"])
      .toBe("supported");
  });

  it("rejects agent list reads for instance-scoped environments", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      permissions: { canCreateAgents: false },
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/companies/company-1/environments");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockEnvironmentService.list).not.toHaveBeenCalled();
  });

  it("rejects agent detail reads for instance-scoped environments", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "cto",
      permissions: { canCreateAgents: true },
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/environments/env-1");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });

  it("creates an environment and logs activity", async () => {
    const environment = createEnvironment();
    mockEnvironmentService.create.mockResolvedValue(environment);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Local",
        driver: "local",
        description: "Current development machine",
        config: { shell: "zsh" },
      });

    expect(res.status).toBe(201);
    expect(mockEnvironmentService.create).toHaveBeenCalledWith({
      name: "Local",
      driver: "local",
      description: "Current development machine",
      status: "active",
      config: { shell: "zsh" },
      envVars: {},
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        agentId: null,
        runId: null,
        action: "environment.created",
        entityType: "environment",
        entityId: environment.id,
      }),
    );
  });

  it("returns conflict when creating a second local environment", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Another Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("A local environment already exists for this instance.");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("rejects non-admin board users even when they have company environment permissions", async () => {
    const environment = createEnvironment();
    mockAccessService.canUser.mockResolvedValue(true);
    mockEnvironmentService.create.mockResolvedValue(environment);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin access required");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("rejects non-admin board users without instance admin access", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin access required");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("rejects agent environment creation even with explicit company grants", async () => {
    const environment = createEnvironment();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      permissions: { canCreateAgents: false },
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockEnvironmentService.create.mockResolvedValue(environment);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("board operators");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("rejects deleting the managed local environment", async () => {
    const environment = createEnvironment();
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.getDeleteBlastRadius.mockResolvedValue(createDeleteBlastRadius({
      isManagedLocal: true,
    }));
    const app = createApp({
      type: "board",
      userId: "admin-1",
      source: "local_implicit",
    });

    const res = await request(app).delete("/api/environments/env-1");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Cannot delete the managed local environment.");
    expect(res.body.details).toEqual({ deleteBlockedReasons: ["managed_local"] });
    expect(mockEnvironmentService.removeIfDeletable).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.clearEnvironmentSelection).not.toHaveBeenCalled();
  });

  it("rejects deleting the current instance default environment", async () => {
    const environment = {
      ...createEnvironment(),
      driver: "ssh" as const,
      name: "SSH Fixture",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.getDeleteBlastRadius.mockResolvedValue(createDeleteBlastRadius({
      isInstanceDefault: true,
    }));
    const app = createApp({
      type: "board",
      userId: "admin-1",
      source: "local_implicit",
    });

    const res = await request(app).delete("/api/environments/env-1");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      "Cannot delete the current instance default environment. Set a new default environment before deleting this one.",
    );
    expect(res.body.details).toEqual({ deleteBlockedReasons: ["instance_default"] });
    expect(mockEnvironmentService.removeIfDeletable).not.toHaveBeenCalled();
  });

  it("clears environment selections and secret bindings across all companies when deleting an environment", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-ssh",
      name: "SSH Fixture",
      driver: "ssh" as const,
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.getDeleteBlastRadius.mockResolvedValue(createDeleteBlastRadius());
    mockEnvironmentService.removeIfDeletable.mockResolvedValue(environment);
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
    const app = createApp({
      type: "board",
      userId: "admin-1",
      source: "local_implicit",
    });

    const res = await request(app).delete("/api/environments/env-ssh");

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.removeIfDeletable).toHaveBeenCalledWith("env-ssh");
    for (const companyId of ["company-1", "company-2"]) {
      expect(mockExecutionWorkspaceService.clearEnvironmentSelection)
        .toHaveBeenCalledWith(companyId, "env-ssh");
      expect(mockIssueService.clearExecutionWorkspaceEnvironmentSelection)
        .toHaveBeenCalledWith(companyId, "env-ssh");
      expect(mockProjectService.clearExecutionWorkspaceEnvironmentSelection)
        .toHaveBeenCalledWith(companyId, "env-ssh");
      expect(mockSecretService.syncEnvBindingsForTarget).toHaveBeenCalledWith(
        companyId,
        { targetType: "environment", targetId: "env-ssh" },
        {},
      );
      expect(mockSecretService.syncSecretRefsForTarget).toHaveBeenCalledWith(
        companyId,
        { targetType: "environment", targetId: "env-ssh" },
        [],
        { replaceAll: true },
      );
    }
    expect(mockSecretService.remove).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "environment.deleted",
        entityType: "environment",
        entityId: "env-ssh",
      }),
    );
  });

  it("rejects invalid SSH config on create", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "SSH Fixture",
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("remote workspace path");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("normalizes SSH private keys into secret refs before persistence", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-ssh",
      name: "SSH Fixture",
      driver: "ssh" as const,
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.create.mockResolvedValue(environment);
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "SSH Fixture",
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: "  super-secret-key  ",
        },
      });

    expect(res.status).toBe(201);
    expect(mockEnvironmentService.create).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
      }),
      envVars: {},
    }));
    expect(JSON.stringify(mockEnvironmentService.create.mock.calls[0][0])).not.toContain("super-secret-key");
    expect(mockSecretService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        provider: "local_encrypted",
        value: "super-secret-key",
      }),
      expect.any(Object),
    );
  });

  it("uses the configured provider for SSH private key secret materialization", async () => {
    process.env.PAPERCLIP_SECRETS_PROVIDER = "aws_secrets_manager";
    const environment = {
      ...createEnvironment(),
      id: "env-ssh",
      name: "SSH Fixture",
      driver: "ssh" as const,
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.create.mockResolvedValue(environment);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "SSH Fixture",
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: "super-secret-key",
        },
      });

    expect(res.status).toBe(201);
    expect(mockSecretService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        provider: "aws_secrets_manager",
        value: "super-secret-key",
      }),
      expect.any(Object),
    );
  });

  it("rejects persisted fake sandbox environments", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Fake Sandbox",
        driver: "sandbox",
        config: {
          provider: "fake",
          image: "  ubuntu:24.04  ",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("reserved for internal probes");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("creates a sandbox environment with normalized Fake plugin config", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-sandbox-fake-plugin",
      name: "Fake plugin Sandbox",
      driver: "sandbox" as const,
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 450000,
        reuseLease: true,
      },
    };
    mockEnvironmentService.create.mockResolvedValue(environment);
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Fake plugin Sandbox",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
          image: "fake:test",
          timeoutMs: "450000",
          reuseLease: true,
        },
      });

    expect(res.status).toBe(201);
    expect(mockValidatePluginSandboxProviderConfig).toHaveBeenCalledWith({
      db: expect.anything(),
      workerManager: pluginWorkerManager,
      provider: "fake-plugin",
      config: {
        image: "fake:test",
        timeoutMs: 450000,
        reuseLease: true,
      },
    });
    expect(mockEnvironmentService.create).toHaveBeenCalledWith({
      name: "Fake plugin Sandbox",
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 450000,
        reuseLease: true,
      },
      envVars: {},
    });
    expect(mockSecretService.create).not.toHaveBeenCalled();
  });

  it("creates a schema-driven sandbox environment with secret-ref fields persisted as secrets", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-sandbox-secure-plugin",
      name: "Secure Sandbox",
      driver: "sandbox" as const,
      config: {
        provider: "secure-plugin",
        template: "base",
        apiKey: "11111111-1111-1111-1111-111111111111",
        timeoutMs: 450000,
        reuseLease: true,
      },
    };
    mockEnvironmentService.create.mockResolvedValue(environment);
    mockValidatePluginSandboxProviderConfig.mockResolvedValue({
      normalizedConfig: {
        template: "base",
        apiKey: "test-provider-key",
        timeoutMs: 450000,
        reuseLease: true,
      },
      pluginId: "plugin-secure",
      pluginKey: "acme.secure-sandbox-provider",
      driver: {
        driverKey: "secure-plugin",
        kind: "sandbox_provider",
        displayName: "Secure Sandbox",
        configSchema: {
          type: "object",
          properties: {
            template: { type: "string" },
            apiKey: { type: "string", format: "secret-ref" },
            timeoutMs: { type: "number" },
            reuseLease: { type: "boolean" },
          },
        },
      },
    });
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Secure Sandbox",
        driver: "sandbox",
        config: {
          provider: "secure-plugin",
          template: "  base  ",
          apiKey: "  test-provider-key  ",
          timeoutMs: "450000",
          reuseLease: true,
        },
      });

    expect(res.status).toBe(201);
    expect(mockValidatePluginSandboxProviderConfig).toHaveBeenCalledWith({
      db: expect.anything(),
      workerManager: pluginWorkerManager,
      provider: "secure-plugin",
      config: {
        template: "  base  ",
        apiKey: "  test-provider-key  ",
        timeoutMs: 450000,
        reuseLease: true,
      },
    });
    expect(mockEnvironmentService.create).toHaveBeenCalledWith({
      name: "Secure Sandbox",
      driver: "sandbox",
      status: "active",
      config: {
        provider: "secure-plugin",
        template: "base",
        apiKey: "11111111-1111-1111-1111-111111111111",
        timeoutMs: 450000,
        reuseLease: true,
      },
      envVars: {},
    });
    expect(JSON.stringify(mockEnvironmentService.create.mock.calls[0][0])).not.toContain("test-provider-key");
    expect(mockSecretService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        provider: "local_encrypted",
        value: "test-provider-key",
      }),
      expect.any(Object),
    );
  });

  it("uses the configured provider for schema-driven sandbox secret fields", async () => {
    process.env.PAPERCLIP_SECRETS_PROVIDER = "aws_secrets_manager";
    const environment = {
      ...createEnvironment(),
      id: "env-sandbox-secure-plugin",
      name: "Secure Sandbox",
      driver: "sandbox" as const,
      config: {
        provider: "secure-plugin",
        template: "base",
        apiKey: "11111111-1111-1111-1111-111111111111",
        timeoutMs: 450000,
        reuseLease: true,
      },
    };
    mockEnvironmentService.create.mockResolvedValue(environment);
    mockValidatePluginSandboxProviderConfig.mockResolvedValue({
      normalizedConfig: {
        template: "base",
        apiKey: "test-provider-key",
        timeoutMs: 450000,
        reuseLease: true,
      },
      pluginId: "plugin-secure",
      pluginKey: "acme.secure-sandbox-provider",
      driver: {
        driverKey: "secure-plugin",
        kind: "sandbox_provider",
        displayName: "Secure Sandbox",
        configSchema: {
          type: "object",
          properties: {
            template: { type: "string" },
            apiKey: { type: "string", format: "secret-ref" },
            timeoutMs: { type: "number" },
            reuseLease: { type: "boolean" },
          },
        },
      },
    });
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Secure Sandbox",
        driver: "sandbox",
        config: {
          provider: "secure-plugin",
          template: "base",
          apiKey: "test-provider-key",
          timeoutMs: "450000",
          reuseLease: true,
        },
      });

    expect(res.status).toBe(201);
    expect(mockSecretService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        provider: "aws_secrets_manager",
        value: "test-provider-key",
      }),
      expect.any(Object),
    );
  });

  it("validates plugin environment config through the plugin driver host", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-plugin",
      name: "Plugin Sandbox",
      driver: "plugin" as const,
      config: {
        pluginKey: "acme.environments",
        driverKey: "sandbox",
        driverConfig: {
          template: "normalized",
        },
      },
    };
    mockValidatePluginEnvironmentDriverConfig.mockResolvedValue(environment.config);
    mockEnvironmentService.create.mockResolvedValue(environment);
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Plugin Sandbox",
        driver: "plugin",
        config: {
          pluginKey: "acme.environments",
          driverKey: "sandbox",
          driverConfig: {
            template: "base",
          },
        },
      });

    expect(res.status).toBe(201);
    expect(mockValidatePluginEnvironmentDriverConfig).toHaveBeenCalledWith({
      db: expect.anything(),
      workerManager: pluginWorkerManager,
      config: {
        pluginKey: "acme.environments",
        driverKey: "sandbox",
        driverConfig: {
          template: "base",
        },
      },
    });
    expect(mockEnvironmentService.create).toHaveBeenCalledWith(expect.objectContaining({
      config: environment.config,
      envVars: {},
    }));
  });

  it("rejects agent mutations for instance-scoped environments", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      permissions: { canCreateAgents: false },
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Sandbox host",
        driver: "local",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("board operators");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("lists leases for an environment after company access is confirmed", async () => {
    const environment = createEnvironment();
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.listLeases.mockResolvedValue([
      {
        id: "lease-1",
        companyId: "company-1",
        environmentId: environment.id,
        executionWorkspaceId: "workspace-1",
        issueId: null,
        heartbeatRunId: null,
        status: "active",
        providerLeaseId: "provider-lease-1",
        acquiredAt: new Date("2026-04-16T05:00:00.000Z"),
        lastUsedAt: new Date("2026-04-16T05:05:00.000Z"),
        expiresAt: null,
        releasedAt: null,
        metadata: { provider: "fake" },
        createdAt: new Date("2026-04-16T05:00:00.000Z"),
        updatedAt: new Date("2026-04-16T05:05:00.000Z"),
      },
    ]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get(`/api/environments/${environment.id}/leases?status=active`);

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.listLeases).toHaveBeenCalledWith(environment.id, {
      status: "active",
    });
  });

  it("returns a single lease after company access is confirmed", async () => {
    mockEnvironmentService.getLeaseById.mockResolvedValue({
      id: "lease-1",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: "workspace-1",
      issueId: null,
      heartbeatRunId: "run-1",
      status: "active",
      leasePolicy: "ephemeral",
      provider: "ssh",
      providerLeaseId: "ssh://ssh-user@example.test:22/workspace",
      acquiredAt: new Date("2026-04-16T05:00:00.000Z"),
      lastUsedAt: new Date("2026-04-16T05:05:00.000Z"),
      expiresAt: null,
      releasedAt: null,
      failureReason: null,
      cleanupStatus: null,
      metadata: { remoteCwd: "/workspace" },
      createdAt: new Date("2026-04-16T05:00:00.000Z"),
      updatedAt: new Date("2026-04-16T05:05:00.000Z"),
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/environment-leases/lease-1");

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("ssh");
    expect(mockEnvironmentService.getLeaseById).toHaveBeenCalledWith("lease-1");
  });

  it("rejects agent access regardless of company when environment management is instance-scoped", async () => {
    mockEnvironmentService.list.mockResolvedValue([]);
    const app = createApp({
      type: "agent",
      agentId: "agent-2",
      companyId: "company-2",
      source: "agent_key",
      runId: "run-2",
    });

    const res = await request(app).get("/api/companies/company-1/environments");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockEnvironmentService.list).not.toHaveBeenCalled();
  });

  it("logs a redacted update summary instead of raw config or metadata", async () => {
    const environment = createEnvironment();
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.update.mockResolvedValue({
      ...environment,
      status: "archived",
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch(`/api/environments/${environment.id}?companyId=company-1`)
      .send({
        status: "archived",
        config: {
          apiKey: "super-secret",
          token: "another-secret",
        },
        metadata: {
          password: "do-not-log",
        },
      });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "environment.updated",
        details: {
          changedFields: ["config", "metadata", "status"],
          status: "archived",
          configChanged: true,
          configTopLevelKeyCount: expect.any(Number),
          metadataChanged: true,
          metadataTopLevelKeyCount: 1,
        },
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls[0][1].details)).not.toContain("super-secret");
    expect(JSON.stringify(mockLogActivity.mock.calls[0][1].details)).not.toContain("do-not-log");
  });

  it("resets config instead of inheriting SSH secrets when switching to local without an explicit config", async () => {
    const environment = {
      ...createEnvironment(),
      name: "SSH Fixture",
      driver: "ssh" as const,
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: "super-secret-key",
        knownHosts: "known-host",
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.update.mockResolvedValue({
      ...createEnvironment(),
      driver: "local" as const,
      config: {},
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch(`/api/environments/${environment.id}?companyId=company-1`)
      .send({
        driver: "local",
      });

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.update).toHaveBeenCalledWith(environment.id, {
      driver: "local",
      config: {},
    });
    expect(JSON.stringify(mockEnvironmentService.update.mock.calls[0][1])).not.toContain("super-secret-key");
    expect(JSON.stringify(mockEnvironmentService.update.mock.calls[0][1])).not.toContain("known-host");
  });

  it("requires explicit SSH config when switching from local to SSH", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/environments/env-1?companyId=company-1")
      .send({
        driver: "ssh",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("host");
    expect(mockEnvironmentService.update).not.toHaveBeenCalled();
  });

  it("rejects switching an environment to the built-in fake sandbox provider", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/environments/env-1?companyId=company-1")
      .send({
        driver: "sandbox",
        config: {
          provider: "fake",
          image: "ubuntu:24.04",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("reserved for internal probes");
    expect(mockEnvironmentService.update).not.toHaveBeenCalled();
  });

  it("returns 404 when patching a missing environment", async () => {
    mockEnvironmentService.getById.mockResolvedValue(null);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/environments/missing-env")
      .send({ status: "archived" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Environment not found");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("probes an SSH environment and logs the result", async () => {
    const environment = {
      ...createEnvironment(),
      name: "SSH Fixture",
      driver: "ssh" as const,
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockProbeEnvironment.mockResolvedValue({
      ok: true,
      driver: "ssh",
      summary: "Connected to ssh-user@ssh.example.test and verified the remote workspace path.",
      details: {
        host: "ssh.example.test",
      },
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/environments/${environment.id}/probe`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockProbeEnvironment).toHaveBeenCalledWith(expect.anything(), environment, {
      companyId: null,
      pluginWorkerManager: undefined,
      applyCustomImageTemplate: false,
      acquireSandboxRuntimeLease: false,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "environment.probed",
        entityType: "environment",
        entityId: environment.id,
        details: expect.objectContaining({
          driver: "ssh",
          ok: true,
        }),
      }),
    );
  });

  it("requires explicit companyId when probing a secret-backed environment without inferable secret context", async () => {
    const environment = {
      ...createEnvironment(),
      driver: "ssh" as const,
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-4111-8111-111111111111",
          version: "latest",
        },
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockSecretService.listBindingCompanyIdsForTarget.mockResolvedValue([]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1", "company-2"],
      memberships: [
        { companyId: "company-1", status: "active", membershipRole: "member" },
        { companyId: "company-2", status: "active", membershipRole: "member" },
      ],
      isInstanceAdmin: true,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/environments/${environment.id}/probe`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("explicit companyId");
    expect(mockProbeEnvironment).not.toHaveBeenCalled();
  });

  it("probes a sandbox environment and logs the result", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-sandbox",
      name: "Fake Sandbox",
      driver: "sandbox" as const,
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockProbeEnvironment.mockResolvedValue({
      ok: true,
      driver: "sandbox",
      summary: "Fake sandbox provider is ready for image ubuntu:24.04.",
      details: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/environments/${environment.id}/probe`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.driver).toBe("sandbox");
    expect(mockProbeEnvironment).toHaveBeenCalledWith(expect.anything(), environment, {
      companyId: "company-1",
      pluginWorkerManager: undefined,
      applyCustomImageTemplate: true,
      acquireSandboxRuntimeLease: true,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "environment.probed",
        entityType: "environment",
        entityId: environment.id,
        details: expect.objectContaining({
          driver: "sandbox",
          ok: true,
        }),
      }),
    );
  });

  it("probes saved sandbox environments with the active custom image template without company context", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-sandbox",
      name: "Daytona Sandbox",
      driver: "sandbox" as const,
      config: {
        provider: "daytona",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockProbeEnvironment.mockResolvedValue({
      ok: true,
      driver: "sandbox",
      summary: "Connected to Daytona sandbox.",
      details: {
        provider: "daytona",
        snapshot: "captured-template",
      },
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/environments/${environment.id}/probe`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.driver).toBe("sandbox");
    expect(mockProbeEnvironment).toHaveBeenCalledWith(expect.anything(), environment, {
      companyId: "company-1",
      pluginWorkerManager: undefined,
      applyCustomImageTemplate: true,
      acquireSandboxRuntimeLease: true,
    });
  });

  it("probes unsaved provider config without persisting secrets", async () => {
    mockProbeEnvironment.mockResolvedValue({
      ok: true,
      driver: "sandbox",
      summary: "Fake plugin sandbox provider is ready.",
      details: { provider: "fake-plugin" },
    });
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      runId: "run-1",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments/probe-config")
      .send({
        name: "Draft Fake plugin",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
          template: "base",
          apiKey: "unsaved-test-key",
          timeoutMs: 300000,
          reuseLease: true,
        },
      });

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
    expect(mockSecretService.create).not.toHaveBeenCalled();
    expect(mockProbeEnvironment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "unsaved",
        driver: "sandbox",
        config: expect.objectContaining({
          apiKey: "unsaved-test-key",
        }),
      }),
      expect.objectContaining({
        pluginWorkerManager,
        resolvedConfig: expect.objectContaining({
          driver: "sandbox",
        }),
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls[0][1].details)).not.toContain("unsaved-test-key");
  });

  it("resolves selected secret refs before probing unsaved provider config", async () => {
    mockValidatePluginSandboxProviderConfig.mockResolvedValue({
      normalizedConfig: {
        template: "base",
        apiKey: "11111111-1111-1111-1111-111111111111",
        timeoutMs: 300000,
        reuseLease: true,
      },
      pluginId: "plugin-secure",
      pluginKey: "acme.secure-sandbox-provider",
      driver: {
        driverKey: "secure-plugin",
        kind: "sandbox_provider",
        displayName: "Secure Sandbox",
        configSchema: {
          type: "object",
          properties: {
            template: { type: "string" },
            apiKey: { type: "string", format: "secret-ref" },
            timeoutMs: { type: "number" },
            reuseLease: { type: "boolean" },
          },
        },
      },
    });
    mockProbeEnvironment.mockResolvedValue({
      ok: true,
      driver: "sandbox",
      summary: "Secure sandbox provider is ready.",
      details: { provider: "secure-plugin" },
    });
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      runId: "run-1",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments/probe-config")
      .send({
        name: "Draft Secure Sandbox",
        driver: "sandbox",
        config: {
          provider: "secure-plugin",
          template: "base",
          apiKey: "11111111-1111-1111-1111-111111111111",
          timeoutMs: 300000,
          reuseLease: true,
        },
      });

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
    expect(mockSecretService.create).not.toHaveBeenCalled();
    expect(mockSecretService.resolveSecretValueForEphemeralAccess).toHaveBeenCalledWith(
      "company-1",
      "11111111-1111-1111-1111-111111111111",
      "latest",
      {
        consumerType: "system",
        consumerId: "environment-probe-config",
        configPath: "apiKey",
        actorType: "user",
        actorId: "user-1",
        actorSource: "local_implicit",
        heartbeatRunId: "run-1",
      },
    );
    expect(mockProbeEnvironment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "unsaved",
        driver: "sandbox",
        config: expect.objectContaining({
          apiKey: "resolved-provider-key",
        }),
      }),
      expect.objectContaining({
        pluginWorkerManager,
        resolvedConfig: expect.objectContaining({
          driver: "sandbox",
          config: expect.objectContaining({
            apiKey: "resolved-provider-key",
          }),
        }),
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls[0][1].details)).not.toContain("resolved-provider-key");
  });

  it("rejects sandbox draft probes for non-admin board users", async () => {
    mockValidatePluginSandboxProviderConfig.mockResolvedValue({
      normalizedConfig: {
        template: "base",
        apiKey: "11111111-1111-1111-1111-111111111111",
      },
      pluginId: "plugin-secure",
      pluginKey: "acme.secure-sandbox-provider",
      driver: {
        driverKey: "secure-plugin",
        kind: "sandbox_provider",
        displayName: "Secure Sandbox",
        configSchema: {
          type: "object",
          properties: {
            template: { type: "string" },
            apiKey: { type: "string", format: "secret-ref" },
          },
        },
      },
    });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      explanation: "Missing permission: secrets:read",
    });
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-2",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments/probe-config")
      .send({
        name: "Draft Secure Sandbox",
        driver: "sandbox",
        config: {
          provider: "secure-plugin",
          template: "base",
          apiKey: "11111111-1111-1111-1111-111111111111",
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin access required");
    expect(mockSecretService.resolveSecretValueForEphemeralAccess).not.toHaveBeenCalled();
    expect(mockProbeEnvironment).not.toHaveBeenCalled();
  });
});
