import { describe, expect, it } from "vitest";
import { chatProviderConversationUrl } from "./chat-provider-links.js";

describe("chat provider conversation links", () => {
  it("links Slack and GitHub threads to their native conversation", () => {
    expect(
      chatProviderConversationUrl({
        provider: "slack",
        providerAccountId: "T123",
        threadId: "slack:C456:1712345678.000100",
        providerMessageId: "1712345678.000100",
      }),
    ).toBe(
      "https://app.slack.com/client/T123/C456/thread/C456-1712345678000100",
    );
    expect(
      chatProviderConversationUrl({
        provider: "github",
        threadId: "github:paperclipai/paperclip:issue:42",
        providerMessageId: "99",
      }),
    ).toBe(
      "https://github.com/paperclipai/paperclip/issues/42#issuecomment-99",
    );
    expect(
      chatProviderConversationUrl({
        provider: "github",
        threadId: "github:paperclipai/paperclip:43",
        providerMessageId: "100",
      }),
    ).toBe("https://github.com/paperclipai/paperclip/pull/43#issuecomment-100");
    expect(
      chatProviderConversationUrl({
        provider: "github",
        threadId: "github:paperclipai/paperclip:43:rc:101",
        providerMessageId: "102",
      }),
    ).toBe("https://github.com/paperclipai/paperclip/pull/43#discussion_r101");
  });

  it("links Teams channel threads and chats using verified activity IDs", () => {
    const channelId = "19:channel@thread.tacv2";
    const rootId = "1740000000000";
    const encodedConversation = Buffer.from(
      `${channelId};messageid=${rootId}`,
    ).toString("base64url");
    const encodedService = Buffer.from(
      "https://smba.trafficmanager.net/amer/",
    ).toString("base64url");
    const channelUrl = chatProviderConversationUrl({
      provider: "microsoft-teams",
      providerAccountId: "tenant-fallback",
      threadId: `teams:${encodedConversation}:${encodedService}:channel`,
      providerMessageId: rootId,
      raw: {
        channelData: {
          tenant: { id: "tenant-1" },
          team: { aadGroupId: "group-1", name: "Product" },
          channel: { id: channelId, name: "General" },
        },
      },
    });
    expect(channelUrl).toContain(
      `https://teams.microsoft.com/l/message/${encodeURIComponent(channelId)}/${rootId}`,
    );
    expect(channelUrl).toContain("tenantId=tenant-1");
    expect(channelUrl).toContain("groupId=group-1");
    expect(channelUrl).toContain(`parentMessageId=${rootId}`);

    const chatId = "19:chat@thread.v2";
    const encodedChat = Buffer.from(chatId).toString("base64url");
    expect(
      chatProviderConversationUrl({
        provider: "microsoft-teams",
        threadId: `teams:${encodedChat}:${encodedService}:groupChat`,
        providerMessageId: "175",
        raw: { id: "175" },
      }),
    ).toBe(
      `https://teams.microsoft.com/l/message/${encodeURIComponent(chatId)}/175?context=${encodeURIComponent(JSON.stringify({ contextType: "chat" }))}`,
    );
  });

  it("links Telegram public and private forum topics and falls back to the bot DM", () => {
    expect(
      chatProviderConversationUrl({
        provider: "telegram",
        threadId: "telegram:-100123456:77",
        providerMessageId: "88",
        raw: { message_id: 88, chat: { username: "paperclip_e2e" } },
      }),
    ).toBe("https://t.me/paperclip_e2e/77/88");
    expect(
      chatProviderConversationUrl({
        provider: "telegram",
        threadId: "telegram:-100123456:77",
        providerMessageId: "88",
      }),
    ).toBe("https://t.me/c/123456/77/88");
    expect(
      chatProviderConversationUrl({
        provider: "telegram",
        botUsername: "@MayaBot",
        threadId: "telegram:1234",
        providerMessageId: "9",
      }),
    ).toBe("https://t.me/MayaBot");
  });

  it("fails closed when a provider ID cannot produce a safe documented link", () => {
    expect(
      chatProviderConversationUrl({
        provider: "microsoft-teams",
        threadId: "teams:not-valid:also-not-valid:channel",
        providerMessageId: "1",
      }),
    ).toBeNull();
  });
});
