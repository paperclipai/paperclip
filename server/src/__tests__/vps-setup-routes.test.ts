import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { vpsSetupRoutes } from "../routes/vps-setup.js";

const mockAccessService = vi.hoisted(() => ({
  promoteInstanceAdmin: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

function createDb(adminCount: number) {
  return {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            { count: adminCount },
          ]),
      }),
    }),
  } as any;
}

function createApp(actor: any, adminCount = 0) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    vpsSetupRoutes(createDb(adminCount), {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("vps setup routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.promoteInstanceAdmin.mockResolvedValue(undefined);
    mockInstanceSettingsService.updateGeneral.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        domain: "skipped",
        domainConfiguredAt: "2026-01-01T00:00:00.000Z",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
  });

  it("promotes the first signed-in user and logs the bootstrap action", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [],
    });

    const res = await request(app).post("/api/vps/bootstrap-admin");

    expect(res.status).toBe(200);
    expect(mockAccessService.promoteInstanceAdmin).toHaveBeenCalledWith("user-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "instance.vps.bootstrap_admin_claimed",
      }),
    );
  });

  it("marks domain setup skipped and logs the action", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    });

    const res = await request(app).post("/api/vps/skip-domain");

    expect(res.status).toBe(200);
    expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "skipped" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "instance.vps.domain_skipped",
      }),
    );
  });

  it("rejects bootstrap when an admin already exists", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [],
    }, 1);

    const res = await request(app).post("/api/vps/bootstrap-admin");

    expect(res.status).toBe(403);
    expect(mockAccessService.promoteInstanceAdmin).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
