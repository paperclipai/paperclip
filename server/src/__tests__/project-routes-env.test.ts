import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
  isCompanyOwner: vi.fn(async () => false),
  hasProjectPermission: vi.fn(async () => true),
}));
const mockGithubConnectionService = vi.hoisted(() => ({
  assertConnection: vi.fn(async () => undefined),
  syncProjectBinding: vi.fn(async () => undefined),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  environmentService: () => mockEnvironmentService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
  accessService: () => mockAccessService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/github-connections.js", () => ({
  githubConnectionService: () => mockGithubConnectionService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    environmentService: () => mockEnvironmentService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => mockWorkspaceOperationService,
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/github-connections.js", () => ({
    githubConnectionService: () => mockGithubConnectionService,
  }));

  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "board-user",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    githubConnectionId: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project",
      effectiveLocalFolder: "/tmp/project",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("project env routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/secrets.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.createWorkspace.mockResolvedValue(null);
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockEnvironmentService.getById.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
    mockAccessService.isCompanyOwner.mockResolvedValue(false);
    mockAccessService.hasProjectPermission.mockResolvedValue(true);
    mockGithubConnectionService.assertConnection.mockResolvedValue(undefined);
    mockGithubConnectionService.syncProjectBinding.mockResolvedValue(undefined);
  });

  it("normalizes env bindings on create and logs only env keys", async () => {
    const normalizedEnv = {
      API_KEY: {
        type: "secret_ref",
        secretId: "11111111-1111-4111-8111-111111111111",
        version: "latest",
      },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.create.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        env: normalizedEnv,
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockSecretService.normalizeEnvBindingsForPersistence).toHaveBeenCalledWith(
      "company-1",
      normalizedEnv,
      expect.objectContaining({ fieldPath: "env" }),
    );
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ env: normalizedEnv }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          envKeys: ["API_KEY"],
        }),
      }),
    );
  });

  it("normalizes env bindings on update and avoids logging raw values", async () => {
    const normalizedEnv = {
      PLAIN_KEY: { type: "plain", value: "top-secret" },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.update.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        env: normalizedEnv,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: {
          changedKeys: ["env"],
          envKeys: ["PLAIN_KEY"],
        },
      }),
    );
  });

  it("rejects agent attempts to repoint project delivery authority", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject());
    const app = await createApp({
      type: "agent",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    const envResult = await request(app)
      .patch("/api/projects/project-1")
      .send({
        env: { CLOUDFLARE_ACCOUNT_ID: { type: "plain", value: "attacker-target" } },
      });
    const githubResult = await request(app)
      .patch("/api/projects/project-1")
      .send({ githubConnectionId: "11111111-1111-4111-8111-111111111111" });
    const environmentResult = await request(app)
      .patch("/api/projects/project-1")
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: "22222222-2222-4222-8222-222222222222",
        },
      });

    expect([envResult.status, githubResult.status, environmentResult.status]).toEqual([403, 403, 403]);
    expect(mockProjectService.update).not.toHaveBeenCalled();
    expect(mockSecretService.normalizeEnvBindingsForPersistence).not.toHaveBeenCalled();
    expect(mockGithubConnectionService.assertConnection).not.toHaveBeenCalled();
    expect(mockEnvironmentService.getById).not.toHaveBeenCalled();
  });

  it("rejects agent-created projects that embed delivery authority", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    const githubResult = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Attacker delivery project",
        githubConnectionId: "11111111-1111-4111-8111-111111111111",
      });
    const workspaceResult = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Attacker repo project",
        workspace: {
          name: "Attacker repo",
          repoUrl: "https://github.com/attacker/repo.git",
          isPrimary: true,
        },
      });

    expect([githubResult.status, workspaceResult.status]).toEqual([403, 403]);
    expect(mockProjectService.create).not.toHaveBeenCalled();
    expect(mockProjectService.createWorkspace).not.toHaveBeenCalled();
    expect(mockGithubConnectionService.assertConnection).not.toHaveBeenCalled();
  });

  it("rejects agent workspace create, update, reprimary, and delete mutations", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject());
    const app = await createApp({
      type: "agent",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    const created = await request(app)
      .post("/api/projects/project-1/workspaces")
      .send({ name: "Attacker repo", repoUrl: "https://github.com/attacker/repo.git" });
    const repointed = await request(app)
      .patch("/api/projects/project-1/workspaces/workspace-1")
      .send({ repoUrl: "https://github.com/attacker/repo.git" });
    const reprioritized = await request(app)
      .patch("/api/projects/project-1/workspaces/workspace-1")
      .send({ isPrimary: true });
    const removed = await request(app)
      .delete("/api/projects/project-1/workspaces/workspace-1");

    expect([created.status, repointed.status, reprioritized.status, removed.status]).toEqual([403, 403, 403, 403]);
    expect(mockProjectService.createWorkspace).not.toHaveBeenCalled();
    expect(mockProjectService.updateWorkspace).not.toHaveBeenCalled();
    expect(mockProjectService.removeWorkspace).not.toHaveBeenCalled();
    expect(mockProjectService.listWorkspaces).not.toHaveBeenCalled();
  });

  it("preserves clearly non-authority project edits for agents", async () => {
    const existing = buildProject();
    mockProjectService.getById.mockResolvedValue(existing);
    mockProjectService.update.mockResolvedValue(buildProject({ description: "Progress note" }));
    const app = await createApp({
      type: "agent",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({ description: "Progress note" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockProjectService.update).toHaveBeenCalledWith("project-1", { description: "Progress note" });
  });

  it("requires project settings permission from non-admin board users", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockAccessService.hasProjectPermission.mockResolvedValue(false);
    const app = await createApp({
      type: "board",
      userId: "board-viewer",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    });

    const envResult = await request(app)
      .patch("/api/projects/project-1")
      .send({ env: { TARGET: { type: "plain", value: "other" } } });
    const workspaceResult = await request(app)
      .post("/api/projects/project-1/workspaces")
      .send({ name: "Other repo", repoUrl: "https://github.com/acme/other.git" });

    expect([envResult.status, workspaceResult.status]).toEqual([403, 403]);
    expect(mockProjectService.update).not.toHaveBeenCalled();
    expect(mockProjectService.createWorkspace).not.toHaveBeenCalled();
  });

  it("allows a board editor with project settings permission to manage delivery authority", async () => {
    const workspace = {
      id: "workspace-1",
      projectId: "project-1",
      name: "Production repo",
      cwd: null,
      repoUrl: "https://github.com/acme/production.git",
      isPrimary: true,
    };
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.update.mockImplementation(async (_id, patch) => buildProject(patch));
    mockProjectService.createWorkspace.mockResolvedValue(workspace);
    mockProjectService.listWorkspaces.mockResolvedValue([workspace]);
    mockProjectService.updateWorkspace.mockResolvedValue(workspace);
    mockProjectService.removeWorkspace.mockResolvedValue(workspace);
    const app = await createApp({
      type: "board",
      userId: "board-editor",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    });

    const envResult = await request(app)
      .patch("/api/projects/project-1")
      .send({ env: { CLOUDFLARE_ACCOUNT_ID: { type: "plain", value: "production-target" } } });
    const githubResult = await request(app)
      .patch("/api/projects/project-1")
      .send({ githubConnectionId: "11111111-1111-4111-8111-111111111111" });
    const created = await request(app)
      .post("/api/projects/project-1/workspaces")
      .send({
        name: "Production repo",
        repoUrl: "https://github.com/acme/production.git",
        isPrimary: true,
      });
    const updated = await request(app)
      .patch("/api/projects/project-1/workspaces/workspace-1")
      .send({ isPrimary: true });
    const removed = await request(app)
      .delete("/api/projects/project-1/workspaces/workspace-1");

    expect([envResult.status, githubResult.status, created.status, updated.status, removed.status])
      .toEqual([200, 200, 201, 200, 200]);
    expect(mockAccessService.hasProjectPermission)
      .toHaveBeenCalledWith("project-1", "user", "board-editor", "project:settings");
    expect(mockGithubConnectionService.assertConnection)
      .toHaveBeenCalledWith("company-1", "11111111-1111-4111-8111-111111111111");
    expect(mockProjectService.createWorkspace).toHaveBeenCalled();
    expect(mockProjectService.updateWorkspace).toHaveBeenCalled();
    expect(mockProjectService.removeWorkspace).toHaveBeenCalled();
  });
});
