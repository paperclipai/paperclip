import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { selectApprovalContinuationRouting } from "../routes/approvals.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

async function createApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeApproved(overrides: Record<string, unknown> = {}) {
  const approval = {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status: "approved",
    payload: {},
    requestedByAgentId: "agent-1",
    ...overrides,
  };
  mockApprovalService.getById.mockResolvedValue(approval);
  mockApprovalService.approve.mockResolvedValue({ approval, applied: true });
}

describe("selectApprovalContinuationRouting", () => {
  it("picks the first actionable linked issue as the primary issue id", () => {
    const routing = selectApprovalContinuationRouting([
      { id: "issue-blocked", status: "blocked" },
      { id: "issue-todo", status: "todo" },
      { id: "issue-progress", status: "in_progress" },
    ]);
    expect(routing).toEqual({
      primaryIssueId: "issue-todo",
      linkedIssueIds: ["issue-blocked", "issue-todo", "issue-progress"],
      actionableIssueIds: ["issue-todo", "issue-progress"],
      blockedIssueIds: ["issue-blocked"],
      allLinkedBlocked: false,
    });
  });

  it("returns null primary issue id when every linked issue is blocked or terminal", () => {
    const routing = selectApprovalContinuationRouting([
      { id: "issue-blocked-1", status: "blocked" },
      { id: "issue-blocked-2", status: "blocked" },
      { id: "issue-done", status: "done" },
      { id: "issue-cancelled", status: "cancelled" },
    ]);
    expect(routing.primaryIssueId).toBeNull();
    expect(routing.allLinkedBlocked).toBe(true);
    expect(routing.actionableIssueIds).toEqual([]);
    expect(routing.blockedIssueIds).toEqual([
      "issue-blocked-1",
      "issue-blocked-2",
      "issue-done",
      "issue-cancelled",
    ]);
  });

  it("returns no linked routing data when there are no linked issues", () => {
    const routing = selectApprovalContinuationRouting([]);
    expect(routing).toEqual({
      primaryIssueId: null,
      linkedIssueIds: [],
      actionableIssueIds: [],
      blockedIssueIds: [],
      allLinkedBlocked: false,
    });
  });
});

describe("approval continuation routing when linked issues are blocked", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.getById.mockReset();
    mockApprovalService.approve.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("routes continuation to the first actionable linked issue when a blocked one exists", async () => {
    makeApproved();
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-blocked", status: "blocked" },
      { id: "issue-actionable", status: "todo" },
    ]);

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    const wakeArgs = mockHeartbeatService.wakeup.mock.calls[0][1];
    expect(wakeArgs.payload.issueId).toBe("issue-actionable");
    expect(wakeArgs.payload.actionableIssueIds).toEqual(["issue-actionable"]);
    expect(wakeArgs.payload.blockedIssueIds).toEqual(["issue-blocked"]);
    expect(wakeArgs.payload.allLinkedBlocked).toBe(false);
    expect(wakeArgs.contextSnapshot.issueId).toBe("issue-actionable");

    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "approval.requester_wakeup_escalated" }),
    );
  });

  it("wakes without an issueId and logs an explicit escalation when every linked issue is blocked", async () => {
    makeApproved();
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-blocked-1", status: "blocked" },
      { id: "issue-blocked-2", status: "blocked" },
    ]);

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    const wakeArgs = mockHeartbeatService.wakeup.mock.calls[0][1];
    expect(wakeArgs.payload.issueId).toBeNull();
    expect(wakeArgs.payload.allLinkedBlocked).toBe(true);
    expect(wakeArgs.payload.blockedIssueIds).toEqual([
      "issue-blocked-1",
      "issue-blocked-2",
    ]);
    expect(wakeArgs.payload.actionableIssueIds).toEqual([]);
    expect(wakeArgs.contextSnapshot.issueId).toBeNull();
    expect(wakeArgs.contextSnapshot.taskId).toBeNull();
    expect(wakeArgs.contextSnapshot.allLinkedBlocked).toBe(true);

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.requester_wakeup_escalated",
        entityId: "approval-1",
        details: expect.objectContaining({
          reason: "all_linked_issues_blocked",
          blockedIssueIds: ["issue-blocked-1", "issue-blocked-2"],
        }),
      }),
    );
  });

  it("uses the only linked issue and emits no escalation when it is actionable", async () => {
    makeApproved();
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-progress", status: "in_progress" },
    ]);

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    const wakeArgs = mockHeartbeatService.wakeup.mock.calls[0][1];
    expect(wakeArgs.payload.issueId).toBe("issue-progress");
    expect(wakeArgs.payload.allLinkedBlocked).toBe(false);
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "approval.requester_wakeup_escalated" }),
    );
  });

  it("annotates approval.approved activity with actionable and blocked linked issue ids", async () => {
    makeApproved();
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-blocked", status: "blocked" },
      { id: "issue-todo", status: "todo" },
    ]);

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.approved",
        details: expect.objectContaining({
          linkedIssueIds: ["issue-blocked", "issue-todo"],
          actionableIssueIds: ["issue-todo"],
          blockedIssueIds: ["issue-blocked"],
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.requester_wakeup_queued",
        details: expect.objectContaining({
          primaryIssueId: "issue-todo",
          actionableIssueIds: ["issue-todo"],
          blockedIssueIds: ["issue-blocked"],
          allLinkedBlocked: false,
        }),
      }),
    );
  });
});
