import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sourceCompanyId = "11111111-1111-4111-8111-111111111111";
const targetCompanyId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";

const release = {
  id: releaseId,
  sourceCompanyId,
  version: 1,
  title: "Operating model",
  notes: null,
  manifest: {
    schema: "paperclip/v1",
    company: null,
    agents: [],
    skills: [],
    projects: [],
    issues: [],
    includes: {
      company: false,
      agents: false,
      skills: false,
      projects: false,
      issues: false,
    },
    envInputs: [],
  },
  files: {},
  selectedFiles: [],
  packageHash: "hash-1",
  counts: {
    files: 0,
    agents: 0,
    skills: 0,
    projects: 0,
    routines: 0,
    issues: 0,
  },
  createdByUserId: "user-1",
  createdAt: new Date("2026-04-18T00:00:00.000Z"),
};

const previewResult = {
  release,
  targets: [
    {
      companyId: targetCompanyId,
      companyName: "Target",
      companyStatus: "active",
      status: "previewed",
      counts: {
        create: 1,
        update: 0,
        skipNoChange: 0,
        skipUnmanagedConflict: 0,
        error: 0,
      },
      warnings: [],
      errors: [],
      entityActions: [],
      updatedAt: null,
    },
  ],
};

const mockRolloutService = vi.hoisted(() => ({
  createRelease: vi.fn(),
  listReleases: vi.fn(),
  getReleaseDetail: vi.fn(),
  previewRelease: vi.fn(),
  applyRelease: vi.fn(),
}));

function resetCompanyRolloutRouteModules() {
  vi.resetModules();
  vi.doUnmock("@paperclipai/db");
  vi.doUnmock("@paperclipai/shared");
  vi.doUnmock("../services/company-rollouts.js");
  vi.doUnmock("../services/company-rollouts.ts");
  vi.doUnmock("../routes/company-rollouts.js");
  vi.doUnmock("../routes/company-rollouts.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/logger.js");
  vi.doUnmock("../middleware/logger.ts");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../middleware/validate.ts");
}

function registerRouteMocks() {
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../middleware/index.js", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/index.ts", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/logger.js", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../middleware/logger.ts", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/validate.ts", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../services/company-rollouts.js", () => ({
    companyRolloutService: () => mockRolloutService,
  }));
  vi.doMock("../services/company-rollouts.ts", () => ({
    companyRolloutService: () => mockRolloutService,
  }));
}

let companyRolloutRouteImportSeq = 0;

async function createApp(actor: Record<string, unknown>) {
  resetCompanyRolloutRouteModules();
  registerRouteMocks();
  companyRolloutRouteImportSeq += 1;
  const routeModulePath = `../routes/company-rollouts.ts?company-rollouts-routes-${companyRolloutRouteImportSeq}`;
  const [{ errorHandler }, { companyRolloutRoutes }] = await Promise.all([
    import("../middleware/index.ts"),
    import(routeModulePath) as Promise<typeof import("../routes/company-rollouts.ts")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", companyRolloutRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("company rollout routes", () => {
  beforeEach(() => {
    resetCompanyRolloutRouteModules();
    registerRouteMocks();
    vi.clearAllMocks();
    mockRolloutService.createRelease.mockResolvedValue(release);
    mockRolloutService.listReleases.mockResolvedValue([release]);
    mockRolloutService.getReleaseDetail.mockResolvedValue(previewResult);
    mockRolloutService.previewRelease.mockResolvedValue(previewResult);
    mockRolloutService.applyRelease.mockResolvedValue({
      ...previewResult,
      targets: previewResult.targets.map((target) => ({ ...target, status: "applied", applied: true })),
    });
  });

  it("requires board instance-admin access to create a release", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [sourceCompanyId],
    });

    const res = await request(app)
      .post(`/api/companies/${sourceCompanyId}/rollouts`)
      .send({ title: "Operating model" });

    expect(res.status).toBe(403);
    expect(mockRolloutService.createRelease).not.toHaveBeenCalled();
  });

  it("creates an immutable release for an instance admin", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [sourceCompanyId],
    });

    const res = await request(app)
      .post(`/api/companies/${sourceCompanyId}/rollouts`)
      .send({
        title: "Operating model",
        notes: "v1",
        selectedFiles: ["agents/builder/AGENTS.md"],
      });

    expect(res.status).toBe(201);
    expect(mockRolloutService.createRelease).toHaveBeenCalledWith(
      sourceCompanyId,
      {
        title: "Operating model",
        notes: "v1",
        selectedFiles: ["agents/builder/AGENTS.md"],
      },
      "user-1",
    );
  });

  it("rejects agent keys for rollout preview", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: sourceCompanyId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post(`/api/company-rollouts/${releaseId}/preview`)
      .send({ targetCompanyIds: [targetCompanyId] });

    expect(res.status).toBe(403);
    expect(mockRolloutService.previewRelease).not.toHaveBeenCalled();
  });

  it("previews and applies selected targets independently", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [],
    });

    const preview = await request(app)
      .post(`/api/company-rollouts/${releaseId}/preview`)
      .send({ targetCompanyIds: [targetCompanyId] });
    const apply = await request(app)
      .post(`/api/company-rollouts/${releaseId}/apply`)
      .send({ targetCompanyIds: [targetCompanyId] });

    expect(preview.status).toBe(200);
    expect(apply.status).toBe(200);
    expect(mockRolloutService.previewRelease).toHaveBeenCalledWith(
      releaseId,
      { targetCompanyIds: [targetCompanyId] },
      "user-1",
    );
    expect(mockRolloutService.applyRelease).toHaveBeenCalledWith(
      releaseId,
      { targetCompanyIds: [targetCompanyId] },
      "user-1",
    );
  });
});
