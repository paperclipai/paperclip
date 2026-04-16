import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  hasPermission: vi.fn(),
  canUser: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
  listBoardApiKeys: vi.fn(),
  createBoardApiKeyForUser: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  getExperimental: vi.fn(),
  get: vi.fn(),
  updateGeneral: vi.fn(),
  updateExperimental: vi.fn(),
  listCompanyIds: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
  deduplicateAgentName: vi.fn((name: string) => name),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => mockBoardAuthService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
    notifyHireApproved: vi.fn(),
    deduplicateAgentName: vi.fn((name: string) => name),
  }));
}

function generalWithBoardKeys(enabled: boolean) {
  return {
    censorUsernameInLogs: false,
    keyboardShortcuts: false,
    feedbackDataSharingPreference: "prompt",
    backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    boardApiKeysEnabled: enabled,
  };
}

async function createApp(actor: any) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/access.js")>("../routes/access.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes({} as any, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

const SESSION_BOARD_ACTOR = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  isInstanceAdmin: false,
  source: "session",
};

const BOARD_KEY_ACTOR = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  isInstanceAdmin: false,
  source: "board_key",
  keyId: "existing-key-1",
};

const LOCAL_BOARD_ACTOR = {
  type: "board",
  userId: "local-board",
  isInstanceAdmin: true,
  source: "local_implicit",
};

const AGENT_ACTOR = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  source: "agent_key",
};

describe("board API key routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockInstanceSettingsService.getGeneral.mockResolvedValue(generalWithBoardKeys(true));
  });

  describe("POST /api/board-api-keys", () => {
    it("creates a key for a session-authenticated user", async () => {
      const now = new Date("2026-04-16T10:00:00.000Z");
      mockBoardAuthService.createBoardApiKeyForUser.mockResolvedValue({
        id: "key-1",
        name: "my-integration",
        token: "pcp_board_abc123",
        expiresAt: null,
        createdAt: now,
      });
      mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-1"]);

      const app = await createApp(SESSION_BOARD_ACTOR);
      const res = await request(app)
        .post("/api/board-api-keys")
        .send({ name: "my-integration" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: "key-1",
        name: "my-integration",
        token: "pcp_board_abc123",
        expiresAt: null,
      });
      expect(mockBoardAuthService.createBoardApiKeyForUser).toHaveBeenCalledWith(
        "user-1",
        "my-integration",
        undefined,
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          action: "board_api_key.created",
        }),
      );
    });

    it("creates a key with expiry", async () => {
      const now = new Date("2026-04-16T10:00:00.000Z");
      const expires = new Date("2026-07-15T10:00:00.000Z");
      mockBoardAuthService.createBoardApiKeyForUser.mockResolvedValue({
        id: "key-2",
        name: "short-lived",
        token: "pcp_board_xyz789",
        expiresAt: expires,
        createdAt: now,
      });
      mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([]);

      const app = await createApp(SESSION_BOARD_ACTOR);
      const res = await request(app)
        .post("/api/board-api-keys")
        .send({ name: "short-lived", expiresInDays: 90 });

      expect(res.status).toBe(201);
      expect(res.body.expiresAt).toBe("2026-07-15T10:00:00.000Z");
      expect(mockBoardAuthService.createBoardApiKeyForUser).toHaveBeenCalledWith(
        "user-1",
        "short-lived",
        90,
      );
    });

    it("rejects when called with a board API key (privilege laundering)", async () => {
      const app = await createApp(BOARD_KEY_ACTOR);
      const res = await request(app)
        .post("/api/board-api-keys")
        .send({ name: "laundered-key" });

      expect(res.status).toBe(403);
      expect(mockBoardAuthService.createBoardApiKeyForUser).not.toHaveBeenCalled();
    });

    it("rejects when called by an agent", async () => {
      const app = await createApp(AGENT_ACTOR);
      const res = await request(app)
        .post("/api/board-api-keys")
        .send({ name: "agent-key" });

      expect(res.status).toBe(403);
    });

    it("allows local-trusted board operator", async () => {
      const now = new Date("2026-04-16T10:00:00.000Z");
      mockBoardAuthService.createBoardApiKeyForUser.mockResolvedValue({
        id: "key-local",
        name: "local-key",
        token: "pcp_board_local",
        expiresAt: null,
        createdAt: now,
      });
      mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([]);

      const app = await createApp(LOCAL_BOARD_ACTOR);
      const res = await request(app)
        .post("/api/board-api-keys")
        .send({ name: "local-key" });

      expect(res.status).toBe(201);
    });

    it("validates request body", async () => {
      const app = await createApp(SESSION_BOARD_ACTOR);
      const res = await request(app)
        .post("/api/board-api-keys")
        .send({ name: "" });

      expect(res.status).toBe(400);
    });

    it("rejects when flag is disabled", async () => {
      mockInstanceSettingsService.getGeneral.mockResolvedValue(generalWithBoardKeys(false));
      const app = await createApp(SESSION_BOARD_ACTOR);
      const res = await request(app)
        .post("/api/board-api-keys")
        .send({ name: "nope" });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("disabled");
      expect(mockBoardAuthService.createBoardApiKeyForUser).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/board-api-keys", () => {
    it("lists keys for the authenticated user", async () => {
      const now = new Date("2026-04-16T10:00:00.000Z");
      mockBoardAuthService.listBoardApiKeys.mockResolvedValue([
        {
          id: "key-1",
          name: "my-key",
          lastUsedAt: now,
          expiresAt: null,
          revokedAt: null,
          createdAt: now,
        },
      ]);

      const app = await createApp(SESSION_BOARD_ACTOR);
      const res = await request(app).get("/api/board-api-keys");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        id: "key-1",
        name: "my-key",
      });
      expect(mockBoardAuthService.listBoardApiKeys).toHaveBeenCalledWith("user-1", false);
    });

    it("rejects when called with a board API key", async () => {
      const app = await createApp(BOARD_KEY_ACTOR);
      const res = await request(app).get("/api/board-api-keys");

      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /api/board-api-keys/:id", () => {
    it("revokes a key belonging to the user", async () => {
      mockBoardAuthService.revokeBoardApiKey.mockResolvedValue({
        id: "key-1",
        userId: "user-1",
      });
      mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-1"]);

      const app = await createApp(SESSION_BOARD_ACTOR);
      const res = await request(app).delete("/api/board-api-keys/key-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ revoked: true, keyId: "key-1" });
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "board_api_key.revoked",
          details: expect.objectContaining({ revokedVia: "board_ui" }),
        }),
      );
    });

    it("returns 404 when key not found or belongs to another user", async () => {
      mockBoardAuthService.revokeBoardApiKey.mockResolvedValue({
        id: "key-other",
        userId: "user-2",
      });

      const app = await createApp(SESSION_BOARD_ACTOR);
      const res = await request(app).delete("/api/board-api-keys/key-other");

      expect(res.status).toBe(404);
    });

    it("returns 404 when revoke returns null (already revoked or missing)", async () => {
      mockBoardAuthService.revokeBoardApiKey.mockResolvedValue(null);

      const app = await createApp(SESSION_BOARD_ACTOR);
      const res = await request(app).delete("/api/board-api-keys/key-gone");

      expect(res.status).toBe(404);
    });

    it("rejects when called with a board API key", async () => {
      const app = await createApp(BOARD_KEY_ACTOR);
      const res = await request(app).delete("/api/board-api-keys/key-1");

      expect(res.status).toBe(403);
    });
  });
});
