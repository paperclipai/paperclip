import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getById: vi.fn(),
  getComment: vi.fn(),
}));

function chainableSelectResult(result: unknown) {
  const limit = vi.fn().mockResolvedValue(result);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy, limit });
  const from = vi.fn().mockReturnValue({ where, orderBy, limit });
  mockDb.select.mockReturnValue({ from });
  return { from, where, orderBy, limit };
}

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

describe("roomMessageService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([
      { id: "issue-1", title: "Board Operations", status: "todo" },
    ]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    chainableSelectResult([]);
  });

  it("returns silent mode when no structured agent mentions are present", async () => {
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    const result = await svc.handle({
      companyId: "company-1",
      message: "bom dia equipe",
      actor: { userId: "user-1" },
    });

    expect(result).toEqual({
      mode: "silent",
      issueId: "issue-1",
      commentId: "comment-1",
      roomMessageId: "comment-1",
    });
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-1",
      "bom dia equipe",
      { agentId: undefined, userId: "user-1", runId: undefined },
    );
  });

  it("returns adapter_wake_pending for a single structured mention", async () => {
    mockIssueService.findMentionedAgents.mockResolvedValue(["agent-ceo"]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    const result = await svc.handle({
      companyId: "company-1",
      message: "[@CEO](agent://agent-ceo) olá",
      actor: { userId: "user-1" },
    });

    expect(result).toEqual({
      mode: "adapter_wake_pending",
      issueId: "issue-1",
      commentId: "comment-1",
      roomMessageId: "comment-1",
      mentionedAgentIds: ["agent-ceo"],
    });
  });

  it("throws INVALID_MENTION when structured mention does not resolve", async () => {
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    const { InvalidMentionError, roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    await expect(
      svc.handle({
        companyId: "company-1",
        message: "[@Ghost](agent://missing-agent) olá",
        actor: { userId: "user-1" },
      }),
    ).rejects.toBeInstanceOf(InvalidMentionError);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("returns adapter_wake_pending with all mentioned agents for fan-out (2+)", async () => {
    mockIssueService.findMentionedAgents.mockResolvedValue(["agent-ceo", "agent-dev"]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    const result = await svc.handle({
      companyId: "company-1",
      message: "[@CEO](agent://agent-ceo) [@Dev](agent://agent-dev)",
      actor: { userId: "user-1" },
    });

    expect(result).toEqual({
      mode: "adapter_wake_pending",
      issueId: "issue-1",
      commentId: "comment-1",
      roomMessageId: "comment-1",
      mentionedAgentIds: ["agent-ceo", "agent-dev"],
    });
  });

  it("throws TOO_MANY_MENTIONS when more than 5 agents are mentioned", async () => {
    mockIssueService.findMentionedAgents.mockResolvedValue([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "a6",
    ]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    await expect(
      svc.handle({
        companyId: "company-1",
        message: "six mentions",
        actor: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_MENTIONS", max: 5 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("prepareMentionWake validates mentions without writing a comment", async () => {
    mockIssueService.findMentionedAgents.mockResolvedValue(["agent-ceo"]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    const prepared = await svc.prepareMentionWake({
      companyId: "company-1",
      message: "[@CEO](agent://agent-ceo) olá",
    });

    expect(prepared).toEqual({
      mode: "adapter_wake_pending",
      issueId: "issue-1",
      mentionedAgentIds: ["agent-ceo"],
    });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();

    const committed = await svc.commit({
      prepared,
      message: "[@CEO](agent://agent-ceo) olá",
      actor: { userId: "user-1" },
    });
    expect(committed.commentId).toBe("comment-1");
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
  });

  it("prepareMentionWake throws INVALID_MENTION without writing", async () => {
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    const { InvalidMentionError, roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    await expect(
      svc.prepareMentionWake({
        companyId: "company-1",
        message: "[@Ghost](agent://missing-agent) olá",
      }),
    ).rejects.toBeInstanceOf(InvalidMentionError);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("prepareMentionWake returns all mentioned agent ids for fan-out without writing", async () => {
    mockIssueService.findMentionedAgents.mockResolvedValue(["agent-ceo", "agent-dev"]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    const prepared = await svc.prepareMentionWake({
      companyId: "company-1",
      message: "[@CEO](agent://agent-ceo) [@Dev](agent://agent-dev)",
    });

    expect(prepared).toEqual({
      mode: "adapter_wake_pending",
      issueId: "issue-1",
      mentionedAgentIds: ["agent-ceo", "agent-dev"],
    });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("prepareMentionWake throws TOO_MANY_MENTIONS without writing", async () => {
    mockIssueService.findMentionedAgents.mockResolvedValue([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "a6",
    ]);
    const { TooManyMentionsError, roomMessageService } = await import(
      "../services/room-message.js"
    );
    const svc = roomMessageService(mockDb as never);

    await expect(
      svc.prepareMentionWake({
        companyId: "company-1",
        message: "six mentions",
      }),
    ).rejects.toBeInstanceOf(TooManyMentionsError);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("creates a standing Board Operations issue with conference_room origin when none exists", async () => {
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.create.mockResolvedValue({ id: "issue-new" });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    const result = await svc.handle({
      companyId: "company-1",
      message: "hello",
      actor: { userId: "user-1" },
    });

    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Board Operations",
        status: "todo",
        originKind: "conference_room",
        originId: "company-1",
      }),
    );
    expect(result.issueId).toBe("issue-new");
  });

  it("prefers originKind+originId lookup before title fallback", async () => {
    mockIssueService.list.mockImplementation(async (_companyId, filters) => {
      if (filters?.originKind === "conference_room") {
        return [{ id: "issue-origin", title: "Board Operations", status: "todo" }];
      }
      return [{ id: "issue-title", title: "Board Operations", status: "todo" }];
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    const result = await svc.handle({
      companyId: "company-1",
      message: "hello",
      actor: { userId: "user-1" },
    });

    expect(result.issueId).toBe("issue-origin");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("re-fetches existing issue when create races on duplicate title", async () => {
    mockIssueService.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "issue-raced", title: "Board Operations", status: "todo" },
      ]);
    mockIssueService.create.mockRejectedValue(new Error("duplicate title"));
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    const result = await svc.handle({
      companyId: "company-1",
      message: "hello",
      actor: { userId: "user-1" },
    });

    expect(result.issueId).toBe("issue-raced");
  });

  it("uses taskId when it belongs to the same company", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-other",
      companyId: "company-1",
      title: "Board Operations",
      status: "todo",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    const result = await svc.handle({
      companyId: "company-1",
      message: "hello",
      taskId: "issue-other",
      actor: { userId: "user-1" },
    });

    expect(mockIssueService.getById).toHaveBeenCalledWith("issue-other");
    expect(mockIssueService.list).not.toHaveBeenCalled();
    expect(result.issueId).toBe("issue-other");
  });

  it("rejects taskId from another company", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-other-co",
      companyId: "company-2",
      title: "Board Operations",
      status: "todo",
    });
    const { TaskCompanyMismatchError, roomMessageService } = await import(
      "../services/room-message.js"
    );
    const svc = roomMessageService(mockDb as never);

    await expect(
      svc.handle({
        companyId: "company-1",
        message: "hello",
        taskId: "issue-other-co",
        actor: { userId: "user-1" },
      }),
    ).rejects.toBeInstanceOf(TaskCompanyMismatchError);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects unknown taskId", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const { TaskNotFoundError, roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    await expect(
      svc.handle({
        companyId: "company-1",
        message: "hello",
        taskId: "missing-issue",
        actor: { userId: "user-1" },
      }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("returns silent turn status when comment exists without host run", async () => {
    mockIssueService.getComment.mockResolvedValue({
      id: "comment-1",
      issueId: "issue-1",
    });
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
    });
    chainableSelectResult([]);

    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    const result = await svc.getTurnStatus({
      companyId: "company-1",
      roomMessageId: "comment-1",
    });

    expect(result).toEqual({
      roomMessageId: "comment-1",
      issueId: "issue-1",
      commentId: "comment-1",
      status: "silent",
    });
  });

  it("returns host run status from contextSnapshot roomMessageId", async () => {
    mockIssueService.getComment.mockResolvedValue({
      id: "comment-2",
      issueId: "issue-1",
    });
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
    });
    chainableSelectResult([
      {
        id: "run-9",
        agentId: "agent-ceo",
        status: "queued",
        resultJson: { cost_usd: "0.42" },
      },
    ]);

    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    const result = await svc.getTurnStatus({
      companyId: "company-1",
      roomMessageId: "comment-2",
    });

    expect(result).toEqual({
      roomMessageId: "comment-2",
      issueId: "issue-1",
      commentId: "comment-2",
      hostRunId: "run-9",
      hostAgentId: "agent-ceo",
      status: "queued",
      costUsd: 0.42,
    });
  });

  it("throws TURN_NOT_FOUND when comment is missing", async () => {
    mockIssueService.getComment.mockResolvedValue(null);
    const { TurnNotFoundError, roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService(mockDb as never);

    await expect(
      svc.getTurnStatus({
        companyId: "company-1",
        roomMessageId: "missing-comment",
      }),
    ).rejects.toBeInstanceOf(TurnNotFoundError);
  });
});
