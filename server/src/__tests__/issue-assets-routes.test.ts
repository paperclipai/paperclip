import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  listAttachments: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  listIssueDocuments: vi.fn(),
  getIssueDocumentByKey: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => mockDocumentsService,
  executionWorkspaceService: () => ({}),
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
    listCompanyIds: vi.fn(async () => [companyId]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductService,
}));

const allowedBoardActor = {
  type: "board",
  userId: "board-user",
  companyIds: [companyId],
  source: "auth0",
  isInstanceAdmin: false,
};

function createApp(actor: Record<string, unknown> = allowedBoardActor) {
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

const now = new Date("2026-04-12T12:00:00.000Z");
const issue = {
  id: issueId,
  companyId,
  identifier: "PAP-1",
  title: "Assets",
  status: "in_progress",
};
const document = {
  id: "document-1",
  companyId,
  issueId,
  key: "plan",
  title: "Plan",
  format: "markdown",
  body: "# Plan",
  latestRevisionId: "revision-1",
  latestRevisionNumber: 1,
  createdByAgentId: null,
  createdByUserId: "board-user",
  updatedByAgentId: null,
  updatedByUserId: "board-user",
  createdAt: now,
  updatedAt: now,
};
const attachment = {
  id: "attachment-1",
  companyId,
  issueId,
  issueCommentId: null,
  assetId: "asset-1",
  provider: "local_disk",
  objectKey: "issues/issue-1/report.pdf",
  contentType: "application/pdf",
  byteSize: 12,
  sha256: "sha256-sample",
  originalFilename: "report.pdf",
  createdByAgentId: null,
  createdByUserId: "board-user",
  createdAt: now,
  updatedAt: now,
};
const workProduct = {
  id: "work-product-1",
  companyId,
  projectId: null,
  issueId,
  executionWorkspaceId: null,
  runtimeServiceId: null,
  type: "pull_request",
  provider: "github",
  externalId: "123",
  title: "PR #123",
  url: "https://github.com/paperclipai/paperclip/pull/123",
  status: "ready_for_review",
  reviewState: "needs_board_review",
  isPrimary: true,
  healthStatus: "unknown",
  summary: null,
  metadata: null,
  createdByRunId: null,
  createdAt: now,
  updatedAt: now,
};

describe("issue assets routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listAttachments.mockResolvedValue([attachment]);
    mockDocumentsService.listIssueDocuments.mockResolvedValue([document]);
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue(document);
    mockWorkProductService.listForIssue.mockResolvedValue([workProduct]);
  });

  it("returns an issue-scoped assets manifest without storage object paths", async () => {
    const res = await request(createApp()).get(`/api/issues/${issueId}/assets`);

    expect(res.status).toBe(200);
    expect(res.body.issue).toEqual({ id: issueId, identifier: "PAP-1" });
    expect(res.body.workspace).toEqual({
      status: "unavailable",
      reason: "workspace_browsing_disabled",
    });
    expect(res.body.assets.map((asset: { kind: string }) => asset.kind)).toEqual([
      "document",
      "attachment",
      "work_product",
    ]);
    expect(res.body.assets[0]).toEqual(expect.objectContaining({
      kind: "document",
      title: "Plan",
      contentType: "text/markdown; charset=utf-8",
      byteSize: Buffer.byteLength(document.body, "utf8"),
      previewable: true,
      previewUrl: `/api/issues/${issueId}/documents/plan`,
      downloadUrl: `/api/issues/${issueId}/documents/plan/export`,
      reviewState: null,
      isPrimary: null,
    }));
    expect(res.body.assets[1]).toEqual(expect.objectContaining({
      kind: "attachment",
      title: "report.pdf",
      contentType: "application/pdf",
      byteSize: 12,
      previewable: true,
      previewUrl: "/api/attachments/attachment-1/content",
      downloadUrl: "/api/attachments/attachment-1/content?download=1",
      reviewState: null,
      isPrimary: null,
    }));
    expect(res.body.assets[1]).not.toHaveProperty("objectKey");
    expect(res.body.assets[2]).toEqual(expect.objectContaining({
      kind: "work_product",
      title: "PR #123",
      contentType: null,
      byteSize: null,
      previewable: true,
      previewUrl: "https://github.com/paperclipai/paperclip/pull/123",
      downloadUrl: null,
      reviewState: "needs_board_review",
      isPrimary: true,
      type: "pull_request",
      provider: "github",
    }));
  });

  it("returns an empty assets manifest with workspace browsing unavailable", async () => {
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockDocumentsService.listIssueDocuments.mockResolvedValue([]);
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const res = await request(createApp()).get(`/api/issues/${issueId}/assets`);

    expect(res.status).toBe(200);
    expect(res.body.assets).toEqual([]);
    expect(res.body.workspace.status).toBe("unavailable");
  });

  it("does not expose parameterized svg attachments as previewable", async () => {
    mockIssueService.listAttachments.mockResolvedValue([
      {
        ...attachment,
        contentType: "image/svg+xml; charset=utf-8",
        originalFilename: "diagram.svg",
      },
    ]);
    mockDocumentsService.listIssueDocuments.mockResolvedValue([]);
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const res = await request(createApp()).get(`/api/issues/${issueId}/assets`);

    expect(res.status).toBe(200);
    expect(res.body.assets).toEqual([
      expect.objectContaining({
        kind: "attachment",
        title: "diagram.svg",
        contentType: "image/svg+xml",
        previewable: false,
        previewUrl: null,
        downloadUrl: "/api/attachments/attachment-1/content?download=1",
      }),
    ]);
  });

  it("exports the latest issue document revision as markdown download", async () => {
    const body = "# Plan\n\nShip it.";
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue({ ...document, body });

    const res = await request(createApp()).get(`/api/issues/${issueId}/documents/plan/export`);

    expect(res.status).toBe(200);
    expect(res.text).toBe(body);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(body, "utf8")));
    expect(res.headers["content-disposition"]).toBe('attachment; filename="PAP-1-plan.md"');
    expect(res.headers["cache-control"]).toBe("private, max-age=60");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects invalid document export keys before loading the document", async () => {
    const res = await request(createApp()).get(`/api/issues/${issueId}/documents/INVALID%20KEY/export`);

    expect(res.status).toBe(400);
    expect(mockDocumentsService.getIssueDocumentByKey).not.toHaveBeenCalled();
  });

  it("returns not found when exporting a missing document", async () => {
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue(null);

    const res = await request(createApp()).get(`/api/issues/${issueId}/documents/plan/export`);

    expect(res.status).toBe(404);
  });

  it("uses existing company access checks for document export", async () => {
    const deniedActor = {
      ...allowedBoardActor,
      companyIds: ["other-company"],
    };

    const res = await request(createApp(deniedActor)).get(`/api/issues/${issueId}/documents/plan/export`);

    expect(res.status).toBe(403);
    expect(mockDocumentsService.getIssueDocumentByKey).not.toHaveBeenCalled();
  });
});
