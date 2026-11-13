import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routineId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";
const agentId = "77777777-7777-4777-8777-777777777777";
const firstRevisionId = "44444444-4444-4444-8444-444444444444";
const secondRevisionId = "99999999-9999-4999-8999-999999999999";

const mockRoutineService = vi.hoisted(() => ({
  get: vi.fn(),
  getDetail: vi.fn(),
  getDescriptionDocument: vi.fn(),
  update: vi.fn(),
}));
const mockAnnotationService = vi.hoisted(() => ({
  listThreadsForRoutineDocument: vi.fn(),
  getThreadForRoutineDocument: vi.fn(),
  createRoutineThread: vi.fn(),
  addRoutineComment: vi.fn(),
  updateRoutineThread: vi.fn(),
  remapOpenThreadsForRoutineDocument: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const routine = {
  id: routineId,
  companyId,
  title: "Daily summary",
  description: "Alpha selected text omega",
  status: "active",
  assigneeAgentId: agentId,
  latestRevisionId: firstRevisionId,
  latestRevisionNumber: 1,
};

const descriptionDocument = {
  id: "document-1",
  companyId,
  routineId,
  key: "description",
  title: "Routine instructions",
  format: "markdown",
  body: "Alpha selected text omega",
  latestRevisionId: firstRevisionId,
  latestRevisionNumber: 1,
  createdByAgentId: null,
  createdByUserId: "board-user",
  updatedByAgentId: null,
  updatedByUserId: "board-user",
  createdAt: new Date("2026-06-16T12:00:00.000Z"),
  updatedAt: new Date("2026-06-16T12:00:00.000Z"),
};

const updatedDescriptionDocument = {
  ...descriptionDocument,
  body: "Alpha updated selected text omega",
  latestRevisionId: secondRevisionId,
  latestRevisionNumber: 2,
  updatedAt: new Date("2026-06-16T12:02:00.000Z"),
};

const selector = {
  quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
  position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
};

const annotationThread = {
  id: "55555555-5555-4555-8555-555555555555",
  companyId,
  issueId: null,
  routineId,
  documentId: descriptionDocument.id,
  documentKey: "description",
  status: "open",
  anchorState: "active",
  anchorConfidence: "exact",
  originalRevisionId: firstRevisionId,
  originalRevisionNumber: 1,
  currentRevisionId: firstRevisionId,
  currentRevisionNumber: 1,
  selectedText: "selected text",
  prefixText: "Alpha ",
  suffixText: " omega",
  normalizedStart: 6,
  normalizedEnd: 19,
  markdownStart: 6,
  markdownEnd: 19,
  anchorSelector: selector,
  createdByAgentId: null,
  createdByUserId: "board-user",
  resolvedByAgentId: null,
  resolvedByUserId: null,
  resolvedAt: null,
  createdAt: new Date("2026-06-16T12:01:00.000Z"),
  updatedAt: new Date("2026-06-16T12:01:00.000Z"),
};

const annotationComment = {
  id: "66666666-6666-4666-8666-666666666666",
  companyId,
  threadId: annotationThread.id,
  issueId: null,
  routineId,
  documentId: descriptionDocument.id,
  body: "Please tighten this",
  authorType: "user",
  authorAgentId: null,
  authorUserId: "board-user",
  createdByRunId: null,
  createdAt: new Date("2026-06-16T12:01:00.000Z"),
  updatedAt: new Date("2026-06-16T12:01:00.000Z"),
};

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(async () => true),
    }),
    documentAnnotationService: () => mockAnnotationService,
    logActivity: mockLogActivity,
    routineService: () => mockRoutineService,
  }));
}

async function createApp(actor: "board" | "agent" = "board", actorCompanyId = companyId) {
  const [{ routineRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/routines.js")>("../routes/routines.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor === "agent"
      ? {
        type: "agent",
        agentId,
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
  app.use("/api", routineRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("routine description annotation routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/routines.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockRoutineService.get.mockResolvedValue(routine);
    mockRoutineService.getDescriptionDocument.mockResolvedValue(updatedDescriptionDocument);
    mockRoutineService.update.mockResolvedValue({
      ...routine,
      description: "Alpha updated selected text omega",
      latestRevisionId: secondRevisionId,
      latestRevisionNumber: 2,
    });
    mockAnnotationService.listThreadsForRoutineDocument.mockImplementation(async (
      _routineId: string,
      _key: string,
      options?: { includeComments?: boolean },
    ) => (
      options?.includeComments
        ? [{ ...annotationThread, comments: [annotationComment] }]
        : [annotationThread]
    ));
    mockAnnotationService.getThreadForRoutineDocument.mockResolvedValue({
      ...annotationThread,
      comments: [annotationComment],
    });
    mockAnnotationService.createRoutineThread.mockResolvedValue({
      ...annotationThread,
      comments: [annotationComment],
    });
    mockAnnotationService.addRoutineComment.mockResolvedValue(annotationComment);
    mockAnnotationService.updateRoutineThread.mockResolvedValue({ ...annotationThread, status: "resolved" });
    mockAnnotationService.remapOpenThreadsForRoutineDocument.mockResolvedValue([
      {
        thread: {
          ...annotationThread,
          currentRevisionId: secondRevisionId,
          currentRevisionNumber: 2,
        },
        snapshot: { id: "snapshot-1" },
      },
    ]);
  });

  it("creates, replies to, resolves, and reopens routine description annotation threads", async () => {
    const app = await createApp();

    const created = await request(app)
      .post(`/api/routines/${routineId}/description/annotations`)
      .send({
        baseRevisionId: firstRevisionId,
        baseRevisionNumber: 1,
        selector,
        body: "Please tighten this",
      })
      .expect(201);

    expect(created.body.id).toBe(annotationThread.id);
    expect(mockAnnotationService.createRoutineThread).toHaveBeenCalledWith(
      routineId,
      "description",
      expect.objectContaining({ baseRevisionId: firstRevisionId, body: "Please tighten this" }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "routine.document_annotation_thread_created",
      entityType: "routine",
      entityId: routineId,
      details: expect.objectContaining({ documentKey: "description", threadId: annotationThread.id }),
    }));

    await request(app)
      .post(`/api/routines/${routineId}/description/annotations/${annotationThread.id}/comments`)
      .send({ body: "Reply on the same thread" })
      .expect(201);
    expect(mockAnnotationService.addRoutineComment).toHaveBeenCalledWith(
      routineId,
      "description",
      annotationThread.id,
      expect.objectContaining({ body: "Reply on the same thread" }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "routine.document_annotation_comment_added",
      details: expect.objectContaining({ documentKey: "description", threadId: annotationThread.id }),
    }));

    await request(app)
      .patch(`/api/routines/${routineId}/description/annotations/${annotationThread.id}`)
      .send({ status: "resolved" })
      .expect(200);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "routine.document_annotation_thread_resolved",
      details: expect.objectContaining({ documentKey: "description", threadId: annotationThread.id }),
    }));

    mockAnnotationService.updateRoutineThread.mockResolvedValueOnce({ ...annotationThread, status: "open" });
    await request(app)
      .patch(`/api/routines/${routineId}/description/annotations/${annotationThread.id}`)
      .send({ status: "open" })
      .expect(200);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "routine.document_annotation_thread_reopened",
      details: expect.objectContaining({ documentKey: "description", threadId: annotationThread.id }),
    }));
  });

  it("remaps open routine description annotations after routine description revisions", async () => {
    const updated = await request(await createApp())
      .patch(`/api/routines/${routineId}`)
      .send({
        description: "Alpha updated selected text omega",
        baseRevisionId: firstRevisionId,
      })
      .expect(200);

    expect(updated.body.latestRevisionNumber).toBe(2);
    expect(mockRoutineService.getDescriptionDocument).toHaveBeenCalledWith(routineId);
    expect(mockAnnotationService.remapOpenThreadsForRoutineDocument).toHaveBeenCalledWith({
      routineId,
      key: "description",
      documentId: updatedDescriptionDocument.id,
      nextRevisionId: updatedDescriptionDocument.latestRevisionId,
      nextRevisionNumber: updatedDescriptionDocument.latestRevisionNumber,
      nextBody: updatedDescriptionDocument.body,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "routine.document_annotation_remapped",
      entityType: "routine",
      entityId: routineId,
      details: expect.objectContaining({
        documentKey: "description",
        threadId: annotationThread.id,
      }),
    }));
  });

  it("rejects agent cross-company routine annotation reads", async () => {
    // Cross-tenant requests return 404 (not 403) so the status code cannot be
    // used as an existence oracle for other tenants' routine ids.
    await request(await createApp("agent", otherCompanyId))
      .get(`/api/routines/${routineId}/description/annotations`)
      .expect(404);
  });
});
