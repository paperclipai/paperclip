/**
 * Tier 3 (supertest route) + Tier 4 (RBAC) tests for GET /instance/secrets/plugin.
 *
 * Verifies:
 * - Instance admin can list plugin-owned secrets
 * - local_implicit (dev mode) board can list plugin-owned secrets
 * - Non-admin board member cannot access the endpoint (403)
 * - Non-board actor (plugin / agent) cannot access the endpoint (403)
 * - Route returns filtered results from secretService.listPluginOwned()
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const mockSecretService = vi.hoisted(() => ({
  listPluginOwned: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  secretService: () => mockSecretService,
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
}));

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

type ActorOverride = {
  type: "board" | "plugin" | "agent";
  userId?: string;
  companyIds?: string[];
  source?: "local_implicit" | "session";
  isInstanceAdmin?: boolean;
};

async function createApp(actorOverride: ActorOverride) {
  const [{ instanceSettingsRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/instance-settings.js")>(
      "../routes/instance-settings.js",
    ),
    vi.importActual<typeof import("../middleware/index.js")>(
      "../middleware/index.js",
    ),
  ]);

  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    (req as any).actor = {
      type: actorOverride.type,
      userId: actorOverride.userId ?? "user-1",
      companyIds: actorOverride.companyIds ?? ["company-1"],
      source: actorOverride.source ?? "session",
      isInstanceAdmin: actorOverride.isInstanceAdmin ?? false,
    };
    next();
  });

  app.use(instanceSettingsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const PLUGIN_SECRET_ROW = {
  id: "secret-uuid-1",
  companyId: "company-1",
  name: "GITHUB_TOKEN",
  provider: "local_encrypted",
  externalRef: null,
  latestVersion: 2,
  description: "Created by gitea plugin",
  createdByAgentId: null,
  createdByUserId: "plugin:com.example.gitea",
  createdAt: new Date("2026-05-01T10:00:00Z"),
  updatedAt: new Date("2026-05-02T12:00:00Z"),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /instance/secrets/plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("RBAC — allowed", () => {
    it("returns 200 for instance admin board user", async () => {
      mockSecretService.listPluginOwned.mockResolvedValue([PLUGIN_SECRET_ROW]);
      const app = await createApp({
        type: "board",
        source: "session",
        isInstanceAdmin: true,
      });

      const res = await request(app).get("/instance/secrets/plugin");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("GITHUB_TOKEN");
      expect(res.body[0].createdByUserId).toBe("plugin:com.example.gitea");
    });

    it("returns 200 for local_implicit board (dev mode)", async () => {
      mockSecretService.listPluginOwned.mockResolvedValue([]);
      const app = await createApp({
        type: "board",
        source: "local_implicit",
        isInstanceAdmin: false,
      });

      const res = await request(app).get("/instance/secrets/plugin");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("RBAC — denied", () => {
    it("returns 403 for board user who is not instance admin and not local_implicit", async () => {
      const app = await createApp({
        type: "board",
        source: "session",
        isInstanceAdmin: false,
      });

      const res = await request(app).get("/instance/secrets/plugin");
      expect(res.status).toBe(403);
    });

    it("returns 403 for plugin actor", async () => {
      const app = await createApp({ type: "plugin" });
      const res = await request(app).get("/instance/secrets/plugin");
      expect(res.status).toBe(403);
    });

    it("returns 403 for agent actor", async () => {
      const app = await createApp({ type: "agent" });
      const res = await request(app).get("/instance/secrets/plugin");
      expect(res.status).toBe(403);
    });
  });

  describe("response shape", () => {
    it("returns all plugin-owned secrets from secretService.listPluginOwned", async () => {
      const rows = [
        PLUGIN_SECRET_ROW,
        { ...PLUGIN_SECRET_ROW, id: "secret-uuid-2", name: "SLACK_TOKEN", createdByUserId: "plugin:com.example.slack" },
      ];
      mockSecretService.listPluginOwned.mockResolvedValue(rows);
      const app = await createApp({ type: "board", source: "session", isInstanceAdmin: true });

      const res = await request(app).get("/instance/secrets/plugin");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toHaveLength(2);
      expect(res.body.map((r: any) => r.name)).toEqual(["GITHUB_TOKEN", "SLACK_TOKEN"]);
    });

    it("returns empty array when no plugin secrets exist", async () => {
      mockSecretService.listPluginOwned.mockResolvedValue([]);
      const app = await createApp({ type: "board", source: "session", isInstanceAdmin: true });

      const res = await request(app).get("/instance/secrets/plugin");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
