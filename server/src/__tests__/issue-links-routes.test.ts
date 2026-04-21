import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  listLinks: vi.fn(),
  getLinkById: vi.fn(),
  createLink: vi.fn(),
  updateLink: vi.fn(),
  deleteLink: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerModuleMocks() {
  vi.doMock("../routes/issues.js", async () =>
    vi.importActual<typeof import("../routes/issues.ts")>("../routes/issues.ts"),
  );
  vi.doMock("../routes/issues.ts", async () =>
    vi.importActual<typeof import("../routes/issues.ts")>("../routes/issues.ts"),
  );
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
  vi.doMock("../routes/issues-checkout-wakeup.js", async () =>
    vi.importActual<typeof import("../routes/issues-checkout-wakeup.ts")>("../routes/issues-checkout-wakeup.ts"),
  );
  vi.doMock("../routes/issues-checkout-wakeup.ts", async () =>
    vi.importActual<typeof import("../routes/issues-checkout-wakeup.ts")>("../routes/issues-checkout-wakeup.ts"),
  );
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  vi.doMock("../telemetry.ts", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  const servicesIndexMock = () => ({
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({
      getById: vi.fn(async () => null),
    }),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  });
  vi.doMock("../services/index.js", servicesIndexMock);
  vi.doMock("../services/index.ts", servicesIndexMock);
  vi.doMock("../services/issue-assignment-wakeup.js", async () =>
    vi.importActual<typeof import("../services/issue-assignment-wakeup.ts")>(
      "../services/issue-assignment-wakeup.ts",
    ),
  );
  vi.doMock("../services/issue-assignment-wakeup.ts", async () =>
    vi.importActual<typeof import("../services/issue-assignment-wakeup.ts")>(
      "../services/issue-assignment-wakeup.ts",
    ),
  );
  vi.doMock("../services/issue-execution-policy.js", async () =>
    vi.importActual<typeof import("../services/issue-execution-policy.ts")>("../services/issue-execution-policy.ts"),
  );
  vi.doMock("../services/issue-execution-policy.ts", async () =>
    vi.importActual<typeof import("../services/issue-execution-policy.ts")>("../services/issue-execution-policy.ts"),
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
  vi.doMock("../attachment-types.js", async () =>
    vi.importActual<typeof import("../attachment-types.ts")>("../attachment-types.ts"),
  );
  vi.doMock("../attachment-types.ts", async () =>
    vi.importActual<typeof import("../attachment-types.ts")>("../attachment-types.ts"),
  );
}

function resetIssueRouteModules() {
  vi.resetModules();
  vi.doUnmock("@paperclipai/shared/telemetry");
  vi.doUnmock("../telemetry.js");
  vi.doUnmock("../telemetry.ts");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
  vi.doUnmock("../services/issue-assignment-wakeup.js");
  vi.doUnmock("../services/issue-assignment-wakeup.ts");
  vi.doUnmock("../services/issue-execution-policy.js");
  vi.doUnmock("../services/issue-execution-policy.ts");
  vi.doUnmock("../routes/issues.js");
  vi.doUnmock("../routes/issues.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../routes/issues-checkout-wakeup.js");
  vi.doUnmock("../routes/issues-checkout-wakeup.ts");
  vi.doUnmock("../routes/workspace-command-authz.js");
  vi.doUnmock("../routes/workspace-command-authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../middleware/validate.ts");
  vi.doUnmock("../middleware/logger.js");
  vi.doUnmock("../middleware/logger.ts");
  vi.doUnmock("../attachment-types.js");
  vi.doUnmock("../attachment-types.ts");
}

let issueRouteImportSeq = 0;

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  resetIssueRouteModules();
  registerModuleMocks();
  issueRouteImportSeq += 1;
  const routeModulePath = `../routes/issues.ts?issue-links-routes-${issueRouteImportSeq}`;
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/issues.ts")>,
    import("../middleware/index.ts"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    identifier: "PAP-902",
    title: "Link route issue",
    executionWorkspaceId: null,
    ...overrides,
  };
}

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    companyId: "company-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    url: "https://example.com/spec",
    title: "Spec",
    position: 0,
    createdByAgentId: null,
    createdByUserId: "local-board",
    createdByRunId: null,
    createdAt: new Date("2026-04-18T12:00:00.000Z"),
    updatedAt: new Date("2026-04-18T12:00:00.000Z"),
    ...overrides,
  };
}

describe("issue link routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.listLinks.mockResolvedValue([makeLink()]);
    mockIssueService.getLinkById.mockResolvedValue(makeLink());
    mockIssueService.createLink.mockImplementation(async (_issue, data) => makeLink(data));
    mockIssueService.updateLink.mockImplementation(async (_id, data) => makeLink(data));
    mockIssueService.deleteLink.mockResolvedValue(makeLink());
  });

  afterEach(() => {
    resetIssueRouteModules();
    vi.resetAllMocks();
  });

  it("lists links for an accessible issue", async () => {
    const res = await request(await createApp()).get("/api/issues/11111111-1111-4111-8111-111111111111/links");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "22222222-2222-4222-8222-222222222222",
        url: "https://example.com/spec",
      }),
    ]);
  });

  it("creates issue links and logs activity", async () => {
    const res = await request(await createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/links")
      .send({ url: "https://example.com/spec", title: "Spec" });

    expect(res.status).toBe(201);
    expect(mockIssueService.createLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      { url: "https://example.com/spec", title: "Spec" },
      { agentId: null, userId: "local-board", runId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.link_created",
        details: expect.objectContaining({ url: "https://example.com/spec" }),
      }),
    );
  });

  it("creates Apple Notes issue links through the same company-scoped route", async () => {
    const res = await request(await createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/links")
      .send({ url: "applenotes://showNote?identifier=ABCDEF", title: "Apple Note" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.createLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      { url: "applenotes://showNote?identifier=ABCDEF", title: "Apple Note" },
      { agentId: null, userId: "local-board", runId: null },
    );
  });

  it("rejects unsafe issue link URL schemes before mutation", async () => {
    const res = await request(await createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/links")
      .send({ url: "javascript:alert(1)", title: "Bad" });

    expect(res.status).toBe(400);
    expect(mockIssueService.createLink).not.toHaveBeenCalled();
  });

  it("uses checkout ownership for assigned in-progress agent mutations", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      status: "in_progress",
      assigneeAgentId: "agent-1",
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "33333333-3333-4333-8333-333333333333",
      runStatus: "running",
    }))
      .patch("/api/issue-links/22222222-2222-4222-8222-222222222222")
      .send({ title: "Updated spec" });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "agent-1",
      "33333333-3333-4333-8333-333333333333",
    );
    expect(mockIssueService.updateLink).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      { title: "Updated spec" },
    );
  });

  it("deletes links and logs activity", async () => {
    const res = await request(await createApp())
      .delete("/api/issue-links/22222222-2222-4222-8222-222222222222");

    expect(res.status).toBe(200);
    expect(mockIssueService.deleteLink).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.link_deleted",
        details: expect.objectContaining({ title: "Spec" }),
      }),
    );
  });
});
