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
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockScopedAccessService = vi.hoisted(() => ({
  resolveAccessibleDepartmentIds: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackProjectCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackProjectCreated: mockTrackProjectCreated,
  };
});

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockScopedAccessService,
}));

vi.mock("../services/index.js", () => ({
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

async function createApp() {
  const { projectRoutes } = await import("../routes/projects.js");
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    departmentId: null,
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

describe("project scoped mutation routes", () => {
  const engineeringId = "22222222-2222-4222-8222-222222222222";
  const financeId = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.createWorkspace.mockResolvedValue(null);
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
    mockScopedAccessService.resolveAccessibleDepartmentIds.mockResolvedValue({
      companyWide: false,
      departmentIds: [engineeringId],
    });
  });

  it("allows creation inside a managed department", async () => {
    mockProjectService.create.mockResolvedValue(buildProject({ departmentId: engineeringId }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Scoped project",
        departmentId: engineeringId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ departmentId: engineeringId }),
    );
  });

  it("blocks moving a project outside the managed department scope", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject({ departmentId: engineeringId }));

    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/11111111-1111-4111-8111-111111111111")
      .send({
        departmentId: financeId,
      });

    expect(res.status).toBe(403);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("blocks workspace creation outside the managed department scope", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject({ departmentId: financeId }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/projects/11111111-1111-4111-8111-111111111111/workspaces")
      .send({
        name: "Finance workspace",
        cwd: "/tmp/finance",
      });

    expect(res.status).toBe(403);
    expect(mockProjectService.createWorkspace).not.toHaveBeenCalled();
  });
});
