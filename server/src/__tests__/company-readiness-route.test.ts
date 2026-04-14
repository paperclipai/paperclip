import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => mockAgentService,
  budgetService: () => ({}),
  companyPortabilityService: () => ({}),
  companyService: () => mockCompanyService,
  feedbackService: () => ({}),
  secretService: () => mockSecretService,
  logActivity: vi.fn(),
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

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/companies.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /api/companies/:companyId/readiness", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  it("returns ready when the company has agents and secrets", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    mockAgentService.list.mockResolvedValue([{ id: "agent-1", status: "active" }]);
    mockSecretService.list.mockResolvedValue([{ id: "secret-1" }]);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .get("/api/companies/company-1/readiness")
      .set("host", "paperclip.example.com");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      companyId: "company-1",
      status: "ready",
      reasons: [],
      webSetupUrl: "http://paperclip.example.com/PAP/onboarding",
    });
    expect(mockAgentService.list).toHaveBeenCalledWith("company-1");
    expect(mockSecretService.list).toHaveBeenCalledWith("company-1");
  });

  it("returns both reasons when agents and secrets are missing", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    mockAgentService.list.mockResolvedValue([]);
    mockSecretService.list.mockResolvedValue([]);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/readiness");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.reasons).toEqual(["missing_secrets", "no_agents_configured"]);
  });

  it("returns missing_secrets when only secrets are missing", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    mockAgentService.list.mockResolvedValue([{ id: "agent-1", status: "active" }]);
    mockSecretService.list.mockResolvedValue([]);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/readiness");

    expect(res.status).toBe(200);
    expect(res.body.reasons).toEqual(["missing_secrets"]);
  });

  it("returns no_agents_configured when only agents are missing", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    mockAgentService.list.mockResolvedValue([]);
    mockSecretService.list.mockResolvedValue([{ id: "secret-1" }]);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/readiness");

    expect(res.status).toBe(200);
    expect(res.body.reasons).toEqual(["no_agents_configured"]);
  });

  it("falls back to /onboarding when the company prefix is missing", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany({ issuePrefix: "" }));
    mockAgentService.list.mockResolvedValue([]);
    mockSecretService.list.mockResolvedValue([]);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .get("/api/companies/company-1/readiness")
      .set("x-forwarded-proto", "https")
      .set("x-forwarded-host", "paperclip.example.com");

    expect(res.status).toBe(200);
    expect(res.body.webSetupUrl).toBe("https://paperclip.example.com/onboarding");
  });

  it("returns 404 when the company does not exist", async () => {
    mockCompanyService.getById.mockResolvedValue(null);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/readiness");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Company not found");
  });

  it("rejects board callers without company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "remote_auth",
      companyIds: [],
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/companies/company-1/readiness");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("does not have access");
  });

  it("rejects unauthenticated callers", async () => {
    const app = await createApp({
      type: "none",
    });

    const res = await request(app).get("/api/companies/company-1/readiness");

    expect(res.status).toBe(401);
  });
});
