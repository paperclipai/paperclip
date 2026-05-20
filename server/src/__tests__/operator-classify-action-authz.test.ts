import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  createApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  logActivity: mockLogActivity,
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ operatorRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/operator.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", operatorRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const callerCompany = "11111111-1111-4111-8111-111111111111";
const otherCompany = "22222222-2222-4222-8222-222222222222";
const callerAgent = "33333333-3333-4333-8333-333333333333";
const callerUser = "44444444-4444-4444-8444-444444444444";

describe("POST /operator/classify-action — body.companyId injection guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores body.companyId and uses the agent caller's own companyId in the audit log", async () => {
    const app = await createApp({
      type: "agent",
      agentId: callerAgent,
      companyId: callerCompany,
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/operator/classify-action")
      .send({
        kind: "file_edit",
        // Attacker-supplied: another company. Must be ignored.
        companyId: otherCompany,
        targetEntityId: "doc-42",
      });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("execute");

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const [, payload] = mockLogActivity.mock.calls[0];
    expect(payload.companyId).toBe(callerCompany);
    expect(payload.companyId).not.toBe(otherCompany);
    expect(payload.actorType).toBe("agent");
    expect(payload.actorId).toBe(callerAgent);
  });

  it("ignores body.companyId and uses a single-company board caller's companyId", async () => {
    const app = await createApp({
      type: "board",
      userId: callerUser,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [callerCompany],
    });

    const res = await request(app)
      .post("/api/operator/classify-action")
      .send({
        kind: "paperclip_comment",
        companyId: otherCompany,
      });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const [, payload] = mockLogActivity.mock.calls[0];
    expect(payload.companyId).toBe(callerCompany);
    expect(payload.companyId).not.toBe(otherCompany);
    expect(payload.actorType).toBe("user");
    expect(payload.actorId).toBe(callerUser);
  });

  it("skips the audit-log entry when a board caller's company scope is ambiguous", async () => {
    const app = await createApp({
      type: "board",
      userId: callerUser,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [callerCompany, otherCompany],
    });

    const res = await request(app)
      .post("/api/operator/classify-action")
      .send({
        kind: "file_edit",
        // Even when ambiguous, the body value never wins.
        companyId: otherCompany,
      });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("execute");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
