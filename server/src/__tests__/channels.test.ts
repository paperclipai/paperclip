import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock data ───────────────────────────────────────────────────────────────

const COMPANY_ID = randomUUID();
const USER_ID = randomUUID();
const CHANNEL_ID = randomUUID();

const MOCK_CHANNELS = [
  { id: CHANNEL_ID, companyId: COMPANY_ID, name: "#company", topic: "General" },
];

const MOCK_MESSAGES = [
  {
    id: randomUUID(),
    channelId: CHANNEL_ID,
    authorUserId: USER_ID,
    authorAgentId: null,
    body: "Hello team",
    messageType: "message",
    createdAt: new Date().toISOString(),
  },
];

const MOCK_POSTED_MESSAGE = {
  id: randomUUID(),
  channelId: CHANNEL_ID,
  authorUserId: USER_ID,
  authorAgentId: null,
  body: "New message",
  messageType: "message",
  mentions: [],
  createdAt: new Date().toISOString(),
};

// ── Service mocks ───────────────────────────────────────────────────────────

const mockEnsureCompanyChannel = vi.hoisted(() => vi.fn().mockResolvedValue("00000000-0000-0000-0000-000000000000"));
const mockListChannels = vi.hoisted(() => vi.fn());
const mockGetMessages = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());
const mockExtractDecisions = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockPinMessage = vi.hoisted(() => vi.fn());
const mockUnpinMessage = vi.hoisted(() => vi.fn());
const mockGetPinnedMessages = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockSummarizeChannel = vi.hoisted(() => vi.fn().mockResolvedValue(""));
const mockDiscoverExpertise = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockStartDeliberation = vi.hoisted(() => vi.fn());
const mockCheckQuorum = vi.hoisted(() => vi.fn());
const mockConcludeDeliberation = vi.hoisted(() => vi.fn());
const mockCreateForkAndTest = vi.hoisted(() => vi.fn());
const mockDetectCrossChannelOverlap = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("../services/channels.js", () => ({
  ensureCompanyChannel: mockEnsureCompanyChannel,
  listChannels: mockListChannels,
  getMessages: mockGetMessages,
  postMessage: mockPostMessage,
  extractDecisions: mockExtractDecisions,
  pinMessage: mockPinMessage,
  unpinMessage: mockUnpinMessage,
  getPinnedMessages: mockGetPinnedMessages,
  summarizeChannel: mockSummarizeChannel,
  discoverExpertise: mockDiscoverExpertise,
  startDeliberation: mockStartDeliberation,
  checkQuorum: mockCheckQuorum,
  concludeDeliberation: mockConcludeDeliberation,
  createForkAndTest: mockCreateForkAndTest,
  detectCrossChannelOverlap: mockDetectCrossChannelOverlap,
  channelAnalytics: vi.fn().mockResolvedValue({}),
}));

vi.mock("../services/executive-analytics.js", () => ({
  channelAnalytics: vi.fn().mockResolvedValue({}),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ getById: vi.fn().mockResolvedValue(null) }),
}));

vi.mock("../services/index.js", () => ({
  heartbeatService: () => ({ wakeup: vi.fn() }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
  setPluginEventBus: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ── App builder ─────────────────────────────────────────────────────────────

async function createApp(actor: Record<string, unknown>) {
  const { channelRoutes } = await import("../routes/channels.js");
  const { errorHandler } = await import("../middleware/error-handler.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });

  // Provide a fake db that supports the channel ownership check query
  const fakeDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockImplementation((cb: any) =>
            cb([{ id: CHANNEL_ID, companyId: COMPANY_ID }]),
          ),
        }),
      }),
    }),
  } as any;

  app.use("/api", channelRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

function createAppWithNoChannel(actor: Record<string, unknown>) {
  return createAppWithChannelLookup(actor, null);
}

async function createAppWithChannelLookup(actor: Record<string, unknown>, result: any) {
  const { channelRoutes } = await import("../routes/channels.js");
  const { errorHandler } = await import("../middleware/error-handler.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });

  const fakeDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockImplementation((cb: any) =>
            cb(result ? [result] : []),
          ),
        }),
      }),
    }),
  } as any;

  app.use("/api", channelRoutes(fakeDb));
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

describe("channel routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListChannels.mockResolvedValue(MOCK_CHANNELS);
    mockGetMessages.mockResolvedValue(MOCK_MESSAGES);
    mockPostMessage.mockResolvedValue(MOCK_POSTED_MESSAGE);
  });

  describe("GET /api/companies/:companyId/channels", () => {
    it("lists channels and ensures default channel exists", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/channels`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ name: "#company" });
      expect(mockEnsureCompanyChannel).toHaveBeenCalledWith(expect.anything(), COMPANY_ID);
    });

    it("rejects unauthenticated requests with 401", async () => {
      const app = await createApp(noActor());
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/channels`);
      expect(res.status).toBe(401);
    });

    it("rejects cross-company access with 403", async () => {
      const otherCompany = randomUUID();
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${otherCompany}/channels`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/companies/:companyId/channels/:channelId/messages", () => {
    it("returns messages for a valid channel", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(
        `/api/companies/${COMPANY_ID}/channels/${CHANNEL_ID}/messages`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ body: "Hello team" });
    });

    it("returns 404 for non-existent channel", async () => {
      const app = await createAppWithNoChannel(boardUser(USER_ID, [COMPANY_ID]));
      const fakeChannelId = randomUUID();
      const res = await request(app).get(
        `/api/companies/${COMPANY_ID}/channels/${fakeChannelId}/messages`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/companies/:companyId/channels/:channelId/messages", () => {
    it("posts a message and returns 201 with correct shape", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/channels/${CHANNEL_ID}/messages`)
        .send({ body: "New message" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ body: "New message", channelId: CHANNEL_ID });
    });

    it("rejects empty body with 400", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/channels/${CHANNEL_ID}/messages`)
        .send({ body: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("body is required");
    });

    it("rejects missing body field with 400", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/channels/${CHANNEL_ID}/messages`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("body is required");
    });

    it("enforces company access on message posting", async () => {
      const otherCompany = randomUUID();
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${otherCompany}/channels/${CHANNEL_ID}/messages`)
        .send({ body: "Exploit" });

      expect(res.status).toBe(403);
    });
  });
});
