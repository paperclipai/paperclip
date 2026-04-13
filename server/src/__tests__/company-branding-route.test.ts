import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

function createCompany() {
  const now = new Date("2026-03-19T02:00:00.000Z");
  return {
    id: "company-1",
    name: "Paperclip",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    issueCounter: 568,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    brandColor: "#123456",
    logoAssetId: "11111111-1111-4111-8111-111111111111",
    logoUrl: "/api/assets/11111111-1111-4111-8111-111111111111/content",
    createdAt: now,
    updatedAt: now,
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

describe("PATCH /api/companies/:companyId/branding", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  it("rejects non-CEO agent callers", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({ logoAssetId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("allows CEO agent callers to update branding fields", async () => {
    const company = createCompany();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });
    mockCompanyService.update.mockResolvedValue(company);
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        brandColor: "#123456",
      });

    expect(res.status).toBe(200);
    expect(res.body.logoAssetId).toBe(company.logoAssetId);
    expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", {
      logoAssetId: "11111111-1111-4111-8111-111111111111",
      brandColor: "#123456",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "company.branding_updated",
        details: {
          logoAssetId: "11111111-1111-4111-8111-111111111111",
          brandColor: "#123456",
        },
      }),
    );
  });

  it("allows board callers to update branding fields", async () => {
    const company = createCompany();
    mockCompanyService.update.mockResolvedValue({
      ...company,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({ brandColor: null, logoAssetId: null });

    expect(res.status).toBe(200);
    expect(res.body.brandColor ?? null).toBeNull();
    expect(res.body.logoAssetId ?? null).toBeNull();
  });

  it("rejects non-branding fields in the request body", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        status: "archived",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});
