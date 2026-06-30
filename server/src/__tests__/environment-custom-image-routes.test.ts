import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { environmentRoutes } from "../routes/environments.js";

const now = new Date("2026-06-25T20:00:00.000Z");

const mockIssueService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
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

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  clearEnvironmentSelection: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  normalizeEnvBindingsForPersistence: vi.fn(),
  listBindingCompanyIdsForTarget: vi.fn(),
  resolveSecretValueForEphemeralAccess: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(),
  syncSecretRefsForTarget: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  projectService: () => mockProjectService,
  instanceSettingsService: () => mockInstanceSettingsService,
  environmentService: () => mockEnvironmentService,
  environmentCustomImageService: () => mockEnvironmentCustomImageService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environment-probe.js", () => ({
  probeEnvironment: vi.fn(),
}));

vi.mock("../services/plugin-environment-driver.js", () => ({
  listReadyPluginEnvironmentDrivers: vi.fn(async () => []),
  resolvePluginSandboxProviderDriverByKey: vi.fn(async () => null),
  validatePluginEnvironmentDriverConfig: vi.fn(async ({ config }) => config),
  validatePluginSandboxProviderConfig: vi.fn(async ({ provider, config }) => ({
    normalizedConfig: config,
    pluginId: `plugin-${provider}`,
    pluginKey: `plugin.${provider}`,
    driver: {
      driverKey: provider,
      kind: "sandbox_provider",
      displayName: provider,
      configSchema: { type: "object" },
    },
  })),
}));

function createEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    id: "env-1",
    name: "Daytona",
    description: null,
    driver: "sandbox",
    status: "active",
    config: {
      provider: "daytona",
      snapshot: "base-snapshot",
      reuseLease: false,
    },
    envVars: {},
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: "template-1",
    companyId: "company-1",
    environmentId: "env-1",
    provider: "daytona",
    templateKind: "snapshot",
    templateRef: "snapshot-secret-ref",
    sourceTemplateRef: "base-snapshot-secret",
    sourceEnvironmentConfigFingerprint: "sha256:base",
    status: "active",
    createdByUserId: "user-1",
    createdByAgentId: null,
    capturedAt: now,
    lastUsedAt: null,
    supersededByTemplateId: null,
    metadata: { safeLabel: "codex" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    companyId: "company-1",
    environmentId: "env-1",
    templateId: "template-1",
    promotedTemplateId: null,
    provider: "daytona",
    providerLeaseId: "lease-secret",
    environmentLeaseId: null,
    status: "waiting_for_user",
    startedByUserId: "user-1",
    startedByAgentId: null,
    baseTemplateRef: "snapshot-secret-ref",
    expiresAt: new Date("2026-06-25T21:00:00.000Z"),
    finishedAt: null,
    failureReason: null,
    connectionSummary: {
      type: "ssh",
      username: "token",
      hostRedacted: true,
      portRedacted: true,
      instructions: "ssh token@203.0.113.10",
    },
    connectionSecretRef: null,
    metadata: {
      safeLabel: "setup",
      connectUrl: "https://203.0.113.10/setup",
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", environmentRoutes({} as never));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as { status?: number }).status ?? 500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return app;
}

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    companyIds: ["company-1"],
    isInstanceAdmin: true,
    ...overrides,
  };
}

function agentActor() {
  return {
    type: "agent",
    agentId: "agent-1",
    companyId: "company-1",
    source: "agent_key",
    runId: "run-1",
  };
}

function loggedActivityJson() {
  return JSON.stringify(mockLogActivity.mock.calls);
}

describe("environment customImage setup routes", () => {
  beforeEach(() => {
    mockIssueService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockProjectService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    Object.values(mockEnvironmentService).forEach((mock) => mock.mockReset());
    Object.values(mockEnvironmentCustomImageService).forEach((mock) => mock.mockReset());
    mockExecutionWorkspaceService.clearEnvironmentSelection.mockReset();
    Object.values(mockSecretService).forEach((mock) => mock.mockReset());
    mockLogActivity.mockReset();

    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    mockEnvironmentCustomImageService.getOverview.mockResolvedValue({
      activeTemplate: null,
      activeSession: null,
      latestSession: null,
    });
    mockEnvironmentCustomImageService.getActiveTemplate.mockResolvedValue(null);
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(null);
    mockEnvironmentCustomImageService.startSetupSession.mockResolvedValue({
      session: createSession(),
      connectionPayload: {
        type: "ssh",
        command: "ssh token@203.0.113.10 -p 2222",
      },
    });
    mockEnvironmentCustomImageService.refreshSetupSession.mockResolvedValue({
      session: createSession(),
      connectionPayload: {
        type: "ssh",
        command: "ssh token@203.0.113.10 -p 2222",
      },
    });
    mockEnvironmentCustomImageService.finishSetupSession.mockResolvedValue({
      session: createSession({
        status: "promoted",
        promotedTemplateId: "template-2",
        finishedAt: now,
      }),
      template: createTemplate({
        id: "template-2",
        templateRef: "captured-template-secret",
        sourceTemplateRef: "snapshot-secret-ref",
        metadata: { sandboxId: "sandbox-secret" },
      }),
      connectionPayload: null,
    });
    mockEnvironmentCustomImageService.cancelSetupSession.mockResolvedValue(createSession({
      status: "cancelled",
      finishedAt: now,
      failureReason: "operator requested",
    }));
    mockEnvironmentCustomImageService.rollbackTemplate.mockResolvedValue({
      activeTemplate: createTemplate({ id: "template-1", templateRef: "old-template-secret" }),
      supersededTemplate: createTemplate({ id: "template-2", templateRef: "new-template-secret" }),
    });
    mockEnvironmentCustomImageService.disableTemplate.mockResolvedValue(createTemplate({
      id: "template-2",
      templateRef: "disabled-template-secret",
      status: "revoked",
    }));
  });

  it("starts a setup session, returns the live payload, and logs redacted details", async () => {
    const res = await request(createApp(boardActor()))
      .post("/api/environments/env-1/custom-image-setup-sessions?companyId=company-1")
      .send({ ttlSeconds: 3600 });

    expect(res.status).toBe(201);
    expect(res.body.connectionPayload.command).toContain("203.0.113.10");
    expect(mockEnvironmentCustomImageService.startSetupSession).toHaveBeenCalledWith({
      companyId: "company-1",
      environmentId: "env-1",
      templateId: null,
      ttlSeconds: 3600,
      actor: {
        userId: "user-1",
        agentId: null,
      },
    });
    const activity = loggedActivityJson();
    expect(activity).not.toContain("203.0.113.10");
    expect(activity).not.toContain("lease-secret");
    expect(activity).not.toContain("snapshot-secret-ref");
  });

  it("refreshes active setup status and can return the live payload to board admins", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession());

    const res = await request(createApp(boardActor()))
      .get("/api/environment-custom-image-setup-sessions/session-1");

    expect(res.status).toBe(200);
    expect(res.body.connectionPayload.command).toContain("203.0.113.10");
    expect(mockEnvironmentCustomImageService.refreshSetupSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      includeConnectionPayload: true,
    });
  });

  it("denies agent API key actors before customImage state or payloads are read", async () => {
    const app = createApp(agentActor());
    const start = await request(app)
      .post("/api/environments/env-1/custom-image-setup-sessions?companyId=company-1")
      .send({});
    const status = await request(app)
      .get("/api/environment-custom-image-setup-sessions/session-1");

    expect(start.status).toBe(403);
    expect(status.status).toBe(403);
    expect(mockEnvironmentCustomImageService.startSetupSession).not.toHaveBeenCalled();
    expect(mockEnvironmentCustomImageService.getSessionById).not.toHaveBeenCalled();
    expect(mockEnvironmentCustomImageService.refreshSetupSession).not.toHaveBeenCalled();
  });

  it("denies non-admin board users before connection payload refresh", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession());

    const res = await request(createApp(boardActor({
      companyIds: ["company-2"],
      isInstanceAdmin: false,
    })))
      .get("/api/environment-custom-image-setup-sessions/session-1");

    expect(res.status).toBe(403);
    expect(mockEnvironmentCustomImageService.getSessionById).not.toHaveBeenCalled();
    expect(mockEnvironmentCustomImageService.refreshSetupSession).not.toHaveBeenCalled();
  });

  it("denies single-company fallback when the board actor is not a member", async () => {
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-2"]);

    const res = await request(createApp(boardActor({
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    })))
      .post("/api/environments/env-1/custom-image-setup-sessions")
      .send({});

    expect(res.status).toBe(403);
    expect(mockEnvironmentCustomImageService.startSetupSession).not.toHaveBeenCalled();
  });

  it("finishes and promotes a template while logging redacted template details", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession());

    const res = await request(createApp(boardActor()))
      .post("/api/environment-custom-image-setup-sessions/session-1/finish")
      .send({ metadata: { safeLabel: "done" } });

    expect(res.status).toBe(200);
    expect(res.body.template.templateRef).toBe("captured-template-secret");
    expect(mockEnvironmentCustomImageService.finishSetupSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      metadata: { safeLabel: "done" },
    });
    const activity = loggedActivityJson();
    expect(activity).not.toContain("captured-template-secret");
    expect(activity).not.toContain("snapshot-secret-ref");
    expect(activity).not.toContain("sandbox-secret");
  });

  it("cancels active sessions without logging lease details", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession());

    const res = await request(createApp(boardActor()))
      .post("/api/environment-custom-image-setup-sessions/session-1/cancel")
      .send({ reason: "operator requested" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(mockEnvironmentCustomImageService.cancelSetupSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      reason: "operator requested",
    });
    expect(loggedActivityJson()).not.toContain("lease-secret");
  });

  it("rolls back and disables active templates through company-scoped routes", async () => {
    const app = createApp(boardActor());
    const rollback = await request(app)
      .post("/api/environments/env-1/custom-image-template/rollback?companyId=company-1")
      .send({});
    const disable = await request(app)
      .delete("/api/environments/env-1/custom-image-template?companyId=company-1&deleteProviderTemplate=true");

    expect(rollback.status).toBe(200);
    expect(disable.status).toBe(200);
    expect(mockEnvironmentCustomImageService.rollbackTemplate).toHaveBeenCalledWith({
      companyId: "company-1",
      environmentId: "env-1",
    });
    expect(mockEnvironmentCustomImageService.disableTemplate).toHaveBeenCalledWith({
      companyId: "company-1",
      environmentId: "env-1",
      deleteProviderTemplate: true,
    });
    const activity = loggedActivityJson();
    expect(activity).not.toContain("new-template-secret");
    expect(activity).not.toContain("old-template-secret");
    expect(activity).not.toContain("disabled-template-secret");
  });
});
