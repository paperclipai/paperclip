import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, unprocessable } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  assertGoalExists,
  assertParentIssueExists,
  parseForeignKeyError,
} from "../services/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  listBlockerAttention: vi.fn(),
  listReviewAttention: vi.fn(),
  listProductivityReviews: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  getActiveInboxArchiveFields: vi.fn(),
  listAttachments: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
  decide: vi.fn(async () => ({ allowed: true })),
  hasPermission: vi.fn(async () => true),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
  })),
  getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: false })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
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

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  environmentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueReferenceService: () => mockIssueReferenceService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({}),
}));

const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb({ select: mockDbSelect })),
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
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue FK validation (#7656)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseForeignKeyError", () => {
    it("identifies parent issue foreign key violations", () => {
      const err = {
        code: "23503",
        constraint: "issues_parent_id_issues_id_fk",
        detail: 'Key (parent_id)=(00000000-0000-0000-0000-000000000000) is not present in table "issues".',
      };
      expect(parseForeignKeyError(err)).toEqual({ message: "Parent issue not found" });
    });

    it("identifies goal foreign key violations", () => {
      const err = {
        code: "23503",
        constraint: "issues_goal_id_goals_id_fk",
        detail: 'Key (goal_id)=(00000000-0000-0000-0000-000000000000) is not present in table "goals".',
      };
      expect(parseForeignKeyError(err)).toEqual({ message: "Goal not found" });
    });

    it("returns null for non-foreign key errors", () => {
      expect(parseForeignKeyError(new Error("regular error"))).toBeNull();
      expect(parseForeignKeyError(null)).toBeNull();
    });
  });

  describe("assertParentIssueExists", () => {
    it("throws unprocessable 422 if parent issue is not found", async () => {
      const dbReader: any = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      };
      await expect(
        assertParentIssueExists(dbReader, "company-1", "00000000-0000-0000-0000-000000000000"),
      ).rejects.toSatisfy((err: unknown) => {
        return err instanceof HttpError && err.status === 422 && err.message === "Parent issue not found";
      });
    });

    it("throws unprocessable 422 if parentId matches current issue id", async () => {
      const dbReader: any = { select: vi.fn() };
      await expect(
        assertParentIssueExists(dbReader, "company-1", "issue-1", "issue-1"),
      ).rejects.toSatisfy((err: unknown) => {
        return err instanceof HttpError && err.status === 422 && err.message === "Parent issue not found";
      });
    });

    it("throws unprocessable 422 if the proposed parentId is a descendant of the issue", async () => {
      // issue-1 -> child-1 -> child-2; attempting to set issue-1's parent to child-2 is a cycle.
      const where = vi.fn();
      where.mockResolvedValueOnce([{ id: "child-2" }]); // parent existence check
      where.mockResolvedValueOnce([{ parentId: "child-1" }]); // child-2's parent
      where.mockResolvedValueOnce([{ parentId: "issue-1" }]); // child-1's parent
      const dbReader: any = { select: () => ({ from: () => ({ where }) }) };

      await expect(
        assertParentIssueExists(dbReader, "company-1", "child-2", "issue-1"),
      ).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof HttpError &&
          err.status === 422 &&
          err.message === "Parent issue cannot be a descendant of this issue"
        );
      });
    });

    it("does not throw when the proposed parentId is unrelated to the issue", async () => {
      const where = vi.fn();
      where.mockResolvedValueOnce([{ id: "other-issue" }]); // parent existence check
      where.mockResolvedValueOnce([{ parentId: null }]); // other-issue has no parent, chain ends
      const dbReader: any = { select: () => ({ from: () => ({ where }) }) };

      await expect(
        assertParentIssueExists(dbReader, "company-1", "other-issue", "issue-1"),
      ).resolves.toBeUndefined();
    });
  });

  describe("assertGoalExists", () => {
    it("throws unprocessable 422 if goal is not found", async () => {
      const dbReader: any = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      };
      await expect(
        assertGoalExists(dbReader, "company-1", "00000000-0000-0000-0000-000000000000"),
      ).rejects.toSatisfy((err: unknown) => {
        return err instanceof HttpError && err.status === 422 && err.message === "Goal not found";
      });
    });
  });

  describe("PATCH /api/issues/:id validation", () => {
    const existingIssue = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      identifier: "PAP-1",
      title: "Test issue",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: "local-board",
      reviewPolicy: null,
      executionPolicy: null,
      executionState: null,
    };

    it("returns 422 when PATCH /api/issues/:id is sent a non-existent parentId", async () => {
      mockIssueService.getById.mockResolvedValue(existingIssue);
      // Exercise the real assertParentIssueExists validation instead of a canned rejection,
      // so a regression in the conversion to a 422 would actually be caught here.
      const dbReader: any = { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) };
      mockIssueService.update.mockImplementation(async () => {
        await assertParentIssueExists(
          dbReader,
          existingIssue.companyId,
          "00000000-0000-0000-0000-000000000000",
          existingIssue.id,
        );
      });

      const res = await request(createApp())
        .patch(`/api/issues/${existingIssue.id}`)
        .send({ parentId: "00000000-0000-0000-0000-000000000000" });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("Parent issue not found");
    });

    it("returns 422 when PATCH /api/issues/:id is sent a parentId that is a descendant of the issue", async () => {
      const childId = "22222222-2222-4222-8222-222222222222";
      mockIssueService.getById.mockResolvedValue(existingIssue);
      const where = vi.fn();
      where.mockResolvedValueOnce([{ id: childId }]); // parent existence check
      where.mockResolvedValueOnce([{ parentId: existingIssue.id }]); // child's parent is the issue itself
      const dbReader: any = { select: () => ({ from: () => ({ where }) }) };
      mockIssueService.update.mockImplementation(async () => {
        await assertParentIssueExists(dbReader, existingIssue.companyId, childId, existingIssue.id);
      });

      const res = await request(createApp())
        .patch(`/api/issues/${existingIssue.id}`)
        .send({ parentId: childId });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("Parent issue cannot be a descendant of this issue");
    });

    it("returns 422 when PATCH /api/issues/:id is sent a non-existent goalId", async () => {
      mockIssueService.getById.mockResolvedValue(existingIssue);
      mockIssueService.update.mockRejectedValue(unprocessable("Goal not found"));

      const res = await request(createApp())
        .patch(`/api/issues/${existingIssue.id}`)
        .send({ goalId: "00000000-0000-0000-0000-000000000000" });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("Goal not found");
    });
  });

  describe("POST /api/companies/:companyId/issues validation", () => {
    it("returns 422 when creating an issue with a non-existent parentId", async () => {
      mockIssueService.create.mockRejectedValue(unprocessable("Parent issue not found"));

      const res = await request(createApp())
        .post("/api/companies/company-1/issues")
        .send({
          title: "Child issue",
          parentId: "00000000-0000-0000-0000-000000000000",
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("Parent issue not found");
    });

    it("returns 422 when creating an issue with a non-existent goalId", async () => {
      mockIssueService.create.mockRejectedValue(unprocessable("Goal not found"));

      const res = await request(createApp())
        .post("/api/companies/company-1/issues")
        .send({
          title: "Goal-linked issue",
          goalId: "00000000-0000-0000-0000-000000000000",
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("Goal not found");
    });
  });
});
