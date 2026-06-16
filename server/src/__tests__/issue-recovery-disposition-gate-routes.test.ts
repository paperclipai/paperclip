/**
 * Tests for §14 Phase 2: recovery disposition gate (Conditions B, C, D).
 *
 * The gate runs inside PATCH /api/issues/:id for agent actors when:
 *   - the requested next status is "done" or "cancelled"
 *   - the issue has previousAssigneeAgentId set (recovery-reassignment happened)
 *
 * Conditions checked:
 *   B — assigneeAgentId must already be the acting agent (pre-reassignment required)
 *   C — recoveryKind must be present in the payload
 *   D — "done" is blocked on canary/bake-off/measurement-tagged issues
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const recoveryOwnerAgentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const originalAgentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getCurrentScheduledRetry: vi.fn(async () => null),
  getDependencyReadiness: vi.fn(async () => ({ unresolvedBlockerCount: 0 })),
  list: vi.fn(),
  listAttachments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  getById: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  resolveActiveForIssue: vi.fn(async () => null),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/documents.js", () => ({
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => mockWorkProductService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: vi.fn(async () => undefined),
  }));

  vi.doMock("../services/index.js", () => ({
    ISSUE_LIST_DEFAULT_LIMIT: 100,
    ISSUE_LIST_MAX_LIMIT: 500,
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    clampIssueListLimit: (value: number) => Math.min(Math.max(value, 1), 500),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
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
      getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: false })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => ({
      listApprovalsForIssue: vi.fn(async () => []),
    }),
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
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
    workProductService: () => mockWorkProductService,
  }));
}

/** Base issue in recovery-reassignment state: previousAssigneeAgentId is set, already reassigned to recoveryOwner */
function makeRecoveryIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: recoveryOwnerAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    createdByAgentId: null,
    identifier: "SAG-9999",
    title: "Recovery-reassigned issue",
    description: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    workMode: "standard",
    originKind: "manual",
    originId: null,
    originFingerprint: "default",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    sourceTrust: null,
    hiddenAt: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
    monitorLastTriggeredAt: null,
    monitorAttemptCount: 0,
    monitorNotes: null,
    monitorScheduledBy: null,
    issueNumber: 1,
    recoveryKind: null,
    previousAssigneeAgentId: originalAgentId,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-07T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

function recoveryOwnerActor() {
  return {
    type: "agent",
    agentId: recoveryOwnerAgentId,
    companyId,
    source: "agent_key",
    runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  };
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function createSimpleDb() {
  const query = {
    innerJoin: vi.fn(() => query),
    leftJoin: vi.fn(() => query),
    where: vi.fn(() => ({
      orderBy: vi.fn(async () => []),
      then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
    })),
  };
  return {
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({} as never),
    select: vi.fn((_selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => query),
    })),
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(createSimpleDb() as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

describe("§14 recovery disposition gate (SAG-3377)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();

    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: ["tasks:assign", "issue:read", "issue:mutate", "company_scope:read"].includes(input.action),
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test default.",
    }));

    mockIssueService.update.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({
      ...makeRecoveryIssue(),
      ...data,
    }));

    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueRecoveryActionService.resolveActiveForIssue.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);

    mockAgentService.resolveByReference.mockResolvedValue({
      agent: { id: recoveryOwnerAgentId, companyId, status: "active", orgChainHealth: null },
      ambiguous: false,
    });
    mockCompanyService.getById.mockResolvedValue({ id: companyId });
  });

  describe("Condition C — recoveryKind required for recovery-context closures", () => {
    it("rejects done without recoveryKind when previousAssigneeAgentId is set", async () => {
      mockIssueService.getById.mockResolvedValue(makeRecoveryIssue());
      const app = await createApp(recoveryOwnerActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ status: "done" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("recovery_disposition_condition_c_violation");
    });

    it("rejects cancelled without recoveryKind when previousAssigneeAgentId is set", async () => {
      mockIssueService.getById.mockResolvedValue(makeRecoveryIssue());
      const app = await createApp(recoveryOwnerActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ status: "cancelled" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("recovery_disposition_condition_c_violation");
    });

    it("allows done with recoveryKind when all conditions are met", async () => {
      mockIssueService.getById.mockResolvedValue(makeRecoveryIssue());
      const app = await createApp(recoveryOwnerActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ status: "done", recoveryKind: "recovery_completion" });

      expect(res.status).not.toBe(422);
      expect(res.body.code).not.toBe("recovery_disposition_condition_c_violation");
    });
  });

  describe("Condition B — assigneeAgentId must already be the recovery owner", () => {
    // Condition B requires the recovery owner to pre-reassign (separate PATCH) before closing.
    // When the issue is still assigned to another agent, the existing checkout ownership check
    // rejects with 409 (checked-out by another agent). This is acceptable: any 4xx enforcement
    // satisfies the "cannot close without prior reassignment" invariant.
    it("rejects with 4xx when assigneeAgentId is still the original agent", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeRecoveryIssue({ assigneeAgentId: originalAgentId }),
      );
      const app = await createApp(recoveryOwnerActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ status: "done", recoveryKind: "recovery_completion" });

      // 409 from checkout ownership check — recoveryOwner is not yet the assignee
      expect(res.status).toBe(409);
    });

    it("rejects with 4xx when actor tries to both reassign and close in one call", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeRecoveryIssue({ assigneeAgentId: originalAgentId }),
      );
      const app = await createApp(recoveryOwnerActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({
          status: "done",
          recoveryKind: "recovery_completion",
          assigneeAgentId: recoveryOwnerAgentId,
        });

      // Condition B is checked against the current DB state (existing.assigneeAgentId), not the patch.
      // The checkout ownership check catches this before the recovery gate runs.
      expect(res.status).toBe(409);
    });
  });

  describe("Condition D — measurement-context issues block done", () => {
    it("rejects done on canary-labelled recovery issue", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeRecoveryIssue({ labels: [{ id: "l1", name: "canary", color: "#ff0000", companyId, createdAt: new Date(), updatedAt: new Date() }] }),
      );
      const app = await createApp(recoveryOwnerActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ status: "done", recoveryKind: "recovery_completion" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("recovery_disposition_condition_d_violation");
    });

    it("rejects done on bake-off-labelled recovery issue", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeRecoveryIssue({ labels: [{ id: "l2", name: "bake-off", color: "#00ff00", companyId, createdAt: new Date(), updatedAt: new Date() }] }),
      );
      const app = await createApp(recoveryOwnerActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ status: "done", recoveryKind: "recovery_completion" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("recovery_disposition_condition_d_violation");
    });

    it("allows cancelled with recoveryKind on measurement-labelled recovery issue (harness-FAIL path)", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeRecoveryIssue({ labels: [{ id: "l3", name: "measurement", color: "#0000ff", companyId, createdAt: new Date(), updatedAt: new Date() }] }),
      );
      const app = await createApp(recoveryOwnerActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ status: "cancelled", recoveryKind: "measurement_bar" });

      expect(res.status).not.toBe(422);
      // Condition D only blocks "done" — "cancelled" with recoveryKind is the harness-FAIL path
      expect(res.body.code).not.toBe("recovery_disposition_condition_d_violation");
    });
  });

  describe("Condition ordering — B evaluated before D", () => {
    it("returns condition_b_violation (not condition_d) when assigneeAgentId is null on a measurement-tagged recovery issue", async () => {
      // When a recovery issue has no current assignee (assigneeAgentId=null), assertAgentIssueMutationAllowed
      // passes (null assignee allows any agent). The recovery gate then receives a non-self-assigned actor
      // trying to close a measurement-tagged issue. With old ordering (D before B) this yields
      // condition_d_violation; with correct ordering (B before D) Condition B fires first.
      mockIssueService.getById.mockResolvedValue(
        makeRecoveryIssue({
          assigneeAgentId: null, // unassigned — mutation check passes for any agent
          labels: [{ id: "l1", name: "canary", color: "#ff0000", companyId, createdAt: new Date(), updatedAt: new Date() }],
        }),
      );
      const anyAgentActor = {
        type: "agent",
        agentId: originalAgentId, // actor is NOT null-assignee's equivalent (null !== originalAgentId)
        companyId,
        source: "agent_key",
        runId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      };
      const app = await createApp(anyAgentActor);

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ status: "done", recoveryKind: "recovery_completion" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("recovery_disposition_condition_b_violation");
    });
  });

  describe("recoveryKind audit integrity — cannot be erased by follow-up PATCH", () => {
    it("rejects a PATCH that sets recoveryKind to null after it was already set", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeRecoveryIssue({ recoveryKind: "recovery_completion" }),
      );
      const app = await createApp(recoveryOwnerActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ recoveryKind: null });

      // Zod schema no longer accepts null for recoveryKind — request is rejected at validation layer
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
    });
  });

  describe("gate bypass conditions", () => {
    it("bypasses when previousAssigneeAgentId is null (normal self-disposal)", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeRecoveryIssue({ previousAssigneeAgentId: null }),
      );
      const app = await createApp(recoveryOwnerActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ status: "done" });

      // Should not get a recovery gate error
      expect(String(res.body.code ?? "")).not.toMatch(/^recovery_disposition_condition/);
    });

    it("bypasses for board actor even with previousAssigneeAgentId set", async () => {
      mockIssueService.getById.mockResolvedValue(makeRecoveryIssue());
      const app = await createApp(boardActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ status: "done" });

      // Board bypasses the gate — no recovery disposition error
      expect(String(res.body.code ?? "")).not.toMatch(/^recovery_disposition_condition/);
    });

    it("bypasses when status is not done or cancelled", async () => {
      mockIssueService.getById.mockResolvedValue(makeRecoveryIssue());
      const app = await createApp(recoveryOwnerActor());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("Content-Type", "application/json")
        .send({ status: "blocked", blockedByIssueIds: [] });

      expect(String(res.body.code ?? "")).not.toMatch(/^recovery_disposition_condition/);
    });
  });
});
