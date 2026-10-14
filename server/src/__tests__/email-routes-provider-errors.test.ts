import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { forbidden } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { emailRoutes } from "../routes/email.js";
import { agentmailApi } from "../services/agentmail-api.js";
import type { EmailChannelService } from "../services/email-channels.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const setupPath = `/api/companies/${companyId}/email/inboxes`;
const setupInput = {
  assignedAgentId: agentId,
  apiKey: "private-api-key",
  username: "ralph",
  receiveMode: "websocket",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
};

function app(setup: () => Promise<unknown>) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "board" };
    next();
  });
  instance.use("/api", emailRoutes({} as Db, { setup, inspect: setup } as unknown as EmailChannelService));
  instance.use(errorHandler);
  return instance;
}

describe("AgentMail provider errors at the HTTP boundary", () => {
  it("explains a key-creation 404 without claiming the allocated address is missing", async () => {
    const api = agentmailApi("private-api-key", vi.fn(async () => Response.json({ code: "not_found" }, { status: 404 })));
    const response = await request(app(() => api.createInboxKey("ralph@agentmail.to")))
      .post(setupPath).send(setupInput).expect(422);
    expect(response.body.error).toBe("AgentMail could not create an access key for this inbox. The email address was saved; try finishing the connection again.");
    expect(response.body.details).toMatchObject({ providerStatus: 404, operation: "create_inbox_key" });
  });

  it.each(["resource_taken", "already_exists"])("identifies %s on inbox creation even when AgentMail returns 403", async (code) => {
    const api = agentmailApi("private-api-key", vi.fn(async () => Response.json({
      code, message: "private provider message", fix: "private-api-key", docs: "https://untrusted.invalid",
    }, { status: 403 })));
    const response = await request(app(() => api.createInbox({ username: "ralph" })))
      .post(setupPath).send(setupInput).expect(409);
    expect(response.body).toMatchObject({
      code: "agentmail_address_taken", error: "This email address is already in use. Choose a different address.",
      details: { field: "username", providerStatus: 403, operation: "create_inbox" },
    });
    expect(response.text).not.toMatch(/private|untrusted/);
  });

  it("does not mislabel a taken resource during another operation as a taken address", async () => {
    const api = agentmailApi("private-api-key", vi.fn(async () => Response.json({ code: "resource_taken" }, { status: 403 })));
    const response = await request(app(() => api.createInboxKey("ralph@agentmail.to")))
      .post(setupPath).send(setupInput).expect(422);
    expect(response.body.code).toBe("agentmail_request_failed");
    expect(response.body.error).not.toContain("already in use");
  });

  it.each([
    [401, 422, "AgentMail rejected the API key"],
    [403, 422, "AgentMail did not allow Paperclip to create the email address"],
    [400, 422, "Try a different address"],
    [409, 422, "Try a different address"],
    [422, 422, "Try a different address"],
    [404, 422, "could not find the requested inbox or resource"],
    [429, 429, "rate limiting"],
    [503, 502, "temporarily unavailable"],
  ])("explains provider %i without exposing the provider body", async (providerStatus, status, message) => {
    const fetcher = vi.fn(async () => new Response("private provider body and private-api-key", {
      status: providerStatus,
      headers: { "Retry-After": "12" },
    }));
    const api = agentmailApi("private-api-key", fetcher);
    const response = await request(app(() => api.createInbox({ username: "ralph" })))
      .post(setupPath).send(setupInput);
    expect(response.status).toBe(status);
    expect(response.body.error).toContain(message);
    expect(response.body.details).toEqual({
      code: "agentmail_request_failed", providerStatus, operation: "create_inbox",
    });
    expect(response.text).not.toMatch(/private|Internal server error/);
    if (providerStatus === 429) expect(response.headers["retry-after"]).toBe("12");
  });

  it("explains a denied runtime-key creation without suggesting a different address", async () => {
    const api = agentmailApi("private-api-key", vi.fn(async () => new Response(null, { status: 403 })));
    const response = await request(app(() => api.createInboxKey("ralph@agentmail.to")))
      .post(setupPath).send(setupInput).expect(422);
    expect(response.body.error).toContain("create an inbox-scoped API key");
    expect(response.body.error).not.toContain("different address");
    expect(response.body.details.operation).toBe("create_inbox_key");
  });

  it("keeps a rejected provider key distinct from Paperclip session authentication", async () => {
    const api = agentmailApi("private-api-key", vi.fn(async () => new Response(null, { status: 401 })));
    const response = await request(app(() => api.whoami()))
      .post(`/api/companies/${companyId}/email/inspect`).send({ apiKey: "private-api-key" }).expect(422);
    expect(response.body.error).toContain("AgentMail rejected the API key");
    expect(response.body.details.operation).toBe("inspect_key");
  });

  it("preserves Paperclip authorization errors", async () => {
    const response = await request(app(async () => { throw forbidden("Missing permission: tools:manage_connections"); }))
      .post(setupPath).send(setupInput).expect(403);
    expect(response.body.error).toBe("Missing permission: tools:manage_connections");
    expect(response.body.details).toBeUndefined();
  });
});
