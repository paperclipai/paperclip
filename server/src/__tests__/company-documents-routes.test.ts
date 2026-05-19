import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";

const mockDocumentsService = vi.hoisted(() => ({
  listCompanyDocuments: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({}),
  companyService: () => ({}),
  documentService: () => mockDocumentsService,
  environmentService: () => ({}),
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
  issueRecoveryActionService: () => ({}),
  issueReferenceService: () => ({}),
  issueService: () => ({}),
  issueThreadInteractionService: () => ({}),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp() {
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

describe("GET /companies/:companyId/documents", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDocumentsService.listCompanyDocuments.mockResolvedValue([
      {
        id: "doc-1",
        companyId,
        issueId: "issue-1",
        key: "deliverable",
        title: "Deal Analysis",
        format: "markdown",
        latestRevisionId: "rev-1",
        latestRevisionNumber: 2,
        createdByAgentId: "agent-1",
        createdByUserId: null,
        updatedByAgentId: "agent-1",
        updatedByUserId: null,
        createdAt: new Date("2026-04-26T12:00:00Z"),
        updatedAt: new Date("2026-04-27T15:30:00Z"),
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          title: "Analyze WireX deal",
          status: "in_progress",
          projectId: "project-1",
          project: null,
        },
      },
    ]);
  });

  it("returns documents for the company", async () => {
    const app = createApp();
    const res = await request(app).get(`/api/companies/${companyId}/documents`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("doc-1");
    expect(res.body[0].issue.identifier).toBe("PAP-1");
    expect(mockDocumentsService.listCompanyDocuments).toHaveBeenCalledWith(companyId, {
      projectId: undefined,
      q: undefined,
      updatedAfter: undefined,
      limit: undefined,
      includeRoutineExecutions: false,
    });
  });

  it("forwards query parameters as service filters", async () => {
    const app = createApp();
    await request(app)
      .get(`/api/companies/${companyId}/documents`)
      .query({
        projectId: "project-7",
        q: "wirex",
        updatedAfter: "2026-04-20T00:00:00Z",
        limit: "25",
        includeRoutineExecutions: "true",
      });

    expect(mockDocumentsService.listCompanyDocuments).toHaveBeenCalledWith(companyId, {
      projectId: "project-7",
      q: "wirex",
      updatedAfter: new Date("2026-04-20T00:00:00Z"),
      limit: 25,
      includeRoutineExecutions: true,
    });
  });

  it("rejects non-numeric limit values", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/documents`)
      .query({ limit: "abc" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
    expect(mockDocumentsService.listCompanyDocuments).not.toHaveBeenCalled();
  });

  it("rejects zero or negative limit", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/documents`)
      .query({ limit: "0" });

    expect(res.status).toBe(400);
    expect(mockDocumentsService.listCompanyDocuments).not.toHaveBeenCalled();
  });

  it("rejects malformed updatedAfter", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/documents`)
      .query({ updatedAfter: "not-a-date" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/updatedAfter/i);
    expect(mockDocumentsService.listCompanyDocuments).not.toHaveBeenCalled();
  });

  it("denies access to a company the actor cannot reach", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Non-implicit board actor without companyId membership → assertCompanyAccess denies
      (req as any).actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes({} as any, {} as any));
    app.use(errorHandler);

    const res = await request(app).get(`/api/companies/${otherCompanyId}/documents`);
    expect(res.status).toBe(403);
    expect(mockDocumentsService.listCompanyDocuments).not.toHaveBeenCalled();
  });
});
