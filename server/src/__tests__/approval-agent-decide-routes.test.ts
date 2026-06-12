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
  decideByAgent: vi.fn(),
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

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

const COMPANY = "company-1";
const DESIGNATED = "agent-architect";

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { isInstanceAdmin: false, ...actor };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const agentActor = (agentId: string) => ({
  type: "agent",
  agentId,
  companyId: COMPANY,
  source: "api_key",
});

function gateApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "appr-1",
    companyId: COMPANY,
    type: "gate_plan_approval",
    status: "pending",
    payload: { gate: true, designatedAgentId: DESIGNATED },
    ...overrides,
  };
}

describe("POST /approvals/:id/agent-decide", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets the designated agent decide its gate", async () => {
    mockApprovalService.getById.mockResolvedValue(gateApproval());
    mockApprovalService.decideByAgent.mockResolvedValue({
      approval: gateApproval({ status: "approved" }),
      applied: true,
    });
    const app = await createApp(agentActor(DESIGNATED));

    const res = await request(app)
      .post("/api/approvals/appr-1/agent-decide")
      .send({ decision: "approved", decisionNote: "lgtm" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.decideByAgent).toHaveBeenCalledWith(
      "appr-1",
      DESIGNATED,
      "approved",
      "lgtm",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.approved",
        details: expect.objectContaining({ gate: true, decidedByAgentId: DESIGNATED }),
      }),
    );
  });

  it("rejects an agent that is not the designated one", async () => {
    mockApprovalService.getById.mockResolvedValue(gateApproval());
    const app = await createApp(agentActor("agent-someone-else"));

    const res = await request(app)
      .post("/api/approvals/appr-1/agent-decide")
      .send({ decision: "approved" });

    expect(res.status).toBe(403);
    expect(mockApprovalService.decideByAgent).not.toHaveBeenCalled();
  });

  it("rejects deciding a non-gate approval type", async () => {
    mockApprovalService.getById.mockResolvedValue(gateApproval({ type: "hire_agent" }));
    const app = await createApp(agentActor(DESIGNATED));

    const res = await request(app)
      .post("/api/approvals/appr-1/agent-decide")
      .send({ decision: "approved" });

    expect(res.status).toBe(403);
    expect(mockApprovalService.decideByAgent).not.toHaveBeenCalled();
  });

  it("rejects a board/user actor (gate decisions are agent-only)", async () => {
    mockApprovalService.getById.mockResolvedValue(gateApproval());
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: [COMPANY],
      source: "session",
    });

    const res = await request(app)
      .post("/api/approvals/appr-1/agent-decide")
      .send({ decision: "approved" });

    expect(res.status).toBe(403);
    expect(mockApprovalService.decideByAgent).not.toHaveBeenCalled();
  });

  it("keeps the board-only /approve endpoint closed to agents (regression)", async () => {
    mockApprovalService.getById.mockResolvedValue(gateApproval());
    const app = await createApp(agentActor(DESIGNATED));

    const res = await request(app)
      .post("/api/approvals/appr-1/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });
});
