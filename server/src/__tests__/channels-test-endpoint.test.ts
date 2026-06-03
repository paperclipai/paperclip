import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const agentId = "11111111-1111-4111-8111-111111111111";
const channelId = "33333333-3333-4333-8333-333333333333";

const deliveredMessage = {
  id: "55555555-5555-4555-8555-555555555555",
  companyId,
  channelId,
  direction: "outbound" as const,
  content: "Paperclip test message: this channel is wired up correctly.",
  metadata: { test: true, httpStatus: 200 },
  issueId: null,
  agentId,
  status: "delivered" as const,
  createdAt: "2026-06-02T00:00:00.000Z",
};

const failedMessage = { ...deliveredMessage, status: "failed" as const, metadata: { test: true, error: "boom" } };

const mockSender = vi.hoisted(() => ({
  sendByChannelId: vi.fn(),
  sendTestMessage: vi.fn(),
  getMessage: vi.fn(),
}));

const mockChannelService = vi.hoisted(() => ({
  listChannels: vi.fn(),
  getChannel: vi.fn(),
  getChannelWithSecrets: vi.fn(),
  createChannel: vi.fn(),
  updateChannel: vi.fn(),
  deleteChannel: vi.fn(),
  listRoutes: vi.fn(),
  getRoute: vi.fn(),
  createRoute: vi.fn(),
  updateRoute: vi.fn(),
  deleteRoute: vi.fn(),
  listMessages: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/channels.js", async () => {
    const actual = await vi.importActual<typeof import("../services/channels.ts")>(
      "../services/channels.ts",
    );
    return { ...actual, channelService: () => mockChannelService };
  });
  vi.doMock("../services/channel-sender.js", () => ({
    channelSenderService: () => mockSender,
  }));
  vi.doMock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { channelRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/channels.js")>("../routes/channels.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", channelRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("channel test endpoint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/channels.js");
    vi.doUnmock("../services/channel-sender.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../routes/channels.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerMocks();
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns 200 + message on delivered, logs activity", async () => {
    mockSender.sendTestMessage.mockResolvedValue({
      message: deliveredMessage,
      attempts: 1,
    });
    const app = await createApp({ type: "agent", agentId, companyId });
    const res = await request(app)
      .post(`/api/companies/${companyId}/channels/${channelId}/test`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      message: { status: "delivered", id: deliveredMessage.id },
      attempts: 1,
    });
    expect(mockSender.sendTestMessage).toHaveBeenCalledWith(companyId, channelId, {
      content: undefined,
      agentId,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "channel.tested",
        entityId: channelId,
        details: expect.objectContaining({ status: "delivered", attempts: 1 }),
      }),
    );
  });

  it("passes custom content through to the sender", async () => {
    mockSender.sendTestMessage.mockResolvedValue({
      message: deliveredMessage,
      attempts: 1,
    });
    const app = await createApp({ type: "agent", agentId, companyId });
    await request(app)
      .post(`/api/companies/${companyId}/channels/${channelId}/test`)
      .send({ content: "Custom verify text" });
    expect(mockSender.sendTestMessage).toHaveBeenCalledWith(companyId, channelId, {
      content: "Custom verify text",
      agentId,
    });
  });

  it("returns 502 + error when delivery failed", async () => {
    mockSender.sendTestMessage.mockResolvedValue({
      message: failedMessage,
      attempts: 3,
      lastError: "boom",
    });
    const app = await createApp({
      type: "board",
      userId: "u",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/channels/${channelId}/test`)
      .send({});
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      message: { status: "failed" },
      attempts: 3,
      error: "boom",
    });
  });

  it("blocks cross-company test send (403)", async () => {
    const app = await createApp({
      type: "board",
      userId: "u",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [otherCompanyId],
      memberships: [{ companyId: otherCompanyId, status: "active", membershipRole: "owner" }],
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/channels/${channelId}/test`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockSender.sendTestMessage).not.toHaveBeenCalled();
  });

  it("validates content length (400/422)", async () => {
    const app = await createApp({ type: "agent", agentId, companyId });
    const res = await request(app)
      .post(`/api/companies/${companyId}/channels/${channelId}/test`)
      .send({ content: "x".repeat(2001) });
    expect([400, 422]).toContain(res.status);
    expect(mockSender.sendTestMessage).not.toHaveBeenCalled();
  });
});
