import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const issueId = "11111111-1111-4111-8111-111111111111";
const workProductId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const attachmentId = "55555555-5555-4555-8555-555555555555";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../otel.js", () => ({
  recordComment: vi.fn(),
  recordHumanIntervened: vi.fn(),
  recordIssueCreated: vi.fn(),
  recordIssueStatusChanged: vi.fn(),
  recordIssueStatusCounts: vi.fn(),
  clearIssueStatusCountsForCompany: vi.fn(),
  traceHumanCommentPosted: vi.fn(),
  recordRunStatus: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  agentService: () => ({ getById: vi.fn(), list: vi.fn(), resolveByReference: vi.fn() }),
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
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueReferenceService: () => ({
    deleteDocumentSource: vi.fn(async () => undefined),
    diffIssueReferenceSummary: vi.fn(() => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    })),
    emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
    listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
    syncComment: vi.fn(async () => undefined),
    syncDocument: vi.fn(async () => undefined),
    syncIssue: vi.fn(async () => undefined),
  }),
  issueService: () => mockIssueService,
  documentService: () => ({ upsertIssueDocument: vi.fn() }),
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductService,
  ISSUE_LIST_DEFAULT_LIMIT: 20,
  ISSUE_LIST_MAX_LIMIT: 100,
  clampIssueListLimit: (value: number) => value,
}));

import { issueRoutes } from "../routes/issues.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  } as any));
  app.use(errorHandler);
  return app;
}

describe("issue work product routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      status: "todo",
      assigneeAgentId: null,
      projectId: null,
    });
  });

  it("rejects updates when the merged artifact state is still missing attachment-backed metadata", async () => {
    mockWorkProductService.getById.mockResolvedValue({
      id: workProductId,
      companyId,
      issueId,
      type: "artifact",
      metadata: null,
      createdByRunId: null,
    });

    const res = await request(createApp())
      .patch(`/api/work-products/${workProductId}`)
      .send({ title: "Recovered title" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("attachment-backed metadata");
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
  });

  it("allows artifact updates when the stored metadata stays attachment-backed", async () => {
    mockWorkProductService.getById.mockResolvedValue({
      id: workProductId,
      companyId,
      issueId,
      type: "artifact",
      metadata: {
        attachmentId,
        contentPath: `/api/attachments/${attachmentId}/content`,
        sourcePath: "deliverables/final-packet.md",
        contentType: "text/markdown",
        byteSize: 128,
        originalFilename: "final-packet.md",
      },
      createdByRunId: runId,
    });
    mockWorkProductService.update.mockResolvedValue({
      id: workProductId,
      title: "Recovered title",
    });

    const res = await request(createApp())
      .patch(`/api/work-products/${workProductId}`)
      .send({ title: "Recovered title" });

    expect(res.status).toBe(200);
    expect(mockWorkProductService.update).toHaveBeenCalledWith(workProductId, { title: "Recovered title" });
  });

  it("rejects artifact updates that try to patch in a filesystem contentPath and fake attachment route", async () => {
    mockWorkProductService.getById.mockResolvedValue({
      id: workProductId,
      companyId,
      issueId,
      type: "artifact",
      url: `/api/attachments/${attachmentId}/content`,
      metadata: {
        attachmentId,
        contentPath: `/api/attachments/${attachmentId}/content`,
        sourcePath: "deliverables/final-packet.md",
        contentType: "text/markdown",
        byteSize: 128,
        originalFilename: "final-packet.md",
      },
      createdByRunId: runId,
    });

    const res = await request(createApp())
      .patch(`/api/work-products/${workProductId}`)
      .send({
        metadata: {
          attachmentId,
          contentPath: "/home/node/.openclaw/workspace-ceo/ceo-config-and-runs-report.md",
          sourcePath: "deliverables/final-packet.md",
          contentType: "text/markdown",
          byteSize: 128,
          originalFilename: "ceo-config-and-runs-report.md",
        },
        url: `/api/attachments/${attachmentId}/content`,
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("attachment-backed metadata");
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
  });

  it("rejects request metadata with extra keys even when PATCH omits type", async () => {
    mockWorkProductService.getById.mockResolvedValue({
      id: workProductId,
      companyId,
      issueId,
      type: "artifact",
      url: `/api/attachments/${attachmentId}/content`,
      metadata: {
        attachmentId,
        contentPath: `/api/attachments/${attachmentId}/content`,
        sourcePath: "deliverables/final-packet.md",
        contentType: "text/markdown",
        byteSize: 128,
        originalFilename: "final-packet.md",
      },
      createdByRunId: runId,
    });

    const res = await request(createApp())
      .patch(`/api/work-products/${workProductId}`)
      .send({
        metadata: {
          attachmentId,
          contentPath: `/api/attachments/${attachmentId}/content`,
          sourcePath: "deliverables/final-packet.md",
          contentType: "text/markdown",
          byteSize: 128,
          originalFilename: "final-packet.md",
          contentBase64: "IyBGaW5hbCBwYWNrZXQK",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("attachment-backed metadata");
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
  });
});
