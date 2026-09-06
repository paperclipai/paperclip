import { describe, expect, it, vi } from "vitest";
import {
  discordMarkdownRequiresAttachment,
  listDiscordBotChannels,
  verifyDiscordBot,
} from "./chat-discord.js";

const applicationId = "123456789012345678";
const guildId = "1457808928258658549";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchFixture(
  routes: Record<string, unknown | (() => Response)>,
): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.headers).toEqual({ authorization: "Bot discord-secret" });
    const url = new URL(String(input));
    const route = routes[url.pathname];
    if (route === undefined) return json({ message: "missing fixture" }, 404);
    return typeof route === "function" ? route() : json(route);
  }) as unknown as typeof globalThis.fetch;
}

describe("Discord bot validation and inventory", () => {
  it("measures the final Discord Markdown instead of raw source length", () => {
    expect(discordMarkdownRequiresAttachment("x".repeat(2_000))).toBe(false);
    expect(discordMarkdownRequiresAttachment("🙂".repeat(1_001))).toBe(true);
    // The Discord formatter expands each bare mention by two characters.
    expect(discordMarkdownRequiresAttachment("@a ".repeat(500))).toBe(true);
    expect(
      discordMarkdownRequiresAttachment(
        `\`\`\`ts\n${"const value = 1;\n".repeat(120)}\`\`\``,
      ),
    ).toBe(true);
  });

  it("binds the token, application, privileged intent, and server", async () => {
    const fetch = fetchFixture({
      "/api/v10/users/@me": {
        id: applicationId,
        username: "maya",
        global_name: "Maya",
        bot: true,
        avatar: "avatar-hash",
      },
      "/api/v10/oauth2/applications/@me": {
        id: applicationId,
        name: "Maya",
        flags: 1 << 18,
      },
      [`/api/v10/guilds/${guildId}`]: { id: guildId, name: "Clawd" },
    });

    await expect(
      verifyDiscordBot({
        applicationId,
        botToken: "discord-secret",
        fetch,
        guildId,
      }),
    ).resolves.toEqual({
      providerAccountId: guildId,
      providerAccountLabel: "Clawd",
      botExternalId: applicationId,
      botUsername: "maya",
      botLabel: "Maya",
      botAvatarUrl: `https://cdn.discordapp.com/avatars/${applicationId}/avatar-hash.png`,
    });
  });

  it("rejects an application mismatch and disabled Message Content intent", async () => {
    const base = {
      "/api/v10/users/@me": {
        id: applicationId,
        username: "maya",
        bot: true,
      },
      [`/api/v10/guilds/${guildId}`]: { id: guildId, name: "Clawd" },
    };
    await expect(
      verifyDiscordBot({
        applicationId,
        botToken: "discord-secret",
        fetch: fetchFixture({
          ...base,
          "/api/v10/oauth2/applications/@me": {
            id: "999999999999999999",
            flags: 1 << 18,
          },
        }),
        guildId,
      }),
    ).rejects.toThrow("Application ID does not match");
    await expect(
      verifyDiscordBot({
        applicationId,
        botToken: "discord-secret",
        fetch: fetchFixture({
          ...base,
          "/api/v10/oauth2/applications/@me": {
            id: applicationId,
            flags: 0,
          },
        }),
        guildId,
      }),
    ).rejects.toThrow("Message Content intent is not enabled");
  });

  it("discovers only text channels where the bot has the complete safe feature set", async () => {
    const requiredPermissions = "309237763136";
    const fetch = fetchFixture({
      [`/api/v10/guilds/${guildId}`]: { id: guildId, name: "Clawd" },
      [`/api/v10/guilds/${guildId}/members/@me`]: {
        roles: ["222222222222222222"],
        user: { id: applicationId },
      },
      [`/api/v10/guilds/${guildId}/roles`]: [
        { id: guildId, permissions: "0" },
        { id: "222222222222222222", permissions: requiredPermissions },
      ],
      [`/api/v10/guilds/${guildId}/channels`]: [
        {
          id: "333333333333333333",
          type: 0,
          name: "agent-lab",
          position: 2,
          permission_overwrites: [],
        },
        {
          id: "444444444444444444",
          type: 0,
          name: "blocked",
          position: 1,
          permission_overwrites: [
            { id: guildId, type: 0, deny: "2048", allow: "0" },
          ],
        },
        { id: "555555555555555555", type: 2, name: "voice" },
      ],
    });

    await expect(
      listDiscordBotChannels({
        botToken: "discord-secret",
        fetch,
        guildId,
      }),
    ).resolves.toEqual({
      provider: "discord",
      resources: [
        {
          providerResourceId: "333333333333333333",
          parentProviderResourceId: guildId,
          type: "channel",
          label: "#agent-lab",
          providerUrl: `https://discord.com/channels/${guildId}/333333333333333333`,
          metadata: { source: "provider_inventory" },
        },
      ],
    });
  });

  it("fails closed when no channel grants the full required permission set", async () => {
    const fetch = fetchFixture({
      [`/api/v10/guilds/${guildId}`]: { id: guildId, name: "Clawd" },
      [`/api/v10/guilds/${guildId}/members/@me`]: {
        roles: [],
        user: { id: applicationId },
      },
      [`/api/v10/guilds/${guildId}/roles`]: [
        { id: guildId, permissions: "1024" },
      ],
      [`/api/v10/guilds/${guildId}/channels`]: [
        { id: "333333333333333333", type: 0, name: "read-only" },
      ],
    });

    await expect(
      listDiscordBotChannels({
        botToken: "discord-secret",
        fetch,
        guildId,
      }),
    ).rejects.toThrow("Send Messages in Threads");
  });
});
