import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";

const mockApprovalService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  pause: vi.fn(),
  schedule: vi.fn(),
  publish: vi.fn(),
  recall: vi.fn(),
  deleteById: vi.fn(),
  updateContent: vi.fn(),
  setScheduleOverride: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(async () => []),
  linkManyForApproval: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  update: vi.fn(),
  addComment: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(async (_c: unknown, p: unknown) => p),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockNotifyKatya = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  secretService: () => mockSecretService,
  logActivity: mockLogActivity,
  notifyKatyaPublishApproved: mockNotifyKatya,
}));

function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaa0000-0000-4000-8000-000000000001",
    companyId: "cccc0000-0000-4000-8000-000000000001",
    type: "approve_ceo_strategy",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: { draft: "hello" },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    commentCount: 0,
    ...overrides,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["cccc0000-0000-4000-8000-000000000001"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("approval state machine — request-revision", () => {
  beforeEach(() => vi.clearAllMocks());

  it("transitions pending → revision_requested", async () => {
    const pending = makeApproval({ status: "pending" });
    const revised = makeApproval({ status: "revision_requested" });
    mockApprovalService.requestRevision.mockResolvedValue(revised);
    mockApprovalService.getById.mockResolvedValue(pending);

    const app = createApp();
    const res = await request(app)
      .post(`/api/approvals/${pending.id}/request-revision`)
      .send({ decisionNote: "needs work" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.requestRevision).toHaveBeenCalledWith(
      pending.id,
      "board",
      "needs work",
    );
  });

  it("transitions approved → revision_requested (Problem 2 fix)", async () => {
    const approved = makeApproval({ status: "approved" });
    const revised = makeApproval({ status: "revision_requested" });
    mockApprovalService.requestRevision.mockResolvedValue(revised);
    mockApprovalService.getById.mockResolvedValue(approved);

    const app = createApp();
    const res = await request(app)
      .post(`/api/approvals/${approved.id}/request-revision`)
      .send({ decisionNote: "post-approval revision" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.requestRevision).toHaveBeenCalledWith(
      approved.id,
      "board",
      "post-approval revision",
    );
  });

  it("logs the transition", async () => {
    const approved = makeApproval({ status: "approved" });
    const revised = makeApproval({ status: "revision_requested" });
    mockApprovalService.requestRevision.mockResolvedValue(revised);
    mockApprovalService.getById.mockResolvedValue(approved);

    const app = createApp();
    await request(app)
      .post(`/api/approvals/${approved.id}/request-revision`)
      .send({});

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "approval.revision_requested" }),
    );
  });

  it("blocks non-board actors", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: "some-agent-id",
        companyIds: ["cccc0000-0000-4000-8000-000000000001"],
        source: "bearer",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", approvalRoutes({} as any));
    app.use(errorHandler);

    const res = await request(app)
      .post("/api/approvals/any-id/request-revision")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("is idempotent when approval is already revision_requested (returns 200)", async () => {
    const revision = makeApproval({ status: "revision_requested" });
    mockApprovalService.getById.mockResolvedValue(revision);
    mockApprovalService.requestRevision.mockResolvedValue(revision);

    const app = createApp();
    const res = await request(app)
      .post(`/api/approvals/${revision.id}/request-revision`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockApprovalService.requestRevision).toHaveBeenCalled();
  });

  it("resubmit restores pending from revision_requested", async () => {
    const revision = makeApproval({ status: "revision_requested" });
    const pending = makeApproval({ status: "pending" });
    mockApprovalService.getById.mockResolvedValue(revision);
    mockApprovalService.resubmit.mockResolvedValue(pending);

    const app = createApp();
    const res = await request(app)
      .post(`/api/approvals/${revision.id}/resubmit`)
      .send({ payload: { draft: "updated content" } });

    expect(res.status).toBe(200);
    expect(mockApprovalService.resubmit).toHaveBeenCalledWith(
      revision.id,
      { draft: "updated content" },
    );
  });
});

describe("approval state machine — content update route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("PATCH /approvals/:id/content updates payload on approved approval", async () => {
    const approved = makeApproval({ status: "approved" });
    const updated = makeApproval({ status: "approved", payload: { draft: "edited" } });
    mockApprovalService.getById.mockResolvedValue(approved);
    mockApprovalService.updateContent.mockResolvedValue(updated);

    const app = createApp();
    const res = await request(app)
      .patch(`/api/approvals/${approved.id}/content`)
      .send({ payload: { draft: "edited" } });

    expect(res.status).toBe(200);
    expect(mockApprovalService.updateContent).toHaveBeenCalledWith(
      approved.id,
      { draft: "edited" },
    );
  });

  it("logs approval.content_updated activity", async () => {
    const approved = makeApproval({ status: "approved" });
    const updated = makeApproval({ status: "approved" });
    mockApprovalService.getById.mockResolvedValue(approved);
    mockApprovalService.updateContent.mockResolvedValue(updated);

    const app = createApp();
    await request(app)
      .patch(`/api/approvals/${approved.id}/content`)
      .send({ payload: { draft: "v2" } });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "approval.content_updated" }),
    );
  });

  it("returns 404 for unknown approval", async () => {
    mockApprovalService.getById.mockResolvedValue(null);
    const app = createApp();
    const res = await request(app)
      .patch("/api/approvals/does-not-exist/content")
      .send({ payload: {} });
    expect(res.status).toBe(404);
  });
});
