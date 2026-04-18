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

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  ensureMembership: vi.fn(async () => undefined),
}));

const mockRolesService = vi.hoisted(() => ({
  seedSystemRoles: vi.fn(async () => []),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(async () => undefined),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  accessService: () => mockAccessService,
  rolesService: () => mockRolesService,
  budgetService: () => mockBudgetService,
  agentService: () => mockAgentService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

async function createApp() {
  const { companyRoutes } = await import("../routes/companies.js");
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [],
      source: "session",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("company creation seeds system roles", () => {
  it("seeds system roles after a fresh company is created via POST /companies", async () => {
    mockCompanyService.create.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      budgetMonthlyCents: 0,
    });

    const app = await createApp();
    const res = await request(app).post("/api/companies/").send({ name: "Paperclip" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockRolesService.seedSystemRoles).toHaveBeenCalledTimes(1);
    expect(mockRolesService.seedSystemRoles).toHaveBeenCalledWith("company-1");
  });

  it("seeds system roles when import creates a new company", async () => {
    mockCompanyPortabilityService.importBundle.mockResolvedValue({
      company: { id: "company-imported", name: "Imported", action: "created" },
      agents: [],
      warnings: [],
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/import")
      .send({
        source: { type: "inline", files: {} },
        target: { mode: "new_company", newCompanyName: "Imported" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockRolesService.seedSystemRoles).toHaveBeenCalledTimes(1);
    expect(mockRolesService.seedSystemRoles).toHaveBeenCalledWith("company-imported");
  });

  it("does not seed roles when import targets an existing company without recreating it", async () => {
    const existingCompanyId = "11111111-1111-4111-8111-111111111111";
    mockCompanyPortabilityService.importBundle.mockResolvedValue({
      company: { id: existingCompanyId, name: "Kept", action: "updated" },
      agents: [],
      warnings: [],
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user",
        companyIds: [existingCompanyId],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    const { companyRoutes } = await import("../routes/companies.js");
    const { errorHandler } = await import("../middleware/index.js");
    app.use("/api/companies", companyRoutes({} as any));
    app.use(errorHandler);

    const res = await request(app)
      .post("/api/companies/import")
      .send({
        source: { type: "inline", files: {} },
        target: { mode: "existing_company", companyId: existingCompanyId },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockRolesService.seedSystemRoles).not.toHaveBeenCalled();
  });
});
