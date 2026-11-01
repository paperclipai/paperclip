import express from "express";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { ConsoleLogger } from "chat";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { chatWebhookBodyParser } from "../middleware/chat-webhook-body.js";
import { errorHandler } from "../middleware/error-handler.js";
import { chatWebhookRoutes } from "../routes/chat-channels.js";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";

const publicId = "A".repeat(43);
const webhookPath = `/api/chat-webhooks/${publicId}/microsoft-teams`;
const modes = ["authenticated", "local_trusted"] as const;
const providerAuthorization = "Bearer synthetic-provider-token";

function fixture(mode: (typeof modes)[number], maxRequests = 20) {
  const queries = vi.fn(() => ({ from: () => ({ where: () => Promise.resolve([]) }) }));
  const session = vi.fn(async () => null);
  const actors: unknown[] = [];
  const handleWebhook = vi.fn(async (_id: string, _provider: string, req: Request) => {
    // Model provider authentication with a synthetic token. These tests prove
    // delegation; the real adapter rejection cases below cover missing and
    // malformed provider credentials without contacting Microsoft.
    const authorization = req.headers.get("authorization");
    const providerAccepted = authorization === providerAuthorization;
    return Response.json(
      { providerAccepted, authorization, body: await req.text() },
      { status: providerAccepted ? 200 : 401 },
    );
  });
  const app = express();
  app.use("/api/chat-webhooks", chatWebhookBodyParser);
  app.use(actorMiddleware({ select: queries } as any, { deploymentMode: mode, resolveSession: session }));
  app.use((req, _res, next) => {
    actors.push(req.actor);
    next();
  });
  app.use(chatWebhookRoutes({ handleWebhook } as any, {
    rateLimiter: createInviteRateLimiter({ windowMs: 60_000, maxRequests, now: () => 1_000 }),
  }));
  app.use((_req, res) => res.status(404).json({ fallback: true }));
  app.use(errorHandler);
  return { app, handleWebhook, queries, session, actors };
}

describe.each(modes)("Teams webhook actor boundary in %s mode", (mode) => {
  it.each([undefined, "Bearer invalid"])(
    "retains the pinned Teams adapter's rejection of %s",
    async (authorization) => {
      const adapter = createTeamsAdapter({
        appId: "11111111-1111-4111-8111-111111111111",
        appTenantId: "22222222-2222-4222-8222-222222222222",
        appPassword: "synthetic-unused-secret",
        appType: "SingleTenant",
        logger: new ConsoleLogger("silent"),
      });
      // Rejection happens before the adapter can dispatch to the chat instance.
      await adapter.initialize({} as Parameters<typeof adapter.initialize>[0]);
      const f = fixture(mode);
      f.handleWebhook.mockImplementation((_id, _provider, req) => adapter.handleWebhook(req));
      let req = request(f.app).post(webhookPath);
      if (authorization) req = req.set("authorization", authorization);
      const res = await req.send({ type: "message", id: "synthetic-message", channelId: "msteams" });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe(authorization ? "JWT validation failed" : "Missing authorization header");
      expect(f.handleWebhook).toHaveBeenCalledOnce();
      expect(f.actors).toEqual([{ type: "none", source: "none" }]);
    },
  );

  it("delegates a canonical POST with the original credentials and body and no actor", async () => {
    const f = fixture(mode);
    const body = '{ "type": "message", "text": "test fixture" }';
    const res = await request(f.app)
      .post(webhookPath)
      .set("authorization", providerAuthorization)
      .set("x-paperclip-run-id", "untrusted-run")
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ providerAccepted: true, authorization: providerAuthorization, body });
    expect(f.handleWebhook).toHaveBeenCalledOnce();
    expect(f.actors).toEqual([{ type: "none", source: "none" }]);
    expect(f.queries).not.toHaveBeenCalled();
    expect(f.session).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer", "Basic invalid", "Bearer invalid", "Bearer pcp_not_a_board_key"])(
    "leaves provider authentication responsible for rejecting %s",
    async (authorization) => {
      const f = fixture(mode);
      let req = request(f.app).post(webhookPath).set("content-type", "application/json");
      if (authorization) req = req.set("authorization", authorization);
      const res = await req.send("{}");
      expect(res.status).toBe(401);
      expect(res.body.providerAccepted).toBe(false);
      expect(f.handleWebhook).toHaveBeenCalledOnce();
      expect(f.actors).toEqual([{ type: "none", source: "none" }]);
      expect(f.session).not.toHaveBeenCalled();
    },
  );

  it.each([`${webhookPath}/`, `${webhookPath}?probe=1`])(
    "preserves provider handling for canonical route variant %s",
    async (target) => {
      const f = fixture(mode);
      const res = await request(f.app).post(target).set("authorization", providerAuthorization).send({});
      expect(res.status).toBe(200);
      expect(res.body.providerAccepted).toBe(true);
    },
  );

  it.each([
    ["get", webhookPath], ["put", webhookPath], ["patch", webhookPath], ["delete", webhookPath],
    ["post", `${webhookPath}/extra`], ["post", `${webhookPath}-extra`],
    ["post", `/api/chat-webhooks/${publicId}/slack`],
    ["post", `/api/chat-webhooks/${publicId}/agentmail`],
    ["post", `/api/chat-webhooks/${"A".repeat(42)}/microsoft-teams`],
    ["post", `/api/chat-webhooks/${"A".repeat(44)}/microsoft-teams`],
    ["post", `/api/chat-webhooks/${"A".repeat(42)}%2F/microsoft-teams`],
    ["post", "/api/chat-endpoints/endpoint"], ["post", "/api/companies/company/issues"],
  ] as const)("retains normal actor rejection on %s %s", async (method, target) => {
    const f = fixture(mode);
    const res = await request(f.app)[method](target).set("authorization", providerAuthorization).send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Agent token did not verify");
    expect(f.handleWebhook).not.toHaveBeenCalled();
  });

  it("preserves the normal unauthenticated actor on ordinary API routes", async () => {
    const f = fixture(mode);
    await request(f.app).get("/api/companies/company/issues").expect(404);
    expect(f.actors).toEqual([mode === "local_trusted"
      ? expect.objectContaining({ type: "board", userId: "local-board", source: "local_implicit" })
      : { type: "none", source: "none" }]);
    expect(f.handleWebhook).not.toHaveBeenCalled();
  });

  it("retains the webhook rate limit after delegating authentication", async () => {
    const f = fixture(mode, 1);
    await request(f.app).post(webhookPath).set("authorization", "Bearer invalid").send({}).expect(401);
    await request(f.app).post(webhookPath).set("authorization", providerAuthorization).send({}).expect(429);
    expect(f.handleWebhook).toHaveBeenCalledOnce();
  });
});
