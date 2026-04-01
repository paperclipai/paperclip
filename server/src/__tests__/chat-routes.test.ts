import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatRoutes } from "../routes/chat.js";
import { errorHandler } from "../middleware/index.js";

const mockChatService = vi.hoisted(() => ({
  listRooms: vi.fn(),
  getRoom: vi.fn(),
  getOrCreateDirectRoom: vi.fn(),
  getOrCreateBoardroom: vi.fn(),
  listMessages: vi.fn(),
  addMessage: vi.fn(),
  createAttachment: vi.fn(),
  listMessageAttachments: vi.fn(async () => new Map()),
}));

const mockIssueService = vi.hoisted(() => ({
  findMentionedAgents: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  chatService: () => mockChatService,
  heartbeatService: () => mockHeartbeatService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

function createApp(actorOverride?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actorOverride ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", chatRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeRoom(overrides: Record<string, unknown> = {}) {
  return {
    id: "room-1",
    companyId: "company-1",
    kind: "direct",
    agentId: "22222222-2222-4222-8222-222222222222",
    title: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    companyId: "company-1",
    chatRoomId: "room-1",
    authorAgentId: null,
    authorUserId: "local-board",
    body: "hello",
    runId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("chat routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Direct room 1:1 chat flow ---

  it("creates a direct room", async () => {
    const room = makeRoom();
    mockChatService.getOrCreateDirectRoom.mockResolvedValue({
      room,
      created: true,
      error: null,
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/chat/rooms")
      .send({ kind: "direct", agentId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "room-1", kind: "direct" });
    expect(mockChatService.getOrCreateDirectRoom).toHaveBeenCalledWith("company-1", "22222222-2222-4222-8222-222222222222");
  });

  it("returns existing direct room with 200", async () => {
    const room = makeRoom();
    mockChatService.getOrCreateDirectRoom.mockResolvedValue({
      room,
      created: false,
      error: null,
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/chat/rooms")
      .send({ kind: "direct", agentId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "room-1" });
  });

  it("returns 404 when agent not found for direct room", async () => {
    mockChatService.getOrCreateDirectRoom.mockResolvedValue({
      room: null,
      created: false,
      error: "agent_not_found",
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/chat/rooms")
      .send({ kind: "direct", agentId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Agent not found" });
  });

  it("posts a message to a direct room and wakes the agent", async () => {
    const room = makeRoom({ kind: "direct", agentId: "22222222-2222-4222-8222-222222222222" });
    const message = makeMessage();
    mockChatService.getRoom.mockResolvedValue(room);
    mockChatService.addMessage.mockResolvedValue(message);

    const res = await request(createApp())
      .post("/api/companies/company-1/chat/rooms/room-1/messages")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "msg-1" });

    // wakeup is fire-and-forget
    await vi.waitFor(() => {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "22222222-2222-4222-8222-222222222222",
        expect.objectContaining({ reason: "chat_message" }),
      );
    });
  });

  it("does not wake agent when agent posts to its own direct room", async () => {
    const room = makeRoom({ kind: "direct", agentId: "22222222-2222-4222-8222-222222222222" });
    const message = makeMessage({ authorAgentId: "22222222-2222-4222-8222-222222222222", authorUserId: null });
    mockChatService.getRoom.mockResolvedValue(room);
    mockChatService.addMessage.mockResolvedValue(message);

    const agentActor = {
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      source: "api_key",
      isInstanceAdmin: false,
    };

    const res = await request(createApp(agentActor))
      .post("/api/companies/company-1/chat/rooms/room-1/messages")
      .send({ body: "self-message" });

    expect(res.status).toBe(201);

    // Give fire-and-forget a chance to run
    await new Promise((r) => setTimeout(r, 20));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("lists messages for a room", async () => {
    const room = makeRoom();
    const messages = [makeMessage(), makeMessage({ id: "msg-2" })];
    mockChatService.getRoom.mockResolvedValue(room);
    mockChatService.listMessages.mockResolvedValue(messages);

    const res = await request(createApp())
      .get("/api/companies/company-1/chat/rooms/room-1/messages");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("returns 404 for GET messages on nonexistent room", async () => {
    mockChatService.getRoom.mockResolvedValue(null);

    const res = await request(createApp())
      .get("/api/companies/company-1/chat/rooms/room-999/messages");

    expect(res.status).toBe(404);
  });

  it("returns 404 for POST message to nonexistent room", async () => {
    mockChatService.getRoom.mockResolvedValue(null);

    const res = await request(createApp())
      .post("/api/companies/company-1/chat/rooms/room-999/messages")
      .send({ body: "hello" });

    expect(res.status).toBe(404);
  });

  // --- Boardroom flow ---

  it("creates a boardroom", async () => {
    const room = makeRoom({ kind: "boardroom", agentId: null, title: "Boardroom" });
    mockChatService.getOrCreateBoardroom.mockResolvedValue({
      room,
      created: true,
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/chat/rooms")
      .send({ kind: "boardroom" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "boardroom" });
  });

  it("posts to boardroom with @mention and wakes mentioned agent", async () => {
    const room = makeRoom({ kind: "boardroom", agentId: null });
    const message = makeMessage({ chatRoomId: "room-1", body: "hey @Alice" });
    mockChatService.getRoom.mockResolvedValue(room);
    mockChatService.addMessage.mockResolvedValue(message);
    mockIssueService.findMentionedAgents.mockResolvedValue(["agent-alice"]);

    const res = await request(createApp())
      .post("/api/companies/company-1/chat/rooms/room-1/messages")
      .send({ body: "hey @Alice" });

    expect(res.status).toBe(201);

    await vi.waitFor(() => {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "agent-alice",
        expect.objectContaining({ reason: "chat_message_mentioned" }),
      );
    });
  });

  it("posts to boardroom without mentions and does not wake anyone", async () => {
    const room = makeRoom({ kind: "boardroom", agentId: null });
    const message = makeMessage({ body: "just chatting" });
    mockChatService.getRoom.mockResolvedValue(room);
    mockChatService.addMessage.mockResolvedValue(message);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);

    const res = await request(createApp())
      .post("/api/companies/company-1/chat/rooms/room-1/messages")
      .send({ body: "just chatting" });

    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 20));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  // --- Validation ---

  it("returns 400 for empty message body", async () => {
    const room = makeRoom();
    mockChatService.getRoom.mockResolvedValue(room);

    const res = await request(createApp())
      .post("/api/companies/company-1/chat/rooms/room-1/messages")
      .send({ body: "" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for direct room without agentId", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/chat/rooms")
      .send({ kind: "direct" });

    expect(res.status).toBe(400);
  });
});
