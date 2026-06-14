import express from "express";
import { EventEmitter } from "node:events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
}));
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

vi.mock("../routes/authz.js", () => ({
  getActorInfo: () => ({ actorId: "user-1", agentId: null, runId: null }),
  assertCompanyAccess: () => {},
  assertInstanceAdmin: () => {},
}));

async function createApp(
  deploymentMode: "local_trusted" | "authenticated" = "local_trusted",
  deploymentExposure: "private" | "public" = "private",
) {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use("/api", boardChatRoutes({} as any, { deploymentMode, deploymentExposure }));
  return app;
}

describe("POST /api/board/chat/stream feature flag guard (PAP-137)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // The guard must fire before anything is persisted.
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 403 DEPLOYMENT_MODE_UNSUPPORTED for authenticated public instances", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    const app = await createApp("authenticated", "public");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("DEPLOYMENT_MODE_UNSUPPORTED");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("lets local_trusted requests past the deployment guard when the flag is on", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    const app = await createApp();

    // Omit the body so the request stops at validation — proves the guard
    // admitted it without spawning the chat subprocess.
    const res = await request(app).post("/api/board/chat/stream").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "companyId and message are required" });
  });

  it("lets authenticated private requests past the deployment guard when the flag is on", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    const app = await createApp("authenticated", "private");

    const res = await request(app).post("/api/board/chat/stream").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "companyId and message are required" });
  });
});

describe("board-chat client disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeFakeProc() {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });
    return proc;
  }

  it("kills the spawned subprocess when the client disconnects mid-stream", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([
      { id: "issue-1", title: "Quarterly hiring plan", originKind: "board_chat", status: "todo" },
    ]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.listComments.mockResolvedValue([]);
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc);
    const app = await createApp();

    const req = request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });
    // Start the request without awaiting the (never-ending) SSE response.
    const pending = req.then(
      () => undefined,
      () => undefined,
    );

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    expect(fakeProc.kill).not.toHaveBeenCalled();

    // Client walks away mid-stream.
    req.abort();
    await vi.waitFor(() => expect(fakeProc.kill).toHaveBeenCalledWith("SIGTERM"));

    // Let the subprocess close handler run so the slot is released.
    fakeProc.exitCode = 143;
    fakeProc.emit("close", 143);
    await pending;
  });

  it("tags newly created issues as board chat conversations with a first-message title", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.create.mockResolvedValue({ id: "issue-new" });
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.listComments.mockResolvedValue([]);
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc);
    const app = await createApp();

    const req = request(app)
      .post("/api/board/chat/stream")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ companyId: "company-1", message: "hello" }));
    const pending = req.then(
      () => undefined,
      () => undefined,
    );

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    fakeProc.exitCode = 0;
    fakeProc.emit("close", 0);

    expect(mockIssueService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      title: "hello",
      originKind: "board_chat",
    }));
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-new",
      "hello",
      expect.any(Object),
    );
    req.abort();
    await pending;
  });

  it("reuses board chat issues by origin before falling back to legacy route-owned Board Operations issues", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "issue-legacy",
          title: "Board Operations",
          description: "Standing issue for board concierge conversations and decision log",
          originKind: "manual",
          status: "todo",
        },
      ]);
    mockIssueService.update.mockResolvedValue({ id: "issue-legacy", originKind: "board_chat" });
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.listComments.mockResolvedValue([]);
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc);
    const app = await createApp();

    const req = request(app)
      .post("/api/board/chat/stream")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ companyId: "company-1", message: "hello" }));
    const pending = req.then(
      () => undefined,
      () => undefined,
    );

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    fakeProc.exitCode = 0;
    fakeProc.emit("close", 0);

    expect(mockIssueService.list).toHaveBeenNthCalledWith(1, "company-1", expect.objectContaining({
      originKind: "board_chat",
    }));
    expect(mockIssueService.list).toHaveBeenNthCalledWith(2, "company-1", expect.objectContaining({
      q: "Board Operations",
    }));
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-legacy", { originKind: "board_chat" });
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-legacy",
      "hello",
      expect.any(Object),
    );
    req.abort();
    await pending;
  });
});

describe("board-chat history role classification", () => {
  it("treats only board-concierge comments as assistant turns", async () => {
    const { isConciergeReply } = await import("../routes/board-chat.js");

    // The relay's own persisted replies.
    expect(
      isConciergeReply({ authorAgentId: null, authorUserId: "board-concierge" }),
    ).toBe(true);

    // A human board user.
    expect(isConciergeReply({ authorAgentId: null, authorUserId: "user-1" })).toBe(
      false,
    );

    // An agent commenting on the standing issue is NOT this assistant — its
    // words must not be serialized as the assistant's own prior turns.
    expect(
      isConciergeReply({ authorAgentId: "agent-1", authorUserId: null }),
    ).toBe(false);

    // Defensive: an agent comment can never impersonate the concierge even if
    // both author fields are somehow set.
    expect(
      isConciergeReply({ authorAgentId: "agent-1", authorUserId: "board-concierge" }),
    ).toBe(false);
  });
});
