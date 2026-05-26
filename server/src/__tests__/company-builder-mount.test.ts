import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";

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

const mockFeedbackService = vi.hoisted(() => ({
  listFeedbackTraces: vi.fn(),
}));

const mockBuilderService = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSessionDetail: vi.fn(),
  createSession: vi.fn(),
  abortSession: vi.fn(),
  archiveSession: vi.fn(),
  restoreSession: vi.fn(),
  sendMessage: vi.fn(),
  getSettings: vi.fn(),
  upsertSettings: vi.fn(),
  getToolCatalog: vi.fn(),
  listProposals: vi.fn(),
  getProposal: vi.fn(),
  applyProposal: vi.fn(),
  rejectProposal: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  rotate: vi.fn(),
  normalizeSecretRefBindingForPersistence: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/builder/index.js", () => ({
    builderService: () => mockBuilderService,
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    budgetService: () => mockBudgetService,
    companyPortabilityService: () => mockCompanyPortabilityService,
    companyService: () => mockCompanyService,
    feedbackService: () => mockFeedbackService,
    awaitingHumanSettingsService: () => ({
      get: vi.fn(),
      update: vi.fn(),
      resolveProvider: vi.fn(),
      resolveClickUpRuntimeConfig: vi.fn(),
      getStored: vi.fn(),
    }),
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
    (req as unknown as { actor: typeof actor }).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("company routes builder mount", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../services/builder/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/secrets.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();

    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      builderEnabled: true,
    });
    mockBuilderService.listSessions.mockResolvedValue([
      {
        id: "session-1",
        companyId,
        title: "Builder chat",
      },
    ]);
  });

  it("serves builder endpoints through companyRoutes", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/companies/${companyId}/builder/sessions`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      {
        id: "session-1",
        companyId,
        title: "Builder chat",
      },
    ]);
    expect(mockBuilderService.listSessions).toHaveBeenCalledWith(companyId, { includeArchived: false });
  });
});
