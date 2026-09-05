import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import type { ChatChannelService } from "../services/chat-channels.js";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";
import { chatWebhookRoutes } from "./chat-channels.js";

function appFor(service: Pick<ChatChannelService, "handleWebhook">) {
  const app = express();
  app.use(express.raw({ type: "*/*" }));
  app.use(
    chatWebhookRoutes(service as ChatChannelService, {
      rateLimiter: createInviteRateLimiter({
        windowMs: 60_000,
        maxRequests: 1,
        now: () => 1_000,
      }),
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("chat webhook routes", () => {
  it("bounds unauthenticated webhook work per public endpoint and source", async () => {
    const handleWebhook = vi.fn(async () => new Response("accepted", {
      status: 202,
      headers: { "content-type": "text/plain" },
    }));
    const app = appFor({ handleWebhook });

    await request(app)
      .post("/api/chat-webhooks/public-a/slack")
      .set("content-type", "application/json")
      .send("{}")
      .expect(202)
      .expect("X-RateLimit-Limit", "1")
      .expect("X-RateLimit-Remaining", "0");

    const limited = await request(app)
      .post("/api/chat-webhooks/public-a/slack")
      .set("content-type", "application/json")
      .send("{}")
      .expect(429)
      .expect("Retry-After", "60");
    expect(limited.body).toMatchObject({
      error: "Too many chat webhook requests",
      details: { retryAfterSeconds: 60 },
    });
    expect(handleWebhook).toHaveBeenCalledTimes(1);

    await request(app)
      .post("/api/chat-webhooks/public-b/slack")
      .set("content-type", "application/json")
      .send("{}")
      .expect(202);
    expect(handleWebhook).toHaveBeenCalledTimes(2);
  });
});
