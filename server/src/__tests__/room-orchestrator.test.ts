import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn());
const mockRedactSensitiveText = vi.hoisted(() =>
  vi.fn((input: string) => `sensitive-redacted:${input}`),
);
const mockRedactCurrentUserText = vi.hoisted(() =>
  vi.fn((input: string) => `user-redacted:${input}`),
);

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    wakeup: mockWakeup,
  }),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockResolvedValue({ censorUsernameInLogs: false }),
  }),
}));

vi.mock("../log-redaction.js", () => ({
  redactCurrentUserText: mockRedactCurrentUserText,
}));

vi.mock("../redaction.js", () => ({
  redactSensitiveText: mockRedactSensitiveText,
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
    expect(mockRedactCurrentUserText).toHaveBeenCalled();
    expect(mockRedactSensitiveText).toHaveBeenCalled();
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-ceo",
      expect.objectContaining({
        reason: "conference_room_mentioned",
        idempotencyKey: "room:comment-1:host",
        payload: expect.objectContaining({
          bodyPreview: "sensitive-redacted:user-redacted:[@CEO](agent://agent-ceo) olá",
        }),
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

  it("wakeMentionedAgents wakes each agent with per-agent idempotency keys", async () => {
    mockWakeup
      .mockResolvedValueOnce({ id: "run-a", status: "queued" })
      .mockResolvedValueOnce({ id: "run-b", status: "queued" });
    const { roomOrchestratorService } = await import("../services/room-orchestrator.js");
    const svc = roomOrchestratorService({} as never);

    const result = await svc.wakeMentionedAgents({
      companyId: "company-1",
      issueId: "issue-1",
      roomMessageId: "comment-fan",
      commentId: "comment-fan",
      body: "[@CEO](agent://agent-ceo) [@Dev](agent://agent-dev)",
      targetAgentIds: ["agent-ceo", "agent-dev"],
      actor: { type: "user", id: "user-1" },
    });

    expect(result).toEqual({
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
    expect(mockWakeup).toHaveBeenNthCalledWith(
      1,
      "agent-ceo",
      expect.objectContaining({
        idempotencyKey: "room:comment-fan:agent:agent-ceo",
      }),
    );
    expect(mockWakeup).toHaveBeenNthCalledWith(
      2,
      "agent-dev",
      expect.objectContaining({
        idempotencyKey: "room:comment-fan:agent:agent-dev",
      }),
    );
  });
});
