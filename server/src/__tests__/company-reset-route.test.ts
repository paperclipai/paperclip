import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/index.js";
import { unprocessable } from "../errors.js";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  reset: vi.fn(),
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
    // placeholder UUIDs for test/example purposes
    logoAssetId: "00000000-0000-4000-8000-000000000000", // placeholder for example
    logoUrl: "/api/assets/00000000-0000-4000-8000-000000000000/content", // placeholder for example
    createdAt: now,
    updatedAt: now,
  };
}

function createApp(actor: Record<string, unknown>) {
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

describe("POST /api/companies/:companyId/reset", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects when confirmCompanyName does not match", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany());
    mockCompanyService.reset.mockRejectedValue(
      unprocessable("Company name does not match"),
    );
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/reset")
      .send({ confirmCompanyName: "WrongName" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Company name does not match");
    expect(mockCompanyService.reset).toHaveBeenCalledWith(
      "company-1",
      "WrongName",
    );
  });

  it("rejects when confirmCompanyName is empty", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/reset")
      .send({ confirmCompanyName: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("resets company org when confirmCompanyName matches", async () => {
    const company = createCompany();
    mockCompanyService.getById.mockResolvedValue(company);
    mockCompanyService.reset.mockResolvedValue({
      company,
      deletedCounts: {
        agents: 5,
        projects: 3,
        goals: 2,
        issues: 47,
        routines: 4,
        skills: 6,
        labels: 8,
        budgets: 1,
        secrets: 2,
      },
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/reset")
      .send({ confirmCompanyName: "Paperclip" });

    expect(res.status).toBe(200);
    expect(res.body.company.id).toBe("company-1");
    expect(res.body.deletedCounts.agents).toBe(5);
    expect(res.body.deletedCounts.issues).toBe(47);
    expect(mockCompanyService.reset).toHaveBeenCalledWith(
      "company-1",
      "Paperclip",
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const call = mockLogActivity.mock.calls[0]![1];
    expect(call.companyId).toBe("company-1");
    expect(call.action).toBe("company.reset");
    expect(call.entityType).toBe("company");
    expect(call.entityId).toBe("company-1");
    expect(call.details.deletedCounts.agents).toBe(5);
    expect(call.details.deletedCounts.issues).toBe(47);
  });

  it("allows board members to reset company", async () => {
    const company = createCompany();
    mockCompanyService.getById.mockResolvedValue(company);
    mockCompanyService.reset.mockResolvedValue({
      company,
      deletedCounts: {
        agents: 0,
        projects: 0,
        goals: 0,
        issues: 0,
        routines: 0,
        skills: 0,
        labels: 0,
        budgets: 0,
        secrets: 0,
      },
    });
    const app = createApp({
      type: "board",
      userId: "board-user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/reset")
      .send({ confirmCompanyName: "Paperclip" });

    expect(res.status).toBe(200);
    expect(mockCompanyService.reset).toHaveBeenCalled();
  });

  it("preserves company after reset", async () => {
    const company = createCompany();
    mockCompanyService.getById.mockResolvedValue(company);
    mockCompanyService.reset.mockResolvedValue({
      company,
      deletedCounts: {
        agents: 1,
        projects: 1,
        goals: 1,
        issues: 1,
        routines: 1,
        skills: 1,
        labels: 1,
        budgets: 1,
        secrets: 1,
      },
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/reset")
      .send({ confirmCompanyName: "Paperclip" });

    expect(res.status).toBe(200);
    expect(res.body.company.id).toBe("company-1");
    expect(res.body.company.name).toBe("Paperclip");
    expect(res.body.company.status).toBe("active");
  });
});
