import { describe, expect, it } from "vitest";
import { parseChatProviderLifecycle } from "./chat-provider-lifecycle.js";

describe("chat provider lifecycle normalization", () => {
  it("tracks only the configured Slack bot's channel membership", () => {
    expect(
      parseChatProviderLifecycle({
        provider: "slack",
        botExternalId: "U-BOT",
        payload: {
          event_id: "Ev1",
          event: {
            type: "member_joined_channel",
            event_ts: "1725551000.125000",
            user: "U-BOT",
            channel: "C123",
            channel_type: "C",
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "resource",
        providerEventId: "Ev1",
        providerResourceId: "C123",
        availability: "available",
        providerOrder: { sequence: "1725551000.125000" },
      }),
    ]);
    expect(
      parseChatProviderLifecycle({
        provider: "slack",
        botExternalId: "U-BOT",
        payload: {
          event_id: "Ev2",
          event: {
            type: "member_left_channel",
            user: "U-SOMEONE-ELSE",
            channel: "C123",
          },
        },
      }),
    ).toEqual([]);
  });

  it("turns Slack uninstall and token revocation into endpoint effects", () => {
    for (const type of ["app_uninstalled", "tokens_revoked"]) {
      expect(
        parseChatProviderLifecycle({
          provider: "slack",
          payload: { event_id: `Ev-${type}`, event: { type } },
        }),
      ).toEqual([
        expect.objectContaining({
          kind: "endpoint",
          availability: "revoked",
          providerEventId: `Ev-${type}`,
        }),
      ]);
    }
  });

  it("turns each GitHub repository-selection callback into one canonical refresh", () => {
    const effects = parseChatProviderLifecycle({
      provider: "github",
      headers: {
        "x-github-event": "installation_repositories",
        "x-github-delivery": "gh-delivery-1",
      },
      payload: {
        action: "added",
        repositories_added: [
          {
            id: 101,
            name: "enabled",
            full_name: "paperclip/enabled",
            html_url: "https://github.com/paperclip/enabled",
          },
        ],
        repositories_removed: [
          {
            id: 202,
            name: "removed",
            full_name: "paperclip/removed",
          },
        ],
      },
    });
    expect(effects).toEqual([
      expect.objectContaining({
        kind: "endpoint",
        providerEventId: "gh-delivery-1",
        availability: "available",
        metadata: { repositoriesAdded: 1, repositoriesRemoved: 1 },
      }),
    ]);
  });

  it("distinguishes suspended and deleted GitHub installations", () => {
    expect(
      parseChatProviderLifecycle({
        provider: "github",
        headers: {
          "x-github-event": "installation",
          "x-github-delivery": "gh-suspended",
        },
        payload: { action: "suspend", installation: { id: 123 } },
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "endpoint",
        availability: "attention",
        metadata: { installationId: "123" },
      }),
    ]);
    expect(
      parseChatProviderLifecycle({
        provider: "github",
        headers: {
          "x-github-event": "installation",
          "x-github-delivery": "gh-deleted",
        },
        payload: { action: "deleted", installation: { id: 123 } },
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "endpoint",
        availability: "revoked",
      }),
    ]);
  });

  it("normalizes Teams installation add/remove for the chosen conversation", () => {
    const base = {
      type: "installationUpdate",
      id: "teams-event-1",
      timestamp: "2026-09-05T14:00:00.000Z",
      conversation: {
        id: "19:conversation@thread.tacv2;messageid=1729",
        isGroup: true,
      },
      channelData: {
        team: { id: "team-1", name: "Paperclip Test" },
        channel: { id: "channel-1", name: "Bots" },
      },
    };
    expect(
      parseChatProviderLifecycle({
        provider: "microsoft-teams",
        payload: { ...base, action: "add" },
      }),
    ).toEqual([
      expect.objectContaining({
        providerResourceId: "19:conversation@thread.tacv2",
        parentProviderResourceId: "team-1",
        resourceType: "channel",
        label: "Bots",
        availability: "available",
        providerOrder: { occurredAt: "2026-09-05T14:00:00.000Z" },
      }),
    ]);
    expect(
      parseChatProviderLifecycle({
        provider: "microsoft-teams",
        payload: { ...base, action: "remove" },
      }),
    ).toEqual([expect.objectContaining({ availability: "removed" })]);
  });

  it("uses Teams conversationType for personal and group lifecycle resources", () => {
    const personal = {
      type: "installationUpdate",
      id: "teams-personal-add",
      action: "add",
      conversation: {
        id: "a:personal-conversation",
        conversationType: "personal",
      },
    };
    expect(
      parseChatProviderLifecycle({
        provider: "microsoft-teams",
        payload: personal,
      }),
    ).toEqual([
      expect.objectContaining({
        providerResourceId: "a:personal-conversation",
        resourceType: "direct_message",
        availability: "available",
      }),
    ]);
    expect(
      parseChatProviderLifecycle({
        provider: "microsoft-teams",
        payload: {
          ...personal,
          id: "teams-personal-remove",
          action: "remove",
        },
      }),
    ).toEqual([
      expect.objectContaining({
        resourceType: "direct_message",
        availability: "removed",
      }),
    ]);

    expect(
      parseChatProviderLifecycle({
        provider: "microsoft-teams",
        botExternalId: "00000000-0000-4000-8000-000000000111",
        payload: {
          type: "conversationUpdate",
          id: "teams-group-membership",
          conversation: {
            id: "19:group-conversation@unq.gbl.spaces",
            conversationType: "group",
          },
          membersAdded: [{ id: "28:00000000-0000-4000-8000-000000000111" }],
        },
      }),
    ).toEqual([
      expect.objectContaining({
        providerResourceId: "19:group-conversation@unq.gbl.spaces",
        resourceType: "group_chat",
        availability: "available",
      }),
    ]);
  });

  it("normalizes Telegram bot membership without requesting chat_member", () => {
    const effect = parseChatProviderLifecycle({
      provider: "telegram",
      payload: {
        update_id: 44,
        my_chat_member: {
          chat: { id: -100123, type: "supergroup", title: "Agent Lab" },
          new_chat_member: { status: "administrator" },
        },
      },
    });
    expect(effect).toEqual([
      expect.objectContaining({
        providerEventId: "telegram:44",
        providerResourceId: "-100123",
        resourceType: "chat",
        label: "Agent Lab",
        availability: "available",
        providerOrder: { sequence: "44" },
      }),
    ]);

    expect(
      parseChatProviderLifecycle({
        provider: "telegram",
        payload: {
          update_id: 45,
          my_chat_member: {
            chat: { id: -100123, type: "supergroup", title: "Agent Lab" },
            new_chat_member: { status: "kicked" },
          },
        },
      }),
    ).toEqual([expect.objectContaining({ availability: "unavailable" })]);
  });
});
