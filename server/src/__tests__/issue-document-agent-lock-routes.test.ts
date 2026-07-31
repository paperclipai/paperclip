import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const otherAgentId = "44444444-4444-4444-8444-444444444444";

const mockIssueService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentByKey: vi.fn(),
  lockIssueDocument: vi.fn(),
  unlockIssueDocument: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({ decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    })) }),
    agentService: () => ({ getById: vi.fn(), list: vi.fn(async () => []) }),
    companySkillService: () => ({ completeTestRunForIssue: vi.fn(async () => null) }),
    companyService: () => ({ getById: vi.fn(async () => ({ id: companyId, attachmentMaxBytes: 10_000_000 })) }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: vi.fn(async () => []) }),
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => ({ reportRunActivity: vi.fn(async () => undefined), wakeup: vi.fn(async () => undefined) }),
    instanceSettingsService: () => ({ get: vi.fn(async () => ({ id: "settings", general: {} })), listCompanyIds: vi.fn(async () => [companyId]) }),
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({ getActiveForIssue: vi.fn(async () => null), listActiveForIssues: vi.fn(async () => new Map()) }),
    issueReferenceService: () => ({
      deleteDocumentSource: vi.fn(async () => undefined),
      diffIssueReferenceSummary: () => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
      syncComment: vi.fn(async () => undefined), syncDocument: vi.fn(async () => undefined), syncIssue: vi.fn(async () => undefined),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({ expireRequestConfirmationsSupersededByComment: vi.fn(async () => []), expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []) }),
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
  vi.doMock("../services/access.js", () => ({ accessService: () => ({ decide: vi.fn(async () => ({ allowed: true, reason: "allow_test", explanation: "Allowed by test mock." })) }) }));
  vi.doMock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
  vi.doMock("@paperclipai/shared/telemetry", () => ({ trackAgentTaskCompleted: vi.fn(), trackErrorHandlerCrash: vi.fn() }));
  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: vi.fn(() => ({ track: vi.fn() })) }));
}

const revisionedDocument = {
  id: "55555555-5555-4555-8555-555555555555",
  companyId,
  issueId,
  key: "plan-eng-review",
  title: "Engineering plan",
  latestRevisionId: "66666666-6666-4666-8666-666666666666",
  lockedAt: null,
  lockedByAgentId: null,
  lockedByUserId: null,
};

function issue(overrides: Record<string, unknown> = {}) {
  return { id: issueId, companyId, status: "in_progress", assigneeAgentId: ownerAgentId, assigneeUserId: null, projectId: null, parentId: null, executionState: null, ...overrides };
}

async function appFor(actor: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const agent = (agentId: string) => ({ type: "agent", agentId, companyId, source: "agent_key", runId: "77777777-7777-4777-8777-777777777777" });
const board = { type: "board", userId: "board-user", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false };

describe("agent-finalizable issue document routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../telemetry.js");
    registerMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(issue());
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue(revisionedDocument);
    mockDocumentService.lockIssueDocument.mockResolvedValue({ changed: true, document: { ...revisionedDocument, lockedAt: new Date(), lockedByAgentId: ownerAgentId } });
    mockDocumentService.unlockIssueDocument.mockResolvedValue({ changed: true, document: revisionedDocument });
  });

  it("allows the assigned agent to lock plan-eng-review", async () => {
    const res = await request(await appFor(agent(ownerAgentId))).post(`/api/issues/${issueId}/documents/plan-eng-review/lock`);
    expect(res.status).toBe(200);
    expect(mockDocumentService.lockIssueDocument).toHaveBeenCalled();
  });

  it("rejects a non-assignee agent", async () => {
    const res = await request(await appFor(agent(otherAgentId))).post(`/api/issues/${issueId}/documents/plan-eng-review/lock`);
    expect(res.status).toBe(403);
  });

  it("rejects an assignee locking a non-allowlisted key", async () => {
    const res = await request(await appFor(agent(ownerAgentId))).post(`/api/issues/${issueId}/documents/plan/lock`);
    expect(res.status).toBe(403);
  });

  it("requires revision content for agent finalization", async () => {
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({ ...revisionedDocument, latestRevisionId: null });
    const res = await request(await appFor(agent(ownerAgentId))).post(`/api/issues/${issueId}/documents/plan-eng-review/lock`);
    expect(res.status).toBe(422);
  });

  it("preserves board lock and unlock behavior", async () => {
    expect((await request(await appFor(board)).post(`/api/issues/${issueId}/documents/plan/lock`)).status).toBe(200);
    expect((await request(await appFor(board)).post(`/api/issues/${issueId}/documents/plan/unlock`)).status).toBe(200);
  });

  it("allows an agent to unlock only its own finalized lock", async () => {
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({ ...revisionedDocument, lockedAt: new Date(), lockedByAgentId: ownerAgentId, lockedByUserId: null });
    expect((await request(await appFor(agent(ownerAgentId))).post(`/api/issues/${issueId}/documents/plan-eng-review/unlock`)).status).toBe(200);
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({ ...revisionedDocument, lockedAt: new Date(), lockedByAgentId: null, lockedByUserId: "board-user" });
    expect((await request(await appFor(agent(ownerAgentId))).post(`/api/issues/${issueId}/documents/plan-eng-review/unlock`)).status).toBe(403);
  });

  it("keeps the review transition reachable after agent finalization", async () => {
    const res = await request(await appFor(agent(ownerAgentId))).post(`/api/issues/${issueId}/documents/plan-eng-review/lock`);
    expect(res.status).toBe(200);
    expect(mockDocumentService.lockIssueDocument).toHaveBeenCalledWith(expect.objectContaining({ key: "plan-eng-review", lockedByAgentId: ownerAgentId }));
  });
});
