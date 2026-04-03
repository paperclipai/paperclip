import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentAclRoutes } from "../routes/agent-acl.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const granteeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const grantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
}));

const mockAgentAclService = vi.hoisted(() => ({
  listGrants: vi.fn(),
  createGrant: vi.fn(),
  deleteGrant: vi.fn(),
  getDefaults: vi.fn(),
  upsertDefaults: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  agentAclService: () => mockAgentAclService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentAclRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const localBoard = {
  type: "board",
  userId: "local-board",
  companyIds: [companyId],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const ceoAgent = {
  type: "agent",
  agentId: "ceo-agent-id",
  companyId,
  runId: "run-1",
};

const engineerAgent = {
  type: "agent",
  agentId: "eng-agent-id",
  companyId,
  runId: "run-2",
};

const sampleGrant = {
  id: grantId,
  companyId,
  granteeId,
  agentId,
  permission: "assign",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const sampleDefaults = {
  companyId,
  assignDefault: false,
  commentDefault: false,
  updatedAt: new Date("2026-01-01"),
};

describe("agent ACL routes — grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAgentAclService.listGrants.mockResolvedValue([sampleGrant]);
    mockAgentAclService.createGrant.mockResolvedValue(sampleGrant);
    mockAgentAclService.deleteGrant.mockResolvedValue(sampleGrant);
    mockAgentAclService.getDefaults.mockResolvedValue(sampleDefaults);
    mockAgentAclService.upsertDefaults.mockResolvedValue(sampleDefaults);
    mockAgentService.getById.mockImplementation((id: string) => {
      if (id === "ceo-agent-id") return Promise.resolve({ id, companyId, role: "ceo", permissions: {} });
      if (id === "eng-agent-id") return Promise.resolve({ id, companyId, role: "engineer", permissions: {} });
      return Promise.resolve(null);
    });
  });

  it("board can list grants", async () => {
    const res = await request(createApp(localBoard))
      .get(`/api/companies/${companyId}/agent-permission-grants`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockAgentAclService.listGrants).toHaveBeenCalledWith(companyId, {
      granteeId: undefined,
      agentId: undefined,
      permission: undefined,
    });
  });

  it("board can create a grant", async () => {
    const res = await request(createApp(localBoard))
      .post(`/api/companies/${companyId}/agent-permission-grants`)
      .send({ granteeId, agentId, permission: "assign" });
    expect(res.status).toBe(201);
    expect(mockAgentAclService.createGrant).toHaveBeenCalledWith(companyId, granteeId, agentId, "assign");
  });

  it("rejects invalid permission value on create", async () => {
    const res = await request(createApp(localBoard))
      .post(`/api/companies/${companyId}/agent-permission-grants`)
      .send({ granteeId, agentId, permission: "invalid-perm" });
    expect(res.status).toBe(400);
    expect(mockAgentAclService.createGrant).not.toHaveBeenCalled();
  });

  it("CEO agent can create a grant", async () => {
    const res = await request(createApp(ceoAgent))
      .post(`/api/companies/${companyId}/agent-permission-grants`)
      .send({ granteeId, agentId, permission: "comment" });
    expect(res.status).toBe(201);
  });

  it("non-CEO agent cannot create a grant", async () => {
    const res = await request(createApp(engineerAgent))
      .post(`/api/companies/${companyId}/agent-permission-grants`)
      .send({ granteeId, agentId, permission: "assign" });
    expect(res.status).toBe(403);
    expect(mockAgentAclService.createGrant).not.toHaveBeenCalled();
  });

  it("board can delete a grant", async () => {
    const res = await request(createApp(localBoard))
      .delete(`/api/companies/${companyId}/agent-permission-grants/${grantId}`);
    expect(res.status).toBe(200);
    expect(mockAgentAclService.deleteGrant).toHaveBeenCalledWith(companyId, grantId);
  });

  it("returns 404 when deleting a non-existent grant", async () => {
    mockAgentAclService.deleteGrant.mockResolvedValue(null);
    const res = await request(createApp(localBoard))
      .delete(`/api/companies/${companyId}/agent-permission-grants/${grantId}`);
    expect(res.status).toBe(404);
  });
});

describe("agent ACL routes — defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAgentAclService.getDefaults.mockResolvedValue(sampleDefaults);
    mockAgentAclService.upsertDefaults.mockResolvedValue({ ...sampleDefaults, assignDefault: true });
    mockAgentService.getById.mockImplementation((id: string) => {
      if (id === "ceo-agent-id") return Promise.resolve({ id, companyId, role: "ceo", permissions: {} });
      return Promise.resolve(null);
    });
  });

  it("board can get defaults", async () => {
    const res = await request(createApp(localBoard))
      .get(`/api/companies/${companyId}/agent-permission-defaults`);
    expect(res.status).toBe(200);
    expect(res.body.assignDefault).toBe(false);
  });

  it("returns sensible defaults when no row exists", async () => {
    mockAgentAclService.getDefaults.mockResolvedValue(null);
    const res = await request(createApp(localBoard))
      .get(`/api/companies/${companyId}/agent-permission-defaults`);
    expect(res.status).toBe(200);
    expect(res.body.assignDefault).toBe(false);
    expect(res.body.commentDefault).toBe(false);
  });

  it("board can patch defaults", async () => {
    const res = await request(createApp(localBoard))
      .patch(`/api/companies/${companyId}/agent-permission-defaults`)
      .send({ assignDefault: true });
    expect(res.status).toBe(200);
    expect(mockAgentAclService.upsertDefaults).toHaveBeenCalledWith(companyId, { assignDefault: true });
  });

  it("non-CEO agent cannot patch defaults", async () => {
    const res = await request(createApp(engineerAgent))
      .patch(`/api/companies/${companyId}/agent-permission-defaults`)
      .send({ assignDefault: true });
    expect(res.status).toBe(403);
    expect(mockAgentAclService.upsertDefaults).not.toHaveBeenCalled();
  });
});
