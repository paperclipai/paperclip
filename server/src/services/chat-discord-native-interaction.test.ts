import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatSdkEndpointRuntime,
  type ChatSdkEndpointRuntime,
  type ChatSdkRuntimeCallbacks,
} from "./chat-sdk-runtime.js";
import {
  type ChatSdkStatePersistence,
  type ChatSdkStateRecord,
  type ChatSdkStateScope,
} from "./chat-sdk-state.js";
import { createChatQuestionOptionActionToken } from "./chat-interaction-publications.js";

const guildId = "1457808928258658549";
const parentChannelId = "333333333333333333";
const threadChannelId = "555555555555555610";
const applicationId = "123456789012345678";
const externalUserId = "444444444444444410";
const messageId = "666666666666666610";
const interactionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type ActionCallback = NonNullable<ChatSdkRuntimeCallbacks["onAction"]>;

function component(customId: string, overrides: Record<string, unknown> = {}) {
  return {
    applicationId,
    channel: { id: threadChannelId, parentId: parentChannelId, type: 11 },
    channelId: threadChannelId,
    componentType: 2,
    customId,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    guildId,
    id: "777777777777777710",
    isChatInputCommand: () => false,
    isMessageComponent: () => true,
    message: { id: messageId },
    reply: vi.fn().mockResolvedValue(undefined),
    token: "synthetic-interaction-token",
    type: 3,
    user: {
      id: externalUserId,
      username: "discord-user",
      globalName: "Discord User",
      bot: false,
    },
    version: 1,
    ...overrides,
  };
}

// Exercise the installed, compatibility-checked adapter and Chat SDK. Only the
// Discord socket/API and final Paperclip service/DB callback are test doubles;
// this suite does not claim a provider login or a native model continuation.
interface DiscordAdapterSeam {
  handleGatewayInteraction(event: ReturnType<typeof component>): Promise<void>;
  handleComponentInteraction(event: Record<string, unknown>): Promise<void>;
  normalizeGatewayComponentInteraction(
    event: ReturnType<typeof component>,
  ): Record<string, unknown>;
  handleWebhook(request: Request): Promise<Response>;
  buildMessagePayload(message: unknown): { payload: Record<string, unknown> };
}

function memoryPersistence(): ChatSdkStatePersistence {
  const rows = new Map<string, ChatSdkStateRecord>();
  const keyFor = (scope: ChatSdkStateScope, key: string) =>
    JSON.stringify([scope.companyId, scope.endpointId, key]);
  return {
    async read(scope, key) {
      return rows.get(keyFor(scope, key)) ?? null;
    },
    async compareAndSet(input) {
      const key = keyFor(input, input.key);
      const previous = rows.get(key);
      if ((previous?.version ?? null) !== input.expectedVersion) return false;
      rows.set(key, {
        value: input.value,
        expiresAt: input.expiresAt,
        version: (previous?.version ?? 0) + 1,
      });
      return true;
    },
    async deleteIfVersion(input) {
      const key = keyFor(input, input.key);
      if (rows.get(key)?.version !== input.expectedVersion) return false;
      return rows.delete(key);
    },
  };
}

function buttonCustomIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(buttonCustomIds);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.custom_id === "string" ? [record.custom_id] : []),
    ...Object.values(record).flatMap(buttonCustomIds),
  ];
}

describe("Discord native question adapter-to-runtime boundary", () => {
  const runtimes: ChatSdkEndpointRuntime[] = [];
  let fetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetch = vi.fn(async () => {
      throw new Error("This synthetic adapter test must not use the network");
    });
    vi.stubGlobal("fetch", fetch);
  });

  afterEach(async () => {
    try {
      await Promise.all(
        runtimes.splice(0).map((runtime) => runtime.shutdown()),
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  async function harness(
    onAction: ActionCallback,
    scope = { companyId: "company-discord", endpointId: "endpoint-discord" },
    persistence = memoryPersistence(),
  ) {
    const runtime = createChatSdkEndpointRuntime({
      ...scope,
      callbacks: { onAction, onMessage() {} },
      enableDiscordGateway: false,
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "discord",
        userName: "maya",
        credentials: {
          applicationId,
          botToken: "synthetic-bot-token",
          guildId,
        },
      },
    });
    runtimes.push(runtime);
    await runtime.initialize();
    const adapter =
      runtime.getProviderAdapter() as unknown as DiscordAdapterSeam;
    return { adapter, runtime };
  }

  it("round-trips the actual question button envelope into the exact scoped typed callback", async () => {
    const onAction = vi.fn<ActionCallback>();
    const { adapter, runtime } = await harness(onAction);
    const actionId = createChatQuestionOptionActionToken();
    const payload = adapter.buildMessagePayload({
      card: {
        type: "card",
        title: "Which priority should we use?",
        children: [
          {
            type: "actions",
            children: [
              {
                type: "button",
                id: actionId,
                value: interactionId,
                label: "High",
              },
            ],
          },
        ],
      },
    }).payload;
    const customIds = buttonCustomIds(payload);
    expect(customIds).toEqual([`${actionId}\n${interactionId}`]);
    expect(customIds[0]!.length).toBeLessThanOrEqual(100);
    const click = component(customIds[0]!);
    await adapter.handleGatewayInteraction(click);

    expect(onAction).toHaveBeenCalledTimes(1);
    const callback = onAction.mock.calls[0]![0];
    const threadId = `discord:${guildId}:${parentChannelId}:${threadChannelId}`;
    expect(callback).toMatchObject({
      endpointId: "endpoint-discord",
      provider: "discord",
      transport: "discord_gateway",
      event: {
        actionId,
        value: interactionId,
        messageId,
        threadId,
        thread: { id: threadId },
        user: {
          userId: externalUserId,
          userName: "discord-user",
          fullName: "Discord User",
          isBot: false,
          isMe: false,
        },
        raw: {
          guild_id: guildId,
          channel_id: threadChannelId,
          channel: {
            id: threadChannelId,
            parent_id: parentChannelId,
            type: 11,
          },
          data: { custom_id: customIds[0], component_type: 2 },
          id: click.id,
          type: 3,
        },
      },
    });
    expect(callback.event.adapter).toBe(runtime.getProviderAdapter());
    expect(typeof callback.event.openModal).toBe("function");
    // The real parser yields JSON, unlike the hand-built downstream Gateway
    // fixture. No function from the discord.js object survives in event.raw.
    expect(callback.event.raw).not.toHaveProperty("deferUpdate");
    expect(callback.event.raw).not.toHaveProperty("isMessageComponent");
    expect(click.deferUpdate).toHaveBeenCalledOnce();
    expect(click.reply).not.toHaveBeenCalled();
  });

  it("waits for the application callback before acknowledging the click", async () => {
    let entered!: () => void;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onAction = vi.fn<ActionCallback>(async () => {
      entered();
      await held;
    });
    const { adapter } = await harness(onAction);
    const click = component("opaque-action\nopaque-value");
    const processing = adapter.handleGatewayInteraction(click);
    try {
      await observed;
      expect(click.deferUpdate).not.toHaveBeenCalled();
      expect(click.reply).not.toHaveBeenCalled();
    } finally {
      release();
      await processing;
    }
    expect(click.deferUpdate).toHaveBeenCalledOnce();
  });

  it("preserves a retry and duplicate for the application's authoritative ledger", async () => {
    const onAction = vi
      .fn<ActionCallback>()
      .mockRejectedValueOnce(new Error("synthetic ledger unavailable"))
      .mockResolvedValue(undefined);
    const { adapter } = await harness(onAction);
    const first = component("opaque-action\nopaque-value");
    await adapter.handleGatewayInteraction(first);
    const duplicate = component(first.customId);
    await adapter.handleGatewayInteraction(duplicate);
    expect(onAction).toHaveBeenCalledTimes(3);
    expect(
      onAction.mock.calls.map(([input]) => ({
        actionId: input.event.actionId,
        value: input.event.value,
        messageId: input.event.messageId,
        threadId: input.event.threadId,
        userId: input.event.user.userId,
      })),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        actionId: "opaque-action",
        value: "opaque-value",
        messageId,
        threadId: `discord:${guildId}:${parentChannelId}:${threadChannelId}`,
        userId: externalUserId,
      })),
    );
    expect(first.deferUpdate).toHaveBeenCalledOnce();
    expect(duplicate.deferUpdate).toHaveBeenCalledOnce();
    // This seam intentionally does not dedupe before the durable service. It
    // does not by itself prove the downstream exactly-once continuation.
  });

  it("propagates the durable rejection sentinel into an ephemeral denial, not success", async () => {
    const onAction = vi.fn<ActionCallback>(async () => {
      throw Object.assign(new Error("synthetic durable denial"), {
        code: "chat_discord_gateway_action_rejected",
      });
    });
    const { adapter } = await harness(onAction);
    const click = component("opaque-action\nopaque-value");
    await adapter.handleGatewayInteraction(click);
    expect(onAction).toHaveBeenCalledOnce();
    expect(click.deferUpdate).not.toHaveBeenCalled();
    expect(click.reply).toHaveBeenCalledWith({
      content:
        "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
      flags: 64,
    });
  });

  it("rejects a foreign guild without acknowledging success or invoking the application callback", async () => {
    const onAction = vi.fn<ActionCallback>();
    const { adapter } = await harness(onAction);
    const click = component("opaque-action", {
      guildId: "1457808928258658599",
    });
    await adapter.handleGatewayInteraction(click);
    expect(onAction).not.toHaveBeenCalled();
    expect(click.deferUpdate).not.toHaveBeenCalled();
    expect(click.reply).toHaveBeenCalledWith({
      content:
        "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
      flags: 64,
    });
  });

  it("retains DM identity for downstream policy without borrowing the configured guild", async () => {
    const onAction = vi.fn<ActionCallback>();
    const { adapter } = await harness(onAction);
    const click = component("opaque-action", {
      guildId: null,
      channelId: "888888888888888810",
      channel: { id: "888888888888888810", parentId: null, type: 1 },
    });
    await adapter.handleGatewayInteraction(click);
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction.mock.calls[0]![0].event).toMatchObject({
      threadId: "discord:@me:888888888888888810",
      raw: { guild_id: "@me" },
    });
  });

  it("selects the runtime endpoint, never an endpoint asserted by the provider envelope", async () => {
    const persistence = memoryPersistence();
    const onFirst = vi.fn<ActionCallback>();
    const onSecond = vi.fn<ActionCallback>();
    const first = await harness(
      onFirst,
      {
        companyId: "company-first",
        endpointId: "endpoint-first",
      },
      persistence,
    );
    const second = await harness(
      onSecond,
      {
        companyId: "company-second",
        endpointId: "endpoint-second",
      },
      persistence,
    );
    const click = component("opaque-action", {
      endpointId: "endpoint-second",
      companyId: "company-second",
    });
    await first.adapter.handleGatewayInteraction(click);
    expect(onFirst).toHaveBeenCalledOnce();
    expect(onFirst.mock.calls[0]![0].endpointId).toBe("endpoint-first");
    expect(onSecond).not.toHaveBeenCalled();
    expect(onFirst.mock.calls[0]![0].event.raw).not.toHaveProperty("companyId");
    expect(onFirst.mock.calls[0]![0].event.raw).not.toHaveProperty(
      "endpointId",
    );

    await second.adapter.handleGatewayInteraction(component(click.customId));
    expect(onSecond).toHaveBeenCalledOnce();
    expect(onSecond.mock.calls[0]![0].endpointId).toBe("endpoint-second");
  });

  it("isolates simultaneous webhook and Gateway transport contexts without trusting raw markers", async () => {
    const onAction = vi.fn<ActionCallback>();
    const { adapter, runtime } = await harness(onAction);
    let entered!: () => void;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The public Discord webhook verifier is intentionally disabled. Substitute
    // only its dispatch here to exercise runtime ALS isolation; the component
    // normalizer, parser, Chat SDK, and scoped callbacks remain real. This is
    // not a claim that a public webhook has passed Discord authentication.
    const dispatch = vi
      .spyOn(adapter, "handleWebhook")
      .mockImplementation(async () => {
        entered();
        await held;
        await adapter.handleComponentInteraction({
          ...adapter.normalizeGatewayComponentInteraction(
            component("webhook-action"),
          ),
          transport: "discord_gateway",
        });
        await adapter.handleComponentInteraction({
          ...adapter.normalizeGatewayComponentInteraction(
            component("foreign-webhook-action"),
          ),
          guild_id: "1457808928258658599",
          transport: "discord_gateway",
        });
        return new Response(null, { status: 200 });
      });
    const webhook = runtime.handleWebhook(
      new Request("https://paperclip.test/webhook", { method: "POST" }),
    );
    try {
      await observed;
      await adapter.handleGatewayInteraction(
        component("gateway-action", { transport: "webhook" }),
      );
      release();
      expect((await webhook).status).toBe(200);
      expect(onAction).toHaveBeenCalledTimes(2);
      expect(onAction.mock.calls[0]![0]).toMatchObject({
        transport: "discord_gateway",
        event: { actionId: "gateway-action" },
      });
      expect(onAction.mock.calls[1]![0]).not.toHaveProperty("transport");
      expect(onAction.mock.calls[1]![0].event).toMatchObject({
        actionId: "webhook-action",
        raw: { transport: "discord_gateway" },
      });
    } finally {
      release();
      await webhook;
      dispatch.mockRestore();
    }
    expect(
      (
        await runtime.handleWebhook(
          new Request("https://paperclip.test/webhook", {
            method: "POST",
            body: JSON.stringify({ type: 3, transport: "discord_gateway" }),
          }),
        )
      ).status,
    ).toBe(401);
    expect(onAction).toHaveBeenCalledTimes(2);
  });
});
