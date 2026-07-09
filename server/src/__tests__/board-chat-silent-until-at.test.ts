import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockPrepareMentionWake = vi.hoisted(() => vi.fn());
const mockCommit = vi.hoisted(() => vi.fn());
const mockRoomGetTurnStatus = vi.hoisted(() => vi.fn());
const mockWakeHost = vi.hoisted(() => vi.fn());
const mockWakeMentionedAgents = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockGetActorInfo = vi.hoisted(() =>
  vi.fn(() => ({ actorId: "user-1", agentId: null as string | null, runId: null as string | null })),
);

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  logActivity: mockLogActivity,
}));

vi.mock("../services/room-message.js", () => ({
  FanoutNotEnabledError: class FanoutNotEnabledError extends Error {
    readonly code = "FANOUT_NOT_ENABLED" as const;
    constructor() {
      super("Fan-out is not enabled yet; mention one agent at a time.");
    }
  },
  TooManyMentionsError: class TooManyMentionsError extends Error {
    readonly code = "TOO_MANY_MENTIONS" as const;
    readonly max: number;
    constructor(max = 5) {
      super(`Too many agent mentions; maximum is ${max}`);
      this.max = max;
    }
  },
  InvalidMentionError: class InvalidMentionError extends Error {
    readonly code = "INVALID_MENTION" as const;
    constructor() {
      super("Message contains an agent mention that does not resolve to a company agent");
    }
  },
  TaskNotFoundError: class TaskNotFoundError extends Error {
    readonly code = "TASK_NOT_FOUND" as const;
    constructor(taskId: string) {
      super(`Task not found: ${taskId}`);
    }
  },
  TaskCompanyMismatchError: class TaskCompanyMismatchError extends Error {
    readonly code = "TASK_COMPANY_MISMATCH" as const;
    constructor() {
      super("Task does not belong to this company");
    }
  },
  TurnNotFoundError: class TurnNotFoundError extends Error {
    readonly code = "TURN_NOT_FOUND" as const;
    constructor(roomMessageId: string) {
      super(`Conference Room turn not found: ${roomMessageId}`);
    }
  },
  roomMessageService: () => ({
    prepareMentionWake: mockPrepareMentionWake,
    commit: mockCommit,
    getTurnStatus: mockRoomGetTurnStatus,
  }),
}));

vi.mock("../services/room-orchestrator.js", () => ({
  AgentNotInvokableError: class AgentNotInvokableError extends Error {
    readonly code = "AGENT_NOT_INVOKABLE" as const;
    constructor(message: string) {
      super(message);
    }
  },
  roomOrchestratorService: () => ({
    wakeHost: mockWakeHost,
    wakeMentionedAgents: mockWakeMentionedAgents,
  }),
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

vi.mock("../routes/authz.js", () => ({
  getActorInfo: () => mockGetActorInfo(),
  assertCompanyAccess: () => {},
}));

async function createApp(deploymentMode: "local_trusted" | "authenticated" = "authenticated") {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use("/api", boardChatRoutes({} as never, { deploymentMode }));
  return app;
}

function mockSilentPrepareAndCommit() {
  mockPrepareMentionWake.mockResolvedValue({
    mode: "silent",
    issueId: "issue-1",
  });
  mockCommit.mockResolvedValue({
    mode: "silent",
    issueId: "issue-1",
    commentId: "comment-1",
    roomMessageId: "comment-1",
  });
}

function mockWakePrepareAndCommit(commentId = "comment-2") {
  mockPrepareMentionWake.mockResolvedValue({
    mode: "adapter_wake_pending",
    issueId: "issue-1",
    mentionedAgentIds: ["agent-ceo"],
  });
  mockCommit.mockResolvedValue({
    mode: "adapter_wake_pending",
    issueId: "issue-1",
    commentId,
    roomMessageId: commentId,
    mentionedAgentIds: ["agent-ceo"],
  });
  mockWakeHost.mockResolvedValue({
    mode: "host_run",
    issueId: "issue-1",
    roomMessageId: commentId,
    commentId,
    hostAgentId: "agent-ceo",
    hostRunId: "run-9",
    status: "queued",
  });
}

describe("POST /api/board/chat/stream silent-until-@ + host_run (P0/P1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockLogActivity.mockResolvedValue(undefined);
    mockGetActorInfo.mockReturnValue({ actorId: "user-1", agentId: null, runId: null });
  });

  beforeEach(async () => {
    const { resetHostRunRateLimitForTests, resetBoardChatIdempotencyForTests } = await import(
      "../routes/board-chat.js"
    );
    resetHostRunRateLimitForTests();
    resetBoardChatIdempotencyForTests();
  });

  it("returns 403 FEATURE_DISABLED when enableConferenceRoomChat is off", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: false });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FEATURE_DISABLED");
    expect(mockPrepareMentionWake).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it("returns 200 silent JSON in authenticated mode without mentions", async () => {
    mockSilentPrepareAndCommit();
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
    expect(mockWakeHost).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockCommit).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "board_chat.message",
        entityType: "issue_comment",
        entityId: "comment-1",
      }),
    );
  });

  it("returns 202 host_run for a single mention", async () => {
    mockWakePrepareAndCommit();
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({
        companyId: "company-1",
        message: "[@CEO](agent://agent-ceo) olá",
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      mode: "host_run",
      issueId: "issue-1",
      commentId: "comment-2",
      roomMessageId: "comment-2",
      hostAgentId: "agent-ceo",
      hostRunId: "run-9",
      status: "queued",
    });
    expect(mockWakeHost).toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "board_chat.message",
        details: expect.objectContaining({ mode: "host_run", hostRunId: "run-9" }),
      }),
    );
  });

  it("replays the same response for duplicate clientMessageId without re-handling", async () => {
    mockSilentPrepareAndCommit();
    const app = await createApp("authenticated");
    const payload = {
      companyId: "company-1",
      message: "bom dia equipe",
      clientMessageId: "msg-abc",
    };

    const first = await request(app).post("/api/board/chat/stream").send(payload);
    const second = await request(app).post("/api/board/chat/stream").send(payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(mockPrepareMentionWake).toHaveBeenCalledTimes(1);
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });

  it("awaits in-flight idempotent request and returns the same result", async () => {
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    mockPrepareMentionWake.mockImplementation(async () => {
      await prepareGate;
      return { mode: "silent", issueId: "issue-1" };
    });
    mockCommit.mockResolvedValue({
      mode: "silent",
      issueId: "issue-1",
      commentId: "comment-1",
      roomMessageId: "comment-1",
    });
    const app = await createApp("authenticated");
    const payload = {
      companyId: "company-1",
      message: "bom dia equipe",
      clientMessageId: "msg-inflight",
    };

    // SuperTest only sends when the thenable is consumed — attach .then to start.
    const firstPromise = request(app).post("/api/board/chat/stream").send(payload);
    void firstPromise.then(() => undefined);

    await vi.waitFor(() => {
      expect(mockPrepareMentionWake).toHaveBeenCalledTimes(1);
    });

    const secondPromise = request(app).post("/api/board/chat/stream").send(payload);
    releasePrepare();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(mockPrepareMentionWake).toHaveBeenCalledTimes(1);
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });

  it("accepts Idempotency-Key header as clientMessageId", async () => {
    mockSilentPrepareAndCommit();
    const app = await createApp("authenticated");

    const first = await request(app)
      .post("/api/board/chat/stream")
      .set("Idempotency-Key", "hdr-key-1")
      .send({ companyId: "company-1", message: "hello" });
    const second = await request(app)
      .post("/api/board/chat/stream")
      .set("Idempotency-Key", "hdr-key-1")
      .send({ companyId: "company-1", message: "hello again" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(mockPrepareMentionWake).toHaveBeenCalledTimes(1);
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when host agent is not invokable", async () => {
    mockWakePrepareAndCommit();
    const { AgentNotInvokableError } = await import("../services/room-orchestrator.js");
    mockWakeHost.mockRejectedValue(new AgentNotInvokableError("Agent paused"));
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({
        companyId: "company-1",
        message: "[@CEO](agent://agent-ceo) olá",
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AGENT_NOT_INVOKABLE");
  });

  it("returns 202 fanout when multiple agents are mentioned", async () => {
    mockPrepareMentionWake.mockResolvedValue({
      mode: "adapter_wake_pending",
      issueId: "issue-1",
      mentionedAgentIds: ["agent-ceo", "agent-dev"],
    });
    mockCommit.mockResolvedValue({
      mode: "adapter_wake_pending",
      issueId: "issue-1",
      commentId: "comment-fan",
      roomMessageId: "comment-fan",
      mentionedAgentIds: ["agent-ceo", "agent-dev"],
    });
    mockWakeMentionedAgents.mockResolvedValue({
      mode: "fanout",
      issueId: "issue-1",
      roomMessageId: "comment-fan",
      commentId: "comment-fan",
      hostRuns: [
        { agentId: "agent-ceo", runId: "run-a", status: "queued" },
        { agentId: "agent-dev", runId: "run-b", status: "queued" },
      ],
      delegationStatus: "pending",
    });
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({
        companyId: "company-1",
        message: "[@CEO](agent://agent-ceo) [@Dev](agent://agent-dev)",
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      mode: "fanout",
      issueId: "issue-1",
      commentId: "comment-fan",
      roomMessageId: "comment-fan",
      hostRuns: [
        { agentId: "agent-ceo", runId: "run-a" },
        { agentId: "agent-dev", runId: "run-b" },
      ],
      delegationStatus: "pending",
    });
    expect(mockWakeMentionedAgents).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAgentIds: ["agent-ceo", "agent-dev"],
        roomMessageId: "comment-fan",
      }),
    );
    expect(mockWakeHost).not.toHaveBeenCalled();
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });

  it("returns 400 TOO_MANY_MENTIONS without committing a comment", async () => {
    const { TooManyMentionsError } = await import("../services/room-message.js");
    mockPrepareMentionWake.mockRejectedValue(new TooManyMentionsError(5));
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({
        companyId: "company-1",
        message: "too many mentions",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOO_MANY_MENTIONS");
    expect(res.body.max).toBe(5);
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it("returns 422 INVALID_MENTION without committing a comment", async () => {
    const { InvalidMentionError } = await import("../services/room-message.js");
    mockPrepareMentionWake.mockRejectedValue(new InvalidMentionError());
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({
        companyId: "company-1",
        message: "[@Ghost](agent://missing-agent) olá",
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_MENTION");
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR when companyId or message are missing", async () => {
    const app = await createApp();

    const res = await request(app).post("/api/board/chat/stream").send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details).toBeDefined();
    expect(mockPrepareMentionWake).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it("returns 403 TASK_COMPANY_MISMATCH for cross-company taskId", async () => {
    const { TaskCompanyMismatchError } = await import("../services/room-message.js");
    mockPrepareMentionWake.mockRejectedValue(new TaskCompanyMismatchError());
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({
        companyId: "company-1",
        message: "hello",
        taskId: "issue-other-co",
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("TASK_COMPANY_MISMATCH");
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it("returns 404 TASK_NOT_FOUND for unknown taskId", async () => {
    const { TaskNotFoundError } = await import("../services/room-message.js");
    mockPrepareMentionWake.mockRejectedValue(new TaskNotFoundError("missing-issue"));
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({
        companyId: "company-1",
        message: "hello",
        taskId: "missing-issue",
      });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("TASK_NOT_FOUND");
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it("returns 429 RATE_LIMITED on the 4th host_run wake within 60 seconds without committing", async () => {
    mockWakePrepareAndCommit();
    const app = await createApp("authenticated");
    const payload = {
      companyId: "company-1",
      message: "[@CEO](agent://agent-ceo) olá",
    };

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post("/api/board/chat/stream").send(payload);
      expect(res.status).toBe(202);
    }

    const limited = await request(app).post("/api/board/chat/stream").send(payload);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(limited.headers["retry-after"]).toBe("60");
    expect(mockWakeHost).toHaveBeenCalledTimes(3);
    // 4th request prepares but must not commit a comment
    expect(mockPrepareMentionWake).toHaveBeenCalledTimes(4);
    expect(mockCommit).toHaveBeenCalledTimes(3);
  });

  it("returns 429 RATE_LIMITED on the 2nd agent host_run wake within 60 seconds", async () => {
    mockGetActorInfo.mockReturnValue({ actorId: "agent-1", agentId: "agent-1", runId: "run-actor" });
    mockWakePrepareAndCommit();
    const app = await createApp("authenticated");
    const payload = {
      companyId: "company-1",
      message: "[@CEO](agent://agent-ceo) olá",
    };

    const first = await request(app).post("/api/board/chat/stream").send(payload);
    expect(first.status).toBe(202);

    const second = await request(app).post("/api/board/chat/stream").send(payload);
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("RATE_LIMITED");
    expect(second.headers["retry-after"]).toBe("60");
    expect(mockWakeHost).toHaveBeenCalledTimes(1);
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/board/chat/turns/:roomMessageId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
  });

  it("returns 200 with silent status when no host run exists", async () => {
    mockRoomGetTurnStatus.mockResolvedValue({
      roomMessageId: "comment-1",
      issueId: "issue-1",
      commentId: "comment-1",
      status: "silent",
    });
    const app = await createApp();

    const res = await request(app)
      .get("/api/board/chat/turns/comment-1")
      .query({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      roomMessageId: "comment-1",
      issueId: "issue-1",
      commentId: "comment-1",
      status: "silent",
    });
  });

  it("returns 200 with host run status", async () => {
    mockRoomGetTurnStatus.mockResolvedValue({
      roomMessageId: "comment-2",
      issueId: "issue-1",
      commentId: "comment-2",
      hostRunId: "run-9",
      hostAgentId: "agent-ceo",
      status: "queued",
    });
    const app = await createApp();

    const res = await request(app)
      .get("/api/board/chat/turns/comment-2")
      .query({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(res.body.hostRunId).toBe("run-9");
  });

  it("returns 404 TURN_NOT_FOUND for unknown room message", async () => {
    const { TurnNotFoundError } = await import("../services/room-message.js");
    mockRoomGetTurnStatus.mockRejectedValue(new TurnNotFoundError("missing-comment"));
    const app = await createApp();

    const res = await request(app)
      .get("/api/board/chat/turns/missing-comment")
      .query({ companyId: "company-1" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("TURN_NOT_FOUND");
  });

  it("returns 400 VALIDATION_ERROR when companyId is missing", async () => {
    const app = await createApp();

    const res = await request(app).get("/api/board/chat/turns/comment-1");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(mockRoomGetTurnStatus).not.toHaveBeenCalled();
  });
});
