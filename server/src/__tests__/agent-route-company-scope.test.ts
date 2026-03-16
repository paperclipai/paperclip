import express, { type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeKey: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));
const mockIssueApprovalService = vi.hoisted(() => ({}));
const mockIssueService = vi.hoisted(() => ({}));
const mockSecretService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  secretService: () => mockSecretService,
  logActivity: mockLogActivity,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request).actor = actor as Request["actor"];
    next();
  });
  app.use("/api", agentRoutes({} as never));
  app.use(errorHandler);
  return app;
}

function sendRequest(app: express.Express, method: "get" | "post" | "delete", path: string) {
  if (method === "get") {
    return request(app).get(path);
  }
  if (method === "post") {
    return request(app).post(path);
  }
  return request(app).delete(path);
}

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
} as const;

const foreignAgent = {
  id: "agent-2",
  companyId: "company-2",
  name: "Foreign Agent",
} as const;

describe("agent route company scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(foreignAgent);
    mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it.each([
    ["post", "/api/agents/agent-2/pause", "pause"],
    ["post", "/api/agents/agent-2/resume", "resume"],
    ["post", "/api/agents/agent-2/terminate", "terminate"],
    ["delete", "/api/agents/agent-2", "remove"],
    ["get", "/api/agents/agent-2/keys", "listKeys"],
    ["post", "/api/agents/agent-2/keys", "createApiKey"],
    ["delete", "/api/agents/agent-2/keys/key-1", "revokeKey"],
  ])("rejects cross-company board access for %s %s", async (method, path, serviceMethod) => {
    const app = createApp(boardActor);
    const req = sendRequest(app, method as "get" | "post" | "delete", path);
    const res = method === "post" && path.endsWith("/keys")
      ? await req.send({ name: "Primary" })
      : await req;

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "User does not have access to this company" });
    expect(mockAgentService[serviceMethod as keyof typeof mockAgentService]).not.toHaveBeenCalled();
  });

  it("returns 404 before mutating when the managed agent does not exist", async () => {
    mockAgentService.getById.mockResolvedValueOnce(null);
    const app = createApp(boardActor);

    const res = await request(app).get("/api/agents/missing/keys");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Agent not found" });
    expect(mockAgentService.listKeys).not.toHaveBeenCalled();
  });

  it("logs key revocation when the key belongs to the managed agent", async () => {
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-1",
      companyId: "company-1",
      name: "Scoped Agent",
    });
    mockAgentService.revokeKey.mockResolvedValueOnce({
      id: "key-1",
      agentId: "agent-1",
      companyId: "company-1",
      name: "Primary",
    });
    const app = createApp(boardActor);

    const res = await request(app).delete("/api/agents/agent-1/keys/key-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockLogActivity).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({
        companyId: "company-1",
        action: "agent.key_revoked",
        entityId: "agent-1",
        details: { keyId: "key-1", name: "Primary" },
      }),
    );
  });

  it("returns 404 when the revoked key does not belong to the requested agent", async () => {
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-1",
      companyId: "company-1",
      name: "Scoped Agent",
    });
    mockAgentService.revokeKey.mockResolvedValueOnce({
      id: "key-1",
      agentId: "agent-9",
      companyId: "company-9",
      name: "Foreign",
    });
    const app = createApp(boardActor);

    const res = await request(app).delete("/api/agents/agent-1/keys/key-1");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Key not found" });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
