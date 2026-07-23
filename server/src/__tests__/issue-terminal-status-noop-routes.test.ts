import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "company-1";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  list: vi.fn(),
  listDependencyReadiness: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({ insert: mockTxInsert }));
const mockDb = vi.hoisted(() => ({
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({
    vote: null,
    consentEnabledNow: false,
    sharingEnabled: false,
  })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => [COMPANY_ID]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: COMPANY_ID, attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  // additional services agentRoutes touches at construction time
  approvalService: () => ({}),
  budgetService: () => ({}),
  environmentService: () => ({ getById: vi.fn() }),
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(),
    resolveAdapterConfigForRuntime: vi.fn(),
  }),
  workspaceOperationService: () => ({}),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveRequestedSkillKeys: vi.fn(),
  }),
  agentInstructionsService: () => ({ materializeManagedBundle: vi.fn() }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
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
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor =
      actor ?? {
        type: "board",
        userId: "local-board",
        companyIds: [COMPANY_ID],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(status: "todo" | "in_progress" | "blocked" | "done" | "cancelled") {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status,
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-PF2",
    title: "Terminal status guard",
    executionState: null,
    executionPolicy: null,
  };
}

function agentActor(agentId = AGENT_ID, runId: string | null = "run-pf2") {
  return {
    type: "agent",
    agentId,
    companyId: COMPANY_ID,
    source: "agent_key",
    runId,
  };
}

describe.sequential("PF-2 issue terminal-status no-op guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockLogActivity.mockReset();

    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: ISSUE_ID,
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-pf2",
      issueId: ISSUE_ID,
      companyId: COMPANY_ID,
      body: "",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: AGENT_ID,
      authorUserId: null,
    });
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns existing issue without invoking update when an agent re-PATCHes status=done on a done issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));

    const res = await request(await installActor(createApp(), agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", comment: "All done!" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ISSUE_ID, status: "done" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.terminal_status_noop",
        entityId: ISSUE_ID,
        details: expect.objectContaining({
          currentStatus: "done",
          attemptedStatus: "done",
          hadComment: true,
        }),
      }),
    );
  });

  it("returns existing issue without invoking update when an agent re-PATCHes status=cancelled on a cancelled issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("cancelled"));

    const res = await request(await installActor(createApp(), agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.terminal_status_noop",
        details: expect.objectContaining({
          currentStatus: "cancelled",
          attemptedStatus: "cancelled",
          hadComment: false,
        }),
      }),
    );
  });

  it("does not no-op when the actor is a user (humans can re-mark terminal issues)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.terminal_status_noop" }),
    );
  });

  it("does not no-op when the agent's request includes an explicit reopen flag", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", reopen: true });

    // The terminal-status no-op guard should NOT fire because reopen is explicit.
    // (Subsequent business logic may still reject the request for other reasons,
    // but the no-op log entry must not be written.)
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.terminal_status_noop" }),
    );
  });

  it("does not no-op when the agent's PATCH targets a non-terminal status (legitimate reopen attempt)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "todo" });

    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.terminal_status_noop" }),
    );
  });

  it("does not no-op when the issue is not yet terminal", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("in_progress"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.terminal_status_noop" }),
    );
  });
});

// Note on PF-1 (terminal-status exclusion from actionable selection):
// The /agents/me/inbox-lite endpoint already filters status to
// "todo,in_progress,blocked" at server/src/routes/agents.ts (the call site
// for issueService.list). That literal filter is verified via:
//   1. Manual code inspection (see PR description)
//   2. The route-level test in wip/ui-cli-pending-changes:
//      server/src/__tests__/agent-inbox-lite.test.ts
// This file therefore focuses on PF-2 (PATCH no-op) which is where the new
// code change lives. Defense-in-depth: even if a stale wakeup payload causes
// an agent to act on a terminal issue, the PATCH guard above prevents the
// observed bug (re-marking + duplicate completion comment).
