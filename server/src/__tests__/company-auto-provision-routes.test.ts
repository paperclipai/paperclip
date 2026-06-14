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
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  ensureRoleDefaultGrants: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));
const mockCompanyArtifactsService = vi.hoisted(() => ({ list: vi.fn() }));
const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGuards: vi.fn(async () => ({ enabled: false, budget: { companyMonthlyTokens: 0 } })),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

// Teams-catalog: one defaultInstall team (dev-team) + a spyable install.
const mockListCatalogTeams = vi.hoisted(() => vi.fn());
const mockInstallCatalogTeam = vi.hoisted(() => vi.fn());
const mockListInstalledCatalogTeams = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyArtifactsService: () => mockCompanyArtifactsService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
}));
vi.mock("../services/teams-catalog.js", () => ({
  listCatalogTeams: mockListCatalogTeams,
  teamsCatalogService: () => ({
    installCatalogTeam: mockInstallCatalogTeam,
    listInstalledCatalogTeams: mockListInstalledCatalogTeams,
  }),
}));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: mockLoggerWarn, info: vi.fn(), error: vi.fn() } }));

const DEV_TEAM = {
  id: "paperclipai:bundled:software-development:dev-team",
  key: "paperclipai/bundled/software-development/dev-team",
  slug: "dev-team",
  defaultInstall: true,
};
const CORE_EXEC = {
  id: "paperclipai:bundled:company-defaults:core-exec-team",
  key: "paperclipai/bundled/company-defaults/core-exec-team",
  slug: "core-exec-team",
  defaultInstall: false,
};

async function createApp() {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", source: "local_implicit", isInstanceAdmin: true, userId: "user-1" };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /api/companies — auto-provision defaultInstall teams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyService.create.mockResolvedValue({ id: "company-1", name: "Acme", budgetMonthlyCents: 0 });
    mockListCatalogTeams.mockResolvedValue([CORE_EXEC, DEV_TEAM]);
    mockListInstalledCatalogTeams.mockResolvedValue([]);
    mockInstallCatalogTeam.mockResolvedValue({ warnings: [] });
  });

  it("installs only the defaultInstall team (dev-team) on company create", async () => {
    const app = await createApp();
    const res = await request(app).post("/api/companies").send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(mockInstallCatalogTeam).toHaveBeenCalledTimes(1);
    expect(mockInstallCatalogTeam).toHaveBeenCalledWith(
      "company-1",
      DEV_TEAM.key,
      expect.objectContaining({ collisionStrategy: "skip" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "company.auto_provisioned", details: { teams: ["dev-team"] } }),
    );
  });

  it("is idempotent — skips a team already installed", async () => {
    mockListInstalledCatalogTeams.mockResolvedValue([{ catalogId: DEV_TEAM.id }]);
    const app = await createApp();
    const res = await request(app).post("/api/companies").send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(mockInstallCatalogTeam).not.toHaveBeenCalled();
  });

  it("is non-fatal — a provisioning failure still creates the company", async () => {
    mockInstallCatalogTeam.mockRejectedValue(new Error("catalog boom"));
    const app = await createApp();
    const res = await request(app).post("/api/companies").send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "company-1" });
    expect(mockLoggerWarn).toHaveBeenCalled();
  });
});
