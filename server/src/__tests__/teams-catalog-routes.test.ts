import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockTeamsCatalogService = vi.hoisted(() => ({
  previewCatalogTeamImport: vi.fn(),
  installCatalogTeam: vi.fn(),
  listInstalledCatalogTeams: vi.fn(),
}));

const mockCatalogModule = vi.hoisted(() => ({
  listCatalogTeams: vi.fn(),
  getCatalogTeamOrThrow: vi.fn(),
  readCatalogTeamFile: vi.fn(),
  teamsCatalogService: vi.fn(() => mockTeamsCatalogService),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/teams-catalog.js", () => mockCatalogModule);
}

async function createApp(actor: Record<string, unknown>) {
  const [{ teamsCatalogRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/teams-catalog.js")>("../routes/teams-catalog.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", teamsCatalogRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function catalogTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: "paperclipai:bundled:software-development:product-engineering",
    key: "paperclipai/bundled/software-development/product-engineering",
    kind: "bundled",
    category: "software-development",
    slug: "product-engineering",
    name: "Product Engineering",
    description: "A software development team with CTO, coder, and QA roles.",
    path: "catalog/bundled/software-development/product-engineering",
    entrypoint: "TEAM.md",
    schema: "agentcompanies/v1",
    defaultInstall: true,
    recommendedForCompanyTypes: ["software"],
    tags: ["engineering"],
    counts: { agents: 3, projects: 1, tasks: 1, routines: 0, localSkills: 0, catalogSkills: 1, externalSkillSources: 0 },
    rootAgentSlugs: ["cto"],
    agentSlugs: ["cto", "senior-coder", "qa"],
    projectSlugs: ["product-engineering"],
    requiredSkills: [],
    envInputs: [],
    sourceRefs: [],
    files: [{ path: "TEAM.md", kind: "team", sizeBytes: 128, sha256: "sha256:team" }],
    trustLevel: "markdown_only",
    compatibility: "compatible",
    contentHash: "sha256:catalog-team",
    ...overrides,
  };
}

const companyId = "11111111-1111-4111-8111-111111111111";

describe("teams catalog routes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      permissions: { canCreateAgents: true },
    });
    mockCatalogModule.listCatalogTeams.mockReturnValue([catalogTeam()]);
    mockCatalogModule.getCatalogTeamOrThrow.mockReturnValue(catalogTeam());
    mockCatalogModule.readCatalogTeamFile.mockResolvedValue({
      catalogTeamId: "paperclipai:bundled:software-development:product-engineering",
      path: "TEAM.md",
      kind: "team",
      content: "# Product Engineering",
      language: "markdown",
      markdown: true,
    });
    mockTeamsCatalogService.previewCatalogTeamImport.mockResolvedValue({
      team: catalogTeam(),
      portabilityPreview: {
        plan: { companyAction: "none", agentPlans: [], projectPlans: [], issuePlans: [] },
        warnings: [],
        errors: [],
      },
      skillPreparations: [],
      warnings: [],
      errors: [],
    });
    mockTeamsCatalogService.listInstalledCatalogTeams.mockResolvedValue([
      {
        catalogId: "paperclipai:bundled:software-development:product-engineering",
        catalogKey: "paperclipai/bundled/software-development/product-engineering",
        present: true,
        currentContentHash: "sha256:catalog-team",
        installedOriginHashes: ["sha256:old"],
        agentCount: 3,
        outOfDate: true,
      },
    ]);
    mockTeamsCatalogService.installCatalogTeam.mockResolvedValue({
      team: catalogTeam(),
      portabilityImport: {
        company: { id: companyId, name: "Paperclip", action: "unchanged" },
        agents: [],
        projects: [],
        envInputs: [],
        warnings: [],
      },
      skillPreparations: [],
      warnings: [],
    });
  });

  it("serves catalog listings, details, and files for authenticated actors", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const list = await request(app).get("/api/teams/catalog?kind=bundled&q=engineering");
    const detail = await request(app).get("/api/teams/catalog/product-engineering");
    const file = await request(app).get("/api/teams/catalog/product-engineering/files?path=TEAM.md");

    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    expect(mockCatalogModule.listCatalogTeams).toHaveBeenCalledWith({ kind: "bundled", q: "engineering" });
    expect(mockCatalogModule.getCatalogTeamOrThrow).toHaveBeenCalledWith("product-engineering");
    expect(mockCatalogModule.readCatalogTeamFile).toHaveBeenCalledWith("product-engineering", "TEAM.md");
  });

  it("returns server-computed installed-team state for actors with company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/teams/catalog/installed`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockTeamsCatalogService.listInstalledCatalogTeams).toHaveBeenCalledWith(companyId);
    expect(res.body).toEqual([
      expect.objectContaining({
        catalogId: "paperclipai:bundled:software-development:product-engineering",
        present: true,
        outOfDate: true,
        agentCount: 3,
      }),
    ]);
  });

  it("denies installed-team state to actors without company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "other",
      companyIds: ["22222222-2222-4222-8222-222222222222"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/teams/catalog/installed`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockTeamsCatalogService.listInstalledCatalogTeams).not.toHaveBeenCalled();
  });

  it("requires authentication for catalog read routes", async () => {
    const app = await createApp({ type: "none" });

    const list = await request(app).get("/api/teams/catalog");
    const detail = await request(app).get("/api/teams/catalog/product-engineering");
    const file = await request(app).get("/api/teams/catalog/product-engineering/files?path=TEAM.md");

    expect(list.status, JSON.stringify(list.body)).toBe(401);
    expect(detail.status, JSON.stringify(detail.body)).toBe(401);
    expect(file.status, JSON.stringify(file.body)).toBe(401);
    expect(mockCatalogModule.listCatalogTeams).not.toHaveBeenCalled();
  });

  it("previews catalog teams with company access and actor/source policy context", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/teams/catalog/ref/preview?ref=paperclipai%2Fbundled%2Fsoftware-development%2Fproduct-engineering`)
      .send({
        targetManagerSlug: "engineering-lead",
        sourcePolicy: { allowExternalSources: true },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockTeamsCatalogService.previewCatalogTeamImport).toHaveBeenCalledWith(
      companyId,
      "paperclipai/bundled/software-development/product-engineering",
      expect.objectContaining({
        targetManagerSlug: "engineering-lead",
        sourcePolicy: { allowExternalSources: true },
        actor: expect.objectContaining({
          actorType: "user",
          actorId: "local-board",
          runId: "run-1",
        }),
      }),
    );
  });

  it("rejects catalog preview requests that try to include company metadata", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/teams/catalog/product-engineering/preview`)
      .send({
        include: { company: true, agents: true },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(mockTeamsCatalogService.previewCatalogTeamImport).not.toHaveBeenCalled();
  });

  it("installs catalog teams only for actors that can create agents", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/teams/catalog/product-engineering/install`)
      .send({
        collisionStrategy: "rename",
        secretValues: { "agent:cto:OPENAI_API_KEY": "sk-test" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockTeamsCatalogService.installCatalogTeam).toHaveBeenCalledWith(
      companyId,
      "product-engineering",
      expect.objectContaining({
        collisionStrategy: "rename",
        secretValues: { "agent:cto:OPENAI_API_KEY": "sk-test" },
        actor: expect.objectContaining({
          actorType: "agent",
          actorId: "agent-1",
          agentId: "agent-1",
          runId: "run-1",
        }),
      }),
    );
  });

  it("blocks same-company agents without management permission from installing catalog teams", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      permissions: {},
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/teams/catalog/product-engineering/install`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockTeamsCatalogService.installCatalogTeam).not.toHaveBeenCalled();
  });
});
