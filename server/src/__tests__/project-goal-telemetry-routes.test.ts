import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  createWorkspace: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockTelemetryTrack = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  environmentService: () => mockEnvironmentService,
  goalService: () => mockGoalService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
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
    goalService: () => mockGoalService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

async function createApp(routeType: "project" | "goal") {
  const { errorHandler } = await vi.importActual<typeof import("../middleware/index.js")>(
    "../middleware/index.js",
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  if (routeType === "project") {
    const { projectRoutes } = await vi.importActual<typeof import("../routes/projects.js")>(
      "../routes/projects.js",
    );
    app.use("/api", projectRoutes({} as any));
  } else {
    const { goalRoutes } = await vi.importActual<typeof import("../routes/goals.js")>(
      "../routes/goals.js",
    );
    app.use("/api", goalRoutes({} as any));
  }
  app.use(errorHandler);
  return app;
}

describe("project and goal telemetry routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/workspace-runtime.js");
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/goals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: mockTelemetryTrack });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockEnvironmentService.getById.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
    mockProjectService.create.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Telemetry project",
      description: null,
      status: "backlog",
    });
    mockGoalService.create.mockResolvedValue({
      id: "goal-1",
      companyId: "company-1",
      title: "Telemetry goal",
      description: null,
      level: "team",
      status: "planned",
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("emits telemetry when a project is created", async () => {
    const app = await createApp("project");
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({ name: "Telemetry project" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTelemetryTrack).toHaveBeenCalledWith("project.created");
  });

  it("emits telemetry when a goal is created", async () => {
    const app = await createApp("goal");
    const res = await request(app)
      .post("/api/companies/company-1/goals")
      .send({ title: "Telemetry goal", level: "team" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTelemetryTrack).toHaveBeenCalledWith("goal.created", { goal_level: "team" });
  });
});
