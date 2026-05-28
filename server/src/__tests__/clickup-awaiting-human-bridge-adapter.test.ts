import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  detectClickUpAwaitingHumanBridgeEvents: vi.fn(),
  addClickUpChatMessageReaction: vi.fn(async () => ({
    status: "sent",
    detail: "sent",
  })),
  deleteClickUpChatMessageReaction: vi.fn(async () => ({
    status: "sent",
    detail: "deleted",
  })),
  sendAwaitingHumanNotification: vi.fn(),
  logActivity: vi.fn(async () => {}),
}));

vi.mock("../services/clickup-awaiting-human-transport.js", () => ({
  detectClickUpAwaitingHumanBridgeEvents: mocks.detectClickUpAwaitingHumanBridgeEvents,
  addClickUpChatMessageReaction: mocks.addClickUpChatMessageReaction,
  deleteClickUpChatMessageReaction: mocks.deleteClickUpChatMessageReaction,
  sendAwaitingHumanNotification: mocks.sendAwaitingHumanNotification,
}));

vi.mock("../services/awaiting-human-settings.js", () => ({
  awaitingHumanSettingsService: () => ({
    resolveClickUpRuntimeConfig: async () => ({
      enabled: true,
      provider: "clickup",
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-1",
    }),
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

const { clickupAwaitingHumanBridgeAdapter } = await import("../services/clickup-awaiting-human-bridge-adapter.js");

afterEach(() => {
  vi.clearAllMocks();
});

function makeDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{
            companyId: "company-1",
            issueId: "issue-1",
            interactionId: "interaction-1",
          }]),
        })),
      })),
    })),
  } as unknown as Db;
}

describe("clickupAwaitingHumanBridgeAdapter", () => {
  it("adds a like reaction after a poll returns new events", async () => {
    mocks.detectClickUpAwaitingHumanBridgeEvents.mockResolvedValueOnce({
      status: "sent",
      detail: "ok",
      events: [
        {
          kind: "reply",
          externalEventId: "reply-1",
          externalMessageId: "message-42",
          body: "Please revise the summary.",
          metadata: { clickupReplyId: "reply-1" },
        },
      ],
    });

    const adapter = clickupAwaitingHumanBridgeAdapter(makeDb());
    const result = await adapter.poll({
      bridgeId: "bridge-1",
      externalMessageId: "message-42",
    });

    expect(result.status).toBe("ok");
    expect(result.events).toHaveLength(1);
    expect(mocks.detectClickUpAwaitingHumanBridgeEvents).toHaveBeenCalledWith(
      "message-42",
      expect.objectContaining({
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
      }),
    );
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "reply-1",
      "white_check_mark",
      expect.objectContaining({
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
      }),
    );
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorId: "clickup_approval_poller",
      action: "issue.awaiting_human.reply_reaction",
    }));
  });

  it("marks the main message as thinking on send and replaces it with a checkmark on close", async () => {
    mocks.sendAwaitingHumanNotification.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "message-1",
    });
    const adapter = clickupAwaitingHumanBridgeAdapter(makeDb());

    await adapter.send({
      bridgeId: "bridge-1",
      companyId: "company-1",
      issueId: "issue-1",
      interactionId: "interaction-1",
      agentId: "agent-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "Title",
        summary: "Summary",
        link: "https://bizbox.example/issues/1",
        cta: "Respond",
        labels: ["awaiting_human"],
      },
    });

    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "brain_is_thinking",
      expect.objectContaining({
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
      }),
    );

    await adapter.close({
      bridgeId: "bridge-1",
      externalMessageId: "message-1",
      outcome: "approved",
      reason: null,
    });

    expect(mocks.deleteClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "brain_is_thinking",
      expect.objectContaining({
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
      }),
    );
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "white_check_mark",
      expect.objectContaining({
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
      }),
    );
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorId: "clickup_approval_poller",
      action: "issue.awaiting_human.state_reaction",
    }));
  });

  it("uses only a white check mark reaction when close is rejected", async () => {
    mocks.sendAwaitingHumanNotification.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "message-1",
    });
    const adapter = clickupAwaitingHumanBridgeAdapter(makeDb());

    await adapter.send({
      bridgeId: "bridge-1",
      companyId: "company-1",
      issueId: "issue-1",
      interactionId: "interaction-1",
      agentId: "agent-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "Title",
        summary: "Summary",
        link: "https://bizbox.example/issues/1",
        cta: "Respond",
        labels: ["awaiting_human"],
      },
    });

    vi.clearAllMocks();

    await adapter.close({
      bridgeId: "bridge-1",
      externalMessageId: "message-1",
      outcome: "rejected",
      reason: "No",
    });

    expect(mocks.deleteClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "brain_is_thinking",
      expect.objectContaining({
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
      }),
    );
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "white_check_mark",
      expect.objectContaining({
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
      }),
    );
    expect(mocks.addClickUpChatMessageReaction).not.toHaveBeenCalledWith(
      "message-1",
      "thumbsdown",
      expect.anything(),
    );
  });

  it("uses an x reaction when close is failed", async () => {
    mocks.sendAwaitingHumanNotification.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "message-1",
    });
    const adapter = clickupAwaitingHumanBridgeAdapter(makeDb());

    await adapter.send({
      bridgeId: "bridge-1",
      companyId: "company-1",
      issueId: "issue-1",
      interactionId: "interaction-1",
      agentId: "agent-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "Title",
        summary: "Summary",
        link: "https://bizbox.example/issues/1",
        cta: "Respond",
        labels: ["awaiting_human"],
      },
    });

    vi.clearAllMocks();

    await adapter.close({
      bridgeId: "bridge-1",
      externalMessageId: "message-1",
      outcome: "failed",
      reason: "This operation was aborted",
    });

    expect(mocks.deleteClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "brain_is_thinking",
      expect.objectContaining({
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
      }),
    );
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "x",
      expect.objectContaining({
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
      }),
    );
    expect(mocks.addClickUpChatMessageReaction).not.toHaveBeenCalledWith(
      "message-1",
      "white_check_mark",
      expect.anything(),
    );
  });

  it("does not add a terminal reaction when close expires", async () => {
    mocks.sendAwaitingHumanNotification.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "message-1",
    });
    const adapter = clickupAwaitingHumanBridgeAdapter(makeDb());

    await adapter.send({
      bridgeId: "bridge-1",
      companyId: "company-1",
      issueId: "issue-1",
      interactionId: "interaction-1",
      agentId: "agent-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "Title",
        summary: "Summary",
        link: "https://bizbox.example/issues/1",
        cta: "Respond",
        labels: ["awaiting_human"],
      },
    });

    vi.clearAllMocks();

    await adapter.close({
      bridgeId: "bridge-1",
      externalMessageId: "message-1",
      outcome: "expired",
      reason: "Timed out",
    });

    expect(mocks.deleteClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "brain_is_thinking",
      expect.objectContaining({
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
      }),
    );
    expect(mocks.addClickUpChatMessageReaction).not.toHaveBeenCalled();
  });

  it("keeps external thread ids null when ClickUp omits them", async () => {
    mocks.sendAwaitingHumanNotification.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: null,
    });
    const adapter = clickupAwaitingHumanBridgeAdapter(makeDb());

    const result = await adapter.send({
      bridgeId: "bridge-1",
      companyId: "company-1",
      issueId: "issue-1",
      interactionId: "interaction-1",
      agentId: "agent-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "Title",
        summary: "Summary",
        link: "https://bizbox.example/issues/1",
        cta: "Respond",
        labels: ["awaiting_human"],
      },
    });

    expect(result.externalThreadId).toBeNull();
    expect(result.externalMessageId).toBeNull();
    expect(mocks.addClickUpChatMessageReaction).not.toHaveBeenCalled();
  });
});
