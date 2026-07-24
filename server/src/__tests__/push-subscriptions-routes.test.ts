import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPushSubscriptionService = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  revokeByEndpoint: vi.fn(),
  listActiveForUser: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    pushSubscriptionService: () => mockPushSubscriptionService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ pushSubscriptionRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/push-subscriptions.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", pushSubscriptionRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const SUBSCRIBE_BODY = {
  endpoint: "https://push.example/device-1",
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
};

describe("push subscription routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/push-subscriptions.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockPushSubscriptionService.subscribe.mockResolvedValue({
      id: "sub-1",
      companyId: "company-1",
      userId: "user-1",
      endpoint: SUBSCRIBE_BODY.endpoint,
      p256dh: SUBSCRIBE_BODY.keys.p256dh,
      auth: SUBSCRIBE_BODY.keys.auth,
      createdAt: new Date(),
      revokedAt: null,
    });
    mockPushSubscriptionService.unsubscribe.mockResolvedValue({ revoked: true });
  });

  it("subscribes a device for board users and logs the activity", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/push-subscriptions/me")
      .send(SUBSCRIBE_BODY);

    expect(res.status).toBe(201);
    expect(mockPushSubscriptionService.subscribe).toHaveBeenCalledWith("company-1", "user-1", {
      endpoint: SUBSCRIBE_BODY.endpoint,
      p256dh: SUBSCRIBE_BODY.keys.p256dh,
      auth: SUBSCRIBE_BODY.keys.auth,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({
        companyId: "company-1",
        action: "push_subscription.subscribed",
      }),
    );
  });

  it("rejects a malformed subscribe body", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post("/api/companies/company-1/push-subscriptions/me")
      .send({ endpoint: "not-a-url", keys: { p256dh: "x", auth: "y" } });

    expect(res.status).toBe(400);
    expect(mockPushSubscriptionService.subscribe).not.toHaveBeenCalled();
  });

  it("unsubscribes a device for board users and logs the activity", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .delete("/api/companies/company-1/push-subscriptions/me")
      .send({ endpoint: SUBSCRIBE_BODY.endpoint });

    expect(res.status).toBe(200);
    expect(mockPushSubscriptionService.unsubscribe).toHaveBeenCalledWith(
      "company-1",
      "user-1",
      SUBSCRIBE_BODY.endpoint,
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({
        companyId: "company-1",
        action: "push_subscription.unsubscribed",
      }),
    );
  });

  it("rejects company-scoped writes when the board user lacks company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .post("/api/companies/company-1/push-subscriptions/me")
      .send(SUBSCRIBE_BODY);

    expect(res.status).toBe(403);
    expect(mockPushSubscriptionService.subscribe).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app)
      .post("/api/companies/company-1/push-subscriptions/me")
      .send(SUBSCRIBE_BODY);

    expect(res.status).toBe(403);
    expect(mockPushSubscriptionService.subscribe).not.toHaveBeenCalled();
  });
});
