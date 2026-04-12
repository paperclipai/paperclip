import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueComments, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import { copilotRoutes } from "../routes/copilot.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  addComment: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  list: vi.fn(),
  cancelRun: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  agentService: () => mockAgentService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
}));

function createDbMock(input: {
  issueRows?: Array<Array<Record<string, unknown>>>;
  commentRows?: Array<Array<Record<string, unknown>>>;
  fallbackRows?: Array<Array<Record<string, unknown>>>;
}) {
  const issueQueue = [...(input.issueRows ?? [])];
  const commentQueue = [...(input.commentRows ?? [])];
  const fallbackQueue = [...(input.fallbackRows ?? [])];
  let activeQueue = fallbackQueue;
  const limit = vi.fn(async () => activeQueue.shift() ?? []);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn((table: unknown) => {
    if (table === issues) {
      activeQueue = issueQueue;
    } else if (table === issueComments) {
      activeQueue = commentQueue;
    } else {
      activeQueue = fallbackQueue;
    }
    return { where };
  });
  const select = vi.fn(() => ({ from }));
  return {
    db: {
      select,
    },
    calls: {
      select,
      from,
      where,
      orderBy,
      limit,
    },
  } as const;
}

function createApp(actor: Record<string, unknown>, db: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", copilotRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("copilot routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue({
      id: "issue-copilot-1",
      identifier: "PAP-900",
      title: "Board Copilot Thread",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-fallback",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      updatedAt: new Date("2026-04-12T10:00:00.000Z"),
    });
    mockIssueService.update.mockResolvedValue(null);
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "issue-copilot-1",
      body: "hello",
      userId: "user-1",
      runId: null,
      createdAt: new Date("2026-04-12T10:01:00.000Z"),
      updatedAt: new Date("2026-04-12T10:01:00.000Z"),
    });
    mockAgentService.list.mockResolvedValue([
      {
        id: "agent-fallback",
        companyId: "company-1",
        status: "active",
        role: "coo",
        createdAt: new Date("2026-04-01T10:00:00.000Z"),
      },
    ]);
    mockAgentService.getById.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue({
      id: "run-1",
      status: "queued",
    });
    mockHeartbeatService.list.mockResolvedValue([]);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
  });

  it("creates a per-user copilot thread and prefers context issue assignee when available", async () => {
    const { db } = createDbMock({
      issueRows: [[]],
    });
    mockIssueService.getById.mockResolvedValue({
      id: "PAP-42",
      companyId: "company-1",
      assigneeAgentId: "agent-context",
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-context",
      companyId: "company-1",
      status: "active",
      role: "engineer",
      createdAt: new Date("2026-03-01T10:00:00.000Z"),
    });
    mockIssueService.create.mockResolvedValueOnce({
      id: "issue-copilot-ctx",
      identifier: "PAP-901",
      title: "Board Copilot Thread",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-context",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      updatedAt: new Date("2026-04-12T10:00:00.000Z"),
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );

    const res = await request(app)
      .get("/api/companies/company-1/copilot/thread")
      .query({ contextIssueId: "PAP-42" });

    expect(res.status).toBe(200);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        originKind: "board_copilot_thread",
        originId: "user-1",
        assigneeAgentId: "agent-context",
      }),
    );
    expect(mockAgentService.list).not.toHaveBeenCalled();
  });

  it("creates a fresh board copilot thread when requested", async () => {
    const { db } = createDbMock({
      issueRows: [
        [
          {
            id: "issue-copilot-existing",
            identifier: "PAP-902",
            title: "Board Copilot Thread",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-existing",
            assigneeUserId: null,
            companyId: "company-1",
            originKind: "board_copilot_thread",
            originId: "user-1",
            updatedAt: new Date("2026-04-12T09:55:00.000Z"),
          },
        ],
        [],
      ],
    });
    mockIssueService.update.mockResolvedValueOnce({
      id: "issue-copilot-existing",
      identifier: "PAP-902",
      title: "Board Copilot Thread",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-existing",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      hiddenAt: new Date("2026-04-12T10:00:00.000Z"),
      updatedAt: new Date("2026-04-12T10:00:00.000Z"),
    });
    mockIssueService.create.mockResolvedValueOnce({
      id: "issue-copilot-new",
      identifier: "PAP-903",
      title: "Board Copilot Thread",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-fallback",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      updatedAt: new Date("2026-04-12T10:00:01.000Z"),
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );

    const res = await request(app)
      .post("/api/companies/company-1/copilot/thread/new")
      .send({ contextIssueId: "PAP-42" });

    expect(res.status).toBe(201);
    expect(res.body.issueId).toBe("issue-copilot-new");
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "issue-copilot-existing",
      expect.objectContaining({
        actorUserId: "user-1",
      }),
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        originKind: "board_copilot_thread",
        originId: "user-1",
      }),
    );
  });

  it("creates a fresh board copilot thread when no active thread exists", async () => {
    const { db } = createDbMock({
      issueRows: [[], []],
    });
    mockIssueService.create.mockResolvedValueOnce({
      id: "issue-copilot-new",
      identifier: "PAP-904",
      title: "Board Copilot Thread",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-fallback",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      updatedAt: new Date("2026-04-12T10:00:01.000Z"),
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );

    const res = await request(app).post("/api/companies/company-1/copilot/thread/new").send({});

    expect(res.status).toBe(201);
    expect(res.body.issueId).toBe("issue-copilot-new");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.create).toHaveBeenCalledTimes(1);
  });

  it("lists board copilot thread history including archived threads", async () => {
    const { db } = createDbMock({
      issueRows: [
        [
          {
            id: "issue-copilot-current",
            identifier: "PAP-904",
            title: "Board Copilot Thread",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-fallback",
            assigneeUserId: null,
            companyId: "company-1",
            originKind: "board_copilot_thread",
            originId: "user-1",
            updatedAt: new Date("2026-04-12T10:10:00.000Z"),
            hiddenAt: null,
          },
          {
            id: "issue-copilot-archived",
            identifier: "PAP-903",
            title: "Board Copilot Thread",
            status: "done",
            priority: "high",
            assigneeAgentId: "agent-fallback",
            assigneeUserId: null,
            companyId: "company-1",
            originKind: "board_copilot_thread",
            originId: "user-1",
            updatedAt: new Date("2026-04-11T08:00:00.000Z"),
            hiddenAt: new Date("2026-04-12T09:00:00.000Z"),
          },
        ],
      ],
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );

    const res = await request(app).get("/api/companies/company-1/copilot/threads").query({ limit: "5" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      issueId: "issue-copilot-current",
      hiddenAt: null,
    });
    expect(res.body[1]).toMatchObject({
      issueId: "issue-copilot-archived",
    });
    expect(typeof res.body[1]?.hiddenAt).toBe("string");
  });

  it("posts a contextual message and enqueues a high-priority dedicated wakeup", async () => {
    const { db } = createDbMock({
      issueRows: [
        [
          {
            id: "issue-copilot-1",
            identifier: "PAP-900",
            title: "Board Copilot Thread",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-fallback",
            assigneeUserId: null,
            companyId: "company-1",
            originKind: "board_copilot_thread",
            originId: "user-1",
            updatedAt: new Date("2026-04-12T10:00:00.000Z"),
          },
        ],
      ],
      commentRows: [[]],
    });
    mockIssueService.getById.mockResolvedValueOnce({
      id: "issue-copilot-1",
      identifier: "PAP-900",
      title: "Board Copilot Thread",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-fallback",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      updatedAt: new Date("2026-04-12T10:00:00.000Z"),
    });
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-fallback",
      companyId: "company-1",
      status: "active",
      role: "coo",
      createdAt: new Date("2026-04-01T10:00:00.000Z"),
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );

    const res = await request(app).post("/api/companies/company-1/copilot/thread/messages").send({
      body: "Please summarize blockers and cleanup this board section.",
      context: {
        pageKind: "issues",
        pagePath: "/issues/PAP-42",
        entityType: "issue",
        entityId: "PAP-42",
      },
    });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-copilot-1",
      expect.stringContaining("paperclip:board-copilot-context"),
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-fallback",
      expect.objectContaining({
        reason: "board_copilot_message",
        contextSnapshot: expect.objectContaining({
          taskKey: "board-copilot-thread:issue-copilot-1",
          priority: 100,
          wakeReason: "board_copilot_message",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          source: "board_copilot",
          originKind: "board_copilot_thread",
        }),
      }),
    );
  });

  it("preempts foreign live runs for the assignee before waking board copilot", async () => {
    const { db } = createDbMock({
      issueRows: [
        [
          {
            id: "issue-copilot-1",
            identifier: "PAP-900",
            title: "Board Copilot Thread",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-fallback",
            assigneeUserId: null,
            companyId: "company-1",
            originKind: "board_copilot_thread",
            originId: "user-1",
            updatedAt: new Date("2026-04-12T10:00:00.000Z"),
          },
        ],
      ],
      commentRows: [[]],
    });
    mockIssueService.getById.mockResolvedValueOnce({
      id: "issue-copilot-1",
      identifier: "PAP-900",
      title: "Board Copilot Thread",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-fallback",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      updatedAt: new Date("2026-04-12T10:00:00.000Z"),
    });
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-fallback",
      companyId: "company-1",
      status: "active",
      role: "coo",
      createdAt: new Date("2026-04-01T10:00:00.000Z"),
    });
    mockHeartbeatService.list.mockResolvedValueOnce([
      {
        id: "run-foreign",
        status: "running",
        agentId: "agent-fallback",
        companyId: "company-1",
        contextSnapshot: {
          issueId: "issue-other-9",
          taskKey: "issue:issue-other-9",
        },
      },
      {
        id: "run-copilot",
        status: "running",
        agentId: "agent-fallback",
        companyId: "company-1",
        contextSnapshot: {
          issueId: "issue-copilot-1",
          taskKey: "board-copilot-thread:issue-copilot-1",
        },
      },
    ]);
    mockHeartbeatService.cancelRun.mockResolvedValueOnce({
      id: "run-foreign",
      status: "cancelled",
      agentId: "agent-fallback",
      companyId: "company-1",
      contextSnapshot: {
        issueId: "issue-other-9",
      },
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );

    const res = await request(app).post("/api/companies/company-1/copilot/thread/messages").send({
      body: "Drop what you're doing and work this copilot request now.",
      context: {
        pageKind: "issues",
        pagePath: "/issues/PAP-42",
        entityType: "issue",
        entityId: "PAP-42",
      },
    });

    expect(res.status).toBe(201);
    expect(mockHeartbeatService.list).toHaveBeenCalledWith("company-1", "agent-fallback");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-foreign");
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-fallback",
      expect.objectContaining({
        payload: expect.objectContaining({
          interruptedRunIds: ["run-foreign"],
        }),
        contextSnapshot: expect.objectContaining({
          interruptedRunIds: ["run-foreign"],
          interruptedRunId: "run-foreign",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "board_copilot_preempt",
          issueId: "issue-copilot-1",
          interruptedRunId: "run-foreign",
        }),
      }),
    );
  });

  it("continues preempting other runs when one cancellation attempt fails", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { db } = createDbMock({
      issueRows: [
        [
          {
            id: "issue-copilot-1",
            identifier: "PAP-900",
            title: "Board Copilot Thread",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-fallback",
            assigneeUserId: null,
            companyId: "company-1",
            originKind: "board_copilot_thread",
            originId: "user-1",
            updatedAt: new Date("2026-04-12T10:00:00.000Z"),
          },
        ],
      ],
      commentRows: [[]],
    });
    mockIssueService.getById.mockResolvedValueOnce({
      id: "issue-copilot-1",
      identifier: "PAP-900",
      title: "Board Copilot Thread",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-fallback",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      updatedAt: new Date("2026-04-12T10:00:00.000Z"),
    });
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-fallback",
      companyId: "company-1",
      status: "active",
      role: "coo",
      createdAt: new Date("2026-04-01T10:00:00.000Z"),
    });
    mockHeartbeatService.list.mockResolvedValueOnce([
      {
        id: "run-foreign-1",
        status: "running",
        agentId: "agent-fallback",
        companyId: "company-1",
        contextSnapshot: {
          issueId: "issue-other-1",
          taskKey: "issue:issue-other-1",
        },
      },
      {
        id: "run-foreign-2",
        status: "queued",
        agentId: "agent-fallback",
        companyId: "company-1",
        contextSnapshot: {
          issueId: "issue-other-2",
          taskKey: "issue:issue-other-2",
        },
      },
    ]);
    mockHeartbeatService.cancelRun.mockRejectedValueOnce(new Error("unable to cancel run-foreign-1"));
    mockHeartbeatService.cancelRun.mockResolvedValueOnce({
      id: "run-foreign-2",
      status: "cancelled",
      agentId: "agent-fallback",
      companyId: "company-1",
      contextSnapshot: {
        issueId: "issue-other-2",
      },
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );

    const res = await request(app).post("/api/companies/company-1/copilot/thread/messages").send({
      body: "Do this immediately.",
      context: {
        pageKind: "issues",
        pagePath: "/issues/PAP-42",
        entityType: "issue",
        entityId: "PAP-42",
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.wakeup.warning).toBe("Failed to preempt one or more active runs before board copilot wakeup");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-fallback",
      expect.objectContaining({
        payload: expect.objectContaining({
          interruptedRunIds: ["run-foreign-2"],
          interruptedRunId: "run-foreign-2",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        entityId: "run-foreign-2",
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        entityId: "run-foreign-1",
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "issue-copilot-1",
        interruptedRunId: "run-foreign-1",
      }),
      "failed to preempt active run for board copilot",
    );
    warnSpy.mockRestore();
  });

  it("keeps an existing wakeable assignee stable on thread bootstrap", async () => {
    const { db } = createDbMock({
      issueRows: [
        [
          {
            id: "issue-copilot-existing",
            identifier: "PAP-902",
            title: "Board Copilot Thread",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-existing",
            assigneeUserId: null,
            companyId: "company-1",
            originKind: "board_copilot_thread",
            originId: "user-1",
            updatedAt: new Date("2026-04-12T10:00:00.000Z"),
          },
        ],
      ],
    });
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-existing",
      companyId: "company-1",
      status: "active",
      role: "cto",
      createdAt: new Date("2026-04-01T10:00:00.000Z"),
    });
    mockIssueService.getById.mockResolvedValueOnce({
      id: "issue-copilot-existing",
      identifier: "PAP-902",
      title: "Board Copilot Thread",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-existing",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      updatedAt: new Date("2026-04-12T10:00:00.000Z"),
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );

    const res = await request(app)
      .get("/api/companies/company-1/copilot/thread")
      .query({ contextIssueId: "PAP-42" });

    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe("agent-existing");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockAgentService.list).not.toHaveBeenCalled();
    expect(mockIssueService.getById).not.toHaveBeenCalledWith("PAP-42");
  });

  it("suppresses duplicate message posts in the short dedupe window", async () => {
    const context = {
      pageKind: "issues",
      pagePath: "/issues/PAP-42",
      entityType: "issue",
      entityId: "PAP-42",
    } as const;
    const body = "Please summarize blockers and cleanup this board section.";
    const persistedBody = `<!-- paperclip:board-copilot-context ${JSON.stringify(context)} -->\n\n${body}`;

    const { db } = createDbMock({
      issueRows: [
        [
          {
            id: "issue-copilot-1",
            identifier: "PAP-900",
            title: "Board Copilot Thread",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-fallback",
            assigneeUserId: null,
            companyId: "company-1",
            originKind: "board_copilot_thread",
            originId: "user-1",
            updatedAt: new Date("2026-04-12T10:00:00.000Z"),
          },
        ],
      ],
      commentRows: [
        [
          {
            id: "comment-duplicate",
            companyId: "company-1",
            issueId: "issue-copilot-1",
            authorAgentId: null,
            authorUserId: "user-1",
            body: persistedBody,
            createdAt: new Date("2026-04-12T10:01:00.000Z"),
            updatedAt: new Date("2026-04-12T10:01:00.000Z"),
          },
        ],
      ],
    });
    mockIssueService.getById.mockResolvedValueOnce({
      id: "issue-copilot-1",
      identifier: "PAP-900",
      title: "Board Copilot Thread",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-fallback",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      updatedAt: new Date("2026-04-12T10:00:00.000Z"),
    });
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-fallback",
      companyId: "company-1",
      status: "active",
      role: "coo",
      createdAt: new Date("2026-04-01T10:00:00.000Z"),
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );

    const res = await request(app).post("/api/companies/company-1/copilot/thread/messages").send({
      body,
      context,
    });

    expect(res.status).toBe(200);
    expect(res.body.wakeup).toEqual({
      enqueued: false,
      warning: "Duplicate message ignored",
    });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not reopen a closed thread when duplicate suppression triggers", async () => {
    const context = {
      pageKind: "issues",
      pagePath: "/issues/PAP-42",
      entityType: "issue",
      entityId: "PAP-42",
    } as const;
    const body = "Please summarize blockers and cleanup this board section.";
    const persistedBody = `<!-- paperclip:board-copilot-context ${JSON.stringify(context)} -->\n\n${body}`;

    const { db } = createDbMock({
      issueRows: [
        [
          {
            id: "issue-copilot-closed",
            identifier: "PAP-903",
            title: "Board Copilot Thread",
            status: "done",
            priority: "high",
            assigneeAgentId: "agent-fallback",
            assigneeUserId: null,
            companyId: "company-1",
            originKind: "board_copilot_thread",
            originId: "user-1",
            updatedAt: new Date("2026-04-12T10:00:00.000Z"),
          },
        ],
      ],
      commentRows: [
        [
          {
            id: "comment-duplicate",
            companyId: "company-1",
            issueId: "issue-copilot-closed",
            authorAgentId: null,
            authorUserId: "user-1",
            body: persistedBody,
            createdAt: new Date("2026-04-12T10:01:00.000Z"),
            updatedAt: new Date("2026-04-12T10:01:00.000Z"),
          },
        ],
      ],
    });
    mockIssueService.getById.mockResolvedValueOnce({
      id: "issue-copilot-closed",
      identifier: "PAP-903",
      title: "Board Copilot Thread",
      status: "done",
      priority: "high",
      assigneeAgentId: "agent-fallback",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      updatedAt: new Date("2026-04-12T10:00:00.000Z"),
    });
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-fallback",
      companyId: "company-1",
      status: "active",
      role: "coo",
      createdAt: new Date("2026-04-01T10:00:00.000Z"),
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );

    const res = await request(app).post("/api/companies/company-1/copilot/thread/messages").send({
      body,
      context,
    });

    expect(res.status).toBe(200);
    expect(res.body.wakeup).toEqual({
      enqueued: false,
      warning: "Duplicate message ignored",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("escapes context comment markers before persisting copilot messages", async () => {
    const context = {
      pageKind: "issues",
      pagePath: "/issues/PAP-42",
      entityType: "issue",
      entityId: "PAP-42",
      title: "Context with <!-- opener and --> closer",
    } as const;

    const { db } = createDbMock({
      issueRows: [
        [
          {
            id: "issue-copilot-1",
            identifier: "PAP-900",
            title: "Board Copilot Thread",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-fallback",
            assigneeUserId: null,
            companyId: "company-1",
            originKind: "board_copilot_thread",
            originId: "user-1",
            updatedAt: new Date("2026-04-12T10:00:00.000Z"),
          },
        ],
      ],
      commentRows: [[]],
    });
    mockIssueService.getById.mockResolvedValueOnce({
      id: "issue-copilot-1",
      identifier: "PAP-900",
      title: "Board Copilot Thread",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-fallback",
      assigneeUserId: null,
      companyId: "company-1",
      originKind: "board_copilot_thread",
      originId: "user-1",
      updatedAt: new Date("2026-04-12T10:00:00.000Z"),
    });
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-fallback",
      companyId: "company-1",
      status: "active",
      role: "coo",
      createdAt: new Date("2026-04-01T10:00:00.000Z"),
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );

    const res = await request(app).post("/api/companies/company-1/copilot/thread/messages").send({
      body: "Cleanup this board lane.",
      context,
    });

    expect(res.status).toBe(201);
    const persistedBody = mockIssueService.addComment.mock.calls[0]?.[1] as string | undefined;
    expect(persistedBody).toBeDefined();
    expect(persistedBody).toContain("<\\!--");
    expect(persistedBody).toContain("--\\>");
    expect(persistedBody?.indexOf("-->")).toBeGreaterThanOrEqual(0);
    expect(persistedBody?.indexOf("-->", (persistedBody?.indexOf("-->") ?? -1) + 3)).toBe(-1);
  });

  it("rejects oversized context filter maps", async () => {
    const { db } = createDbMock({});
    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      db,
    );
    const filters = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`k${index}`, `v${index}`]),
    );

    const res = await request(app).post("/api/companies/company-1/copilot/thread/messages").send({
      body: "Please summarize current blockers.",
      context: {
        pageKind: "issues",
        pagePath: "/issues",
        filters,
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects non-board actors from accessing the copilot thread endpoints", async () => {
    const { db } = createDbMock({});
    const app = createApp(
      {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      },
      db,
    );

    const res = await request(app).get("/api/companies/company-1/copilot/thread");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only board users");
  });
});
