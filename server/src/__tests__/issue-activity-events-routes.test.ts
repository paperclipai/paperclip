import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
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

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => false),
    hasPermission: vi.fn(async () => false),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
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
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
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

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Activity event issue",
    executionPolicy: null,
    executionState: null,
  };
}

describe("issue activity event routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("logs blocker activity with added and removed issue summaries", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getRelationSummaries
      .mockResolvedValueOnce({
        blockedBy: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            identifier: "PAP-10",
            title: "Old blocker",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
        blocks: [],
      })
      .mockResolvedValueOnce({
        blockedBy: [
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            identifier: "PAP-11",
            title: "New blocker",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
        blocks: [],
      });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ blockedByIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.blockers_updated",
        details: expect.objectContaining({
          addedBlockedByIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
          removedBlockedByIssueIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
          addedBlockedByIssues: [
            {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              identifier: "PAP-11",
              title: "New blocker",
            },
          ],
          removedBlockedByIssues: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              identifier: "PAP-10",
              title: "Old blocker",
            },
          ],
        }),
      }),
    );
  });

  it("logs explicit reviewer and approver activity when execution policy participants change", async () => {
    const existingPolicy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "11111111-2222-4333-8444-555555555555" }],
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "approval",
          participants: [{ type: "agent", agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa" }],
        },
      ],
    })!;
    const nextPolicy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" }],
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "approval",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue(),
      executionPolicy: existingPolicy,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      executionPolicy: patch.executionPolicy,
      updatedAt: new Date(),
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ executionPolicy: nextPolicy });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.reviewers_updated",
        details: expect.objectContaining({
          participants: [{ type: "agent", agentId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", userId: null }],
          addedParticipants: [{ type: "agent", agentId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", userId: null }],
          removedParticipants: [{ type: "agent", agentId: "11111111-2222-4333-8444-555555555555", userId: null }],
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.approvers_updated",
        details: expect.objectContaining({
          participants: [{ type: "user", agentId: null, userId: "local-board" }],
          addedParticipants: [{ type: "user", agentId: null, userId: "local-board" }],
          removedParticipants: [{ type: "agent", agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa", userId: null }],
        }),
      }),
    );
  });
});
