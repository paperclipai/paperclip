import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { companyCoordinationRoutes } from "../routes/company-coordination.js";

// The route layer must own the coordination authorization gates, so these
// tests stub the services and assert only on routing, gating, and validation.
const mockCoordinationService = vi.hoisted(() => ({
  listCompanyWork: vi.fn(),
  createHandoff: vi.fn(),
}));

const mockGetAgentById = vi.hoisted(() => vi.fn());

vi.mock("../services/company-coordination.js", () => ({
  companyCoordinationService: () => mockCoordinationService,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({ getById: mockGetAgentById }),
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";

// The db is never touched here: every backing service is mocked above.
const fakeDb = {} as unknown as Db;

function grantedAgent() {
  return { companyId, permissions: { canCoordinateCompanyWork: true } };
}

function agentActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent" as const,
    agentId,
    companyId,
    source: "agent_jwt" as const,
    keyScope: { kind: "standard" as const },
    runId,
    ...overrides,
  };
}

function boardActor() {
  return {
    type: "board" as const,
    userId: "board-user",
    source: "board_key" as const,
    companyIds: [companyId],
    isInstanceAdmin: false,
  };
}

function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", companyCoordinationRoutes(fakeDb, { heartbeat: { wakeup: async () => null } }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCoordinationService.listCompanyWork.mockResolvedValue({ items: [], nextOffset: null });
  mockCoordinationService.createHandoff.mockResolvedValue({
    sourceIssueId: "44444444-4444-4444-8444-444444444444",
    targetIssueId: "55555555-5555-4555-8555-555555555555",
    leadAgentId: agentId,
    leadIssueId: "66666666-6666-4666-8666-666666666666",
    commentId: "77777777-7777-4777-8777-777777777777",
    wakeRequestId: null,
  });
});

describe("company coordination routes", () => {
  describe("GET /api/companies/:companyId/coordination/work", () => {
    it("serves a granted agent and forwards the parsed query", async () => {
      mockGetAgentById.mockResolvedValue(grantedAgent());
      const res = await request(createApp(agentActor()))
        .get(`/api/companies/${companyId}/coordination/work`)
        .query({ projectId: "88888888-8888-4888-8888-888888888888", offset: "50" });
      expect(res.status).toBe(200);
      expect(mockCoordinationService.listCompanyWork).toHaveBeenCalledWith(companyId, {
        projectId: "88888888-8888-4888-8888-888888888888",
        offset: 50,
      });
    });

    it("rejects an agent without the coordination grant", async () => {
      mockGetAgentById.mockResolvedValue({ companyId, permissions: {} });
      const res = await request(createApp(agentActor()))
        .get(`/api/companies/${companyId}/coordination/work`);
      expect(res.status).toBe(403);
      expect(mockCoordinationService.listCompanyWork).not.toHaveBeenCalled();
    });

    it("lets a board operator read the list without a grant", async () => {
      const res = await request(createApp(boardActor()))
        .get(`/api/companies/${companyId}/coordination/work`);
      expect(res.status).toBe(200);
      expect(mockCoordinationService.listCompanyWork).toHaveBeenCalledWith(companyId, { offset: 0, projectId: undefined });
    });

    it("rejects unknown query parameters", async () => {
      mockGetAgentById.mockResolvedValue(grantedAgent());
      const res = await request(createApp(agentActor()))
        .get(`/api/companies/${companyId}/coordination/work`)
        .query({ limit: "5" });
      expect(res.status).toBe(400);
    });

    it("rejects a negative or malformed offset", async () => {
      mockGetAgentById.mockResolvedValue(grantedAgent());
      const res = await request(createApp(agentActor()))
        .get(`/api/companies/${companyId}/coordination/work`)
        .query({ offset: "-1" });
      expect(res.status).toBe(400);
    });

    it("rejects a malformed projectId", async () => {
      mockGetAgentById.mockResolvedValue(grantedAgent());
      const res = await request(createApp(agentActor()))
        .get(`/api/companies/${companyId}/coordination/work`)
        .query({ projectId: "not-a-uuid" });
      expect(res.status).toBe(400);
    });

    it("keeps task bridge keys out of the company-wide list", async () => {
      const res = await request(createApp(agentActor({ source: "agent_key", keyScope: { kind: "task_bridge" } })))
        .get(`/api/companies/${companyId}/coordination/work`);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/companies/:companyId/coordination/handoffs", () => {
    const body = {
      sourceIssueId: "44444444-4444-4444-8444-444444444444",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      message: "Please take this over",
      idempotencyKey: "key-1",
    };

    it("forwards a granted agent handoff to the service", async () => {
      mockGetAgentById.mockResolvedValue(grantedAgent());
      const res = await request(createApp(agentActor())).post(`/api/companies/${companyId}/coordination/handoffs`).send(body);
      expect(res.status).toBe(200);
      expect(mockCoordinationService.createHandoff).toHaveBeenCalledWith({
        companyId,
        body,
        actor: { agentId, runId, onBehalfOfUserId: null },
      });
    });

    it("refuses a board caller — board may read but never spoof an agent-run handoff", async () => {
      const res = await request(createApp(boardActor())).post(`/api/companies/${companyId}/coordination/handoffs`).send(body);
      expect(res.status).toBe(403);
      expect(mockCoordinationService.createHandoff).not.toHaveBeenCalled();
    });

    it("refuses a granted agent without a bound run", async () => {
      mockGetAgentById.mockResolvedValue(grantedAgent());
      const res = await request(createApp(agentActor({ runId: undefined })))
        .post(`/api/companies/${companyId}/coordination/handoffs`)
        .send(body);
      expect(res.status).toBe(403);
      expect(mockCoordinationService.createHandoff).not.toHaveBeenCalled();
    });

    it("rejects a strict-body violation (unknown field)", async () => {
      mockGetAgentById.mockResolvedValue(grantedAgent());
      const res = await request(createApp(agentActor()))
        .post(`/api/companies/${companyId}/coordination/handoffs`)
        .send({ ...body, leadAgentId: agentId });
      expect(res.status).toBe(400);
      expect(mockCoordinationService.createHandoff).not.toHaveBeenCalled();
    });

    it("rejects an oversized message", async () => {
      mockGetAgentById.mockResolvedValue(grantedAgent());
      const res = await request(createApp(agentActor()))
        .post(`/api/companies/${companyId}/coordination/handoffs`)
        .send({ ...body, message: "x".repeat(4001) });
      expect(res.status).toBe(400);
    });

    it("rejects an oversized idempotency key", async () => {
      mockGetAgentById.mockResolvedValue(grantedAgent());
      const res = await request(createApp(agentActor()))
        .post(`/api/companies/${companyId}/coordination/handoffs`)
        .send({ ...body, idempotencyKey: "k".repeat(129) });
      expect(res.status).toBe(400);
    });

    it("keeps task bridge keys out of handoffs", async () => {
      const res = await request(createApp(agentActor({ source: "agent_key", keyScope: { kind: "task_bridge" } })))
        .post(`/api/companies/${companyId}/coordination/handoffs`)
        .send(body);
      expect(res.status).toBe(403);
    });
  });
});
