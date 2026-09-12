import express from "express";
import request from "supertest";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  buildRunOutputSilence: vi.fn(),
  decorateActiveRunStatus: vi.fn(),
  getRunIssueSummary: vi.fn(),
  getActiveRunIssueSummaryForAgent: vi.fn(),
  getRunLogAccess: vi.fn(),
  readLog: vi.fn(),
  wakeup: vi.fn(),
  getRun: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockExecutionProjection = vi.hoisted(() => ({
  executionProjectionForRun: vi.fn(async () => null),
  executionProjectionsForRuns: vi.fn(async () => new Map()),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));

const mockRunSecretRedactionRegistry = vi.hoisted(() => ({
  redactForRuns: vi.fn(async (_companyId: string, values: unknown[]) => values),
  redactForRun: vi.fn(
    async (_companyId: string, _runId: string, value: unknown) => value,
  ),
}));

const mockProviderTraceStore = vi.hoisted(() => ({
  inspect: vi.fn(),
  getByRun: vi.fn(),
  readExactEntries: vi.fn(),
  revealFrame: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  listMetadataForRuns: vi.fn(),
}));
const mockWorkspaceDiffReprojection = vi.hoisted(() => ({
  project: vi.fn(),
  persist: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockQueueRuntimeRequestResolution = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({
  getById: vi.fn(),
  listForRun: vi.fn(),
  readLog: vi.fn(),
}));

const routeAgentId = "11111111-1111-4111-8111-111111111111";
const failedChatRunId = "22222222-2222-4222-8222-222222222222";
const failedChatIssueId = "33333333-3333-4333-8333-333333333333";
const retryActionId = "44444444-4444-4444-8444-444444444444";
const mockChatRunRetries = vi.hoisted(() => ({
  prepareFailedChatRunRetry: vi.fn(),
  processFailedChatRunRetry: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/execution-projection.js", () => mockExecutionProjection);
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual("../routes/authz.js"),
  );

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/run-secret-redaction.js", () => ({
    createRunSecretRedactionRegistry: () => mockRunSecretRedactionRegistry,
  }));

  vi.doMock("../services/provider-trace-store.js", () => ({
    providerTraceStore: () => mockProviderTraceStore,
  }));

  vi.doMock("../services/provider-trace-workspace-diff-reprojection.js", () => ({
    projectCodexWorkspaceDiffsFromTrace: mockWorkspaceDiffReprojection.project,
    persistReprojectedWorkspaceDiffs: mockWorkspaceDiffReprojection.persist,
  }));

  vi.doMock("../realtime/runner-prp-ws.js", async () => {
    const actual = await vi.importActual<typeof import("../realtime/runner-prp-ws.js")>(
      "../realtime/runner-prp-ws.js",
    );
    return {
      ...actual,
      queueRunnerPrpRuntimeRequestResolution: mockQueueRuntimeRequestResolution,
    };
  });

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

async function createApp(
  db: Record<string, unknown> = {},
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
  options: { chatRunRetries?: typeof mockChatRunRetries } = {},
) {
  // Vitest tracks factory-mock resolution in one shared call stack. Importing
  // these graphs concurrently can drop the services/index factory mock and
  // accidentally run real DB-backed activity logging against this test stub.
  const { agentRoutes } = await vi.importActual<
    typeof import("../routes/agents.js")
  >("../routes/agents.js");
  const { errorHandler } = await vi.importActual<
    typeof import("../middleware/index.js")
  >("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db as any, options));
  app.use(errorHandler);
  return app;
}

function createLiveRunsDbStub(rows: Array<Record<string, unknown>>) {
  const limit = vi.fn(async (value: number) => rows.slice(0, value));
  const orderedQuery = {
    limit,
    then: (resolve: (value: Array<Record<string, unknown>>) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  const query = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnValue(orderedQuery),
  };

  return {
    db: {
      select: vi.fn().mockReturnValue(query),
    },
    limit,
  };
}

function createRuntimeRequestDbStub(row: Record<string, unknown>) {
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => [row]),
  };
  return { select: vi.fn(() => query) };
}

function createFailedChatRetryDb(chatBound = true) {
  const predicates: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const order: string[] = [];
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn((condition: SQL) => {
      predicates.push(new PgDialect().sqlToQuery(condition));
      return query;
    }),
    limit: vi.fn(async () => (chatBound ? [{ id: "chat-conversation" }] : [])),
  };
  const tx = { transactionMarker: "exact-retry-transaction" };
  const db = {
    select: vi.fn(() => query),
    transaction: vi.fn(
      async (callback: (value: typeof tx) => Promise<unknown>) => {
        order.push("begin");
        try {
          const result = await callback(tx);
          order.push("commit");
          return result;
        } catch (error) {
          order.push("rollback");
          throw error;
        }
      },
    ),
  };
  return { db, tx, order, predicates };
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } =
    await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe("agent live run routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockChatRunRetries.prepareFailedChatRunRetry.mockReset();
    mockChatRunRetries.processFailedChatRunRetry.mockReset();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionRunId: "run-1",
      assigneeAgentId: "agent-1",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Builder",
      adapterType: "codex_local",
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({});
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockHeartbeatService.buildRunOutputSilence.mockResolvedValue(null);
    mockHeartbeatService.decorateActiveRunStatus.mockImplementation((run) => ({
      ...run,
      currentStatusMessage: null,
      currentStatusUpdatedAt: null,
    }));
    mockHeartbeatService.getRunIssueSummary.mockResolvedValue({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      contextCommentId: "comment-1",
      contextWakeCommentId: "comment-1",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:29:59.000Z"),
      agentId: "agent-1",
      issueId: "issue-1",
    });
    mockHeartbeatService.getActiveRunIssueSummaryForAgent.mockResolvedValue(
      null,
    );
    mockHeartbeatService.buildRunOutputSilence.mockResolvedValue(null);
    mockHeartbeatService.getRunLogAccess.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      logStore: "local_file",
      logRef: "logs/run-1.ndjson",
    });
    mockHeartbeatService.readLog.mockResolvedValue({
      runId: "run-1",
      store: "local_file",
      logRef: "logs/run-1.ndjson",
      content: "chunk",
      nextOffset: 5,
    });
    mockHeartbeatService.wakeup.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "queued",
      invocationSource: "on_demand",
      triggerDetail: "manual",
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "succeeded",
    });
    mockWorkspaceOperationService.getById.mockResolvedValue({
      id: "operation-1",
      companyId: "company-1",
      runId: "run-1",
    });
    mockQueueRuntimeRequestResolution.mockReturnValue({
      commandId: "command-resolution-1",
    });
    mockProviderTraceStore.inspect.mockResolvedValue({
      trace: null,
      entries: [],
    });
    mockProviderTraceStore.getByRun.mockResolvedValue(null);
    mockProviderTraceStore.readExactEntries.mockResolvedValue([]);
    mockWorkspaceDiffReprojection.project.mockReturnValue({ turns: [], skipReasons: [] });
    mockWorkspaceDiffReprojection.persist.mockResolvedValue({
      created: 0,
      skipped: 0,
      skipReasons: [],
    });
  });

  it("returns a compact active run payload for issue polling", async () => {
    const res = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl).get("/api/issues/pc1a2-1295/active-run"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PC1A2-1295");
    expect(mockHeartbeatService.getRunIssueSummary).toHaveBeenCalledWith(
      "run-1",
    );
    expect(res.body).toMatchObject({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      contextCommentId: "comment-1",
      contextWakeCommentId: "comment-1",
      startedAt: "2026-04-10T09:30:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-10T09:29:59.000Z",
      agentId: "agent-1",
      issueId: "issue-1",
      agentName: "Builder",
      adapterType: "codex_local",
      outputSilence: null,
      currentStatusMessage: null,
      currentStatusUpdatedAt: null,
    });
    expect(res.body).not.toHaveProperty("resultJson");
    expect(res.body).not.toHaveProperty("contextSnapshot");
    expect(res.body).not.toHaveProperty("logRef");
  }, 10_000);

  it("ignores a stale execution run from another issue and falls back to the assignee's matching run", async () => {
    mockHeartbeatService.getRunIssueSummary.mockResolvedValue({
      id: "run-foreign",
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "callback",
      startedAt: new Date("2026-04-10T10:00:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:59:00.000Z"),
      agentId: "agent-1",
      issueId: "issue-2",
    });
    mockHeartbeatService.getActiveRunIssueSummaryForAgent.mockResolvedValue({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:29:59.000Z"),
      agentId: "agent-1",
      issueId: "issue-1",
    });

    const res = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl).get("/api/issues/PC1A2-1295/active-run"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.getRunIssueSummary).toHaveBeenCalledWith(
      "run-1",
    );
    expect(
      mockHeartbeatService.getActiveRunIssueSummaryForAgent,
    ).toHaveBeenCalledWith("agent-1");
    expect(res.body).toMatchObject({
      id: "run-1",
      issueId: "issue-1",
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
    });
  });

  it("includes ephemeral current status fields on active run polling", async () => {
    mockHeartbeatService.decorateActiveRunStatus.mockImplementation((run) => ({
      ...run,
      currentStatusMessage: "Syncing workspace to environment",
      currentStatusUpdatedAt: new Date("2026-04-10T09:30:05.000Z"),
      currentToolName: "bash",
      lastAssistantSnippet: "Inspecting files",
      lastEventAt: new Date("2026-04-10T09:30:06.000Z"),
    }));

    const res = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl).get("/api/issues/PC1A2-1295/active-run"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.decorateActiveRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", issueId: "issue-1" }),
      { companyId: "company-1", issueId: "issue-1" },
    );
    expect(mockExecutionProjection.executionProjectionForRun).toHaveBeenCalledWith(
      expect.anything(), "company-1", "run-1",
    );
    expect(res.body).toMatchObject({
      execution: null,
      currentStatusMessage: "Syncing workspace to environment",
      currentStatusUpdatedAt: "2026-04-10T09:30:05.000Z",
      currentToolName: "bash",
      lastAssistantSnippet: "Inspecting files",
      lastEventAt: "2026-04-10T09:30:06.000Z",
    });
  });

  it("uses narrow run log metadata lookups for log polling", async () => {
    const res = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl).get(
        "/api/heartbeat-runs/run-1/log?offset=12&limitBytes=64",
      ),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.getRunLogAccess).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.readLog).toHaveBeenCalledWith(
      {
        id: "run-1",
        companyId: "company-1",
        logStore: "local_file",
        logRef: "logs/run-1.ndjson",
      },
      {
        offset: 12,
        limitBytes: 64,
      },
    );
    expect(res.body).toEqual({
      runId: "run-1",
      store: "local_file",
      logRef: "logs/run-1.ndjson",
      content: "chunk",
      nextOffset: 5,
    });
  });

  it.each(["skill_test", "task_bridge"])(
    "denies %s keys from company-wide run and workspace logs",
    async (kind) => {
      mockAccessService.decide.mockImplementation(async (input: { action?: string }) => ({
        allowed: input.action !== "company_scope:read",
        action: input.action,
        reason: input.action === "company_scope:read" ? "deny_key_scope" : "allow_explicit_grant",
        explanation: input.action === "company_scope:read"
          ? "Restricted keys cannot read company-wide run telemetry."
          : "Allowed by test grant.",
      }));
      const actor = {
        type: "agent",
        agentId: routeAgentId,
        companyId: "company-1",
        source: "agent_key",
        keyScope: kind === "skill_test"
          ? { kind, issueId: "issue-1" }
          : { kind, parentIssueId: "issue-1" },
      };
      const app = await createApp({}, actor);
      const paths = [
        "/api/companies/company-1/heartbeat-runs",
        "/api/companies/company-1/live-runs",
        "/api/heartbeat-runs/run-1",
        "/api/heartbeat-runs/run-1/events",
        "/api/heartbeat-runs/run-1/log",
        "/api/heartbeat-runs/run-1/workspace-operations",
        "/api/workspace-operations/operation-1/log",
      ];

      for (const path of paths) {
        const res = await requestApp(app, (baseUrl) => request(baseUrl).get(path));
        expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(403);
        expect(res.body.error).toContain("Run telemetry");
      }

      expect(mockHeartbeatService.readLog).not.toHaveBeenCalled();
      expect(mockWorkspaceOperationService.readLog).not.toHaveBeenCalled();
      expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
        action: "company_scope:read",
        resource: { type: "company", companyId: "company-1" },
      }));
    },
  );

  it("caps company live run polling by default", async () => {
    const rows = Array.from({ length: 75 }, (_, index) => ({
      id: `run-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(
        `2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
      ),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));
    const { db, limit } = createLiveRunsDbStub(rows);

    const res = await requestApp(await createApp(db), (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/live-runs"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(limit).toHaveBeenCalledWith(50);
    expect(res.body).toHaveLength(50);
    expect(mockRunSecretRedactionRegistry.redactForRuns).toHaveBeenCalledTimes(1);
    expect(mockRunSecretRedactionRegistry.redactForRun).not.toHaveBeenCalled();
    expect(mockHeartbeatService.buildRunOutputSilence).toHaveBeenCalledTimes(
      50,
    );
  });

  it("treats explicit zero or invalid live run limit as the capped default", async () => {
    const rows = Array.from({ length: 75 }, (_, index) => ({
      id: `run-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(
        `2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
      ),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));
    const { db, limit } = createLiveRunsDbStub(rows);

    const res = await requestApp(await createApp(db), (baseUrl) =>
      request(baseUrl).get(
        "/api/companies/company-1/live-runs?limit=0&minCount=0",
      ),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(limit).toHaveBeenCalledWith(50);
    expect(res.body).toHaveLength(50);
    expect(mockRunSecretRedactionRegistry.redactForRuns).toHaveBeenCalledTimes(1);
    expect(mockRunSecretRedactionRegistry.redactForRun).not.toHaveBeenCalled();
  });

  it("does not pad with recent runs when no minCount is requested", async () => {
    const liveRows = Array.from({ length: 8 }, (_, index) => ({
      id: `run-live-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(
        `2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
      ),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));

    const selectCalls: Array<ReturnType<typeof vi.fn>> = [];
    const db = {
      select: vi.fn().mockImplementation(() => {
        const limitFn = vi.fn(async (value: number) =>
          liveRows.slice(0, value),
        );
        const orderedQuery = {
          limit: limitFn,
          then: (resolve: (value: typeof liveRows) => unknown) =>
            Promise.resolve(liveRows).then(resolve),
        };
        const query = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnValue(orderedQuery),
        };
        selectCalls.push(limitFn);
        return query;
      }),
    };

    const res = await requestApp(await createApp(db), (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/live-runs"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(8);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("pads with recent runs when minCount is explicitly requested", async () => {
    const liveRows = Array.from({ length: 2 }, (_, index) => ({
      id: `run-live-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(
        `2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
      ),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));
    const recentRows = Array.from({ length: 4 }, (_, index) => ({
      id: `run-recent-${index}`,
      companyId: "company-1",
      status: "succeeded",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-09T09:30:00.000Z"),
      finishedAt: new Date("2026-04-09T09:35:00.000Z"),
      createdAt: new Date(
        `2026-04-09T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
      ),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));

    let selectCallCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount += 1;
        const rows = selectCallCount === 1 ? liveRows : recentRows;
        const limitFn = vi.fn(async (value: number) => rows.slice(0, value));
        const orderedQuery = {
          limit: limitFn,
          then: (resolve: (value: typeof rows) => unknown) =>
            Promise.resolve(rows).then(resolve),
        };
        return {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnValue(orderedQuery),
        };
      }),
    };

    const res = await requestApp(await createApp(db), (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/live-runs?minCount=4"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("passes scoped wake fields through the legacy heartbeat invoke route", async () => {
    const res = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl)
        .post(
          `/api/agents/${routeAgentId}/heartbeat/invoke?companyId=company-1`,
        )
        .send({
          reason: "issue_assigned",
          payload: {
            issueId: "issue-1",
            taskId: "issue-1",
            taskKey: "issue-1",
          },
          forceFreshSession: true,
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    // Optional wake fields retain their existing shape; execution identity
    // always comes from the authenticated caller.
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(routeAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_assigned",
      payload: {
        issueId: "issue-1",
        taskId: "issue-1",
        taskKey: "issue-1",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: {
        triggeredBy: "board",
        actorId: "local-board",
        responsibleUserId: "local-board",
        originIdentityContextId: null,
        forceFreshSession: true,
      },
    });
  });

  it("calls heartbeat.wakeup with the legacy minimal shape when the body is empty", async () => {
    const res = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl)
        .post(
          `/api/agents/${routeAgentId}/heartbeat/invoke?companyId=company-1`,
        )
        .send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(routeAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: {
        triggeredBy: "board",
        actorId: "local-board",
        responsibleUserId: "local-board",
        originIdentityContextId: null,
      },
    });
  });

  describe("exact failed chat run retry", () => {
    const retryBody = {
      failedRunId: failedChatRunId,
      reason: "retry_failed_run",
    };
    const selectedRun = {
      id: failedChatRunId,
      companyId: "company-1",
      agentId: routeAgentId,
      status: "failed",
      contextSnapshot: {
        issueId: failedChatIssueId,
        taskId: failedChatIssueId,
        taskKey: "PAP-FAILED-CHAT",
        source: "chat:slack",
        wakeCommentId: "original-comment",
      },
    };

    beforeEach(() => {
      mockAgentService.getById.mockResolvedValue({
        id: routeAgentId,
        companyId: "company-1",
      });
      mockHeartbeatService.getRun.mockResolvedValue(selectedRun);
      mockChatRunRetries.prepareFailedChatRunRetry.mockResolvedValue({
        actionId: retryActionId,
        issueId: failedChatIssueId,
      });
      mockChatRunRetries.processFailedChatRunRetry.mockResolvedValue({
        actionId: retryActionId,
        issueId: failedChatIssueId,
        runId: null,
        status: "deferred",
      });
    });

    it.each([
      ["failed", "deferred", null],
      ["timed_out", "running", "55555555-5555-4555-8555-555555555555"],
    ])(
      "stages the exact %s run before dispatch and returns its %s receipt",
      async (runStatus, status, runId) => {
        const fixture = createFailedChatRetryDb();
        mockHeartbeatService.getRun.mockResolvedValue({
          ...selectedRun,
          status: runStatus,
        });
        mockChatRunRetries.prepareFailedChatRunRetry.mockImplementation(
          async () => {
            fixture.order.push("stage");
            return { actionId: retryActionId, issueId: failedChatIssueId };
          },
        );
        const receipt = {
          actionId: retryActionId,
          issueId: failedChatIssueId,
          runId,
          status,
        };
        mockChatRunRetries.processFailedChatRunRetry.mockImplementation(
          async () => {
            fixture.order.push("dispatch");
            return receipt;
          },
        );
        const res = await requestApp(
          await createApp(fixture.db, undefined, {
            chatRunRetries: mockChatRunRetries,
          }),
          (url) =>
            request(url)
              .post(`/api/agents/${routeAgentId}/wakeup`)
              .send({
                ...retryBody,
                payload: {
                  issueId: "forged-issue",
                  taskKey: "forged-task",
                  wakeCommentIds: ["forged-comment"],
                  retryOfRunId: "forged-run",
                },
                idempotencyKey: "untrusted-idempotency-key",
              }),
        );

        expect(res.status, JSON.stringify(res.body)).toBe(202);
        expect(res.body).toEqual(receipt);
        expect(mockHeartbeatService.getRun).toHaveBeenCalledWith(
          failedChatRunId,
        );
        expect(
          mockChatRunRetries.prepareFailedChatRunRetry,
        ).toHaveBeenCalledExactlyOnceWith(fixture.tx, {
          companyId: "company-1",
          issueId: failedChatIssueId,
          agentId: routeAgentId,
          failedRunId: failedChatRunId,
          initiatedByUserId: "local-board",
        });
        expect(
          mockChatRunRetries.processFailedChatRunRetry,
        ).toHaveBeenCalledExactlyOnceWith(retryActionId);
        expect(fixture.order).toEqual(["begin", "stage", "commit", "dispatch"]);
        expect(fixture.predicates).toEqual([
          {
            sql: '("chat_conversations"."company_id" = $1 and "chat_conversations"."issue_id" = $2)',
            params: ["company-1", failedChatIssueId],
            typings: ["uuid", "uuid"],
          },
        ]);
        expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
      },
    );

    it.each([
      { reason: "issue_assigned" },
      { source: "automation" },
      { triggerDetail: "system" },
      { forceFreshSession: true },
      { debug: { providerTrace: "raw" } },
    ])(
      "rejects execution-context overrides before staging: %j",
      async (override) => {
        const fixture = createFailedChatRetryDb();
        const res = await requestApp(
          await createApp(fixture.db, undefined, {
            chatRunRetries: mockChatRunRetries,
          }),
          (url) =>
            request(url)
              .post(`/api/agents/${routeAgentId}/wakeup`)
              .send({ ...retryBody, ...override }),
        );
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(
          mockChatRunRetries.prepareFailedChatRunRetry,
        ).not.toHaveBeenCalled();
        expect(
          mockChatRunRetries.processFailedChatRunRetry,
        ).not.toHaveBeenCalled();
        expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
      },
    );

    it.each([
      null,
      { ...selectedRun, companyId: "other-company" },
      { ...selectedRun, agentId: "other-agent" },
    ])(
      "does not retry a missing or wrong-scope selected run: %j",
      async (run) => {
        mockHeartbeatService.getRun.mockResolvedValue(run);
        const fixture = createFailedChatRetryDb();
        const res = await requestApp(
          await createApp(fixture.db, undefined, {
            chatRunRetries: mockChatRunRetries,
          }),
          (url) =>
            request(url)
              .post(`/api/agents/${routeAgentId}/wakeup`)
              .send(retryBody),
        );
        expect(res.status, JSON.stringify(res.body)).toBe(404);
        expect(fixture.db.select).not.toHaveBeenCalled();
        expect(
          mockChatRunRetries.prepareFailedChatRunRetry,
        ).not.toHaveBeenCalled();
        expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
      },
    );

    it.each(["running", "queued", "succeeded", "cancelled"])(
      "rejects selected %s runs",
      async (status) => {
        mockHeartbeatService.getRun.mockResolvedValue({
          ...selectedRun,
          status,
        });
        const fixture = createFailedChatRetryDb();
        const res = await requestApp(
          await createApp(fixture.db, undefined, {
            chatRunRetries: mockChatRunRetries,
          }),
          (url) =>
            request(url)
              .post(`/api/agents/${routeAgentId}/wakeup`)
              .send(retryBody),
        );
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(
          mockChatRunRetries.prepareFailedChatRunRetry,
        ).not.toHaveBeenCalled();
        expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
      },
    );

    it.each(["agent", "company", "permission"])(
      "denies %s authority before retry selection",
      async (denial) => {
        const fixture = createFailedChatRetryDb();
        const actor =
          denial === "agent"
            ? {
                type: "agent",
                agentId: routeAgentId,
                companyId: "company-1",
                source: "agent_key",
              }
            : {
                type: "board",
                userId: "member",
                companyIds: denial === "company" ? [] : ["company-1"],
                source: "session",
              };
        if (denial === "permission")
          mockAccessService.decide.mockResolvedValue({
            allowed: false,
            explanation: "Invocation denied",
          });
        const res = await requestApp(
          await createApp(fixture.db, actor, {
            chatRunRetries: mockChatRunRetries,
          }),
          (url) =>
            request(url)
              .post(`/api/agents/${routeAgentId}/wakeup`)
              .send(retryBody),
        );
        expect([403, 404]).toContain(res.status);
        expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
        expect(
          mockChatRunRetries.prepareFailedChatRunRetry,
        ).not.toHaveBeenCalled();
        expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
      },
    );

    it("keeps an unconfigured chat retry fail-closed", async () => {
      const fixture = createFailedChatRetryDb();
      const res = await requestApp(await createApp(fixture.db), (url) =>
        request(url).post(`/api/agents/${routeAgentId}/wakeup`).send(retryBody),
      );
      expect(res.status).toBe(409);
      expect(res.body.details?.code).toBe(
        "chat_failed_run_retry_requires_authorized_context",
      );
      expect(fixture.db.transaction).not.toHaveBeenCalled();
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });

    it("rolls back staging denial without falling back to a generic wake", async () => {
      const fixture = createFailedChatRetryDb();
      const { HttpError } =
        await vi.importActual<typeof import("../errors.js")>("../errors.js");
      mockChatRunRetries.prepareFailedChatRunRetry.mockRejectedValue(
        new HttpError(409, "The original chat generation is retired", {
          code: "chat_retry_source_denied",
        }),
      );
      const res = await requestApp(
        await createApp(fixture.db, undefined, {
          chatRunRetries: mockChatRunRetries,
        }),
        (url) =>
          request(url)
            .post(`/api/agents/${routeAgentId}/wakeup`)
            .send(retryBody),
      );
      expect(res.status).toBe(409);
      expect(res.body.details?.code).toBe("chat_retry_source_denied");
      expect(fixture.order).toEqual(["begin", "rollback"]);
      expect(
        mockChatRunRetries.processFailedChatRunRetry,
      ).not.toHaveBeenCalled();
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("does not use generic retry when the selected chat run lost its binding", async () => {
      const fixture = createFailedChatRetryDb(false);
      const res = await requestApp(
        await createApp(fixture.db, undefined, {
          chatRunRetries: mockChatRunRetries,
        }),
        (url) =>
          request(url)
            .post(`/api/agents/${routeAgentId}/wakeup`)
            .send(retryBody),
      );
      expect(res.status).toBe(409);
      expect(res.body.details?.code).toBe(
        "chat_failed_run_retry_requires_authorized_context",
      );
      expect(
        mockChatRunRetries.prepareFailedChatRunRetry,
      ).not.toHaveBeenCalled();
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });

    it("returns the committed intent when immediate retry dispatch rejects", async () => {
      const fixture = createFailedChatRetryDb();
      mockChatRunRetries.processFailedChatRunRetry.mockImplementation(
        async () => {
          fixture.order.push("dispatch");
          throw new Error("PRIVATE immediate dispatch failure");
        },
      );
      const res = await requestApp(
        await createApp(fixture.db, undefined, {
          chatRunRetries: mockChatRunRetries,
        }),
        (url) =>
          request(url)
            .post(`/api/agents/${routeAgentId}/wakeup`)
            .send(retryBody),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body).toEqual({
        actionId: retryActionId,
        issueId: failedChatIssueId,
        runId: null,
        status: "queued",
      });
      expect(fixture.order).toEqual(["begin", "commit", "dispatch"]);
      expect(
        mockChatRunRetries.prepareFailedChatRunRetry,
      ).toHaveBeenCalledTimes(1);
      expect(
        mockChatRunRetries.processFailedChatRunRetry,
      ).toHaveBeenCalledExactlyOnceWith(retryActionId);
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
      expect(res.text).not.toContain("PRIVATE");
    });

    it("rejects exact selectors on legacy invoke instead of starting a generic run", async () => {
      const fixture = createFailedChatRetryDb();
      const res = await requestApp(
        await createApp(fixture.db, undefined, {
          chatRunRetries: mockChatRunRetries,
        }),
        (url) =>
          request(url)
            .post(`/api/agents/${routeAgentId}/heartbeat/invoke`)
            .send(retryBody),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(
        mockChatRunRetries.prepareFailedChatRunRetry,
      ).not.toHaveBeenCalled();
      expect(
        mockChatRunRetries.processFailedChatRunRetry,
      ).not.toHaveBeenCalled();
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
      expect(fixture.db.transaction).not.toHaveBeenCalled();
    });

    it("preserves non-chat retry using only the selected run's server task fields", async () => {
      const fixture = createFailedChatRetryDb(false);
      mockHeartbeatService.getRun.mockResolvedValue({
        ...selectedRun,
        contextSnapshot: { ...selectedRun.contextSnapshot, source: "board" },
      });
      const res = await requestApp(
        await createApp(fixture.db, undefined, {
          chatRunRetries: mockChatRunRetries,
        }),
        (url) =>
          request(url)
            .post(`/api/agents/${routeAgentId}/wakeup`)
            .send({
              ...retryBody,
              payload: {
                issueId: "forged",
                taskKey: "forged",
                wakeCommentId: "forged",
              },
            }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledExactlyOnceWith(
        routeAgentId,
        expect.objectContaining({
          reason: "retry_failed_run",
          payload: {
            issueId: failedChatIssueId,
            taskId: failedChatIssueId,
            taskKey: "PAP-FAILED-CHAT",
          },
        }),
      );
      expect(
        mockChatRunRetries.prepareFailedChatRunRetry,
      ).not.toHaveBeenCalled();
    });
  });

  it("allows implicit local administrators to opt one manual run into raw provider tracing", async () => {
    const res = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl)
        .post(
          `/api/agents/${routeAgentId}/heartbeat/invoke?companyId=company-1`,
        )
        .send({ debug: { providerTrace: "raw" } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      routeAgentId,
      expect.objectContaining({
        contextSnapshot: expect.objectContaining({
          debug: { providerTrace: "raw" },
          providerTraceRequestedBy: "local-board",
        }),
      }),
    );
  });

  it("marks traced re-runs as explicit resumes so terminal issue context can execute", async () => {
    const issueId = "22222222-2222-4222-8222-222222222222";
    const res = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl)
        .post(`/api/agents/${routeAgentId}/wakeup?companyId=company-1`)
        .send({
          source: "on_demand",
          triggerDetail: "manual",
          reason: "rerun_with_provider_trace",
          payload: { issueId, taskId: issueId, taskKey: issueId },
          debug: { providerTrace: "raw" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      routeAgentId,
      expect.objectContaining({
        contextSnapshot: expect.objectContaining({
          resumeIntent: true,
          debug: { providerTrace: "raw" },
        }),
      }),
    );
  });

  it("rejects raw provider tracing for ordinary board members", async () => {
    const res = await requestApp(
      await createApp(
        {},
        {
          type: "board",
          userId: "member-user",
          companyIds: ["company-1"],
          source: "session",
          isInstanceAdmin: false,
        },
      ),
      (baseUrl) =>
        request(baseUrl)
          .post(
            `/api/agents/${routeAgentId}/heartbeat/invoke?companyId=company-1`,
          )
          .send({ debug: { providerTrace: "raw" } }),
    );

    expect(res.status).toBe(403);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not let an ordinary member downgrade a persisted approval into a question", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "running",
      runtimeMode: "native",
    });
    const db = createRuntimeRequestDbStub({
      eventType: "runtime_request.created",
      payload: {
        prpEvent: {
          schema: "paperclip.prp.event.v1",
          eventType: "runtime_request.created",
          sourceKind: "runner",
          runId: "run-1",
          turnId: "canonical-turn",
          payload: {
            request: {
              requestId: "approval-1",
              requestKind: "command_approval",
              turnId: "canonical-turn",
              status: "pending",
            },
          },
        },
      },
    });
    const app = await createApp(db, {
      type: "board",
      userId: "ordinary-member",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/heartbeat-runs/run-1/runtime-requests/approval-1/resolve")
      .send({
        requestKind: "runtime",
        turnId: "attacker-turn",
        resolution: { action: "accept" },
      }));

    expect(res.status).toBe(403);
    expect(mockQueueRuntimeRequestResolution).not.toHaveBeenCalled();
  });

  it("queues an admin resolution with canonical request and actor bindings", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "running",
      runtimeMode: "native",
    });
    const db = createRuntimeRequestDbStub({
      eventType: "runtime_request.created",
      payload: {
        prpEvent: {
          schema: "paperclip.prp.event.v1",
          eventType: "runtime_request.created",
          sourceKind: "runner",
          runId: "run-1",
          turnId: "canonical-turn",
          payload: {
            request: {
              requestId: "approval-1",
              requestKind: "permission_approval",
              turnId: "canonical-turn",
              status: "pending",
            },
          },
        },
      },
    });
    const app = await createApp(db, {
      type: "board",
      userId: "instance-admin",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/heartbeat-runs/run-1/runtime-requests/approval-1/resolve")
      .send({
        requestKind: "user_input",
        turnId: "attacker-turn",
        resolution: { action: "accept" },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(mockQueueRuntimeRequestResolution).toHaveBeenCalledWith({
      companyId: "company-1",
      runId: "run-1",
      pendingRequest: {
        companyId: "company-1",
        runId: "run-1",
        requestId: "approval-1",
        requestKind: "permission_approval",
        turnId: "canonical-turn",
        resolverPolicy: "instance_admin",
      },
      actor: {
        type: "user",
        userId: "instance-admin",
        isInstanceAdmin: true,
      },
      resolution: { action: "accept" },
    });
  });

  it.each([
    ["get", "/api/companies/company-1/provider-traces?runIds=run-1"],
    ["get", "/api/heartbeat-runs/run-1/provider-trace"],
    ["post", "/api/heartbeat-runs/run-1/provider-trace/frames/1/reveal"],
    ["get", "/api/heartbeat-runs/run-1/provider-trace/download"],
    ["delete", "/api/heartbeat-runs/run-1/provider-trace"],
  ] as const)(
    "requires instance administration to %s %s",
    async (method, path) => {
      const app = await createApp(
        {},
        {
          type: "board",
          userId: "member-user",
          companyIds: ["company-1"],
          source: "session",
          isInstanceAdmin: false,
        },
      );
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)[method](path),
      );

      expect(res.status).toBe(403);
      expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    },
  );

  it("lists trace status metadata without exposing payload contents", async () => {
    mockProviderTraceStore.listMetadataForRuns.mockResolvedValueOnce([
      {
        schema: "paperclip.provider_trace_metadata.v1",
        id: "trace-1",
        runId: "run-1",
        companyId: "company-1",
        status: "complete",
        provider: "codex",
        frameCount: 70,
        byteCount: 4096,
        digest: `sha256:${"a".repeat(64)}`,
        reason: null,
        requestedBy: "local-board",
        createdAt: new Date("2026-08-22T12:00:00.000Z"),
        expiresAt: new Date("2026-08-23T12:00:00.000Z"),
        deletedAt: null,
      },
    ]);

    const res = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl).get(
        "/api/companies/company-1/provider-traces?runIds=run-1",
      ),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockProviderTraceStore.listMetadataForRuns).toHaveBeenCalledWith(
      "company-1",
      ["run-1"],
    );
    expect(res.body[0]).not.toHaveProperty("rawBase64");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "provider_trace.metadata_listed",
        details: expect.objectContaining({ payloadLogged: false }),
      }),
    );
  });

  it("returns only the redacted inspection view and audits the access", async () => {
    mockProviderTraceStore.inspect.mockResolvedValue({
      trace: { id: "trace-1", status: "complete" },
      entries: [
        {
          kind: "frame",
          frameId: 1,
          parsed: { token: "[withheld]" },
          withheldPaths: ["token"],
        },
      ],
    });
    const res = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl).get("/api/heartbeat-runs/run-1/provider-trace"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.entries[0]).not.toHaveProperty("rawBase64");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "provider_trace.redacted_viewed",
        details: { traceId: "trace-1", rawPayloadRevealed: false },
      }),
    );
  });

  it("lets a board member reproject only retained workspace diffs", async () => {
    mockProviderTraceStore.getByRun.mockResolvedValue({
      id: "trace-1",
      status: "complete",
      deletedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockProviderTraceStore.readExactEntries.mockResolvedValue([
      { kind: "frame", frameId: 1 },
    ]);
    const projection = { turns: [{ turnId: "turn-1" }], skipReasons: [] };
    mockWorkspaceDiffReprojection.project.mockReturnValue(projection);
    mockWorkspaceDiffReprojection.persist.mockResolvedValue({
      created: 1,
      skipped: 0,
      skipReasons: [],
    });

    const res = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl).post(
        "/api/heartbeat-runs/run-1/provider-trace/reproject-workspace-diffs",
      ),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ created: 1, skipped: 0, skipReasons: [] });
    expect(mockWorkspaceDiffReprojection.persist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        traceId: "trace-1",
        runId: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        projection,
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "provider_trace.workspace_diffs_reprojected",
        details: expect.objectContaining({ providerActionsReplayed: 0 }),
      }),
    );
  });

  it.each([
    ["unavailable", null, "trace_unavailable"],
    [
      "expired",
      {
        id: "trace-1",
        status: "complete",
        deletedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      },
      "trace_expired",
    ],
    [
      "incomplete",
      {
        id: "trace-1",
        status: "incomplete",
        deletedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
      "trace_incomplete",
    ],
  ] as const)(
    "does not write when a retained trace is %s",
    async (_label, trace, reason) => {
      mockProviderTraceStore.getByRun.mockResolvedValue(trace);

      const res = await requestApp(await createApp(), (baseUrl) =>
        request(baseUrl).post(
          "/api/heartbeat-runs/run-1/provider-trace/reproject-workspace-diffs",
        ),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({
        created: 0,
        skipped: 1,
        skipReasons: [{ reason }],
      });
      expect(mockProviderTraceStore.readExactEntries).not.toHaveBeenCalled();
      expect(mockWorkspaceDiffReprojection.persist).not.toHaveBeenCalled();
    },
  );

  it("rejects workspace-diff reprojection from an agent actor", async () => {
    const res = await requestApp(
      await createApp(
        {},
        {
          type: "agent",
          agentId: "agent-1",
          companyId: "company-1",
          runId: "run-1",
          source: "agent_key",
        },
      ),
      (baseUrl) =>
        request(baseUrl).post(
          "/api/heartbeat-runs/run-1/provider-trace/reproject-workspace-diffs",
        ),
    );

    expect(res.status).toBe(403);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockWorkspaceDiffReprojection.persist).not.toHaveBeenCalled();
  });
});
