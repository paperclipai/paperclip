import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
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

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  resolveByReference: vi.fn(async (_companyId: string, ref: string) => ({
    ambiguous: false,
    agent: { id: ref },
  })),
}));

function registerModuleMocks() {
  const sharedTelemetryMock = () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  });

  const telemetryMock = () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  });

  const servicesIndexMock = () => ({
    accessService: () => ({
      canUser: vi.fn(async () => false),
      hasPermission: vi.fn(async () => false),
    }),
    agentService: () => mockAgentService,
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
    issueService: () => mockIssueService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  });

  vi.doMock("@paperclipai/shared/telemetry", sharedTelemetryMock);
  vi.doMock("../telemetry.js", telemetryMock);
  vi.doMock("../telemetry.ts", telemetryMock);
  vi.doMock("../services/index.js", servicesIndexMock);
  vi.doMock("../services/index.ts", servicesIndexMock);
  vi.doMock("../services/issue-assignment-wakeup.js", async () =>
    vi.importActual<typeof import("../services/issue-assignment-wakeup.ts")>(
      "../services/issue-assignment-wakeup.ts",
    ),
  );
  vi.doMock("../services/issue-assignment-wakeup.ts", async () =>
    vi.importActual<typeof import("../services/issue-assignment-wakeup.ts")>(
      "../services/issue-assignment-wakeup.ts",
    ),
  );
  vi.doMock("../services/issue-execution-policy.js", async () =>
    vi.importActual<typeof import("../services/issue-execution-policy.ts")>("../services/issue-execution-policy.ts"),
  );
  vi.doMock("../services/issue-execution-policy.ts", async () =>
    vi.importActual<typeof import("../services/issue-execution-policy.ts")>("../services/issue-execution-policy.ts"),
  );
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/workspace-command-authz.js", async () =>
    vi.importActual<typeof import("../routes/workspace-command-authz.ts")>("../routes/workspace-command-authz.ts"),
  );
  vi.doMock("../routes/workspace-command-authz.ts", async () =>
    vi.importActual<typeof import("../routes/workspace-command-authz.ts")>("../routes/workspace-command-authz.ts"),
  );
  vi.doMock("../routes/issues-checkout-wakeup.js", async () =>
    vi.importActual<typeof import("../routes/issues-checkout-wakeup.ts")>("../routes/issues-checkout-wakeup.ts"),
  );
  vi.doMock("../routes/issues-checkout-wakeup.ts", async () =>
    vi.importActual<typeof import("../routes/issues-checkout-wakeup.ts")>("../routes/issues-checkout-wakeup.ts"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/validate.ts", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/index.js", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/index.ts", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/logger.js", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../middleware/logger.ts", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../attachment-types.js", async () =>
    vi.importActual<typeof import("../attachment-types.ts")>("../attachment-types.ts"),
  );
  vi.doMock("../attachment-types.ts", async () =>
    vi.importActual<typeof import("../attachment-types.ts")>("../attachment-types.ts"),
  );
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: string;
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      companyIds: string[];
      runId?: string | null;
      runStatus?: string | null;
      source: string;
    };

async function createApp(actor?: TestActor) {
  vi.resetModules();
  vi.doUnmock("@paperclipai/db");
  vi.doUnmock("@paperclipai/shared");
  vi.doUnmock("@paperclipai/shared/telemetry");
  vi.doUnmock("../telemetry.js");
  vi.doUnmock("../telemetry.ts");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
  vi.doUnmock("../services/issue-assignment-wakeup.js");
  vi.doUnmock("../services/issue-assignment-wakeup.ts");
  vi.doUnmock("../services/issue-execution-policy.js");
  vi.doUnmock("../services/issue-execution-policy.ts");
  vi.doUnmock("../routes/issues.js");
  vi.doUnmock("../routes/issues.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../routes/issues-checkout-wakeup.js");
  vi.doUnmock("../routes/issues-checkout-wakeup.ts");
  vi.doUnmock("../routes/workspace-command-authz.js");
  vi.doUnmock("../routes/workspace-command-authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../middleware/validate.ts");
  vi.doUnmock("../middleware/logger.js");
  vi.doUnmock("../middleware/logger.ts");
  vi.doUnmock("../attachment-types.js");
  vi.doUnmock("../attachment-types.ts");
  registerModuleMocks();
  issueRouteImportSeq += 1;
  const routeModulePath = `../routes/issues.ts?issue-execution-policy-routes-${issueRouteImportSeq}`;
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.ts"),
    import(routeModulePath) as Promise<typeof import("../routes/issues.ts")>,
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
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

let issueRouteImportSeq = 0;

describe("issue execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/db");
    vi.doUnmock("@paperclipai/shared");
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../telemetry.ts");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/index.ts");
    vi.doUnmock("../services/issue-assignment-wakeup.js");
    vi.doUnmock("../services/issue-assignment-wakeup.ts");
    vi.doUnmock("../services/issue-execution-policy.js");
    vi.doUnmock("../services/issue-execution-policy.ts");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/issues.ts");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/authz.ts");
    vi.doUnmock("../routes/issues-checkout-wakeup.js");
    vi.doUnmock("../routes/issues-checkout-wakeup.ts");
    vi.doUnmock("../routes/workspace-command-authz.js");
    vi.doUnmock("../routes/workspace-command-authz.ts");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/index.ts");
    vi.doUnmock("../middleware/validate.js");
    vi.doUnmock("../middleware/validate.ts");
    vi.doUnmock("../middleware/logger.js");
    vi.doUnmock("../middleware/logger.ts");
    vi.doUnmock("../attachment-types.js");
    vi.doUnmock("../attachment-types.ts");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, ref: string) => ({
      ambiguous: false,
      agent: { id: ref },
    }));
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

  it("rejects status-only workflow handoff from a user-owned issue to an agent reviewer", async () => {
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
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1000",
      title: "Human-owned execution",
      executionPolicy: policy,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("explicit assignee change");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("allows explicit board assignment from a user-owned issue to an agent", async () => {
    const agentId = "33333333-3333-4333-8333-333333333333";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Manual handoff",
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
      .send({ assigneeAgentId: agentId });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        assigneeAgentId: agentId,
        assigneeUserId: null,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        reason: "issue_assigned",
      }),
    );
  });

  it("rejects agent-originated handoff from a user-owned issue to an agent", async () => {
    const agentId = "33333333-3333-4333-8333-333333333333";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Agent handoff attempt",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId,
      companyId: "company-1",
      companyIds: ["company-1"],
      source: "agent_api_key",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ assigneeAgentId: agentId });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Agents cannot move");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});
