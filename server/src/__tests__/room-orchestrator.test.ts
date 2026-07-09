import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn());

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    wakeup: mockWakeup,
  }),
}));

describe("roomOrchestratorService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wakes the host agent with conference_room_mentioned and idempotency key", async () => {
    mockWakeup.mockResolvedValue({ id: "run-1", status: "queued" });
    const { roomOrchestratorService } = await import("../services/room-orchestrator.js");
    const svc = roomOrchestratorService({} as never);

    const result = await svc.wakeHost({
      companyId: "company-1",
      issueId: "issue-1",
      roomMessageId: "comment-1",
      commentId: "comment-1",
      body: "[@CEO](agent://agent-ceo) olá",
      targetAgentId: "agent-ceo",
      actor: { type: "user", id: "user-1" },
    });

    expect(result).toEqual({
      mode: "host_run",
      issueId: "issue-1",
      roomMessageId: "comment-1",
      commentId: "comment-1",
      hostAgentId: "agent-ceo",
      hostRunId: "run-1",
      status: "queued",
    });
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-ceo",
      expect.objectContaining({
        reason: "conference_room_mentioned",
        idempotencyKey: "room:comment-1:host",
        contextSnapshot: expect.objectContaining({
          wakeReason: "conference_room_mentioned",
          roomMessageId: "comment-1",
          source: "board_chat.mention",
        }),
      }),
    );
  });

  it("throws AGENT_NOT_INVOKABLE when wakeup returns null", async () => {
    mockWakeup.mockResolvedValue(null);
    const { AgentNotInvokableError, roomOrchestratorService } = await import(
      "../services/room-orchestrator.js"
    );
    const svc = roomOrchestratorService({} as never);

    await expect(
      svc.wakeHost({
        companyId: "company-1",
        issueId: "issue-1",
        roomMessageId: "comment-1",
        commentId: "comment-1",
        body: "hi",
        targetAgentId: "agent-ceo",
        actor: { type: "user", id: "user-1" },
      }),
    ).rejects.toBeInstanceOf(AgentNotInvokableError);
  });
});
