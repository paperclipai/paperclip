import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  listIssueDocumentRevisions: vi.fn(),
  restoreIssueDocumentRevision: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function createServiceIndexMock() {
  return {
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentService: () => mockDocumentsService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
    }),
    instanceSettingsService: () => ({
      getExperimental: vi.fn(async () => ({})),
      getGeneral: vi.fn(async () => ({ feedbackDataSharingPreference: "prompt" })),
    }),
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  };
}

function unmockRouteModules() {
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
  vi.doUnmock("../services/routines.js");
  vi.doUnmock("../services/routines.ts");
  vi.doUnmock("../routes/issues.js");
  vi.doUnmock("../routes/issues.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../middleware/validate.ts");
}

function registerModuleMocks() {
  vi.doMock("../services/index.js", createServiceIndexMock);
  vi.doMock("../services/index.ts", createServiceIndexMock);
}

async function createApp() {
  vi.resetModules();
  unmockRouteModules();
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/validate.ts", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  registerModuleMocks();
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.ts"),
    import("../middleware/index.ts"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue document revision routes", () => {
  beforeEach(() => {
    vi.resetModules();
    unmockRouteModules();
    registerModuleMocks();
    vi.resetAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "PAP-881",
      title: "Document revisions",
      status: "in_progress",
    });
    mockDocumentsService.listIssueDocumentRevisions.mockResolvedValue([
      {
        id: "revision-2",
        companyId,
        documentId: "document-1",
        issueId,
        key: "plan",
        revisionNumber: 2,
        title: "Plan v2",
        format: "markdown",
        body: "# Two",
        changeSummary: null,
        createdByAgentId: null,
        createdByUserId: "board-user",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);
    mockDocumentsService.restoreIssueDocumentRevision.mockResolvedValue({
      restoredFromRevisionId: "revision-1",
      restoredFromRevisionNumber: 1,
      document: {
        id: "document-1",
        companyId,
        issueId,
        key: "plan",
        title: "Plan v1",
        format: "markdown",
        body: "# One",
        latestRevisionId: "revision-3",
        latestRevisionNumber: 3,
        createdByAgentId: null,
        createdByUserId: "board-user",
        updatedByAgentId: null,
        updatedByUserId: "board-user",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:10:00.000Z"),
      },
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.resetModules();
    unmockRouteModules();
    vi.resetAllMocks();
  });

  it("returns revision snapshots including title and format", async () => {
    const res = await request(await createApp()).get(`/api/issues/${issueId}/documents/plan/revisions`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        revisionNumber: 2,
        title: "Plan v2",
        format: "markdown",
        body: "# Two",
      }),
    ]);
  });

  it("restores a revision through the append-only route and logs the action", async () => {
    const res = await request(await createApp())
      .post(`/api/issues/${issueId}/documents/plan/revisions/revision-1/restore`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockDocumentsService.restoreIssueDocumentRevision).toHaveBeenCalledWith({
      issueId,
      key: "plan",
      revisionId: "revision-1",
      createdByAgentId: null,
      createdByUserId: "board-user",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.document_restored",
        details: expect.objectContaining({
          key: "plan",
          restoredFromRevisionId: "revision-1",
          restoredFromRevisionNumber: 1,
          revisionNumber: 3,
        }),
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      key: "plan",
      title: "Plan v1",
      latestRevisionNumber: 3,
    }));
  });

  it("rejects invalid document keys before attempting restore", async () => {
    const res = await request(await createApp())
      .post(`/api/issues/${issueId}/documents/INVALID KEY/revisions/revision-1/restore`)
      .send({});

    expect(res.status).toBe(400);
    expect(mockDocumentsService.restoreIssueDocumentRevision).not.toHaveBeenCalled();
  });
});
