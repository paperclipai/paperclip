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
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockTelemetryTrack = vi.hoisted(() => vi.fn());

vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/workspace-command-authz.js", async () =>
    vi.importActual<typeof import("../routes/workspace-command-authz.ts")>("../routes/workspace-command-authz.ts"),
  );
  vi.doMock("../routes/workspace-command-authz.ts", async () =>
    vi.importActual<typeof import("../routes/workspace-command-authz.ts")>("../routes/workspace-command-authz.ts"),
  );
  vi.doMock("../routes/workspace-runtime-service-authz.js", async () =>
    vi.importActual<typeof import("../routes/workspace-runtime-service-authz.ts")>(
      "../routes/workspace-runtime-service-authz.ts",
    ),
  );
  vi.doMock("../routes/workspace-runtime-service-authz.ts", async () =>
    vi.importActual<typeof import("../routes/workspace-runtime-service-authz.ts")>(
      "../routes/workspace-runtime-service-authz.ts",
    ),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/validate.ts", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/index.js", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/index.ts", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/logger.js", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../middleware/logger.ts", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));
  vi.doMock("../telemetry.ts", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  const servicesIndexMock = () => ({
    goalService: () => mockGoalService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => mockWorkspaceOperationService,
  });
  vi.doMock("../services/index.js", servicesIndexMock);
  vi.doMock("../services/index.ts", servicesIndexMock);

  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
  vi.doMock("../services/workspace-runtime.ts", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

let projectGoalRouteImportSeq = 0;

async function createApp(routeType: "project" | "goal") {
  projectGoalRouteImportSeq += 1;
  const { errorHandler } = await import("../middleware/index.ts");
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
    const routeModulePath = `../routes/projects.ts?project-goal-telemetry-${projectGoalRouteImportSeq}`;
    const { projectRoutes } = await import(routeModulePath) as typeof import("../routes/projects.ts");
    app.use("/api", projectRoutes({} as any));
  } else {
    const routeModulePath = `../routes/goals.ts?project-goal-telemetry-${projectGoalRouteImportSeq}`;
    const { goalRoutes } = await import(routeModulePath) as typeof import("../routes/goals.ts");
    app.use("/api", goalRoutes({} as any));
  }
  app.use(errorHandler);
  return app;
}

describe("project and goal telemetry routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../telemetry.ts");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/index.ts");
    vi.doUnmock("../services/workspace-runtime.js");
    vi.doUnmock("../services/workspace-runtime.ts");
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/projects.ts");
    vi.doUnmock("../routes/goals.js");
    vi.doUnmock("../routes/goals.ts");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/authz.ts");
    vi.doUnmock("../routes/workspace-command-authz.js");
    vi.doUnmock("../routes/workspace-command-authz.ts");
    vi.doUnmock("../routes/workspace-runtime-service-authz.js");
    vi.doUnmock("../routes/workspace-runtime-service-authz.ts");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/index.ts");
    vi.doUnmock("../middleware/validate.js");
    vi.doUnmock("../middleware/validate.ts");
    vi.doUnmock("../middleware/logger.js");
    vi.doUnmock("../middleware/logger.ts");
    registerModuleMocks();
    vi.resetAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: mockTelemetryTrack });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
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
