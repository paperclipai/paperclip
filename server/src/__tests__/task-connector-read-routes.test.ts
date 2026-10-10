import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { chatChannelRoutes } from "../routes/chat-channels.js";
import { emailRoutes } from "../routes/email.js";
import type { ChatChannelService } from "../services/chat-channels.js";
import type { EmailChannelService } from "../services/email-channels.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const boardActor: Express.Request["actor"] = {
  type: "board",
  source: "session",
  userId: "test-board-user",
  companyIds: [companyId],
};
const chat = { getIssueBinding: vi.fn(), get: vi.fn() };
const email = { authorizeRead: vi.fn(), thread: vi.fn() };

function app(actor = boardActor) {
  const instance = express();
  instance.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  instance.use("/api", chatChannelRoutes({} as Db, {
    service: chat as unknown as ChatChannelService,
    heartbeat: { wakeup: vi.fn() },
  }));
  instance.use("/api", emailRoutes({} as Db, email as unknown as EmailChannelService));
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  vi.resetAllMocks();
  chat.getIssueBinding.mockResolvedValue(null);
  email.authorizeRead.mockResolvedValue(undefined);
  email.thread.mockResolvedValue(null);
});

describe("task connector read routes", () => {
  it.each([`chat:${issueId}`, "undefined", "not-a-uuid", ` ${issueId} `])(
    "rejects invalid task ID %s before reading either connector",
    async (invalidId) => {
      const server = app();
      const encodedId = encodeURIComponent(invalidId);
      await request(server).get(`/api/issues/${encodedId}/chat-binding`).expect(400);
      await request(server).get(`/api/companies/${companyId}/email/tasks/${encodedId}`).expect(400);
      expect(chat.getIssueBinding).not.toHaveBeenCalled();
      expect(email.authorizeRead).not.toHaveBeenCalled();
      expect(email.thread).not.toHaveBeenCalled();
    },
  );

  it("retains normal task reads and email authorization", async () => {
    const server = app();
    await request(server).get(`/api/issues/${issueId}/chat-binding`).expect(200, "null");
    await request(server).get(`/api/companies/${companyId}/email/tasks/${issueId}`).expect(200, "null");
    expect(chat.getIssueBinding).toHaveBeenCalledWith(issueId);
    expect(email.authorizeRead).toHaveBeenCalledWith(companyId, issueId, {
      userId: boardActor.userId,
      localImplicit: false,
    });
    expect(email.thread).toHaveBeenCalledWith(companyId, issueId);
  });

  it.each([issueId, `chat:${issueId}`])("retains authentication checks for %s", async (id) => {
    const server = app({ type: "none", source: "none" });
    await request(server).get(`/api/issues/${id}/chat-binding`).expect(403);
    await request(server).get(`/api/companies/${companyId}/email/tasks/${id}`).expect(401);
    expect(chat.getIssueBinding).not.toHaveBeenCalled();
    expect(email.authorizeRead).not.toHaveBeenCalled();
    expect(email.thread).not.toHaveBeenCalled();
  });

  it("retains company isolation for task bindings", async () => {
    const binding = { endpointId: "test-endpoint" };
    chat.getIssueBinding.mockResolvedValue(binding);
    chat.get.mockResolvedValue({ companyId });
    await request(app()).get(`/api/issues/${issueId}/chat-binding`).expect(200, binding);
    chat.get.mockResolvedValue({ companyId: "other-company" });
    await request(app()).get(`/api/issues/${issueId}/chat-binding`).expect(404);
  });

  it.each([issueId, `chat:${issueId}`])("retains company isolation for email task %s", async (id) => {
    await request(app({ ...boardActor, companyIds: [] }))
      .get(`/api/companies/${companyId}/email/tasks/${id}`).expect(403);
    expect(email.authorizeRead).not.toHaveBeenCalled();
    expect(email.thread).not.toHaveBeenCalled();
  });
});
