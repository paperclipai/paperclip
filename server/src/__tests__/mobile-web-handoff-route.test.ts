import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockMobileWebHandoffService = vi.hoisted(() => ({
  create: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
  agentService: () => mockAgentService,
  projectService: () => mockProjectService,
  mobileWebHandoffService: () => mockMobileWebHandoffService,
}));

function createCompany(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-03-19T02:00:00.000Z");
  return {
    id: "company-1",
    name: "Paperclip",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "PAP",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createAgent(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-03-19T02:00:00.000Z");
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "CTO",
    role: "cto",
    status: "active",
    adapterType: "openai",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    title: null,
    reportsTo: null,
    capabilities: null,
    metadata: null,
    permissions: [],
    createdAt: now,
    updatedAt: now,
    urlKey: "cto",
    ...overrides,
  };
}

function createProject(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-03-19T02:00:00.000Z");
  return {
    id: "project-1",
    companyId: "company-1",
    name: "Get Rich",
    description: null,
    status: "backlog",
    goalId: null,
    goalIds: [],
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    executionWorkspacePolicy: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    urlKey: "get-rich",
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ mobileWebHandoffRedirectRoutes, mobileWebHandoffRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/mobile-web-handoff.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(mobileWebHandoffRedirectRoutes());
  app.use("/api/mobile-web-handoff", mobileWebHandoffRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("mobile web handoff routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  it("creates a no-company onboarding handoff", async () => {
    mockMobileWebHandoffService.create.mockResolvedValue({
      token: "token-123",
      expiresAt: new Date("2026-04-13T16:00:00.000Z"),
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/mobile-web-handoff")
      .set("host", "paperclip.example.com")
      .send({ target: "onboarding" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "http://paperclip.example.com/auth/mobile-handoff?token=token-123",
      expiresAt: "2026-04-13T16:00:00.000Z",
    });
    expect(mockMobileWebHandoffService.create).toHaveBeenCalledWith({
      userId: "user-1",
      targetPath: "/onboarding",
      companyId: null,
    });
  });

  it("creates a company-scoped onboarding handoff", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    mockMobileWebHandoffService.create.mockResolvedValue({
      token: "token-123",
      expiresAt: new Date("2026-04-13T16:00:00.000Z"),
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "remote_auth",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/mobile-web-handoff")
      .send({ target: "onboarding", companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(mockMobileWebHandoffService.create).toHaveBeenCalledWith({
      userId: "user-1",
      targetPath: "/PAP/onboarding",
      companyId: "company-1",
    });
  });

  it("creates an agent configuration handoff", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    mockAgentService.getById.mockResolvedValue(createAgent());
    mockMobileWebHandoffService.create.mockResolvedValue({
      token: "token-123",
      expiresAt: new Date("2026-04-13T16:00:00.000Z"),
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "remote_auth",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/mobile-web-handoff")
      .send({
        target: "agent_configuration",
        companyId: "company-1",
        agentId: "agent-1",
      });

    expect(res.status).toBe(200);
    expect(mockMobileWebHandoffService.create).toHaveBeenCalledWith({
      userId: "user-1",
      targetPath: "/PAP/agents/cto/configuration",
      companyId: "company-1",
    });
  });

  it("creates a project configuration handoff", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    mockProjectService.getById.mockResolvedValue(createProject());
    mockMobileWebHandoffService.create.mockResolvedValue({
      token: "token-123",
      expiresAt: new Date("2026-04-13T16:00:00.000Z"),
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "remote_auth",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/mobile-web-handoff")
      .send({
        target: "project_configuration",
        companyId: "company-1",
        projectId: "project-1",
      });

    expect(res.status).toBe(200);
    expect(mockMobileWebHandoffService.create).toHaveBeenCalledWith({
      userId: "user-1",
      targetPath: "/PAP/projects/get-rich/configuration",
      companyId: "company-1",
    });
  });

  it("returns 404 when the requested company is missing", async () => {
    mockCompanyService.getById.mockResolvedValue(null);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "remote_auth",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/mobile-web-handoff")
      .send({ target: "onboarding", companyId: "company-1" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Company not found");
  });

  it("returns 404 when the requested agent is missing", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    mockAgentService.getById.mockResolvedValue(null);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "remote_auth",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/mobile-web-handoff")
      .send({
        target: "agent_configuration",
        companyId: "company-1",
        agentId: "agent-1",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
  });

  it("returns 404 when the requested project is missing", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    mockProjectService.getById.mockResolvedValue(null);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "remote_auth",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/mobile-web-handoff")
      .send({
        target: "project_configuration",
        companyId: "company-1",
        projectId: "project-1",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Project not found");
  });

  it("rejects unauthorized company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "remote_auth",
      companyIds: [],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/mobile-web-handoff")
      .send({ target: "onboarding", companyId: "company-1" });

    expect(res.status).toBe(403);
  });

  it("redirects public handoff requests into the auth consume route", async () => {
    const app = await createApp({
      type: "none",
    });

    const res = await request(app).get("/auth/mobile-handoff?token=token-123");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/api/auth/mobile-web-handoff/consume?token=token-123");
  });
});
