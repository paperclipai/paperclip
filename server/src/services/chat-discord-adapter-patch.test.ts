import { createDiscordAdapter } from "@chat-adapter/discord";
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

function harness(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, GatewayHandler>();
  const client = {
    user: { id: "123456789012345678" },
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
      new Response(
        JSON.stringify({
          code: 160004,
          message: "A thread has already been created for this message",
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      ),
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
      "https://discord.com/api/v10/channels/channel-1/messages/message-1/threads",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
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

  it("acknowledges a component once and retries its durable action callback", async () => {
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

    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    await handlers.get("interactionCreate")?.({
      applicationId: "123456789012345678",
      channel: { id: "thread-1", parentId: "channel-1", type: 11 },
      channelId: "thread-1",
      customId: "approve\nyes",
      deferUpdate,
      guildId: "1457808928258658549",
      id: "interaction-1",
      isChatInputCommand: () => false,
      isMessageComponent: () => true,
      message: { id: "message-2" },
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
    });

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(chat.handleActionEvent).toHaveBeenCalledTimes(2);
    expect(chat.handleActionEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionId: "approve",
        messageId: "message-2",
        threadId: "discord:1457808928258658549:channel-1:thread-1",
        value: "yes",
      }),
      undefined,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Retrying Discord Gateway event after processing error",
      expect.objectContaining({
        event: "interaction",
        messageId: "message-2",
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
