import express from "express";
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
    constructor() {
      super("Fan-out is not enabled yet; mention one agent at a time.");
    }
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

async function createApp(deploymentMode: "local_trusted" | "authenticated" = "authenticated") {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use("/api", boardChatRoutes({} as never, { deploymentMode }));
  return app;
}

describe("POST /api/board/chat/stream silent-until-@ (P0)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
  });

  it("returns 403 FEATURE_DISABLED when enableConferenceRoomChat is off", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: false });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FEATURE_DISABLED");
    expect(mockRoomHandle).not.toHaveBeenCalled();
  });

  it("returns 200 silent JSON in authenticated mode without mentions", async () => {
    mockRoomHandle.mockResolvedValue({
      mode: "silent",
      issueId: "issue-1",
      commentId: "comment-1",
      roomMessageId: "comment-1",
    });
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "bom dia equipe" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      mode: "silent",
      issueId: "issue-1",
      commentId: "comment-1",
      roomMessageId: "comment-1",
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns 202 adapter_wake_pending for a single mention", async () => {
    mockRoomHandle.mockResolvedValue({
      mode: "adapter_wake_pending",
      issueId: "issue-1",
      commentId: "comment-2",
      roomMessageId: "comment-2",
      mentionedAgentIds: ["agent-ceo"],
    });
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({
        companyId: "company-1",
        message: "[@CEO](agent://agent-ceo) olá",
      });

    expect(res.status).toBe(202);
    expect(res.body.mode).toBe("adapter_wake_pending");
    expect(res.body.mentionedAgentIds).toEqual(["agent-ceo"]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns 400 FANOUT_NOT_ENABLED for multiple mentions", async () => {
    const { FanoutNotEnabledError } = await import("../services/room-message.js");
    mockRoomHandle.mockRejectedValue(new FanoutNotEnabledError());
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({
        companyId: "company-1",
        message: "[@CEO](agent://a) [@Dev](agent://b)",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("FANOUT_NOT_ENABLED");
  });

  it("returns 400 when companyId or message are missing", async () => {
    const app = await createApp();

    const res = await request(app).post("/api/board/chat/stream").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "companyId and message are required" });
    expect(mockRoomHandle).not.toHaveBeenCalled();
  });
});
