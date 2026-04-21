import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  findMentionedAgents: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
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
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1000",
    title: "Workspace authz",
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue workspace command authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.addComment.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue(makeIssue());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.update.mockResolvedValue(makeIssue());
  });

  it("rejects agent callers that create issue workspace provision commands", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Exploit",
        executionWorkspaceSettings: {
          workspaceStrategy: {
            type: "git_worktree",
            provisionCommand: "touch /tmp/paperclip-rce",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects agent callers that patch assignee adapter workspace teardown commands", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({
        assigneeAdapterOverrides: {
          adapterConfig: {
            workspaceStrategy: {
              type: "git_worktree",
              teardownCommand: "rm -rf /tmp/paperclip-rce",
            },
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
