import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSdkStatePersistence } from "./chat-sdk-state.js";

const captures = vi.hoisted(() => ({
  chatConfigs: [] as Array<Record<string, unknown>>,
  chats: [] as Array<Record<string, unknown>>,
  discordConfigs: [] as Array<Record<string, unknown>>,
  discordGatewayDurations: [] as number[],
  discordRootThreads: [] as Array<{
    channelId: string;
    content: string;
    messageId: string;
  }>,
  githubConfigs: [] as Array<Record<string, unknown>>,
  slackConfigs: [] as Array<Record<string, unknown>>,
  teamsConfigs: [] as Array<Record<string, unknown>>,
  telegramConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@chat-adapter/discord", () => ({
  createDiscordAdapter: (config: Record<string, unknown>) => {
    captures.discordConfigs.push(config);
    return {
      name: "discord",
      paperclipCompatibilityRevision:
        config.botToken === "unpatched-discord"
          ? undefined
          : "paperclip-discord-v2",
      async ensureRootThread(
        channelId: string,
        messageId: string,
        content: string,
      ) {
        captures.discordRootThreads.push({ channelId, content, messageId });
        return { id: messageId, name: content };
      },
      async startGatewayListener(
        options: { waitUntil?: (task: Promise<unknown>) => void },
        durationMs: number,
      ) {
        captures.discordGatewayDurations.push(durationMs);
        if (config.botToken === "gateway-start-failure") {
          throw new Error("Gateway failed to start");
        }
        options.waitUntil?.(Promise.resolve());
        return new Response("listening");
      },
    };
  },
}));

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: (config: Record<string, unknown>) => {
    captures.slackConfigs.push(config);
    return { name: "slack" };
  },
}));

vi.mock("@chat-adapter/github", () => ({
  createGitHubAdapter: (config: Record<string, unknown>) => {
    captures.githubConfigs.push(config);
    return { name: "github" };
  },
}));

vi.mock("@chat-adapter/teams", () => ({
  createTeamsAdapter: (config: Record<string, unknown>) => {
    captures.teamsConfigs.push(config);
    class MockTeamsApi {
      readonly _apiClientSettings: unknown;
      readonly http: unknown;

      constructor(
        readonly serviceUrl: string,
        http: unknown = {},
        settings?: unknown,
      ) {
        this.http = http;
        this._apiClientSettings = settings;
      }
    }
    const noop = async () => undefined;
    return {
      name: "teams",
      app: {
        api: new MockTeamsApi("https://smba.trafficmanager.net/teams"),
      },
      decodeThreadId: () => ({
        serviceUrl: "https://smba.trafficmanager.net/teams",
      }),
      openDM: async () => "teams:mock:thread",
      postMessage: noop,
      postEphemeral: noop,
      editMessage: noop,
      deleteMessage: noop,
      addReaction: noop,
      removeReaction: noop,
      startTyping: noop,
      stream: noop,
      postChannelMessage: noop,
    };
  },
}));

vi.mock("@chat-adapter/telegram", () => ({
  createTelegramAdapter: (config: Record<string, unknown>) => {
    captures.telegramConfigs.push(config);
    return { name: "telegram" };
  },
}));

vi.mock("chat", () => ({
  Chat: class MockChat {
    readonly handlers: Record<string, (...args: unknown[]) => unknown> = {};
    readonly handlerRegistrations: Record<string, number> = {};
    readonly webhooks: Record<string, (request: Request) => Promise<Response>> =
      {};
    initializeCalls = 0;
    shutdownCalls = 0;

    constructor(config: Record<string, unknown>) {
      captures.chatConfigs.push(config);
      captures.chats.push(this as unknown as Record<string, unknown>);
      for (const key of Object.keys(
        config.adapters as Record<string, unknown>,
      )) {
        this.webhooks[key] = async () => new Response(key, { status: 202 });
      }
    }

    onDirectMessage(handler: (...args: unknown[]) => unknown) {
      this.handlerRegistrations.direct =
        (this.handlerRegistrations.direct ?? 0) + 1;
      this.handlers.direct = handler;
    }
    onNewMention(handler: (...args: unknown[]) => unknown) {
      this.handlerRegistrations.mention =
        (this.handlerRegistrations.mention ?? 0) + 1;
      this.handlers.mention = handler;
    }
    onSubscribedMessage(handler: (...args: unknown[]) => unknown) {
      this.handlerRegistrations.subscribed =
        (this.handlerRegistrations.subscribed ?? 0) + 1;
      this.handlers.subscribed = handler;
    }
    onNewMessage(_pattern: RegExp, handler: (...args: unknown[]) => unknown) {
      this.handlerRegistrations.unaddressed =
        (this.handlerRegistrations.unaddressed ?? 0) + 1;
      this.handlers.unaddressed = handler;
    }
    onMessageUpdated(handler: (...args: unknown[]) => unknown) {
      this.handlers.updated = handler;
    }
    onMessageDeleted(handler: (...args: unknown[]) => unknown) {
      this.handlers.deleted = handler;
    }
    onReaction(handler: (...args: unknown[]) => unknown) {
      this.handlers.reaction = handler;
    }
    onAction(handler: (...args: unknown[]) => unknown) {
      this.handlers.action = handler;
    }
    onOptionsLoad(handler: (...args: unknown[]) => unknown) {
      this.handlers.options = handler;
    }
    onModalSubmit(handler: (...args: unknown[]) => unknown) {
      this.handlers.modalSubmit = handler;
    }
    onModalClose(handler: (...args: unknown[]) => unknown) {
      this.handlers.modalClose = handler;
    }
    onSlashCommand(handler: (...args: unknown[]) => unknown) {
      this.handlers.slash = handler;
    }
    async initialize() {
      this.initializeCalls += 1;
    }
    async shutdown() {
      this.shutdownCalls += 1;
    }
    thread(id: string) {
      return { id };
    }
    channel(id: string) {
      return { id };
    }
    async openDM(user: unknown) {
      return { user };
    }
    async getUser(user: unknown) {
      return { user };
    }
    async abortTurn() {}
    async handleActionEvent() {}

    async handleIncomingMessage() {}
    async handleReactionEvent() {}
    async processMessageDeleted() {}
    async processMessageUpdated() {}
  },
}));

import {
  CHAT_SDK_SOURCE_REVISION,
  CHAT_SDK_VERSION,
  DiscordAdapterCompatibilityError,
  ChatSdkEndpointNotRegisteredError,
  createChatSdkEndpointRuntime,
  createChatSdkRuntime,
  type CreateChatSdkEndpointRuntimeOptions,
} from "./chat-sdk-runtime.js";

const persistence: ChatSdkStatePersistence = {
  async compareAndSet() {
    return true;
  },
  async deleteIfVersion() {
    return true;
  },
  async read() {
    return null;
  },
};

function baseOptions(
  providerConfig: CreateChatSdkEndpointRuntimeOptions["providerConfig"],
): CreateChatSdkEndpointRuntimeOptions {
  return {
    callbacks: { onMessage: vi.fn() },
    companyId: "company-1",
    endpointId: "endpoint-1",
    logger: "silent",
    persistence,
    providerConfig,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

interface CapturedWebhookOptions {
  waitUntil?: (task: Promise<unknown>) => void;
}

describe("Chat SDK endpoint runtime", () => {
  beforeEach(() => {
    for (const value of Object.values(captures)) value.length = 0;
  });

  it("pins the audited SDK release and configures Slack's automatic feature path", () => {
    expect(CHAT_SDK_VERSION).toBe("4.39.0");
    expect(CHAT_SDK_SOURCE_REVISION).toBe(
      "51322dde8f4aafd8a7fc7a20cbfd7ae45cafaa5c",
    );
    const runtime = createChatSdkEndpointRuntime(
      baseOptions({
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          signingSecret: "signing-secret",
          botUserId: "U123",
        },
      }),
    );

    expect(runtime.provider).toBe("slack");
    expect(runtime.sdkAdapterKey).toBe("slack");
    expect(captures.slackConfigs[0]).toMatchObject({
      botToken: "xoxb-test",
      signingSecret: "signing-secret",
      botUserId: "U123",
      mode: "webhook",
      nativeStreaming: true,
      userName: "paperclip-agent",
      webClientOptions: {
        rejectRateLimitedCalls: true,
        retryConfig: { retries: 0 },
        timeout: 45_000,
      },
    });
    expect(captures.chatConfigs[0]).toMatchObject({
      concurrency: "concurrent",
    });
  });

  it("leaves pre-callback SDK retry markers unclaimed so the delivery ledger remains authoritative", async () => {
    createChatSdkEndpointRuntime(
      baseOptions({
        provider: "slack",
        userName: "agent",
        credentials: { botToken: "token", signingSecret: "secret" },
      }),
    );
    const state = captures.chatConfigs[0]?.state as {
      connect(): Promise<void>;
      get<T>(key: string): Promise<T | null>;
      set(key: string, value: unknown, ttlMs?: number): Promise<void>;
      setIfNotExists(
        key: string,
        value: unknown,
        ttlMs?: number,
      ): Promise<boolean>;
    };
    await state.connect();

    expect(
      await state.setIfNotExists("dedupe:slack:message-1", true, 60_000),
    ).toBe(true);
    expect(
      await state.setIfNotExists("dedupe:slack:message-1", true, 60_000),
    ).toBe(true);
    await state.set("slack:event-delivered:event-1", true, 60_000);
    expect(await state.get("slack:event-delivered:event-1")).toBeNull();
    expect(
      await state.setIfNotExists(
        "telegram:webhook-update:bot-1:42",
        true,
        60_000,
      ),
    ).toBe(true);
    expect(
      await state.setIfNotExists(
        "telegram:webhook-update:bot-1:42",
        true,
        60_000,
      ),
    ).toBe(true);
  });

  it.each([
    {
      expectedKey: "discord",
      providerConfig: {
        provider: "discord" as const,
        userName: "paperclip-agent",
        credentials: {
          applicationId: "123456789012345678",
          botToken: "discord-token",
          guildId: "1457808928258658549",
        },
      },
    },
    {
      expectedKey: "github",
      providerConfig: {
        provider: "github" as const,
        userName: "paperclip-agent[bot]",
        credentials: { token: "github-token", webhookSecret: "github-secret" },
      },
    },
    {
      expectedKey: "teams",
      providerConfig: {
        provider: "microsoft-teams" as const,
        userName: "Paperclip Agent",
        credentials: {
          appId: "teams-app",
          appPassword: "teams-password",
          appTenantId: "teams-tenant",
          appType: "SingleTenant" as const,
        },
      },
    },
    {
      expectedKey: "telegram",
      providerConfig: {
        provider: "telegram" as const,
        userName: "paperclip_agent_bot",
        credentials: {
          botToken: "telegram-token",
          secretToken: "telegram-secret",
        },
      },
    },
  ])(
    "maps $providerConfig.provider to the $expectedKey SDK adapter",
    ({ expectedKey, providerConfig }) => {
      const runtime = createChatSdkEndpointRuntime(baseOptions(providerConfig));
      expect(runtime.sdkAdapterKey).toBe(expectedKey);
      expect(
        Object.keys((captures.chatConfigs[0]?.adapters ?? {}) as object),
      ).toEqual([expectedKey]);
    },
  );

  it("passes only the Discord application credentials to the adapter and fences guild callbacks", async () => {
    const runtime = createChatSdkEndpointRuntime(
      baseOptions({
        provider: "discord",
        userName: "paperclip-agent",
        credentials: {
          apiUrl: "https://discord.example.test/api/v10",
          applicationId: "123456789012345678",
          botToken: "discord-token",
          guildId: "1457808928258658549",
        },
      }),
    );

    expect(captures.discordConfigs[0]).toMatchObject({
      apiUrl: "https://discord.example.test/api/v10",
      applicationId: "123456789012345678",
      botToken: "discord-token",
      userName: "paperclip-agent",
    });
    expect(captures.discordConfigs[0]).not.toHaveProperty("guildId");
    expect(captures.discordConfigs[0]).not.toHaveProperty("publicKey");
    expect(captures.discordConfigs[0]?.webhookVerifier).toEqual(
      expect.any(Function),
    );
    expect(captures.discordConfigs[0]?.shouldCreateThread).toEqual(
      expect.any(Function),
    );
    expect(
      runtime.acceptsProviderScope({ guild_id: "1457808928258658549" }),
    ).toBe(true);
    expect(
      runtime.acceptsProviderScope({ guild_id: "999999999999999999" }),
    ).toBe(false);
    expect(runtime.acceptsProviderScope({ guild_id: "@me" })).toBe(true);
    await runtime.ensureDiscordRootThread({
      channelId: "333333333333333333",
      messageId: "555555555555555555",
      content: "Investigate the queue",
    });
    expect(captures.discordRootThreads).toEqual([
      {
        channelId: "333333333333333333",
        messageId: "555555555555555555",
        content: "Investigate the queue",
      },
    ]);
  });

  it("fails loudly when the pinned Discord patch revision is unavailable", () => {
    expect(() =>
      createChatSdkEndpointRuntime(
        baseOptions({
          provider: "discord",
          userName: "paperclip-agent",
          credentials: {
            applicationId: "123456789012345678",
            botToken: "unpatched-discord",
            guildId: "1457808928258658549",
          },
        }),
      ),
    ).toThrow(DiscordAdapterCompatibilityError);
  });

  it("keeps one long-lived Discord Gateway session and shuts it down cleanly", async () => {
    const runtime = createChatSdkEndpointRuntime(
      baseOptions({
        provider: "discord",
        userName: "paperclip-agent",
        credentials: {
          applicationId: "123456789012345678",
          botToken: "discord-token",
          guildId: "1457808928258658549",
        },
      }),
    );

    await runtime.initialize();
    await vi.waitFor(() =>
      expect(captures.discordGatewayDurations).toEqual([24 * 60 * 60_000]),
    );
    await runtime.shutdown();
    expect(captures.discordGatewayDurations).toHaveLength(1);
  });

  it("supervises a failed Discord Gateway start without leaking a rejected task", async () => {
    const runtime = createChatSdkEndpointRuntime(
      baseOptions({
        provider: "discord",
        userName: "paperclip-agent",
        credentials: {
          applicationId: "123456789012345678",
          botToken: "gateway-start-failure",
          guildId: "1457808928258658549",
        },
      }),
    );

    await runtime.initialize();
    await vi.waitFor(() =>
      expect(captures.discordGatewayDurations).toEqual([24 * 60 * 60_000]),
    );
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(captures.discordGatewayDurations).toHaveLength(1);
  });

  it("wraps each normalized message route with endpoint and public provider identity", async () => {
    const onMessage = vi.fn();
    createChatSdkEndpointRuntime({
      ...baseOptions({
        provider: "microsoft-teams",
        userName: "Paperclip Agent",
        credentials: { appId: "app", appPassword: "password" },
      }),
      callbacks: { onMessage },
    });
    const chat = captures.chats[0] as unknown as {
      handlerRegistrations: Record<string, number>;
      handlers: Record<string, (...args: unknown[]) => Promise<void>>;
    };
    const thread = { id: "teams:thread" };
    const message = {
      id: "message-1",
      raw: { conversation: { tenantId: "teams-tenant" } },
    };
    await chat.handlers.mention?.(thread, message, {
      totalSinceLastHandler: 1,
      skipped: [],
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId: "endpoint-1",
        provider: "microsoft-teams",
        trigger: "mention",
        thread,
        message,
      }),
    );
    expect(chat.handlerRegistrations).toMatchObject({
      direct: 1,
      mention: 1,
      subscribed: 1,
      unaddressed: 1,
    });
  });

  it("rejects every Teams callback outside the configured tenant", async () => {
    const callbacks = {
      onAction: vi.fn(),
      onMessage: vi.fn(),
      onMessageDeleted: vi.fn(),
      onMessageUpdated: vi.fn(),
      onModalClose: vi.fn(),
      onModalSubmit: vi.fn(),
      onOptionsLoad: vi.fn(),
      onReaction: vi.fn(),
      onSlashCommand: vi.fn(),
    };
    const runtime = createChatSdkEndpointRuntime({
      ...baseOptions({
        provider: "microsoft-teams",
        userName: "Paperclip Agent",
        credentials: {
          appId: "app",
          appPassword: "password",
          appTenantId: " Tenant-Expected ",
          appType: "SingleTenant",
        },
      }),
      callbacks,
    });
    const chat = captures.chats[0] as unknown as {
      handlers: Record<string, (...args: unknown[]) => Promise<unknown>>;
    };
    const thread = { id: "teams:thread" };
    const foreign = {
      id: "message-foreign",
      raw: { channelData: { tenant: { id: "tenant-foreign" } } },
    };
    const missing = { id: "message-missing", raw: {} };

    expect(runtime.acceptsProviderScope(foreign.raw)).toBe(false);
    expect(runtime.acceptsProviderScope(missing.raw)).toBe(false);
    await chat.handlers.direct?.(thread, foreign, {}, {});
    await chat.handlers.mention?.(thread, missing, {});
    await chat.handlers.subscribed?.(thread, foreign, {});
    await chat.handlers.unaddressed?.(thread, missing, {});
    await chat.handlers.updated?.(thread, foreign, undefined);
    await chat.handlers.deleted?.({ raw: missing.raw });
    await chat.handlers.reaction?.({ raw: foreign.raw });
    await chat.handlers.action?.({ raw: missing.raw });
    await chat.handlers.options?.({ raw: foreign.raw });
    await chat.handlers.modalSubmit?.({ raw: missing.raw });
    await chat.handlers.modalClose?.({ raw: foreign.raw });
    await chat.handlers.slash?.({ raw: missing.raw });

    for (const callback of Object.values(callbacks))
      expect(callback).not.toHaveBeenCalled();

    const expectedRaw = {
      conversation: { tenantId: "TENANT-EXPECTED" },
      channelData: { tenant: { id: "tenant-expected" } },
    };
    expect(runtime.acceptsProviderScope(expectedRaw)).toBe(true);
    expect(
      runtime.acceptsProviderScope({
        ...expectedRaw,
        channelData: { tenant: { id: "tenant-foreign" } },
      }),
    ).toBe(false);
    await chat.handlers.mention?.(
      thread,
      { id: "message-expected", raw: expectedRaw },
      {},
    );
    await chat.handlers.reaction?.({ raw: expectedRaw });
    await chat.handlers.action?.({ raw: expectedRaw });
    await chat.handlers.modalSubmit?.({ raw: expectedRaw });

    expect(callbacks.onMessage).toHaveBeenCalledTimes(1);
    expect(callbacks.onReaction).toHaveBeenCalledTimes(1);
    expect(callbacks.onAction).toHaveBeenCalledTimes(1);
    expect(callbacks.onModalSubmit).toHaveBeenCalledTimes(1);
  });

  it("registers optional interaction callbacks only when supplied", () => {
    createChatSdkEndpointRuntime({
      ...baseOptions({
        provider: "telegram",
        userName: "paperclip_bot",
        credentials: { botToken: "token", secretToken: "secret" },
      }),
      callbacks: {
        onMessage: vi.fn(),
        onAction: vi.fn(),
        onModalSubmit: vi.fn(),
        onOptionsLoad: vi.fn(),
        onReaction: vi.fn(),
        onSlashCommand: vi.fn(),
      },
    });
    const chat = captures.chats[0] as unknown as {
      handlers: Record<string, unknown>;
    };
    expect(Object.keys(chat.handlers).sort()).toEqual([
      "action",
      "direct",
      "mention",
      "modalSubmit",
      "options",
      "reaction",
      "slash",
      "subscribed",
      "unaddressed",
    ]);
  });

  it("routes webhooks and shuts down replaced endpoint instances", async () => {
    const registry = createChatSdkRuntime();
    const options = baseOptions({
      provider: "slack",
      userName: "agent",
      credentials: { botToken: "token", signingSecret: "secret" },
    });
    await registry.replaceEndpoint(options);
    const firstChat = captures.chats[0] as unknown as { shutdownCalls: number };
    const response = await registry.handleWebhook(
      "endpoint-1",
      new Request("https://paperclip.test/api/chat/webhooks/endpoint-1", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("slack");

    await registry.replaceEndpoint(options);
    expect(firstChat.shutdownCalls).toBe(1);
    expect(registry.list()).toHaveLength(1);
    expect(await registry.removeEndpoint("endpoint-1")).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it("waits for every SDK background callback without an external waitUntil", async () => {
    const runtime = createChatSdkEndpointRuntime(
      baseOptions({
        provider: "slack",
        userName: "agent",
        credentials: { botToken: "token", signingSecret: "secret" },
      }),
    );
    const firstTask = deferred();
    const rejectedTask = deferred();
    let callbacksRegistered = false;
    const chat = captures.chats[0] as unknown as {
      webhooks: Record<
        string,
        (
          request: Request,
          options?: CapturedWebhookOptions,
        ) => Promise<Response>
      >;
    };
    chat.webhooks.slack = async (_request, options) => {
      options?.waitUntil?.(firstTask.promise);
      options?.waitUntil?.(rejectedTask.promise);
      callbacksRegistered = true;
      return new Response("accepted", { status: 202 });
    };

    let responseSettled = false;
    const responsePromise = runtime
      .handleWebhook(
        new Request("https://paperclip.test/api/chat/webhooks/endpoint-1", {
          method: "POST",
        }),
      )
      .then((response) => {
        responseSettled = true;
        return response;
      });

    await vi.waitFor(() => expect(callbacksRegistered).toBe(true));
    expect(responseSettled).toBe(false);

    firstTask.resolve();
    await Promise.resolve();
    expect(responseSettled).toBe(false);

    rejectedTask.reject(new Error("durable callback failed"));
    const response = await responsePromise;
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("accepted");
  });

  it("still waits for durable ingress when an external waitUntil owns background lifetime", async () => {
    const runtime = createChatSdkEndpointRuntime(
      baseOptions({
        provider: "slack",
        userName: "agent",
        credentials: { botToken: "token", signingSecret: "secret" },
      }),
    );
    const backgroundTask = deferred();
    let backgroundSettled = false;
    void backgroundTask.promise.then(
      () => {
        backgroundSettled = true;
      },
      () => {
        backgroundSettled = true;
      },
    );
    const externalWaitUntil = vi.fn((task: Promise<unknown>) => {
      // A real platform lifecycle owns this promise. Attach a rejection handler
      // in the test so the delegated task can be cleaned up safely.
      void task.catch(() => undefined);
    });
    const chat = captures.chats[0] as unknown as {
      webhooks: Record<
        string,
        (
          request: Request,
          options?: CapturedWebhookOptions,
        ) => Promise<Response>
      >;
    };
    chat.webhooks.slack = async (_request, options) => {
      options?.waitUntil?.(backgroundTask.promise);
      return new Response("delegated", { status: 202 });
    };

    let responseSettled = false;
    const responsePromise = runtime
      .handleWebhook(
        new Request("https://paperclip.test/api/chat/webhooks/endpoint-1", {
          method: "POST",
        }),
        { waitUntil: externalWaitUntil },
      )
      .then((response) => {
        responseSettled = true;
        return response;
      });

    await vi.waitFor(() => expect(externalWaitUntil).toHaveBeenCalledTimes(1));
    expect(responseSettled).toBe(false);
    expect(externalWaitUntil).toHaveBeenCalledTimes(1);
    expect(externalWaitUntil).toHaveBeenCalledWith(backgroundTask.promise);
    expect(backgroundSettled).toBe(false);

    backgroundTask.resolve();
    await backgroundTask.promise;
    const response = await responsePromise;
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("delegated");
  });

  it("returns a retryable non-2xx when the durable delivery callback fails, then accepts a provider retry", async () => {
    const onMessage = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("chat_deliveries insert failed"))
      .mockResolvedValueOnce(undefined);
    const runtime = createChatSdkEndpointRuntime({
      ...baseOptions({
        provider: "slack",
        userName: "agent",
        credentials: { botToken: "token", signingSecret: "secret" },
      }),
      callbacks: { onMessage },
    });
    const chat = captures.chats[0] as unknown as {
      handlers: Record<string, (...args: unknown[]) => Promise<void>>;
      webhooks: Record<
        string,
        (
          request: Request,
          options?: CapturedWebhookOptions,
        ) => Promise<Response>
      >;
    };
    const thread = { id: "slack:C1:1", channelId: "C1" };
    const message = { id: "1", author: { isMe: false } };
    chat.webhooks.slack = async (_request, options) => {
      const callback = chat.handlers.mention?.(thread, message);
      options?.waitUntil?.(callback.catch(() => undefined));
      return new Response("ok", { status: 200 });
    };

    const first = await runtime.handleWebhook(
      new Request("https://paperclip.test/api/chat/webhooks/endpoint-1", {
        method: "POST",
      }),
    );
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("1");
    expect(await first.text()).toContain("durably accept");

    const retried = await runtime.handleWebhook(
      new Request("https://paperclip.test/api/chat/webhooks/endpoint-1", {
        method: "POST",
      }),
    );
    expect(retried.status).toBe(200);
    expect(await retried.text()).toBe("ok");
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("waits for delayed callback registration before acknowledging durable ingress", async () => {
    const callbackGate = deferred();
    const onMessage = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("delayed durable insert failed"));
    const runtime = createChatSdkEndpointRuntime({
      ...baseOptions({
        provider: "telegram",
        userName: "agent",
        credentials: {
          botToken: "token",
          secretToken: "secret",
        },
      }),
      callbacks: { onMessage },
      webhookIngressTimeoutMs: 1_000,
    });
    const chat = captures.chats[0] as unknown as {
      handlers: Record<string, (...args: unknown[]) => Promise<void>>;
      webhooks: Record<
        string,
        (
          request: Request,
          options?: CapturedWebhookOptions,
        ) => Promise<Response>
      >;
    };
    const thread = { id: "telegram:1", channelId: "telegram:1" };
    const message = { id: "telegram:1:1", author: { isMe: false } };
    chat.webhooks.telegram = async (_request, options) => {
      const delayedDispatch = (async () => {
        await callbackGate.promise;
        await chat.handlers.direct?.(thread, message);
      })();
      options?.waitUntil?.(delayedDispatch);
      return new Response("ok", { status: 200 });
    };

    let settled = false;
    const responsePromise = runtime
      .handleWebhook(new Request("https://paperclip.test/telegram"))
      .then((response) => {
        settled = true;
        return response;
      });
    await Promise.resolve();
    expect(settled).toBe(false);

    callbackGate.resolve();
    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("carries Telegram update_id into the normalized message callback", async () => {
    const onMessage = vi.fn();
    const runtime = createChatSdkEndpointRuntime({
      ...baseOptions({
        provider: "telegram",
        userName: "agent",
        credentials: {
          botToken: "token",
          secretToken: "secret",
        },
      }),
      callbacks: { onMessage },
    });
    const chat = captures.chats[0] as unknown as {
      handlers: Record<string, (...args: unknown[]) => Promise<void>>;
      webhooks: Record<
        string,
        (
          request: Request,
          options?: CapturedWebhookOptions,
        ) => Promise<Response>
      >;
    };
    const thread = { id: "telegram:1", channelId: "telegram:1" };
    const message = {
      id: "telegram:1:42",
      raw: { message_id: 42 },
      author: { isMe: false },
    };
    chat.webhooks.telegram = async (_request, options) => {
      options?.waitUntil?.(chat.handlers.direct?.(thread, message));
      return new Response("ok", { status: 200 });
    };

    const response = await runtime.handleWebhook(
      new Request("https://paperclip.test/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          update_id: 987654,
          message: { message_id: 42 },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ providerUpdateId: 987654 }),
    );
  });

  it("returns a retryable response before a provider deadline when ingress work stalls", async () => {
    const stalled = deferred();
    const runtime = createChatSdkEndpointRuntime({
      ...baseOptions({
        provider: "telegram",
        userName: "agent",
        credentials: {
          botToken: "token",
          secretToken: "secret",
        },
      }),
      webhookIngressTimeoutMs: 25,
    });
    const chat = captures.chats[0] as unknown as {
      webhooks: Record<
        string,
        (
          request: Request,
          options?: CapturedWebhookOptions,
        ) => Promise<Response>
      >;
    };
    chat.webhooks.telegram = async (_request, options) => {
      options?.waitUntil?.(stalled.promise);
      return new Response("ok", { status: 200 });
    };

    const startedAt = Date.now();
    const response = await runtime.handleWebhook(
      new Request("https://paperclip.test/telegram"),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(Date.now() - startedAt).toBeLessThan(500);
    stalled.resolve();
    await stalled.promise;
  });

  it("fails closed for unknown endpoint ids", async () => {
    const registry = createChatSdkRuntime();
    await expect(
      registry.handleWebhook(
        "missing",
        new Request("https://paperclip.test/api/chat/webhooks/missing", {
          method: "POST",
        }),
      ),
    ).rejects.toBeInstanceOf(ChatSdkEndpointNotRegisteredError);
  });
});
