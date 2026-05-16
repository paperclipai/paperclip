import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const ownerRunId = "55555555-5555-4555-8555-555555555555";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listAttachments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/documents.js", () => ({
    documentService: () => mockDocumentService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => mockWorkProductService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: vi.fn(async () => undefined),
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => mockCompanyService,
    documentService: () => mockDocumentService,
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
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
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
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1649",
    title: "Owned active issue",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId,
    role: "engineer",
    reportsTo: null,
    permissions: { canCreateAgents: false },
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function peerActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: peerAgentId,
    companyId,
    source: "agent_key",
    runId: "66666666-6666-4666-8666-666666666666",
    ...overrides,
  };
}

function ownerActor() {
  return {
    type: "agent",
    agentId: ownerAgentId,
    companyId,
    source: "agent_key",
    runId: ownerRunId,
  };
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

describe("agent issue mutation checkout ownership", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockCompanyService.getById.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.getAttachmentById.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockIssueService.listAttachments.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueService.remove.mockReset();
    mockIssueService.removeAttachment.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockDocumentService.upsertIssueDocument.mockReset();
    mockWorkProductService.getById.mockReset();
    mockWorkProductService.update.mockReset();
    mockStorageService.putFile.mockReset();
    mockStorageService.getObject.mockReset();
    mockStorageService.headObject.mockReset();
    mockStorageService.deleteObject.mockReset();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === ownerAgentId) return makeAgent(ownerAgentId);
      if (id === peerAgentId) return makeAgent(peerAgentId);
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      makeAgent(ownerAgentId),
      makeAgent(peerAgentId),
    ]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "PAP" });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      issueId,
      companyId,
      body: "comment",
    });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.remove.mockResolvedValue(makeIssue({ status: "cancelled" }));
    mockIssueService.getAttachmentById.mockResolvedValue({
      id: "attachment-1",
      issueId,
      companyId,
      objectKey: "issues/attachment-1/report.txt",
      contentType: "text/plain",
      byteSize: 6,
      originalFilename: "report.txt",
    });
    mockIssueService.removeAttachment.mockResolvedValue({
      id: "attachment-1",
      issueId,
      companyId,
      objectKey: "issues/attachment-1/report.txt",
    });
    mockDocumentService.upsertIssueDocument.mockResolvedValue({
      created: false,
      document: {
        id: "document-1",
        key: "plan",
        title: "Plan",
        format: "markdown",
        latestRevisionNumber: 2,
      },
    });
    mockWorkProductService.getById.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
    });
    mockWorkProductService.update.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
      title: "Updated",
    });
    mockStorageService.putFile.mockResolvedValue({
      provider: "local_disk",
      objectKey: "issues/upload.txt",
      contentType: "text/plain",
      byteSize: 6,
      sha256: "sha256",
      originalFilename: "upload.txt",
    });
    mockStorageService.getObject.mockResolvedValue({
      stream: Readable.from(Buffer.from("report")),
      contentLength: 6,
    });
    mockStorageService.deleteObject.mockResolvedValue(undefined);
  });

  it.each([
    ["patch", (app: express.Express) => request(app).patch(`/api/issues/${issueId}`).send({ title: "Blocked" })],
    ["delete", (app: express.Express) => request(app).delete(`/api/issues/${issueId}`)],
    ["comment", (app: express.Express) => request(app).post(`/api/issues/${issueId}/comments`).send({ body: "blocked" })],
    [
      "document upsert",
      (app: express.Express) =>
        request(app).put(`/api/issues/${issueId}/documents/plan`).send({ format: "markdown", body: "# blocked" }),
    ],
    ["work product update", (app: express.Express) => request(app).patch("/api/work-products/product-1").send({ title: "Blocked" })],
    [
      "attachment upload",
      (app: express.Express) =>
        request(app)
          .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
          .attach("file", Buffer.from("report"), { filename: "report.txt", contentType: "text/plain" }),
    ],
    ["attachment delete", (app: express.Express) => request(app).delete("/api/attachments/attachment-1")],
  ])("rejects peer agent %s on another agent's active checkout", async (_name, sendRequest) => {
    const res = await sendRequest(await createApp(peerActor()));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockDocumentService.upsertIssueDocument).not.toHaveBeenCalled();
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
    expect(mockStorageService.deleteObject).not.toHaveBeenCalled();
  });

  it("allows the checked-out owner with the matching run id to patch and update documents", async () => {
    const app = await createApp(ownerActor());

    await request(app).patch(`/api/issues/${issueId}`).send({ title: "Updated" }).expect(200);
    await request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# updated" })
      .expect(200);

    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, ownerAgentId, ownerRunId);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId,
        key: "plan",
        createdByAgentId: ownerAgentId,
        createdByRunId: ownerRunId,
        lockedDocumentStrategy: "create_new_document",
      }),
    );
  });

  it("preserves board mutations on active checkouts", async () => {
    const app = await createApp(boardActor());

    await request(app).patch(`/api/issues/${issueId}`).send({ title: "Board update" }).expect(200);
    await request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# board" })
      .expect(200);

    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalled();
  });

  it("allows agents with the active-checkout management grant to mutate active checkouts", async () => {
    mockAccessService.hasPermission.mockImplementation(async (
      _companyId: string,
      _principalType: string,
      principalId: string,
      permissionKey: string,
    ) => principalId === peerAgentId && permissionKey === "tasks:manage_active_checkouts");

    const res = await request(await createApp(peerActor())).patch(`/api/issues/${issueId}`).send({ title: "Managed update" });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it.each([
    ["todo", "patch", (app: express.Express) => request(app).patch(`/api/issues/${issueId}`).send({ title: "Todo update" })],
    ["todo", "comment", (app: express.Express) => request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Todo noise" })],
    ["blocked", "patch", (app: express.Express) => request(app).patch(`/api/issues/${issueId}`).send({ title: "Blocked update" })],
  ])("rejects peer agent %s issue %s mutations outside active checkout ownership", async (status, _kind, sendRequest) => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: status as "todo" | "blocked", assigneeAgentId: ownerAgentId }));

    const res = await sendRequest(await createApp(peerActor()));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("allows same-company agent mutations on unassigned in-progress issues", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: null }));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({ assigneeAgentId: null }),
      ...patch,
    }));

    const res = await request(await createApp(peerActor())).patch(`/api/issues/${issueId}`).send({ title: "Claimable update" });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      id: issueId,
      assigneeAgentId: null,
      title: "Claimable update",
    });
  });
});
