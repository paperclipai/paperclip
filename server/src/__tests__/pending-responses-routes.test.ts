import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pendingResponseRoutes } from "../routes/pending-responses.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const PENDING_RESPONSE_ID = "33333333-3333-4333-8333-333333333333";

const mockSvc = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../services/pending-responses.js", () => ({
  pendingResponseService: () => mockSvc,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", pendingResponseRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /api/companies/:companyId/pending-responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.create.mockResolvedValue({ id: PENDING_RESPONSE_ID });
  });

  it("creates a pending response and returns 201 with id", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/pending-responses`)
      .send({ waitingAgentId: AGENT_ID, channelId: "C12345", threadTs: "1234567890.123456" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: PENDING_RESPONSE_ID });
    expect(mockSvc.create).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      waitingAgentId: AGENT_ID,
      channelId: "C12345",
      threadTs: "1234567890.123456",
      expiresAt: undefined,
    });
  });

  it("computes expiresAt when expiresInMinutes is provided", async () => {
    const app = createApp();
    const before = Date.now();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/pending-responses`)
      .send({ waitingAgentId: AGENT_ID, channelId: "C12345", threadTs: "1234567890.123456", expiresInMinutes: 60 });
    const after = Date.now();

    expect(res.status).toBe(201);
    const { expiresAt } = mockSvc.create.mock.calls[0]![0] as { expiresAt: Date };
    expect(expiresAt).toBeInstanceOf(Date);
    const expiresMs = expiresAt.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + 60 * 60 * 1000);
  });

  it("returns 400 when waitingAgentId is not a UUID", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/pending-responses`)
      .send({ waitingAgentId: "not-a-uuid", channelId: "C12345", threadTs: "1234567890.123456" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/pending-responses`)
      .send({ waitingAgentId: AGENT_ID });

    expect(res.status).toBe(400);
  });

  it("returns 403 when actor lacks access to the company", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: AGENT_ID,
        companyIds: ["different-company-id"],
        source: "api_key",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", pendingResponseRoutes({} as any));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/pending-responses`)
      .send({ waitingAgentId: AGENT_ID, channelId: "C12345", threadTs: "1234567890.123456" });

    expect(res.status).toBe(403);
  });
});
