import * as discord from "@chat-adapter/discord";
import {
  Modal,
  Select,
  SelectOption,
  TextInput,
  type ModalElement,
} from "chat";
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

const guildId = "1457808928258658549";
const channelId = "333333333333333333";
const threadId = "555555555555555610";
const applicationId = "123456789012345678";
const userId = "444444444444444410";
const messageId = "666666666666666610";
const callbackId = `pcfs:${"A".repeat(22)}`;
const contextId = "11111111-1111-4111-8111-111111111111";
const modalCustomId = `${callbackId}:${contextId}`;

function modal(): ModalElement {
  return Modal({
    callbackId,
    privateMetadata: callbackId,
    title: "Deployment details",
    children: [
      Select({
        id: `pcff:${"B".repeat(22)}`,
        label: "Environment",
        options: [
          SelectOption({ label: "Staging", value: `pcfo:${"C".repeat(22)}` }),
          SelectOption({
            label: "Production",
            value: `pcfo:${"D".repeat(22)}`,
          }),
        ],
      }),
      TextInput({
        id: `pcff:${"E".repeat(22)}`,
        label: "Release note",
        maxLength: 4000,
        multiline: true,
      }),
    ],
  });
}

function interaction(overrides: Record<string, unknown> = {}) {
  return {
    applicationId,
    channel: { id: threadId, parentId: channelId, type: 11 },
    channelId: threadId,
    componentType: 2,
    customId: `pcf:${"F".repeat(22)}`,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    guildId,
    id: "777777777777777710",
    isChatInputCommand: () => false,
    isMessageComponent: () => true,
    isModalSubmit: () => false,
    message: { id: messageId },
    reply: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    token: "synthetic-interaction-token-never-persisted",
    type: 3,
    user: {
      id: userId,
      username: "operator",
      globalName: "Operator",
      bot: false,
    },
    version: 1,
    ...overrides,
  };
}

function submit(overrides: Record<string, unknown> = {}) {
  return interaction({
    customId: modalCustomId,
    type: 5,
    isMessageComponent: () => false,
    isModalSubmit: () => true,
    components: [
      {
        type: 18,
        component: {
          type: 3,
          customId: `pcff:${"B".repeat(22)}`,
          values: [`pcfo:${"C".repeat(22)}`],
        },
      },
      {
        type: 18,
        component: {
          type: 4,
          customId: `pcff:${"E".repeat(22)}`,
          value: "Ship safely",
        },
      },
    ],
    ...overrides,
  });
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
  return { persistence, rows };
}

interface AdapterSeam {
  handleGatewayInteraction(
    event: ReturnType<typeof interaction>,
  ): Promise<void>;
  fetchMessage: (...args: unknown[]) => Promise<unknown>;
}

// Real installed adapter, Chat SDK and scoped runtime. Provider socket/HTTP and
// the final service callback are test doubles; this is not live Discord proof.
describe("Discord native modal Gateway bridge", () => {
  const runtimes: ChatSdkEndpointRuntime[] = [];
  afterEach(async () => {
    try {
      await Promise.all(
        runtimes.splice(0).map((runtime) => runtime.shutdown()),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  async function harness(callbacks: Partial<ChatSdkRuntimeCallbacks> = {}) {
    const { persistence, rows } = memoryPersistence();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("No provider network permitted");
      }),
    );
    const runtime = createChatSdkEndpointRuntime({
      companyId: "company-discord-modal",
      endpointId: "endpoint-discord-modal",
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
    const adapter = runtime.getProviderAdapter() as unknown as AdapterSeam;
    // Chat SDK fetches the source message while storing its modal context.
    adapter.fetchMessage = vi.fn().mockResolvedValue(null);
    return { adapter, runtime, rows };
  }

  it("renders native Label select and text components without changing opaque values", () => {
    const render = (
      discord as unknown as {
        modalToDiscordPayload?: (
          modal: ModalElement,
          contextId: string,
        ) => Record<string, unknown>;
      }
    ).modalToDiscordPayload;
    expect(render).toBeTypeOf("function");
    expect(render!(modal(), contextId)).toEqual({
      custom_id: modalCustomId,
      title: "Deployment details",
      components: [
        {
          type: 18,
          label: "Environment",
          component: {
            type: 3,
            custom_id: `pcff:${"B".repeat(22)}`,
            required: true,
            min_values: 1,
            max_values: 1,
            options: [
              { label: "Staging", value: `pcfo:${"C".repeat(22)}` },
              { label: "Production", value: `pcfo:${"D".repeat(22)}` },
            ],
          },
        },
        {
          type: 18,
          label: "Release note",
          component: {
            type: 4,
            custom_id: `pcff:${"E".repeat(22)}`,
            style: 2,
            required: true,
            max_length: 4000,
          },
        },
      ],
    });
  });

  it("opens through actual Chat SDK and consumes exactly the initial modal response", async () => {
    const opened = vi.fn();
    const { adapter, rows } = await harness({
      onAction: async ({ event }) => {
        opened(await event.openModal(modal()));
      },
    });
    const click = interaction();
    await adapter.handleGatewayInteraction(click);
    expect(click.showModal).toHaveBeenCalledOnce();
    expect(click.showModal.mock.calls[0]![0]).toMatchObject({
      title: "Deployment details",
      components: [{ type: 18 }, { type: 18 }],
    });
    expect(opened).toHaveBeenCalledWith({
      viewId: click.showModal.mock.calls[0]![0].custom_id,
    });
    expect(click.deferUpdate).not.toHaveBeenCalled();
    expect(click.reply).not.toHaveBeenCalled();
    expect(JSON.stringify([...rows])).not.toContain(click.token);
  });

  it("parses a native modal submit into exact scoped callback and privately acknowledges durable clear", async () => {
    const onModalSubmit = vi
      .fn<NonNullable<ChatSdkRuntimeCallbacks["onModalSubmit"]>>()
      .mockResolvedValue({ action: "clear" });
    const { adapter } = await harness({ onModalSubmit });
    const submission = submit();
    await adapter.handleGatewayInteraction(submission);
    expect(onModalSubmit).toHaveBeenCalledOnce();
    expect(onModalSubmit.mock.calls[0]![0]).toMatchObject({
      endpointId: "endpoint-discord-modal",
      provider: "discord",
      transport: "discord_gateway",
      event: {
        callbackId,
        privateMetadata: callbackId,
        user: { userId },
        values: {
          [`pcff:${"B".repeat(22)}`]: `pcfo:${"C".repeat(22)}`,
          [`pcff:${"E".repeat(22)}`]: "Ship safely",
        },
        raw: {
          guild_id: guildId,
          channel_id: threadId,
          message: { id: messageId },
          type: 5,
        },
      },
    });
    expect(submission.reply).toHaveBeenCalledWith({
      content: "Your response was received.",
      flags: 64,
      allowedMentions: { parse: [] },
    });
    expect(submission.showModal).not.toHaveBeenCalled();
    expect(submission.deferUpdate).not.toHaveBeenCalled();
  });

  it.each([
    "empty",
    "six fields",
    "26 options",
    "duplicate fields",
    "foreign metadata",
    "oversized title",
    "oversized label",
    "oversized input",
  ])("rejects unsupported renderer shape: %s", (variant) => {
    const value = modal();
    if (variant === "empty") value.children = [];
    if (variant === "six fields")
      value.children = Array.from({ length: 6 }, (_, index) => ({
        ...value.children[1]!,
        id: `pcff:${String(index).repeat(22)}`,
      }));
    if (variant === "26 options" && value.children[0]?.type === "select")
      value.children[0].options = Array.from({ length: 26 }, (_, index) =>
        SelectOption({
          label: "Choice",
          value: `pcfo:${String(index).padStart(22, "0")}`,
        }),
      );
    if (variant === "duplicate fields")
      value.children = [value.children[0]!, value.children[0]!];
    if (variant === "foreign metadata") value.privateMetadata = "other";
    if (variant === "oversized title") value.title = "t".repeat(46);
    if (
      variant === "oversized label" &&
      value.children[1]?.type === "text_input"
    )
      value.children[1].label = "l".repeat(46);
    if (
      variant === "oversized input" &&
      value.children[1]?.type === "text_input"
    )
      value.children[1].maxLength = 4001;
    expect(() => discord.modalToDiscordPayload(value, contextId)).toThrow(
      "Unsupported Discord modal shape",
    );
  });

  it("does not retry or acknowledge an ambiguous initial modal response", async () => {
    const onAction = vi.fn<NonNullable<ChatSdkRuntimeCallbacks["onAction"]>>(
      async ({ event }) => {
        await event.openModal(modal());
      },
    );
    const { adapter } = await harness({ onAction });
    const click = interaction({
      showModal: vi
        .fn()
        .mockRejectedValue(new Error("synthetic connection loss")),
    });
    await adapter.handleGatewayInteraction(click);
    expect(onAction).toHaveBeenCalledOnce();
    expect(click.showModal).toHaveBeenCalledOnce();
    expect(click.reply).not.toHaveBeenCalled();
    expect(click.deferUpdate).not.toHaveBeenCalled();
  });

  it("does not turn an application-swallowed unsupported modal into a success ACK", async () => {
    const { adapter } = await harness({
      onAction: async ({ event }) => {
        try {
          await event.openModal({ ...modal(), children: [] });
        } catch {
          /* Simulates durable modal-open failure audit. */
        }
      },
    });
    const click = interaction();
    await adapter.handleGatewayInteraction(click);
    expect(click.showModal).not.toHaveBeenCalled();
    expect(click.deferUpdate).not.toHaveBeenCalled();
    expect(click.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "This form could not be opened. Open the linked Paperclip task.",
        flags: 64,
      }),
    );
  });

  it.each([
    "missing callback",
    "throwing callback",
    "unknown response",
    "foreign guild",
    "malformed field",
    "duplicate field",
    "malformed callback",
  ])(
    "returns private failure, never success or a modal, for %s",
    async (variant) => {
      const onModalSubmit = vi
        .fn<NonNullable<ChatSdkRuntimeCallbacks["onModalSubmit"]>>()
        .mockResolvedValue({ action: "clear" });
      if (variant === "throwing callback")
        onModalSubmit.mockRejectedValue(
          new Error("secret provider error not visible"),
        );
      if (variant === "unknown response")
        onModalSubmit.mockResolvedValue({ action: "update", modal: modal() });
      const { adapter } = await harness(
        variant === "missing callback" ? {} : { onModalSubmit },
      );
      const input = submit();
      if (variant === "foreign guild") input.guildId = "999999999999999999";
      if (variant === "malformed field")
        (input as unknown as { components: unknown[] }).components = [
          {
            type: 18,
            component: { type: 4, customId: "untrusted", value: "x" },
          },
        ];
      if (variant === "duplicate field")
        (input as unknown as { components: unknown[] }).components = Array(
          2,
        ).fill({
          type: 18,
          component: {
            type: 4,
            customId: `pcff:${"E".repeat(22)}`,
            value: "x",
          },
        });
      if (variant === "malformed callback") input.customId = "foreign-token";
      await adapter.handleGatewayInteraction(input);
      expect(input.reply).toHaveBeenCalledWith({
        content:
          "This response was not accepted. Open the linked Paperclip task or reopen the question to try again.",
        flags: 64,
        allowedMentions: { parse: [] },
      });
      expect(input.showModal).not.toHaveBeenCalled();
      expect(input.deferUpdate).not.toHaveBeenCalled();
      if (
        [
          "foreign guild",
          "malformed field",
          "duplicate field",
          "malformed callback",
        ].includes(variant)
      )
        expect(onModalSubmit).not.toHaveBeenCalled();
    },
  );

  it("uses the explicit internal correction response only for a private reopen button", async () => {
    const actionId = `pcfr:${"R".repeat(43)}`;
    const { adapter } = await harness({
      onModalSubmit: async () => ({
        action: "errors",
        errors: { field: "Required" },
        paperclipDiscordCorrection: {
          version: 1,
          actionId,
          message: "Release note: Please provide an answer.",
        },
      }),
    });
    const input = submit();
    await adapter.handleGatewayInteraction(input);
    expect(input.reply).toHaveBeenCalledWith({
      content: "Release note: Please provide an answer.",
      flags: 64,
      allowedMentions: { parse: [] },
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: "Edit answers", custom_id: actionId },
          ],
        },
      ],
    });
    expect(input.showModal).not.toHaveBeenCalled();
  });

  it("retains the durable callback/source when SDK context was consumed by an invalid submission", async () => {
    const onModalSubmit = vi
      .fn<NonNullable<ChatSdkRuntimeCallbacks["onModalSubmit"]>>()
      .mockResolvedValueOnce({
        action: "errors",
        errors: { field: "Required" },
      })
      .mockResolvedValue({ action: "clear" });
    const { adapter, rows } = await harness({
      onAction: async ({ event }) => {
        await event.openModal(modal());
      },
      onModalSubmit,
    });
    const click = interaction();
    await adapter.handleGatewayInteraction(click);
    const realCustomId = click.showModal.mock.calls[0]![0].custom_id;
    await adapter.handleGatewayInteraction(submit({ customId: realCustomId }));
    expect(onModalSubmit.mock.calls[0]![0].event.relatedThread?.id).toBe(
      `discord:${guildId}:${channelId}:${threadId}`,
    );
    await adapter.handleGatewayInteraction(
      submit({ customId: realCustomId, id: "777777777777777711" }),
    );
    expect(onModalSubmit.mock.calls[1]![0].event.relatedThread).toBeUndefined();
    expect(onModalSubmit.mock.calls[1]![0].event).toMatchObject({
      callbackId,
      privateMetadata: callbackId,
      raw: { guild_id: guildId, channel_id: threadId },
    });
    expect(JSON.stringify([...rows])).not.toContain(click.token);
  });
});
