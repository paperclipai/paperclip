import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const ownerRunId = "55555555-5555-4555-8555-555555555555";
const recoveryActionId = "77777777-7777-4777-8777-777777777777";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  decomposeAcceptedPlan: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  list: vi.fn(),
  listAttachments: vi.fn(),
  listComments: vi.fn(),
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
  expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  link: vi.fn(),
  unlink: vi.fn(),
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  resolveActiveForIssue: vi.fn(async () => null),
}));
const mockTaskWatchdogService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  revalidateMutationScope: vi.fn(async () => ({
    allowed: true,
    classification: { state: "stopped", stopFingerprint: "task_watchdog_stop:test" },
  })),
  reconcileForIssueAndAncestors: vi.fn(async () => ({
    checked: 0,
    triggered: 0,
    skipped: 0,
    watchdogIssueIds: [],
  })),
  upsertForIssue: vi.fn(),
  disableForIssue: vi.fn(async () => null),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  getIssueSummaries: vi.fn(async () => new Map()),
  getIssueSummary: vi.fn(async () => ({
    authRequiredCount: 0,
    byLiveness: {},
    byStatusCategory: {},
    highestSeverity: "muted",
    objects: [],
    staleCount: 0,
    total: 0,
    unreachableCount: 0,
  })),
  getProjectSummary: vi.fn(async () => ({
    authRequiredCount: 0,
    byLiveness: {},
    byStatusCategory: {},
    highestSeverity: "muted",
    objects: [],
    staleCount: 0,
    total: 0,
    unreachableCount: 0,
  })),
  listForIssue: vi.fn(async () => []),
  refreshIssueObjects: vi.fn(async () => []),
  syncCommentSafely: vi.fn(async () => undefined),
  syncDocumentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

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

  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => mockExternalObjectService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    ISSUE_LIST_DEFAULT_LIMIT: 100,
    ISSUE_LIST_MAX_LIMIT: 500,
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    clampIssueListLimit: (value: number) => Math.min(Math.max(value, 1), 500),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
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
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
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
    taskWatchdogService: () => mockTaskWatchdogService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1649",
    title: "Owned active issue",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId,
    role: "engineer",
    reportsTo: null,
    permissions: { canCreateAgents: false },
    ...overrides,
  };
}

function createRunContextDb(
  contextSnapshot: Record<string, unknown> = {},
  runAgentOrRows: string | Record<string, unknown>[] = ownerAgentId,
  runId: string = ownerRunId,
) {
  const runRows = Array.isArray(runAgentOrRows)
    ? runAgentOrRows
    : [{
        id: runId,
        companyId,
        agentId: runAgentOrRows,
        agentCompanyId: companyId,
        contextSnapshot,
      }];
  const firstRun = runRows[0] ?? {};
  const runAgentId = typeof firstRun.agentId === "string" ? firstRun.agentId : ownerAgentId;
  const runAgentCompanyId = typeof firstRun.agentCompanyId === "string" ? firstRun.agentCompanyId : companyId;
  const rowsForSelection = (selection: Record<string, unknown>) => {
    const keys = Object.keys(selection);
    if (keys.includes("entityId")) return [];
    if (keys.includes("contextSnapshot")) return runRows;
    if (keys.includes("agentCompanyId")) return runRows;
    return [{ id: runAgentId, companyId: runAgentCompanyId, permissions: {}, role: "engineer", reportsTo: null }];
  };
  const buildQuery = (selection: Record<string, unknown>) => {
    const rows = rowsForSelection(selection);
    const whereResult = {
      orderBy: vi.fn(async () => []),
      limit: vi.fn(() => ({
        then: async (resolve: (limitedRows: unknown[]) => unknown) => resolve(rows),
      })),
      then: async (resolve: (selectedRows: unknown[]) => unknown) => resolve(rows),
    };
    const query = {
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => whereResult),
    };
    return query;
  };
  return {
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => buildQuery(selection)),
    })),
  };
}

async function createApp(actor: Record<string, unknown>, db?: unknown) {
  const routeDb = db ?? createRunContextDb(
    {},
    typeof actor.agentId === "string" ? actor.agentId : ownerAgentId,
    typeof actor.runId === "string" ? actor.runId : ownerRunId,
  );
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
  app.use("/api", issueRoutes(routeDb as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function peerActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: peerAgentId,
    companyId,
    source: "agent_key",
    runId: "66666666-6666-4666-8666-666666666666",
    ...overrides,
  };
}

function ownerActor() {
  return {
    type: "agent",
    agentId: ownerAgentId,
    companyId,
    source: "agent_key",
    runId: ownerRunId,
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

describe("agent issue mutation checkout ownership", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/external-objects.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed:
        input.action === "tasks:assign" ||
        input.action === "issue:comment" ||
        input.action === "issue:read" ||
        input.action === "issue:mutate" ||
        input.action === "company_scope:read",
      action: input.action,
      reason:
        input.action === "tasks:assign" ||
          input.action === "issue:comment" ||
          input.action === "issue:read" ||
          input.action === "issue:mutate" ||
          input.action === "company_scope:read"
          ? "allow_explicit_grant"
          : "deny_missing_grant",
      explanation:
        input.action === "tasks:assign" ||
          input.action === "issue:comment" ||
          input.action === "issue:read" ||
          input.action === "issue:mutate" ||
          input.action === "company_scope:read"
          ? "Allowed by test default."
          : "Missing permission.",
    }));
    mockAccessService.hasPermission.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockCompanyService.getById.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
    mockIssueService.decomposeAcceptedPlan.mockReset();
    mockIssueService.getAttachmentById.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.getComment.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      blockerIssueIds: [],
      isDependencyReady: false,
      unresolvedBlockerCount: 0,
    });
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockIssueService.list.mockReset();
    mockIssueService.listAttachments.mockReset();
    mockIssueService.listComments.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireStaleRequestConfirmationsForIssueDocument.mockReset();
    mockIssueThreadInteractionService.expireStaleRequestConfirmationsForIssueDocument.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockResolvedValue([]);
    mockIssueThreadInteractionService.listForIssue.mockReset();
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueRecoveryActionService.listActiveForIssues.mockReset();
    mockIssueRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
    mockIssueRecoveryActionService.resolveActiveForIssue.mockReset();
    mockIssueRecoveryActionService.resolveActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      recoveryIssueId: null,
      kind: "issue_graph_liveness",
      status: "resolved",
      ownerType: "agent",
      ownerAgentId,
      ownerUserId: null,
      previousOwnerAgentId: null,
      returnOwnerAgentId: null,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:test",
      evidence: {},
      nextAction: "Restore a live execution path.",
      wakePolicy: null,
      monitorPolicy: null,
      attemptCount: 1,
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: new Date("2026-05-13T18:00:00.000Z"),
      outcome: "restored",
      resolutionNote: "Resolved by recovery owner",
      resolvedAt: new Date("2026-05-13T18:05:00.000Z"),
      createdAt: new Date("2026-05-13T17:55:00.000Z"),
      updatedAt: new Date("2026-05-13T18:05:00.000Z"),
    });
    mockTaskWatchdogService.getActiveForIssue.mockReset();
    mockTaskWatchdogService.getActiveForIssue.mockResolvedValue(null);
    mockTaskWatchdogService.revalidateMutationScope.mockReset();
    mockTaskWatchdogService.revalidateMutationScope.mockResolvedValue({
      allowed: true,
      classification: { state: "stopped", stopFingerprint: "task_watchdog_stop:test" },
    });
    mockTaskWatchdogService.reconcileForIssueAndAncestors.mockReset();
    mockTaskWatchdogService.reconcileForIssueAndAncestors.mockResolvedValue({
      checked: 0,
      triggered: 0,
      skipped: 0,
      watchdogIssueIds: [],
    });
    mockTaskWatchdogService.upsertForIssue.mockReset();
    mockTaskWatchdogService.disableForIssue.mockReset();
    mockTaskWatchdogService.disableForIssue.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockReset();
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockIssueApprovalService.link.mockReset();
    mockIssueApprovalService.unlink.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.listForIssue.mockReset();
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueService.remove.mockReset();
    mockIssueService.removeAttachment.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockLogActivity.mockClear();
    mockDocumentService.upsertIssueDocument.mockReset();
    mockWorkProductService.createForIssue.mockReset();
    mockExternalObjectService.getIssueSummaries.mockClear();
    mockExternalObjectService.getIssueSummary.mockClear();
    mockExternalObjectService.getProjectSummary.mockClear();
    mockExternalObjectService.listForIssue.mockClear();
    mockExternalObjectService.refreshIssueObjects.mockClear();
    mockExternalObjectService.syncCommentSafely.mockClear();
    mockExternalObjectService.syncDocumentSafely.mockClear();
    mockExternalObjectService.syncIssueSafely.mockClear();
    mockWorkProductService.getById.mockReset();
    mockWorkProductService.remove.mockReset();
    mockWorkProductService.update.mockReset();
    mockStorageService.putFile.mockReset();
    mockStorageService.getObject.mockReset();
    mockStorageService.headObject.mockReset();
    mockStorageService.deleteObject.mockReset();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === ownerAgentId) return makeAgent(ownerAgentId);
      if (id === peerAgentId) return makeAgent(peerAgentId);
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      makeAgent(ownerAgentId),
      makeAgent(peerAgentId),
    ]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "PAP" });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getComment.mockResolvedValue({
      id: "comment-1",
      issueId,
      companyId,
      body: "Mentioned reply context.",
    });
    mockIssueService.list.mockResolvedValue([makeIssue()]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      ...makeIssue({
        id: "88888888-8888-4888-8888-888888888888",
        status: "todo",
        assigneeAgentId: null,
      }),
      ...input,
      companyId,
    }));
    mockIssueService.createChild.mockImplementation(async (_parentId: string, input: Record<string, unknown>) => ({
      issue: {
        ...makeIssue({
          id: "99999999-9999-4999-8999-999999999999",
          status: "todo",
          parentId: issueId,
          assigneeAgentId: null,
        }),
        ...input,
        companyId,
      },
      parentBlockerAdded: false,
    }));
    mockIssueService.decomposeAcceptedPlan.mockImplementation(async (_sourceIssueId: string, input: Record<string, unknown>) => {
      const children = input.children as Record<string, unknown>[];
      return {
        decomposition: {
          id: "decomposition-1",
          status: "completed",
          childIssueIds: children.map((child) => child.id),
        },
        childIssueIds: children.map((child) => child.id),
        newlyCreatedIssues: children.map((child) => ({
          ...makeIssue({
            id: child.id,
            parentId: issueId,
            status: child.status,
            assigneeAgentId: child.assigneeAgentId ?? null,
          }),
          ...child,
          companyId,
        })),
      };
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      issueId,
      companyId,
      body: "comment",
    });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "comment-1",
        issueId,
        companyId,
        body: "Mentioned reply context.",
      },
    ]);
    mockIssueService.remove.mockResolvedValue(makeIssue({ status: "cancelled" }));
    mockIssueService.getAttachmentById.mockResolvedValue({
      id: "attachment-1",
      issueId,
      companyId,
      objectKey: "issues/attachment-1/report.txt",
      contentType: "text/plain",
      byteSize: 6,
      originalFilename: "report.txt",
    });
    mockIssueService.removeAttachment.mockResolvedValue({
      id: "attachment-1",
      issueId,
      companyId,
      objectKey: "issues/attachment-1/report.txt",
    });
    mockDocumentService.upsertIssueDocument.mockResolvedValue({
      created: false,
      document: {
        id: "document-1",
        key: "plan",
        title: "Plan",
        format: "markdown",
        latestRevisionNumber: 2,
      },
    });
    mockWorkProductService.createForIssue.mockResolvedValue({
      id: "product-2",
      issueId,
      companyId,
      type: "artifact",
      provider: "test",
      title: "Artifact",
    });
    mockWorkProductService.getById.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
    });
    mockWorkProductService.update.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
      title: "Updated",
    });
    mockWorkProductService.remove.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
    });
    mockStorageService.putFile.mockResolvedValue({
      provider: "local_disk",
      objectKey: "issues/upload.txt",
      contentType: "text/plain",
      byteSize: 6,
      sha256: "sha256",
      originalFilename: "upload.txt",
    });
    mockStorageService.getObject.mockResolvedValue({
      stream: Readable.from(Buffer.from("report")),
      contentLength: 6,
    });
    mockStorageService.deleteObject.mockResolvedValue(undefined);
  });

  it("denies company-wide issue list routes for task bridge keys", async () => {
    const app = await createApp(peerActor({
      keyId: "99999999-9999-4999-8999-999999999999",
      keyScope: {
        kind: "task_bridge",
        parentIssueId: issueId,
      },
    }));

    const res = await request(app).get(`/api/companies/${companyId}/issues`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Task bridge keys cannot use company-wide issue list APIs");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("uses the company-scope fast path on the issue list route", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
      if (input.action === "company_scope:read") {
        return {
          allowed: true,
          action: input.action,
          reason: "allow_explicit_grant",
          explanation: "Allowed by test company scope.",
        };
      }
      if (input.action === "issue:read") {
        throw new Error("issue:read should not be evaluated for company-scope readers");
      }
      return {
        allowed: true,
        action: input.action,
        reason: "allow_test_default",
        explanation: "Allowed by test default.",
      };
    });

    const app = await createApp(boardActor());
    const res = await request(app).get(`/api/companies/${companyId}/issues`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: issueId })]);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "company_scope:read",
      resource: { type: "company", companyId },
    }));
    expect(mockAccessService.decide).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "issue:read",
    }));
  });

  it.each([
    ["patch", (app: express.Express) => request(app).patch(`/api/issues/${issueId}`).send({ title: "Blocked" })],
    ["delete", (app: express.Express) => request(app).delete(`/api/issues/${issueId}`)],
    [
      "document upsert",
      (app: express.Express) =>
        request(app).put(`/api/issues/${issueId}/documents/plan`).send({ format: "markdown", body: "# blocked" }),
    ],
    ["work product update", (app: express.Express) => request(app).patch("/api/work-products/product-1").send({ title: "Blocked" })],
    [
      "low-trust promotion",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/low-trust/promotions`).send({
          sourceArtifactKind: "comment",
          sourceArtifactId: recoveryActionId,
          title: "Promoted artifact",
          summary: "Sanitized output",
        }),
    ],
    [
      "attachment upload",
      (app: express.Express) =>
        request(app)
          .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
          .attach("file", Buffer.from("report"), { filename: "report.txt", contentType: "text/plain" }),
    ],
    ["attachment delete", (app: express.Express) => request(app).delete("/api/attachments/attachment-1")],
  ])("rejects peer agent %s on another agent's active checkout", async (_name, sendRequest) => {
    const res = await sendRequest(await createApp(peerActor()));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockDocumentService.upsertIssueDocument).not.toHaveBeenCalled();
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
    expect(mockStorageService.deleteObject).not.toHaveBeenCalled();
  });

  it("allows mentioned peer agents to post comments without ownership of an active checkout", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:comment",
      action: input.action,
      reason: input.action === "issue:comment" ? "allow_issue_mention_grant" : "deny_missing_grant",
      explanation:
        input.action === "issue:comment"
          ? "Allowed by a mention-scoped issue comment grant."
          : "Missing permission.",
    }));

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "I can respond here." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "I can respond here.",
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects non-mentioned peer agents from posting comments", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:read",
      action: input.action,
      reason: input.action === "issue:read" ? "allow_explicit_grant" : "deny_missing_grant",
      explanation: input.action === "issue:read" ? "Allowed by test read grant." : "Missing permission.",
    }));

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "I was not mentioned." });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Issue is outside this actor's authorization boundary");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects peer agents from listing comments when issue read is outside their boundary", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_low_trust_boundary",
      explanation: "Issue is outside this low-trust boundary.",
    }));

    const res = await request(await createApp(peerActor()))
      .get(`/api/issues/${issueId}/comments`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Issue is outside this actor's authorization boundary");
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read" }));
  });

  it("rejects peer agents from listing interactions when issue read is outside their boundary", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_low_trust_boundary",
      explanation: "Issue is outside this low-trust boundary.",
    }));

    const res = await request(await createApp(peerActor()))
      .get(`/api/issues/${issueId}/interactions`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Issue is outside this actor's authorization boundary");
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read" }));
    expect(mockIssueThreadInteractionService.listForIssue).not.toHaveBeenCalled();
  });

  it("allows mentioned peer agents to list comments through an issue read grant", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:read",
      action: input.action,
      reason: input.action === "issue:read" ? "allow_issue_mention_grant" : "deny_missing_grant",
      explanation:
        input.action === "issue:read"
          ? "Allowed by a mention-scoped issue comment grant."
          : "Missing permission.",
    }));

    const res = await request(await createApp(peerActor()))
      .get(`/api/issues/${issueId}/comments`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "comment-1",
        body: "Mentioned reply context.",
      }),
    ]);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read" }));
    expect(mockIssueService.listComments).toHaveBeenCalledWith(issueId, {
      afterCommentId: null,
      order: "desc",
      limit: null,
    });
  });

  it("rejects peer agents from reading a specific comment when issue read is outside their boundary", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_low_trust_boundary",
      explanation: "Issue is outside this low-trust boundary.",
    }));

    const res = await request(await createApp(peerActor()))
      .get(`/api/issues/${issueId}/comments/comment-1`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Issue is outside this actor's authorization boundary");
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read" }));
    expect(mockIssueService.getComment).not.toHaveBeenCalled();
  });

  it("keeps true issue mutations denied for mentioned peer agents", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "todo", assigneeAgentId: ownerAgentId }));
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:comment" || input.action === "issue:mutate",
      action: input.action,
      reason:
        input.action === "issue:comment"
          ? "allow_issue_mention_grant"
          : input.action === "issue:mutate"
            ? "allow_explicit_grant"
            : "deny_missing_grant",
      explanation:
        input.action === "issue:comment"
          ? "Allowed by a mention-scoped issue comment grant."
          : input.action === "issue:mutate"
            ? "Allowed by test boundary default."
            : "Missing permission.",
    }));

    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("denies cross-company agents before comment authorization is evaluated", async () => {
    const res = await request(await createApp(peerActor({ companyId: "99999999-9999-4999-8999-999999999999" })))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Wrong company." });

    // Cross-tenant requests return 404 (not 403) so the response is
    // indistinguishable from a nonexistent issue — no existence oracle.
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
    expect(mockAccessService.decide).not.toHaveBeenCalledWith(expect.objectContaining({ action: "issue:comment" }));
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects the checked-out owner without a run id on attachment upload (401)", async () => {
    // Regression: an agent-authenticated client (e.g. the CLI's attachment:upload)
    // that fails to send X-Paperclip-Run-Id must be rejected — mutating your own
    // in-progress checkout requires proving run ownership.
    const app = await createApp({
      type: "agent",
      agentId: ownerAgentId,
      companyId,
      source: "agent_key",
      // intentionally no runId
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
      .attach("file", Buffer.from("report"), { filename: "report.html", contentType: "text/html" });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error).toBe("Agent run id required");
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
  });

  it("allows the checked-out owner with the matching run id to patch and update documents", async () => {
    const app = await createApp(ownerActor());

    await request(app).patch(`/api/issues/${issueId}`).send({ title: "Updated" }).expect(200);
    await request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# updated" })
      .expect(200);

    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, ownerAgentId, ownerRunId);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId,
        key: "plan",
        createdByAgentId: ownerAgentId,
        createdByRunId: ownerRunId,
        lockedDocumentStrategy: "create_new_document",
      }),
    );
  });

  it("stores the authenticated agent run id when creating work products", async () => {
    const app = await createApp(ownerActor());

    await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
    }).expect(201);

    expect(mockWorkProductService.createForIssue).toHaveBeenCalledWith(
      issueId,
      companyId,
      expect.objectContaining({ createdByRunId: ownerRunId }),
    );
  });

  it("rejects agent-created work products with a forged run id", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId must match the authenticated agent run");
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
  });

  it("rejects work product updates with a forged agent run id", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app).patch("/api/work-products/product-1").send({
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId must match the authenticated agent run");
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
  });

  it("rejects board-created work products with a foreign-company run id", async () => {
    const app = await createApp(
      boardActor(),
      createRunContextDb({}, [{
        id: "66666666-6666-4666-8666-666666666666",
        companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        agentCompanyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contextSnapshot: {},
      }]),
    );

    const res = await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId is not valid for this company");
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
  });

  it.each([
    [
      "work product create",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/work-products`).send({
          type: "artifact",
          provider: "test",
          title: "Artifact",
        }),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "work product update",
      (app: express.Express) => request(app).patch("/api/work-products/product-1").send({ title: "Blocked" }),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "work product delete",
      (app: express.Express) => request(app).delete("/api/work-products/product-1"),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "low-trust promotion",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/low-trust/promotions`).send({
          sourceArtifactKind: "comment",
          sourceArtifactId: recoveryActionId,
          title: "Promoted artifact",
          summary: "Sanitized output",
        }),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "attachment upload",
      (app: express.Express) =>
        request(app)
          .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
          .attach("file", Buffer.from("report"), { filename: "report.txt", contentType: "text/plain" }),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "attachment delete",
      (app: express.Express) => request(app).delete("/api/attachments/attachment-1"),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "issue approval link",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/approvals`).send({
          approvalId: "88888888-8888-4888-8888-888888888888",
        }),
      "Cheap status-only recovery runs cannot create or modify approvals",
    ],
    [
      "issue approval unlink",
      (app: express.Express) =>
        request(app).delete(`/api/issues/${issueId}/approvals/88888888-8888-4888-8888-888888888888`),
      "Cheap status-only recovery runs cannot create or modify approvals",
    ],
  ])("blocks cheap status-only recovery runs from %s", async (_name, sendRequest, expectedError) => {
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      }),
    );

    const res = await sendRequest(app);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain(expectedError);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, ownerAgentId, ownerRunId);
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
    expect(mockWorkProductService.remove).not.toHaveBeenCalled();
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
    expect(mockStorageService.deleteObject).not.toHaveBeenCalled();
    expect(mockIssueService.removeAttachment).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.link).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.unlink).not.toHaveBeenCalled();
  });

  it.each([
    [
      "issue create",
      (app: express.Express) =>
        request(app).post(`/api/companies/${companyId}/issues`).send({
          title: "Downstream source work",
          assigneeAdapterOverrides: { modelProfile: "cheap" },
        }),
    ],
    [
      "child issue create",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/children`).send({
          title: "Downstream child source work",
          assigneeAdapterOverrides: { modelProfile: "cheap" },
        }),
    ],
    [
      "issue update",
      (app: express.Express) =>
        request(app).patch(`/api/issues/${issueId}`).send({
          assigneeAdapterOverrides: { modelProfile: "cheap" },
        }),
    ],
  ])("blocks cheap status-only recovery runs from propagating cheap profile through %s", async (_name, sendRequest) => {
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      }),
    );

    const res = await sendRequest(app);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("cannot assign downstream issue work to the cheap model profile");
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("defaults agent-created root follow-up issues to inherit the current run workspace", async () => {
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        issueId,
        executionWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Follow-up in same worktree",
        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Follow-up in same worktree",
        inheritExecutionWorkspaceFromIssueId: issueId,
      }),
    );
  });

  it("preserves explicit workspace choices on agent-created root issues", async () => {
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        issueId,
        executionWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );

    const explicitExecutionWorkspaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Explicit different workspace",
        executionWorkspaceId: explicitExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Explicit different workspace",
        executionWorkspaceId: explicitExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      }),
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.not.objectContaining({
        inheritExecutionWorkspaceFromIssueId: issueId,
      }),
    );
  });

  it("rejects agent-created issues that supply responsibleUserId", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Spoof responsible user",
        responsibleUserId: "spoofed-user",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("responsibleUserId");
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "agent",
        actorId: ownerAgentId,
        action: "issue.attribution_spoof_rejected",
        entityType: "company",
        details: expect.objectContaining({
          surface: "issues.create",
          field: "responsibleUserId",
          requestedValue: "spoofed-user",
        }),
      }),
    );
  });

  it("strips agent-supplied createdByUserId and derives attribution from the authenticated actor", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Spoof creator",
        createdByUserId: "spoofed-user",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Spoof creator",
        createdByAgentId: ownerAgentId,
        createdByUserId: null,
        actorRunId: ownerRunId,
      }),
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.not.objectContaining({
        createdByUserId: "spoofed-user",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "agent",
        actorId: ownerAgentId,
        action: "issue.attribution_spoof_stripped",
        details: expect.objectContaining({
          surface: "issues.create",
          field: "createdByUserId",
          requestedValue: "spoofed-user",
        }),
      }),
    );
  });

  it("allows board-created issues to pass explicit responsibleUserId as trusted attribution", async () => {
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Board-owned work",
        responsibleUserId: "responsible-board-user",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Board-owned work",
        responsibleUserId: "responsible-board-user",
        createdByUserId: "board-user",
        trustExplicitResponsibleUserId: true,
      }),
    );
  });

  it("rejects agent-created child issues that supply responsibleUserId", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app)
      .post(`/api/issues/${issueId}/children`)
      .send({
        title: "Spoof child responsible user",
        responsibleUserId: "spoofed-user",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        action: "issue.attribution_spoof_rejected",
        entityType: "issue",
        entityId: issueId,
        details: expect.objectContaining({
          surface: "issues.children.create",
          field: "responsibleUserId",
        }),
      }),
    );
  });

  it("rejects accepted-plan child creation when an agent child body supplies responsibleUserId", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app)
      .post(`/api/issues/${issueId}/accepted-plan-decompositions`)
      .send({
        acceptedPlanRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        children: [
          {
            title: "Spoof plan child responsible user",
            responsibleUserId: "spoofed-user",
          },
        ],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockIssueService.decomposeAcceptedPlan).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        action: "issue.attribution_spoof_rejected",
        entityType: "issue",
        entityId: issueId,
        details: expect.objectContaining({
          surface: "issues.accepted_plan_decomposition",
          field: "responsibleUserId",
        }),
      }),
    );
  });

  it("allows board users to set explicit cheap issue assignee profile overrides", async () => {
    const app = await createApp(boardActor());

    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAdapterOverrides: { modelProfile: "cheap" } })
      .expect(200);

    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({
        assigneeAdapterOverrides: { modelProfile: "cheap" },
      }),
    );
  });

  it("preserves committed issue updates, comments, documents, and work product writes when recovery revalidation fails", async () => {
    const app = await createApp(ownerActor());

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Updated after commit" })
      .expect(200);

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "progress update" })
      .expect(201);

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# updated" })
      .expect(200);

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .patch("/api/work-products/product-1")
      .send({ title: "Updated product" })
      .expect(200);

    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ title: "Updated after commit" }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "progress update",
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalled();
    expect(mockWorkProductService.update).toHaveBeenCalledWith("product-1", { title: "Updated product" });
  });

  it("preserves board mutations on active checkouts", async () => {
    const app = await createApp(boardActor());

    await request(app).patch(`/api/issues/${issueId}`).send({ title: "Board update" }).expect(200);
    await request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# board" })
      .expect(200);

    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalled();
  });

  it("allows agents with the active-checkout management grant to mutate active checkouts", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:mutate" || input.action === "tasks:manage_active_checkouts",
      action: input.action,
      reason:
        input.action === "issue:mutate" || input.action === "tasks:manage_active_checkouts"
          ? "allow_explicit_grant"
          : "deny_missing_grant",
      explanation:
        input.action === "tasks:manage_active_checkouts"
          ? "Allowed by checkout management grant."
          : input.action === "issue:mutate"
            ? "Allowed by test boundary default."
            : "Missing permission.",
    }));

    const res = await request(await createApp(peerActor())).patch(`/api/issues/${issueId}`).send({ title: "Managed update" });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it.each([
    ["todo", "patch", (app: express.Express) => request(app).patch(`/api/issues/${issueId}`).send({ title: "Todo update" })],
    ["blocked", "patch", (app: express.Express) => request(app).patch(`/api/issues/${issueId}`).send({ title: "Blocked update" })],
  ])("rejects peer agent %s issue %s mutations outside active checkout ownership", async (status, _kind, sendRequest) => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: status as "todo" | "blocked", assigneeAgentId: ownerAgentId }));

    const res = await sendRequest(await createApp(peerActor()));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("allows same-company agent mutations on unassigned in-progress issues", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: null }));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({ assigneeAgentId: null }),
      ...patch,
    }));

    const res = await request(await createApp(peerActor())).patch(`/api/issues/${issueId}`).send({ title: "Claimable update" });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      id: issueId,
      assigneeAgentId: null,
      title: "Claimable update",
    });
  });

  it.each([
    ["board", "board"],
    ["a company user", { userId: "board-user" }],
  ])("rejects an agent naming %s as unblock owner", async (_label, unblockOwner) => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress" }));

    const res = await request(await createApp(ownerActor())).patch(`/api/issues/${issueId}`).send({
      status: "blocked",
      unblockDescriptor: { owner: unblockOwner, action: "Review the blocker" },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agents may only name themselves as an unblock owner");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["board", "board"],
    ["a company user", { userId: "board-user" }],
  ])("rejects an agent changing an already-blocked issue owner to %s", async (_label, unblockOwner) => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked" }));

    const res = await request(await createApp(ownerActor())).patch(`/api/issues/${issueId}`).send({
      unblockDescriptor: { owner: unblockOwner, action: "Review the blocker" },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agents may only name themselves as an unblock owner");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows a board actor to name the board as unblock owner", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({ status: "in_progress" }),
      ...patch,
    }));

    const res = await request(await createApp(boardActor())).patch(`/api/issues/${issueId}`).send({
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Review the blocker" },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Review the blocker" },
      }),
    );
  });

  it("rejects peer-agent status updates that would clear a recovery action they do not own", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
    );
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    });

    const res = await request(await createApp(peerActor())).patch(`/api/issues/${issueId}`).send({ status: "todo" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot resolve another owner's recovery action");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects peer-agent recovery resolution on a board-owned source issue", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
    );
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    });

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      .send({
        actionId: recoveryActionId,
        outcome: "restored",
        sourceIssueStatus: "done",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot resolve another owner's recovery action");
    expect(mockIssueRecoveryActionService.resolveActiveForIssue).not.toHaveBeenCalled();
  });

  it("allows the named recovery owner to resolve a board-owned source issue", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
      ...patch,
    }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    });

    const res = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      .send({
        actionId: recoveryActionId,
        outcome: "restored",
        sourceIssueStatus: "done",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockIssueRecoveryActionService.resolveActiveForIssue).toHaveBeenCalled();
  });

  it("wakes the assigned agent when recovery resolution restores a source issue to todo", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }),
      ...patch,
    }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    });

    const res = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      .send({
        actionId: recoveryActionId,
        outcome: "restored",
        sourceIssueStatus: "todo",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ownerAgentId,
      expect.objectContaining({
        reason: "issue_recovery_action_restored",
        payload: expect.objectContaining({
          issueId,
          recoveryActionId,
          mutation: "recovery_action_resolution",
        }),
      }),
    );
  });

  it("uses the authorization decision path for assignment changes", async () => {
    const decide = vi.fn(async () => ({
      allowed: false,
      action: "tasks:assign",
      reason: "deny_policy_restricted",
      explanation: "Target agent requires approval before task assignment.",
    }));
    decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:mutate",
      action: input.action,
      reason: input.action === "issue:mutate" ? "allow_self" : "deny_policy_restricted",
      explanation:
        input.action === "issue:mutate"
          ? "Allowed because the actor owns the assigned issue."
          : "Target agent requires approval before task assignment.",
    }));
    (mockAccessService as any).decide = decide;
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent(peerAgentId),
    });

    const app = await createApp(ownerActor());
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: peerAgentId });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("requires approval");
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "tasks:assign",
      resource: expect.objectContaining({
        type: "issue",
        companyId,
        issueId,
        assigneeAgentId: peerAgentId,
      }),
    }));
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  describe("task watchdog scope grants", () => {
    const watchdogRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
    const watchdogReportIssueId = "cccccccc-cccc-4ccc-8ccc-cccccccccccd";

    // The watchdog agent (peerAgentId) is NOT the assignee of the watched issue
    // (ownerAgentId), so the base authorization boundary (issue:mutate) denies.
    // The watchdog scope must grant the mutation regardless.
    function watchdogActor(runId: string = watchdogRunId) {
      return {
        type: "agent",
        agentId: peerAgentId,
        companyId,
        source: "agent_key",
        runId,
      };
    }

    function createWatchdogDb(options: {
      watchedIssueId?: string;
      watchdogIssueId?: string | null;
      ancestryParentId?: string | null;
      watchdogRows?: Record<string, unknown>[];
    } = {}) {
      const watchedIssueId = options.watchedIssueId ?? issueId;
      const runRows = [{
        id: watchdogRunId,
        companyId,
        agentId: peerAgentId,
        contextSnapshot: { taskWatchdog: { watchedIssueId, stopFingerprint: "task_watchdog_stop:test" } },
      }];
      const watchdogRows = options.watchdogRows ?? [{
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddddde",
        companyId,
        issueId: watchedIssueId,
        watchdogAgentId: peerAgentId,
        watchdogIssueId: options.watchdogIssueId ?? watchdogReportIssueId,
        status: "active",
      }];
      const ancestryRows = [{
        id: "ancestry",
        companyId,
        parentId: options.ancestryParentId ?? null,
      }];
      const rowsForSelection = (selection: Record<string, unknown>) => {
        const keys = Object.keys(selection);
        if (keys.includes("entityId")) return [];
        if (keys.includes("contextSnapshot")) return runRows;
        if (keys.includes("watchdogAgentId")) return watchdogRows;
        if (keys.includes("parentId")) return ancestryRows;
        if (keys.includes("status")) return [];
        if (keys.includes("agentCompanyId")) return runRows;
        return [{ id: peerAgentId, companyId, permissions: {}, role: "engineer", reportsTo: null }];
      };
      const buildQuery = (selection: Record<string, unknown>) => {
        const rows = rowsForSelection(selection);
        const whereResult = {
          orderBy: vi.fn(async () => []),
          limit: vi.fn(() => ({
            then: async (resolve: (limitedRows: unknown[]) => unknown) => resolve(rows),
          })),
          then: async (resolve: (selectedRows: unknown[]) => unknown) => resolve(rows),
        };
        const query = {
          innerJoin: vi.fn(() => query),
          where: vi.fn(() => whereResult),
        };
        return query;
      };
      return {
        transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
        select: vi.fn((selection: Record<string, unknown> = {}) => ({
          from: vi.fn(() => buildQuery(selection)),
        })),
      };
    }

    // The base boundary always denies a cross-agent issue:mutate; only the
    // watchdog scope can widen access. Denying it here proves the grant works.
    function denyBaseBoundary() {
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: input.action === "company_scope:read" || input.action === "issue:read" || input.action === "tasks:assign",
        action: input.action,
        reason:
          input.action === "company_scope:read" || input.action === "issue:read" || input.action === "tasks:assign"
            ? "allow_explicit_grant"
            : "deny_missing_grant",
        explanation: "Watchdog test boundary default.",
      }));
    }

    it("lets a watchdog run comment on a watched issue assigned to a different agent", async () => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Watchdog finding" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        issueId,
        "Watchdog finding",
        expect.any(Object),
        expect.any(Object),
      );
    });

    it.each([
      ["in_progress"],
      ["blocked"],
      ["todo"],
    ])("lets a watchdog run transition a watched issue to %s", async (status) => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress", assigneeAgentId: ownerAgentId }));
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...makeIssue({ assigneeAgentId: ownerAgentId }),
        ...patch,
      }));

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(issueId, expect.objectContaining({ status }));
    });

    it("lets a watchdog run transition a watched issue to in_review with a live review path", async () => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress", assigneeAgentId: ownerAgentId }));
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...makeIssue({ assigneeAgentId: ownerAgentId }),
        ...patch,
      }));
      // A pending interaction is a valid review path, so the agent in_review guard
      // is satisfied — this isolates the test to the watchdog boundary grant.
      mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{ status: "pending" }] as never);

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_review" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(issueId, expect.objectContaining({ status: "in_review" }));
    });

    it("rejects stale watchdog source mutations when revalidation finds a live path", async () => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress", assigneeAgentId: ownerAgentId }));
      mockTaskWatchdogService.revalidateMutationScope.mockResolvedValueOnce({
        allowed: false,
        reason:
          "Task-watchdog review is stale because the watched subtree now has a live, waiting, already-reviewed, or not-applicable path; refresh the source state before mutating it.",
        classification: { state: "live", liveIssueIds: [issueId] },
      });

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toContain("Task-watchdog review is stale");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("suppresses watchdog follow-up creation when current source revalidation is live", async () => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));
      mockTaskWatchdogService.revalidateMutationScope.mockResolvedValueOnce({
        allowed: false,
        reason:
          "Task-watchdog review is stale because the watched subtree now has a live, waiting, already-reviewed, or not-applicable path; refresh the source state before mutating it.",
        classification: { state: "live", liveIssueIds: [issueId] },
      });

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app)
        .post(`/api/issues/${issueId}/children`)
        .send({ title: "Stale follow-up", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toContain("Task-watchdog review is stale");
      expect(mockIssueService.createChild).not.toHaveBeenCalled();
    });

    it("serializes watchdog accepted-plan follow-ups behind one active child lane", async () => {
      denyBaseBoundary();
      mockIssueService.list.mockResolvedValue([]);
      mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: reference === ownerAgentId ? makeAgent(ownerAgentId) : null,
      }));
      mockIssueService.getById.mockImplementation(async (id: string) => {
        if (id === watchdogReportIssueId) {
          return makeIssue({
            id: watchdogReportIssueId,
            originKind: "task_watchdog",
            status: "in_progress",
            assigneeAgentId: peerAgentId,
          });
        }
        return makeIssue({ assigneeAgentId: ownerAgentId });
      });

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app)
        .post(`/api/issues/${issueId}/accepted-plan-decompositions`)
        .send({
          acceptedPlanRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          children: [
            { title: "Fix watchdog authorization", assigneeAgentId: ownerAgentId },
            { title: "Fix watchdog startup race", assigneeAgentId: ownerAgentId },
          ],
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const decompositionInput = mockIssueService.decomposeAcceptedPlan.mock.calls[0]?.[1];
      const children = decompositionInput.children as Array<Record<string, unknown>>;
      expect(children).toHaveLength(2);
      expect(children[0]).toEqual(expect.objectContaining({
        title: "Fix watchdog authorization",
        status: "todo",
        assigneeAgentId: ownerAgentId,
      }));
      expect(children[1]).toEqual(expect.objectContaining({
        title: "Fix watchdog startup race",
        status: "blocked",
        assigneeAgentId: ownerAgentId,
        blockedByIssueIds: [children[0]?.id],
      }));
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        ownerAgentId,
        expect.objectContaining({
          payload: expect.objectContaining({ issueId: children[0]?.id }),
        }),
      );
      expect(mockIssueService.update).toHaveBeenCalledWith(
        watchdogReportIssueId,
        expect.objectContaining({
          status: "blocked",
          blockedByIssueIds: [children[0]?.id],
          actorAgentId: peerAgentId,
        }),
      );
    });

    it("preserves normal accepted-plan decomposition parallel wakeups outside watchdog context", async () => {
      mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: reference === ownerAgentId ? makeAgent(ownerAgentId) : null,
      }));
      const app = await createApp(ownerActor());
      const res = await request(app)
        .post(`/api/issues/${issueId}/accepted-plan-decompositions`)
        .send({
          acceptedPlanRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          children: [
            { title: "Implement backend", assigneeAgentId: ownerAgentId },
            { title: "Implement frontend", assigneeAgentId: ownerAgentId },
          ],
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const decompositionInput = mockIssueService.decomposeAcceptedPlan.mock.calls[0]?.[1];
      const children = decompositionInput.children as Array<Record<string, unknown>>;
      expect(children).toHaveLength(2);
      expect(children[0]).toEqual(expect.objectContaining({ status: "todo" }));
      expect(children[1]).toEqual(expect.objectContaining({ status: "todo" }));
      expect(children[1]?.blockedByIssueIds).toBeUndefined();
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(2);
      expect(mockHeartbeatService.wakeup).toHaveBeenNthCalledWith(
        1,
        ownerAgentId,
        expect.objectContaining({
          payload: expect.objectContaining({ issueId: children[0]?.id }),
        }),
      );
      expect(mockHeartbeatService.wakeup).toHaveBeenNthCalledWith(
        2,
        ownerAgentId,
        expect.objectContaining({
          payload: expect.objectContaining({ issueId: children[1]?.id }),
        }),
      );
      expect(mockIssueService.update).not.toHaveBeenCalledWith(
        watchdogReportIssueId,
        expect.anything(),
      );
    });

    it("lets a watchdog run reassign a watched issue to an active same-company agent", async () => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...makeIssue({ assigneeAgentId: ownerAgentId }),
        ...patch,
      }));
      mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: makeAgent(peerAgentId) });

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: peerAgentId });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        issueId,
        expect.objectContaining({ assigneeAgentId: peerAgentId }),
      );
    });

    it("still denies a watchdog run mutating an issue outside the watched subtree", async () => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));

      // The watched issue is a different issue, and the target's ancestry chain
      // (parentId === null) never reaches it, so it is outside the subtree.
      const outsideWatched = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef";
      const app = await createApp(
        watchdogActor(),
        createWatchdogDb({ watchedIssueId: outsideWatched, ancestryParentId: null }),
      );
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("still enforces normal assignment guards for watchdog reassignment", async () => {
      // Base boundary denied AND tasks:assign denied: the watchdog grant lets the
      // mutation past the ownership boundary, but the assignment guard must still bite.
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: input.action === "company_scope:read",
        action: input.action,
        reason: input.action === "company_scope:read" ? "allow_explicit_grant" : "deny_policy_restricted",
        explanation:
          input.action === "tasks:assign"
            ? "Target agent requires approval before task assignment."
            : "Watchdog test boundary default.",
      }));
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));
      mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: makeAgent(peerAgentId) });

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: peerAgentId });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("requires approval");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("denies an invalid watchdog run context even when the base boundary would allow it", async () => {
      // Run context claims a watched issue, but no active persisted watchdog backs it.
      const app = await createApp(
        watchdogActor(),
        createWatchdogDb({ watchdogRows: [] }),
      );
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: peerAgentId }));

      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Task-watchdog run context is not backed by an active persisted watchdog.");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });
  });
});
