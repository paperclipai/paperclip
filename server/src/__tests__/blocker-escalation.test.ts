import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockReturning = vi.fn();
const mockDelete = vi.fn();
const mockInnerJoin = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();

// Queued results for chained DB calls
let selectResults: unknown[][] = [];

function buildChain() {
  const chain: Record<string, unknown> = {};
  chain.from = mockFrom.mockReturnValue(chain);
  chain.where = mockWhere.mockImplementation(() => {
    const result = selectResults.shift() ?? [];
    // Return a thenable so `.then()` works
    const thenable = Object.assign(Promise.resolve(result), chain);
    return thenable;
  });
  chain.orderBy = mockOrderBy.mockImplementation(() => {
    const result = selectResults.shift() ?? [];
    return Object.assign(Promise.resolve(result), chain);
  });
  chain.innerJoin = mockInnerJoin.mockReturnValue(chain);
  return chain;
}

const db = {
  select: mockSelect.mockImplementation(() => buildChain()),
  insert: mockInsert.mockReturnValue({
    values: mockValues.mockReturnValue({
      returning: mockReturning,
    }),
  }),
  delete: mockDelete.mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "rel-1", companyId: "comp-1" }]),
    }),
  }),
  update: mockUpdate.mockReturnValue({
    set: mockSet.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  }),
} as any;

// Mock the issueService dependency
vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    create: vi.fn().mockResolvedValue({
      id: "blocker-issue-1",
      companyId: "comp-1",
      identifier: "TEST-2",
      title: "[Action needed] TEST-1: Original issue",
      status: "todo",
    }),
    update: vi.fn().mockResolvedValue({
      id: "blocked-issue-1",
      status: "todo",
    }),
    addComment: vi.fn().mockResolvedValue({
      id: "comment-1",
      body: "test comment",
    }),
  }),
}));

// Mock the wakeup dependency
vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn().mockResolvedValue(null),
}));

// Mock the logger
vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { blockerEscalationService } from "../services/blocker-escalation.js";

describe("blockerEscalationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
  });

  describe("createBlockerIssue", () => {
    it("creates a blocker issue when an issue becomes blocked", async () => {
      const svc = blockerEscalationService(db);

      // Mock: no existing open blocker (hasOpenBlockerIssue → empty)
      selectResults.push([]);
      // Mock: find company owner
      selectResults.push([{ principalId: "user-owner-1" }]);
      // Mock: no latest agent comment needed (commentBody provided)

      // Mock the insert for the relation
      mockReturning.mockResolvedValueOnce([{
        id: "rel-1",
        companyId: "comp-1",
        issueId: "blocker-issue-1",
        relatedIssueId: "blocked-1",
        type: "blocks",
      }]);

      const result = await svc.createBlockerIssue({
        blockedIssue: {
          id: "blocked-1",
          companyId: "comp-1",
          identifier: "TEST-1",
          title: "Original issue",
          priority: "high",
          projectId: "proj-1",
          assigneeAgentId: "agent-1",
        },
        commentBody: "I need API credentials to proceed",
      });

      expect(result).not.toBeNull();
      expect(result!.blockerIssueId).toBe("blocker-issue-1");
    });

    it("skips creation when an open blocker already exists", async () => {
      const svc = blockerEscalationService(db);

      // Mock: existing open blocker found
      selectResults.push([{ id: "existing-rel", relatedStatus: "todo" }]);

      const result = await svc.createBlockerIssue({
        blockedIssue: {
          id: "blocked-1",
          companyId: "comp-1",
          identifier: "TEST-1",
          title: "Original issue",
          priority: "high",
          projectId: null,
          assigneeAgentId: "agent-1",
        },
      });

      expect(result).toBeNull();
    });

    it("skips creation when no company owner is found", async () => {
      const svc = blockerEscalationService(db);

      // Mock: no existing blocker
      selectResults.push([]);
      // Mock: no company owner
      selectResults.push([]);

      const result = await svc.createBlockerIssue({
        blockedIssue: {
          id: "blocked-1",
          companyId: "comp-1",
          identifier: "TEST-1",
          title: "Original issue",
          priority: "medium",
          projectId: null,
          assigneeAgentId: null,
        },
      });

      expect(result).toBeNull();
    });
  });

  describe("handleBlockerResolved", () => {
    it("unblocks issues when a blocker is resolved", async () => {
      const svc = blockerEscalationService(db);
      const mockWakeup = vi.fn().mockResolvedValue(null);

      // Mock: find blocking relations
      selectResults.push([{ relatedIssueId: "blocked-1" }]);
      // Mock: load blocked issues that are still blocked
      selectResults.push([{
        id: "blocked-1",
        companyId: "comp-1",
        status: "blocked",
        assigneeAgentId: "agent-1",
        identifier: "TEST-1",
      }]);

      const result = await svc.handleBlockerResolved(
        { id: "blocker-1", companyId: "comp-1", identifier: "TEST-2" },
        { wakeup: mockWakeup },
        "Here are the credentials you need",
      );

      expect(result.unblockedCount).toBe(1);
    });

    it("does nothing when the resolved issue has no blocking relations", async () => {
      const svc = blockerEscalationService(db);

      // Mock: no blocking relations
      selectResults.push([]);

      const result = await svc.handleBlockerResolved(
        { id: "non-blocker-1", companyId: "comp-1", identifier: "TEST-3" },
        { wakeup: vi.fn() },
      );

      expect(result.unblockedCount).toBe(0);
    });
  });

  describe("listRelations", () => {
    it("returns forward and reverse relations with enriched issue data", async () => {
      const svc = blockerEscalationService(db);

      // Mock: forward relations
      selectResults.push([{
        id: "rel-1",
        companyId: "comp-1",
        issueId: "issue-1",
        relatedIssueId: "issue-2",
        type: "blocks",
        createdAt: new Date(),
      }]);
      // Mock: reverse relations
      selectResults.push([]);
      // Mock: enriched issue data
      selectResults.push([{
        id: "issue-2",
        identifier: "TEST-2",
        title: "Blocked issue",
        status: "blocked",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
      }]);

      const relations = await svc.listRelations("issue-1");
      expect(relations).toHaveLength(1);
      expect(relations[0].type).toBe("blocks");
      expect(relations[0].relatedIssue).toBeTruthy();
    });
  });

  describe("deleteRelation", () => {
    it("deletes a relation by id", async () => {
      const svc = blockerEscalationService(db);
      const result = await svc.deleteRelation("rel-1");
      expect(result).toBeTruthy();
      expect(result.id).toBe("rel-1");
    });
  });
});
