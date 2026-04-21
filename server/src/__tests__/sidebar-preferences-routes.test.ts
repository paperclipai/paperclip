import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { sidebarPreferenceRoutes } from "../routes/sidebar-preferences.js";

const mockSidebarPreferenceService = vi.hoisted(() => ({
  getCompanyOrder: vi.fn(),
  upsertCompanyOrder: vi.fn(),
  getProjectOrder: vi.fn(),
  upsertProjectOrder: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  sidebarPreferenceService: () => mockSidebarPreferenceService,
  logActivity: mockLogActivity,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", sidebarPreferenceRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const ORDERED_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

describe("sidebar preference routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSidebarPreferenceService.getCompanyOrder.mockResolvedValue({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
    mockSidebarPreferenceService.upsertCompanyOrder.mockResolvedValue({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
    mockSidebarPreferenceService.getProjectOrder.mockResolvedValue({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
    mockSidebarPreferenceService.upsertProjectOrder.mockResolvedValue({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
  });

  it("returns company rail order for board users", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/sidebar-preferences/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
    expect(mockSidebarPreferenceService.getCompanyOrder).toHaveBeenCalledWith("user-1");
  });

  it("updates company rail order for board users", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .put("/api/sidebar-preferences/me")
      .send({ orderedIds: ORDERED_IDS });

    expect(res.status).toBe(200);
    expect(mockSidebarPreferenceService.upsertCompanyOrder).toHaveBeenCalledWith("user-1", ORDERED_IDS);
  });

  it("returns project order for companies the board user can access", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/companies/company-1/sidebar-preferences/me");

    expect(res.status).toBe(200);
    expect(mockSidebarPreferenceService.getProjectOrder).toHaveBeenCalledWith("company-1", "user-1");
  });

  it("logs project order updates for company-scoped writes", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      runId: "run-1",
    });

    const res = await request(app)
      .put("/api/companies/company-1/sidebar-preferences/me")
      .send({ orderedIds: ORDERED_IDS });

    expect(res.status).toBe(200);
    expect(mockSidebarPreferenceService.upsertProjectOrder).toHaveBeenCalledWith("company-1", "user-1", ORDERED_IDS);
    expect(mockLogActivity).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({
        companyId: "company-1",
        action: "sidebar_preferences.project_order_updated",
        details: expect.objectContaining({
          userId: "user-1",
          orderedIds: ORDERED_IDS,
        }),
      }),
    );
  });

  it("rejects company-scoped reads when the board user lacks company access", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app).get("/api/companies/company-1/sidebar-preferences/me");

    expect(res.status).toBe(403);
    expect(mockSidebarPreferenceService.getProjectOrder).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/sidebar-preferences/me");

    expect(res.status).toBe(403);
    expect(mockSidebarPreferenceService.getCompanyOrder).not.toHaveBeenCalled();
  });
});
