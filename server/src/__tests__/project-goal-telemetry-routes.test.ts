import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectRoutes } from "../routes/projects.js";
import { goalRoutes } from "../routes/goals.js";
import { errorHandler } from "../middleware/index.js";

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
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackProjectCreated = vi.hoisted(() => vi.fn());
const mockTrackGoalCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackProjectCreated: mockTrackProjectCreated,
    trackGoalCreated: mockTrackGoalCreated,
  };
});

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(async () => true), canAgent: vi.fn(async () => true) }),
  agentService: () => ({ findById: vi.fn(async () => null), findByCompany: vi.fn(async () => []), update: vi.fn(async (id: string, data: any) => ({ id, ...data })) }),
  executionWorkspaceService: () => ({ findById: vi.fn(async () => null) }),
  heartbeatService: () => ({ findRunById: vi.fn(async () => null), queueIssueAssignmentWakeup: vi.fn() }),
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  issueApprovalService: () => ({ findById: vi.fn(async () => null) }),
  issueService: () => ({ findById: vi.fn(async () => null), update: vi.fn(async (id: string, data: any) => ({ id, ...data })), countRecentByAgent: vi.fn(async () => 0) }),
  documentService: () => ({ findByIssueAndKey: vi.fn(async () => null) }),
  routineService: () => ({ findById: vi.fn(async () => null) }),
  workProductService: () => ({ findByIssue: vi.fn(async () => []) }),
  goalService: () => mockGoalService,
  feedbackService: () => ({}),
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

function createApp(route: ReturnType<typeof projectRoutes> | ReturnType<typeof goalRoutes>) {
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
  app.use("/api", route);
  app.use(errorHandler);
  return app;
}

describe("project and goal telemetry routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
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
    const res = await request(createApp(projectRoutes({} as any)))
      .post("/api/companies/company-1/projects")
      .send({ name: "Telemetry project" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockTrackProjectCreated).toHaveBeenCalledWith(expect.anything());
  });

  it("emits telemetry when a goal is created", async () => {
    const res = await request(createApp(goalRoutes({} as any)))
      .post("/api/companies/company-1/goals")
      .send({ title: "Telemetry goal", level: "team" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockTrackGoalCreated).toHaveBeenCalledWith(expect.anything(), { goalLevel: "team" });
  });
});
