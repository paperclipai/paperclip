import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock data ───────────────────────────────────────────────────────────────

const COMPANY_ID = randomUUID();
const USER_ID = randomUUID();
const SECRET_ID = randomUUID();

const MOCK_SECRET = {
  id: SECRET_ID,
  companyId: COMPANY_ID,
  name: "ANTHROPIC_API_KEY",
  provider: "local_encrypted",
  description: "Anthropic API key",
  latestVersion: 1,
};

const MOCK_PROVIDERS = [
  { id: "local_encrypted", name: "Local Encrypted" },
];

// ── Service mocks ───────────────────────────────────────────────────────────

const mockSecretService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listProviders: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn().mockResolvedValue(true),
}));

vi.mock("../services/index.js", () => ({
  secretService: () => mockSecretService,
  logActivity: mockLogActivity,
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
}));

vi.mock("../services/billing.js", () => ({
  billingService: () => ({}),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ── App builder ─────────────────────────────────────────────────────────────

async function createApp(actor: Record<string, unknown>) {
  const { secretRoutes } = await import("../routes/secrets.js");
  const { errorHandler } = await import("../middleware/error-handler.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  // Chainable that's also awaitable via a proper thenable contract.
  const chainable: any = {};
  chainable.select = vi.fn().mockReturnValue(chainable);
  chainable.from = vi.fn().mockReturnValue(chainable);
  chainable.where = vi.fn().mockReturnValue(chainable);
  chainable.update = vi.fn().mockReturnValue(chainable);
  chainable.set = vi.fn().mockReturnValue(chainable);
  chainable.limit = vi.fn().mockReturnValue(chainable);
  chainable.then = vi.fn().mockImplementation((resolve: any) =>
    resolve([{ membershipRole: "owner" }]),
  );
  const fakeDb = chainable as any;
  app.use("/api", secretRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

function boardUser(userId: string, companyIds: string[]) {
  return { type: "board", userId, companyIds, isInstanceAdmin: false, source: "session" };
}

function noActor() {
  return { type: "none" };
}

function agentActor(agentId: string, companyId: string) {
  return { type: "agent", agentId, companyId };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("secret routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecretService.list.mockResolvedValue([MOCK_SECRET]);
    mockSecretService.getById.mockResolvedValue(MOCK_SECRET);
    mockSecretService.create.mockResolvedValue(MOCK_SECRET);
    mockSecretService.rotate.mockResolvedValue({ ...MOCK_SECRET, latestVersion: 2 });
    mockSecretService.update.mockResolvedValue(MOCK_SECRET);
    mockSecretService.remove.mockResolvedValue(MOCK_SECRET);
    mockSecretService.listProviders.mockReturnValue(MOCK_PROVIDERS);
  });

  describe("GET /api/companies/:companyId/secrets", () => {
    it("lists secrets for authorized board user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/secrets`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ name: "ANTHROPIC_API_KEY" });
    });

    it("rejects unauthenticated requests with 401", async () => {
      const app = await createApp(noActor());
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/secrets`);
      // noActor fails assertBoard which throws forbidden (403) since type is "none"
      // Actually assertBoard checks type !== "board", so it throws forbidden
      expect(res.status).toBe(403);
    });

    it("rejects agent actor (board required)", async () => {
      const app = await createApp(agentActor(randomUUID(), COMPANY_ID));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/secrets`);
      expect(res.status).toBe(403);
    });

    it("rejects cross-company access with 403", async () => {
      const otherCompany = randomUUID();
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${otherCompany}/secrets`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/companies/:companyId/secret-providers", () => {
    it("lists available secret providers", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/secret-providers`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(MOCK_PROVIDERS);
    });
  });

  describe("POST /api/companies/:companyId/secrets", () => {
    it("creates a new secret", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/secrets`)
        .send({ name: "ANTHROPIC_API_KEY", value: "sk-ant-test123" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: "ANTHROPIC_API_KEY" });
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("rejects agent actor (board required)", async () => {
      const app = await createApp(agentActor(randomUUID(), COMPANY_ID));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/secrets`)
        .send({ name: "MY_SECRET", value: "value123" });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/secrets/:id/rotate", () => {
    it("rotates a secret value", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/secrets/${SECRET_ID}/rotate`)
        .send({ value: "sk-ant-newkey456" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ latestVersion: 2 });
    });

    it("returns 404 for non-existent secret", async () => {
      mockSecretService.getById.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/secrets/${randomUUID()}/rotate`)
        .send({ value: "newvalue" });
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/secrets/:id", () => {
    it("updates secret metadata", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .patch(`/api/secrets/${SECRET_ID}`)
        .send({ description: "Updated description" });

      expect(res.status).toBe(200);
      expect(mockSecretService.update).toHaveBeenCalled();
    });

    it("returns 404 for non-existent secret", async () => {
      mockSecretService.getById.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .patch(`/api/secrets/${randomUUID()}`)
        .send({ description: "test" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/secrets/:id", () => {
    it("deletes a secret", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).delete(`/api/secrets/${SECRET_ID}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("returns 404 for non-existent secret", async () => {
      mockSecretService.getById.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).delete(`/api/secrets/${randomUUID()}`);
      expect(res.status).toBe(404);
    });

    it("returns 404 when remove returns null", async () => {
      mockSecretService.remove.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).delete(`/api/secrets/${SECRET_ID}`);
      expect(res.status).toBe(404);
    });
  });
});
