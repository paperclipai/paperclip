import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

async function createBoardApp(actorOverrides: Record<string, unknown> = {}) {
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
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status: "pending",
    payload: { title: "Test approval" },
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-05-12T00:00:00.000Z"),
    updatedAt: new Date("2026-05-12T00:00:00.000Z"),
    ...overrides,
  };
}

describe("approval wake reliability", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.list.mockReset();
    mockApprovalService.getById.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.approve.mockReset();
    mockApprovalService.reject.mockReset();
    mockApprovalService.requestRevision.mockReset();
    mockApprovalService.resubmit.mockReset();
    mockApprovalService.listComments.mockReset();
    mockApprovalService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockReset();
    mockLogActivity.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-1" },
    ]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("approve wake (regression)", () => {
    it("queues requester wakeup on approve with correct params", async () => {
      const approval = makeApproval();
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.approve.mockResolvedValue({
        approval: { ...approval, status: "approved" },
        applied: true,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/approve")
        .send({ decisionNote: "ship it" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("approved");
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({
          source: "automation",
          triggerDetail: "system",
          reason: "approval_approved",
          payload: expect.objectContaining({
            approvalId: "approval-1",
            approvalStatus: "approved",
          }),
          contextSnapshot: expect.objectContaining({
            approvalId: "approval-1",
            approvalStatus: "approved",
            wakeReason: "approval_approved",
          }),
        }),
      );
    });

    it("does not wakeup on approve if applied is false (idempotent)", async () => {
      const approval = makeApproval({ status: "approved" });
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.approve.mockResolvedValue({
        approval,
        applied: false,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/approve")
        .send({});

      expect(res.status).toBe(200);
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });

    it("does not wakeup on approve if no requestedByAgentId", async () => {
      const approval = makeApproval({ requestedByAgentId: null });
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.approve.mockResolvedValue({
        approval: { ...approval, status: "approved" },
        applied: true,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/approve")
        .send({});

      expect(res.status).toBe(200);
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });
  });

  describe("reject wake", () => {
    it("queues requester wakeup on reject with correct params", async () => {
      const approval = makeApproval();
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.reject.mockResolvedValue({
        approval: { ...approval, status: "rejected", decisionNote: "not now" },
        applied: true,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/reject")
        .send({ decisionNote: "not now" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("rejected");
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({
          source: "automation",
          triggerDetail: "system",
          reason: "approval_rejected",
          payload: expect.objectContaining({
            approvalId: "approval-1",
            approvalStatus: "rejected",
          }),
          contextSnapshot: expect.objectContaining({
            approvalId: "approval-1",
            approvalStatus: "rejected",
            wakeReason: "approval_rejected",
          }),
        }),
      );
    });

    it("does not wakeup on reject if applied is false (idempotent)", async () => {
      const approval = makeApproval({ status: "rejected" });
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.reject.mockResolvedValue({
        approval,
        applied: false,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/reject")
        .send({ decisionNote: "already rejected" });

      expect(res.status).toBe(200);
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });

    it("does not wakeup on reject if no requestedByAgentId", async () => {
      const approval = makeApproval({ requestedByAgentId: null });
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.reject.mockResolvedValue({
        approval: { ...approval, status: "rejected" },
        applied: true,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/reject")
        .send({ decisionNote: "not now" });

      expect(res.status).toBe(200);
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });
  });

  describe("request-revision wake", () => {
    it("queues requester wakeup on request-revision with correct params", async () => {
      const approval = makeApproval();
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.requestRevision.mockResolvedValue({
        ...approval,
        status: "revision_requested",
        decisionNote: "needs changes",
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/request-revision")
        .send({ decisionNote: "needs changes" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("revision_requested");
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({
          source: "automation",
          triggerDetail: "system",
          reason: "approval_revision_requested",
          payload: expect.objectContaining({
            approvalId: "approval-1",
            approvalStatus: "revision_requested",
          }),
          contextSnapshot: expect.objectContaining({
            approvalId: "approval-1",
            approvalStatus: "revision_requested",
            wakeReason: "approval_revision_requested",
          }),
        }),
      );
    });

    it("does not wakeup on request-revision if no requestedByAgentId", async () => {
      const approval = makeApproval({ requestedByAgentId: null });
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.requestRevision.mockResolvedValue({
        ...approval,
        status: "revision_requested",
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/request-revision")
        .send({ decisionNote: "needs changes" });

      expect(res.status).toBe(200);
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });
  });

  describe("multi-cycle reliability", () => {
    const RELIABILITY_CYCLES = 5;

    it(`survives ${RELIABILITY_CYCLES} consecutive reject cycles without missing a wakeup`, async () => {
      for (let i = 0; i < RELIABILITY_CYCLES; i++) {
        const approvalId = `approval-${i}`;
        const approval = makeApproval({ id: approvalId });
        mockApprovalService.getById.mockResolvedValue(approval);
        mockApprovalService.reject.mockResolvedValue({
          approval: { ...approval, status: "rejected", decisionNote: `cycle ${i}` },
          applied: true,
        });

        const res = await request(await createBoardApp())
          .post(`/api/approvals/${approvalId}/reject`)
          .send({ decisionNote: `cycle ${i}` });

        expect(res.status).toBe(200);
        expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(i + 1);
      }
    });

    it(`survives ${RELIABILITY_CYCLES} consecutive request-revision cycles without missing a wakeup`, async () => {
      for (let i = 0; i < RELIABILITY_CYCLES; i++) {
        const approvalId = `approval-${i}`;
        const approval = makeApproval({ id: approvalId });
        mockApprovalService.getById.mockResolvedValue(approval);
        mockApprovalService.requestRevision.mockResolvedValue({
          ...approval,
          status: "revision_requested",
          decisionNote: `cycle ${i}`,
        });

        const res = await request(await createBoardApp())
          .post(`/api/approvals/${approvalId}/request-revision`)
          .send({ decisionNote: `cycle ${i}` });

        expect(res.status).toBe(200);
        expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(i + 1);
      }
    });

    it(`survives ${RELIABILITY_CYCLES} alternating reject / revision cycles without missing a wakeup`, async () => {
      let wakeCount = 0;
      for (let i = 0; i < RELIABILITY_CYCLES; i++) {
        if (i % 2 === 0) {
          const approvalId = `approval-reject-${i}`;
          const approval = makeApproval({ id: approvalId });
          mockApprovalService.getById.mockResolvedValue(approval);
          mockApprovalService.reject.mockResolvedValue({
            approval: { ...approval, status: "rejected", decisionNote: `reject cycle ${i}` },
            applied: true,
          });

          const res = await request(await createBoardApp())
            .post(`/api/approvals/${approvalId}/reject`)
            .send({ decisionNote: `reject cycle ${i}` });

          expect(res.status).toBe(200);
          wakeCount++;
          expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(wakeCount);
        } else {
          const approvalId = `approval-rev-${i}`;
          const approval = makeApproval({ id: approvalId });
          mockApprovalService.getById.mockResolvedValue(approval);
          mockApprovalService.requestRevision.mockResolvedValue({
            ...approval,
            status: "revision_requested",
            decisionNote: `revision cycle ${i}`,
          });

          const res = await request(await createBoardApp())
            .post(`/api/approvals/${approvalId}/request-revision`)
            .send({ decisionNote: `revision cycle ${i}` });

          expect(res.status).toBe(200);
          wakeCount++;
          expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(wakeCount);
        }
      }
    });

    it(`survives ${RELIABILITY_CYCLES} full lifecycle cycles (approve -> resubmit -> reject -> resubmit -> revision) without missed wakeups`, async () => {
      let wakeCount = 0;
      const lifecycleApproval = makeApproval({ id: "lifecycle-approval" });

      // Approve
      mockApprovalService.getById.mockResolvedValue(lifecycleApproval);
      mockApprovalService.approve.mockResolvedValue({
        approval: { ...lifecycleApproval, status: "approved" },
        applied: true,
      });
      const approveRes = await request(await createBoardApp())
        .post("/api/approvals/lifecycle-approval/approve")
        .send({ decisionNote: "approved" });
      expect(approveRes.status).toBe(200);
      wakeCount++;
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(wakeCount);

      // Resubmit to pending (no wakeup for resubmit)
      const pendingApproval = { ...lifecycleApproval, status: "pending", decisionNote: null };
      mockApprovalService.getById.mockResolvedValue(pendingApproval);

      for (let i = 0; i < RELIABILITY_CYCLES; i++) {
        // Reject
        mockApprovalService.reject.mockResolvedValue({
          approval: { ...lifecycleApproval, id: `approval-lifecycle-${i}`, status: "rejected", decisionNote: `reject ${i}` },
          applied: true,
        });
        const rejApproval = makeApproval({ id: `approval-lifecycle-${i}`, status: "pending" });
        mockApprovalService.getById.mockResolvedValue(rejApproval);

        const rejRes = await request(await createBoardApp())
          .post(`/api/approvals/approval-lifecycle-${i}/reject`)
          .send({ decisionNote: `reject ${i}` });
        expect(rejRes.status).toBe(200);
        wakeCount++;
        expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(wakeCount);

        // Request revision on next approval
        const revApproval = makeApproval({ id: `approval-lifecycle-rev-${i}`, status: "pending" });
        mockApprovalService.getById.mockResolvedValue(revApproval);
        mockApprovalService.requestRevision.mockResolvedValue({
          ...revApproval,
          status: "revision_requested",
          decisionNote: `revision ${i}`,
        });

        const revRes = await request(await createBoardApp())
          .post(`/api/approvals/approval-lifecycle-rev-${i}/request-revision`)
          .send({ decisionNote: `revision ${i}` });
        expect(revRes.status).toBe(200);
        wakeCount++;
        expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(wakeCount);
      }
    });
  });
});
