import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockRoomHandle = vi.hoisted(() => vi.fn());
const mockWakeHost = vi.hoisted(() => vi.fn());
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
  roomMessageService: () => ({
    handle: mockRoomHandle,
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

describe("POST /api/board/chat/stream silent-until-@ + host_run (P0/P1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
  });

  beforeEach(async () => {
    const { resetHostRunRateLimitForTests } = await import("../routes/board-chat.js");
    resetHostRunRateLimitForTests();
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
    expect(mockWakeHost).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns 202 host_run for a single mention", async () => {
    mockRoomHandle.mockResolvedValue({
      mode: "adapter_wake_pending",
      issueId: "issue-1",
      commentId: "comment-2",
      roomMessageId: "comment-2",
      mentionedAgentIds: ["agent-ceo"],
    });
    mockWakeHost.mockResolvedValue({
      mode: "host_run",
      issueId: "issue-1",
      roomMessageId: "comment-2",
      commentId: "comment-2",
      hostAgentId: "agent-ceo",
      hostRunId: "run-9",
      status: "queued",
    });
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
  });

  it("returns 409 when host agent is not invokable", async () => {
    mockRoomHandle.mockResolvedValue({
      mode: "adapter_wake_pending",
      issueId: "issue-1",
      commentId: "comment-2",
      roomMessageId: "comment-2",
      mentionedAgentIds: ["agent-ceo"],
    });
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

  it("returns 403 TASK_COMPANY_MISMATCH for cross-company taskId", async () => {
    const { TaskCompanyMismatchError } = await import("../services/room-message.js");
    mockRoomHandle.mockRejectedValue(new TaskCompanyMismatchError());
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
  });

  it("returns 404 TASK_NOT_FOUND for unknown taskId", async () => {
    const { TaskNotFoundError } = await import("../services/room-message.js");
    mockRoomHandle.mockRejectedValue(new TaskNotFoundError("missing-issue"));
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
  });

  it("returns 429 RATE_LIMITED on the 4th host_run wake within 60 seconds", async () => {
    mockRoomHandle.mockResolvedValue({
      mode: "adapter_wake_pending",
      issueId: "issue-1",
      commentId: "comment-2",
      roomMessageId: "comment-2",
      mentionedAgentIds: ["agent-ceo"],
    });
    mockWakeHost.mockResolvedValue({
      mode: "host_run",
      issueId: "issue-1",
      roomMessageId: "comment-2",
      commentId: "comment-2",
      hostAgentId: "agent-ceo",
      hostRunId: "run-9",
      status: "queued",
    });
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
  });
});
