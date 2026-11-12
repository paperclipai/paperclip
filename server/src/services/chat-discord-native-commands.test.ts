import { createHash } from "node:crypto";
import type { SlashCommandEvent } from "chat";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { describe, expect, it } from "vitest";
import type { ChatSdkCallbackEvent } from "./chat-sdk-runtime.js";
import {
  createDiscordCommandRegistration,
  discordPaperclipCommandDefinition,
} from "./chat-discord-command-registration.js";
import {
  isCurrentDiscordCommandRegistration,
  parseDiscordNativeCommand,
  parseDiscordNativeCommandReceipt,
} from "./chat-discord-native-commands.js";

const scope = {
  companyId: "11111111-1111-4111-8111-111111111111",
  endpointId: "22222222-2222-4222-8222-222222222222",
  applicationId: "123456789012345678",
  guildId: "1457808928258658549",
};
const parentId = "333333333333333333";
const threadId = "555555555555555555";
const userId = "444444444444444444";
const commandId = "888888888888888888";
const interactionId = "777777777777777777";
function callback(rawOverrides: Record<string, unknown> = {}) {
  const thread = `discord:${scope.guildId}:${parentId}:${threadId}`;
  return {
    endpointId: scope.endpointId,
    provider: "discord",
    transport: "discord_gateway",
    event: {
      command: "/paperclip status",
      text: "",
      channelId: thread,
      channel: { id: thread },
      user: { userId, isBot: false, isMe: false },
      raw: {
        id: interactionId,
        application_id: scope.applicationId,
        type: 2,
        version: 1,
        channel_id: threadId,
        channel: { id: threadId, type: 11, parent_id: parentId },
        guild_id: scope.guildId,
        context: 0,
        authorizing_integration_owners: { "0": scope.guildId },
        data: {
          id: commandId,
          type: 1,
          name: "paperclip",
          options: [{ type: 1, name: "status" }],
        },
        user: { id: userId, username: "operator", bot: false },
        ...rawOverrides,
      },
    },
  } as unknown as ChatSdkCallbackEvent<
    SlashCommandEvent & { channelId: string }
  >;
}
function registrationAction() {
  const prepared = createDiscordCommandRegistration(scope);
  return {
    companyId: scope.companyId,
    endpointId: scope.endpointId,
    conversationId: null,
    kind: "discord_command_registration",
    providerActionId: `discord-command-registration:${scope.applicationId}`,
    status: "processed",
    payload: {
      registration: {
        ...prepared,
        phase: "registered",
        receipt: {
          commandId,
          version: "999999999999999999",
          definitionDigest: createHash("sha256")
            .update(
              JSON.stringify(
                discordPaperclipCommandDefinition(prepared.ownerId),
              ),
            )
            .digest("hex"),
        },
      },
    },
  };
}

describe("Discord native command service authority parser", () => {
  it("accepts the pinned adapter's actual normalized user fields without treating presentation as authority", () => {
    const adapter = createDiscordAdapter({
      applicationId: scope.applicationId,
      botToken: "synthetic-token",
      webhookVerifier: async () => false,
    }) as unknown as {
      normalizeGatewayUser(input: Record<string, unknown>): unknown;
    };
    const normalized = adapter.normalizeGatewayUser({
      id: userId,
      username: "operator",
      bot: false,
      discriminator: "0",
      avatar: "a_fixture_avatar",
      globalName: "Operator",
    });
    expect(normalized).toMatchObject({
      discriminator: "0",
      avatar: "a_fixture_avatar",
    });
    expect(
      parseDiscordNativeCommand(callback({ user: normalized }), scope),
    ).toMatchObject({ actorExternalId: userId });
  });
  it("preserves exact native thread, registered command, actor and immutable invocation digest", () => {
    const parsed = parseDiscordNativeCommand(callback(), scope);
    expect(parsed).toMatchObject({
      command: "status",
      interactionId,
      applicationId: scope.applicationId,
      registeredCommandId: commandId,
      actorExternalId: userId,
      sourceKind: "native_thread",
      threadId: `discord:${scope.guildId}:${parentId}:${threadId}`,
      channelId: `discord:${scope.guildId}:${parentId}`,
      providerResourceId: parentId,
      guildId: scope.guildId,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("requires the current processed registration receipt, never just a familiar command name", () => {
    expect(
      isCurrentDiscordCommandRegistration(
        registrationAction(),
        scope,
        commandId,
      ),
    ).toBe(true);
  });

  it("preserves explicit bot-DM source without inventing a guild binding", () => {
    const c = callback({
      channel: { id: parentId, type: 1 },
      channel_id: parentId,
      guild_id: "@me",
      context: 1,
      authorizing_integration_owners: { "0": "0" },
    });
    c.event.channelId = `discord:@me:${parentId}`;
    Object.assign(c.event.channel, { id: c.event.channelId });
    expect(parseDiscordNativeCommand(c, scope)).toMatchObject({
      sourceKind: "direct_message",
      guildId: null,
      threadId: `discord:@me:${parentId}`,
      channelId: `discord:@me:${parentId}`,
    });
  });

  it.each([
    ["token-bearing raw", { token: "never-persist-this" }],
    ["foreign application", { application_id: "123456789012345679" }],
    ["foreign guild", { guild_id: "1457808928258658550" }],
    [
      "foreign install",
      { authorizing_integration_owners: { "0": "1457808928258658550" } },
    ],
    [
      "user install",
      { authorizing_integration_owners: { "0": scope.guildId, "1": userId } },
    ],
    ["private context", { context: 2 }],
    ["missing parent", { channel: { id: threadId, type: 11 } }],
    ["wrong channel", { channel_id: parentId }],
    [
      "extra argument",
      {
        data: {
          id: commandId,
          type: 1,
          name: "paperclip",
          options: [
            {
              type: 1,
              name: "status",
              options: [{ type: 3, name: "task", value: "foreign" }],
            },
          ],
        },
      },
    ],
    [
      "unknown command",
      {
        data: {
          id: commandId,
          type: 1,
          name: "paperclip",
          options: [{ type: 1, name: "delete" }],
        },
      },
    ],
    [
      "self",
      { user: { id: scope.applicationId, username: "maya", bot: true } },
    ],
  ])("rejects %s without extracting a command", (_reason, raw) => {
    expect(
      parseDiscordNativeCommand(
        callback(raw as Record<string, unknown>),
        scope,
      ),
    ).toBeNull();
  });

  it("rejects altered runtime-normalized actor, channel, command and ingress context", () => {
    for (const mutate of [
      (c: ReturnType<typeof callback>) => {
        delete c.transport;
      },
      (c: ReturnType<typeof callback>) => {
        c.endpointId = "33333333-3333-4333-8333-333333333333";
      },
      (c: ReturnType<typeof callback>) => {
        c.event.user.userId = "444444444444444445";
      },
      (c: ReturnType<typeof callback>) => {
        c.event.command = "/paperclip close";
      },
      (c: ReturnType<typeof callback>) => {
        c.event.text = "status";
      },
      (c: ReturnType<typeof callback>) => {
        c.event.channelId = `discord:${scope.guildId}:${parentId}`;
      },
      (c: ReturnType<typeof callback>) => {
        Object.assign(c.event.channel, {
          id: `discord:${scope.guildId}:${parentId}`,
        });
      },
    ]) {
      const c = callback();
      mutate(c);
      expect(parseDiscordNativeCommand(c, scope)).toBeNull();
    }
  });

  it("uses exact canonical identity for the digest, not display-name or object-key ordering", () => {
    const first = parseDiscordNativeCommand(callback(), scope)!;
    const renamed = parseDiscordNativeCommand(
      callback({
        user: {
          bot: false,
          username: "renamed",
          global_name: "New Display",
          id: userId,
        },
      }),
      scope,
    )!;
    expect(renamed.digest).toBe(first.digest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(
      parseDiscordNativeCommand(callback({ id: "777777777777777778" }), scope)
        ?.digest,
    ).not.toBe(first.digest);
    expect(
      parseDiscordNativeCommand(callback(), {
        ...scope,
        companyId: "33333333-3333-4333-8333-333333333333",
      })?.digest,
    ).not.toBe(first.digest);
  });

  it("keeps a guild root distinct from an existing native task thread", () => {
    const c = callback({
      channel: { id: parentId, type: 0 },
      channel_id: parentId,
    });
    c.event.channelId = `discord:${scope.guildId}:${parentId}`;
    Object.assign(c.event.channel, { id: c.event.channelId });
    expect(parseDiscordNativeCommand(c, scope)).toMatchObject({
      sourceKind: "guild_channel",
      threadId: c.event.channelId,
    });
    expect(parseDiscordNativeCommand(c, scope)?.digest).not.toBe(
      parseDiscordNativeCommand(callback(), scope)?.digest,
    );
  });

  it("rejects incomplete, foreign, ambiguous and mismatched registration rows", () => {
    const row = registrationAction();
    for (const changed of [
      { ...row, status: "processing" },
      { ...row, endpointId: "33333333-3333-4333-8333-333333333333" },
      { ...row, companyId: "33333333-3333-4333-8333-333333333333" },
      { ...row, kind: "ordinary_action" },
      { ...row, conversationId: "33333333-3333-4333-8333-333333333333" },
      {
        ...row,
        providerActionId: "discord-command-registration:123456789012345679",
      },
      {
        ...row,
        payload: { registration: createDiscordCommandRegistration(scope) },
      },
      {
        ...row,
        payload: {
          registration: {
            ...row.payload.registration,
            receipt: {
              ...row.payload.registration.receipt,
              definitionDigest: "0".repeat(64),
            },
          },
        },
      },
      {
        ...row,
        payload: {
          registration: {
            ...row.payload.registration,
            scope: { ...scope, guildId: "1457808928258658550" },
          },
        },
      },
      null,
    ])
      expect(
        isCurrentDiscordCommandRegistration(changed, scope, commandId),
      ).toBe(false);
    expect(
      isCurrentDiscordCommandRegistration(row, scope, "888888888888888889"),
    ).toBe(false);
  });

  it("returns only the exact processed invocation, origin fence and original target for a replay", () => {
    const invocation = parseDiscordNativeCommand(callback(), scope)!;
    const target = {
      conversationId: scope.endpointId,
      issueId: scope.companyId,
      sessionGeneration: 1,
    };
    const row = {
      ...scope,
      principalId: scope.companyId,
      conversationId: target.conversationId,
      kind: "discord_native_command",
      providerActionId: `discord-native-command:${interactionId}`,
      status: "processed",
      payload: {
        version: 1,
        invocation,
        runtimeFence: { generation: 7, credentialFingerprint: "a".repeat(64) },
        target,
      },
      result: {
        kind: "discord_native_command_recorded",
        content: "Current task status",
        publicationId: null,
      },
    };
    expect(parseDiscordNativeCommandReceipt(row, invocation, scope)).toEqual({
      principalId: scope.companyId,
      runtimeFence: row.payload.runtimeFence,
      target,
      result: row.result,
    });
    for (const changed of [
      { ...row, status: "received" },
      { ...row, companyId: scope.endpointId },
      { ...row, principalId: "" },
      { ...row, conversationId: null },
      { ...row, payload: { ...row.payload, extra: true } },
      {
        ...row,
        payload: {
          ...row.payload,
          invocation: { ...invocation, command: "close" },
        },
      },
      {
        ...row,
        payload: {
          ...row.payload,
          invocation: { ...invocation, extra: "opaque" },
        },
      },
      { ...row, payload: { ...row.payload, runtimeFence: { generation: 7 } } },
      {
        ...row,
        payload: {
          ...row.payload,
          target: { ...target, sessionGeneration: 0 },
        },
      },
      { ...row, result: { ...row.result, publicationId: scope.endpointId } },
      { ...row, result: { ...row.result, content: "" } },
      { ...row, result: { ...row.result, raw: "provider error" } },
    ])
      expect(
        parseDiscordNativeCommandReceipt(changed, invocation, scope),
      ).toBeNull();
  });
});
