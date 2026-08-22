import express from "express";
import { once } from "node:events";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { HttpError } from "../errors.js";
import { createCloseReadinessDemandLimiter } from "../services/execution-workspace-close-readiness-demand.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listOverview: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  archiveWorkspaceUnderLifecycleLock: vi.fn(),
  fenceClosedWorkspaceDestruction: vi.fn(),
  reconcileExecutionWorkspaceBranch: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
  assertRuntimeControlAvailable: vi.fn(async () => undefined),
}));

const mockWorkspaceRuntimeLeaseService = vi.hoisted(() => ({
  claim: vi.fn(async () => ({ outcome: "created", ownerKey: "issue:issue-1", lease: null, reclaimedFrom: null })),
  release: vi.fn(async () => ({ released: false, ownerKey: null })),
  get: vi.fn(async () => null),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockEnvironmentRuntimeService = vi.hoisted(() => ({
  destroyReusableSandboxLeases: vi.fn(async () => undefined),
}));

const mockCloseReadinessDemandLimiter = vi.hoisted(() => ({
  acquire: vi.fn(() => vi.fn()),
  recordAborted: vi.fn(),
  recordTimedOut: vi.fn(),
  recordDegraded: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  closeReadinessDemandLimiter: mockCloseReadinessDemandLimiter,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
  workspaceRuntimeLeaseService: () => mockWorkspaceRuntimeLeaseService,
  LEASED_WORKSPACE_RUNTIME_ACTIONS: ["start", "stop", "restart", "repair"],
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntimeService,
}));

const mockWorkspaceRuntimeTeardown = vi.hoisted(() => ({
  stopRuntimeServicesForExecutionWorkspace: vi.fn(async () => undefined),
  cleanupExecutionWorkspaceArtifacts: vi.fn(async () => ({ cleaned: true, warnings: [] as string[] })),
}));

vi.mock("../services/workspace-runtime.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/workspace-runtime.js")>();
  return {
    ...actual,
    stopRuntimeServicesForExecutionWorkspace:
      mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace,
    cleanupExecutionWorkspaceArtifacts: mockWorkspaceRuntimeTeardown.cleanupExecutionWorkspaceArtifacts,
  };
});

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("execution workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
    mockExecutionWorkspaceService.listOverview.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    mockExecutionWorkspaceService.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockCloseReadinessDemandLimiter.acquire.mockImplementation(() => vi.fn());
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue(null);
  });

  it("propagates an abort signal without hydrating a duplicate Git inspection", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      workspaceId: "workspace-1",
      state: "blocked",
      blockingReasons: ["Git status is unavailable"],
      requiresGitUnavailableAcknowledgement: true,
      gitInspection: {
        state: "unavailable",
        errorCode: "workspace_git_scan_saturated",
        message: "Git status is unavailable",
        retryable: false,
      },
      git: null,
    });

    const res = await request(createApp()).get("/api/execution-workspaces/workspace-1/close-readiness");

    expect(res.status).toBe(200);
    expect(res.body.gitInspection.state).toBe("unavailable");
    expect(mockExecutionWorkspaceService.getById).toHaveBeenCalledWith("workspace-1", { inspectGit: false });
    expect(mockExecutionWorkspaceService.getCloseReadiness).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        fairnessKeys: ["actor:user:local-board"],
      }),
    );
    expect(mockCloseReadinessDemandLimiter.acquire).toHaveBeenCalledWith({
      workspaceKey: "workspace-1",
      tenantKey: "company:company-1",
    });
  });

  it("rejects saturation before database or service allocations and advertises retry backoff", async () => {
    mockCloseReadinessDemandLimiter.acquire.mockImplementation(() => {
      throw new HttpError(503, "Workspace close readiness is temporarily at capacity", {
        code: "close_readiness_saturated",
        retryable: false,
      });
    });

    const res = await request(createApp()).get("/api/execution-workspaces/workspace-1/close-readiness");

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(res.body).toMatchObject({ code: "close_readiness_saturated" });
    expect(mockExecutionWorkspaceService.getById).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.getCloseReadiness).not.toHaveBeenCalled();
  });

  it("aborts the service waiter and releases route demand when the HTTP client disconnects", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
    });
    let capturedSignal: AbortSignal | null = null;
    const release = vi.fn();
    mockCloseReadinessDemandLimiter.acquire.mockReturnValue(release);
    mockExecutionWorkspaceService.getCloseReadiness.mockImplementation(
      (_id: string, options: { signal: AbortSignal }) => new Promise((resolve) => {
        capturedSignal = options.signal;
        options.signal.addEventListener("abort", () => resolve(null), { once: true });
      }),
    );

    const pendingRequest = request(createApp()).get("/api/execution-workspaces/workspace-1/close-readiness");
    const completion = pendingRequest.then(
      () => undefined,
      () => undefined,
    );
    await vi.waitFor(() => expect(capturedSignal).not.toBeNull());
    pendingRequest.abort();
    await completion;

    await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true));
    expect(mockCloseReadinessDemandLimiter.recordAborted).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps health responsive and route demand bounded during thousands of close-readiness requests", async () => {
    const limiter = createCloseReadinessDemandLimiter({
      maxWaiters: 64,
      maxWaitersPerWorkspace: 8,
      maxWaitersPerTenant: 32,
      warningIntervalMs: 60_000,
    });
    mockCloseReadinessDemandLimiter.acquire.mockImplementation(limiter.acquire.bind(limiter));
    mockCloseReadinessDemandLimiter.recordAborted.mockImplementation(limiter.recordAborted.bind(limiter));
    mockCloseReadinessDemandLimiter.recordTimedOut.mockImplementation(limiter.recordTimedOut.bind(limiter));
    mockExecutionWorkspaceService.getById.mockImplementation(async (id: string) => ({
      id,
      companyId: "company-1",
    }));
    let releaseInspections!: () => void;
    const inspectionsBlocked = new Promise<void>((resolve) => {
      releaseInspections = resolve;
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockImplementation(async (id: string) => {
      await inspectionsBlocked;
      return {
        workspaceId: id,
        state: "ready",
        blockingReasons: [],
        gitInspection: { state: "available" },
      };
    });

    const app = createApp();
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const client = request(server);
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    const baselineMemory = process.memoryUsage();
    eventLoopDelay.enable();
    try {
      const requestCount = 2_000;
      const hotRequestCount = 1_000;
      const routeWaveSize = 250;
      const stormRequests: Array<Promise<number>> = [];
      const healthLatencies: number[] = [];
      let settledRequestCount = 0;
      for (let waveStart = 0; waveStart < requestCount; waveStart += routeWaveSize) {
        const waveEnd = Math.min(requestCount, waveStart + routeWaveSize);
        for (let index = waveStart; index < waveEnd; index += 1) {
          const workspaceId = index < hotRequestCount ? "hot" : `workspace-${index % 80}`;
          stormRequests.push(
            client
              .get(`/api/execution-workspaces/${workspaceId}/close-readiness`)
              .then((response) => {
                settledRequestCount += 1;
                return response.status;
              }),
          );
        }
        await vi.waitFor(() => {
          const snapshot = limiter.snapshot();
          expect(snapshot.totals.admitted + snapshot.totals.rejected).toBe(waveEnd);
        }, { timeout: 5_000 });
        await vi.waitFor(() => {
          expect(settledRequestCount).toBeGreaterThanOrEqual(waveEnd - limiter.snapshot().waiterCount);
        }, { timeout: 5_000 });
        const remainingHealthRequests = 100 - healthLatencies.length;
        const waveHealthLatencies = await Promise.all(Array.from(
          { length: Math.min(13, remainingHealthRequests) },
          async () => {
            const startedAt = performance.now();
            const response = await client.get("/api/health");
            expect(response.status).toBe(200);
            return performance.now() - startedAt;
          },
        ));
        healthLatencies.push(...waveHealthLatencies);
      }
      const peakMemory = process.memoryUsage();
      releaseInspections();
      const statuses = await Promise.all(stormRequests);
      stormRequests.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const settledMemory = process.memoryUsage();
      const snapshot = limiter.snapshot();
      const sortedHealthLatencies = [...healthLatencies].sort((a, b) => a - b);
      const healthPercentile = (percentile: number) =>
        sortedHealthLatencies[Math.ceil(sortedHealthLatencies.length * percentile) - 1]!;
      const healthP50Ms = healthPercentile(0.5);
      const healthP95Ms = healthPercentile(0.95);
      const healthP99Ms = healthPercentile(0.99);
      const eventLoopP99Ms = eventLoopDelay.percentile(99) / 1_000_000;
      const mib = 1024 * 1024;
      const succeeded = statuses.filter((status) => status === 200).length;
      const rejected = statuses.filter((status) => status === 503).length;

      expect(succeeded).toBeLessThanOrEqual(32);
      expect(rejected).toBeGreaterThan(1_900);
      expect(snapshot).toMatchObject({
        waiterCount: 0,
        workspaceKeyCount: 0,
        tenantKeyCount: 0,
      });
      expect(snapshot.peakWaiters).toBeLessThanOrEqual(32);
      expect(healthP99Ms).toBeLessThan(250);
      expect(eventLoopP99Ms).toBeLessThan(250);
      expect(peakMemory.heapUsed - baselineMemory.heapUsed).toBeLessThan(128 * mib);
      expect(peakMemory.rss - baselineMemory.rss).toBeLessThan(192 * mib);
      // V8 can retain a larger young-generation allocation after the Promise
      // wave in a loaded serialized shard even when every route waiter is gone.
      // Keep a hard ceiling that still fails unbounded request retention.
      expect(settledMemory.heapUsed - baselineMemory.heapUsed).toBeLessThan(128 * mib);
      expect(settledMemory.rss - baselineMemory.rss).toBeLessThan(192 * mib);
      console.info("close-readiness route stress evidence", {
        requests: requestCount,
        hotKeyRequests: hotRequestCount,
        succeeded,
        rejected,
        peakRouteWaiters: snapshot.peakWaiters,
        healthP50Ms: Number(healthP50Ms.toFixed(1)),
        healthP95Ms: Number(healthP95Ms.toFixed(1)),
        healthP99Ms: Number(healthP99Ms.toFixed(1)),
        eventLoopDelayP99Ms: Number(eventLoopP99Ms.toFixed(1)),
        heapPeakDeltaMiB: Number(((peakMemory.heapUsed - baselineMemory.heapUsed) / mib).toFixed(1)),
        rssPeakDeltaMiB: Number(((peakMemory.rss - baselineMemory.rss) / mib).toFixed(1)),
        heapSettledDeltaMiB: Number(((settledMemory.heapUsed - baselineMemory.heapUsed) / mib).toFixed(1)),
        rssSettledDeltaMiB: Number(((settledMemory.rss - baselineMemory.rss) / mib).toFixed(1)),
      });
    } finally {
      releaseInspections();
      eventLoopDelay.disable();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  }, 15_000);

  it("uses summary mode for lightweight workspace lookups", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/execution-workspaces?summary=true&reuseEligible=true");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    expect(mockExecutionWorkspaceService.listSummaries).toHaveBeenCalledWith("company-1", {
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      status: undefined,
      reuseEligible: true,
    });
    expect(mockExecutionWorkspaceService.list).not.toHaveBeenCalled();
  });

  it("delegates bounded workspace overview queries", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/workspace-overview?status=active,idle&limit=25&offset=10");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    expect(mockExecutionWorkspaceService.listOverview).toHaveBeenCalledWith("company-1", {
      status: ["active", "idle"],
      limit: 25,
      offset: 10,
    });
  });

  it("rejects invalid workspace overview pagination", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/workspace-overview?limit=1000");

    expect(res.status).toBe(422);
    expect(mockExecutionWorkspaceService.listOverview).not.toHaveBeenCalled();
  });

  it.each([
    ["forward", { mode: "forward" }],
    ["override", { mode: "override", reason: "operator break-glass" }],
    ["quarantine_restore", { mode: "quarantine_restore", reason: "rescue dirty branch" }],
  ])("rejects agent actors for %s branch reconciliation", async (_mode, body) => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    }))
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send(body);

    expect(res.status).toBe(403);
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("logs branch reconciliation activity after the service operation succeeds", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/current",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:test",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/current",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "ancestor",
        cleanliness: "clean",
        statusEntryCount: 0,
        plainLanguageReason: "forward",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "forward" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).toHaveBeenCalledWith("workspace-1", {
      mode: "forward",
      reason: null,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "execution_workspace.branch_reconciled",
      entityType: "execution_workspace",
      entityId: "workspace-1",
      details: expect.objectContaining({
        mode: "forward",
        fromBranch: "feature/recorded",
        toBranch: "feature/current",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "ancestor",
        fingerprint: "workspace_incoherence:v1:sha256:test",
        sourceIssueId: "issue-1",
        auditCommentId: "comment-1",
        recoveryActionId: "recovery-1",
      }),
    }));
  });

  it("accepts quarantine_restore, logs the rescue ref, and wakes the restored source issue", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/recorded",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/live",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "diverged",
        cleanliness: "dirty",
        statusEntryCount: 2,
        plainLanguageReason: "dirty live branch",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
      rescueRef: {
        branchName: "paperclip/rescue/PAP-123/20260709T120000Z",
        commitSha: "3333333",
        fileCount: 2,
        sourceAuditCommentId: "comment-0",
        claimantAuditCommentId: null,
      },
      restoredSourceIssue: {
        id: "issue-1",
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: "agent-1",
      },
      sourceIssueStatusChanged: true,
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "quarantine_restore" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).toHaveBeenCalledWith("workspace-1", {
      mode: "quarantine_restore",
      reason: null,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "execution_workspace.branch_reconciled",
      entityType: "execution_workspace",
      entityId: "workspace-1",
      details: expect.objectContaining({
        mode: "quarantine_restore",
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        recoveryActionId: "recovery-1",
        rescueRef: expect.objectContaining({
          branchName: "paperclip/rescue/PAP-123/20260709T120000Z",
          commitSha: "3333333",
        }),
        sourceIssueStatus: "todo",
      }),
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      source: "automation",
      reason: "issue_recovery_action_restored",
      payload: expect.objectContaining({
        issueId: "issue-1",
        recoveryActionId: "recovery-1",
        executionWorkspaceId: "workspace-1",
        rescueRef: "paperclip/rescue/PAP-123/20260709T120000Z",
        mutation: "execution_workspace_quarantine_restore",
      }),
      contextSnapshot: expect.objectContaining({
        issueId: "issue-1",
        taskId: "issue-1",
        wakeReason: "issue_recovery_action_restored",
        source: "execution_workspace.quarantine_restore",
        recoveryActionId: "recovery-1",
        executionWorkspaceId: "workspace-1",
        rescueRef: "paperclip/rescue/PAP-123/20260709T120000Z",
      }),
    }));
  });

  it("wakes a restored in_review agent participant after quarantine_restore", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/recorded",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/live",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "diverged",
        cleanliness: "dirty",
        statusEntryCount: 2,
        plainLanguageReason: "dirty live branch",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
      rescueRef: null,
      restoredSourceIssue: {
        id: "issue-1",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: "reviewer-agent-1",
      },
      sourceIssueStatusChanged: true,
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "quarantine_restore" });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({
        sourceIssueStatus: "in_review",
      }),
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("reviewer-agent-1", expect.objectContaining({
      reason: "issue_recovery_action_restored",
      payload: expect.objectContaining({
        issueId: "issue-1",
        mutation: "execution_workspace_quarantine_restore",
      }),
      contextSnapshot: expect.objectContaining({
        issueId: "issue-1",
        wakeReason: "issue_recovery_action_restored",
        source: "execution_workspace.quarantine_restore",
      }),
    }));
  });

  it("returns 409 and skips destructive cleanup when the archive hits a reopen-pending workspace", async () => {
    // A reopen published the workspace active while its source issue is still
    // terminal. The archive control must return 409 before any lease teardown,
    // runtime-service stop, or artifact cleanup, so it never removes the rebuilt
    // worktree.
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "active",
      mode: "isolated_workspace",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "reopen_pending",
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(409);
    expect(mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock).toHaveBeenCalledTimes(1);
    // The destruction fence never runs, so no worktree is removed.
    expect(mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction).not.toHaveBeenCalled();
  });

  it("requires explicit acknowledgement before closing with unavailable Git readiness", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "active",
      mode: "isolated_workspace",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "blocked",
      blockingReasons: ["Git readiness is unavailable"],
      requiresGitUnavailableAcknowledgement: true,
      gitInspection: { state: "unavailable", message: "scan timed out" },
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(409);
    expect(mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock).not.toHaveBeenCalled();
  });

  it("bounds archive close-readiness demand before starting Git inspection", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "active",
      mode: "isolated_workspace",
    });
    mockCloseReadinessDemandLimiter.acquire.mockImplementation(() => {
      throw new HttpError(503, "Workspace close readiness is temporarily at capacity", {
        code: "close_readiness_saturated",
        retryable: false,
      });
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(mockExecutionWorkspaceService.getById).toHaveBeenCalledWith(
      "workspace-1",
      { inspectGit: false },
    );
    expect(mockExecutionWorkspaceService.getCloseReadiness).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock).not.toHaveBeenCalled();
  });

  it("permits acknowledged unavailable Git only when it is the sole blocker", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "active",
      mode: "isolated_workspace",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "blocked",
      blockingReasons: ["Git readiness is unavailable"],
      requiresGitUnavailableAcknowledgement: true,
      gitInspection: { state: "unavailable", message: "scan timed out" },
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "reopen_pending",
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived", acknowledgeGitUnavailable: true });

    expect(res.status).toBe(409);
    expect(mockExecutionWorkspaceService.getCloseReadiness).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        fairnessKeys: ["actor:user:local-board"],
        cacheTtlMs: 0,
      }),
    );
    expect(mockCloseReadinessDemandLimiter.acquire).toHaveBeenCalledWith({
      workspaceKey: "workspace-1",
      tenantKey: "company:company-1",
    });
    expect(mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock).toHaveBeenCalledTimes(1);
  });

  it("destroys the reusable sandbox leases inside the destruction fence when the archive wins", async () => {
    // The archive wins the lifecycle race. The fence runs the destroy callback,
    // so the reusable sandbox lease teardown runs with the worktree teardown.
    const archivedWorkspace = {
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "archived",
      mode: "isolated_workspace",
      projectWorkspaceId: null,
      projectId: null,
      cwd: "/tmp/worktree",
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      ...archivedWorkspace,
      status: "active",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "archived",
      workspace: archivedWorkspace,
      capturedGeneration: 3,
    });
    mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction.mockImplementation(
      async ({ destroy }: { destroy: () => Promise<unknown> }) => ({
        skippedReopened: false,
        result: await destroy(),
      }),
    );

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    // The lease teardown runs inside the fence, so it uses the closed-workspace
    // failure reason and targets the archived row.
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        executionWorkspaceId: "workspace-1",
        failureReason: "execution_workspace_closed",
      }),
    );
  });

  it("keeps the reusable sandbox leases when a reopen makes the fence skip the archive teardown", async () => {
    // A reopen raised the lifecycle generation after the archive captured its
    // own generation. The fence skips the destroy callback and keeps the
    // reopened row, so the lease teardown must not run. Before the fix the lease
    // teardown ran before the fence, so an overlapping reopen lost its leases.
    const archivedWorkspace = {
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "archived",
      mode: "isolated_workspace",
      projectWorkspaceId: null,
      projectId: null,
      cwd: "/tmp/worktree",
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      ...archivedWorkspace,
      status: "active",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "archived",
      workspace: archivedWorkspace,
      capturedGeneration: 3,
    });
    // The fence detects the reopen and never runs the destroy callback.
    mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction.mockResolvedValue({
      skippedReopened: true,
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction).toHaveBeenCalledTimes(1);
    // The reopen keeps its reusable leases because the fence skipped the destroy.
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).not.toHaveBeenCalled();
  });
});
