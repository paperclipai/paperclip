import { createHash } from "node:crypto";
import type { SlashCommandEvent } from "chat";
import { z } from "zod";
import type { ChatSdkCallbackEvent } from "./chat-sdk-runtime.js";
import {
  parseDiscordCommandRegistration,
  type DiscordCommandRegistrationScope,
} from "./chat-discord-command-registration.js";

const snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/);
const sourceScope = z
  .object({
    companyId: z.uuid(),
    endpointId: z.uuid(),
    applicationId: snowflake,
    guildId: snowflake,
  })
  .strict();
// This is the runtime's closed token-free normalized object, not arbitrary
// Discord JSON. A caller cannot turn a raw transport hint into Gateway proof.
const rawCommand = z
  .object({
    id: snowflake,
    application_id: snowflake,
    type: z.literal(2),
    version: z.literal(1),
    channel_id: snowflake,
    channel: z
      .object({
        id: snowflake,
        type: z.number().int(),
        parent_id: snowflake.optional(),
      })
      .strict(),
    guild_id: z.union([snowflake, z.literal("@me")]),
    context: z.union([z.literal(0), z.literal(1)]),
    authorizing_integration_owners: z
      .object({ "0": z.union([snowflake, z.literal("0")]) })
      .strict(),
    data: z
      .object({
        id: snowflake,
        type: z.literal(1),
        name: z.literal("paperclip"),
        options: z.tuple([
          z
            .object({
              type: z.literal(1),
              name: z.enum(["status", "new", "close"]),
            })
            .strict(),
        ]),
      })
      .strict(),
    user: z
      .object({
        id: snowflake,
        username: z.string().min(1).max(100),
        global_name: z.string().max(100).nullable().optional(),
        avatar: z.string().max(100).optional(),
        discriminator: z
          .string()
          .regex(/^[0-9]{1,4}$/)
          .optional(),
        bot: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export interface DiscordNativeCommandInvocation {
  schema: "paperclip.discord.native-command.v1";
  interactionId: string;
  applicationId: string;
  registeredCommandId: string;
  command: "status" | "new" | "close";
  actorExternalId: string;
  sourceKind: "direct_message" | "native_thread" | "guild_channel";
  threadId: string;
  channelId: string;
  providerResourceId: string;
  guildId: string | null;
  digest: string;
}

export function parseDiscordNativeCommand(
  callback: ChatSdkCallbackEvent<SlashCommandEvent>,
  scope: DiscordCommandRegistrationScope,
): DiscordNativeCommandInvocation | null {
  if (
    !sourceScope.safeParse(scope).success ||
    callback.provider !== "discord" ||
    callback.transport !== "discord_gateway" ||
    callback.endpointId !== scope.endpointId
  )
    return null;
  const result = rawCommand.safeParse(callback.event.raw);
  if (!result.success) return null;
  const raw = result.data;
  const command = raw.data.options[0].name;
  if (
    raw.application_id !== scope.applicationId ||
    raw.user.bot ||
    raw.user.id === scope.applicationId ||
    callback.event.user.userId !== raw.user.id ||
    callback.event.user.isBot ||
    callback.event.user.isMe ||
    callback.event.command !== `/paperclip ${command}` ||
    callback.event.text !== "" ||
    raw.channel_id !== raw.channel.id
  )
    return null;
  const isDm =
    raw.context === 1 &&
    raw.guild_id === "@me" &&
    raw.authorizing_integration_owners["0"] === "0" &&
    raw.channel.type === 1 &&
    raw.channel.parent_id === undefined;
  const isGuild =
    raw.context === 0 &&
    raw.guild_id === scope.guildId &&
    raw.authorizing_integration_owners["0"] === scope.guildId &&
    [0, 5, 11, 12, 15, 16].includes(raw.channel.type);
  if (!isDm && !isGuild) return null;
  const isThread = raw.channel.type === 11 || raw.channel.type === 12;
  if (isThread && !raw.channel.parent_id) return null;
  const providerResourceId = isThread ? raw.channel.parent_id! : raw.channel_id;
  const channelId = `discord:${isDm ? "@me" : scope.guildId}:${providerResourceId}`;
  const threadId = isThread ? `${channelId}:${raw.channel_id}` : channelId;
  if (
    (callback.event as SlashCommandEvent & { channelId?: unknown })
      .channelId !== threadId ||
    callback.event.channel.id !== threadId
  )
    return null;
  const invocation = {
    schema: "paperclip.discord.native-command.v1" as const,
    interactionId: raw.id,
    applicationId: raw.application_id,
    registeredCommandId: raw.data.id,
    command,
    actorExternalId: raw.user.id,
    sourceKind: isDm
      ? ("direct_message" as const)
      : isThread
        ? ("native_thread" as const)
        : ("guild_channel" as const),
    threadId,
    channelId,
    providerResourceId,
    guildId: isDm ? null : scope.guildId,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify([scope.companyId, scope.endpointId, invocation]))
    .digest("hex");
  return Object.freeze({ ...invocation, digest });
}

export function isCurrentDiscordCommandRegistration(
  action: unknown,
  scope: DiscordCommandRegistrationScope,
  commandId: string,
): boolean {
  if (
    !sourceScope.safeParse(scope).success ||
    !snowflake.safeParse(commandId).success ||
    !action ||
    typeof action !== "object" ||
    Array.isArray(action)
  )
    return false;
  const row = action as Record<string, unknown>;
  if (
    row.companyId !== scope.companyId ||
    row.endpointId !== scope.endpointId ||
    row.conversationId !== null ||
    row.kind !== "discord_command_registration" ||
    row.providerActionId !==
      `discord-command-registration:${scope.applicationId}` ||
    row.status !== "processed" ||
    !row.payload ||
    typeof row.payload !== "object" ||
    Array.isArray(row.payload)
  )
    return false;
  const registration = parseDiscordCommandRegistration(
    (row.payload as Record<string, unknown>).registration,
    scope,
  );
  return (
    registration?.phase === "registered" &&
    registration.receipt.commandId === commandId
  );
}

const targetSchema = z
  .object({
    conversationId: z.uuid(),
    issueId: z.uuid(),
    sessionGeneration: z.number().int().positive(),
  })
  .strict();
const receiptPayloadSchema = z
  .object({
    version: z.literal(1),
    invocation: z.record(z.string(), z.unknown()),
    runtimeFence: z
      .object({
        generation: z.number().int().nonnegative(),
        credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    target: targetSchema.nullable(),
  })
  .strict();
const receiptResultSchema = z
  .object({
    kind: z.literal("discord_native_command_recorded"),
    content: z.string().min(1).max(2000),
    publicationId: z.uuid().nullable(),
  })
  .strict();
export type DiscordNativeCommandTarget = z.infer<typeof targetSchema>;

/** A prior callback is observation-only; fresh source/actor authority is still required. */
export function parseDiscordNativeCommandReceipt(
  action: unknown,
  invocation: DiscordNativeCommandInvocation,
  scope: DiscordCommandRegistrationScope,
) {
  if (!action || typeof action !== "object" || Array.isArray(action))
    return null;
  const row = action as Record<string, unknown>;
  if (
    row.companyId !== scope.companyId ||
    row.endpointId !== scope.endpointId ||
    row.kind !== "discord_native_command" ||
    row.providerActionId !==
      `discord-native-command:${invocation.interactionId}` ||
    row.status !== "processed" ||
    !z.uuid().safeParse(row.principalId).success
  )
    return null;
  const payload = receiptPayloadSchema.safeParse(row.payload);
  const result = receiptResultSchema.safeParse(row.result);
  if (
    !payload.success ||
    !result.success ||
    row.conversationId !== (payload.data.target?.conversationId ?? null)
  )
    return null;
  const stored = payload.data.invocation;
  if (
    Object.keys(stored).length !== Object.keys(invocation).length ||
    !Object.entries(invocation).every(([key, value]) => stored[key] === value)
  )
    return null;
  if (
    result.data.publicationId !== null &&
    (!payload.data.target ||
      invocation.command === "status" ||
      (invocation.command === "new" &&
        invocation.sourceKind !== "direct_message"))
  )
    return null;
  return {
    principalId: row.principalId as string,
    runtimeFence: payload.data.runtimeFence,
    target: payload.data.target,
    result: result.data,
  };
}
