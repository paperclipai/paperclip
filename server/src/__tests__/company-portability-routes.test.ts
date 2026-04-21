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

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    budgetService: () => mockBudgetService,
    companyPortabilityService: () => mockCompanyPortabilityService,
    companyService: () => mockCompanyService,
    feedbackService: () => mockFeedbackService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
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

const companyId = "11111111-1111-4111-8111-111111111111";

const exportRequest = {
  include: { company: true, agents: true, projects: true },
};

function createExportResult() {
  return {
    rootPath: "paperclip",
    manifest: {
      agents: [],
      skills: [],
      projects: [],
      issues: [],
      envInputs: [],
      includes: { company: true, agents: true, projects: true, issues: false, skills: false },
      company: null,
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      source: null,
    },
    files: {},
    warnings: [],
  };
}

describe("company portability routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
  });

  it("rejects non-CEO agents from CEO-safe export preview routes", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/exports/preview`)
      .send(exportRequest);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
  });

  it("rejects non-CEO agents from legacy and CEO-safe export bundle routes", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    for (const path of [`/api/companies/${companyId}/export`, `/api/companies/${companyId}/exports`]) {
      const res = await request(app).post(path).send(exportRequest);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only CEO agents");
    }
    expect(mockCompanyPortabilityService.exportBundle).not.toHaveBeenCalled();
  });

  it("allows CEO agents to use company-scoped export preview routes", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      role: "ceo",
    });
    mockCompanyPortabilityService.previewExport.mockResolvedValue({
      rootPath: "paperclip",
      manifest: { agents: [], skills: [], projects: [], issues: [], envInputs: [], includes: { company: true, agents: true, projects: true, issues: false, skills: false }, company: null, schemaVersion: 1, generatedAt: new Date().toISOString(), source: null },
      files: {},
      fileInventory: [],
      counts: { files: 0, agents: 0, skills: 0, projects: 0, issues: 0 },
      warnings: [],
      paperclipExtensionPath: ".paperclip.yaml",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/exports/preview`)
      .send(exportRequest);

    expect(res.status).toBe(200);
    expect(res.body.rootPath).toBe("paperclip");
  });

  it("allows CEO agents to export through legacy and CEO-safe bundle routes", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      role: "ceo",
    });
    mockCompanyPortabilityService.exportBundle.mockResolvedValue(createExportResult());
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    for (const path of [`/api/companies/${companyId}/export`, `/api/companies/${companyId}/exports`]) {
      const res = await request(app).post(path).send(exportRequest);

      expect(res.status).toBe(200);
      expect(res.body.rootPath).toBe("paperclip");
    }
    expect(mockCompanyPortabilityService.exportBundle).toHaveBeenCalledTimes(2);
    expect(mockCompanyPortabilityService.exportBundle).toHaveBeenNthCalledWith(1, companyId, exportRequest);
    expect(mockCompanyPortabilityService.exportBundle).toHaveBeenNthCalledWith(2, companyId, exportRequest);
  });

  it("allows board users to export through legacy and CEO-safe bundle routes", async () => {
    mockCompanyPortabilityService.exportBundle.mockResolvedValue(createExportResult());
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    for (const path of [`/api/companies/${companyId}/export`, `/api/companies/${companyId}/exports`]) {
      const res = await request(app).post(path).send(exportRequest);

      expect(res.status).toBe(200);
      expect(res.body.rootPath).toBe("paperclip");
    }
    expect(mockCompanyPortabilityService.exportBundle).toHaveBeenCalledTimes(2);
  });

  it("rejects replace collision strategy on CEO-safe import routes", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      role: "ceo",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "replace",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("does not allow replace");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it("keeps global import preview routes board-only", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/import/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });

  it("requires instance admin for new-company import preview", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["11111111-1111-4111-8111-111111111111"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/import/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "new_company", newCompanyName: "Imported Test" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it("rejects replace collision strategy on CEO-safe import apply routes", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      role: "ceo",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/apply")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "replace",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("does not allow replace");
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it("rejects non-CEO agents from CEO-safe import preview routes", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it("rejects non-CEO agents from CEO-safe import apply routes", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/apply")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it("requires instance admin for new-company import apply", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["11111111-1111-4111-8111-111111111111"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/import")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "new_company", newCompanyName: "Imported Test" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });
});
