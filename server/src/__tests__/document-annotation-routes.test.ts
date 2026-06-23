import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));
const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentByKey: vi.fn(),
  upsertIssueDocument: vi.fn(),
}));
const mockAnnotationService = vi.hoisted(() => ({
  listThreadsForIssueDocument: vi.fn(),
  getThreadForIssueDocument: vi.fn(),
  createThread: vi.fn(),
  addComment: vi.fn(),
  updateThread: vi.fn(),
  remapOpenThreadsForDocument: vi.fn(),
}));
const mockIssueReferenceService = vi.hoisted(() => ({
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncAnnotationComment: vi.fn(async () => undefined),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const documentPayload = {
  id: "document-1",
  companyId,
  issueId,
  key: "plan",
  title: "Plan",
  format: "markdown",
  body: "Alpha selected text omega",
  latestRevisionId: "44444444-4444-4444-8444-444444444444",
  latestRevisionNumber: 1,
  createdByAgentId: null,
  createdByUserId: "board-user",
  updatedByAgentId: null,
  updatedByUserId: "board-user",
  createdAt: new Date("2026-05-14T12:00:00.000Z"),
  updatedAt: new Date("2026-05-14T12:00:00.000Z"),
};

const annotationThread = {
  id: "55555555-5555-4555-8555-555555555555",
  companyId,
  issueId,
  documentId: "document-1",
  documentKey: "plan",
  status: "open",
  anchorState: "active",
  anchorConfidence: "exact",
  originalRevisionId: documentPayload.latestRevisionId,
  originalRevisionNumber: 1,
  currentRevisionId: documentPayload.latestRevisionId,
  currentRevisionNumber: 1,
  selectedText: "selected text",
  prefixText: "Alpha ",
  suffixText: " omega",
  normalizedStart: 6,
  normalizedEnd: 19,
  markdownStart: 6,
  markdownEnd: 19,
  anchorSelector: {
    quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
    position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
  },
  createdByAgentId: null,
  createdByUserId: "board-user",
  resolvedByAgentId: null,
  resolvedByUserId: null,
  resolvedAt: null,
  createdAt: new Date("2026-05-14T12:01:00.000Z"),
  updatedAt: new Date("2026-05-14T12:01:00.000Z"),
};

const annotationComment = {
  id: "66666666-6666-4666-8666-666666666666",
  companyId,
  threadId: annotationThread.id,
  issueId,
  documentId: "document-1",
  body: "Please review PAP-1",
  authorType: "user",
  authorAgentId: null,
  authorUserId: "board-user",
  createdByRunId: null,
  createdAt: new Date("2026-05-14T12:01:00.000Z"),
  updatedAt: new Date("2026-05-14T12:01:00.000Z"),
};

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(),
      decide: vi.fn(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_test",
        explanation: "Allowed by test mock.",
      })),
      hasPermission: vi.fn(async () => false),
    }),
    agentService: () => ({ getById: vi.fn(), list: vi.fn(async () => []) }),
    companyService: () => ({ getById: vi.fn(async () => ({ id: companyId, attachmentMaxBytes: 10_000_000 })) }),
    documentAnnotationService: () => mockAnnotationService,
    documentService: () => mockDocumentService,
    environmentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({ id: "settings", general: {} })),
      getExperimental: vi.fn(async () => ({})),
      getGeneral: vi.fn(async () => ({})),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueReferenceService: () => mockIssueReferenceService,
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

async function createApp(actor: "board" | "agent" = "board", actorCompanyId = companyId) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor === "agent"
      ? {
        type: "agent",
        agentId: "77777777-7777-4777-8777-777777777777",
        companyId: actorCompanyId,
        runId: "88888888-8888-4888-8888-888888888888",
      }
      : {
        type: "board",
        userId: "board-user",
        companyIds: [actorCompanyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("document annotation routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      title: "Annotation API",
      status: "in_progress",
      assigneeAgentId: null,
    });
    mockIssueService.assertCheckoutOwner.mockResolvedValue({});
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue(documentPayload);
    mockDocumentService.upsertIssueDocument.mockResolvedValue({
      created: false,
      document: {
        ...documentPayload,
        body: "Alpha updated selected text omega",
        latestRevisionId: "99999999-9999-4999-8999-999999999999",
        latestRevisionNumber: 2,
      },
    });
    mockAnnotationService.listThreadsForIssueDocument.mockImplementation(async (
      _issueId: string,
      _key: string,
      options?: { includeComments?: boolean },
    ) => (
      options?.includeComments
        ? [{ ...annotationThread, comments: [annotationComment] }]
        : [annotationThread]
    ));
    mockAnnotationService.getThreadForIssueDocument.mockResolvedValue({ ...annotationThread, comments: [annotationComment] });
    mockAnnotationService.createThread.mockResolvedValue({ ...annotationThread, comments: [annotationComment] });
    mockAnnotationService.addComment.mockResolvedValue(annotationComment);
    mockAnnotationService.updateThread.mockResolvedValue({ ...annotationThread, status: "resolved" });
    mockAnnotationService.remapOpenThreadsForDocument.mockResolvedValue([]);
  });

  it("includes compact open annotations without comment bodies by default for agent document reads", async () => {
    const res = await request(await createApp("agent"))
      .get(`/api/issues/${issueId}/documents/plan`)
      .expect(200);

    expect(res.body.annotations).toHaveLength(1);
    expect(res.body.annotations[0].comments).toBeUndefined();
    expect(mockAnnotationService.listThreadsForIssueDocument).toHaveBeenCalledWith(issueId, "plan", {
      status: "open",
      includeComments: false,
    });
  });

  it("includes annotation comment bodies on document reads only when explicitly requested", async () => {
    const res = await request(await createApp("agent"))
      .get(`/api/issues/${issueId}/documents/plan?includeAnnotationComments=true`)
      .expect(200);

    expect(res.body.annotations[0].comments[0].body).toBe("Please review PAP-1");
    expect(mockAnnotationService.listThreadsForIssueDocument).toHaveBeenCalledWith(issueId, "plan", {
      status: "open",
      includeComments: true,
    });
  });

  it("updates issue documents without waking the assignee through the issue-comment path", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      title: "Document API",
      status: "in_progress",
      assigneeAgentId: "99999999-9999-4999-8999-999999999999",
    });

    const res = await request(await createApp())
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({
        title: "Plan",
        format: "markdown",
        body: "Alpha updated selected text omega",
        changeSummary: "Document feedback only",
        baseRevisionId: documentPayload.latestRevisionId,
      })
      .expect(200);

    expect(res.body.latestRevisionNumber).toBe(2);
    expect(mockIssueReferenceService.syncDocument).toHaveBeenCalledWith(documentPayload.id);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.document_updated",
    }));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("creates annotation threads, syncs references, logs activity, and does not wake the assignee", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      title: "Annotation API",
      status: "todo",
      assigneeAgentId: "99999999-9999-4999-8999-999999999999",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${issueId}/documents/plan/annotations`)
      .send({
        baseRevisionId: documentPayload.latestRevisionId,
        baseRevisionNumber: 1,
        selector: annotationThread.anchorSelector,
        body: "Please review PAP-1",
      })
      .expect(201);

    expect(res.body.id).toBe(annotationThread.id);
    expect(mockIssueReferenceService.syncAnnotationComment).toHaveBeenCalledWith(annotationComment.id);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.document_annotation_thread_created",
      details: expect.objectContaining({
        key: "plan",
        documentKey: "plan",
      }),
    }));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects agent cross-company annotation reads", async () => {
    await request(await createApp("agent", otherCompanyId))
      .get(`/api/issues/${issueId}/documents/plan/annotations`)
      .expect(403);
  });

  it("adds annotation comments without waking the assignee and resolves threads", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      title: "Annotation API",
      status: "todo",
      assigneeAgentId: "99999999-9999-4999-8999-999999999999",
    });

    await request(await createApp())
      .post(`/api/issues/${issueId}/documents/plan/annotations/${annotationThread.id}/comments`)
      .send({ body: "Reply with PAP-2" })
      .expect(201);
    expect(mockIssueReferenceService.syncAnnotationComment).toHaveBeenCalledWith(annotationComment.id);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.document_annotation_comment_added",
      details: expect.objectContaining({
        key: "plan",
        documentKey: "plan",
      }),
    }));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();

    const resolved = await request(await createApp())
      .patch(`/api/issues/${issueId}/documents/plan/annotations/${annotationThread.id}`)
      .send({ status: "resolved" })
      .expect(200);
    expect(resolved.body.status).toBe("resolved");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.document_annotation_thread_resolved",
      details: expect.objectContaining({
        key: "plan",
        documentKey: "plan",
      }),
    }));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});
