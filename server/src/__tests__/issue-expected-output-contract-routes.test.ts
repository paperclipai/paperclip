import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const parentIssueId = "33333333-3333-4333-8333-333333333333";
const agentId = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";
const runId = "66666666-6666-4666-8666-666666666666";

const mockIssueService = vi.hoisted(() => ({
  checkout: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  listAttachments: vi.fn(),
  listBlockerAttention: vi.fn(),
  listProductivityReviews: vi.fn(),
  update: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  getIssueDocumentByKey: vi.fn(),
  getIssueDocumentPayload: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  getRun: vi.fn(async () => null),
  reportRunActivity: vi.fn(async () => undefined),
  wakeup: vi.fn(async () => undefined),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => mockAgentService,
  companyService: () => mockCompanyService,
  documentService: () => mockDocumentsService,
  environmentService: () => ({}),
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => mockGoalService,
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
  issueApprovalService: () => ({}),
  issueReferenceService: () => mockIssueReferenceService,
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => mockProjectService,
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    identifier: "AGE-50",
    title: "Expected output lint",
    description: "Expected output: github_pr\n\nShip a PR.",
    status: "todo",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    originKind: "manual",
    originId: null,
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    hiddenAt: null,
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId,
    name: "Agentic Grove Engineer",
    metadata: { requiresOutputContract: true },
    ...overrides,
  };
}

function makeCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: companyId,
    name: "Agentic Grove",
    requireOutputContracts: false,
    attachmentMaxBytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: projectId,
    companyId,
    name: "Grove MCP",
    requireOutputContracts: false,
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actor,
    };
    next();
  });
  return vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js").then(({ issueRoutes }) => {
    app.use("/api", issueRoutes({} as any, {} as any));
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err?.name === "ZodError") {
        res.status(400).json({ error: "Validation error", details: err.issues });
        return;
      }
      res.status(err?.status ?? 500).json({ error: err?.message ?? "Internal server error", details: err?.details });
    });
    return app;
  });
}

async function withApi<T>(
  actor: Record<string, unknown>,
  fn: (api: ReturnType<typeof request>) => Promise<T>,
) {
  const app = await createApp(actor);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  try {
    return await fn(request(`http://127.0.0.1:${address.port}`));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("issue Expected output contract routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue(makeCompany());
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    }));
    mockProjectService.getById.mockResolvedValue(null);
    mockProjectService.listByIds.mockResolvedValue([]);
    mockGoalService.getById.mockResolvedValue(null);
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
    mockDocumentsService.getIssueDocumentPayload.mockResolvedValue({});
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue(null);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.listBlockerAttention.mockResolvedValue(new Map());
    mockIssueService.listProductivityReviews.mockResolvedValue(new Map());
  });

  it("rejects assigned issue creation when the assignee requires an Expected output contract", async () => {
    const res = await withApi({}, (api) => api.post(`/api/companies/${companyId}/issues`).send({
        title: "Implement the change",
        description: "No output contract.",
        status: "todo",
        assigneeAgentId: agentId,
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("Missing Expected output");
    expect(res.body.error).toContain("github_pr");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects unsupported Expected output values with the supported values", async () => {
    const res = await withApi({}, (api) => api.post(`/api/companies/${companyId}/issues`).send({
        title: "Implement the change",
        description: "Expected output: issue_update\n\nLegacy value.",
        status: "todo",
        assigneeAgentId: agentId,
      }));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("Unsupported Expected output");
    expect(JSON.stringify(res.body)).toContain("github_pr");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("allows valid required issue creation and returns derived expectedOutput", async () => {
    const created = makeIssue({ assigneeAgentId: agentId });
    mockIssueService.create.mockResolvedValue(created);

    const res = await withApi({}, (api) => api.post(`/api/companies/${companyId}/issues`).send({
        title: "Implement the change",
        description: "Expected output: github_pr\n\nOpen a draft PR.",
        status: "todo",
        assigneeAgentId: agentId,
      }));

    expect(res.status).toBe(201);
    expect(res.body.expectedOutput).toBe("github_pr");
  });

  it("rejects child issue creation when the project requires Expected output contracts", async () => {
    const parent = makeIssue({ id: parentIssueId, projectId });
    mockIssueService.getById.mockResolvedValue(parent);
    mockProjectService.getById.mockResolvedValue(makeProject({ requireOutputContracts: true }));

    const res = await withApi({}, (api) => api.post(`/api/issues/${parentIssueId}/children`).send({
        title: "Audit the behavior",
        description: "No output contract.",
        status: "todo",
      }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Missing Expected output");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("rejects assignment updates that would hand required work to a specialist without Expected output", async () => {
    const existing = makeIssue({
      description: "No output contract.",
      status: "backlog",
      assigneeAgentId: null,
    });
    mockIssueService.getById.mockResolvedValue(existing);

    const res = await withApi({}, (api) => api.patch(`/api/issues/${issueId}`).send({
        status: "todo",
        assigneeAgentId: agentId,
      }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Missing Expected output");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects checkout before execution when a required issue is missing Expected output", async () => {
    const existing = makeIssue({
      description: "No output contract.",
      status: "todo",
      assigneeAgentId: agentId,
    });
    mockIssueService.getById.mockResolvedValue(existing);

    const res = await withApi({
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_key",
    }, (api) => api.post(`/api/issues/${issueId}/checkout`)
      .set("X-Paperclip-Run-Id", runId)
      .send({
        agentId,
        expectedStatuses: ["todo"],
      }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Missing Expected output");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("exposes derived expectedOutput on issue detail and heartbeat context responses", async () => {
    const existing = makeIssue({
      description: "Expected output: audit_brief\n\nSummarize the risk.",
    });
    mockIssueService.getById.mockResolvedValue(existing);

    const issueRes = await withApi({}, (api) => api.get(`/api/issues/${issueId}`));
    const contextRes = await withApi({}, (api) => api.get(`/api/issues/${issueId}/heartbeat-context`));

    expect(issueRes.status).toBe(200);
    expect(issueRes.body.expectedOutput).toBe("audit_brief");
    expect(contextRes.status).toBe(200);
    expect(contextRes.body.issue.expectedOutput).toBe("audit_brief");
  });
});
