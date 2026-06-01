import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const selfAgentId = "33333333-3333-4333-8333-333333333333";
const otherAgentId = "44444444-4444-4444-8444-444444444444";
const callingRunId = "55555555-5555-4555-8555-555555555555";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  createChild: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getByIdempotencyKey: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async (id: string) => {
    if (id === selfAgentId) {
      return { id: selfAgentId, name: "TestAgent", companyId: "company-1" };
    }
    return null;
  }),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => mockAgentService,
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
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
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

async function createApp(opts: { actorAgentId?: string | null; actorRunId?: string | null } = {}) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.actorAgentId) {
      (req as any).actor = {
        type: "agent",
        agentId: opts.actorAgentId,
        runId: opts.actorRunId ?? null,
        companyId: "company-1",
        companyIds: ["company-1"],
        source: "agent_jwt",
        isInstanceAdmin: false,
      };
    } else {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
    }
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(input: {
  id: string;
  title: string;
  status?: string;
  assigneeAgentId?: string | null;
  idempotencyKey?: string | null;
}) {
  return {
    id: input.id,
    companyId: "company-1",
    identifier: "SPC-6909-test",
    title: input.title,
    description: null,
    status: input.status ?? "todo",
    priority: "medium",
    parentId: null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    assigneeUserId: null,
    createdByAgentId: input.assigneeAgentId ?? null,
    createdByUserId: null,
    executionWorkspaceId: null,
    idempotencyKey: input.idempotencyKey ?? null,
    labels: [],
    labelIds: [],
  };
}

describe("SPC-6909 — issue create self-checkout + idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) =>
      makeIssue({
        id: "issue-new",
        title: String(data.title),
        status: String(data.status),
        assigneeAgentId: data.assigneeAgentId as string | null | undefined,
        idempotencyKey: data.idempotencyKey as string | null | undefined,
      }));
    mockIssueService.getByIdempotencyKey.mockResolvedValue(null);
  });

  describe("self-checkout (ask #1)", () => {
    it("agent posting in_progress + assigneeAgentId=self gets selfCheckoutRunId stamped and no wake fires", async () => {
      const res = await request(await createApp({ actorAgentId: selfAgentId, actorRunId: callingRunId }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "Self-assigned in_progress",
          assigneeAgentId: selfAgentId,
          status: "in_progress",
        });

      expect(res.status).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          title: "Self-assigned in_progress",
          assigneeAgentId: selfAgentId,
          status: "in_progress",
          selfCheckoutRunId: callingRunId,
          selfCheckoutAgentNameKey: "testagent",
        }),
      );
      expect(mockWakeup).not.toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.created",
          details: expect.objectContaining({ selfCheckoutRunId: callingRunId }),
        }),
      );
    });

    it("agent posting in_progress + assigneeAgentId=ANOTHER_AGENT does NOT self-checkout and DOES wake", async () => {
      const res = await request(await createApp({ actorAgentId: selfAgentId, actorRunId: callingRunId }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "Other-assigned in_progress",
          assigneeAgentId: otherAgentId,
          status: "in_progress",
        });

      expect(res.status).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          assigneeAgentId: otherAgentId,
          selfCheckoutRunId: null,
          selfCheckoutAgentNameKey: null,
        }),
      );
      expect(mockWakeup).toHaveBeenCalledWith(
        otherAgentId,
        expect.objectContaining({ reason: "issue_assigned" }),
      );
    });

    it("agent without run id does NOT self-checkout (defense in depth)", async () => {
      const res = await request(await createApp({ actorAgentId: selfAgentId, actorRunId: null }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "No run id",
          assigneeAgentId: selfAgentId,
          status: "in_progress",
        });

      expect(res.status).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ selfCheckoutRunId: null }),
      );
      expect(mockWakeup).toHaveBeenCalled();
    });

    it("agent posting todo (not in_progress) does NOT self-checkout — wake still fires", async () => {
      const res = await request(await createApp({ actorAgentId: selfAgentId, actorRunId: callingRunId }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "Self-assigned todo",
          assigneeAgentId: selfAgentId,
          status: "todo",
        });

      expect(res.status).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          status: "todo",
          selfCheckoutRunId: null,
        }),
      );
      expect(mockWakeup).toHaveBeenCalled();
    });
  });

  describe("idempotencyKey fast-path (ask #2)", () => {
    it("returns the prior issue (200) when idempotencyKey matches and skips create + wake + activity log", async () => {
      const existing = makeIssue({
        id: "issue-prior",
        title: "Prior umbrella",
        status: "in_progress",
        assigneeAgentId: selfAgentId,
        idempotencyKey: "umbrella:eu:2026-06-01",
      });
      mockIssueService.getByIdempotencyKey.mockResolvedValue(existing);

      const res = await request(await createApp({ actorAgentId: selfAgentId, actorRunId: callingRunId }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "Umbrella second call",
          assigneeAgentId: selfAgentId,
          status: "in_progress",
          idempotencyKey: "umbrella:eu:2026-06-01",
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({
        id: "issue-prior",
        idempotentReturn: true,
      }));
      expect(mockIssueService.getByIdempotencyKey).toHaveBeenCalledWith(
        "company-1",
        "umbrella:eu:2026-06-01",
      );
      expect(mockIssueService.create).not.toHaveBeenCalled();
      expect(mockWakeup).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("creates as normal when idempotencyKey has not been seen yet", async () => {
      mockIssueService.getByIdempotencyKey.mockResolvedValue(null);

      const res = await request(await createApp({ actorAgentId: selfAgentId, actorRunId: callingRunId }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "First call with idempotencyKey",
          assigneeAgentId: selfAgentId,
          status: "in_progress",
          idempotencyKey: "umbrella:na:2026-06-01",
        });

      expect(res.status).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          idempotencyKey: "umbrella:na:2026-06-01",
          selfCheckoutRunId: callingRunId,
        }),
      );
      // self-checkout suppresses the wake even when key is novel
      expect(mockWakeup).not.toHaveBeenCalled();
    });
  });
});
