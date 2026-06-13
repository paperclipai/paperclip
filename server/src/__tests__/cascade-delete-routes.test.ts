import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  deleteWithCascade: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  deleteWithCascade: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  deleteWithCascade: vi.fn(),
}));

const mockRoutineService = vi.hoisted(() => ({
  getById: vi.fn(),
  deleteWithCascade: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  goalService: () => mockGoalService,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  logActivity: mockLogActivity,
}));

const testIssue = {
  id: "issue-1",
  companyId: "company-1",
  title: "Test Issue",
  status: "todo",
  priority: "medium",
};

const testGoal = {
  id: "goal-1",
  companyId: "company-1",
  title: "Test Goal",
};

const testProject = {
  id: "project-1",
  companyId: "company-1",
  name: "Test Project",
};

function createBoardApp() {
  const app = express();
  app.use((req: any, _res: any, next: any) => {
    req.actor = { type: "board", companyId: "company-1", userId: "user-1" };
    req.companyAccess = new Map([["company-1", true]]);
    next();
  });
  return app;
}

function createAgentApp() {
  const app = express();
  app.use((req: any, _res: any, next: any) => {
    req.actor = { type: "agent", companyId: "company-1", agentId: "agent-1" };
    req.companyAccess = new Map([["company-1", true]]);
    next();
  });
  return app;
}

describe("DELETE /issues/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 204 on success for board actor", async () => {
    mockIssueService.getById.mockResolvedValue(testIssue);
    mockIssueService.deleteWithCascade.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);

    const { issueRoutes } = await import("../routes/issues.js");
    const app = createBoardApp();
    app.use(issueRoutes(null as any, null as any));

    const res = await request(app).delete("/issues/issue-1");
    expect(res.status).toBe(204);
    expect(mockIssueService.deleteWithCascade).toHaveBeenCalledWith("issue-1");
  });

  it("returns 403 for non-board actor", async () => {
    mockIssueService.getById.mockResolvedValue(testIssue);

    const { issueRoutes } = await import("../routes/issues.js");
    const app = createAgentApp();
    app.use(issueRoutes(null as any, null as any));

    const res = await request(app).delete("/issues/issue-1");
    expect(res.status).toBe(403);
    expect(mockIssueService.deleteWithCascade).not.toHaveBeenCalled();
  });

  it("returns 404 when issue not found", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const { issueRoutes } = await import("../routes/issues.js");
    const app = createBoardApp();
    app.use(issueRoutes(null as any, null as any));

    const res = await request(app).delete("/issues/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /goals/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 204 on success for board actor", async () => {
    mockGoalService.getById.mockResolvedValue(testGoal);
    mockGoalService.deleteWithCascade.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);

    const { goalRoutes } = await import("../routes/goals.js");
    const app = createBoardApp();
    app.use(goalRoutes(null as any));

    const res = await request(app).delete("/goals/goal-1");
    expect(res.status).toBe(204);
    expect(mockGoalService.deleteWithCascade).toHaveBeenCalledWith("goal-1");
  });

  it("returns 403 for non-board actor", async () => {
    mockGoalService.getById.mockResolvedValue(testGoal);

    const { goalRoutes } = await import("../routes/goals.js");
    const app = createAgentApp();
    app.use(goalRoutes(null as any));

    const res = await request(app).delete("/goals/goal-1");
    expect(res.status).toBe(403);
  });

  it("returns 404 when goal not found", async () => {
    mockGoalService.getById.mockResolvedValue(null);

    const { goalRoutes } = await import("../routes/goals.js");
    const app = createBoardApp();
    app.use(goalRoutes(null as any));

    const res = await request(app).delete("/goals/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /projects/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 204 on success for board actor", async () => {
    mockProjectService.getById.mockResolvedValue(testProject);
    mockProjectService.deleteWithCascade.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);

    const { projectRoutes } = await import("../routes/projects.js");
    const app = createBoardApp();
    app.use(projectRoutes(null as any));

    const res = await request(app).delete("/projects/project-1");
    expect(res.status).toBe(204);
    expect(mockProjectService.deleteWithCascade).toHaveBeenCalledWith("project-1");
  });

  it("returns 403 for non-board actor", async () => {
    mockProjectService.getById.mockResolvedValue(testProject);

    const { projectRoutes } = await import("../routes/projects.js");
    const app = createAgentApp();
    app.use(projectRoutes(null as any));

    const res = await request(app).delete("/projects/project-1");
    expect(res.status).toBe(403);
  });
});
