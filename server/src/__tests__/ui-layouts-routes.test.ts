import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockUiLayoutService = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  uiLayoutService: () => mockUiLayoutService,
  logActivity: mockLogActivity,
}));

async function createApp(actor: Record<string, unknown>) {
  const { errorHandler } = await import("../middleware/index.js");
  const { uiLayoutRoutes } = await import("../routes/ui-layouts.js");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", uiLayoutRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const BOARD_ACTOR = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "owner" }],
};

const VIEWER_ACTOR = {
  ...BOARD_ACTOR,
  userId: "viewer-1",
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }],
};

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const GRAPH_LAYOUT = {
  schemaVersion: 1,
  direction: "TB",
  viewport: null,
  positions: { [AGENT_ID]: { x: 10, y: 20 } },
  hiddenAgentIds: [],
  stickies: [],
  drafts: [],
};

const DASHBOARD_LAYOUT = {
  schemaVersion: 1,
  widgets: [{ instanceId: "w1", widgetId: "metric-agents", w: 1, h: 1 }],
  contextualRules: { "live-runs": true },
};

describe("ui layout routes", () => {
  beforeAll(async () => {
    await createApp({ type: "none" });
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockUiLayoutService.get.mockResolvedValue({
      surface: "agent_graph",
      schemaVersion: 1,
      layout: GRAPH_LAYOUT,
      updatedAt: null,
    });
    mockUiLayoutService.upsert.mockImplementation(async (_companyId, _userId, surface, input) => ({
      surface,
      schemaVersion: input.schemaVersion,
      layout: input.layout,
      updatedAt: null,
    }));
    mockUiLayoutService.remove.mockImplementation(async (_companyId, _userId, surface) => ({
      surface,
      schemaVersion: null,
      layout: null,
      updatedAt: null,
    }));
  });

  it("returns the caller's layout for a company surface", async () => {
    const app = await createApp(BOARD_ACTOR);
    const res = await request(app).get("/api/companies/company-1/ui-layouts/agent_graph/me");
    expect(res.status).toBe(200);
    expect(res.body.layout).toEqual(GRAPH_LAYOUT);
    expect(mockUiLayoutService.get).toHaveBeenCalledWith("company-1", "user-1", "agent_graph");
  });

  it("saves a valid layout for the caller only and keeps this personal preference out of the company activity log", async () => {
    const app = await createApp(BOARD_ACTOR);
    const res = await request(app)
      .put("/api/companies/company-1/ui-layouts/dashboard/me")
      .send({ layout: DASHBOARD_LAYOUT });
    expect(res.status).toBe(200);
    expect(mockUiLayoutService.upsert).toHaveBeenCalledWith("company-1", "user-1", "dashboard", {
      layout: DASHBOARD_LAYOUT,
      schemaVersion: 1,
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects a layout that does not match the surface schema", async () => {
    const app = await createApp(BOARD_ACTOR);
    const res = await request(app)
      .put("/api/companies/company-1/ui-layouts/agent_graph/me")
      .send({ layout: DASHBOARD_LAYOUT });
    expect(res.status).toBe(400);
    expect(mockUiLayoutService.upsert).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects hire drafts that carry adapter configuration", async () => {
    const app = await createApp(BOARD_ACTOR);
    const draft = {
      id: "draft-1", x: 0, y: 0, name: "Copy", role: "engineer", title: null, capabilities: null,
      adapterType: "claude_local", model: null, reportsTo: null, sourceAgentId: AGENT_ID,
      adapterConfig: { env: { ANTHROPIC_API_KEY: "sk-ant-test" } },
    };
    const res = await request(app)
      .put("/api/companies/company-1/ui-layouts/agent_graph/me")
      .send({ layout: { ...GRAPH_LAYOUT, drafts: [draft] } });
    expect(res.status).toBe(400);
    expect(mockUiLayoutService.upsert).not.toHaveBeenCalled();
  });

  it("rejects a layout above the size limit", async () => {
    const app = await createApp(BOARD_ACTOR);
    const sticky = { x: 0, y: 0, width: 200, height: 120, text: "x".repeat(2_000), color: "yellow" };
    const stickies = Array.from({ length: 200 }, (_, index) => ({ ...sticky, id: `s${index}` }));
    const res = await request(app)
      .put("/api/companies/company-1/ui-layouts/agent_graph/me")
      .send({ layout: { ...GRAPH_LAYOUT, stickies } });
    expect(res.status).toBe(400);
    expect(mockUiLayoutService.upsert).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown surface", async () => {
    const app = await createApp(BOARD_ACTOR);
    const res = await request(app).get("/api/companies/company-1/ui-layouts/secrets/me");
    expect(res.status).toBe(404);
    expect(mockUiLayoutService.get).not.toHaveBeenCalled();
  });

  it("rejects a board user without access to the company", async () => {
    const app = await createApp(BOARD_ACTOR);
    const read = await request(app).get("/api/companies/company-2/ui-layouts/agent_graph/me");
    const write = await request(app)
      .put("/api/companies/company-2/ui-layouts/agent_graph/me")
      .send({ layout: GRAPH_LAYOUT });
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(mockUiLayoutService.get).not.toHaveBeenCalled();
    expect(mockUiLayoutService.upsert).not.toHaveBeenCalled();
  });

  it("lets a viewer read, save and reset their own layout", async () => {
    const app = await createApp(VIEWER_ACTOR);
    const read = await request(app).get("/api/companies/company-1/ui-layouts/agent_graph/me");
    const write = await request(app)
      .put("/api/companies/company-1/ui-layouts/dashboard/me")
      .send({ layout: DASHBOARD_LAYOUT });
    const reset = await request(app).delete("/api/companies/company-1/ui-layouts/dashboard/me");
    expect(read.status).toBe(200);
    expect(write.status).toBe(200);
    expect(reset.status).toBe(200);
    expect(mockUiLayoutService.get).toHaveBeenCalledWith("company-1", "viewer-1", "agent_graph");
    expect(mockUiLayoutService.upsert).toHaveBeenCalledWith("company-1", "viewer-1", "dashboard", {
      layout: DASHBOARD_LAYOUT,
      schemaVersion: 1,
    });
    expect(mockUiLayoutService.remove).toHaveBeenCalledWith("company-1", "viewer-1", "dashboard");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects a viewer of another company and a member whose access is not active", async () => {
    const outsider = await createApp(VIEWER_ACTOR);
    const outsiderWrite = await request(outsider)
      .put("/api/companies/company-2/ui-layouts/dashboard/me")
      .send({ layout: DASHBOARD_LAYOUT });
    const outsiderReset = await request(outsider).delete("/api/companies/company-2/ui-layouts/dashboard/me");
    const suspended = await createApp({
      ...VIEWER_ACTOR,
      memberships: [{ companyId: "company-1", status: "suspended", membershipRole: "viewer" }],
    });
    const suspendedRead = await request(suspended).get("/api/companies/company-1/ui-layouts/dashboard/me");
    const suspendedWrite = await request(suspended)
      .put("/api/companies/company-1/ui-layouts/dashboard/me")
      .send({ layout: DASHBOARD_LAYOUT });
    expect(outsiderWrite.status).toBe(403);
    expect(outsiderReset.status).toBe(403);
    expect(suspendedRead.status).toBe(403);
    expect(suspendedWrite.status).toBe(403);
    expect(mockUiLayoutService.get).not.toHaveBeenCalled();
    expect(mockUiLayoutService.upsert).not.toHaveBeenCalled();
    expect(mockUiLayoutService.remove).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });
    const read = await request(app).get("/api/companies/company-1/ui-layouts/agent_graph/me");
    const write = await request(app)
      .put("/api/companies/company-1/ui-layouts/agent_graph/me")
      .send({ layout: GRAPH_LAYOUT });
    const reset = await request(app).delete("/api/companies/company-1/ui-layouts/agent_graph/me");
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(reset.status).toBe(403);
    expect(mockUiLayoutService.get).not.toHaveBeenCalled();
    expect(mockUiLayoutService.upsert).not.toHaveBeenCalled();
    expect(mockUiLayoutService.remove).not.toHaveBeenCalled();
  });

  it("resets the caller's layout without a company activity entry", async () => {
    const app = await createApp(BOARD_ACTOR);
    const res = await request(app).delete("/api/companies/company-1/ui-layouts/dashboard/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ surface: "dashboard", schemaVersion: null, layout: null, updatedAt: null });
    expect(mockUiLayoutService.remove).toHaveBeenCalledWith("company-1", "user-1", "dashboard");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
