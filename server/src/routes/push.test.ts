import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";

const upsertSubscription = vi.fn();

vi.mock("../services/web-push.js", () => ({
  getVapidPublicKey: vi.fn(() => "public-key"),
  isVapidConfigured: vi.fn(() => true),
  webPushService: vi.fn(() => ({
    upsertSubscription,
    deleteSubscription: vi.fn(),
    listSubscriptions: vi.fn(async () => []),
    sendToBoard: vi.fn(async () => ({ sent: 0, pruned: 0 })),
  })),
}));

import { pushRoutes } from "./push.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "session",
      userId: "user-1",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      isInstanceAdmin: false,
    };
    next();
  }) as RequestHandler);
  app.use("/api", pushRoutes({} as Db));
  app.use(errorHandler);
  return app;
}

function subscriptionBody(endpoint: string) {
  return {
    endpoint,
    p256dh: "p256dh-key",
    auth: "auth-secret",
  };
}

describe("pushRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["plain text", "not-a-url"],
    ["non-https URL", "http://push.example.com/subscription"],
    ["localhost URL", "https://localhost/subscription"],
    ["loopback IP URL", "https://127.0.0.1/subscription"],
    ["private IP URL", "https://10.1.2.3/subscription"],
    ["link-local IP URL", "https://169.254.169.254/subscription"],
    ["multicast IP URL", "https://224.0.0.1/subscription"],
    ["IPv6 loopback URL", "https://[::1]/subscription"],
    ["IPv6 unique-local URL", "https://[fd00::1]/subscription"],
    ["IPv6 link-local URL", "https://[fe80::1]/subscription"],
  ])("rejects %s subscription endpoints", async (_label, endpoint) => {
    const res = await request(createApp())
      .post("/api/companies/company-1/push/subscriptions")
      .send(subscriptionBody(endpoint));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_subscription" });
    expect(upsertSubscription).not.toHaveBeenCalled();
  });

  it("accepts an HTTPS public push endpoint", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/push/subscriptions")
      .send(subscriptionBody("https://push.example.com/subscription"));

    expect(res.status).toBe(201);
    expect(upsertSubscription).toHaveBeenCalledWith({
      companyId: "company-1",
      endpoint: "https://push.example.com/subscription",
      p256dh: "p256dh-key",
      auth: "auth-secret",
      deviceLabel: undefined,
    });
  });
});
