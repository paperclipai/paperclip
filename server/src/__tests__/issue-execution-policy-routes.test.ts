import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  list: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const FACTORY_CONTROL_ID = "99999999-9999-4999-8999-999999999999";
const FACTORY_CTO_ID = "11111111-1111-4111-8111-111111111111";
const FACTORY_DEVOPS_ID = "22222222-2222-4222-8222-222222222222";

function managedFactoryPolicyFixture() {
  return normalizeIssueExecutionPolicy({
    mode: "normal",
    commentRequired: true,
    stages: [
      {
        id: "88888888-8888-4888-8888-888888888888",
        key: "contract",
        type: "work",
        role: "cto",
        participants: [{
          id: "77777777-7777-4777-8777-777777777777",
          type: "agent",
          agentId: FACTORY_CTO_ID,
        }],
      },
    ],
    factory: {
      schemaVersion: 1,
      laneKind: "execution",
      topologyMode: "same_issue_only",
      controlIssueId: FACTORY_CONTROL_ID,
      coordinator: { type: "agent", agentId: FACTORY_CTO_ID },
      policyKey: "company/acme/ai-factory-policy",
      policyVersion: "1",
      policyHash: "deadbeef",
      maxExecutionLanes: 1,
      production: false,
    },
  })!;
}

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
  isCompanyOwner: vi.fn(async () => false),
  hasProjectPermission: vi.fn(async () => false),
  canUserAccessProject: vi.fn(async () => false),
}));

const mockIssueVisibilityService = vi.hoisted(() => ({
  canSeeIssue: vi.fn(async () => true),
  filterVisibleIssues: vi.fn(async (_principal, issues) => issues),
  ensureCollaborator: vi.fn(async () => undefined),
  resolveMentionsToCollaborators: vi.fn(async () => undefined),
  listCollaborators: vi.fn(async () => []),
  removeCollaborator: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockValidateDelegatedIssueExecutionContract = vi.hoisted(() => vi.fn(() => ({
  valid: true,
  warnings: [],
})));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  cancelPendingForTerminalIssue: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async (_id: string): Promise<any> => null),
  list: vi.fn(async (_companyId?: string): Promise<any[]> => []),
  resolveByReference: vi.fn(async (_companyId: string, _reference: string): Promise<any> => ({ agent: null, ambiguous: false })),
}));

function registerModuleMocks() {
  vi.doMock("../services/image-reference-guardrails.js", () => ({
    resolveIssueImageReferenceGuardrail: vi.fn(async () => ({
      required: false,
      issueScopeIds: [],
      boardText: "",
      candidateAttachmentIds: [],
      candidateAssetIds: [],
    })),
    hasReferenceBackedImageGenerationEvidence: vi.fn(async () => false),
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    budgetService: () => ({
      upsertPolicy: vi.fn(async () => undefined),
    }),
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
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
    issueApprovalService: () => mockIssueApprovalService,
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
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    validateDelegatedIssueExecutionContract: mockValidateDelegatedIssueExecutionContract,
    workProductService: () => ({}),
    issueVisibilityService: () => mockIssueVisibilityService,
    webPushService: () => ({
      sendToUser: vi.fn(async () => undefined),
      sendToUsers: vi.fn(async () => undefined),
      notifyUsers: vi.fn(async () => undefined),
    }),
  }));
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit" | "session";
      isInstanceAdmin: boolean;
      memberships?: Array<{
        companyId: string;
        membershipRole: "owner" | "admin" | "operator" | "viewer";
        status: "active" | "inactive";
      }>;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
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
  const db = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
      insert: () => ({ values: async () => [] }),
    }),
  };
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/image-reference-guardrails.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.addComment.mockImplementation(async (issueId: string, body: string) => ({
      id: `comment-${issueId}`,
      issueId,
      body,
      createdAt: new Date(),
    }));
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueThreadInteractionService.cancelPendingForTerminalIssue.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ agent: null, ambiguous: false });
    mockValidateDelegatedIssueExecutionContract.mockReturnValue({ valid: true, warnings: [] });
    mockIssueService.createChild.mockResolvedValue({
      issue: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId: "company-1",
        identifier: "PAP-1002",
        title: "Child issue",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        assigneeUserId: null,
        executionContract: null,
      },
      parentBlockerAdded: false,
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.isCompanyOwner.mockResolvedValue(false);
    mockAccessService.hasProjectPermission.mockResolvedValue(false);
    mockAccessService.canUserAccessProject.mockResolvedValue(false);
    mockIssueVisibilityService.canSeeIssue.mockResolvedValue(true);
  });

  it("hides a private issue from an unauthorized board PATCH", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      visibility: "private",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: "different-user",
      createdByAgentId: null,
      identifier: "PAP-1000",
      title: "Private issue",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAccessService.canUser.mockResolvedValue(true);
    mockIssueVisibilityService.canSeeIssue.mockResolvedValue(false);

    const res = await request(await createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    }))
      .patch(`/api/issues/${issue.id}`)
      .send({ priority: "high" });

    expect(res.status).toBe(404);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("requires board issue-edit permission before a generic PATCH", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      visibility: "public",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: "board-user",
      createdByAgentId: null,
      identifier: "PAP-1000",
      title: "Public issue",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    }))
      .patch(`/api/issues/${issue.id}`)
      .send({ priority: "high" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("issues:manage");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects visibility changes through generic PATCH instead of bypassing mediation", async () => {
    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ visibility: "company" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("keeps private-to-company visibility changes behind board confirmation", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      visibility: "private",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: "local-board",
      createdByAgentId: null,
      identifier: "PAP-1000",
      title: "Private issue",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, visibility: "company" });

    const unconfirmed = await request(await createApp())
      .post(`/api/issues/${issue.id}/visibility`)
      .send({ visibility: "company" });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body).toMatchObject({ requiresConfirmation: true });
    expect(mockIssueService.update).not.toHaveBeenCalled();

    const confirmed = await request(await createApp())
      .post(`/api/issues/${issue.id}/visibility`)
      .send({ visibility: "company", confirmed: true });
    expect(confirmed.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(issue.id, { visibility: "company" });
  });

  it("does not let agents use the dedicated visibility route", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      visibility: "private",
      status: "todo",
      assigneeAgentId: FACTORY_CTO_ID,
      assigneeUserId: null,
      createdByUserId: null,
      createdByAgentId: FACTORY_CTO_ID,
      identifier: "PAP-1000",
      title: "Private issue",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: FACTORY_CTO_ID,
      companyId: "company-1",
      runId: "run-1",
    }))
      .post(`/api/issues/${issue.id}/visibility`)
      .send({ visibility: "company", confirmed: true });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects first-time factory attachment through generic issue creation", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Forged factory control",
        executionPolicy: managedFactoryPolicyFixture(),
      });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "factory_managed_route_required",
      reason: "factory_snapshot_attach",
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects first-time factory attachment through generic child creation", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: FACTORY_CTO_ID,
      assigneeUserId: null,
      identifier: "PAP-1001",
      title: "Control issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Forged execution lane",
        executionPolicy: managedFactoryPolicyFixture(),
      });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "factory_managed_route_required",
      reason: "factory_snapshot_attach",
      managedRoute: "POST /api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/execution-lanes",
    });
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("rejects first-time factory attachment through generic issue PATCH", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: FACTORY_CTO_ID,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Ordinary issue",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: managedFactoryPolicyFixture() });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "factory_managed_route_required",
      reason: "factory_snapshot_attach",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows a monitor-only PATCH when the existing factory snapshot is unchanged", async () => {
    const executionPolicy = managedFactoryPolicyFixture();
    const currentStage = executionPolicy.stages[0]!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: FACTORY_CTO_ID,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1003",
      title: "Managed execution lane",
      executionPolicy,
      executionState: {
        status: "pending",
        currentStageId: currentStage.id,
        currentStageIndex: 0,
        currentStageType: "work",
        stageRevision: 3,
        currentParticipant: { type: "agent", agentId: FACTORY_CTO_ID, userId: null },
        returnAssignee: { type: "agent", agentId: FACTORY_CTO_ID, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    const nextPolicy = structuredClone(executionPolicy);
    nextPolicy.monitor = {
      nextCheckAt: "2026-07-20T12:00:00.000Z",
      notes: "Wait for provider evidence.",
      scheduledBy: "board",
    };

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: nextPolicy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({
        factoryManagedTransition: expect.objectContaining({
          expectedStageRevision: 3,
          decisionId: null,
        }),
        monitorNextCheckAt: new Date("2026-07-20T12:00:00.000Z"),
      }),
    );
  });

  it("lets the active CTO complete technical acceptance before its server-generated ledger event exists", async () => {
    const technicalStageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const deploymentStageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const executionPolicy = normalizeIssueExecutionPolicy({
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: technicalStageId,
          key: "technical_acceptance",
          type: "review",
          role: "cto",
          evidenceGates: [
            "delivery:functional_qa:succeeded",
            "delivery:technical_acceptance:accepted:paperclip_verified",
          ],
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: FACTORY_CTO_ID }],
        },
        {
          id: deploymentStageId,
          key: "deployment",
          type: "deployment",
          role: "devops",
          evidenceGates: ["delivery:deployment:succeeded:provider_verified"],
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: FACTORY_DEVOPS_ID }],
        },
      ],
      factory: {
        schemaVersion: 1,
        laneKind: "execution",
        topologyMode: "same_issue_only",
        controlIssueId: FACTORY_CONTROL_ID,
        coordinator: { type: "agent", agentId: FACTORY_CTO_ID },
        policyKey: "company/acme/ai-factory-policy",
        policyVersion: "1",
        policyHash: "deadbeef",
        maxExecutionLanes: 1,
        production: true,
      },
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      visibility: "public",
      status: "in_review",
      assigneeAgentId: FACTORY_CTO_ID,
      assigneeUserId: null,
      createdByUserId: "local-board",
      createdByAgentId: null,
      identifier: "PAP-1013",
      title: "Technical acceptance",
      executionPolicy,
      executionState: {
        status: "pending",
        currentStageId: technicalStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        stageRevision: 4,
        currentStageActivatedAt: "2026-07-17T03:00:00.000Z",
        completedStageRevisions: {},
        currentParticipant: { type: "agent", agentId: FACTORY_CTO_ID, userId: null },
        returnAssignee: { type: "agent", agentId: FACTORY_CTO_ID, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-technical-acceptance",
      companyId: issue.companyId,
      agentId: FACTORY_CTO_ID,
      status: "running",
      contextSnapshot: { issueId: issue.id },
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: FACTORY_CTO_ID,
      companyId: issue.companyId,
      runId: "run-technical-acceptance",
    }))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Approved this exact candidate for deployment." });

    expect(res.status).toBe(200);
    const patch = mockIssueService.update.mock.calls[0]?.[1] as any;
    expect(patch).toMatchObject({
      status: "in_progress",
      assigneeAgentId: FACTORY_DEVOPS_ID,
      executionState: {
        currentStageId: deploymentStageId,
        stageRevision: 5,
        completedStageIds: [technicalStageId],
        lastDecisionOutcome: "approved",
      },
      factoryManagedTransition: { expectedStageRevision: 4 },
    });
    expect(patch.factoryManagedTransition.decisionId).toBeTypeOf("string");
    expect(patch.executionState.lastDecisionId).toBe(patch.factoryManagedTransition.decisionId);
  });

  it("lets the active CTO complete final acceptance before its server-generated ledger event exists", async () => {
    const finalStageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const executionPolicy = normalizeIssueExecutionPolicy({
      mode: "normal",
      commentRequired: true,
      stages: [{
        id: finalStageId,
        key: "final_acceptance",
        type: "approval",
        role: "cto",
        evidenceGates: [
          "delivery:deployment:succeeded:provider_verified",
          "delivery:smoke:succeeded",
          "delivery:business_acceptance:accepted:paperclip_verified",
        ],
        approvalsNeeded: 1,
        participants: [{ type: "agent", agentId: FACTORY_CTO_ID }],
      }],
      factory: {
        schemaVersion: 1,
        laneKind: "execution",
        topologyMode: "same_issue_only",
        controlIssueId: FACTORY_CONTROL_ID,
        coordinator: { type: "agent", agentId: FACTORY_CTO_ID },
        policyKey: "company/acme/ai-factory-policy",
        policyVersion: "1",
        policyHash: "deadbeef",
        maxExecutionLanes: 1,
        production: true,
      },
    })!;
    const issue = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      companyId: "company-1",
      projectId: null,
      visibility: "public",
      status: "in_review",
      assigneeAgentId: FACTORY_CTO_ID,
      assigneeUserId: null,
      createdByUserId: "local-board",
      createdByAgentId: null,
      identifier: "PAP-1014",
      title: "Final acceptance",
      executionPolicy,
      executionState: {
        status: "pending",
        currentStageId: finalStageId,
        currentStageIndex: 0,
        currentStageType: "approval",
        stageRevision: 7,
        currentStageActivatedAt: "2026-07-17T06:00:00.000Z",
        completedStageRevisions: {},
        currentParticipant: { type: "agent", agentId: FACTORY_CTO_ID, userId: null },
        returnAssignee: { type: "agent", agentId: FACTORY_CTO_ID, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-final-acceptance",
      companyId: issue.companyId,
      agentId: FACTORY_CTO_ID,
      status: "running",
      contextSnapshot: { issueId: issue.id },
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: FACTORY_CTO_ID,
      companyId: issue.companyId,
      runId: "run-final-acceptance",
    }))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Final acceptance approved for the verified production target." });

    expect(res.status).toBe(200);
    const patch = mockIssueService.update.mock.calls[0]?.[1] as any;
    expect(patch).toMatchObject({
      status: "done",
      executionState: {
        status: "completed",
        currentStageId: null,
        completedStageIds: [finalStageId],
        lastDecisionOutcome: "approved",
      },
      factoryManagedTransition: { expectedStageRevision: 7 },
    });
    expect(patch.factoryManagedTransition.decisionId).toBeTypeOf("string");
    expect(patch.executionState.lastDecisionId).toBe(patch.factoryManagedTransition.decisionId);
  });

  it("rejects factory-lane agent mutations without a heartbeat run", async () => {
    const executionPolicy = managedFactoryPolicyFixture();
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      visibility: "public",
      status: "in_review",
      assigneeAgentId: FACTORY_CTO_ID,
      assigneeUserId: null,
      createdByUserId: "local-board",
      createdByAgentId: null,
      identifier: "PAP-1004",
      title: "Managed execution lane",
      executionPolicy,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: FACTORY_CTO_ID,
      companyId: "company-1",
      runId: null,
    }))
      .patch(`/api/issues/${issue.id}`)
      .send({ priority: "high" });

    expect(res.status).toBe(401);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects factory-lane agent mutations from a stale or differently scoped run", async () => {
    const executionPolicy = managedFactoryPolicyFixture();
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      visibility: "public",
      status: "in_review",
      assigneeAgentId: FACTORY_CTO_ID,
      assigneeUserId: null,
      createdByUserId: "local-board",
      createdByAgentId: null,
      identifier: "PAP-1004",
      title: "Managed execution lane",
      executionPolicy,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockHeartbeatService.getRun.mockResolvedValueOnce({
      id: "run-stale",
      companyId: "company-1",
      agentId: FACTORY_CTO_ID,
      status: "succeeded",
      contextSnapshot: { issueId: issue.id },
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: FACTORY_CTO_ID,
      companyId: "company-1",
      runId: "run-stale",
    }))
      .patch(`/api/issues/${issue.id}`)
      .send({ priority: "high" });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent-authored in_review transition without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1003",
      title: "Missing review path",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.error).toContain("request_confirmation");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("auto-routes worker-authored in_review to the actor reportsTo reviewer", async () => {
    const workerId = "33333333-3333-4333-8333-333333333333";
    const managerId = "44444444-4444-4444-8444-444444444444";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: workerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      createdByAgentId: null,
      parentId: null,
      identifier: "PAP-1010",
      title: "Ready for manager review",
      executionPolicy: null,
      executionState: null,
    };
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === workerId) {
        return {
          id: workerId,
          companyId: "company-1",
          role: "engineer",
          status: "idle",
          reportsTo: managerId,
          permissions: {},
        };
      }
      if (id === managerId) {
        return {
          id: managerId,
          companyId: "company-1",
          role: "cto",
          status: "idle",
          reportsTo: null,
          permissions: {},
        };
      }
      return null;
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: workerId,
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: managerId,
        assigneeUserId: null,
        executionState: expect.objectContaining({
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: managerId, userId: null },
          returnAssignee: { type: "agent", agentId: workerId, userId: null },
        }),
      }),
    );
  });

  it("auto-routes top-level C-level in_review to board confirmation", async () => {
    const ctoId = "33333333-3333-4333-8333-333333333333";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: ctoId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      createdByAgentId: null,
      parentId: null,
      identifier: "PAP-1011",
      title: "CTO decision review",
      executionPolicy: null,
      executionState: null,
    };
    mockAgentService.getById.mockResolvedValue({
      id: ctoId,
      companyId: "company-1",
      role: "cto",
      status: "idle",
      reportsTo: "55555555-5555-4555-8555-555555555555",
      permissions: {},
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: ctoId,
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        executionState: expect.objectContaining({
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "user", agentId: null, userId: "local-board" },
          returnAssignee: { type: "agent", agentId: ctoId, userId: null },
        }),
      }),
    );
  });

  it("does not auto-route child C-level in_review to the board without an explicit board path", async () => {
    const ceoId = "33333333-3333-4333-8333-333333333333";
    const child = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      parentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      assigneeAgentId: ceoId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      createdByAgentId: null,
      identifier: "PAP-1012",
      title: "CEO child lane review",
      executionPolicy: null,
      executionState: null,
    };
    const parent = {
      ...child,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      parentId: null,
      assigneeAgentId: ceoId,
      identifier: "PAP-1011",
      title: "Parent lane",
    };
    mockAgentService.getById.mockResolvedValue({
      id: ceoId,
      companyId: "company-1",
      role: "ceo",
      status: "idle",
      reportsTo: null,
      permissions: {},
    });
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === child.id) return child;
      if (id === parent.id) return parent;
      return null;
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: ceoId,
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent-authored in_review transition with a pending confirmation interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
    );
  });

  it("allows an agent-authored in_review transition with a typed execution participant", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1005",
      title: "Execution participant",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: "44444444-4444-4444-8444-444444444444",
          }),
        }),
      }),
    );
  });

  it("allows an agent-authored in_review transition with a scheduled monitor", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1006",
      title: "External review monitor",
      executionPolicy: null,
      executionState: null,
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            scheduledBy: "assignee",
            notes: "Wait for external QA report.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
    );
  });

  it("allows board-authored in_review repair updates without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1007",
      title: "Board repair",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueThreadInteractionService.listForIssue).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("does not auto-start execution review when reviewers are added to an already in_review issue", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-999",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: policy,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBeUndefined();
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(updatePatch.executionState).toBeUndefined();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("lets board users move a pending human task review back to todo without a review comment", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      workItemType: "human_task",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1008",
      title: "Human review escape",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "user", userId: "local-board", agentId: null },
        returnAssignee: { type: "user", userId: "worker-1", agentId: null },
        reviewRequest: null,
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

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "todo",
        executionState: null,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
  });

  it("reassigns a pending human task review as todo work instead of keeping it trapped in review", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      workItemType: "human_task",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1009",
      title: "Human review rework",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "user", userId: "local-board", agentId: null },
        returnAssignee: { type: "user", userId: "worker-1", agentId: null },
        reviewRequest: null,
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

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ assigneeAgentId: null, assigneeUserId: "worker-2" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "worker-2",
        executionState: null,
      }),
    );
  });

  it("triggers a scheduled monitor immediately from the dedicated route", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Manual monitor trigger",
      executionPolicy: normalizeIssueExecutionPolicy({
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      }),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/monitor/check-now")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockHeartbeatService.triggerIssueMonitor).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        actorType: "user",
        actorId: "local-board",
        agentId: null,
      }),
    );
  });

  it("lets a board user create a child issue with a scheduled monitor", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "assignee",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("board");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        details: expect.objectContaining({
          scheduledBy: "board",
        }),
      }),
    );
  });

  it("rejects child monitor scheduling by a non-assignee agent even with task assignment permission", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the assignee agent or a board user can manage issue monitors");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("normalizes spoofed child monitor scheduledBy to the assignee actor", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
            externalRef: "https://example.test/deploy?token=secret",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string; externalRef: string | null } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("assignee");
    expect(createPayload.executionPolicy.monitor.externalRef).toBe("[redacted]");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        details: expect.not.objectContaining({ externalRef: expect.anything() }),
      }),
    );
  });
});
