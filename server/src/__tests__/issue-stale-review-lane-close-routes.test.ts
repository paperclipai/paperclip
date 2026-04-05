import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { conflict } from "../errors.js";

const sourceIssueId = "11111111-1111-4111-8111-111111111111";
const childIssueId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  list: vi.fn(),
  listComments: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
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

function makeSourceIssue(status: string) {
  return {
    id: sourceIssueId,
    companyId: "company-1",
    status,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-700",
    title: "Source issue",
    originKind: "manual",
    parentId: null,
  };
}

function makeReviewChild(status: string) {
  return {
    id: childIssueId,
    companyId: "company-1",
    status,
    assigneeAgentId: "reviewer-1",
    assigneeUserId: null,
    createdByUserId: null,
    identifier: "PAP-701",
    title: "Revisar PR #999 de PAP-700",
    originKind: "technical_review_dispatch",
    parentId: sourceIssueId,
    createdAt: new Date("2026-03-31T12:00:00.000Z"),
  };
}

describe("issue stale review lane close routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([]);
  });

  it("auto-walks handoff_ready to done when the source issue already has approved review evidence", async () => {
    const sourceIssue = makeSourceIssue("handoff_ready");

    mockIssueService.getById.mockResolvedValue(sourceIssue);
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "comment-approved",
        issueId: sourceIssueId,
        companyId: "company-1",
        body: "Decisao operacional: [PAP-700](/PAP/issues/PAP-700) pode seguir para revisao humana final.",
        createdAt: new Date("2026-03-31T12:15:00.000Z"),
        updatedAt: new Date("2026-03-31T12:15:00.000Z"),
      },
    ]);
    mockIssueService.update
      .mockResolvedValueOnce({ ...sourceIssue, status: "technical_review" })
      .mockResolvedValueOnce({ ...sourceIssue, status: "human_review" })
      .mockResolvedValueOnce({ ...sourceIssue, status: "done" });

    const res = await request(createApp())
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update.mock.calls).toEqual([
      [sourceIssueId, { status: "technical_review" }],
      [sourceIssueId, { status: "human_review" }],
      [sourceIssueId, { status: "done" }],
    ]);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        entityId: sourceIssueId,
        details: expect.objectContaining({
          status: "done",
          resolvedFromApprovedTechnicalReview: true,
          statusTransitionPath: [
            "handoff_ready->technical_review",
            "technical_review->human_review",
            "human_review->done",
          ],
        }),
      }),
    );
  });

  it("can promote handoff_ready to human_review from a completed review child summary", async () => {
    const sourceIssue = makeSourceIssue("handoff_ready");
    const reviewChild = makeReviewChild("done");

    mockIssueService.getById.mockResolvedValue(sourceIssue);
    mockIssueService.list.mockResolvedValue([reviewChild]);
    mockIssueService.listComments.mockImplementation(async (issueId: string) => {
      if (issueId === sourceIssueId) return [];
      if (issueId === childIssueId) {
        return [
          {
            id: "child-comment-approved",
            issueId: childIssueId,
            companyId: "company-1",
            body: `## Revisao tecnica concluida

### Findings bloqueantes
- Nenhum.

### Decisao operacional
- [PAP-700](/PAP/issues/PAP-700) pode seguir para revisao humana final/merge.`,
            createdAt: new Date("2026-03-31T12:20:00.000Z"),
            updatedAt: new Date("2026-03-31T12:20:00.000Z"),
          },
        ];
      }
      return [];
    });
    mockIssueService.update
      .mockResolvedValueOnce({ ...sourceIssue, status: "technical_review" })
      .mockResolvedValueOnce({ ...sourceIssue, status: "human_review" });

    const res = await request(createApp())
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "human_review" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update.mock.calls).toEqual([
      [sourceIssueId, { status: "technical_review" }],
      [sourceIssueId, { status: "human_review" }],
    ]);
  });

  it("keeps rejecting the close when no approved review evidence exists", async () => {
    const sourceIssue = makeSourceIssue("handoff_ready");
    mockIssueService.getById.mockResolvedValue(sourceIssue);
    mockIssueService.update.mockRejectedValueOnce(
      conflict("Invalid issue status transition: handoff_ready -> done"),
    );

    const res = await request(createApp())
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Invalid issue status transition: handoff_ready -> done",
    });
    expect(mockIssueService.update).toHaveBeenCalledWith(sourceIssueId, { status: "done" });
  });
});
