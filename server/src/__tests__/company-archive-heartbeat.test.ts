import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/index.js";

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
  list: vi.fn(),
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

const mockCancelActiveForAgent = vi.hoisted(() => vi.fn());
const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: mockCancelActiveForAgent,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
}));

function createCompany(overrides?: Record<string, unknown>) {
  const now = new Date("2026-03-21T00:00:00.000Z");
  return {
    id: "company-1",
    name: "Test Co",
    description: null,
    status: "archived",
    issuePrefix: "TST",
    issueCounter: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
    };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /api/companies/:companyId/archive — heartbeat cancellation (#1348)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cancels active heartbeats for all agents in the company on archive", async () => {
    const company = createCompany();
    mockCompanyService.archive.mockResolvedValue(company);
    mockAgentService.list.mockResolvedValue([
      { id: "agent-1", companyId: "company-1", status: "running" },
      { id: "agent-2", companyId: "company-1", status: "running" },
    ]);
    mockCancelActiveForAgent.mockResolvedValue(undefined);

    const app = createApp();
    const res = await request(app).post("/api/companies/company-1/archive");

    expect(res.status).toBe(200);
    expect(mockCancelActiveForAgent).toHaveBeenCalledTimes(2);
    expect(mockCancelActiveForAgent).toHaveBeenCalledWith("agent-1");
    expect(mockCancelActiveForAgent).toHaveBeenCalledWith("agent-2");
  });

  it("does not fail when cancelActiveForAgent rejects (no active runs)", async () => {
    const company = createCompany();
    mockCompanyService.archive.mockResolvedValue(company);
    mockAgentService.list.mockResolvedValue([
      { id: "agent-1", companyId: "company-1", status: "paused" },
    ]);
    mockCancelActiveForAgent.mockRejectedValue(new Error("No active run"));

    const app = createApp();
    const res = await request(app).post("/api/companies/company-1/archive");

    expect(res.status).toBe(200);
    expect(mockCancelActiveForAgent).toHaveBeenCalledWith("agent-1");
  });

  it("returns 404 when company not found", async () => {
    mockCompanyService.archive.mockResolvedValue(null);

    const app = createApp();
    const res = await request(app).post("/api/companies/company-1/archive");

    expect(res.status).toBe(404);
    expect(mockCancelActiveForAgent).not.toHaveBeenCalled();
  });
});
