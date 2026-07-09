import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getById: vi.fn(),
}));

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
  });

  it("returns silent mode when no structured agent mentions are present", async () => {
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService({} as never);

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
    const svc = roomMessageService({} as never);

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

  it("throws FANOUT_NOT_ENABLED when multiple agents are mentioned", async () => {
    mockIssueService.findMentionedAgents.mockResolvedValue(["agent-ceo", "agent-dev"]);
    const { FanoutNotEnabledError, roomMessageService } = await import(
      "../services/room-message.js"
    );
    const svc = roomMessageService({} as never);

    await expect(
      svc.handle({
        companyId: "company-1",
        message: "[@CEO](agent://agent-ceo) [@Dev](agent://agent-dev)",
        actor: { userId: "user-1" },
      }),
    ).rejects.toBeInstanceOf(FanoutNotEnabledError);
  });

  it("creates a standing Board Operations issue when none exists", async () => {
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.create.mockResolvedValue({ id: "issue-new" });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    const { roomMessageService } = await import("../services/room-message.js");
    const svc = roomMessageService({} as never);

    const result = await svc.handle({
      companyId: "company-1",
      message: "hello",
      actor: { userId: "user-1" },
    });

    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ title: "Board Operations", status: "todo" }),
    );
    expect(result.issueId).toBe("issue-new");
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
    const svc = roomMessageService({} as never);

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
    const svc = roomMessageService({} as never);

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
    const svc = roomMessageService({} as never);

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
});
