import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const issueId = "11111111-1111-4111-8111-111111111111";
const agentA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ceoAgentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentAclService = vi.hoisted(() => ({
  listGrants: vi.fn(),
  getDefaults: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentAclService: () => mockAgentAclService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({}),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(async () => undefined),
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

const boardActor = {
  type: "board",
  userId: "board-user",
  companyIds: [companyId],
  source: "local_implicit",
  isInstanceAdmin: false,
};

function agentActor(agentId: string) {
  return { type: "agent", agentId, companyId, companyIds: [companyId], runId: "run-1" };
}

function makeIssue(assigneeAgentId: string | null = agentB) {
  return {
    id: issueId,
    companyId,
    status: "todo",
    assigneeAgentId,
    assigneeUserId: null,
    createdByAgentId: agentB,
    createdByUserId: null,
    executionRunId: null,
    checkoutRunId: null,
    identifier: "LAM-99",
    title: "Test issue",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAccessService.hasPermission.mockResolvedValue(true);
  mockAgentAclService.listGrants.mockResolvedValue([]);
  mockAgentAclService.getDefaults.mockResolvedValue(null);
  mockAgentService.getById.mockResolvedValue({ id: agentA, companyId, role: "engineer" });
  mockIssueService.findMentionedAgents.mockResolvedValue([]);
});

describe("ACL enforcement — task creation", () => {
  it("blocks agent without assign grant from creating issue assigned to another agent", async () => {
    const res = await request(createApp(agentActor(agentA)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "New task", assigneeAgentId: agentB });

    expect(res.status).toBe(403);
  });

  it("allows agent with explicit assign grant to create assigned issue", async () => {
    mockAgentAclService.listGrants.mockResolvedValue([
      { id: "grant-1", companyId, granteeId: agentA, agentId: agentB, permission: "assign" },
    ]);
    mockIssueService.create.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "LAM-99",
      title: "New task",
      status: "todo",
      assigneeAgentId: agentB,
    });

    const res = await request(createApp(agentActor(agentA)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "New task", assigneeAgentId: agentB });

    expect(res.status).toBe(201);
  });

  it("allows assign when company assignDefault=true and no explicit grant", async () => {
    mockAgentAclService.getDefaults.mockResolvedValue({ companyId, assignDefault: true, commentDefault: false });
    mockIssueService.create.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "LAM-99",
      title: "New task",
      status: "todo",
      assigneeAgentId: agentB,
    });

    const res = await request(createApp(agentActor(agentA)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "New task", assigneeAgentId: agentB });

    expect(res.status).toBe(201);
  });

  it("allows CEO agent to create assigned issue via explicit grant", async () => {
    mockAgentService.getById.mockResolvedValue({ id: ceoAgentId, companyId, role: "ceo" });
    mockAgentAclService.listGrants.mockResolvedValue([
      { id: "grant-1", companyId, granteeId: ceoAgentId, agentId: agentB, permission: "assign" },
    ]);
    mockIssueService.create.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "LAM-99",
      title: "New task",
      status: "todo",
      assigneeAgentId: agentB,
    });

    const res = await request(createApp(agentActor(ceoAgentId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "New task", assigneeAgentId: agentB });

    expect(res.status).toBe(201);
  });

  it("allows board user with tasks:assign grant to create assigned issue", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    mockIssueService.create.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "LAM-99",
      title: "New task",
      status: "todo",
      assigneeAgentId: agentB,
    });

    const res = await request(createApp(boardActor))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "New task", assigneeAgentId: agentB });

    expect(res.status).toBe(201);
    expect(mockAgentAclService.listGrants).not.toHaveBeenCalled();
  });
});

describe("ACL enforcement — task reassignment via PATCH", () => {
  it("blocks agent without assign grant from reassigning to another agent", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue(agentA));

    const res = await request(createApp(agentActor(agentA)))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: agentB });

    expect(res.status).toBe(403);
  });

  it("allows agent with explicit assign grant to reassign", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue(agentA));
    mockAgentAclService.listGrants.mockResolvedValue([
      { id: "grant-1", companyId, granteeId: agentA, agentId: agentB, permission: "assign" },
    ]);
    mockIssueService.update.mockResolvedValue({ ...makeIssue(agentB) });

    const res = await request(createApp(agentActor(agentA)))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: agentB });

    expect(res.status).toBe(200);
  });
});

describe("ACL enforcement — comment posting", () => {
  it("blocks agent without comment grant from commenting on another agent's issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue(agentB));

    const res = await request(createApp(agentActor(agentA)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hello" });

    expect(res.status).toBe(403);
  });

  it("allows agent with explicit comment grant to comment", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue(agentB));
    mockAgentAclService.listGrants.mockResolvedValue([
      { id: "grant-1", companyId, granteeId: agentA, agentId: agentB, permission: "comment" },
    ]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({});
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId,
      companyId,
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: agentA,
      authorUserId: null,
    });

    const res = await request(createApp(agentActor(agentA)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hello" });

    expect(res.status).toBe(201);
  });

  it("allows self-comment (assignee commenting on own issue)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue(agentA));
    mockIssueService.assertCheckoutOwner.mockResolvedValue({});
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId,
      companyId,
      body: "self comment",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: agentA,
      authorUserId: null,
    });

    const res = await request(createApp(agentActor(agentA)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "self comment" });

    expect(res.status).toBe(201);
    expect(mockAgentAclService.listGrants).not.toHaveBeenCalled();
  });

  it("allows comment on unassigned issue without grant check", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue(null));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId,
      companyId,
      body: "comment on unassigned",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: agentA,
      authorUserId: null,
    });

    const res = await request(createApp(agentActor(agentA)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "comment on unassigned" });

    expect(res.status).toBe(201);
    expect(mockAgentAclService.listGrants).not.toHaveBeenCalled();
  });

  it("allows board user to comment without grant check", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue(agentB));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId,
      companyId,
      body: "board comment",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "board-user",
    });

    const res = await request(createApp(boardActor))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "board comment" });

    expect(res.status).toBe(201);
    expect(mockAgentAclService.listGrants).not.toHaveBeenCalled();
  });

  it("allows comment when company commentDefault=true and no explicit grant", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue(agentB));
    mockAgentAclService.getDefaults.mockResolvedValue({ companyId, assignDefault: false, commentDefault: true });
    mockIssueService.assertCheckoutOwner.mockResolvedValue({});
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId,
      companyId,
      body: "default allowed",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: agentA,
      authorUserId: null,
    });

    const res = await request(createApp(agentActor(agentA)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "default allowed" });

    expect(res.status).toBe(201);
  });
});
