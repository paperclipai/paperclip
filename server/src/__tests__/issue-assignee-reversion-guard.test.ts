/**
 * Tests for FRE-202: agent assignee-change guard.
 *
 * Non-CEO agents must not be able to change assigneeAgentId on an issue
 * they do not currently own (i.e., where existing.assigneeAgentId !== actorAgentId).
 * This prevents stale runs from overriding a CEO reassignment.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY_ID = "5056d9c4-d5c2-42bf-9011-c0e2c837e2d5";
const ISSUE_ID = "11111111-1111-4111-8111-111111111101";
const CEO_AGENT_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const ORIGINAL_AGENT_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const NEW_AGENT_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const REASSIGNED_AGENT_ID = "dddddddd-dddd-4ddd-dddd-dddddddddddd";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getHeartbeatPolicy: vi.fn(async () => ({
    enabled: true,
    intervalSec: 0,
    wakeOnDemand: true,
    wakeOnComment: true,
    maxConcurrentRuns: 1,
  })),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function baseIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    identifier: "FRE-TEST",
    title: "Test Issue",
    status: "in_review",
    assigneeAgentId: REASSIGNED_AGENT_ID, // CEO reassigned to this agent
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    createdByUserId: null,
    labels: [],
    ...overrides,
  };
}

function createApp(actorAgentId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: actorAgentId,
      runId: "run-stale-1",
      companyId: COMPANY_ID,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue assignee-reversion guard (FRE-202)", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Default: issue exists, CEO has reassigned it to REASSIGNED_AGENT_ID
    mockIssueService.getById.mockResolvedValue(baseIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null); // not an identifier lookup
    mockIssueService.update.mockResolvedValue(baseIssue());
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      body: "done",
      issueId: ISSUE_ID,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAccessService.hasPermission.mockResolvedValue(true); // agents have tasks:assign
    mockAccessService.canUser.mockResolvedValue(true);
  });

  it("blocks non-CEO agent from reassigning an issue it does not own", async () => {
    // Original agent (not the current assignee) tries to baton-pass to Code Reviewer
    mockAgentService.getById.mockResolvedValue({
      id: ORIGINAL_AGENT_ID,
      role: "developer",
      companyId: COMPANY_ID,
      permissions: {},
    });

    const app = createApp(ORIGINAL_AGENT_ID);
    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_review", assigneeAgentId: NEW_AGENT_ID, comment: "done" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/CEO reassignment takes precedence/);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows current assignee to baton-pass (own the issue)", async () => {
    // The issue is now assigned to ORIGINAL_AGENT_ID (they still own it)
    mockIssueService.getById.mockResolvedValue(baseIssue({ assigneeAgentId: ORIGINAL_AGENT_ID }));
    mockIssueService.update.mockResolvedValue(
      baseIssue({ assigneeAgentId: NEW_AGENT_ID, status: "in_review" }),
    );
    mockAgentService.getById.mockResolvedValue({
      id: ORIGINAL_AGENT_ID,
      role: "developer",
      companyId: COMPANY_ID,
      permissions: {},
    });

    const app = createApp(ORIGINAL_AGENT_ID);
    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_review", assigneeAgentId: NEW_AGENT_ID, comment: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows CEO-role agent to reassign any issue", async () => {
    // CEO can always override
    mockAgentService.getById.mockResolvedValue({
      id: CEO_AGENT_ID,
      role: "ceo",
      companyId: COMPANY_ID,
      permissions: {},
    });

    const app = createApp(CEO_AGENT_ID);
    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeAgentId: NEW_AGENT_ID });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows agent to update issue without changing assignee", async () => {
    // Status-only PATCH, no assigneeAgentId — should always be allowed
    mockAgentService.getById.mockResolvedValue({
      id: ORIGINAL_AGENT_ID,
      role: "developer",
      companyId: COMPANY_ID,
      permissions: {},
    });

    const app = createApp(ORIGINAL_AGENT_ID);
    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ comment: "status update only" });

    expect(res.status).toBe(200);
  });
});
