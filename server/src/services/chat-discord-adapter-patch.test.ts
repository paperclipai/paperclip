import { createDiscordAdapter } from "@chat-adapter/discord";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyChatPublicationError } from "./chat-publication-errors.js";

type GatewayHandler = (...args: unknown[]) => Promise<void> | void;

function gatewayMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    channelId: "thread-1",
    guildId: "1457808928258658549",
    partial: false,
    content: "updated content",
    attachments: new Map(),
    messageSnapshots: new Map(),
    channel: { isThread: () => true, parentId: "channel-1" },
    author: {
      id: "user-1",
      username: "ada",
      displayName: "Ada",
      bot: false,
    },
    createdAt: new Date("2026-09-06T12:00:00.000Z"),
    editedAt: new Date("2026-09-06T12:01:00.000Z"),
    ...overrides,
  };
}

function gatewayComponent(overrides: Record<string, unknown> = {}) {
  return {
    applicationId: "123456789012345678",
    channel: { id: "thread-1", parentId: "channel-1", type: 11 },
    channelId: "thread-1",
    customId: "approve\nyes",
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    guildId: "1457808928258658549",
    id: "interaction-1",
    isChatInputCommand: () => false,
    isMessageComponent: () => true,
    message: { id: "message-2" },
    reply: vi.fn().mockResolvedValue(undefined),
    token: "interaction-token",
    type: 3,
    user: {
      id: "user-1",
      username: "ada",
      globalName: "Ada",
      bot: false,
    },
    values: ["yes"],
    version: 1,
    ...overrides,
  };
}

function harness(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, GatewayHandler>();
  const ws = {
    handlePacket(packet: unknown) {
      const record = packet as {
        t?: string;
        testReaction?: unknown;
        testUser?: unknown;
      };
      const event =
        record.t === "MESSAGE_REACTION_ADD"
          ? "messageReactionAdd"
          : record.t === "MESSAGE_REACTION_REMOVE"
            ? "messageReactionRemove"
            : undefined;
      if (!event || !record.testReaction || !record.testUser) return false;
      return handlers.get(event)?.(record.testReaction, record.testUser);
    },
  };
  const client = {
    user: { id: "123456789012345678" },
    ws,
    on(event: string, handler: GatewayHandler) {
      handlers.set(event, handler);
      return this;
    },
  };
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const adapter = createDiscordAdapter({
    applicationId: "123456789012345678",
    botToken: "discord-token",
    logger,
    webhookVerifier: async () => false,
    ...config,
  } as never);
  const chat = {
    handleActionEvent: vi.fn(),
    handleIncomingMessage: vi.fn(),
    handleReactionEvent: vi.fn(),
    processMessageDeleted: vi.fn(),
    processMessageUpdated: vi.fn(),
    processSlashCommand: vi.fn(),
  };
  return { adapter, chat, client, handlers, logger };
}

describe("Paperclip Discord adapter patch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("explicitly clears Discord buttons when editing a terminal card", () => {
    const { adapter } = harness();
    const buildMessagePayload = (
      adapter as unknown as {
        buildMessagePayload(
          message: unknown,
          options?: { clearContentForCard?: boolean },
        ): { payload: Record<string, unknown> };
      }
    ).buildMessagePayload.bind(adapter);
    const terminalCard = {
      card: {
        children: [],
        title: "Choose a color",
        type: "card",
      },
    };

    expect(buildMessagePayload(terminalCard).payload).not.toHaveProperty(
      "components",
    );
    expect(
      buildMessagePayload(terminalCard, { clearContentForCard: true }).payload,
    ).toMatchObject({ components: [] });
  });

  it("names root-mention threads from the request without the bot mention", () => {
    const { adapter } = harness();
    const gatewayThreadName = (
      adapter as unknown as { gatewayThreadName(content: string): string }
    ).gatewayThreadName.bind(adapter);

    expect(
      gatewayThreadName(
        "<@123456789012345678> Investigate the checkout race condition",
      ),
    ).toBe("Investigate the checkout race condition");
    expect(gatewayThreadName("<@123456789012345678>")).toBe("Task with bot");
    expect(Array.from(gatewayThreadName("x".repeat(150)))).toHaveLength(100);
  });

  it("normalizes direct-message interactions into the fail-closed DM scope", () => {
    const { adapter } = harness();
    const normalized = (
      adapter as unknown as {
        normalizeGatewayComponentInteraction(
          interaction: Record<string, unknown>,
        ): Record<string, unknown>;
      }
    ).normalizeGatewayComponentInteraction({
      applicationId: "123456789012345678",
      channel: { id: "dm-1", parentId: null, type: 1 },
      channelId: "dm-1",
      customId: "approve",
      guildId: null,
      id: "interaction-1",
      message: { id: "message-1" },
      token: "interaction-token",
      type: 3,
      user: {
        id: "user-1",
        username: "ada",
        globalName: "Ada",
        bot: false,
      },
      version: 1,
    });

    expect(normalized.guild_id).toBe("@me");
  });

  it("delivers Gateway message edits with the canonical Discord thread", async () => {
    const { adapter, chat, client, handlers } = harness();
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const previous = gatewayMessage({
      content: "original content",
      editedAt: null,
    });
    const next = gatewayMessage();
    await handlers.get("messageUpdate")?.(previous, next);

    expect(chat.processMessageUpdated).toHaveBeenCalledTimes(1);
    expect(chat.processMessageUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter,
        threadId: "discord:1457808928258658549:channel-1:thread-1",
        message: expect.objectContaining({
          id: "message-1",
          text: "updated content",
        }),
        previousMessage: expect.objectContaining({
          id: "message-1",
          text: "original content",
        }),
      }),
    );
  });

  it("honors rate limits while fetching a partial Gateway message edit", async () => {
    vi.useFakeTimers();
    const { adapter, chat, client, handlers, logger } = harness();
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const complete = gatewayMessage();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce({ retryAfter: 2 })
      .mockResolvedValueOnce(complete);
    const handling = handlers.get("messageUpdate")?.(
      gatewayMessage({ content: "original", editedAt: null }),
      gatewayMessage({ partial: true, fetch }),
    );

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await handling;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(chat.processMessageUpdated).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Retrying Discord Gateway event after processing error",
      expect.objectContaining({
        event: "message_update_fetch",
        messageId: "message-1",
        retryAfterMs: 2_000,
      }),
    );
  });

  it.each(["thread", "pin", "embed", "reaction", "url", "timestamp"])(
    "ignores a Discord %s-only update with a complete unchanged source snapshot",
    async (kind) => {
      const { adapter, chat, client, handlers } = harness();
      await adapter.initialize(chat as never);
      (
        adapter as unknown as {
          setupLegacyGatewayHandlers(
            client: unknown,
            closing: () => boolean,
          ): void;
        }
      ).setupLegacyGatewayHandlers(client, () => false);
      const file = {
        id: "file-1",
        name: "source.png",
        contentType: "image/png",
        size: 123,
        url: "https://cdn.discordapp.com/attachments/channel/file/source.png?ex=old",
      };
      const previous = gatewayMessage({
        content: "unchanged request",
        editedAt: null,
        attachments: new Map([[file.id, file]]),
      });
      const next = gatewayMessage({
        ...previous,
        ...(kind === "thread"
          ? { flags: 32, thread: { id: previous.id } }
          : {}),
        ...(kind === "pin" ? { pinned: true } : {}),
        ...(kind === "embed" ? { embeds: [{ title: "Fetched preview" }] } : {}),
        ...(kind === "reaction" ? { reactions: new Map([["eyes", 1]]) } : {}),
        ...(kind === "url"
          ? {
              attachments: new Map([
                [
                  file.id,
                  {
                    ...file,
                    url: "https://cdn.discordapp.com/attachments/channel/file/source.png?ex=renewed",
                  },
                ],
              ]),
            }
          : {}),
        ...(kind === "timestamp"
          ? { editedAt: new Date("2026-09-06T12:02:00Z") }
          : {}),
      });
      await handlers.get("messageUpdate")?.(previous, next);
      expect(chat.processMessageUpdated).not.toHaveBeenCalled();
      expect(chat.handleIncomingMessage).not.toHaveBeenCalled();
      expect(chat.processMessageDeleted).not.toHaveBeenCalled();
    },
  );

  it.each([
    "text",
    "file_add",
    "file_remove",
    "file_id",
    "file_name",
    "file_type",
    "file_size",
    "file_order",
    "forwarded_text",
    "forwarded_file",
    "partial_previous",
    "unknown_previous",
    "different_message",
    "different_channel",
    "different_guild",
  ])(
    "preserves a Discord %s update even when editedAt is unchanged",
    async (kind) => {
      const { adapter, chat, client, handlers } = harness();
      await adapter.initialize(chat as never);
      (
        adapter as unknown as {
          setupLegacyGatewayHandlers(
            client: unknown,
            closing: () => boolean,
          ): void;
        }
      ).setupLegacyGatewayHandlers(client, () => false);
      const file = {
        id: "file-1",
        name: "source.txt",
        contentType: "text/plain",
        size: 123,
        url: "https://cdn.discordapp.com/attachments/channel/file/source.txt?ex=SECRET",
      };
      const second = { ...file, id: "file-2" };
      const previous = gatewayMessage({
        content: "unchanged request",
        editedAt: null,
        attachments: new Map([
          [file.id, file],
          [second.id, second],
        ]),
      });
      const next = gatewayMessage({ ...previous });
      if (kind === "text") next.content = "actual edit";
      if (kind === "file_add")
        next.attachments = new Map([
          ...previous.attachments,
          ["file-3", { ...file, id: "file-3" }],
        ]);
      if (kind === "file_remove") next.attachments = new Map();
      if (kind === "file_order")
        next.attachments = new Map([
          [second.id, second],
          [file.id, file],
        ]);
      for (const [testKind, key, value] of [
        ["file_id", "id", "replacement"],
        ["file_name", "name", "renamed.txt"],
        ["file_type", "contentType", "application/pdf"],
        ["file_size", "size", 124],
      ] as const) {
        if (kind === testKind)
          next.attachments = new Map([
            [file.id, { ...file, [key]: value }],
            [second.id, second],
          ]);
      }
      if (kind === "forwarded_text")
        next.messageSnapshots = new Map([
          [
            "forward",
            { content: "new forwarded request", attachments: new Map() },
          ],
        ]);
      if (kind === "forwarded_file")
        next.messageSnapshots = new Map([
          ["forward", { content: "", attachments: new Map([[file.id, file]]) }],
        ]);
      if (kind === "partial_previous") previous.partial = true;
      if (kind === "unknown_previous")
        Object.assign(previous, { partial: undefined });
      if (kind === "different_message") previous.id = "other-message";
      if (kind === "different_channel") previous.channelId = "other-channel";
      if (kind === "different_guild") previous.guildId = "other-guild";
      await handlers.get("messageUpdate")?.(previous, next);
      expect(chat.processMessageUpdated).toHaveBeenCalledTimes(1);
      const delivered = chat.processMessageUpdated.mock.calls[0]![0] as {
        message: { raw: Record<string, unknown> };
      };
      expect(delivered.message.raw.attachments).toBeInstanceOf(Array);
      expect(JSON.stringify(delivered.message.raw)).not.toContain("SECRET");
      expect(JSON.stringify(delivered.message.raw)).not.toContain(
        "cdn.discordapp.com",
      );
    },
  );

  it("reconstructs the created thread for root-message edits and deletes", async () => {
    const { adapter, chat, client, handlers } = harness();
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const previous = gatewayMessage({
      id: "root-message-1",
      channelId: "channel-1",
      channel: { isThread: () => false, parentId: null },
      content: "original root request",
      editedAt: null,
    });
    const next = gatewayMessage({
      id: "root-message-1",
      channelId: "channel-1",
      channel: { isThread: () => false, parentId: null },
      content: "updated root request",
    });
    await handlers.get("messageUpdate")?.(previous, next);
    await handlers.get("messageDelete")?.(next);

    const expectedThreadId =
      "discord:1457808928258658549:channel-1:root-message-1";
    expect(chat.processMessageUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: expectedThreadId }),
    );
    expect(chat.processMessageDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "root-message-1",
        threadId: expectedThreadId,
      }),
    );
  });

  it("keeps direct-message edits on the linear DM conversation", () => {
    const { adapter } = harness();
    const threadId = (
      adapter as unknown as {
        gatewayThreadId(message: unknown): string;
      }
    ).gatewayThreadId(
      gatewayMessage({
        guildId: null,
        channelId: "dm-1",
        channel: { isThread: () => false, parentId: null },
      }),
    );

    expect(threadId).toBe("discord:@me:dm-1");
  });

  it("never logs inbound message content before Paperclip admission", async () => {
    const { adapter, chat, client, handlers, logger } = harness();
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const sensitiveContent = "private content from a disabled destination";
    await handlers.get("messageCreate")?.(
      gatewayMessage({
        channelId: "disabled-channel",
        channel: { isThread: () => false, parentId: null },
        content: sensitiveContent,
        mentions: { has: () => false, roles: [], everyone: false },
      }),
    );

    const receiptLog = logger.info.mock.calls.find(
      ([message]) => message === "Discord Gateway message received",
    );
    expect(receiptLog?.[1]).toEqual(
      expect.objectContaining({
        channelId: "disabled-channel",
        guildId: "1457808928258658549",
        authorId: "user-1",
        isMentioned: false,
      }),
    );
    expect(receiptLog?.[1]).not.toHaveProperty("content");
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
      sensitiveContent,
    );
  });

  it("keeps Discord content, tokens, and raw provider errors out of every log level", async () => {
    vi.useFakeTimers();
    const { adapter, chat, logger } = harness({
      publicKey: "a".repeat(64),
      webhookVerifier: undefined,
    });
    const sensitiveContent = "private roadmap and customer names";
    const sensitiveToken = "discord-token";
    const providerBody = JSON.stringify({
      code: 50035,
      message: `${sensitiveContent} ${sensitiveToken}`,
      retry_after: 120,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "message-1", name: sensitiveContent }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(providerBody, {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "120",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(providerBody, {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(
        new TypeError(
          `Failed to fetch https://discord.com/api/v10/webhooks/app/${sensitiveToken}`,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await adapter.initialize(chat as never);

    await (
      adapter as unknown as {
        verifySignature(
          body: Uint8Array,
          signature: string,
          timestamp: string,
        ): Promise<boolean>;
      }
    ).verifySignature(
      new TextEncoder().encode(sensitiveContent),
      "0".repeat(128),
      "1777777777",
    );
    await (
      adapter as unknown as {
        handleComponentInteraction(
          interaction: Record<string, unknown>,
        ): Promise<void>;
      }
    ).handleComponentInteraction({
      application_id: "123456789012345678",
      channel: { id: "thread-1", parent_id: "channel-1", type: 11 },
      channel_id: "thread-1",
      data: { custom_id: `answer\n${sensitiveContent}` },
      guild_id: "1457808928258658549",
      id: "interaction-1",
      message: { id: "message-1" },
      token: sensitiveToken,
      type: 3,
      user: { id: "user-1", username: "ada" },
      version: 1,
    });
    (
      adapter as unknown as {
        handleApplicationCommandInteraction(
          context: Record<string, unknown>,
        ): void;
      }
    ).handleApplicationCommandInteraction({
      channelId: "discord:1457808928258658549:channel-1:thread-1",
      command: "task",
      interaction: { token: sensitiveToken },
      text: sensitiveContent,
      user: { id: "user-1", username: "ada" },
    });

    await (
      adapter as unknown as {
        createDiscordThread(
          channelId: string,
          messageId: string,
          requestedName: string,
        ): Promise<unknown>;
      }
    ).createDiscordThread("channel-1", "message-1", sensitiveContent);
    const error = await (
      adapter as unknown as {
        discordFetch(path: string, method: string): Promise<Response>;
      }
    )
      .discordFetch("/channels/channel-1/messages", "POST")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "NetworkError",
      retryAfter: 120,
      status: 429,
      originalError: { code: 50035, status: 429 },
    });
    expect(String(error)).not.toContain(sensitiveContent);
    expect(String(error)).not.toContain(sensitiveToken);
    expect(
      String((error as { originalError?: unknown }).originalError),
    ).not.toContain(sensitiveContent);
    const interactionError = await (
      adapter as unknown as {
        discordInteractionFetch(
          path: string,
          method: string,
        ): Promise<Response>;
      }
    )
      .discordInteractionFetch(
        `/webhooks/123456789012345678/${sensitiveToken}`,
        "POST",
      )
      .catch((caught: unknown) => caught);
    expect(interactionError).toMatchObject({
      name: "NetworkError",
      status: 403,
    });
    const interactionNetworkError = await (
      adapter as unknown as {
        discordInteractionFetch(
          path: string,
          method: string,
        ): Promise<Response>;
      }
    )
      .discordInteractionFetch(
        `/webhooks/123456789012345678/${sensitiveToken}`,
        "POST",
      )
      .catch((caught: unknown) => caught);
    expect(interactionNetworkError).toMatchObject({
      name: "NetworkError",
      originalError: undefined,
    });
    expect(String(interactionNetworkError)).not.toContain(sensitiveToken);

    const processing = (
      adapter as unknown as {
        processGatewayWithRetry(
          operation: () => Promise<void>,
          context: Record<string, unknown>,
        ): Promise<boolean>;
      }
    ).processGatewayWithRetry(
      async () => {
        throw Object.assign(
          new Error(`${sensitiveContent} ${sensitiveToken}`),
          {
            code: sensitiveToken,
            name: sensitiveContent,
          },
        );
      },
      { event: "privacy_test", messageId: "message-1" },
    );
    await vi.advanceTimersByTimeAsync(600);
    await expect(processing).resolves.toBe(false);

    const serializedLogs = JSON.stringify([
      ...logger.debug.mock.calls,
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(sensitiveContent);
    expect(serializedLogs).not.toContain(sensitiveToken);
    expect(serializedLogs).not.toContain(providerBody);
    expect(logger.error).toHaveBeenCalledWith(
      "Discord API error",
      expect.objectContaining({
        error: { code: 50035, retryAfter: 120, status: 429 },
      }),
    );
  });

  it("delivers partial Gateway deletes without inventing deleted content", async () => {
    const { adapter, chat, client, handlers } = harness();
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    await handlers.get("messageDelete")?.(
      gatewayMessage({ partial: true, author: null }),
    );

    expect(chat.processMessageDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter,
        channelId: "discord:1457808928258658549:channel-1",
        messageId: "message-1",
        platform: "discord",
        previousMessage: undefined,
        threadId: "discord:1457808928258658549:channel-1:thread-1",
        raw: {
          id: "message-1",
          channel_id: "thread-1",
          guild_id: "1457808928258658549",
        },
      }),
    );
  });

  it("retries a transient durable-ingress failure without recreating the thread", async () => {
    const { adapter, chat, logger } = harness();
    chat.handleIncomingMessage
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);
    await adapter.initialize(chat as never);

    await (
      adapter as unknown as {
        handleGatewayMessage(
          message: unknown,
          mentioned: boolean,
        ): Promise<void>;
      }
    ).handleGatewayMessage(
      gatewayMessage({
        channelId: "thread-1",
        channel: { isThread: () => true, parentId: "channel-1" },
      }),
      false,
    );

    expect(chat.handleIncomingMessage).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "Retrying Discord Gateway event after processing error",
      expect.objectContaining({ event: "message", messageId: "message-1" }),
    );
  });

  it("fails closed when a root-mention thread cannot be created", async () => {
    const { adapter, chat, logger } = harness();
    await adapter.initialize(chat as never);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          Response.json(
            { code: 10003, message: "Unknown Channel" },
            { status: 404 },
          ),
        ),
    );
    const createDiscordThread = vi
      .spyOn(
        adapter as unknown as {
          createDiscordThread: (...args: unknown[]) => Promise<unknown>;
        },
        "createDiscordThread",
      )
      .mockRejectedValue(new Error("Discord unavailable"));

    await (
      adapter as unknown as {
        handleGatewayMessage(
          message: unknown,
          mentioned: boolean,
        ): Promise<void>;
      }
    ).handleGatewayMessage(
      gatewayMessage({
        channelId: "channel-1",
        channel: { isThread: () => false, parentId: null },
        content: "<@123456789012345678> investigate the race",
      }),
      true,
    );

    expect(createDiscordThread).toHaveBeenCalledTimes(3);
    expect(chat.handleIncomingMessage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Discord Gateway event processing failed",
      expect.objectContaining({
        attempts: 3,
        event: "thread_create",
        messageId: "message-1",
      }),
    );
  });

  it("retries root-mention thread creation without creating a channel-level task", async () => {
    const { adapter, chat } = harness();
    await adapter.initialize(chat as never);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          Response.json(
            { code: 10003, message: "Unknown Channel" },
            { status: 404 },
          ),
        ),
    );
    const createDiscordThread = vi
      .spyOn(
        adapter as unknown as {
          createDiscordThread: (...args: unknown[]) => Promise<unknown>;
        },
        "createDiscordThread",
      )
      .mockRejectedValueOnce(new Error("Discord unavailable"))
      .mockResolvedValueOnce({ id: "message-1" });

    await (
      adapter as unknown as {
        handleGatewayMessage(
          message: unknown,
          mentioned: boolean,
        ): Promise<void>;
      }
    ).handleGatewayMessage(
      gatewayMessage({
        channelId: "channel-1",
        channel: { isThread: () => false, parentId: null },
        content: "<@123456789012345678> investigate the race",
      }),
      true,
    );

    expect(createDiscordThread).toHaveBeenCalledTimes(2);
    expect(chat.handleIncomingMessage).toHaveBeenCalledTimes(1);
    expect(chat.handleIncomingMessage).toHaveBeenCalledWith(
      adapter,
      "discord:1457808928258658549:channel-1:message-1",
      expect.objectContaining({
        threadId: "discord:1457808928258658549:channel-1:message-1",
      }),
    );
  });

  it("checks Paperclip admission before creating a root provider thread", async () => {
    const shouldCreateThread = vi.fn().mockResolvedValue(false);
    const { adapter, chat } = harness({ shouldCreateThread });
    await adapter.initialize(chat as never);
    const createDiscordThread = vi.spyOn(
      adapter as unknown as {
        createDiscordThread: (...args: unknown[]) => Promise<unknown>;
      },
      "createDiscordThread",
    );

    await (
      adapter as unknown as {
        handleGatewayMessage(
          message: unknown,
          mentioned: boolean,
        ): Promise<void>;
      }
    ).handleGatewayMessage(
      gatewayMessage({
        channelId: "channel-1",
        channel: { isThread: () => false, parentId: null },
        content: "<@123456789012345678> investigate the race",
      }),
      true,
    );

    expect(shouldCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "1457808928258658549",
        channelId: "channel-1",
        messageId: "message-1",
        userId: "user-1",
        threadId: "discord:1457808928258658549:channel-1:message-1",
        message: expect.objectContaining({
          id: "message-1",
          threadId: "discord:1457808928258658549:channel-1:message-1",
        }),
      }),
    );
    expect(createDiscordThread).not.toHaveBeenCalled();
    expect(chat.handleIncomingMessage).not.toHaveBeenCalled();
  });

  it("never tries to create a thread for a direct message", async () => {
    const shouldCreateThread = vi.fn();
    const { adapter, chat } = harness({ shouldCreateThread });
    await adapter.initialize(chat as never);
    const createDiscordThread = vi.spyOn(
      adapter as unknown as {
        createDiscordThread: (...args: unknown[]) => Promise<unknown>;
      },
      "createDiscordThread",
    );

    await (
      adapter as unknown as {
        handleGatewayMessage(
          message: unknown,
          mentioned: boolean,
        ): Promise<void>;
      }
    ).handleGatewayMessage(
      gatewayMessage({
        guildId: null,
        channelId: "dm-1",
        channel: { isThread: () => false, parentId: null },
      }),
      true,
    );

    expect(shouldCreateThread).not.toHaveBeenCalled();
    expect(createDiscordThread).not.toHaveBeenCalled();
    expect(chat.handleIncomingMessage).toHaveBeenCalledTimes(1);
  });

  it("bounds Discord REST calls and preserves explicit provider status", async () => {
    const { adapter } = harness();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ message: "rate limited", retry_after: 2 }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "2",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await (
      adapter as unknown as {
        discordFetch(path: string, method: string): Promise<Response>;
      }
    )
      .discordFetch("/channels/channel-1/messages", "POST")
      .catch((caught: unknown) => caught);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(error).toMatchObject({
      name: "NetworkError",
      retryAfter: 2,
      status: 429,
      response: { status: 429 },
    });
    expect(classifyChatPublicationError(error, 1)).toMatchObject({
      kind: "retry",
      retryAfterMs: 2_000,
    });
  });

  it.each([50001, 50013])(
    "preserves Discord destination code %s for resource-scoped failure handling",
    async (providerCode) => {
      const { adapter } = harness();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              code: providerCode,
              message:
                providerCode === 50001
                  ? "Missing Access"
                  : "Missing Permissions",
            }),
            {
              status: 403,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
      );

      const error = await (
        adapter as unknown as {
          discordFetch(path: string, method: string): Promise<Response>;
        }
      )
        .discordFetch("/channels/channel-1/messages", "POST")
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        name: "NetworkError",
        adapter: "discord",
        status: 403,
        response: { status: 403 },
        originalError: {
          name: "DiscordApiError",
          code: providerCode,
          status: 403,
        },
      });
      expect(classifyChatPublicationError(error, 1)).toMatchObject({
        kind: "resource_unavailable",
      });
    },
  );

  it("idempotently recovers an already-created root thread", async () => {
    const { adapter } = harness();
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: "message-1",
        name: "investigate the queue",
        parent_id: "channel-1",
        type: 11,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      adapter.ensureRootThread(
        "channel-1",
        "message-1",
        "<@123456789012345678> investigate the queue",
      ),
    ).resolves.toMatchObject({ id: "message-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/message-1",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      fetchMock.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(0);
  });

  it.each([
    ["postMessageWithFiles", "/channels/channel-1/messages"],
    ["discordInteractionFetch", "/webhooks/application/token"],
    ["discordInteractionFetchWithFiles", "/webhooks/application/token"],
  ] as const)("bounds and classifies %s", async (method, path) => {
    const { adapter } = harness({
      apiUrl: "https://discord.example.test/api/v10",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "missing" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const internals = adapter as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const error = await (
      method === "postMessageWithFiles"
        ? internals[method]!("channel-1", "thread-1", { content: "x" }, [])
        : method === "discordInteractionFetch"
          ? internals[method]!(path, "POST", { content: "x" })
          : internals[method]!(path, "POST", { content: "x" }, [])
    ).catch((caught: unknown) => caught);

    expect(fetchMock).toHaveBeenCalledWith(
      `https://discord.example.test/api/v10${path}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(classifyChatPublicationError(error, 1)).toMatchObject({
      kind: "resource_unavailable",
    });
  });

  it("keeps an oversized Markdown attachment byte-for-byte intact", async () => {
    const { adapter } = harness({
      apiUrl: "https://discord.example.test/api/v10",
    });
    const source = [
      "## Full response 🙂",
      "[Evidence](https://example.test/evidence)",
      `\`\`\`ts\n${"const value = 1;\n".repeat(150)}\`\`\``,
    ].join("\n\n");
    let capturedBody: FormData | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as FormData;
        return Response.json({ id: "message-with-file" });
      }),
    );

    await adapter.postMessage("discord:guild-1:channel-1:thread-1", {
      markdown: "Complete response attached.",
      files: [
        {
          data: Buffer.from(source, "utf8"),
          filename: "paperclip-response.md",
          mimeType: "text/markdown; charset=utf-8",
        },
      ],
    });

    expect(capturedBody).toBeInstanceOf(FormData);
    expect(
      JSON.parse(String(capturedBody!.get("payload_json"))) as {
        content: string;
      },
    ).toEqual({ content: "Complete response attached." });
    const file = capturedBody!.get("files[0]");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("paperclip-response.md");
    expect(await (file as File).text()).toBe(source);
  });

  it("honors Discord retry-after when replaying a Gateway operation", async () => {
    vi.useFakeTimers();
    const { adapter, logger } = harness();
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ retryAfter: 2 })
      .mockResolvedValueOnce(undefined);

    const processing = (
      adapter as unknown as {
        processGatewayWithRetry(
          operation: () => Promise<void>,
          context: Record<string, unknown>,
        ): Promise<boolean>;
      }
    ).processGatewayWithRetry(operation, {
      event: "thread_create",
      messageId: "message-1",
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(processing).resolves.toBe(true);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "Retrying Discord Gateway event after processing error",
      expect.objectContaining({ retryAfterMs: 2_000 }),
    );
  });

  it("does not retry before a Discord retry-after longer than one minute", async () => {
    vi.useFakeTimers();
    const { adapter } = harness();
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ retryAfter: 120 })
      .mockResolvedValueOnce(undefined);

    const processing = (
      adapter as unknown as {
        processGatewayWithRetry(
          operation: () => Promise<void>,
          context: Record<string, unknown>,
        ): Promise<boolean>;
      }
    ).processGatewayWithRetry(operation, {
      event: "thread_create",
      messageId: "message-1",
    });

    await vi.advanceTimersByTimeAsync(119_999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(processing).resolves.toBe(true);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("acknowledges a component only after its durable action callback succeeds", async () => {
    const { adapter, chat, client, handlers, logger } = harness();
    chat.handleActionEvent
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const interaction = gatewayComponent();
    await handlers.get("interactionCreate")?.(interaction);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(chat.handleActionEvent).toHaveBeenCalledTimes(2);
    expect(chat.handleActionEvent.mock.invocationCallOrder.at(-1)).toBeLessThan(
      interaction.deferUpdate.mock.invocationCallOrder[0]!,
    );
    expect(chat.handleActionEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionId: "approve",
        messageId: "message-2",
        threadId: "discord:1457808928258658549:channel-1:thread-1",
        value: "yes",
      }),
      { onOpenModal: expect.any(Function) },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Retrying Discord Gateway event after processing error",
      expect.objectContaining({
        event: "interaction",
        messageId: "message-2",
      }),
    );
  });

  it("does not acknowledge an action that Paperclip durably rejects", async () => {
    const { adapter, chat, client, handlers, logger } = harness();
    chat.handleActionEvent.mockRejectedValueOnce(
      Object.assign(new Error("action rejected"), {
        code: "chat_discord_gateway_action_rejected",
      }),
    );
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const interaction = gatewayComponent();
    await handlers.get("interactionCreate")?.(interaction);

    expect(chat.handleActionEvent).toHaveBeenCalledTimes(1);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content:
        "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
      flags: 64,
    });
    expect(logger.info).toHaveBeenCalledWith(
      "Discord Gateway action was not acknowledged after Paperclip rejected it",
      expect.objectContaining({
        event: "interaction",
        messageId: "message-2",
      }),
    );
  });

  it("acknowledges a duplicate that Paperclip reports as already durable", async () => {
    const { adapter, chat, client, handlers } = harness();
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const first = gatewayComponent({ id: "interaction-first" });
    const duplicate = gatewayComponent({ id: "interaction-duplicate" });
    await handlers.get("interactionCreate")?.(first);
    await handlers.get("interactionCreate")?.(duplicate);

    expect(chat.handleActionEvent).toHaveBeenCalledTimes(2);
    expect(first.deferUpdate).toHaveBeenCalledOnce();
    expect(duplicate.deferUpdate).toHaveBeenCalledOnce();
    expect(first.reply).not.toHaveBeenCalled();
    expect(duplicate.reply).not.toHaveBeenCalled();
  });

  it("does not acknowledge or retry an action after the provider deadline", async () => {
    vi.useFakeTimers();
    const { adapter, chat, client, handlers, logger } = harness();
    chat.handleActionEvent.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => setTimeout(resolve, 2_600)),
    );
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const interaction = gatewayComponent();
    const handling = handlers.get("interactionCreate")?.(interaction);
    await vi.advanceTimersByTimeAsync(2_600);
    await handling;

    expect(chat.handleActionEvent).toHaveBeenCalledTimes(1);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Discord Gateway event completed after provider acknowledgement deadline",
      expect.objectContaining({
        event: "interaction",
        messageId: "message-2",
      }),
    );
  });

  it("does not send a late ephemeral denial after the provider deadline", async () => {
    vi.useFakeTimers();
    const { adapter, chat, client, handlers, logger } = harness();
    chat.handleActionEvent.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_600));
      throw Object.assign(new Error("action rejected"), {
        code: "chat_discord_gateway_action_rejected",
      });
    });
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const interaction = gatewayComponent();
    const handling = handlers.get("interactionCreate")?.(interaction);
    await vi.advanceTimersByTimeAsync(2_600);
    await handling;

    expect(chat.handleActionEvent).toHaveBeenCalledOnce();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Discord Gateway action was not acknowledged after Paperclip rejected it",
      expect.objectContaining({
        event: "interaction",
        messageId: "message-2",
      }),
    );
  });

  it("contains a failed ephemeral denial without logging provider text", async () => {
    const { adapter, chat, client, handlers, logger } = harness();
    chat.handleActionEvent.mockRejectedValueOnce(
      Object.assign(new Error("action rejected"), {
        code: "chat_discord_gateway_action_rejected",
      }),
    );
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const interaction = gatewayComponent({
      reply: vi
        .fn()
        .mockRejectedValue(new Error("unknown interaction secret-body")),
    });
    await handlers.get("interactionCreate")?.(interaction);

    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Error handling Gateway interaction",
      expect.objectContaining({
        error: { name: "Error" },
        interactionId: "interaction-1",
      }),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "secret-body",
    );
  });

  it("does not start a retry that cannot finish before the provider deadline", async () => {
    vi.useFakeTimers();
    const { adapter, chat, client, handlers, logger } = harness();
    chat.handleActionEvent.mockRejectedValueOnce({ retryAfter: 3 });
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const interaction = gatewayComponent();
    await handlers.get("interactionCreate")?.(interaction);

    expect(chat.handleActionEvent).toHaveBeenCalledTimes(1);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Discord Gateway event retry would exceed provider acknowledgement deadline",
      expect.objectContaining({
        event: "interaction",
        messageId: "message-2",
        retryAfterMs: 3_000,
      }),
    );
  });

  it("fetches partial reactions and retries their durable callback", async () => {
    const { adapter, chat, client, handlers, logger } = harness();
    chat.handleReactionEvent
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);
    await adapter.initialize(chat as never);
    (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const completeReaction = {
      partial: false,
      emoji: { id: null, name: "thumbsup" },
      message: gatewayMessage({ id: "message-3" }),
    };
    const fetchReaction = vi.fn().mockResolvedValue(completeReaction);
    await handlers.get("messageReactionAdd")?.(
      {
        partial: true,
        fetch: fetchReaction,
        emoji: { id: null, name: "thumbsup" },
        message: gatewayMessage({ id: "message-3" }),
      },
      {
        id: "user-1",
        username: "ada",
        bot: false,
        partial: false,
      },
    );

    expect(fetchReaction).toHaveBeenCalledTimes(2);
    expect(chat.handleReactionEvent).toHaveBeenCalledTimes(2);
    expect(chat.handleReactionEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        added: true,
        messageId: "message-3",
        threadId: "discord:1457808928258658549:channel-1:thread-1",
        user: expect.objectContaining({ userId: "user-1" }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Retrying Discord Gateway event after processing error",
      expect.objectContaining({
        event: "reaction_add",
        messageId: "message-3",
      }),
    );
  });

  it("preserves Discord Gateway reaction sequence identity across cycles and replay", async () => {
    const { adapter, chat, client, handlers } = harness();
    await adapter.initialize(chat as never);
    const originalHandlePacket = client.ws.handlePacket;
    const cleanup = (
      adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          shuttingDown: () => boolean,
        ): () => void;
      }
    ).setupLegacyGatewayHandlers(client, () => false);

    const reaction = {
      partial: false,
      emoji: { id: null, name: "thumbsup" },
      message: gatewayMessage({ id: "message-reaction-cycle" }),
    };
    const user = {
      id: "user-1",
      username: "ada",
      bot: false,
      partial: false,
    };
    const raw = {
      guild_id: "1457808928258658549",
      channel_id: "thread-1",
      message_id: "message-reaction-cycle",
      user_id: "user-1",
      emoji: { id: null, name: "thumbsup" },
    };
    const ready = {
      op: 0,
      t: "READY",
      s: 1,
      d: { session_id: "private-gateway-session" },
    };
    handlers.get("raw")?.(ready, 0);
    await client.ws.handlePacket(ready);
    const dispatch = async (
      type: "MESSAGE_REACTION_ADD" | "MESSAGE_REACTION_REMOVE",
      sequence: number,
      delayed = false,
    ) => {
      const packet = {
        op: 0,
        t: type,
        s: sequence,
        d: raw,
        testReaction: reaction,
        testUser: user,
      };
      handlers.get("raw")?.(packet, 0);
      if (delayed) await Promise.resolve();
      await client.ws.handlePacket(packet);
    };

    await dispatch("MESSAGE_REACTION_ADD", 42, true);
    await dispatch("MESSAGE_REACTION_ADD", 42);
    const suppressedPacket = {
      op: 0,
      t: "MESSAGE_REACTION_REMOVE",
      s: 43,
      d: raw,
    };
    handlers.get("raw")?.(suppressedPacket, 0);
    await client.ws.handlePacket(suppressedPacket);
    await dispatch("MESSAGE_REACTION_REMOVE", 44);
    await dispatch("MESSAGE_REACTION_ADD", 45);
    const resumed = { op: 0, t: "RESUMED", s: 46, d: {} };
    handlers.get("raw")?.(resumed, 0);
    await client.ws.handlePacket(resumed);
    await dispatch("MESSAGE_REACTION_ADD", 45);
    const replacementReady = {
      op: 0,
      t: "READY",
      s: 1,
      d: { session_id: "replacement-private-gateway-session" },
    };
    handlers.get("raw")?.(replacementReady, 0);
    await client.ws.handlePacket(replacementReady);
    await dispatch("MESSAGE_REACTION_ADD", 42);

    const callbacks = chat.handleReactionEvent.mock.calls.map(
      ([event]) => event as { raw: Record<string, unknown> },
    );
    expect(callbacks).toHaveLength(6);
    expect(
      callbacks.map(({ raw: eventRaw }) => eventRaw.gateway_dispatch),
    ).toEqual([
      expect.objectContaining({
        eventType: "MESSAGE_REACTION_ADD",
        sequence: 42,
        shardId: 0,
        sessionFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/u),
      }),
      expect.objectContaining({
        eventType: "MESSAGE_REACTION_ADD",
        sequence: 42,
        shardId: 0,
      }),
      expect.objectContaining({
        eventType: "MESSAGE_REACTION_REMOVE",
        sequence: 44,
        shardId: 0,
      }),
      expect.objectContaining({
        eventType: "MESSAGE_REACTION_ADD",
        sequence: 45,
        shardId: 0,
      }),
      expect.objectContaining({
        eventType: "MESSAGE_REACTION_ADD",
        sequence: 45,
        shardId: 0,
      }),
      expect.objectContaining({
        eventType: "MESSAGE_REACTION_ADD",
        sequence: 42,
        shardId: 0,
      }),
    ]);
    expect(JSON.stringify(callbacks)).not.toContain("private-gateway-session");
    expect(
      (callbacks[0]?.raw.gateway_dispatch as { sessionFingerprint: string })
        .sessionFingerprint,
    ).not.toBe(
      (callbacks[5]?.raw.gateway_dispatch as { sessionFingerprint: string })
        .sessionFingerprint,
    );
    expect(callbacks[3]?.raw.gateway_dispatch).toEqual(
      callbacks[4]?.raw.gateway_dispatch,
    );
    cleanup();
    expect(client.ws.handlePacket).toBe(originalHandlePacket);
  });

  it("fails closed when Discord's pinned Gateway packet hook is unavailable", async () => {
    const { adapter, chat, client } = harness();
    await adapter.initialize(chat as never);

    expect(() =>
      (
        adapter as unknown as {
          setupLegacyGatewayHandlers(
            client: unknown,
            shuttingDown: () => boolean,
          ): () => void;
        }
      ).setupLegacyGatewayHandlers({ ...client, ws: {} }, () => false),
    ).toThrow(
      "Discord Gateway compatibility error: packet handler is unavailable",
    );
  });

  it("maps a root-message reaction to its created Discord thread", async () => {
    const { adapter, chat } = harness();
    await adapter.initialize(chat as never);

    await (
      adapter as unknown as {
        handleGatewayReaction(
          reaction: unknown,
          user: unknown,
          added: boolean,
        ): Promise<void>;
      }
    ).handleGatewayReaction(
      {
        partial: false,
        emoji: { id: null, name: "thumbsup" },
        message: gatewayMessage({
          id: "root-message-1",
          channelId: "channel-1",
          channel: { isThread: () => false, parentId: null },
        }),
      },
      {
        id: "user-1",
        username: "ada",
        bot: false,
        partial: false,
      },
      true,
    );

    expect(chat.handleReactionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "root-message-1",
        threadId: "discord:1457808928258658549:channel-1:root-message-1",
      }),
    );
  });
});

type DiscordClientForLifecycleTest = {
  destroy(): void | Promise<void>;
  emit(event: string, ...args: unknown[]): boolean;
  login(token?: string): Promise<string>;
};

const discordRequire = createRequire(
  import.meta.resolve("@chat-adapter/discord"),
);
const { Client, Events } = discordRequire("discord.js") as {
  Client: {
    prototype: DiscordClientForLifecycleTest;
    new (options: Record<string, unknown>): DiscordClientForLifecycleTest & {
      rest: { get(...args: unknown[]): Promise<unknown> };
    };
  };
  Events: {
    Error: string;
    ClientReady: string;
    ShardReady: string;
    ShardResume: string;
  };
};

describe("pinned Discord Gateway lifecycle patch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    "packet decoding",
    "heartbeat lookup",
    "identify throttle",
    "ready persistence",
  ])("fences a retired shard's pending %s", async (stage) => {
    const discordWsRequire = createRequire(
      discordRequire.resolve("discord.js"),
    );
    const { WebSocketShard, DefaultWebSocketManagerOptions } = discordWsRequire(
      "@discordjs/ws",
    ) as {
      DefaultWebSocketManagerOptions: Record<string, unknown>;
      WebSocketShard: new (
        strategy: Record<string, unknown>,
        id: number,
      ) => {
        status: number;
        destroy(): Promise<void>;
        heartbeat(): Promise<void>;
        identify(): Promise<void>;
        onMessage(data: string, binary: boolean): Promise<void>;
        unpackMessage(): Promise<unknown>;
        send(): Promise<void>;
        waitForEvent(): Promise<{ ok: boolean }>;
        on(event: string, handler: (...args: unknown[]) => void): void;
      };
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pause = async () => {
      reached();
      await held;
    };
    const shard = new WebSocketShard(
      {
        options: { ...DefaultWebSocketManagerOptions, shardCount: 1 },
        retrieveSessionInfo: async () => {
          if (stage === "heartbeat lookup") await pause();
          return null;
        },
        updateSessionInfo: async (_id: number, session: unknown) => {
          if (stage === "ready persistence" && session) await pause();
        },
        waitForIdentify: pause,
      },
      0,
    );
    const ready = {
      op: 0,
      t: "READY",
      s: 1,
      d: {
        session_id: "synthetic-session",
        resume_gateway_url: "wss://example.invalid",
      },
    };
    if (stage === "packet decoding")
      vi.spyOn(shard, "unpackMessage").mockImplementation(async () => {
        await pause();
        return ready;
      });
    const send = vi.spyOn(shard, "send").mockResolvedValue(undefined);
    vi.spyOn(shard, "waitForEvent").mockResolvedValue({ ok: true });
    const emitted = vi.fn();
    shard.on("ready", emitted);
    shard.on("dispatch", emitted);
    const pending =
      stage === "heartbeat lookup"
        ? shard.heartbeat()
        : stage === "identify throttle"
          ? shard.identify()
          : shard.onMessage(JSON.stringify(ready), false);
    await started;
    await shard.destroy();
    release();
    await pending;
    expect(shard.status).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();
  });

  it("does not restart a real Discord client retired during its outer gateway lookup", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const strategy = {
      connect: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
      spawn: vi.fn(async () => undefined),
    };
    const client = new Client({
      intents: [],
      ws: { buildStrategy: () => strategy },
    });
    vi.spyOn(client.rest, "get").mockImplementation(async () => {
      reached();
      await held;
      return {
        url: "ws://127.0.0.1",
        shards: 1,
        session_start_limit: { total: 100, remaining: 100, reset_after: 1_000 },
      };
    });
    const login = client.login("synthetic-discord-token");
    await started;
    await client.destroy();
    release();
    await login;
    expect(strategy.spawn).not.toHaveBeenCalled();
    expect(strategy.connect).not.toHaveBeenCalled();
    expect(strategy.destroy).toHaveBeenCalledOnce();
  });

  it.each(["gateway lookup", "shard spawn"])(
    "does not connect retired shards after pending %s",
    async (stage) => {
      const discordWsRequire = createRequire(
        discordRequire.resolve("discord.js"),
      );
      const { WebSocketManager } = discordWsRequire("@discordjs/ws") as {
        WebSocketManager: new (options: Record<string, unknown>) => {
          connect(): Promise<void>;
          destroy(): Promise<void>;
        };
      };
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const strategy = {
        connect: vi.fn(async () => undefined),
        destroy: vi.fn(async () => undefined),
        spawn: vi.fn(async () => {
          if (stage === "shard spawn") {
            reached();
            await held;
          }
        }),
      };
      const manager = new WebSocketManager({
        buildStrategy: () => strategy,
        rest: {
          get: async () => {
            if (stage === "gateway lookup") {
              reached();
              await held;
            }
            return {
              url: "ws://127.0.0.1",
              shards: 1,
              session_start_limit: { remaining: 100, reset_after: 1_000 },
            };
          },
        },
      });
      const connecting = manager.connect();
      await started;
      await manager.destroy();
      release();
      await connecting;
      expect(strategy.connect).not.toHaveBeenCalled();
      if (stage === "gateway lookup")
        expect(strategy.spawn).not.toHaveBeenCalled();
      else expect(strategy.destroy).toHaveBeenCalledTimes(3); // Initial reset, retirement, then late-spawn cleanup.
    },
  );

  it.each([
    "retirement",
    "timeout recovery",
    "retired recovery",
    "handshake timeout recovery",
  ])("owns real socket teardown through %s", async (mode) => {
    const discordWsRequire = createRequire(
      discordRequire.resolve("discord.js"),
    );
    const script = String.raw`
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { createServer } from "node:net";
      const require = createRequire(import.meta.url);
      const { WebSocketShard, DefaultWebSocketManagerOptions } = require(process.argv[1]);
      const mode = process.argv[2];
      const sockets = new Set();
      let accepted = 0;
      let observeHandshake;
      const handshake = new Promise(resolve => { observeHandshake = resolve; });
      let observeRecovery;
      const recoveredHandshake = new Promise(resolve => { observeRecovery = resolve; });
      const server = createServer(socket => {
        accepted += 1;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.once("data", () => accepted === 1 ? observeHandshake() : observeRecovery());
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      let sessionReads = 0;
      const shard = new WebSocketShard({
        options: {
          ...DefaultWebSocketManagerOptions,
          compression: null,
          handshakeTimeout: mode === "handshake timeout recovery" ? 100 : 1_000,
          helloTimeout: mode === "retirement" || mode === "handshake timeout recovery" ? 2_000 : 20,
          gatewayInformation: { url: "ws://127.0.0.1:" + address.port },
        },
        retrieveSessionInfo: async () => { sessionReads += 1; return null; },
        updateSessionInfo: async () => {},
      }, 0);
      const failures = [];
      shard.on("error", event => failures.push(event.error?.name));
      const connecting = shard.internalConnect();
      await handshake;
      const connection = shard.connection;
      assert.equal(connection.readyState, 0);
      const closed = new Promise(resolve => connection.once("close", resolve));
      if (mode === "retirement") await shard.destroy();
      await closed;
      if (mode === "timeout recovery" || mode === "handshake timeout recovery") await recoveredHandshake;
      if (mode === "retired recovery") await new Promise(resolve => setImmediate(resolve));
      const replacement = shard.connection;
      await shard.destroy();
      await connecting;
      assert.equal(connection.readyState, 3);
      if (replacement) assert.equal(replacement.readyState, 3);
      const expectedConnections = mode === "timeout recovery" || mode === "handshake timeout recovery" ? 2 : 1;
      assert.equal(accepted, expectedConnections);
      assert.equal(sessionReads, expectedConnections);
      assert.deepEqual(failures, mode === "handshake timeout recovery" ? ["Error"] : []);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      process.stdout.write("all owned sockets closed; expected reconnect and failure counts\n");
    `;
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        discordWsRequire.resolve("@discordjs/ws"),
        mode,
      ],
      { timeout: 5_000 },
    );
    expect(result.stdout).toBe(
      "all owned sockets closed; expected reconnect and failure counts\n",
    );
    expect(result.stderr).toBe("");
  });

  it.each(["connecting callback", "credential lookup"])(
    "never logs in after retirement during %s",
    async (stage) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const login = vi
        .spyOn(Client.prototype, "login")
        .mockResolvedValue("discord-token");
      const destroy = vi
        .spyOn(Client.prototype, "destroy")
        .mockResolvedValue(undefined);
      const { adapter, chat } = harness({
        botToken: async () => {
          if (stage === "credential lookup") {
            reached();
            await held;
          }
          return "discord-token";
        },
        onGatewayEvent: async (event: { type: string }) => {
          if (stage === "connecting callback" && event.type === "connecting") {
            reached();
            await held;
          }
        },
      });
      await adapter.initialize(chat as never);
      const abort = new AbortController();
      let listener: Promise<unknown> | undefined;
      await adapter.startGatewayListener(
        {
          waitUntil: (task) => {
            listener = Promise.resolve(task);
          },
        },
        60_000,
        abort.signal,
      );
      await started;
      abort.abort();
      await listener;
      release();
      await held;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(login).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledOnce();
    },
  );

  it("waits for client destruction and suppresses retired ready events", async () => {
    let client!: DiscordClientForLifecycleTest;
    vi.spyOn(Client.prototype, "login").mockImplementation(function (
      this: DiscordClientForLifecycleTest,
    ) {
      client = this;
      return Promise.resolve("discord-token");
    });
    let release!: () => void;
    const destroyed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const destroy = vi
      .spyOn(Client.prototype, "destroy")
      .mockReturnValue(destroyed);
    const onGatewayEvent = vi.fn(async () => undefined);
    const { adapter, chat, logger } = harness({ onGatewayEvent });
    await adapter.initialize(chat as never);
    const abort = new AbortController();
    let listener: Promise<unknown> | undefined;
    await adapter.startGatewayListener(
      {
        waitUntil: (task) => {
          listener = Promise.resolve(task);
        },
      },
      60_000,
      abort.signal,
    );
    await vi.waitFor(() => expect(client).toBeDefined());
    abort.abort();
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    let settled = false;
    void listener!.then(() => {
      settled = true;
    });
    const priorEvents = onGatewayEvent.mock.calls.length;
    client.emit(Events.ClientReady);
    client.emit(Events.ShardReady);
    client.emit(Events.ShardResume);
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(settled).toBe(false);
      expect(onGatewayEvent.mock.calls).toHaveLength(priorEvents);
      expect(logger.info).not.toHaveBeenCalledWith(
        "Discord Gateway connected",
        expect.anything(),
      );
    } finally {
      release();
      await listener;
    }
    expect(settled).toBe(true);
  });

  it("recovers an accepted root-thread request after its response is lost", async () => {
    const channelId = "333333333333333333";
    const messageId = "555555555555555555";
    const providerFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { code: 10003, message: "Unknown Channel" },
          { status: 404 },
        ),
      )
      .mockRejectedValueOnce(new TypeError("response lost after acceptance"))
      .mockResolvedValueOnce(
        Response.json({
          id: messageId,
          name: "Investigate the queue",
          parent_id: channelId,
          type: 11,
        }),
      );
    vi.stubGlobal("fetch", providerFetch);
    const adapter = createDiscordAdapter({
      applicationId: "123456789012345678",
      botToken: "discord-token",
      webhookVerifier: async () => false,
    });

    await expect(
      adapter.ensureRootThread(channelId, messageId, "Investigate the queue"),
    ).rejects.toThrow("response lost after acceptance");
    await expect(
      adapter.ensureRootThread(channelId, messageId, "Investigate the queue"),
    ).resolves.toMatchObject({
      id: messageId,
      parent_id: channelId,
      type: 11,
    });
    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(
      providerFetch.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(1);
  });

  it("observes a Gateway failure while login is still pending", async () => {
    let client: DiscordClientForLifecycleTest | null = null;
    vi.spyOn(Client.prototype, "login").mockImplementation(function (
      this: DiscordClientForLifecycleTest,
    ) {
      client = this;
      return new Promise(() => undefined);
    });
    const destroy = vi
      .spyOn(Client.prototype, "destroy")
      .mockImplementation(() => undefined);
    const adapter = createDiscordAdapter({
      applicationId: "123456789012345678",
      botToken: "discord-token",
      onGatewayEvent: vi.fn(async () => undefined),
      webhookVerifier: async () => false,
    });
    await adapter.initialize({} as never);
    let listener: Promise<unknown> | null = null;
    await adapter.startGatewayListener(
      {
        waitUntil(task) {
          listener = Promise.resolve(task);
        },
      },
      60_000,
    );
    await vi.waitFor(() => expect(client).not.toBeNull());
    const failure = Object.assign(new Error("Privileged intent rejected"), {
      code: 4014,
    });
    client!.emit(Events.Error, failure);

    await expect(listener).rejects.toBe(failure);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("removes the lifetime abort listener on every shutdown path", async () => {
    vi.spyOn(Client.prototype, "login").mockResolvedValue("discord-token");
    const destroy = vi
      .spyOn(Client.prototype, "destroy")
      .mockImplementation(() => undefined);
    const adapter = createDiscordAdapter({
      applicationId: "123456789012345678",
      botToken: "discord-token",
      webhookVerifier: async () => false,
    });
    await adapter.initialize({} as never);
    const abort = new AbortController();
    const removeEventListener = vi.spyOn(abort.signal, "removeEventListener");
    let listener: Promise<unknown> | null = null;
    await adapter.startGatewayListener(
      {
        waitUntil(task) {
          listener = Promise.resolve(task);
        },
      },
      60_000,
      abort.signal,
    );
    if (!listener) throw new Error("Expected Discord Gateway listener task");
    abort.abort();

    await expect(listener).resolves.toBeUndefined();
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
});
