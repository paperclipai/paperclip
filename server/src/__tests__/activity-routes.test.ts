import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockScopedAccessService = vi.hoisted(() => ({
  resolveAccessibleDepartmentIds: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockScopedAccessService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  projectService: () => mockProjectService,
}));

function createApp() {
  return createAppWithOptions();
}

function createDb(runCompanyId: string | null = null) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => (runCompanyId ? [{ companyId: runCompanyId }] : [])),
      })),
    })),
  };
}

function createAppWithOptions(opts?: {
  actor?: Record<string, unknown>;
  db?: unknown;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...opts?.actor,
    };
    next();
  });
  app.use("/api", activityRoutes((opts?.db ?? createDb()) as any));
  app.use(errorHandler);
  return app;
}

describe("activity routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScopedAccessService.resolveAccessibleDepartmentIds.mockResolvedValue({
      companyWide: true,
      departmentIds: [],
    });
    mockProjectService.getById.mockResolvedValue(null);
  });

  it("resolves issue identifiers before loading runs", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
      departmentId: null,
      projectId: null,
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
      },
    ]);

    const res = await request(createApp()).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1");
    expect(res.body).toEqual([{ runId: "run-1" }]);
  });

  it("passes department scope filters to company activity listing", async () => {
    mockScopedAccessService.resolveAccessibleDepartmentIds.mockResolvedValue({
      companyWide: false,
      departmentIds: ["dept-engineering"],
    });
    mockActivityService.list.mockResolvedValue([]);

    const res = await request(createApp()).get("/api/companies/company-1/activity");

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: undefined,
      entityId: undefined,
      scopeDepartmentIds: ["dept-engineering"],
    });
  });

  it("rejects activity creation outside the actor company scope", async () => {
    const res = await request(createApp()).post("/api/companies/company-2/activity").send({
      actorType: "system",
      actorId: "system",
      action: "issue.created",
      entityType: "issue",
      entityId: "issue-1",
    });

    expect(res.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("rejects activity creation for non-admin board actors", async () => {
    const res = await request(createApp()).post("/api/companies/company-1/activity").send({
      action: "issue.created",
      entityType: "issue",
      entityId: "issue-1",
    });

    expect(res.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("derives activity actor identity from the authenticated request", async () => {
    mockActivityService.create.mockResolvedValue({
      id: "event-1",
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      action: "issue.created",
      entityType: "issue",
      entityId: "issue-1",
      agentId: null,
      runId: null,
      details: null,
    });

    const res = await request(
      createAppWithOptions({
        actor: {
          isInstanceAdmin: true,
        },
      }),
    )
      .post("/api/companies/company-1/activity")
      .send({
        actorType: "system",
        actorId: "spoofed-system",
        action: "issue.created",
        entityType: "issue",
        entityId: "issue-1",
      });

    expect(res.status).toBe(201);
    expect(mockActivityService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        action: "issue.created",
        entityType: "issue",
        entityId: "issue-1",
      }),
    );
  });

  it("blocks issue activity reads outside the scoped department set", async () => {
    mockScopedAccessService.resolveAccessibleDepartmentIds.mockResolvedValue({
      companyWide: false,
      departmentIds: ["dept-engineering"],
    });
    mockIssueService.getById.mockResolvedValue({
      id: "issue-uuid-2",
      companyId: "company-1",
      departmentId: "dept-finance",
      projectId: null,
    });

    const res = await request(createApp()).get("/api/issues/issue-uuid-2/activity");

    expect(res.status).toBe(403);
    expect(mockActivityService.forIssue).not.toHaveBeenCalled();
  });

  it("filters run issue lookups to the scoped department set", async () => {
    mockScopedAccessService.resolveAccessibleDepartmentIds.mockResolvedValue({
      companyWide: false,
      departmentIds: ["dept-engineering"],
    });
    mockActivityService.issuesForRun.mockResolvedValue([
      {
        issueId: "issue-1",
        identifier: "PAP-1",
        title: "Engineering issue",
        status: "todo",
        priority: "medium",
        departmentId: "dept-engineering",
      },
      {
        issueId: "issue-2",
        identifier: "PAP-2",
        title: "Finance issue",
        status: "todo",
        priority: "medium",
        departmentId: "dept-finance",
      },
    ]);

    const res = await request(
      createAppWithOptions({
        db: createDb("company-1"),
      }),
    ).get("/api/heartbeat-runs/run-1/issues");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        issueId: "issue-1",
        identifier: "PAP-1",
        title: "Engineering issue",
        status: "todo",
        priority: "medium",
      },
    ]);
  });

  it("rejects run issue lookups outside the actor company scope", async () => {
    const res = await request(
      createAppWithOptions({
        db: createDb("company-2"),
      }),
    ).get("/api/heartbeat-runs/run-1/issues");

    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });
});
