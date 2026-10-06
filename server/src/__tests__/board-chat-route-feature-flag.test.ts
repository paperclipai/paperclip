import express from "express";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
}));
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

async function createApp(
  deploymentMode: "local_trusted" | "authenticated" = "local_trusted",
  authDb?: Db,
) {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  if (authDb) {
    app.use(actorMiddleware(authDb, { deploymentMode, resolveSession: async () => null }));
  } else {
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
  }
  app.use("/api", boardChatRoutes({} as any, { deploymentMode }));
  app.use(errorHandler);
  return app;
}

describe("POST /api/board/chat/stream feature flag guard (PAP-137)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a valid run-scoped agent JWT before settings, issue writes, or host process spawn", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "board-chat-isolation-test-secret");
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    const agentId = randomUUID();
    const companyId = randomUUID();
    const runId = randomUUID();
    const authDb = {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => table === agents
            ? [{ id: agentId, companyId, status: "idle" }]
            : table === heartbeatRuns
              ? [{ id: runId, companyId, agentId, status: "running", resultJson: {}, contextSnapshot: {} }]
              : [],
        }),
      }),
    } as unknown as Db;

    try {
      const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, null);
      expect(token).not.toBeNull();
      const app = await createApp("local_trusted", authDb);
      const res = await request(app)
        .post("/api/board/chat/stream")
        .set("Authorization", `Bearer ${token}`)
        .send({ companyId, message: "hello" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Board access required");
      expect(mockGetExperimental).not.toHaveBeenCalled();
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
      expect(mockIssueService.create).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
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

  it("returns 403 DEPLOYMENT_MODE_UNSUPPORTED outside local_trusted even with the flag on", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("DEPLOYMENT_MODE_UNSUPPORTED");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("lets requests past the guard when the flag is on (400 on missing body, not 403)", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    const app = await createApp();

    // Omit the body so the request stops at validation — proves the guard
    // admitted it without spawning the chat subprocess.
    const res = await request(app).post("/api/board/chat/stream").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "companyId and message are required" });
  });
});

describe("board-chat client disconnect", () => {
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
      { id: "issue-1", title: "Board Operations", status: "todo" },
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
