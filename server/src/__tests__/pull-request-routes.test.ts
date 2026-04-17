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
  updateWithRowLock: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockRunArchiveSideEffects = vi.hoisted(() =>
  vi.fn(async () => ({
    cleanupWarnings: [] as string[],
    cleaned: true,
    status: "archived" as const,
    cleanupReason: null as string | null,
    closedAt: new Date(),
  })),
);

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
  // Archive side-effects hit git / child processes; mock to a
  // no-failure success so route tests can exercise the terminal
  // blocking path without a real workspace.
  vi.doMock("../services/execution-workspace-archive.js", () => ({
    runArchiveSideEffects: mockRunArchiveSideEffects,
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
    vi.doUnmock("../services/execution-workspace-archive.js");
    vi.doUnmock("../routes/execution-workspaces.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerServiceMocks();
    vi.resetAllMocks();
    mockRunArchiveSideEffects.mockImplementation(async () => ({
      cleanupWarnings: [],
      cleaned: true,
      status: "archived",
      cleanupReason: null,
      closedAt: new Date(),
    }));
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

  function stubRowLockWithRecord(record: Record<string, unknown> | null, currentStatus = "active") {
    const workspace = makeWorkspace({
      status: currentStatus,
      metadata: record ? { pullRequest: record } : null,
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue(workspace);
    mockExecutionWorkspaceService.updateWithRowLock.mockImplementation(async (_id, _cid, apply) => {
      const outcome = await apply(workspace as any);
      if (!outcome) return { workspace, result: null };
      if (!outcome.patch) return { workspace, result: outcome.result };
      const nextWorkspace = {
        ...workspace,
        ...outcome.patch,
        metadata: outcome.patch.metadata ?? workspace.metadata,
        status: outcome.patch.status ?? workspace.status,
      };
      return { workspace: nextWorkspace, result: outcome.result };
    });
  }

  it("POST /pull-request/result rejects transition from terminal status", async () => {
    stubRowLockWithRecord({
      status: "merged",
      mode: "fire_and_forget",
      requestedAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: "2026-01-01T01:00:00.000Z",
    });
    const res = await request(await createApp())
      .post("/api/execution-workspaces/workspace-1/pull-request/result")
      .send({ status: "opened" });
    expect(res.status).toBe(409);
    expect(res.body.pullRequest.status).toBe("merged");
  });

  it("POST /pull-request/result returns 409 when no record exists", async () => {
    stubRowLockWithRecord(null);
    const res = await request(await createApp())
      .post("/api/execution-workspaces/workspace-1/pull-request/result")
      .send({ status: "opened", url: "https://git.example.com/pr/1" });
    expect(res.status).toBe(409);
  });

  it("POST /pull-request/result updates metadata and emits resolved event", async () => {
    stubRowLockWithRecord(
      {
        status: "requested",
        mode: "blocking",
        requestedAt: "2026-01-01T00:00:00.000Z",
      },
      "in_review",
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
    expect((input.details as any).projectId).toBe("project-1");
    expect((input.details as any).record).toBeDefined();
    expect((input.details as any).record.status).toBe("merged");
  });

  it("POST /pull-request/result emits resolved event with final workspaceStatus (after cleanup)", async () => {
    // Reviewer finding: the resolved event should reflect the FINAL
    // post-cleanup state. Here the side-effects mock downgrades to
    // cleanup_failed; the emitted event must match.
    stubRowLockWithRecord(
      {
        status: "requested",
        mode: "blocking",
        requestedAt: "2026-01-01T00:00:00.000Z",
      },
      "in_review",
    );
    mockExecutionWorkspaceService.update.mockImplementation(async (_id, patch) => {
      return makeWorkspace({
        status: patch?.status ?? "in_review",
        metadata: (patch as any).metadata,
      });
    });
    // Override the default no-failure helper: simulate cleanup failure.
    mockRunArchiveSideEffects.mockResolvedValueOnce({
      cleanupWarnings: ["teardown command crashed"],
      cleaned: false,
      status: "cleanup_failed",
      cleanupReason: "teardown command crashed",
      closedAt: new Date(),
    });

    const res = await request(await createApp())
      .post("/api/execution-workspaces/workspace-1/pull-request/result")
      .send({ status: "merged", sha: "abc", url: "https://git.example.com/pr/1" });
    expect(res.status).toBe(200);
    // Response uses the final status, not the intermediate "archived".
    expect(res.body.workspaceStatus).toBe("cleanup_failed");

    const resolved = mockLogActivity.mock.calls.find(
      ([, input]: [unknown, { action?: string }]) =>
        input.action === "execution_workspace.pull_request_resolved",
    );
    expect(resolved).toBeDefined();
    const [, input] = resolved as [unknown, Record<string, unknown>];
    // Critical: the event's workspaceStatus must match the post-
    // cleanup final state, not the intermediate archived.
    expect((input.details as any).workspaceStatus).toBe("cleanup_failed");
  });

  it("POST /pull-request/result races with timeout: 409 when record is already terminal", async () => {
    // Simulates a late consumer result arriving after the scheduler
    // has already moved the record to skipped. The locked re-read
    // inside the transaction sees the terminal record and short-
    // circuits with 409 instead of blindly writing the consumer's
    // desired transition.
    stubRowLockWithRecord(
      {
        status: "skipped",
        mode: "blocking",
        requestedAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: "2026-01-01T00:30:00.000Z",
        error: "archive_timeout_reached",
      },
      "archived",
    );
    const res = await request(await createApp())
      .post("/api/execution-workspaces/workspace-1/pull-request/result")
      .send({ status: "merged", sha: "abc", url: "https://git.example.com/pr/1" });
    expect(res.status).toBe(409);
    expect(res.body.pullRequest.status).toBe("skipped");
    expect(res.body.pullRequest.error).toBe("archive_timeout_reached");
    // No resolved event should fire on the late loser.
    const resolvedCall = mockLogActivity.mock.calls.find(
      ([, input]: [unknown, { action?: string }]) => input.action === "execution_workspace.pull_request_resolved",
    );
    expect(resolvedCall).toBeUndefined();
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
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
