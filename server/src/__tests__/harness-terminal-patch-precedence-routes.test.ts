// Repro for MONAA-558. Verifies that when HARNESS_TERMINAL_PATCH_PRECEDENCE
// is enabled, a PATCH /api/issues body that combines `status=done` (or
// `status=cancelled`) with a `comment` no longer enqueues a comment-driven
// wake on the assignee, so the terminal status transition is not preempted by
// the same body's comment. With the flag off the route keeps its current
// behaviour and the wake reproduces the cascade trigger reported in MONAA-556.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
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

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
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
    listCompanyIds: vi.fn(async () => ["company-1"]),
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

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
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
      listCompanyIds: vi.fn(async () => ["company-1"]),
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
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-558",
    title: "MONAA-558 repro",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function setupCommonMocks() {
  mockIssueService.findMentionedAgents.mockResolvedValue([]);
  mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
  mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
  mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
}

function commentWakeCalls() {
  return mockHeartbeatService.wakeup.mock.calls.filter(([, opts]: any[]) => {
    return opts && (opts.reason === "issue_commented" || opts.reason === "issue_reopened_via_comment");
  });
}

describe("MONAA-558 harness terminal-PATCH precedence", { timeout: 30_000 }, () => {
  const originalFlag = process.env.HARNESS_TERMINAL_PATCH_PRECEDENCE;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    setupCommonMocks();
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.HARNESS_TERMINAL_PATCH_PRECEDENCE;
    } else {
      process.env.HARNESS_TERMINAL_PATCH_PRECEDENCE = originalFlag;
    }
  });

  it("flag=\"false\" (explicit opt-out, MONAA-674): PATCH status=done + comment still enqueues a comment wake on the assignee (cascade trigger restored)", async () => {
    process.env.HARNESS_TERMINAL_PATCH_PRECEDENCE = "false";

    const existing = makeIssue({ status: "in_progress" });
    const updated = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-558-off",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "Closing this out.",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "done", comment: "Closing this out." });

    expect(res.status).toBe(200);
    expect(commentWakeCalls()).toHaveLength(1);
    expect(commentWakeCalls()[0][0]).toBe(ASSIGNEE_AGENT_ID);
    expect(commentWakeCalls()[0][1].reason).toBe("issue_commented");
  });

  it("flag unset (default-on, MONAA-674): PATCH status=done + comment leaves the issue done with no comment-driven wake", async () => {
    delete process.env.HARNESS_TERMINAL_PATCH_PRECEDENCE;

    const existing = makeIssue({ status: "in_progress" });
    const updated = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-674-default",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "Closing this out.",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "done", comment: "Closing this out." });

    expect(res.status).toBe(200);
    expect(commentWakeCalls()).toHaveLength(0);
  });

  it("flag=true: PATCH status=done + comment leaves the issue done with no comment-driven wake", async () => {
    process.env.HARNESS_TERMINAL_PATCH_PRECEDENCE = "true";

    const existing = makeIssue({ status: "in_progress" });
    const updated = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-558-on",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "Closing this out.",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "done", comment: "Closing this out." });

    expect(res.status).toBe(200);
    expect(commentWakeCalls()).toHaveLength(0);
  });

  it("flag=true: PATCH status=cancelled + comment also suppresses the comment wake", async () => {
    process.env.HARNESS_TERMINAL_PATCH_PRECEDENCE = "true";

    const existing = makeIssue({ status: "in_progress" });
    const updated = makeIssue({ status: "cancelled" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-558-cancel",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "Cancelled, superseded by MONAA-560.",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "cancelled", comment: "Cancelled, superseded by MONAA-560." });

    expect(res.status).toBe(200);
    expect(commentWakeCalls()).toHaveLength(0);
  });

  it("flag=true: comment-only PATCH (no status transition) still wakes the assignee", async () => {
    process.env.HARNESS_TERMINAL_PATCH_PRECEDENCE = "true";

    const existing = makeIssue({ status: "in_progress" });
    const updated = { ...existing };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-558-no-status",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "please revise this",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ comment: "please revise this" });

    expect(res.status).toBe(200);
    expect(commentWakeCalls()).toHaveLength(1);
    expect(commentWakeCalls()[0][1].reason).toBe("issue_commented");
  });
});
