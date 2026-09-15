import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalDetailV2Schema } from "@paperclipai/shared";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

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

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
  const { errorHandler } = await import("../middleware/index.js");
  const { approvalRoutes } = await import("../routes/approvals.js");
  return { errorHandler, approvalRoutes };
});

function createRouteDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
        })),
      })),
    })),
  } as any;
}

function createApp() {
  const { errorHandler, approvalRoutes } = routeModules.value;
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
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

function approvalRecord(payload: Record<string, unknown>, type = "request_board_approval") {
  return {
    id: "approval-1",
    companyId: "company-1",
    type,
    status: "pending",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    payload,
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
    updatedAt: new Date("2026-09-15T00:00:00.000Z"),
  };
}

describe("GET /approvals/:id?v=2 detail contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns a hydrated v2 envelope with omitted payload for a refund approval", async () => {
    mockApprovalService.getById.mockResolvedValue(
      approvalRecord({
        action: "refund",
        orderId: "8891",
        refundAmount: 50,
        currency: "USD",
        reason: "returned",
      }),
    );
    const res = await request(createApp()).get("/api/approvals/approval-1?v=2");
    expect(res.status).toBe(200);
    expect(approvalDetailV2Schema.safeParse(res.body).success).toBe(true);
    expect(res.body.version).toBe(2);
    expect(res.body.payload).toBeUndefined();
    expect(res.body.refund.orderId).toBe("8891");
    expect(res.body.sideEffects.some((e: any) => e.kind === "refund")).toBe(true);
  });

  it("preserves reply context and attaches payload on opt-in", async () => {
    mockApprovalService.getById.mockResolvedValue(
      approvalRecord({
        action: "reply",
        recipient: "customer@example.com",
        subject: "Re: order",
        originalMessage: "where is it?",
        proposedMessage: "shipping today",
      }),
    );
    const res = await request(createApp()).get(
      "/api/approvals/approval-1?v=2&includePayload=1",
    );
    expect(res.status).toBe(200);
    expect(res.body.reply.recipient).toBe("customer@example.com");
    expect(res.body.reply.proposedMessage).toBe("shipping today");
    expect(res.body.payload).toBeDefined();
  });

  it("returns the legacy shape (with raw payload) when v=2 is absent", async () => {
    mockApprovalService.getById.mockResolvedValue(
      approvalRecord({ title: "legacy consumer" }),
    );
    const res = await request(createApp()).get("/api/approvals/approval-1");
    expect(res.status).toBe(200);
    expect(res.body.version).toBeUndefined();
    expect(res.body.payload).toEqual({ title: "legacy consumer" });
  });
});
