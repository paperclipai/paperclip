import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock data ───────────────────────────────────────────────────────────────

const COMPANY_ID = randomUUID();
const USER_ID = randomUUID();
const BRIDGE_ID = randomUUID();
const SECRET_ID = randomUUID();

const MOCK_BRIDGE = {
  id: BRIDGE_ID,
  companyId: COMPANY_ID,
  platform: "telegram",
  status: "connected",
  secretId: SECRET_ID,
  config: { botUsername: "test_bot" },
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── Service mocks ───────────────────────────────────────────────────────────

const mockBridgeService = vi.hoisted(() => ({
  list: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  getByPlatform: vi.fn(),
  updateStatus: vi.fn(),
  getSupportedPlatforms: vi.fn().mockReturnValue(["telegram", "slack", "discord"]),
}));

const mockSecretService = vi.hoisted(() => ({
  getByName: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
  remove: vi.fn(),
  resolveSecretValue: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/messaging-bridges.js", () => ({
  messagingBridgeService: () => mockBridgeService,
}));

vi.mock("../services/index.js", async () => {
  const { makeFullServicesMock } = await import("./helpers/mock-services.js");
  return makeFullServicesMock({
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    companyService: () => mockCompanyService,
  });
});

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
}));

vi.mock("../bridges/telegram.js", () => ({
  testTelegramToken: vi.fn().mockResolvedValue("test_bot"),
  startTelegramBridge: vi.fn().mockResolvedValue(undefined),
  stopTelegramBridge: vi.fn().mockResolvedValue(undefined),
  isTelegramBridgeRunning: vi.fn().mockReturnValue(false),
}));

vi.mock("../bridges/email.js", () => ({
  handleInboundEmail: vi.fn().mockResolvedValue({ ok: true, issueId: randomUUID() }),
  getCompanyEmailAddress: vi.fn().mockReturnValue("test@ironworksapp.ai"),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ── App builder ─────────────────────────────────────────────────────────────

async function createApp(actor: Record<string, unknown>) {
  const { messagingRoutes, emailWebhookRoutes } = await import("../routes/messaging.js");
  const { errorHandler } = await import("../middleware/error-handler.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: actor prop is attached to Express Request by middleware but not declared in its TypeScript type
    (req as any).actor = actor;
    next();
  });
  // biome-ignore lint/suspicious/noExplicitAny: mock Drizzle DB or storage object for unit tests; real type requires full schema-aware Drizzle instance
  const fakeDb = {} as any;
  app.use("/api", messagingRoutes(fakeDb));
  app.use("/api", emailWebhookRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

function boardUser(userId: string, companyIds: string[]) {
  return { type: "board", userId, companyIds, isInstanceAdmin: false, source: "session" };
}

function noActor() {
  return { type: "none" };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("messaging routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBridgeService.list.mockResolvedValue([MOCK_BRIDGE]);
    mockCompanyService.getById.mockResolvedValue({ id: COMPANY_ID, name: "Test Corp" });
  });

  describe("GET /api/companies/:companyId/messaging/bridges", () => {
    it("returns bridge list for authorized board user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/messaging/bridges`);

      expect(res.status).toBe(200);
      expect(res.body.bridges).toHaveLength(1);
      expect(res.body.bridges[0].platform).toBe("telegram");
      expect(res.body.email).toBeDefined();
      expect(res.body.platforms).toBeDefined();
    });

    it("rejects unauthenticated requests with 403", async () => {
      const app = await createApp(noActor());
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/messaging/bridges`);
      expect(res.status).toBe(403);
    });

    it("rejects cross-company access with 403", async () => {
      const otherCompany = randomUUID();
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${otherCompany}/messaging/bridges`);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/companies/:companyId/messaging/telegram", () => {
    it("rejects missing token with 400", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).post(`/api/companies/${COMPANY_ID}/messaging/telegram`).send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("valid Telegram bot token");
    });

    it("rejects short token with 400", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).post(`/api/companies/${COMPANY_ID}/messaging/telegram`).send({ token: "short" });
      expect(res.status).toBe(400);
    });

    it("configures telegram bridge with valid token", async () => {
      mockSecretService.getByName.mockResolvedValue(null);
      mockSecretService.create.mockResolvedValue({ id: SECRET_ID });
      mockBridgeService.upsert.mockResolvedValue(MOCK_BRIDGE);

      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/messaging/telegram`)
        .send({ token: "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ" });

      expect(res.status).toBe(200);
      expect(res.body.platform).toBe("telegram");
    });
  });

  describe("DELETE /api/companies/:companyId/messaging/telegram", () => {
    it("removes telegram bridge for authorized user", async () => {
      mockSecretService.getByName.mockResolvedValue({ id: SECRET_ID });

      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).delete(`/api/companies/${COMPANY_ID}/messaging/telegram`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("POST /api/companies/:companyId/messaging/telegram/test", () => {
    it("returns 404 when no bridge configured", async () => {
      mockBridgeService.getByPlatform.mockResolvedValue(null);

      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).post(`/api/companies/${COMPANY_ID}/messaging/telegram/test`);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("No Telegram bridge configured");
    });
  });

  describe("POST /api/webhooks/email", () => {
    it("rejects when webhook secret not set", async () => {
      delete process.env.IRONWORKS_EMAIL_WEBHOOK_SECRET;
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).post("/api/webhooks/email").send({ from: "test@example.com", subject: "Test" });

      expect(res.status).toBe(503);
    });

    it("rejects invalid webhook secret with 401", async () => {
      process.env.IRONWORKS_EMAIL_WEBHOOK_SECRET = "correct-secret";
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post("/api/webhooks/email?token=wrong-secret")
        .send({ from: "test@example.com", subject: "Test" });

      expect(res.status).toBe(401);
      delete process.env.IRONWORKS_EMAIL_WEBHOOK_SECRET;
    });

    // SEC-WEBHOOK-002 — provider signature verification.
    it("rejects bad Mailgun signature with 401 even if token is valid", async () => {
      process.env.IRONWORKS_EMAIL_WEBHOOK_SECRET = "correct-secret";
      process.env.MAILGUN_WEBHOOK_SIGNING_KEY = "mg-secret";
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post("/api/webhooks/email?token=correct-secret")
        .set("X-Mailgun-Signature-256", "deadbeef")
        .send({ from: "test@example.com", subject: "Test" });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Mailgun/);
      delete process.env.IRONWORKS_EMAIL_WEBHOOK_SECRET;
      delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    });

    it("accepts a valid Mailgun signature WITHOUT a static token", async () => {
      const { createHmac } = await import("node:crypto");
      delete process.env.IRONWORKS_EMAIL_WEBHOOK_SECRET;
      process.env.MAILGUN_WEBHOOK_SIGNING_KEY = "mg-secret";

      const body = { from: "test@example.com", subject: "Test" };
      const rawBody = Buffer.from(JSON.stringify(body));
      const sig = createHmac("sha256", "mg-secret").update(rawBody).digest("hex");

      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post("/api/webhooks/email")
        .set("X-Mailgun-Signature-256", sig)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    });

    it("rejects Mailgun-signed request with 401 when signing key not configured", async () => {
      delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
      process.env.IRONWORKS_EMAIL_WEBHOOK_SECRET = "correct-secret";
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post("/api/webhooks/email?token=correct-secret")
        .set("X-Mailgun-Signature-256", "deadbeef")
        .send({ from: "test@example.com" });

      expect(res.status).toBe(401);
      delete process.env.IRONWORKS_EMAIL_WEBHOOK_SECRET;
    });
  });
});
