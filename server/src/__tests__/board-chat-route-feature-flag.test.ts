import express from "express";
import { EventEmitter } from "node:events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockRoomHandle = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
}));

vi.mock("../services/room-message.js", () => ({
  FanoutNotEnabledError: class FanoutNotEnabledError extends Error {
    readonly code = "FANOUT_NOT_ENABLED" as const;
  },
  roomMessageService: () => ({
    handle: mockRoomHandle,
  }),
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

vi.mock("../routes/authz.js", () => ({
  getActorInfo: () => ({ actorId: "user-1", agentId: null, runId: null }),
  assertCompanyAccess: () => {},
}));

async function createApp(deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use("/api", boardChatRoutes({} as never, { deploymentMode }));
  return app;
}

describe("POST /api/board/chat/stream feature flag guard (PAP-137)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockRoomHandle.mockResolvedValue({
      mode: "silent",
      issueId: "issue-1",
      commentId: "comment-1",
      roomMessageId: "comment-1",
    });
  });

  it("returns 403 FEATURE_DISABLED when enableConferenceRoomChat is off", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: false });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Conference Room Chat is not enabled",
      code: "FEATURE_DISABLED",
    });
    expect(mockRoomHandle).not.toHaveBeenCalled();
  });

  it("allows authenticated deployment mode when the flag is on", async () => {
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("silent");
    expect(mockRoomHandle).toHaveBeenCalled();
  });

  it("lets requests past the guard when the flag is on (400 on missing body, not 403)", async () => {
    const app = await createApp();

    const res = await request(app).post("/api/board/chat/stream").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "companyId and message are required" });
  });
});

describe("board-chat history role classification", () => {
  it("treats only board-concierge comments as assistant turns", async () => {
    const { isConciergeReply } = await import("../routes/board-chat.js");

    expect(
      isConciergeReply({ authorAgentId: null, authorUserId: "board-concierge" }),
    ).toBe(true);
    expect(isConciergeReply({ authorAgentId: null, authorUserId: "user-1" })).toBe(
      false,
    );
    expect(
      isConciergeReply({ authorAgentId: "agent-1", authorUserId: null }),
    ).toBe(false);
    expect(
      isConciergeReply({ authorAgentId: "agent-1", authorUserId: "board-concierge" }),
    ).toBe(false);
  });
});
