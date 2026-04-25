import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  listIssueDocuments: vi.fn(),
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
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  getExperimental: vi.fn(async () => ({})),
  getGeneral: vi.fn(async () => ({ feedbackDataSharingPreference: "prompt" })),
  listCompanyIds: vi.fn(async () => [companyId]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

const planDocument = {
  id: "document-1",
  companyId,
  issueId,
  key: "plan",
  title: "Plan",
  format: "markdown",
  body: "# Plan",
  latestRevisionId: "revision-2",
  latestRevisionNumber: 2,
  createdByAgentId: null,
  createdByUserId: "board-user",
  updatedByAgentId: null,
  updatedByUserId: "board-user",
  createdAt: new Date("2026-03-26T12:00:00.000Z"),
  updatedAt: new Date("2026-03-26T12:10:00.000Z"),
};

const systemDocument = {
  ...planDocument,
  id: "document-2",
  key: "system-plan",
  title: "System plan",
};

function registerModuleMocks() {
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/documents.js", () => ({
    documentService: () => mockDocumentsService,
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

  vi.doMock("../services/routines.js", () => ({
    routineService: () => mockRoutineService,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentService: () => mockDocumentsService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => mockRoutineService,
    workProductService: () => ({}),
  }));
}

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
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
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "PAP-881",
      title: "Document revisions",
      status: "in_progress",
    });
    mockDocumentsService.listIssueDocuments.mockImplementation(
      async (_issueId, options: { includeSystem?: boolean } | undefined) =>
        options?.includeSystem ? [planDocument, systemDocument] : [planDocument],
    );
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
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({});
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ feedbackDataSharingPreference: "prompt" });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([companyId]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
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

  it("filters system documents by default on the document list route", async () => {
    const res = await request(await createApp()).get(`/api/issues/${issueId}/documents`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ key: "plan" })]);
  });

  it("passes includeSystem=true through for debug document listing", async () => {
    const res = await request(await createApp()).get(
      `/api/issues/${issueId}/documents?includeSystem=true`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ key: "plan" }),
      expect.objectContaining({ key: "system-plan" }),
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
