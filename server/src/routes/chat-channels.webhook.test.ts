import express from "express";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { CHAT_WEBHOOK_BODY_LIMIT_BYTES } from "../http/body-limits.js";
import { chatWebhookBodyParser } from "../middleware/chat-webhook-body.js";
import { errorHandler } from "../middleware/index.js";
import type { ChatChannelService } from "../services/chat-channels.js";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";
import { chatWebhookRoutes } from "./chat-channels.js";

function appFor(service: Pick<ChatChannelService, "handleWebhook">) {
  const app = express();
  app.use("/api/chat-webhooks", chatWebhookBodyParser);
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

async function sendChunkedBody(
  app: ReturnType<typeof appFor>,
  chunks: readonly Buffer[],
) {
  const server = app.listen(0);
  try {
    const address = server.address() as AddressInfo;
    return await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const outgoing = httpRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            method: "POST",
            path: "/api/chat-webhooks/public-a/slack",
            headers: {
              "content-type": "application/json",
              "transfer-encoding": "chunked",
            },
          },
          (incoming) => {
            const responseChunks: Buffer[] = [];
            incoming.on("data", (chunk) =>
              responseChunks.push(Buffer.from(chunk)),
            );
            incoming.on("end", () => {
              resolve({
                status: incoming.statusCode ?? 0,
                body: Buffer.concat(responseChunks).toString("utf8"),
              });
            });
          },
        );
        outgoing.on("error", reject);
        for (const chunk of chunks) outgoing.write(chunk);
        outgoing.end();
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("chat webhook routes", () => {
  it("preserves the exact signed request bytes", async () => {
    const signedBody = Buffer.from(
      "payload=%7B%22type%22%3A%22block_actions%22%7D&padding=%2B%25",
    );
    const handleWebhook = vi.fn(
      async (_publicId, _provider, providerRequest) => {
        expect(Buffer.from(await providerRequest.arrayBuffer())).toEqual(
          signedBody,
        );
        return new Response("accepted", { status: 202 });
      },
    );
    const app = appFor({ handleWebhook });

    await request(app)
      .post("/api/chat-webhooks/public-a/slack")
      .set("content-type", "application/x-www-form-urlencoded")
      .send(signedBody.toString("utf8"))
      .expect(202);

    expect(handleWebhook).toHaveBeenCalledTimes(1);
  });

  it("rejects a declared oversized body before webhook routing", async () => {
    const handleWebhook = vi.fn();
    const app = appFor({ handleWebhook });

    const response = await request(app)
      .post("/api/chat-webhooks/public-a/slack")
      .set("content-type", "application/json")
      .set("content-length", String(CHAT_WEBHOOK_BODY_LIMIT_BYTES + 1))
      .send("x")
      .expect(413);

    expect(response.body).toMatchObject({
      error: "Chat webhook request body is too large",
      code: "chat_webhook_body_too_large",
      details: {
        maxBytes: CHAT_WEBHOOK_BODY_LIMIT_BYTES,
      },
    });
    expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("caps chunked webhook bodies that omit Content-Length", async () => {
    const handleWebhook = vi.fn();
    const app = appFor({ handleWebhook });

    const response = await sendChunkedBody(app, [
      Buffer.alloc(CHAT_WEBHOOK_BODY_LIMIT_BYTES, 0x61),
      Buffer.from("x"),
    ]);

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "Chat webhook request body is too large",
      code: "chat_webhook_body_too_large",
      details: {
        maxBytes: CHAT_WEBHOOK_BODY_LIMIT_BYTES,
      },
    });
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("bounds unauthenticated webhook work per public endpoint and source", async () => {
    const handleWebhook = vi.fn(
      async () =>
        new Response("accepted", {
          status: 202,
          headers: { "content-type": "text/plain" },
        }),
    );
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
