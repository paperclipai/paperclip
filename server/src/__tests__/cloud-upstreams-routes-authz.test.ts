import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCloudUpstreamService = vi.hoisted(() => ({
  list: vi.fn(),
  readConnection: vi.fn(),
  startConnect: vi.fn(),
  finishConnect: vi.fn(),
  preview: vi.fn(),
  createRun: vi.fn(),
  readRun: vi.fn(),
  cancelRun: vi.fn(),
  activateRunEntities: vi.fn(),
}));

vi.mock("../routes/authz.js", async () => {
  const { forbidden } = await vi.importActual<typeof import("../errors.js")>("../errors.js");

  function assertBoardOrgAccess(req: Express.Request) {
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }
  }

  function assertCompanyAccess(req: Express.Request, companyId: string) {
    assertBoardOrgAccess(req);
    if (!req.actor.companyIds?.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
  }

  return {
    assertBoardOrgAccess,
    assertCompanyAccess,
  };
});

vi.mock("../services/index.js", () => ({
  cloudUpstreamService: () => mockCloudUpstreamService,
  instanceSettingsService: () => ({
    getExperimental: vi.fn(async () => ({ enableCloudSync: true })),
  }),
}));

let routeModules:
  | Promise<[
    typeof import("../middleware/index.js"),
    typeof import("../routes/cloud-upstreams.js"),
  ]>
  | null = null;

async function loadRouteModules() {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/cloud-upstreams.js"),
  ]);
  return routeModules;
}

async function createApp(companyIds: string[]) {
  const [{ errorHandler }, { cloudUpstreamRoutes }] = await loadRouteModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "session",
      companyIds,
    };
    next();
  });
  app.use("/api", cloudUpstreamRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("cloud upstream route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudUpstreamService.list.mockResolvedValue({ connections: [], runs: [] });
    mockCloudUpstreamService.readConnection.mockResolvedValue({
      id: "connection-1",
      companyId: "company-a",
      remoteUrl: "https://cloud.example",
      target: {
        stackId: "stack-1",
        stackSlug: null,
        stackDisplayName: null,
        companyId: "cloud-company",
        primaryHost: "cloud.example",
        origin: "https://cloud.example",
        product: "Paperclip Cloud",
        schemaMajor: 1,
        maxChunkBytes: 1024,
      },
      tokenStatus: "connected",
      scopes: [],
      authorizedGlobalUserId: null,
      expiresAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastRunId: null,
    });
    mockCloudUpstreamService.preview.mockResolvedValue({
      connectionId: "connection-1",
      sourceCompanyId: "company-a",
      target: {
        stackId: "stack-1",
        stackSlug: null,
        stackDisplayName: null,
        companyId: "cloud-company",
        primaryHost: "cloud.example",
        origin: "https://cloud.example",
        product: "Paperclip Cloud",
        schemaMajor: 1,
        maxChunkBytes: 1024,
      },
      schemaCompatible: true,
      summary: [],
      warnings: [],
      conflicts: [],
      generatedAt: new Date(0).toISOString(),
    });
  });

  it("rejects list requests for companies outside the board actor membership", async () => {
    const app = await createApp(["company-a"]);

    const res = await request(app).get("/api/cloud-upstreams?companyId=company-b");

    expect(res.status).toBe(403);
    expect(mockCloudUpstreamService.list).not.toHaveBeenCalled();
  });

  it("checks connection company access before previewing a connection-scoped endpoint", async () => {
    const app = await createApp(["company-b"]);

    const res = await request(app).post("/api/cloud-upstreams/connection-1/push-runs/preview").send({});

    expect(res.status).toBe(403);
    expect(mockCloudUpstreamService.preview).not.toHaveBeenCalled();
  });
});
