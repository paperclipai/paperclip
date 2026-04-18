import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  resolveByReference: vi.fn(),
  getById: vi.fn(),
  getChainOfCommand: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn().mockResolvedValue(false),
  }),
  approvalService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  secretService: () => ({}),
  logActivity: vi.fn(),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("agent key company scope", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockSameCompanyAgentLookup() {
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: { id: "agent-2", companyId: "company-1" },
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-1") {
        return {
          id: "agent-1",
          companyId: "company-1",
          role: "manager",
          permissions: null,
        };
      }
      if (id === "agent-2") {
        return {
          id: "agent-2",
          companyId: "company-1",
          role: "ceo",
          permissions: null,
        };
      }
      return null;
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
  }

  it("rejects agent shortname lookups when an agent key targets another company", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/agents/ceo?companyId=company-2");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
    expect(mockAgentService.resolveByReference).not.toHaveBeenCalled();
  });

  it("uses the actor company for shortname lookups when no company query is supplied", async () => {
    mockSameCompanyAgentLookup();

    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/agents/ceo");

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig).toEqual({});
    expect(res.body.runtimeConfig).toEqual({});
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith(
      "company-1",
      "ceo",
    );
  });

  it("allows agent shortname lookups when the company query matches the actor company", async () => {
    mockSameCompanyAgentLookup();

    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/agents/ceo?companyId=company-1");

    expect(res.status).toBe(200);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith(
      "company-1",
      "ceo",
    );
  });
});
