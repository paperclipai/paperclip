import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatSdkEndpointRuntime,
  type ChatSdkEndpointRuntime,
  type ChatSdkRuntimeCallbacks,
} from "./chat-sdk-runtime.js";
import type {
  ChatSdkStatePersistence,
  ChatSdkStateRecord,
} from "./chat-sdk-state.js";

interface WireClient {
  guilds: { _add(data: Record<string, unknown>): { id: string } };
  channels: {
    _add(data: Record<string, unknown>, guild?: { id: string }): unknown;
  };
  rest: {
    post(route: string, options: Record<string, unknown>): Promise<unknown>;
    patch(route: string, options: Record<string, unknown>): Promise<unknown>;
  };
  destroy(): Promise<void>;
}
interface WireInteraction {
  id: string;
  replied: boolean;
  deferred: boolean;
}
const discordJs = createRequire(import.meta.resolve("@chat-adapter/discord"))(
  "discord.js",
) as {
  Client: new (options: { intents: number[] }) => WireClient;
  ChatInputCommandInteraction: new (
    client: WireClient,
    data: Record<string, unknown>,
  ) => WireInteraction;
};
const applicationId = "123456789012345678";
const guildId = "1457808928258658549";
const channelId = "333333333333333333";
const threadId = "555555555555555610";
const userId = "444444444444444410";
const commandId = "888888888888888880";
let interactionSequence = 0n;
const freshInteractionId = (at = Date.now()) =>
  (((BigInt(at) - 1420070400000n) << 22n) + interactionSequence++).toString();
const token = "synthetic-private-discord-command-token";

function wire(overrides: Record<string, unknown> = {}) {
  return {
    id: freshInteractionId(),
    application_id: applicationId,
    type: 2,
    token,
    version: 1,
    context: 0,
    authorizing_integration_owners: { "0": guildId },
    guild_id: guildId,
    channel: { id: threadId, type: 11 },
    user: {
      id: userId,
      username: "operator",
      global_name: "Operator",
      discriminator: "0",
      avatar: null,
      bot: false,
    },
    locale: "en-US",
    guild_locale: "en-US",
    entitlements: [],
    data: {
      id: commandId,
      name: "paperclip",
      type: 1,
      options: [{ type: 1, name: "status" }],
    },
    ...overrides,
  };
}

// Actual installed discord.js -> adapter -> Chat SDK -> scoped callback. Only
// HTTP is simulated; this is not durable service admission or live Discord proof.
describe("Discord native command Gateway boundary", () => {
  const runtimes: ChatSdkEndpointRuntime[] = [];
  const clients: WireClient[] = [];
  afterEach(async () => {
    try {
      await Promise.all(
        runtimes.splice(0).map((runtime) => runtime.shutdown()),
      );
    } finally {
      try {
        await Promise.all(clients.splice(0).map((client) => client.destroy()));
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    }
  });

  async function setup(
    onSlashCommand: ChatSdkRuntimeCallbacks["onSlashCommand"],
  ) {
    const rows = new Map<string, ChatSdkStateRecord>();
    const persistence: ChatSdkStatePersistence = {
      async read(_scope, key) {
        return rows.get(key) ?? null;
      },
      async compareAndSet(input) {
        const previous = rows.get(input.key);
        if ((previous?.version ?? null) !== input.expectedVersion) return false;
        rows.set(input.key, {
          value: input.value,
          expiresAt: input.expiresAt,
          version: (previous?.version ?? 0) + 1,
        });
        return true;
      },
      async deleteIfVersion(input) {
        if (rows.get(input.key)?.version !== input.expectedVersion)
          return false;
        return rows.delete(input.key);
      },
    };
    const fetch = vi.fn(async () => {
      throw new Error("Network disabled");
    });
    vi.stubGlobal("fetch", fetch);
    const runtime = createChatSdkEndpointRuntime({
      companyId: "company-command",
      endpointId: "endpoint-command",
      callbacks: {
        onMessage() {},
        ...(onSlashCommand ? { onSlashCommand } : {}),
      },
      enableDiscordGateway: false,
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "discord",
        userName: "maya",
        credentials: {
          applicationId,
          guildId,
          botToken: "synthetic-bot-token",
        },
      },
    });
    runtimes.push(runtime);
    await runtime.initialize();
    const client = new discordJs.Client({ intents: [] });
    clients.push(client);
    const guild = client.guilds._add({
      id: guildId,
      name: "Fixture",
      unavailable: false,
    });
    client.channels._add(
      {
        id: threadId,
        type: 11,
        guild_id: guildId,
        parent_id: channelId,
        name: "task",
        thread_metadata: {
          archived: false,
          archive_timestamp: "2026-09-09T00:00:00.000Z",
          auto_archive_duration: 60,
          locked: false,
        },
      },
      guild,
    );
    client.channels._add({
      id: "333333333333333334",
      type: 1,
      recipients: [
        { id: userId, username: "operator", discriminator: "0", avatar: null },
      ],
    });
    const post = vi.spyOn(client.rest, "post").mockResolvedValue(undefined);
    const patch = vi.spyOn(client.rest, "patch").mockResolvedValue({
      id: "999999999999999999",
      channel_id: threadId,
      content: "Reply",
      author: {
        id: applicationId,
        username: "maya",
        discriminator: "0",
        avatar: null,
        bot: true,
      },
      timestamp: "2026-09-09T00:00:00.000Z",
      type: 0,
      attachments: [],
      embeds: [],
    });
    const adapter = runtime.getProviderAdapter() as unknown as {
      handleGatewayInteraction(interaction: WireInteraction): Promise<void>;
      postMessage(threadId: string, message: string): Promise<unknown>;
      discordFetch(
        path: string,
        method: string,
        body: unknown,
      ): Promise<Response>;
      requestContext: { getStore(): unknown };
    };
    const command = (overrides: Record<string, unknown> = {}) =>
      new discordJs.ChatInputCommandInteraction(client, wire(overrides));
    return { runtime, rows, adapter, post, patch, command, fetch };
  }

  it("awaits closed admission after an immediate private defer and retains exact no-argument command identity without token", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callback = vi.fn(
      async (
        input: Parameters<
          NonNullable<ChatSdkRuntimeCallbacks["onSlashCommand"]>
        >[0],
      ) => {
        await input.event.channel.setState({ nativeCommand: input.event.raw });
        await held;
        return { kind: "accepted" as const, content: "Task is running." };
      },
    );
    const f = await setup(callback);
    let completed = false;
    const command = f.command();
    const pending = f.adapter.handleGatewayInteraction(command).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    const earlyCompleted = completed;
    const earlyPost = f.post.mock.calls.map((call) => call[1]);
    release();
    await pending;
    expect(earlyCompleted).toBe(false);
    expect(earlyPost).toMatchObject([
      { body: { type: 5, data: { flags: 64 } } },
    ]);
    expect(f.patch).toHaveBeenCalledOnce();
    expect(f.patch.mock.calls[0]?.[1]).toMatchObject({
      body: { content: "Task is running.", allowed_mentions: { parse: [] } },
    });
    const event = callback.mock.calls[0]?.[0] as unknown as {
      transport: string;
      event: { command: string; text: string; raw: Record<string, unknown> };
    };
    expect(event).toMatchObject({
      endpointId: "endpoint-command",
      provider: "discord",
      transport: "discord_gateway",
      event: {
        command: "/paperclip status",
        text: "",
        channelId: `discord:${guildId}:${channelId}:${threadId}`,
        raw: {
          id: command.id,
          application_id: applicationId,
          data: {
            id: commandId,
            name: "paperclip",
            options: [{ type: 1, name: "status" }],
          },
        },
      },
    });
    expect(JSON.stringify(event.event.raw)).not.toContain(token);
    expect(f.rows.size).toBeGreaterThan(0);
    expect(JSON.stringify([...f.rows.values()])).not.toContain(token);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("does not turn a throwing callback into accepted text or a second initial response", async () => {
    const callback = vi.fn(async () => {
      throw new Error("sensitive-bootstrap-error");
    });
    const f = await setup(callback);
    await f.adapter.handleGatewayInteraction(f.command());
    expect(callback).toHaveBeenCalledOnce();
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.patch).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.patch.mock.calls)).toContain(
      "could not be confirmed",
    );
    expect(JSON.stringify(f.patch.mock.calls)).not.toContain(
      "sensitive-bootstrap-error",
    );
  });

  it("keeps a publication inside command handling on the ordinary bot route", async () => {
    let f: Awaited<ReturnType<typeof setup>>;
    const callback = vi.fn(async () => {
      expect(f.adapter.requestContext.getStore()).toBeUndefined();
      await f.adapter.postMessage(
        `discord:${guildId}:${channelId}:${threadId}`,
        "Durable task publication",
      );
      return { kind: "accepted", content: "Command recorded." };
    });
    f = await setup(
      callback as unknown as ChatSdkRuntimeCallbacks["onSlashCommand"],
    );
    const publicSend = vi
      .spyOn(f.adapter, "discordFetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "999999999999999999" })),
      );
    await f.adapter.handleGatewayInteraction(f.command());
    expect(publicSend).toHaveBeenCalledWith(
      `/channels/${threadId}/messages`,
      "POST",
      expect.objectContaining({ content: "Durable task publication" }),
    );
    expect(f.patch).toHaveBeenCalledOnce();
  });

  it.each(["new", "close"])(
    "normalizes the exact no-argument %s subcommand",
    async (name) => {
      const callback = vi.fn(async () => ({
        kind: "accepted" as const,
        content: "Recorded.",
      }));
      const f = await setup(callback);
      await f.adapter.handleGatewayInteraction(
        f.command({
          data: {
            id: commandId,
            name: "paperclip",
            type: 1,
            options: [{ name, type: 1, options: [] }],
          },
        }),
      );
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            command: `/paperclip ${name}`,
            text: "",
          }),
        }),
      );
      expect(f.patch).toHaveBeenCalledOnce();
    },
  );

  it("admits only the explicit guild-installed bot DM context without inventing a guild", async () => {
    const callback = vi.fn(async () => ({
      kind: "accepted" as const,
      content: "Recorded.",
    }));
    const f = await setup(callback);
    await f.adapter.handleGatewayInteraction(
      f.command({
        guild_id: undefined,
        channel: { id: "333333333333333334", type: 1 },
        context: 1,
        authorizing_integration_owners: { "0": "0" },
      }),
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          channelId: "discord:@me:333333333333333334",
          raw: expect.objectContaining({
            guild_id: "@me",
            context: 1,
            authorizing_integration_owners: { "0": "0" },
          }),
        }),
      }),
    );
  });

  it.each([
    ["foreign application", { application_id: "123456789012345679" }],
    ["foreign guild", { guild_id: "1457808928258658550" }],
    [
      "foreign install",
      { authorizing_integration_owners: { "0": "1457808928258658550" } },
    ],
    [
      "user install",
      { authorizing_integration_owners: { "0": guildId, "1": userId } },
    ],
    ["missing install", { authorizing_integration_owners: {} }],
    ["private context", { context: 2 }],
    ["missing context", { context: undefined }],
    [
      "unknown namespace",
      {
        data: {
          id: commandId,
          name: "customer",
          type: 1,
          options: [{ name: "status", type: 1 }],
        },
      },
    ],
    [
      "unknown subcommand",
      {
        data: {
          id: commandId,
          name: "paperclip",
          type: 1,
          options: [{ name: "delete", type: 1 }],
        },
      },
    ],
    [
      "argument value",
      {
        data: {
          id: commandId,
          name: "paperclip",
          type: 1,
          options: [{ name: "status", type: 3, value: "secret" }],
        },
      },
    ],
    [
      "nested options",
      {
        data: {
          id: commandId,
          name: "paperclip",
          type: 1,
          options: [
            {
              name: "status",
              type: 1,
              options: [{ name: "task", type: 3, value: "other" }],
            },
          ],
        },
      },
    ],
    [
      "multiple options",
      {
        data: {
          id: commandId,
          name: "paperclip",
          type: 1,
          options: [
            { name: "status", type: 1 },
            { name: "close", type: 1 },
          ],
        },
      },
    ],
    [
      "missing command identity",
      {
        data: {
          name: "paperclip",
          type: 1,
          options: [{ name: "status", type: 1 }],
        },
      },
    ],
  ])(
    "privately denies %s without calling scoped admission",
    async (_name, overrides) => {
      const callback = vi.fn(async () => ({
        kind: "accepted" as const,
        content: "Recorded.",
      }));
      const f = await setup(callback);
      await f.adapter.handleGatewayInteraction(
        f.command(overrides as Record<string, unknown>),
      );
      expect(callback).not.toHaveBeenCalled();
      expect(f.post).toHaveBeenCalledOnce();
      expect(f.patch).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.patch.mock.calls)).toContain(
        "not available here",
      );
    },
  );

  it.each([
    undefined,
    { kind: "accepted", content: "" },
    { kind: "accepted", content: "x".repeat(2001) },
    { kind: "accepted", content: "x", extra: true },
  ])("never accepts a missing or invalid completion %#", async (result) => {
    const callback = vi.fn(async () => result) as unknown as NonNullable<
      ChatSdkRuntimeCallbacks["onSlashCommand"]
    >;
    const f = await setup(callback);
    await f.adapter.handleGatewayInteraction(f.command());
    expect(JSON.stringify(f.patch.mock.calls)).toContain(
      "could not be confirmed",
    );
  });

  it("keeps a deliberate denial private with recovery guidance that also applies to linked users", async () => {
    const f = await setup(async () => ({ kind: "denied" }));
    await f.adapter.handleGatewayInteraction(f.command());
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.post.mock.calls[0]?.[1]).toMatchObject({
      body: { type: 5, data: { flags: 64 } },
    });
    expect(f.patch).toHaveBeenCalledOnce();
    expect(f.patch.mock.calls[0]?.[1]).toMatchObject({
      body: {
        content:
          "This command is not available here. Open the Paperclip task or ask an operator to check your chat access.",
        allowed_mentions: { parse: [] },
      },
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("does not replay the callback or any response after an ambiguous initial POST", async () => {
    const callback = vi.fn(async () => ({
      kind: "accepted" as const,
      content: "Recorded.",
    }));
    const f = await setup(callback);
    const command = f.command();
    f.post.mockRejectedValueOnce(new Error(`HTTP outcome unknown ${token}`));
    await f.adapter.handleGatewayInteraction(command);
    await f.adapter.handleGatewayInteraction(f.command({ id: command.id }));
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.patch).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("suppresses concurrent and completed duplicate IDs but admits a new interaction", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callback = vi.fn(async () => {
      await held;
      return { kind: "accepted" as const, content: "Recorded." };
    });
    const f = await setup(callback);
    const command = f.command();
    const pending = f.adapter.handleGatewayInteraction(command);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    await f.adapter.handleGatewayInteraction(f.command({ id: command.id }));
    release();
    await pending;
    await f.adapter.handleGatewayInteraction(f.command({ id: command.id }));
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.patch).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
    await f.adapter.handleGatewayInteraction(f.command());
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("never retries an uncertain private completion or repeats its committed callback", async () => {
    const callback = vi.fn(async () => ({
      kind: "accepted" as const,
      content: "Recorded.",
    }));
    const f = await setup(callback);
    const command = f.command();
    f.patch.mockRejectedValueOnce(new Error("lost completion"));
    await f.adapter.handleGatewayInteraction(command);
    await f.adapter.handleGatewayInteraction(f.command({ id: command.id }));
    expect(callback).toHaveBeenCalledOnce();
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.patch).toHaveBeenCalledOnce();
  });

  it("refuses to start an expired interaction even after its local dedupe entry could expire", async () => {
    const callback = vi.fn(async () => ({
      kind: "accepted" as const,
      content: "Recorded.",
    }));
    const f = await setup(callback);
    await f.adapter.handleGatewayInteraction(
      f.command({ id: freshInteractionId(Date.now() - 3000) }),
    );
    expect(callback).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.patch).not.toHaveBeenCalled();
  });

  it("keeps concurrent private completions attached to their own interaction", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callback: NonNullable<
      ChatSdkRuntimeCallbacks["onSlashCommand"]
    > = async ({ event }) => {
      if (event.command === "/paperclip status") await held;
      return { kind: "accepted", content: event.command };
    };
    const f = await setup(callback);
    const status = f.adapter.handleGatewayInteraction(
      f.command({ token: "private-status-token" }),
    );
    await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
    await f.adapter.handleGatewayInteraction(
      f.command({
        token: "private-close-token",
        data: {
          id: commandId,
          name: "paperclip",
          type: 1,
          options: [{ name: "close", type: 1 }],
        },
      }),
    );
    release();
    await status;
    expect(f.patch.mock.calls).toMatchObject([
      [
        expect.stringContaining("private-close-token"),
        { body: { content: "/paperclip close" } },
      ],
      [
        expect.stringContaining("private-status-token"),
        { body: { content: "/paperclip status" } },
      ],
    ]);
    expect(JSON.stringify([...f.rows.values()])).not.toContain("private-");
  });

  it("does not trust a forged transport marker through ordinary SDK dispatch", async () => {
    const callback = vi.fn(async () => ({
      kind: "accepted" as const,
      content: "Recorded.",
    }));
    const f = await setup(callback);
    const sdk = (
      f.runtime as unknown as {
        chat: {
          handleSlashCommandEvent(
            event: Record<string, unknown>,
          ): Promise<void>;
        };
      }
    ).chat;
    await sdk.handleSlashCommandEvent({
      command: "/paperclip status",
      text: "",
      adapter: f.adapter,
      channelId: `discord:${guildId}:${channelId}:${threadId}`,
      user: { userId, userName: "operator", isMe: false, isBot: false },
      raw: { ...wire(), transport: "discord_gateway" },
    });
    expect(callback).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.patch).not.toHaveBeenCalled();
  });
});
