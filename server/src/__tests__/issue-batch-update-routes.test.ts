import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_ID = "company-1";
const ISSUE_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ISSUE_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ISSUE_ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: COMPANY_ID, attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    documentService: () => ({}),
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
      listCompanyIds: vi.fn(async () => [COMPANY_ID]),
    }),
    issueApprovalService: () => ({}),
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
    workProductService: () => ({}),
  }));
}

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId: COMPANY_ID,
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: `PAP-${id.slice(0, 3)}`,
    title: `Issue ${id}`,
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("POST /companies/:companyId/issues/batch", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
  });

  it("updates every requested issue and returns success entries for each", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) => makeIssue(id));
    mockIssueService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(id),
      status: patch.status ?? "todo",
    }));

    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/issues/batch`)
      .send({
        issueIds: [ISSUE_ID_A, ISSUE_ID_B],
        update: { status: "in_progress" },
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results.every((r: any) => r.success)).toBe(true);
    expect(res.body.results.map((r: any) => r.id)).toEqual([ISSUE_ID_A, ISSUE_ID_B]);
    expect(mockIssueService.update).toHaveBeenCalledTimes(2);
  });

  it("returns a per-issue failure entry when an issue is not found and continues with the rest", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === ISSUE_ID_B) return null;
      return makeIssue(id);
    });
    mockIssueService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(id),
      status: patch.status ?? "todo",
    }));

    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/issues/batch`)
      .send({
        issueIds: [ISSUE_ID_A, ISSUE_ID_B, ISSUE_ID_C],
        update: { status: "done" },
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);

    const byId = new Map<string, { success: boolean; error?: string }>(
      res.body.results.map((r: any) => [r.id, r]),
    );
    expect(byId.get(ISSUE_ID_A)?.success).toBe(true);
    expect(byId.get(ISSUE_ID_B)?.success).toBe(false);
    expect(byId.get(ISSUE_ID_B)?.error).toBe("Issue not found");
    expect(byId.get(ISSUE_ID_C)?.success).toBe(true);
    expect(mockIssueService.update).toHaveBeenCalledTimes(2);
  });

  it("rejects an issue from a different company without leaking it as a success", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === ISSUE_ID_B) return makeIssue(id, { companyId: "other-company" });
      return makeIssue(id);
    });
    mockIssueService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(id),
      status: patch.status ?? "todo",
    }));

    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/issues/batch`)
      .send({
        issueIds: [ISSUE_ID_A, ISSUE_ID_B],
        update: { priority: "high" },
      });

    expect(res.status).toBe(200);
    const byId = new Map<string, { success: boolean; error?: string }>(
      res.body.results.map((r: any) => [r.id, r]),
    );
    expect(byId.get(ISSUE_ID_B)?.success).toBe(false);
    expect(byId.get(ISSUE_ID_B)?.error).toBe("Issue not found");
  });

  it("captures thrown errors from the service as a per-issue failure entry", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) => makeIssue(id));
    mockIssueService.update.mockImplementation(async (id: string) => {
      if (id === ISSUE_ID_A) throw new Error("validation failed");
      return makeIssue(id);
    });

    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/issues/batch`)
      .send({
        issueIds: [ISSUE_ID_A, ISSUE_ID_B],
        update: { status: "in_review" },
      });

    expect(res.status).toBe(200);
    const byId = new Map<string, { success: boolean; error?: string }>(
      res.body.results.map((r: any) => [r.id, r]),
    );
    expect(byId.get(ISSUE_ID_A)).toEqual({ id: ISSUE_ID_A, success: false, error: "validation failed" });
    expect(byId.get(ISSUE_ID_B)?.success).toBe(true);
  });

  it("rejects requests with an empty issueIds array via schema validation", async () => {
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/issues/batch`)
      .send({
        issueIds: [],
        update: { status: "todo" },
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects requests with no update fields via schema validation", async () => {
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/issues/batch`)
      .send({
        issueIds: [ISSUE_ID_A],
        update: {},
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
