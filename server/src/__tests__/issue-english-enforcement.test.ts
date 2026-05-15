import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isTextEnglish } from "../services/issue-english-enforcement.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  assertCheckoutOwner: vi.fn(),
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

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
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
}));

const mockTrackAgentTaskCompleted = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: mockTrackAgentTaskCompleted,
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueReferenceService: () => mockIssueReferenceService,
  issueRecoveryActionService: () => () => ({ listActiveForIssues: () => Promise.resolve(new Map()) }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "English enforcement test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
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

describe("isTextEnglish", () => {
  it("returns true for empty string", () => {
    expect(isTextEnglish("")).toBe(true);
  });

  it("returns true for short English text", () => {
    expect(isTextEnglish("OK")).toBe(true);
  });

  it("returns true for plain English text", () => {
    expect(isTextEnglish("Fixed the bug and deployed to production")).toBe(true);
  });

  it("returns true for English text with accented characters", () => {
    expect(isTextEnglish("Fixed the café variable name and résumé upload")).toBe(true);
  });

  it("returns true for English with numbers and punctuation", () => {
    expect(isTextEnglish("Issue #42: Fixed null pointer in the render loop.")).toBe(true);
  });

  it("returns true for mostly English with a few foreign characters", () => {
    expect(isTextEnglish("Fixed the bug. 问题已经解决。Please deploy.")).toBe(true);
  });

  it("returns true for English text containing code-like content", () => {
    expect(isTextEnglish("Added the render function with proper type safety")).toBe(true);
  });

  it("returns false for Chinese text", () => {
    expect(isTextEnglish("修复了生产环境中的空指针错误")).toBe(false);
  });

  it("returns false for Arabic text", () => {
    expect(isTextEnglish("تم إصلاح الخطأ في بيئة الإنتاج")).toBe(false);
  });

  it("returns false for Russian text", () => {
    expect(isTextEnglish("Исправлена ошибка в production среде")).toBe(false);
  });

  it("returns false for Japanese text", () => {
    expect(isTextEnglish("本番環境のバグを修正しました")).toBe(false);
  });

  it("returns false for Korean text", () => {
    expect(isTextEnglish("프로덕션 환경의 버그를 수정했습니다")).toBe(false);
  });

  it("returns false for mixed CJK with mostly non-English", () => {
    expect(isTextEnglish("修复了 bug 在 production 环境中")).toBe(false);
  });

  it("returns false for predominantly non-English text with some English", () => {
    expect(isTextEnglish("This is test. 修复了生产环境问题，需要部署到所有服务器上。")).toBe(false);
  });
});

describe("issue english enforcement routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "test comment",
    });
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue(null);
  });

  describe("PATCH /issues/:id", () => {
    it("rejects non-English comment with 400", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue());

      const app = await createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
      });

      const res = await request(app)
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({ comment: "修复了生产环境中的空指针错误" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("English");
    }, 15000);

    it("rejects non-English comment with status update", async () => {
      const existing = makeIssue({ status: "in_progress", assigneeAgentId: "agent-1" });
      mockIssueService.getById.mockResolvedValue(existing);

      const app = await createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
      });

      const res = await request(app)
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({ status: "done", comment: "Исправлена ошибка в production среде" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("English");
    }, 15000);

    it("allows English comment to pass through", async () => {
      const existing = makeIssue();
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.update.mockResolvedValue(makeIssue());

      const app = await createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
      });

      const res = await request(app)
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({ comment: "Fixed the bug and deployed to production" });

      expect(res.status).toBe(200);
    }, 15000);

    it("allows comment-free status update (no comment field)", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue());
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...makeIssue(),
        ...patch,
      }));

      const app = await createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
      });

      const res = await request(app)
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({ status: "done" });

      expect(res.status).toBe(200);
    }, 15000);
  });

  describe("POST /issues/:id/comments", () => {
    it("rejects non-English body with 400", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue());

      const app = await createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
      });

      const res = await request(app)
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({ body: "本番環境のバグを修正しました" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("English");
    }, 15000);

    it("allows English body to pass through", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue());

      const app = await createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
      });

      const res = await request(app)
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({ body: "Fixed the bug and deployed to production" });

      expect(res.status).toBe(201);
    }, 15000);
  });
});
