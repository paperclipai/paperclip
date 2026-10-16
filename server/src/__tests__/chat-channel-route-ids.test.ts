import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { chatChannelRoutes } from "../routes/chat-channels.js";
import type { ChatChannelService } from "../services/chat-channels.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const endpointId = "33333333-3333-4333-8333-333333333333";
const nestedId = "44444444-4444-4444-8444-444444444444";
const adminActor: Express.Request["actor"] = {
  type: "board",
  source: "session",
  userId: "test-board-user",
  companyIds: [companyId],
  isInstanceAdmin: true,
};
const chat = {
  get: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  createLinkIntent: vi.fn(),
  revokeLink: vi.fn(),
  replayDelivery: vi.fn(),
  replayPublication: vi.fn(),
  resolvePublication: vi.fn(),
  resolveAction: vi.fn(),
  publishComment: vi.fn(),
  getPublicationBatchStatus: vi.fn(),
  slackRegistration: { managerGrants: { choices: vi.fn(), revoke: vi.fn(), defaultMethod: vi.fn() } },
};

function app(actor: Express.Request["actor"] = adminActor) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  instance.use("/api", chatChannelRoutes({} as Db, {
    service: chat as unknown as ChatChannelService,
    heartbeat: { wakeup: vi.fn() },
  }));
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  vi.resetAllMocks();
  chat.get.mockResolvedValue({ id: endpointId, companyId });
  chat.list.mockResolvedValue([]);
  chat.create.mockResolvedValue({ id: endpointId, companyId });
  chat.replayDelivery.mockResolvedValue(undefined);
  chat.slackRegistration.managerGrants.choices.mockResolvedValue({});
  chat.slackRegistration.managerGrants.revoke.mockResolvedValue(undefined);
});

describe("chat channel route ids", () => {
  it.each(["PASTE_ID_HERE", "1407b816", "undefined", ` ${endpointId} `])(
    "rejects endpoint ID %s with 400 before calling the service",
    async (invalidId) => {
      const server = app();
      const encodedId = encodeURIComponent(invalidId);
      const read = await request(server).get(`/api/chat-endpoints/${encodedId}`).expect(400);
      expect(read.body.error).toBe("Chat endpoint ID must be a UUID");
      await request(server).get(`/api/chat-endpoints/${encodedId}/github/configuration`).expect(400);
      expect(chat.get).not.toHaveBeenCalled();
    },
  );

  it("preserves well-formed and unknown endpoint responses", async () => {
    await request(app()).get(`/api/chat-endpoints/${endpointId}`).expect(200);
    expect(chat.get).toHaveBeenCalledWith(endpointId);
    chat.get.mockResolvedValue(null);
    await request(app()).get(`/api/chat-endpoints/${endpointId}`).expect(404);
  });

  it("requires a board actor before validating the endpoint ID", async () => {
    const agentActor = { type: "agent", agentId: "agent-1", companyId, source: "agent_key" } as unknown as Express.Request["actor"];
    await request(app(agentActor)).get("/api/chat-endpoints/PASTE_ID_HERE").expect(403);
    expect(chat.get).not.toHaveBeenCalled();
  });

  it.each([
    ["post", "principals/PASTE_ID_HERE/link-intent", {}, "Chat principal ID", "createLinkIntent"],
    ["delete", "principals/PASTE_ID_HERE/link", undefined, "Chat principal ID", "revokeLink"],
    ["post", "deliveries/PASTE_ID_HERE/replay", undefined, "Chat delivery ID", "replayDelivery"],
    ["post", "publications/PASTE_ID_HERE/replay", undefined, "Chat publication ID", "replayPublication"],
    ["post", "publications/PASTE_ID_HERE/resolve", { action: "cancel" }, "Chat publication ID", "resolvePublication"],
    ["post", "actions/PASTE_ID_HERE/resolve", { action: "cancel" }, "Chat action ID", "resolveAction"],
    ["post", "conversations/PASTE_ID_HERE/publications", { commentId: nestedId }, "Chat conversation ID", "publishComment"],
  ] as const)("rejects a malformed ID on %s .../%s after endpoint access", async (method, path, body, label, serviceMethod) => {
    const res = await request(app())[method](`/api/chat-endpoints/${endpointId}/${path}`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${label} must be a UUID`);
    expect(chat.get).toHaveBeenCalledWith(endpointId);
    expect(chat[serviceMethod]).not.toHaveBeenCalled();
  });

  it("still replays a well-formed delivery ID", async () => {
    await request(app()).post(`/api/chat-endpoints/${endpointId}/deliveries/${nestedId}/replay`).expect(204);
    expect(chat.replayDelivery).toHaveBeenCalledWith(endpointId, nestedId);
  });

  it("keeps the publication status route's combined ID check", async () => {
    const malformed = await request(app())
      .get(`/api/chat-endpoints/PASTE_ID_HERE/conversations/${nestedId}/publications/${nestedId}/status`)
      .expect(400);
    expect(malformed.body.error).toBe("Valid endpoint, conversation, and publication IDs are required");
    const padded = await request(app())
      .get(`/api/chat-endpoints/${endpointId}/conversations/${encodeURIComponent(` ${nestedId} `)}/publications/${nestedId}/status`)
      .expect(400);
    expect(padded.body.error).toBe("Chat conversation ID must be a UUID");
    expect(chat.getPublicationBatchStatus).not.toHaveBeenCalled();
  });

  it("rejects a malformed company ID on company-scoped chat routes before calling the service", async () => {
    const server = app();
    for (const res of [
      await request(server).get("/api/companies/PASTE_ID_HERE/chat-endpoints"),
      await request(server)
        .post("/api/companies/PASTE_ID_HERE/chat-endpoints")
        .send({ provider: "github", assignedAgentId: nestedId }),
      await request(server).get("/api/companies/PASTE_ID_HERE/chat-slack/setup-options"),
      await request(server).delete(`/api/companies/PASTE_ID_HERE/chat-slack/manager-grants/${nestedId}`),
    ]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Company ID must be a UUID");
    }
    expect(chat.list).not.toHaveBeenCalled();
    expect(chat.create).not.toHaveBeenCalled();
    expect(chat.slackRegistration.managerGrants.choices).not.toHaveBeenCalled();
    expect(chat.slackRegistration.managerGrants.revoke).not.toHaveBeenCalled();
    await request(server).get(`/api/companies/${companyId}/chat-endpoints`).expect(200);
    expect(chat.list).toHaveBeenCalledWith(companyId);
  });

  it("checks company access before validating a Slack manager grant ID", async () => {
    const memberActor: Express.Request["actor"] = { ...adminActor, isInstanceAdmin: false };
    await request(app(memberActor))
      .delete(`/api/companies/${otherCompanyId}/chat-slack/manager-grants/PASTE_ID_HERE`)
      .expect(403);
    const malformed = await request(app())
      .delete(`/api/companies/${companyId}/chat-slack/manager-grants/PASTE_ID_HERE`)
      .expect(400);
    expect(malformed.body.error).toBe("Slack manager grant ID must be a UUID");
    expect(chat.slackRegistration.managerGrants.revoke).not.toHaveBeenCalled();
    await request(app()).delete(`/api/companies/${companyId}/chat-slack/manager-grants/${nestedId}`).expect(204);
    expect(chat.slackRegistration.managerGrants.revoke).toHaveBeenCalledWith(
      nestedId,
      companyId,
      expect.objectContaining({ userId: "test-board-user" }),
    );
  });
});
