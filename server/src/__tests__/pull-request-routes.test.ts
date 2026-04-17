import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type WorkspaceShape = {
  id: string;
  companyId: string;
  projectId: string;
  status: string;
  branchName: string | null;
  baseRef: string | null;
  repoUrl: string | null;
  providerRef: string | null;
  sourceIssueId: string | null;
  metadata: Record<string, unknown> | null;
  name?: string;
  mode?: string;
};

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerServiceMocks() {
  vi.doMock("../services/index.js", () => ({
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    logActivity: mockLogActivity,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));
  // The scheduler is wired via onPullRequestRequested; mocking it to
  // a no-op keeps these tests focused on the HTTP layer.
  vi.doMock("../services/execution-workspace-timeout.js", () => ({
    onPullRequestRequested: vi.fn(),
    rescheduleBlockingPullRequestTimeouts: vi.fn(async () => ({ rescheduled: 0 })),
    cancelArchiveTimeout: vi.fn(),
  }));
}

async function createApp() {
  const [{ executionWorkspaceRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/execution-workspaces.js")>("../routes/execution-workspaces.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeWorkspace(overrides: Partial<WorkspaceShape> = {}): WorkspaceShape {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    status: "active",
    branchName: "feat/x",
    baseRef: "main",
    repoUrl: "https://git.example.com/r",
    providerRef: null,
    sourceIssueId: "issue-1",
    metadata: null,
    name: "alpha",
    mode: "isolated_workspace",
    ...overrides,
  };
}

describe("pull-request routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/execution-workspace-timeout.js");
    vi.doUnmock("../routes/execution-workspaces.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerServiceMocks();
    vi.resetAllMocks();
  });

  it("POST /pull-request/request returns the existing record idempotently", async () => {
    const existing = makeWorkspace({
      metadata: {
        pullRequest: {
          status: "opened",
          mode: "fire_and_forget",
          url: "https://git.example.com/pr/1",
          requestedAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: "2026-01-01T00:05:00.000Z",
        },
      },
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);

    const res = await request(await createApp())
      .post("/api/execution-workspaces/workspace-1/pull-request/request")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.pullRequest.status).toBe("opened");
    expect(res.body.pullRequest.url).toBe("https://git.example.com/pr/1");
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("POST /pull-request/result validates the body", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue(
      makeWorkspace({
        metadata: {
          pullRequest: {
            status: "requested",
            mode: "fire_and_forget",
            requestedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    const res = await request(await createApp())
      .post("/api/execution-workspaces/workspace-1/pull-request/result")
      .send({ status: "failed" }); // missing error
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("POST /pull-request/result rejects transition from terminal status", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue(
      makeWorkspace({
        metadata: {
          pullRequest: {
            status: "merged",
            mode: "fire_and_forget",
            requestedAt: "2026-01-01T00:00:00.000Z",
            resolvedAt: "2026-01-01T01:00:00.000Z",
          },
        },
      }),
    );
    const res = await request(await createApp())
      .post("/api/execution-workspaces/workspace-1/pull-request/result")
      .send({ status: "opened" });
    expect(res.status).toBe(422);
  });

  it("POST /pull-request/result returns 409 when no record exists", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue(makeWorkspace({ metadata: null }));
    const res = await request(await createApp())
      .post("/api/execution-workspaces/workspace-1/pull-request/result")
      .send({ status: "opened", url: "https://git.example.com/pr/1" });
    expect(res.status).toBe(409);
  });

  it("POST /pull-request/result updates metadata and emits resolved event", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue(
      makeWorkspace({
        status: "in_review",
        metadata: {
          pullRequest: {
            status: "requested",
            mode: "blocking",
            requestedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    mockExecutionWorkspaceService.update.mockImplementation(async (_id, patch) => {
      return {
        ...makeWorkspace({
          status: patch?.status ?? "in_review",
          metadata: (patch as any).metadata,
        }),
      };
    });
    const res = await request(await createApp())
      .post("/api/execution-workspaces/workspace-1/pull-request/result")
      .send({ status: "merged", sha: "abc123", url: "https://git.example.com/pr/1" });
    expect(res.status).toBe(200);
    expect(res.body.workspaceStatus).toBe("archived");
    expect(res.body.pullRequest.status).toBe("merged");

    const activityCall = mockLogActivity.mock.calls.find(
      ([, input]: [unknown, { action?: string }]) => input.action === "execution_workspace.pull_request_resolved",
    );
    expect(activityCall).toBeDefined();
    const [, input] = activityCall as [unknown, Record<string, unknown>];
    expect((input.details as any).source).toBe("consumer_result");
    expect((input.details as any).mode).toBe("blocking");
  });

  it("PATCH archive returns 409 while a blocking record is still in requested", async () => {
    const existing = makeWorkspace({
      status: "in_review",
      metadata: {
        pullRequest: {
          status: "requested",
          mode: "blocking",
          requestedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      workspaceId: existing.id,
      state: "ready",
      blockingReasons: [],
      warnings: [],
      linkedIssues: [],
      plannedActions: [],
      isDestructiveCloseAllowed: true,
      isSharedWorkspace: false,
      isProjectPrimaryWorkspace: false,
      git: null,
      runtimeServices: [],
    });

    const res = await request(await createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });
    expect(res.status).toBe(409);
    expect(res.body.pullRequest.status).toBe("requested");
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
  });
});
