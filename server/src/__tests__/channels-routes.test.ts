import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const agentId = "11111111-1111-4111-8111-111111111111";
const channelId = "33333333-3333-4333-8333-333333333333";
const otherChannelId = "44444444-4444-4444-8444-444444444444";

const channel = {
  id: channelId,
  companyId,
  platform: "slack" as const,
  name: "eng",
  config: { botToken: "***REDACTED***", workspace: "acme" },
  status: "active" as const,
  direction: "outbound" as const,
  createdAt: "2026-03-20T00:00:00.000Z",
  updatedAt: "2026-03-20T00:00:00.000Z",
};

const otherChannel = { ...channel, id: otherChannelId, companyId: otherCompanyId };

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

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/channels.js", async () => {
    const actual = await vi.importActual<typeof import("../services/channels.ts")>(
      "../services/channels.ts",
    );
    return {
      ...actual,
      channelService: () => mockChannelService,
    };
  });
  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));
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

describe("channel routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/channels.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../routes/channels.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockChannelService.listChannels.mockResolvedValue([channel]);
    mockChannelService.getChannel.mockImplementation(async (id: string) => {
      if (id === channelId) return channel;
      if (id === otherChannelId) return otherChannel;
      return null;
    });
    mockChannelService.createChannel.mockResolvedValue(channel);
    mockChannelService.updateChannel.mockResolvedValue(channel);
    mockChannelService.deleteChannel.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lists channels for a board member with company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "u",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });
    const res = await request(app).get(`/api/companies/${companyId}/channels`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // GET responses must not leak secrets
    expect(JSON.stringify(res.body)).not.toContain("xoxb");
    expect(res.body[0].config.botToken).toBe("***REDACTED***");
  });

  it("blocks listing channels of another company", async () => {
    const app = await createApp({
      type: "board",
      userId: "u",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [otherCompanyId],
      memberships: [{ companyId: otherCompanyId, status: "active", membershipRole: "owner" }],
    });
    const res = await request(app).get(`/api/companies/${companyId}/channels`);
    expect(res.status).toBe(403);
    expect(mockChannelService.listChannels).not.toHaveBeenCalled();
  });

  it("blocks PATCH on a channel owned by another company", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId: otherCompanyId,
    });
    const res = await request(app)
      .patch(`/api/channels/${channelId}`)
      .send({ name: "stolen" });
    expect(res.status).toBe(403);
    expect(mockChannelService.updateChannel).not.toHaveBeenCalled();
  });

  it("blocks DELETE on a channel owned by another company", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId: otherCompanyId,
    });
    const res = await request(app).delete(`/api/channels/${channelId}`);
    expect(res.status).toBe(403);
    expect(mockChannelService.deleteChannel).not.toHaveBeenCalled();
  });

  it("rejects empty PATCH bodies at the validator (422)", async () => {
    const app = await createApp({
      type: "board",
      userId: "u",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });
    const res = await request(app).patch(`/api/channels/${channelId}`).send({});
    expect([400, 422]).toContain(res.status);
    expect(mockChannelService.updateChannel).not.toHaveBeenCalled();
  });

  it("records channel.created activity log entries with sensitive key summary", async () => {
    const app = await createApp({
      type: "board",
      userId: "u",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/channels`)
      .send({
        platform: "slack",
        name: "eng",
        config: { botToken: "xoxb-PLAIN", workspace: "acme" },
      });
    expect(res.status).toBe(201);
    expect(mockChannelService.createChannel).toHaveBeenCalledWith(companyId, expect.objectContaining({
      platform: "slack",
      name: "eng",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "channel.created",
        details: expect.objectContaining({
          configKeys: ["botToken", "workspace"],
          sensitiveConfigKeys: ["botToken"],
        }),
      }),
    );
    // Response must not echo the raw bot token even though it was in the request
    expect(JSON.stringify(res.body)).not.toContain("xoxb-PLAIN");
  });
});
