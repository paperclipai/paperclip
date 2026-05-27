import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const ownerRunId = "55555555-5555-4555-8555-555555555555";
const recoveryActionId = "77777777-7777-4777-8777-777777777777";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  list: vi.fn(),
  listAttachments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
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
  createForIssue: vi.fn(),
  getById: vi.fn(),
  remove: vi.fn(),
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
  listForIssue: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  resolveActiveForIssue: vi.fn(async () => null),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
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
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
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
    ISSUE_LIST_DEFAULT_LIMIT: 100,
    ISSUE_LIST_MAX_LIMIT: 500,
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    clampIssueListLimit: (value: number) => Math.min(Math.max(value, 1), 500),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
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

function createRunContextDb(
  contextSnapshot: Record<string, unknown> = {},
  runAgentOrRows: string | Record<string, unknown>[] = ownerAgentId,
  runId: string = ownerRunId,
) {
  const runRows = Array.isArray(runAgentOrRows)
    ? runAgentOrRows
    : [{
        id: runId,
        companyId,
        agentId: runAgentOrRows,
        agentCompanyId: companyId,
        contextSnapshot,
      }];
  const firstRun = runRows[0] ?? {};
  const runAgentId = typeof firstRun.agentId === "string" ? firstRun.agentId : ownerAgentId;
  const runAgentCompanyId = typeof firstRun.agentCompanyId === "string" ? firstRun.agentCompanyId : companyId;
  const rowsForSelection = (selection: Record<string, unknown>) => {
    const keys = Object.keys(selection);
    if (keys.includes("entityId")) return [];
    if (keys.includes("contextSnapshot")) return runRows;
    if (keys.includes("agentCompanyId")) return runRows;
    return [{ id: runAgentId, companyId: runAgentCompanyId, permissions: {}, role: "engineer", reportsTo: null }];
  };
  const buildQuery = (selection: Record<string, unknown>) => {
    const whereResult = {
      orderBy: vi.fn(async () => []),
      then: async (resolve: (rows: unknown[]) => unknown) => resolve(rowsForSelection(selection)),
    };
    const query = {
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => whereResult),
    };
    return query;
  };
  return {
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => buildQuery(selection)),
    })),
  };
}

async function createApp(actor: Record<string, unknown>, db?: unknown) {
  const routeDb = db ?? createRunContextDb(
    {},
    typeof actor.agentId === "string" ? actor.agentId : ownerAgentId,
    typeof actor.runId === "string" ? actor.runId : ownerRunId,
  );
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
  app.use("/api", issueRoutes(routeDb as any, mockStorageService as any));
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
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed:
        input.action === "tasks:assign" ||
        input.action === "issue:read" ||
        input.action === "issue:mutate" ||
        input.action === "company_scope:read",
      action: input.action,
      reason:
        input.action === "tasks:assign" ||
          input.action === "issue:read" ||
          input.action === "issue:mutate" ||
          input.action === "company_scope:read"
          ? "allow_explicit_grant"
          : "deny_missing_grant",
      explanation:
        input.action === "tasks:assign" ||
          input.action === "issue:read" ||
          input.action === "issue:mutate" ||
          input.action === "company_scope:read"
          ? "Allowed by test default."
          : "Missing permission.",
    }));
    mockAccessService.hasPermission.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockCompanyService.getById.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
    mockIssueService.getAttachmentById.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockIssueService.list.mockReset();
    mockIssueService.listAttachments.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueRecoveryActionService.listActiveForIssues.mockReset();
    mockIssueRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
    mockIssueRecoveryActionService.resolveActiveForIssue.mockReset();
    mockIssueRecoveryActionService.resolveActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      recoveryIssueId: null,
      kind: "issue_graph_liveness",
      status: "resolved",
      ownerType: "agent",
      ownerAgentId,
      ownerUserId: null,
      previousOwnerAgentId: null,
      returnOwnerAgentId: null,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:test",
      evidence: {},
      nextAction: "Restore a live execution path.",
      wakePolicy: null,
      monitorPolicy: null,
      attemptCount: 1,
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: new Date("2026-05-13T18:00:00.000Z"),
      outcome: "restored",
      resolutionNote: "Resolved by recovery owner",
      resolvedAt: new Date("2026-05-13T18:05:00.000Z"),
      createdAt: new Date("2026-05-13T17:55:00.000Z"),
      updatedAt: new Date("2026-05-13T18:05:00.000Z"),
    });
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockReset();
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockIssueService.remove.mockReset();
    mockIssueService.removeAttachment.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueThreadInteractionService.listForIssue.mockReset();
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockDocumentService.upsertIssueDocument.mockReset();
    mockWorkProductService.createForIssue.mockReset();
    mockWorkProductService.getById.mockReset();
    mockWorkProductService.remove.mockReset();
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
    mockIssueService.list.mockResolvedValue([makeIssue()]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      ...makeIssue({
        id: "88888888-8888-4888-8888-888888888888",
        status: "todo",
        assigneeAgentId: null,
      }),
      ...input,
      companyId,
    }));
    mockIssueService.createChild.mockImplementation(async (_parentId: string, input: Record<string, unknown>) => ({
      issue: {
        ...makeIssue({
          id: "99999999-9999-4999-8999-999999999999",
          status: "todo",
          parentId: issueId,
          assigneeAgentId: null,
        }),
        ...input,
        companyId,
      },
      parentBlockerAdded: false,
    }));
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
    mockWorkProductService.createForIssue.mockResolvedValue({
      id: "product-2",
      issueId,
      companyId,
      type: "artifact",
      provider: "test",
      title: "Artifact",
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
    mockWorkProductService.remove.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
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

  it("uses the company-scope fast path on the issue list route", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
      if (input.action === "company_scope:read") {
        return {
          allowed: true,
          action: input.action,
          reason: "allow_explicit_grant",
          explanation: "Allowed by test company scope.",
        };
      }
      if (input.action === "issue:read") {
        throw new Error("issue:read should not be evaluated for company-scope readers");
      }
      return {
        allowed: true,
        action: input.action,
        reason: "allow_test_default",
        explanation: "Allowed by test default.",
      };
    });

    const app = await createApp(boardActor());
    const res = await request(app).get(`/api/companies/${companyId}/issues`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: issueId })]);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "company_scope:read",
      resource: { type: "company", companyId },
    }));
    expect(mockAccessService.decide).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "issue:read",
    }));
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
      "low-trust promotion",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/low-trust/promotions`).send({
          sourceArtifactKind: "comment",
          sourceArtifactId: recoveryActionId,
          title: "Promoted artifact",
          summary: "Sanitized output",
        }),
    ],
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
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
    expect(mockStorageService.deleteObject).not.toHaveBeenCalled();
  });

  it("rejects the checked-out owner without a run id on attachment upload (401)", async () => {
    // Regression: an agent-authenticated client (e.g. the CLI's attachment:upload)
    // that fails to send X-Paperclip-Run-Id must be rejected — mutating your own
    // in-progress checkout requires proving run ownership.
    const app = await createApp({
      type: "agent",
      agentId: ownerAgentId,
      companyId,
      source: "agent_key",
      // intentionally no runId
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
      .attach("file", Buffer.from("report"), { filename: "report.html", contentType: "text/html" });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error).toBe("Agent run id required");
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
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

  it("stores the authenticated agent run id when creating work products", async () => {
    const app = await createApp(ownerActor());

    await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
    }).expect(201);

    expect(mockWorkProductService.createForIssue).toHaveBeenCalledWith(
      issueId,
      companyId,
      expect.objectContaining({ createdByRunId: ownerRunId }),
    );
  });

  it("rejects agent-created work products with a forged run id", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId must match the authenticated agent run");
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
  });

  it("rejects work product updates with a forged agent run id", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app).patch("/api/work-products/product-1").send({
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId must match the authenticated agent run");
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
  });

  it("rejects board-created work products with a foreign-company run id", async () => {
    const app = await createApp(
      boardActor(),
      createRunContextDb({}, [{
        id: "66666666-6666-4666-8666-666666666666",
        companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        agentCompanyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contextSnapshot: {},
      }]),
    );

    const res = await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId is not valid for this company");
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
  });

  it.each([
    [
      "work product create",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/work-products`).send({
          type: "artifact",
          provider: "test",
          title: "Artifact",
        }),
    ],
    ["work product update", (app: express.Express) => request(app).patch("/api/work-products/product-1").send({ title: "Blocked" })],
    ["work product delete", (app: express.Express) => request(app).delete("/api/work-products/product-1")],
    [
      "low-trust promotion",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/low-trust/promotions`).send({
          sourceArtifactKind: "comment",
          sourceArtifactId: recoveryActionId,
          title: "Promoted artifact",
          summary: "Sanitized output",
        }),
    ],
    [
      "attachment upload",
      (app: express.Express) =>
        request(app)
          .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
          .attach("file", Buffer.from("report"), { filename: "report.txt", contentType: "text/plain" }),
    ],
    ["attachment delete", (app: express.Express) => request(app).delete("/api/attachments/attachment-1")],
  ])("blocks cheap status-only recovery runs from %s", async (_name, sendRequest) => {
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      }),
    );

    const res = await sendRequest(app);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot update issue documents");
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, ownerAgentId, ownerRunId);
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
    expect(mockWorkProductService.remove).not.toHaveBeenCalled();
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
    expect(mockStorageService.deleteObject).not.toHaveBeenCalled();
    expect(mockIssueService.removeAttachment).not.toHaveBeenCalled();
  });

  it.each([
    [
      "issue create",
      (app: express.Express) =>
        request(app).post(`/api/companies/${companyId}/issues`).send({
          title: "Downstream source work",
          assigneeAdapterOverrides: { modelProfile: "cheap" },
        }),
    ],
    [
      "child issue create",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/children`).send({
          title: "Downstream child source work",
          assigneeAdapterOverrides: { modelProfile: "cheap" },
        }),
    ],
    [
      "issue update",
      (app: express.Express) =>
        request(app).patch(`/api/issues/${issueId}`).send({
          assigneeAdapterOverrides: { modelProfile: "cheap" },
        }),
    ],
  ])("blocks cheap status-only recovery runs from propagating cheap profile through %s", async (_name, sendRequest) => {
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      }),
    );

    const res = await sendRequest(app);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("cannot assign downstream issue work to the cheap model profile");
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("defaults agent-created root follow-up issues to inherit the current run workspace", async () => {
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        issueId,
        executionWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Follow-up in same worktree",
        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Follow-up in same worktree",
        inheritExecutionWorkspaceFromIssueId: issueId,
      }),
    );
  });

  it("preserves explicit workspace choices on agent-created root issues", async () => {
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        issueId,
        executionWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );

    const explicitExecutionWorkspaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Explicit different workspace",
        executionWorkspaceId: explicitExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Explicit different workspace",
        executionWorkspaceId: explicitExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      }),
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.not.objectContaining({
        inheritExecutionWorkspaceFromIssueId: issueId,
      }),
    );
  });

  it("allows board users to set explicit cheap issue assignee profile overrides", async () => {
    const app = await createApp(boardActor());

    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAdapterOverrides: { modelProfile: "cheap" } })
      .expect(200);

    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({
        assigneeAdapterOverrides: { modelProfile: "cheap" },
      }),
    );
  });

  it("preserves committed issue updates, comments, documents, and work product writes when recovery revalidation fails", async () => {
    const app = await createApp(ownerActor());

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Updated after commit" })
      .expect(200);

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "progress update" })
      .expect(201);

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# updated" })
      .expect(200);

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .patch("/api/work-products/product-1")
      .send({ title: "Updated product" })
      .expect(200);

    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ title: "Updated after commit" }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "progress update",
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalled();
    expect(mockWorkProductService.update).toHaveBeenCalledWith("product-1", { title: "Updated product" });
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
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:mutate" || input.action === "tasks:manage_active_checkouts",
      action: input.action,
      reason:
        input.action === "issue:mutate" || input.action === "tasks:manage_active_checkouts"
          ? "allow_explicit_grant"
          : "deny_missing_grant",
      explanation:
        input.action === "tasks:manage_active_checkouts"
          ? "Allowed by checkout management grant."
          : input.action === "issue:mutate"
            ? "Allowed by test boundary default."
            : "Missing permission.",
    }));

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

  it.each([
    {
      name: "board-assigned issue",
      issue: makeIssue({
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "board-user",
      }),
      interactions: [],
    },
    {
      name: "in_review issue with pending interaction",
      issue: makeIssue({
        status: "in_review",
        assigneeAgentId: ownerAgentId,
      }),
      interactions: [{ id: "interaction-1", status: "pending", kind: "request_confirmation" }],
    },
    {
      name: "awaiting-board labeled issue",
      issue: makeIssue({
        status: "todo",
        assigneeAgentId: ownerAgentId,
        labels: [{ id: "label-1", name: "awaiting-board" }],
      }),
      interactions: [],
    },
  ])("rejects agent auto-correction writes on protected triage state: $name", async ({ issue, interactions }) => {
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue(interactions as any);

    const app = await createApp(ownerActor());
    const patchRes = await request(app).patch(`/api/issues/${issueId}`).send({ status: "todo", assigneeAgentId: null });
    const commentRes = await request(app).post(`/api/issues/${issueId}/comments`).send({
      body: "Routing correction: reassigned to executor.",
    });

    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(403);
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects peer-agent status updates that would clear a recovery action they do not own", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
    );
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    });

    const res = await request(await createApp(peerActor())).patch(`/api/issues/${issueId}`).send({ status: "todo" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate board-owned or board-hold issues");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects peer-agent recovery resolution on a board-owned source issue", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
    );
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    });

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      .send({
        actionId: recoveryActionId,
        outcome: "restored",
        sourceIssueStatus: "done",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot resolve another owner's recovery action");
    expect(mockIssueRecoveryActionService.resolveActiveForIssue).not.toHaveBeenCalled();
  });

  it("allows the named recovery owner to resolve a board-owned source issue", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
      ...patch,
    }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    });

    const res = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      .send({
        actionId: recoveryActionId,
        outcome: "restored",
        sourceIssueStatus: "done",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockIssueRecoveryActionService.resolveActiveForIssue).toHaveBeenCalled();
  });

  it("wakes the assigned agent when recovery resolution restores a source issue to todo", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }),
      ...patch,
    }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    });

    const res = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      .send({
        actionId: recoveryActionId,
        outcome: "restored",
        sourceIssueStatus: "todo",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ownerAgentId,
      expect.objectContaining({
        reason: "issue_recovery_action_restored",
        payload: expect.objectContaining({
          issueId,
          recoveryActionId,
          mutation: "recovery_action_resolution",
        }),
      }),
    );
  });

  it("uses the authorization decision path for assignment changes", async () => {
    const decide = vi.fn(async () => ({
      allowed: false,
      action: "tasks:assign",
      reason: "deny_policy_restricted",
      explanation: "Target agent requires approval before task assignment.",
    }));
    decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:mutate",
      action: input.action,
      reason: input.action === "issue:mutate" ? "allow_self" : "deny_policy_restricted",
      explanation:
        input.action === "issue:mutate"
          ? "Allowed because the actor owns the assigned issue."
          : "Target agent requires approval before task assignment.",
    }));
    (mockAccessService as any).decide = decide;
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent(peerAgentId),
    });

    const app = await createApp(ownerActor());
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: peerAgentId });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("requires approval");
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "tasks:assign",
      resource: expect.objectContaining({
        type: "issue",
        companyId,
        issueId,
        assigneeAgentId: peerAgentId,
      }),
    }));
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});

describe("issue markers endpoint (cross-assignee dedup write path)", () => {
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
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockIssueService.addComment.mockResolvedValue({
      id: "cc111111-1111-4111-8111-111111111111",
      body: "[discord-notified:int-123:2026-05-27T00:00:00Z]",
      authorType: "agent",
      authorAgentId: peerAgentId,
      createdAt: new Date().toISOString(),
      presentation: null,
      metadata: null,
    });
  });

  it("allows a peer agent to write a marker to a cross-assignee issue (bypasses ownership check)", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "in_review", assigneeAgentId: ownerAgentId }),
    );

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/markers`)
      .send({ kind: "discord-notified", body: "[discord-notified:int-123:2026-05-27T00:00:00Z]" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.kind).toBe("discord-notified");
    expect(res.body.comment).toBeDefined();
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "[discord-notified:int-123:2026-05-27T00:00:00Z]",
      expect.objectContaining({ agentId: peerAgentId }),
      expect.objectContaining({ presentation: null }),
    );
  });

  it("does not fire a wake event when a marker is written", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "in_review", assigneeAgentId: ownerAgentId }),
    );

    await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/markers`)
      .send({ kind: "discord-notified", body: "[discord-notified:int-123:2026-05-27T00:00:00Z]" });

    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects board actors from writing markers", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "in_review", assigneeAgentId: ownerAgentId }),
    );

    const res = await request(await createApp(boardActor()))
      .post(`/api/issues/${issueId}/markers`)
      .send({ kind: "discord-notified", body: "[discord-notified:int-123:2026-05-27T00:00:00Z]" });

    expect(res.status).toBe(403);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects unknown marker kinds", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "in_review", assigneeAgentId: ownerAgentId }),
    );

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/markers`)
      .send({ kind: "arbitrary-injection", body: "[discord-notified:int-123:2026-05-27T00:00:00Z]" });

    expect(res.status).toBe(400);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects body exceeding 500 characters", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "in_review", assigneeAgentId: ownerAgentId }),
    );

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/markers`)
      .send({ kind: "discord-notified", body: "x".repeat(501) });

    expect(res.status).toBe(400);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("returns 404 when the target issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/markers`)
      .send({ kind: "discord-notified", body: "[discord-notified:int-999:2026-05-27T00:00:00Z]" });

    expect(res.status).toBe(404);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });
});
