import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listAttachments: vi.fn(),
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

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentService,
  executionWorkspaceService: () => ({ getById: vi.fn(async () => null) }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabledNow: false })),
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
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    })),
    listCompanyIds: vi.fn(async () => [companyId]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductService,
}));

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
    createdByUserId: null,
    identifier: "PAP-0001",
    title: "Test issue",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    gateBlockCount: 0,
    deliverableType: null,
    ...overrides,
  };
}

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.actor = {
      type: "agent",
      agentId: ownerAgentId,
      companyId,
      source: "agent_key",
      runId: "55555555-5555-4555-8555-555555555555",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

describe("deliverableType gateBlockCount reset (DLD-3465)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue({
      id: ownerAgentId,
      companyId,
      role: "engineer",
      reportsTo: null,
      permissions: { canCreateAgents: false },
    });
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.getAttachmentById.mockResolvedValue(null);
    mockIssueService.remove.mockResolvedValue(makeIssue({ status: "cancelled" }));
    mockIssueService.removeAttachment.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
  });

  it("PATCH deliverableType null→value resets gateBlockCount to 0", async () => {
    // Regression: setting deliverableType on a code issue used to NOT reset gateBlockCount,
    // causing it to keep incrementing and agents to be skipped on wakeups.
    const issue = makeIssue({ status: "in_progress", deliverableType: null, gateBlockCount: 1 });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, fields: Record<string, unknown>) => ({
      ...issue,
      ...fields,
      gateBlockCount: fields.gateBlockCount as number,
    }));

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ deliverableType: "report" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({ gateBlockCount: 0, deliverableType: "report" }),
    );
    expect(res.body.gateBlockCount).toBe(0);
  });

  it("PATCH deliverableType value→null resets gateBlockCount to 0", async () => {
    // Same logic: when deliverableType reverts, gateBlockCount resets.
    const issue = makeIssue({ status: "in_progress", deliverableType: "report", gateBlockCount: 3 });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, fields: Record<string, unknown>) => ({
      ...issue,
      ...fields,
      gateBlockCount: fields.gateBlockCount as number,
    }));

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ deliverableType: null });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({ gateBlockCount: 0, deliverableType: null }),
    );
    expect(res.body.gateBlockCount).toBe(0);
  });

  it("PATCH deliverableType with no change does not reset gateBlockCount", async () => {
    // When deliverableType stays the same, gateBlockCount should not be reset.
    const issue = makeIssue({ status: "in_progress", deliverableType: "report", gateBlockCount: 2 });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, fields: Record<string, unknown>) => ({
      ...issue,
      ...fields,
      gateBlockCount: fields.gateBlockCount as number,
    }));

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ deliverableType: "report" });

    expect(res.status).toBe(200);
    // The update call should NOT include gateBlockCount: 0 (no-op for gate reset)
    const updateCall = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updateCall).not.toHaveProperty("gateBlockCount", 0);
  });
});
