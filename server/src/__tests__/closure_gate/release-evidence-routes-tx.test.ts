import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
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
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  list: vi.fn(async () => []),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({ insert: mockTxInsert }));
const mockDb = vi.hoisted(() => ({
  select: vi.fn(() => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) })),
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));

const mockValidate = vi.hoisted(() => vi.fn());
const mockRecordAudit = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../../services/feedback.js", () => ({
  feedbackService: () => ({
    listIssueVotesForUser: async () => [],
    saveIssueVote: async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false }),
  }),
}));

vi.mock("../../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    get: async () => ({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    }),
    listCompanyIds: async () => [COMPANY_ID],
  }),
}));

vi.mock("../../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../../services/routines.js", () => ({
  routineService: () => ({ syncRunStatusForIssue: async () => undefined }),
}));

vi.mock("../../services/index.js", () => ({
  companyService: () => ({
    getById: async () => ({ id: COMPANY_ID, attachmentMaxBytes: 10 * 1024 * 1024 }),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: async () => [],
    saveIssueVote: async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false }),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: async () => ({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    }),
    listCompanyIds: async () => [COMPANY_ID],
  }),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({ getActiveForIssue: async () => null }),
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
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: async () => [],
    expireStaleRequestConfirmationsForIssueDocument: async () => [],
  }),
  issueTreeControlService: () => ({ getActivePauseHoldGate: async () => null }),
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: async () => undefined }),
  workProductService: () => ({}),
}));

vi.mock("../../services/release-evidence/validator.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    validateReleaseEvidenceForIssueClose: mockValidate,
    recordReleaseEvidenceAudit: mockRecordAudit,
  };
});

function createApp() {
  return express().use(express.json());
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../../routes/issues.js"),
    import("../../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
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

function makeIssue() {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "in_progress",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "CLO-672",
    title: "Closure-gate tx test",
    parentId: null,
    executionWorkspaceId: null,
    releaseEvidence: null,
    createdAt: new Date("2026-05-13T12:00:00.000Z"),
  };
}

const ACCEPTED_EVIDENCE = {
  kind: "merge_commit",
  repo: "https://github.com/paperclipai/paperclip",
  ref: "master",
  sha: "abcdef1234567",
} as const;

describe("closure-gate accept tx — release-evidence audit atomicity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.update.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: ISSUE_ID,
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockTxInsertValues.mockReset();
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockReset();
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
    );
    mockValidate.mockReset();
    mockRecordAudit.mockReset();
  });

  it("rolls back the issue update when the release-evidence audit insert throws", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));

    mockValidate.mockResolvedValue({
      ok: true,
      validated: ACCEPTED_EVIDENCE,
      githubApiCalled: true,
      degraded: false,
      detail: { codeTouchingReason: "engineer_role_default_code_touching" },
      codeTouching: true,
      codeTouchingReason: "engineer_role_default_code_touching",
    });

    const auditError = new Error("simulated audit-log write failure");
    mockRecordAudit.mockRejectedValue(auditError);

    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", releaseEvidence: ACCEPTED_EVIDENCE });

    // The audit failure must surface to the caller, not silently swallow a
    // partially-applied close.
    expect([422, 500]).toContain(res.status);
    expect(res.status).not.toBe(200);

    // The accepted-audit and the issue update must run inside the same
    // db.transaction call, so a thrown audit cannot leave the issue in `done`.
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);

    // The audit recorder must receive the transaction handle, not the bare db.
    const auditCall = mockRecordAudit.mock.calls[0];
    expect(auditCall?.[0]).toBe(mockTx);
    expect(auditCall?.[1]).toMatchObject({
      issueId: ISSUE_ID,
      evidence: expect.objectContaining({ kind: "merge_commit" }),
      outcome: expect.objectContaining({ ok: true }),
    });
  });

  it("inserts the audit row inside the closure-gate transaction on accept", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));

    mockValidate.mockResolvedValue({
      ok: true,
      validated: ACCEPTED_EVIDENCE,
      githubApiCalled: true,
      degraded: false,
      detail: { codeTouchingReason: "engineer_role_default_code_touching" },
      codeTouching: true,
      codeTouchingReason: "engineer_role_default_code_touching",
    });
    mockRecordAudit.mockResolvedValue(undefined);

    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", releaseEvidence: ACCEPTED_EVIDENCE });

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0]?.[0]).toBe(mockTx);
  });
});
