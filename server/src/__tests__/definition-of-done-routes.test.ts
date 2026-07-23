/**
 * Integration tests for HUM-183 (Paperclip mechanical DoD guards).
 *
 *   1. Pre-flight negative: PATCH /api/issues/:id setting assigneeAgentId on an
 *      issue whose description lacks `Acceptance:` returns 422.
 *   2. Post-flight negative: PATCH /api/issues/:id setting status=done when the
 *      latest assignee comment lacks `Proof:` returns 422.
 *   3. Happy path: full lifecycle (assign with Acceptance → Proof comment →
 *      status=done) succeeds with 200 at every step.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSIGNEE_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "company-1";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  getCurrentScheduledRetry: vi.fn(async () => null),
  getDependencyReadiness: vi.fn(async () => ({ unresolvedBlockerCount: 0 })),
  listComments: vi.fn(async () => []),
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

function buildServicesIndexMock() {
  return {
    companyService: () => ({
      getById: vi.fn(async () => ({
        id: COMPANY_ID,
        attachmentMaxBytes: 10 * 1024 * 1024,
      })),
    }),
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
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    documentService: () => ({}),
    documentAnnotationService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({
        vote: null,
        consentEnabledNow: false,
        sharingEnabled: false,
      })),
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
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  };
}

vi.mock("../services/index.js", () => buildServicesIndexMock());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => buildServicesIndexMock());
}

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>(
      "../middleware/index.js",
    ),
    vi.importActual<typeof import("../routes/issues.js")>(
      "../routes/issues.js",
    ),
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

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    createdByAgentId: null,
    identifier: "PAP-DOD",
    title: "DoD test",
    description: null as string | null,
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-26T00:00:00Z"),
    updatedAt: new Date("2026-05-26T00:00:00Z"),
    ...overrides,
  };
}

describe("HUM-183 — Definition of Done mechanical guards", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/definition-of-done.js");
    registerModuleMocks();
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_DOD_GUARD_ENFORCEMENT_START_AT;
    delete process.env.PAPERCLIP_DOD_GUARD_GRANDFATHER_DAYS;
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [],
      blocks: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(
      null,
    );
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      unresolvedBlockerCount: 0,
    });
    mockIssueService.listComments.mockResolvedValue([]);
  });

  it("Test 1 (pre-flight negative): PATCH assigning an agent without Acceptance in description returns 422", async () => {
    // Non-board-owned issue (assigneeUserId !== "local-board") so the
    // board-owned exemption does not apply.
    const existing = makeIssue({
      description:
        "We need this fixed by Friday. Some context but no structured acceptance.",
      assigneeUserId: null,
    });
    mockIssueService.getById.mockResolvedValue(existing);

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeAgentId: ASSIGNEE_AGENT_ID });

    expect(res.status).toBe(422);
    expect(String(res.body?.error ?? res.text)).toMatch(/Acceptance/);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("Test 2 (post-flight negative): PATCH status=done without a Proof comment by the assignee returns 422", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
      description: "**Acceptance:** the thing must do X.",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    // Latest comment is from a different agent or lacks Proof:
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "comment-x",
        body: "Looks fine to me",
        authorAgentId: ASSIGNEE_AGENT_ID,
        derivedAuthorAgentId: null,
      },
    ]);

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(String(res.body?.error ?? res.text)).toMatch(/Proof/);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("Test 3 (happy path): assign with Acceptance → Proof comment → status=done returns 200 at every step", async () => {
    const description =
      "## Acceptance:\n- The system MUST do the thing\n- The other thing too\n";

    // Step 1: assign with Acceptance present.
    const beforeAssign = makeIssue({ description });
    const afterAssign = makeIssue({
      description,
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
    });
    mockIssueService.getById.mockResolvedValue(beforeAssign);
    mockIssueService.update.mockResolvedValue(afterAssign);

    const assignRes = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeAgentId: ASSIGNEE_AGENT_ID });
    expect(assignRes.status).toBe(200);

    // Step 2: assignee posts a Proof comment via PATCH-with-comment.
    mockIssueService.getById.mockResolvedValue(afterAssign);
    mockIssueService.update.mockResolvedValue(afterAssign);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-proof",
      issueId: ISSUE_ID,
      companyId: COMPANY_ID,
      body: "Proof: tests pass, smoke pass.",
      authorAgentId: ASSIGNEE_AGENT_ID,
    });
    const commentRes = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ comment: "Proof: tests pass, smoke pass." });
    expect(commentRes.status).toBe(200);

    // Step 3: status=done with the Proof comment now the latest.
    const doneIssue = makeIssue({
      description,
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(doneIssue);
    mockIssueService.update.mockResolvedValue({
      ...doneIssue,
      status: "done",
    });
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "comment-proof",
        body: "Proof: tests pass, smoke pass.",
        authorAgentId: ASSIGNEE_AGENT_ID,
        derivedAuthorAgentId: null,
      },
    ]);
    const doneRes = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });
    expect(doneRes.status).toBe(200);
  });
});
