import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "company-1";
const documentId = "document-1";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  listCompanyDocuments: vi.fn(),
  getCompanyDocumentById: vi.fn(),
  createCompanyDocument: vi.fn(),
  updateCompanyDocument: vi.fn(),
  listCompanyDocumentRevisions: vi.fn(),
  restoreCompanyDocumentRevision: vi.fn(),
  deleteCompanyDocument: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listFeedbackTraces: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerServiceMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    budgetService: () => mockBudgetService,
    companyPortabilityService: () => mockCompanyPortabilityService,
    companyService: () => mockCompanyService,
    documentService: () => mockDocumentService,
    feedbackService: () => mockFeedbackService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/companies.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function createDocument() {
  return {
    id: documentId,
    companyId,
    title: "Nuviya Stage Tone Profiles",
    format: "markdown",
    body: "# Tone",
    latestRevisionId: "revision-2",
    latestRevisionNumber: 2,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    createdAt: new Date("2026-04-12T00:00:00.000Z"),
    updatedAt: new Date("2026-04-12T00:05:00.000Z"),
  };
}

describe("company documents routes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerServiceMocks();
    vi.resetAllMocks();
  });

  it("lists company documents for board users", async () => {
    mockDocumentService.listCompanyDocuments.mockResolvedValue([createDocument()]);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/documents`);

    expect(res.status).toBe(200);
    expect(mockDocumentService.listCompanyDocuments).toHaveBeenCalledWith(companyId);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: documentId,
        title: "Nuviya Stage Tone Profiles",
      }),
    ]);
  });

  it("restores a company document revision and returns the restored document", async () => {
    mockDocumentService.restoreCompanyDocumentRevision.mockResolvedValue({
      restoredFromRevisionId: "revision-1",
      restoredFromRevisionNumber: 1,
      document: {
        ...createDocument(),
        latestRevisionId: "revision-3",
        latestRevisionNumber: 3,
      },
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/documents/${documentId}/revisions/revision-1/restore`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockDocumentService.restoreCompanyDocumentRevision).toHaveBeenCalledWith({
      companyId,
      documentId,
      revisionId: "revision-1",
      createdByUserId: "user-1",
      createdByAgentId: null,
    });
    expect(res.body).toEqual(expect.objectContaining({
      id: documentId,
      latestRevisionNumber: 3,
    }));
  });

  it("rejects agent callers because company documents are a board-managed UI surface", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });

    const res = await request(app).get(`/api/companies/${companyId}/documents`);

    expect(res.status).toBe(403);
    expect(mockDocumentService.listCompanyDocuments).not.toHaveBeenCalled();
  });
});
