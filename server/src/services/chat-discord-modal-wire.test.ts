import { createRequire } from "node:module";
import { Modal, Select, SelectOption, TextInput } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatSdkEndpointRuntime,
  type ChatSdkEndpointRuntime,
  type ChatSdkRuntimeCallbacks,
} from "./chat-sdk-runtime.js";
import type {
  ChatSdkStatePersistence,
  ChatSdkStateRecord,
  ChatSdkStateScope,
} from "./chat-sdk-state.js";

interface WireClient {
  guilds: { _add(data: Record<string, unknown>): { id: string } };
  channels: {
    _add(data: Record<string, unknown>, guild: { id: string }): unknown;
  };
  rest: {
    post(route: string, options: Record<string, unknown>): Promise<unknown>;
  };
  destroy(): Promise<void>;
}
interface WireInteraction {
  id: string;
  customId: string;
  replied: boolean;
  deferred: boolean;
  components?: unknown[];
}

// Resolve the adapter's own pinned discord.js, not a separately installed test
// dependency. These are actual constructors and response methods, never mocks.
const discordJs = createRequire(import.meta.resolve("@chat-adapter/discord"))(
  "discord.js",
) as {
  Client: new (options: { intents: number[] }) => WireClient;
  ButtonInteraction: new (
    client: WireClient,
    data: Record<string, unknown>,
  ) => WireInteraction;
  ModalSubmitInteraction: new (
    client: WireClient,
    data: Record<string, unknown>,
  ) => WireInteraction;
};

const guildId = "1457808928258658549";
const channelId = "333333333333333333";
const threadId = "555555555555555610";
const applicationId = "123456789012345678";
const userId = "444444444444444410";
const messageId = "666666666666666610";
const callbackId = `pcfs:${"A".repeat(22)}`;
const selectId = `pcff:${"B".repeat(22)}`;
const optionId = `pcfo:${"C".repeat(22)}`;
const textId = `pcff:${"D".repeat(22)}`;
const token = "synthetic-discord-wire-interaction-token";

function modal() {
  return Modal({
    callbackId,
    privateMetadata: callbackId,
    title: "Deployment details",
    children: [
      Select({
        id: selectId,
        label: "Environment",
        options: [SelectOption({ label: "Staging", value: optionId })],
      }),
      TextInput({
        id: textId,
        label: "Release note",
        maxLength: 4000,
        multiline: true,
      }),
    ],
  });
}

function envelope(type: 3 | 5, data: Record<string, unknown>) {
  return {
    id: type === 3 ? "777777777777777710" : "777777777777777711",
    application_id: applicationId,
    type,
    token,
    version: 1,
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
    authorizing_integration_owners: { "0": guildId },
    data,
    message: {
      id: messageId,
      channel_id: threadId,
      type: 0,
      author: {
        id: applicationId,
        username: "maya",
        discriminator: "0",
        avatar: null,
        bot: true,
      },
      content: "Please provide deployment details",
      timestamp: "2026-09-09T00:00:00.000Z",
      attachments: [],
      embeds: [],
      components: [],
    },
  };
}

function memoryPersistence() {
  const rows = new Map<string, ChatSdkStateRecord>();
  const keyFor = (scope: ChatSdkStateScope, key: string) =>
    JSON.stringify([scope.companyId, scope.endpointId, key]);
  const persistence: ChatSdkStatePersistence = {
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
  return { rows, persistence };
}

// Wire JSON -> installed discord.js -> installed adapter -> Chat SDK -> scoped
// runtime callback. Only REST post returns a provider result. Other network is
// denied, so SDK source-message lookup exercises its supported missing-message
// fallback. Callback observers stop short of service/DB or live Discord proof.
describe("Discord modal installed discord.js wire contract", () => {
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

  async function harness(callbacks: Partial<ChatSdkRuntimeCallbacks> = {}) {
    const { rows, persistence } = memoryPersistence();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Provider network is disabled");
      }),
    );
    const runtime = createChatSdkEndpointRuntime({
      companyId: "company-discord-wire",
      endpointId: "endpoint-discord-wire",
      callbacks: { onMessage() {}, ...callbacks },
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
    const client = new discordJs.Client({ intents: [] });
    clients.push(client);
    const guild = client.guilds._add({
      id: guildId,
      name: "Wire fixture",
      unavailable: false,
    });
    client.channels._add(
      {
        id: threadId,
        type: 11,
        guild_id: guildId,
        parent_id: channelId,
        name: "deployment",
        thread_metadata: {
          archived: false,
          archive_timestamp: "2026-09-09T00:00:00.000Z",
          auto_archive_duration: 60,
          locked: false,
        },
      },
      guild,
    );
    const post = vi.spyOn(client.rest, "post").mockResolvedValue(undefined);
    const adapter = runtime.getProviderAdapter() as unknown as {
      handleGatewayInteraction(interaction: WireInteraction): Promise<void>;
    };
    const button = () =>
      new discordJs.ButtonInteraction(
        client,
        envelope(3, {
          component_type: 2,
          custom_id: `pcf:${"E".repeat(22)}`,
        }),
      );
    const submit = (customId: string, value = "Ship safely") =>
      new discordJs.ModalSubmitInteraction(
        client,
        envelope(5, {
          custom_id: customId,
          components: [
            {
              type: 18,
              id: 1,
              component: {
                type: 3,
                id: 2,
                custom_id: selectId,
                values: [optionId],
              },
            },
            {
              type: 18,
              id: 3,
              component: { type: 4, id: 4, custom_id: textId, value },
            },
          ],
        }),
      );
    return { rows, adapter, post, button, submit };
  }

  it("posts modern Label modal JSON once with exact opaque IDs and token-free SDK state", async () => {
    const onAction = vi.fn<NonNullable<ChatSdkRuntimeCallbacks["onAction"]>>(
      async ({ event }) => {
        await event.openModal!(modal());
      },
    );
    const h = await harness({ onAction });
    const button = h.button();
    await h.adapter.handleGatewayInteraction(button);
    expect(h.post).toHaveBeenCalledTimes(1);
    const [route, options] = h.post.mock.calls[0]!;
    expect(route).toBe(`/interactions/${button.id}/${token}/callback`);
    expect(options.auth).toBe(false);
    expect(options.body).toEqual({
      type: 9,
      data: {
        custom_id: expect.stringMatching(
          new RegExp(`^${callbackId}:[0-9a-f-]{36}$`),
        ),
        title: "Deployment details",
        components: [
          {
            type: 18,
            label: "Environment",
            component: {
              type: 3,
              custom_id: selectId,
              options: [{ label: "Staging", value: optionId }],
              required: true,
              min_values: 1,
              max_values: 1,
            },
          },
          {
            type: 18,
            label: "Release note",
            component: {
              type: 4,
              custom_id: textId,
              style: 2,
              required: true,
              max_length: 4000,
            },
          },
        ],
      },
    });
    expect(button.replied).toBe(true);
    expect(button.deferred).toBe(false);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]![0]).toMatchObject({
      transport: "discord_gateway",
      event: {
        threadId: `discord:${guildId}:${channelId}:${threadId}`,
        messageId,
        user: { userId },
      },
    });
    expect(h.rows.size).toBeGreaterThan(0);
    expect(JSON.stringify([...h.rows])).toContain(messageId);
    expect(JSON.stringify([...h.rows])).not.toContain(token);
    expect(JSON.stringify(onAction.mock.calls[0]![0].event.raw)).not.toContain(
      token,
    );
  });

  it("does not defer, reply, or retry after actual showModal REST failure", async () => {
    const onAction = vi.fn<NonNullable<ChatSdkRuntimeCallbacks["onAction"]>>(
      async ({ event }) => {
        await event.openModal!(modal());
      },
    );
    const h = await harness({ onAction });
    h.post.mockRejectedValue(new Error("Synthetic ambiguous callback failure"));
    const button = h.button();
    await h.adapter.handleGatewayInteraction(button);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]![1].body).toMatchObject({ type: 9 });
    expect(button.replied).toBe(false);
    expect(button.deferred).toBe(false);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...h.rows])).not.toContain(token);
  });

  it.each(["accepted", "denied"])(
    "parses actual Label submit values and sends one private %s response",
    async (outcome) => {
      const onModalSubmit = vi.fn<
        NonNullable<ChatSdkRuntimeCallbacks["onModalSubmit"]>
      >(async () =>
        outcome === "accepted"
          ? { action: "clear" as const }
          : {
              action: "errors" as const,
              errors: { _form: "This response was not accepted." },
            },
      );
      const h = await harness({
        onAction: async ({ event }) => {
          await event.openModal!(modal());
        },
        onModalSubmit,
      });
      await h.adapter.handleGatewayInteraction(h.button());
      const body = h.post.mock.calls[0]![1].body as {
        data: { custom_id: string };
      };
      const before = JSON.stringify([...h.rows]);
      expect(before).toContain(messageId);
      expect(before).not.toContain(token);
      h.post.mockClear();
      const submission = h.submit(body.data.custom_id);
      expect(submission.components).toEqual([
        {
          type: 18,
          id: 1,
          component: { type: 3, id: 2, customId: selectId, values: [optionId] },
        },
        {
          type: 18,
          id: 3,
          component: { type: 4, id: 4, customId: textId, value: "Ship safely" },
        },
      ]);
      await h.adapter.handleGatewayInteraction(submission);
      expect(onModalSubmit).toHaveBeenCalledTimes(1);
      expect(onModalSubmit.mock.calls[0]![0]).toMatchObject({
        transport: "discord_gateway",
        event: {
          callbackId,
          privateMetadata: callbackId,
          values: { [selectId]: optionId, [textId]: "Ship safely" },
          user: { userId },
          relatedThread: { id: `discord:${guildId}:${channelId}:${threadId}` },
        },
      });
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.post.mock.calls[0]![0]).toBe(
        `/interactions/${submission.id}/${token}/callback`,
      );
      expect(h.post.mock.calls[0]![1]).toMatchObject({
        auth: false,
        body: {
          type: 4,
          data: {
            content:
              outcome === "accepted"
                ? "Your response was received."
                : "This response was not accepted. Open the linked Paperclip task or reopen the question to try again.",
            flags: 64,
            allowed_mentions: { parse: [] },
          },
        },
      });
      expect(submission.replied).toBe(true);
      expect(submission.deferred).toBe(false);
      expect(JSON.stringify([...h.rows])).not.toContain(token);
      expect(JSON.stringify(onModalSubmit.mock.calls[0]![0])).not.toContain(
        token,
      );
    },
  );
});
