import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));
const mockListMissionControlCompletionDocuments = vi.hoisted(() => vi.fn());
const mockListAutonomousGoalLoopWatchdogPreview = vi.hoisted(() => vi.fn());
const mockIsValidAutonomousGoalLoopWatchdogCursor = vi.hoisted(() => vi.fn());
const mockListAutonomousGoalLoopWatchdogRecoveryPlanPreview = vi.hoisted(() => vi.fn());

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
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({ orderBy: mockDbSelectOrderBy })));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockApplyCommentDisposition = vi.hoisted(() => vi.fn());
const mockIssueDispositionService = vi.hoisted(() => ({
  applyCommentDisposition: mockApplyCommentDisposition,
}));
const mockExtractDispositionRowFromMetadata = vi.hoisted(() => vi.fn(() => null));
const mockIssueFinalDeliveryService = vi.hoisted(() => ({
  queueForCompletedIssue: vi.fn(async () => ({ status: "skipped", reason: "not_configured" })),
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

vi.mock("../services/mission-control-gates.js", () => ({
  listMissionControlCompletionDocuments: mockListMissionControlCompletionDocuments,
}));

vi.mock("../services/autonomous-loop-watchdog-preview.js", () => ({
  isValidAutonomousGoalLoopWatchdogCursor: mockIsValidAutonomousGoalLoopWatchdogCursor,
  listAutonomousGoalLoopWatchdogPreview: mockListAutonomousGoalLoopWatchdogPreview,
}));

vi.mock("../services/autonomous-loop-watchdog-recovery-plan.js", () => ({
  listAutonomousGoalLoopWatchdogRecoveryPlanPreview: mockListAutonomousGoalLoopWatchdogRecoveryPlanPreview,
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
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueDispositionService: () => mockIssueDispositionService,
  extractDispositionRowFromMetadata: (...args: unknown[]) =>
    mockExtractDispositionRowFromMetadata(...args),
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
  issueFinalDeliveryService: () => mockIssueFinalDeliveryService,
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
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function normalizePolicy(input: {
  stages: Array<{
    id: string;
    type: "review" | "approval";
    participants: Array<{ type: "agent"; agentId: string } | { type: "user"; userId: string }>;
  }>;
}) {
  const { normalizeIssueExecutionPolicy } = await import("../services/issue-execution-policy.js");
  return normalizeIssueExecutionPolicy(input);
}

function makeIssue(status: "todo" | "done" | "blocked" | "cancelled" | "in_progress") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

function agentActor(agentId = "22222222-2222-4222-8222-222222222222") {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: "run-1",
  };
}

async function waitForWakeup(assertion: () => void) {
  await vi.waitFor(assertion);
}

describe.sequential("issue comment reopen routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.list.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockLogActivity.mockReset();
    mockFeedbackService.listIssueVotesForUser.mockReset();
    mockFeedbackService.saveIssueVote.mockReset();
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockRoutineService.syncRunStatusForIssue.mockReset();
    mockIssueTreeControlService.getActivePauseHoldGate.mockReset();
    mockApplyCommentDisposition.mockReset();
    mockExtractDispositionRowFromMetadata.mockReset();
    mockExtractDispositionRowFromMetadata.mockImplementation(() => null);
    mockTxInsertValues.mockReset();
    mockTxInsert.mockReset();
    mockDbSelect.mockReset();
    mockDbSelectFrom.mockReset();
    mockDbSelectWhere.mockReset();
    mockDbSelectOrderBy.mockReset();
    mockDb.transaction.mockReset();
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({ orderBy: mockDbSelectOrderBy }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.list.mockResolvedValue([]);
    mockListMissionControlCompletionDocuments.mockReset();
    mockListMissionControlCompletionDocuments.mockResolvedValue([]);
    mockListAutonomousGoalLoopWatchdogPreview.mockReset();
    mockIsValidAutonomousGoalLoopWatchdogCursor.mockReset();
    mockIsValidAutonomousGoalLoopWatchdogCursor.mockImplementation((cursor: string) => cursor === "opaque-watchdog-cursor-1");
    mockListAutonomousGoalLoopWatchdogPreview.mockResolvedValue({
      companyId: "company-1",
      mode: "preview",
      readOnly: true,
      generatedAt: "2026-05-11T10:00:00.000Z",
      totalIssuesScanned: 0,
      hasMore: false,
      nextCursor: null,
      candidates: [],
    });
    mockListAutonomousGoalLoopWatchdogRecoveryPlanPreview.mockReset();
    mockListAutonomousGoalLoopWatchdogRecoveryPlanPreview.mockResolvedValue({
      companyId: "company-1",
      mode: "recovery_plan_preview",
      dryRun: true,
      readOnly: true,
      liveRecovery: false,
      generatedAt: "2026-05-11T10:00:00.000Z",
      totalIssuesScanned: 0,
      candidatesConsidered: 0,
      plans: [],
      skippedCandidates: [],
      guardrails: {
        boardOnly: true,
        dryRunOnly: true,
        noLiveRecovery: true,
        noApprovalLaundering: true,
        allowedOwners: ["operator"],
      },
    });
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
    ]);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, reference: string) => {
      if (reference === "ambiguous-codex") {
        return { ambiguous: true, agent: null };
      }
      if (reference === "missing-codex") {
        return { ambiguous: false, agent: null };
      }
      if (reference === "codexcoder") {
        return {
          ambiguous: false,
          agent: { id: "33333333-3333-4333-8333-333333333333" },
        };
      }
      return {
        ambiguous: false,
        agent: { id: reference },
      };
    });
  });

  it("serves read-only autonomous loop watchdog previews for operators", async () => {
    mockListAutonomousGoalLoopWatchdogPreview.mockResolvedValue({
      companyId: "company-1",
      mode: "preview",
      readOnly: true,
      generatedAt: "2026-05-11T10:00:00.000Z",
      totalIssuesScanned: 2,
      hasMore: true,
      nextCursor: "opaque-watchdog-cursor-1",
      candidates: [
        {
          id: "issue-1:repair_loop_decision:ceo_loop_decision_stale",
          kind: "loop_decision_repair",
          severity: "high",
          owner: "operator",
          issueId: "issue-1",
          identifier: "PAP-581",
          title: "Autonomous loop goal",
          status: "in_progress",
          reason: "ceo_loop_decision_stale",
          recoveryAction: "repair_loop_decision",
          recommendedAction: "Review and rewrite the ceo-loop-decision document.",
          userVisible: false,
          generatedAt: "2026-05-11T10:00:00.000Z",
        },
      ],
    });

    const res = await request(await installActor(createApp()))
      .get("/api/companies/company-1/autonomous-loop-watchdog/preview?limit=25&cursor=opaque-watchdog-cursor-1")
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId: "company-1",
      mode: "preview",
      readOnly: true,
      totalIssuesScanned: 2,
      hasMore: true,
      nextCursor: "opaque-watchdog-cursor-1",
      candidates: [
        expect.objectContaining({
          owner: "operator",
          kind: "loop_decision_repair",
          recoveryAction: "repair_loop_decision",
        }),
      ],
    });
    expect(mockListAutonomousGoalLoopWatchdogPreview).toHaveBeenCalledWith(mockDb, "company-1", {
      limit: 25,
      cursor: "opaque-watchdog-cursor-1",
    });
  });

  it("rejects non-board actors for autonomous loop watchdog previews", async () => {
    const res = await request(await installActor(createApp(), agentActor()))
      .get("/api/companies/company-1/autonomous-loop-watchdog/preview")
      .send();

    expect(res.status).toBe(403);
    expect(mockListAutonomousGoalLoopWatchdogPreview).not.toHaveBeenCalled();
  });

  it("validates autonomous loop watchdog preview limits", async () => {
    const res = await request(await installActor(createApp()))
      .get("/api/companies/company-1/autonomous-loop-watchdog/preview?limit=101")
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid limit");
    expect(mockListAutonomousGoalLoopWatchdogPreview).not.toHaveBeenCalled();
  });

  it("validates autonomous loop watchdog preview cursors", async () => {
    const res = await request(await installActor(createApp()))
      .get("/api/companies/company-1/autonomous-loop-watchdog/preview?cursor=issue-1")
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid cursor");
    expect(mockListAutonomousGoalLoopWatchdogPreview).not.toHaveBeenCalled();
  });

  it("serves dry-run autonomous loop watchdog recovery-plan previews for operators", async () => {
    mockListAutonomousGoalLoopWatchdogRecoveryPlanPreview.mockResolvedValue({
      companyId: "company-1",
      mode: "recovery_plan_preview",
      dryRun: true,
      readOnly: true,
      liveRecovery: false,
      generatedAt: "2026-05-11T10:00:00.000Z",
      totalIssuesScanned: 2,
      candidatesConsidered: 1,
      plans: [
        {
          id: "recovery-plan:issue-1:repair_loop_decision:ceo_loop_decision_stale",
          candidateId: "issue-1:repair_loop_decision:ceo_loop_decision_stale",
          issueId: "issue-1",
          identifier: "PAP-581",
          title: "Autonomous loop goal",
          severity: "high",
          reason: "ceo_loop_decision_stale",
          recoveryAction: "repair_loop_decision",
          planKind: "repair_loop_decision_document",
          execution: "operator_manual_only",
          mutationPolicy: {
            dryRunOnly: true,
            writesDocument: false,
            createsIssue: false,
            createsApproval: false,
            queuesWakeup: false,
            continuesAutonomousLoop: false,
            liveRecovery: false,
          },
          steps: [],
          blockedActions: ["continue_autonomous_goal_loop", "create_child_issue", "request_user_approval"],
        },
      ],
      skippedCandidates: [],
      guardrails: {
        boardOnly: true,
        dryRunOnly: true,
        noLiveRecovery: true,
        noApprovalLaundering: true,
        allowedOwners: ["operator"],
      },
    });

    const res = await request(await installActor(createApp()))
      .get("/api/companies/company-1/autonomous-loop-watchdog/recovery-plan/preview?limit=25&dryRun=true")
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId: "company-1",
      mode: "recovery_plan_preview",
      dryRun: true,
      readOnly: true,
      liveRecovery: false,
      plans: [
        expect.objectContaining({
          execution: "operator_manual_only",
          planKind: "repair_loop_decision_document",
        }),
      ],
    });
    expect(mockListAutonomousGoalLoopWatchdogRecoveryPlanPreview).toHaveBeenCalledWith(mockDb, "company-1", {
      limit: 25,
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects non-board actors for autonomous loop watchdog recovery-plan previews", async () => {
    const res = await request(await installActor(createApp(), agentActor()))
      .get("/api/companies/company-1/autonomous-loop-watchdog/recovery-plan/preview")
      .send();

    expect(res.status).toBe(403);
    expect(mockListAutonomousGoalLoopWatchdogRecoveryPlanPreview).not.toHaveBeenCalled();
  });

  it("validates autonomous loop watchdog recovery-plan preview limits", async () => {
    const res = await request(await installActor(createApp()))
      .get("/api/companies/company-1/autonomous-loop-watchdog/recovery-plan/preview?limit=101")
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid recovery plan preview query");
    expect(mockListAutonomousGoalLoopWatchdogRecoveryPlanPreview).not.toHaveBeenCalled();
  });

  it("rejects live/apply-shaped autonomous loop watchdog recovery-plan preview queries", async () => {
    const dryRunFalse = await request(await installActor(createApp()))
      .get("/api/companies/company-1/autonomous-loop-watchdog/recovery-plan/preview?dryRun=false")
      .send();
    const applyQuery = await request(await installActor(createApp()))
      .get("/api/companies/company-1/autonomous-loop-watchdog/recovery-plan/preview?apply=true")
      .send();

    expect(dryRunFalse.status).toBe(400);
    expect(applyQuery.status).toBe(400);
    expect(mockListAutonomousGoalLoopWatchdogRecoveryPlanPreview).not.toHaveBeenCalled();
  });

  it("serves derived autonomous loop state for the issue detail panel", async () => {
    const parentIssue = {
      ...makeIssue("in_progress"),
      priority: "high",
      executionPolicy: {
        missionControl: {
          enabled: true,
          riskClass: "high",
          requiredDocumentKeys: ["validation-contract", "worker-handoff", "validator-report"],
          autonomousLoop: {
            enabled: true,
            controller: "CEO",
            goal: "Ship Autonomous Loop v2 observability",
            startedAt: "2026-05-11T08:00:00.000Z",
            iteration: 1,
            maxIterations: 5,
            maxRuntimeHours: 24 * 90,
            maxDecisionAgeMinutes: null,
          },
        },
      },
    };
    mockIssueService.getById.mockResolvedValue(parentIssue);
    mockListMissionControlCompletionDocuments.mockResolvedValue([
      { key: "validation-contract", body: "objective/pass criteria" },
      { key: "worker-handoff", body: "worker done" },
      { key: "validator-report", body: "Verdict: PASS" },
      {
        key: "ceo-loop-decision",
        body: JSON.stringify({
          version: 1,
          iteration: 1,
          decision: "next_iteration",
          rationale: "Continue with the next safe internal task.",
          nextTask: {
            title: "Expose loop state panel",
            acceptanceCriteria: ["Issue detail shows loop state"],
            safeToRunWithoutUserApproval: true,
          },
        }),
      },
    ]);
    mockIssueService.list.mockResolvedValue([
      {
        id: "child-1",
        parentId: parentIssue.id,
        identifier: "PAP-581",
        title: "Expose loop state panel",
        status: "in_progress",
        originKind: "autonomous_goal_loop_iteration",
        originId: parentIssue.id,
        originFingerprint: "iteration:1",
        createdAt: new Date("2026-05-11T09:00:00.000Z"),
        updatedAt: new Date("2026-05-11T09:10:00.000Z"),
      },
    ]);

    const res = await request(await installActor(createApp()))
      .get("/api/issues/11111111-1111-4111-8111-111111111111/autonomous-loop-state")
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      status: "executing",
      goal: "Ship Autonomous Loop v2 observability",
      iteration: 1,
      progressLabel: "1 / 5",
      currentDecision: {
        iteration: 1,
        decision: "next_iteration",
        nextTaskTitle: "Expose loop state panel",
      },
      planner: {
        mode: "single_child",
        supportsParallelChildren: false,
        originFingerprint: "iteration:1",
        childIssueId: "child-1",
      },
      supervisor: {
        attentionRequired: false,
        recoveryAction: "none",
      },
      iterations: [
        {
          iteration: 2,
          issueId: "child-1",
          identifier: "PAP-581",
          title: "Expose loop state panel",
          status: "in_progress",
        },
      ],
    });
    expect(res.body.observability.chain).toEqual([
      expect.objectContaining({ kind: "goal", issueId: parentIssue.id }),
      expect.objectContaining({ kind: "iteration", issueId: "child-1", iteration: 2 }),
    ]);
    expect(mockIssueService.list).toHaveBeenCalledWith("company-1", {
      parentId: parentIssue.id,
      originKind: "autonomous_goal_loop_iteration",
      originId: parentIssue.id,
      limit: 100,
    });
  });

  it("treats reopen=true as a no-op when the issue is already open", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe("33333333-3333-4333-8333-333333333333");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reopened: true }),
      }),
    );
  });

  it("implicitly reopens closed issues via the PATCH comment path when reassigning to an agent", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("resolves assignee shortnames before updating an issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", assigneeAgentId: "codexcoder" });

    expect(res.status).toBe(200);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith("company-1", "codexcoder");
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      }),
    );
  });

  it("rejects ambiguous assignee shortnames", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ assigneeAgentId: "ambiguous-codex" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("ambiguous");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects missing assignee shortnames", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ assigneeAgentId: "missing-codex" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
  it("reopens closed issues via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("implicitly reopens closed issues via POST comments when an agent is assigned", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          reopenedFrom: "done",
        }),
      }),
    ));
  });

  it("rejects non-assignee agent POST comments on closed issues", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: "33333333-3333-4333-8333-333333333333",
      authorUserId: null,
    });

    const res = await request(await installActor(createApp(), {
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      source: "agent_key",
      runId: "77777777-7777-4777-8777-777777777777",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("moves assigned blocked issues back to todo via POST comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please continue" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "blocked",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          wakeCommentId: "comment-1",
          wakeReason: "issue_reopened_via_comment",
          reopenedFrom: "blocked",
        }),
      }),
    ));
  });

  it("passes validated comment presentation fields to trusted board comment writes", async () => {
    const app = await installActor(createApp());
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "local-board",
      body: "Paperclip needs a disposition before this issue can continue.",
      presentation: { kind: "system_notice", tone: "warning", detailsDefaultOpen: false },
      metadata: {
        version: 1,
        sections: [{ rows: [{ type: "key_value", label: "Cause", value: "successful_run_missing_state" }] }],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);

    const metadata = {
      version: 1,
      sections: [{ rows: [{ type: "key_value", label: "Cause", value: "successful_run_missing_state" }] }],
    };
    const presentation = { kind: "system_notice", tone: "warning" };
    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Paperclip needs a disposition before this issue can continue.",
        presentation,
        metadata,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Paperclip needs a disposition before this issue can continue.",
      { agentId: undefined, userId: "local-board", runId: null },
      {
        authorType: "user",
        presentation: { kind: "system_notice", tone: "warning", detailsDefaultOpen: false },
        metadata,
      },
    );
  });

  it("rejects structured comment presentation fields from agent-authenticated writes", async () => {
    const app = await installActor(createApp(), agentActor());
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Hidden details",
        presentation: { kind: "system_notice", tone: "warning" },
        metadata: {
          version: 1,
          sections: [{ rows: [{ type: "key_value", label: "Cause", value: "covert_channel_attempt" }] }],
        },
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects invalid comment metadata before writing a comment", async () => {
    const app = await installActor(createApp());
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Invalid metadata",
        metadata: { version: 1, arbitrary: true },
      });

    expect(res.status).toBe(400);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("does not move dependency-blocked issues to todo via POST comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "what is happening?" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          commentId: "comment-1",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          wakeCommentId: "comment-1",
          wakeReason: "issue_commented",
        }),
      }),
    ));
  });

  it("does not implicitly reopen closed issues via POST comments when no agent is assigned", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("done"),
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("moves assigned blocked issues back to todo via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "please continue" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "blocked",
          mutation: "comment",
        }),
      }),
    ));
  });

  it("rejects non-assignee agent PATCH comments on closed issues", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: "33333333-3333-4333-8333-333333333333",
      authorUserId: null,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), {
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      source: "agent_key",
      runId: "88888888-8888-4888-8888-888888888888",
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not move dependency-blocked issues to todo via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "what is happening?" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          commentId: "comment-1",
          mutation: "comment",
        }),
      }),
    ));
  });

  it("wakes the assignee when an assigned blocked issue moves back to todo", async () => {
    const issue = makeIssue("blocked");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          mutation: "update",
        }),
      }),
    ));
  });

  it("wakes the assignee when an assigned done issue moves back to todo", async () => {
    const issue = makeIssue("done");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          mutation: "update",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          source: "issue.status_change",
        }),
      }),
    );
  });

  it("explicit same-agent resume works through the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "please validate the follow-up", resume: true });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "todo",
        actorAgentId: "22222222-2222-4222-8222-222222222222",
        actorUserId: null,
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "done",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
  });

  it("keeps generic same-agent comments on closed issues inert", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "follow-up note without intent" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("explicit same-agent resume comments reopen closed issues and mark the wake payload", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please validate the follow-up", resume: true });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "done",
          resumeIntent: true,
          followUpRequested: true,
        }),
        contextSnapshot: expect.objectContaining({
          wakeReason: "issue_reopened_via_comment",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
  });

  it("rejects explicit agent resume intent from a non-assignee", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));

    const res = await request(await installActor(createApp(), agentActor("44444444-4444-4444-8444-444444444444")))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "restart someone else's work", resume: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects explicit resume intent under an active pause hold", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue({
      holdId: "hold-1",
      rootIssueId: "root-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      isRoot: false,
      mode: "pause",
      reason: "reviewing",
      releasePolicy: null,
    });

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please resume", resume: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue follow-up blocked by active subtree pause hold");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects explicit resume intent on cancelled issues", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("cancelled"));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please resume", resume: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Cancelled issues must be restored through the dedicated restore flow");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("interrupts an active run before a combined comment update", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", interrupt: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "issue_comment_interrupt",
          issueId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("cancels an active run when an issue is marked cancelled", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "issue_status_cancelled",
          issueId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("does not cancel active runs when an issue is marked done", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("writes decision ids into executionState and inserts the decision inside the transaction", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "approval",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: "local-board" },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
      ...issue,
      ...patch,
      executionState: patch.executionState,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done", comment: "Approved for ship" });

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        executionState: expect.objectContaining({
          status: "completed",
          lastDecisionId: expect.any(String),
          lastDecisionOutcome: "approved",
        }),
      }),
      mockTx,
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, any>;
    const decisionId = updatePatch.executionState.lastDecisionId;
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: decisionId,
        issueId: "11111111-1111-4111-8111-111111111111",
        outcome: "approved",
        body: "Approved for ship",
      }),
    );
  });

  it("coerces executor handoff patches into workflow-controlled review wakes", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_progress",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      executionPolicy: policy,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        reviewRequest: {
          instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe("33333333-3333-4333-8333-333333333333");
    expect(res.body.assigneeUserId).toBeNull();
    expect(res.body.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: {
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
      },
      returnAssignee: {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
      },
      reviewRequest: {
        instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
      },
    });
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({
        reason: "execution_review_requested",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          executionStage: expect.objectContaining({
            wakeRole: "reviewer",
            stageType: "review",
            reviewRequest: {
              instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
            },
            allowedActions: ["approve", "request_changes"],
          }),
        }),
      }),
    ));
  });

  it("wakes the return assignee with execution_changes_requested", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-2",
      }),
    )
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        status: "in_progress",
        comment: "Needs another pass",
      });

    expect(res.status).toBe(200);
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "execution_changes_requested",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          executionStage: expect.objectContaining({
            wakeRole: "executor",
            stageType: "review",
            lastDecisionOutcome: "changes_requested",
            allowedActions: ["address_changes", "resubmit"],
          }),
        }),
      }),
    ));
  });

  describe("disposition carrier", () => {
    const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
    const RUN_ID = "55555555-5555-4555-8555-555555555555";
    const dispositionRow = {
      type: "disposition" as const,
      value: "done" as const,
      reason: "All done",
      evidenceRefs: [],
      idempotencyKey: `disposition:${ISSUE_ID}:${RUN_ID}:done`,
    };
    const dispositionMetadata = {
      version: 1,
      sourceRunId: RUN_ID,
      sections: [{ rows: [dispositionRow] }],
    };

    function setupBaseStubs() {
      mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
      mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
      mockExtractDispositionRowFromMetadata.mockImplementation(() => ({
        row: dispositionRow,
        sectionIndex: 0,
        rowIndex: 0,
      }));
    }

    it("delegates to the disposition writer and surfaces atomic evidence", async () => {
      setupBaseStubs();
      const appliedComment = {
        id: "disposition-comment-1",
        issueId: ISSUE_ID,
        companyId: "company-1",
        body: "Marking done",
        createdAt: new Date(),
        updatedAt: new Date(),
        authorAgentId: "22222222-2222-4222-8222-222222222222",
        authorUserId: null,
      };
      mockApplyCommentDisposition.mockResolvedValue({
        comment: appliedComment,
        applied: true,
        noop: false,
        dispositionValue: "done",
        intention: { targetStatus: "done", parentBlockerIntention: "remove_from_parent_blockers" },
        sourceRunId: RUN_ID,
        idempotencyKey: dispositionRow.idempotencyKey,
        evidence: {
          sourceRunId: RUN_ID,
          sourceCommentId: appliedComment.id,
          actor: { actorType: "agent", agentId: "22222222-2222-4222-8222-222222222222", runId: RUN_ID },
          parentBlockerIntention: "remove_from_parent_blockers",
          parentBlockerCleared: true,
          parentBlockerReplacementDeferred: false,
          previousStatus: "in_progress",
          nextStatus: "done",
        },
      });
      (mockIssueService as unknown as { getComment?: ReturnType<typeof vi.fn> }).getComment =
        vi.fn(async () => appliedComment);

      const res = await request(await installActor(createApp(), agentActor()))
        .post(`/api/issues/${ISSUE_ID}/comments`)
        .send({
          body: "Marking done",
          metadata: dispositionMetadata,
        });

      expect(res.status).toBe(201);
      expect(mockApplyCommentDisposition).toHaveBeenCalledTimes(1);
      expect(mockIssueService.addComment).not.toHaveBeenCalled();

      // The post-tx comment_added activity references the atomic evidence row.
      const commentAddedCall = mockLogActivity.mock.calls.find(
        ([, input]) => (input as { action: string }).action === "issue.comment_added",
      );
      expect(commentAddedCall).toBeTruthy();
      const commentAddedDetails = (commentAddedCall?.[1] as { details: Record<string, unknown> }).details;
      expect(commentAddedDetails.disposition).toMatchObject({
        value: "done",
        applied: true,
        previousStatus: "in_progress",
        nextStatus: "done",
        parentBlockerCleared: true,
        parentBlockerReplacementDeferred: false,
        atomicEvidenceAction: "issue.disposition_applied",
      });
    });

    it("rejects requests that combine a disposition row with reopen/resume/interrupt", async () => {
      setupBaseStubs();
      mockIssueService.getById.mockResolvedValue(makeIssue("done"));

      const res = await request(await installActor(createApp(), agentActor()))
        .post(`/api/issues/${ISSUE_ID}/comments`)
        .send({
          body: "Marking done again",
          resume: true,
          metadata: dispositionMetadata,
        });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        details: { code: "disposition_combines_with_lifecycle_flag" },
      });
      expect(mockApplyCommentDisposition).not.toHaveBeenCalled();
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("surfaces HttpError details from the disposition writer back to the client", async () => {
      setupBaseStubs();
      const { HttpError } = await import("../errors.js");
      mockApplyCommentDisposition.mockRejectedValue(
        new HttpError(409, "duplicate idempotency", { code: "disposition_idempotency_conflict" }),
      );

      const res = await request(await installActor(createApp(), agentActor()))
        .post(`/api/issues/${ISSUE_ID}/comments`)
        .send({
          body: "Marking done",
          metadata: dispositionMetadata,
        });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: "duplicate idempotency",
        details: { code: "disposition_idempotency_conflict" },
      });
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });

    it("falls through to the legacy comment path when no disposition row is present", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
      mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
      mockExtractDispositionRowFromMetadata.mockImplementation(() => null);

      const res = await request(await installActor(createApp(), agentActor()))
        .post(`/api/issues/${ISSUE_ID}/comments`)
        .send({ body: "plain comment" });

      expect(res.status).toBe(201);
      expect(mockApplyCommentDisposition).not.toHaveBeenCalled();
      expect(mockIssueService.addComment).toHaveBeenCalled();
    });
  });
});
