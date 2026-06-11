import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const ownerRunId = "55555555-5555-4555-8555-555555555555";
const REAL_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const FAKE_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const REPO_URL = "https://example.com/repo.git";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
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
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));

const mockClosureGate = vi.hoisted(() => {
  const gateBehavior: {
    mode: "off" | "advisory" | "enforce";
    reject: boolean;
    reason: string;
    reachableShas: Set<string>;
  } = {
    mode: "off",
    reject: false,
    reason: "missing_fix_sha",
    reachableShas: new Set(["abcdef0123456789abcdef0123456789abcdef01"]),
  };

  return {
    gateBehavior,
    captured: [] as Array<Record<string, unknown>>,
    assertAllowed: vi.fn(async (input: Record<string, unknown>) => {
      mockClosureGate.captured.push(input);
      // eslint-disable-next-line no-console
      console.log("[test] assertAllowed called", { mode: gateBehavior.mode, reject: gateBehavior.reject });
      if (gateBehavior.reject) {
        return {
          allowed: false,
          mode: gateBehavior.mode,
          reason: gateBehavior.reason,
          message: `synthetic rejection (${gateBehavior.reason}): Fix-SHA closure-gate rejected`,
        };
      }
      const actor = input.actor as { actorType?: string; agentId?: string | null } | undefined;
      if (actor && actor.actorType !== "agent") {
        return {
          allowed: true,
          mode: gateBehavior.mode,
          fixSha: null,
          verified: null,
          verificationFailed: false,
        };
      }
      const commentBody = (input.commentBody as string | null | undefined) ?? "";
      const fallback = (input.fallbackCommentBody as string | null | undefined) ?? "";
      const combined = `${commentBody}\n${fallback}`;
      const shaMatch = combined.match(/Fix-SHA:\s*([0-9a-f]{40})/i);
      if (gateBehavior.mode === "off") {
        return { allowed: true, mode: "off", fixSha: null, verified: null, verificationFailed: false };
      }
      if (!shaMatch) {
        if (gateBehavior.mode === "advisory") {
          return { allowed: true, mode: "advisory", fixSha: null, verified: null, verificationFailed: true };
        }
        return {
          allowed: false,
          mode: "enforce",
          reason: "missing_fix_sha",
          message: "Fix-SHA missing",
        };
      }
      const sha = shaMatch[1].toLowerCase();
      if (!gateBehavior.reachableShas.has(sha)) {
        if (gateBehavior.mode === "advisory") {
          return {
            allowed: true,
            mode: "advisory",
            fixSha: { sha, target: "main" },
            verified: null,
            verificationFailed: true,
          };
        }
        return {
          allowed: false,
          mode: "enforce",
          reason: "unreachable_sha",
          message: `Fix-SHA ${sha} not reachable`,
        };
      }
      return {
        allowed: true,
        mode: gateBehavior.mode,
        fixSha: { sha, target: "main" },
        verified: "fresh",
        verificationFailed: false,
      };
    }),
    extractFixSha: vi.fn(),
    verifyFixShaOnRemote: vi.fn(),
    cache: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
  };
});

// `throwIfClosureGateRejected` is captured lazily (per test, after
// vi.resetModules + mock application) by `createApp`, then handed to
// the closure-gate mock factory. This guarantees the rejected-path
// HttpError comes from the same errors module the errorHandler loads
// via vi.importActual — avoiding a vitest module-identity split where
// the test's hoisted reference would otherwise see a stale HttpError
// class after vi.resetModules invalidated the module cache.
let liveThrowIfClosureGateRejected: (outcome: unknown) => void = () => {
  throw new Error("closure-gate test setup did not provide throwIfClosureGateRejected");
};

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
    documentService: () => mockDocumentService,
  }));

  vi.doMock("../services/closure-gate.js", () => ({
    createClosureGate: () => mockClosureGate,
    // Forward to whatever throwIfClosureGateRejected createApp installed
    // for this test run. Captured at test setup time so it shares
    // module identity with the real errors.js / errorHandler.
    throwIfClosureGateRejected: (outcome: unknown) =>
      liveThrowIfClosureGateRejected(outcome),
  }));

  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => mockExecutionWorkspaceService,
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
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => mockCompanyService,
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
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
    issueApprovalService: () => ({}),
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
    executionWorkspaceId: "ws-1",
    ...overrides,
  };
}

function makeAgent(id: string) {
  return {
    id,
    companyId,
    role: "engineer",
    reportsTo: null,
    permissions: { canCreateAgents: false },
  };
}

async function createApp(actor: Record<string, unknown>) {
  // Load the REAL closure-gate service via vi.importActual so the
  // throwIfClosureGateRejected we wire up here is the actual
  // implementation (which throws HttpError(422) via unprocessable()).
  // The mock factory in registerRouteMocks() installs a forwarder that
  // calls liveThrowIfClosureGateRejected at invocation time, so the
  // route's mock-imported throwIfClosureGateRejected hands the
  // outcome to this real function — guaranteeing the HttpError class
  // shares identity with the one errorHandler recognises.
  const realClosureGate = await vi.importActual<
    typeof import("../services/closure-gate.js")
  >("../services/closure-gate.js");
  liveThrowIfClosureGateRejected = realClosureGate.throwIfClosureGateRejected;

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
  app.use("/api", issueRoutes({} as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
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
    companyId,
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

describe("issue closure-gate route integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/closure-gate.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/execution-workspaces.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();

    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) =>
      id === ownerAgentId ? makeAgent(ownerAgentId) : null,
    );
    mockAgentService.list.mockResolvedValue([makeAgent(ownerAgentId)]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([]);
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
    mockIssueService.remove.mockResolvedValue(makeIssue({ status: "cancelled" }));
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "ws-1",
      companyId,
      repoUrl: REPO_URL,
    });
    mockDocumentService.upsertIssueDocument.mockResolvedValue({
      created: false,
      document: { id: "doc-1", key: "plan", title: "Plan", format: "markdown", latestRevisionNumber: 1 },
    });
    mockWorkProductService.getById.mockResolvedValue({
      id: "wp-1",
      issueId,
      companyId,
      type: "artifact",
    });
    mockWorkProductService.update.mockResolvedValue({
      id: "wp-1",
      issueId,
      companyId,
      type: "artifact",
      title: "Updated",
    });

    mockClosureGate.captured = [];
    mockClosureGate.gateBehavior.mode = "off";
    mockClosureGate.gateBehavior.reject = false;
    mockClosureGate.gateBehavior.reason = "missing_fix_sha";
    mockClosureGate.gateBehavior.reachableShas = new Set(["abcdef0123456789abcdef0123456789abcdef01"]);
  });

  it("does not require a Fix-SHA when the company mode is off", async () => {
    mockCompanyService.getById.mockResolvedValue({ id: companyId, closureGateFixSha: "off" });

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "All done, no SHA required." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: issueId, status: "done" });
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ status: "done" }),
    );
  });

  it("accepts an agent closure under enforce when a reachable Fix-SHA is in the comment", async () => {
    mockCompanyService.getById.mockResolvedValue({ id: companyId, closureGateFixSha: "enforce" });
    mockClosureGate.gateBehavior.mode = "enforce";

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: `Merged. Fix-SHA: ${REAL_SHA}\nFix-Target: main`,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: issueId, status: "done" });
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("rejects an agent closure with 422 under enforce when Fix-SHA is missing", async () => {
    mockCompanyService.getById.mockResolvedValue({ id: companyId, closureGateFixSha: "enforce" });
    mockClosureGate.gateBehavior.mode = "enforce";
    mockClosureGate.gateBehavior.reject = true;
    mockClosureGate.gateBehavior.reason = "missing_fix_sha";

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "All done, no SHA here." });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      error: expect.stringMatching(/Fix-SHA/i),
      details: expect.objectContaining({ reason: "missing_fix_sha" }),
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent closure with 422 under enforce when Fix-SHA is not reachable", async () => {
    mockCompanyService.getById.mockResolvedValue({ id: companyId, closureGateFixSha: "enforce" });
    mockClosureGate.gateBehavior.mode = "enforce";
    mockClosureGate.gateBehavior.reject = true;
    mockClosureGate.gateBehavior.reason = "unreachable_sha";
    mockClosureGate.gateBehavior.reachableShas = new Set(["abcdef0123456789abcdef0123456789abcdef01"]);

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: `Done. Fix-SHA: ${FAKE_SHA}\n` });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      details: expect.objectContaining({ reason: "unreachable_sha" }),
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("falls back to the most recent persisted comment when the request body has no comment", async () => {
    mockCompanyService.getById.mockResolvedValue({ id: companyId, closureGateFixSha: "enforce" });
    mockClosureGate.gateBehavior.mode = "enforce";
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "c-prev",
        issueId,
        companyId,
        body: `Earlier merge. Fix-SHA: ${REAL_SHA}\n`,
        createdAt: new Date().toISOString(),
      },
    ]);

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.listComments).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ order: "desc", limit: 1 }),
    );
  });

  it("does not reject a board (user) actor under enforce", async () => {
    mockCompanyService.getById.mockResolvedValue({ id: companyId, closureGateFixSha: "enforce" });
    mockClosureGate.gateBehavior.mode = "enforce";

    const res = await request(await createApp(boardActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Closing from the board; no SHA required." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: issueId, status: "done" });
  });

  it("does not invoke the gate when status transitions to anything other than done", async () => {
    mockCompanyService.getById.mockResolvedValue({ id: companyId, closureGateFixSha: "enforce" });
    mockClosureGate.gateBehavior.mode = "enforce";
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "todo" }));

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Starting work, no closure yet." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockClosureGate.assertAllowed).not.toHaveBeenCalled();
  });

  it("passes the company mode and actor info to the gate", async () => {
    mockCompanyService.getById.mockResolvedValue({ id: companyId, closureGateFixSha: "enforce" });
    mockClosureGate.gateBehavior.mode = "enforce";

    await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: `Fix-SHA: ${REAL_SHA}\n` })
      .expect(200);

    expect(mockClosureGate.captured.length).toBe(1);
    const call = mockClosureGate.captured[0];
    expect(call).toMatchObject({
      companyMode: "enforce",
      actor: expect.objectContaining({ actorType: "agent", agentId: ownerAgentId }),
    });
  });
});
