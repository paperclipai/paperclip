import {
  createGitHubAdapter,
  type GitHubAdapter,
  type GitHubAdapterConfig,
} from "@chat-adapter/github";
import {
  createDiscordAdapter,
  type DiscordAdapter,
  type DiscordAdapterConfig,
} from "@chat-adapter/discord";
import {
  createSlackAdapter,
  type SlackAdapterConfig,
} from "@chat-adapter/slack";
import {
  createTeamsAdapter,
  type TeamsAdapter,
  type TeamsAdapterConfig,
} from "@chat-adapter/teams";
import {
  createTelegramAdapter,
  type TelegramAdapter,
  type TelegramAdapterConfig,
  type TelegramRawMessage,
} from "@chat-adapter/telegram";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  Chat,
  type ActionEvent,
  type Adapter,
  type Attachment,
  type Author,
  type Channel,
  type ConcurrencyConfig,
  type ConcurrencyStrategy,
  type Logger,
  type Message,
  type MessageContext,
  type MessageDeletedEvent,
  type ModalCloseEvent,
  type ModalResponse,
  type ModalSubmitEvent,
  type OptionsLoadEvent,
  type OptionsLoadResult,
  type ReactionEvent,
  type SlashCommandEvent,
  type Thread,
  type UserInfo,
  type WebhookOptions,
} from "chat";
import type { StateAdapter } from "chat";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import {
  deriveTeamsInlineImageLocator,
  parseTeamsInlineImageLocator,
  teamsInlineImageDownloadUrl,
  type TeamsInlineImageLocator,
  type TeamsInlineImageScope,
} from "./chat-teams-inline-image-intake.js";
import { normalizeTelegramVideoNoteAttachments } from "./chat-telegram-video-note.js";
import {
  hasTelegramMediaProvenance,
  normalizeTelegramMediaAttachments,
  retainTelegramMediaProvenance,
  telegramMediaLocator,
  validateTelegramMediaLocator,
  type TelegramMediaLocator,
  type TelegramMediaScope,
} from "./chat-telegram-media-intake.js";
import { normalizeTelegramRichMessage } from "./chat-telegram-rich-intake.js";
import {
  captureTelegramGenerationStopped,
  telegramPrivateDraftDestination,
  type TelegramDraftControl,
  type TelegramDraftStopped,
  type TelegramGenerationStoppedProof,
} from "./chat-telegram-draft-stop.js";
import {
  applySlackReceiptReaction,
  type SlackReceiptMutation,
} from "./chat-slack-receipts.js";
import {
  applyGitHubReceiptReaction,
  type GitHubReceiptMutation,
} from "./chat-github-receipt-reactions.js";
import {
  captureTelegramCallbackProvenance,
  hasTelegramEphemeralInput,
  sendTelegramCallbackNotice,
  type TelegramCallbackProvenance,
  type TelegramCallbackReceipt,
} from "./chat-telegram-ephemeral.js";
import {
  installTeamsFileConsentHook,
  parseTeamsFileConsentCard,
  parseTeamsUploadedFileCard,
  type buildTeamsFileConsentCard,
  type buildTeamsUploadedFileCard,
  type TeamsConsentApp,
  type TeamsFileConsentEvent,
} from "./chat-teams-file-consent.js";
import {
  githubAttachmentLocator,
  githubAttachmentCommentFetch,
  githubAttachmentDiagnosticCode,
  GitHubAttachmentUnavailableError,
  isGitHubAttachmentCommentRequest,
  githubPublicAttachmentsFromMessage,
  rehydrateGitHubPublicAttachment,
  validateGitHubAttachmentLocator,
  type GitHubPublicAttachmentLocator,
  type GitHubAttachmentCommentRequest,
} from "./chat-github-attachments.js";
import {
  createPaperclipChatSdkState,
  type ChatSdkStatePersistence,
} from "./chat-sdk-state.js";

export const CHAT_SDK_VERSION = "4.39.0";
export const CHAT_SDK_SOURCE_REVISION =
  "51322dde8f4aafd8a7fc7a20cbfd7ae45cafaa5c";
const SLACK_WEB_API_TIMEOUT_MS = 45_000;
const GITHUB_API_TIMEOUT_MS = 25_000;
// discord.js owns resume and reconnect while a Client remains alive. Keep the
// client up for a day instead of deliberately creating a disconnect window
// every few minutes; the outer loop still recovers if the adapter exits.
const DISCORD_GATEWAY_SESSION_MS = 24 * 60 * 60_000;
const DISCORD_GATEWAY_RESTART_MAX_DELAY_MS = 60_000;
const DISCORD_GATEWAY_HEALTHY_SESSION_MS = 60_000;

/** Public Paperclip provider ids. The Teams SDK name remains an internal detail. */
export type ChatSdkProvider =
  "slack" | "github" | "discord" | "microsoft-teams" | "telegram";
type ChatSdkAdapterKey = "slack" | "github" | "discord" | "teams" | "telegram";

interface ProviderConfigBase {
  /** Agent-derived native bot display/mention name. */
  userName: string;
}

export interface ResolvedSlackChatConfig extends ProviderConfigBase {
  provider: "slack";
  credentials: {
    apiUrl?: string;
    botToken: string;
    botUserId?: string;
    signingSecret: string;
  };
}

export type ResolvedGitHubCredentials =
  | {
      apiUrl?: string;
      botUserId?: number;
      token: string;
      webhookSecret: string;
    }
  | {
      apiUrl?: string;
      appId: string;
      botUserId?: number;
      installationId?: number;
      privateKey: string;
      webhookSecret: string;
    };

export interface ResolvedGitHubChatConfig extends ProviderConfigBase {
  provider: "github";
  credentials: ResolvedGitHubCredentials;
}

export interface ResolvedDiscordChatConfig extends ProviderConfigBase {
  provider: "discord";
  credentials: {
    apiUrl?: string;
    applicationId: string;
    botToken: string;
    guildId: string;
  };
}

export interface ResolvedMicrosoftTeamsChatConfig extends ProviderConfigBase {
  provider: "microsoft-teams";
  credentials: {
    apiUrl?: string;
    appId: string;
    appPassword: string;
    appTenantId?: string;
    appType?: "MultiTenant" | "SingleTenant";
  };
}

export interface ResolvedTelegramChatConfig extends ProviderConfigBase {
  provider: "telegram";
  maxDownloadBytes?: number;
  credentials: {
    apiUrl?: string;
    botToken: string;
    secretToken: string;
  };
}

export type ResolvedChatSdkProviderConfig =
  | ResolvedSlackChatConfig
  | ResolvedGitHubChatConfig
  | ResolvedDiscordChatConfig
  | ResolvedMicrosoftTeamsChatConfig
  | ResolvedTelegramChatConfig;

export type ChatSdkMessageTrigger =
  "direct_message" | "mention" | "subscribed_message" | "unaddressed_message";

type DurableAttachmentType = Attachment["type"];

interface DurableAttachmentMetadata {
  height?: number;
  mimeType?: string;
  name?: string;
  size?: number;
  type: DurableAttachmentType;
  width?: number;
}

type ChatSdkAttachmentLocator =
  | GitHubPublicAttachmentLocator
  | TeamsInlineImageLocator
  | TelegramMediaLocator
  | {
      enterpriseId?: string;
      isEnterpriseInstall?: true;
      kind: "slack_private_url";
      teamId?: string;
      url: string;
    }
  | {
      connectorOrigin: string;
      kind: "teams_bot_url";
      url: string;
    }
  | {
      kind: "discord_cdn_url";
      url: string;
    }
  | {
      kind: "teams_anonymous_url";
      url: string;
    }
  | {
      fileId: string;
      fileUniqueId?: string;
      kind: "telegram_file_id";
    };

/**
 * JSON-safe attachment data that may be stored with a durable delivery.
 *
 * This intentionally excludes `fetchData`, binary data, authorization
 * headers, bot/app tokens, signing secrets, and arbitrary adapter metadata.
 * Provider locators are a closed allowlist sufficient for the pinned Chat SDK
 * adapters to rebuild their authenticated download closure after restart.
 */
export interface ChatSdkAttachmentRecoveryDescriptor {
  attachment: DurableAttachmentMetadata;
  locator: ChatSdkAttachmentLocator;
  provider: ChatSdkProvider;
  version: 1;
}

export interface ChatSdkAttachmentSource {
  threadId: string;
  messageId: string;
  runtimeGeneration?: number;
  credentialFingerprint?: string;
  principalExternalId?: string;
  message?: Message;
  isDirectMessage?: boolean;
}

const ATTACHMENT_TYPES = new Set<DurableAttachmentType>([
  "audio",
  "file",
  "image",
  "video",
]);

function boundedAttachmentText(
  value: unknown,
  maximum: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return sanitized ? sanitized.slice(0, maximum) : undefined;
}

function boundedAttachmentNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function durableAttachmentMetadata(
  attachment: Attachment,
): DurableAttachmentMetadata | null {
  if (!ATTACHMENT_TYPES.has(attachment.type)) return null;
  const name = boundedAttachmentText(attachment.name, 512);
  const mimeType = boundedAttachmentText(attachment.mimeType, 255);
  const size = boundedAttachmentNumber(attachment.size);
  const width = boundedAttachmentNumber(attachment.width);
  const height = boundedAttachmentNumber(attachment.height);
  return {
    type: attachment.type,
    ...(name ? { name } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function sanitizedRecoveryUrl(
  value: unknown,
  options?: { allowQuery?: boolean; requiredOrigin?: string },
): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      (options?.requiredOrigin && parsed.origin !== options.requiredOrigin)
    ) {
      return null;
    }
    if (!options?.allowQuery && parsed.search) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function sanitizedRecoveryOrigin(value: unknown): string | null {
  const url = sanitizedRecoveryUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.pathname !== "/" || parsed.search) return null;
  return parsed.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function microsoftTeamsTenantIds(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const conversation = isRecord(raw.conversation) ? raw.conversation : null;
  const channelData = isRecord(raw.channelData) ? raw.channelData : null;
  const tenant =
    channelData && isRecord(channelData.tenant) ? channelData.tenant : null;
  return (
    [conversation?.tenantId, tenant?.id]
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      // Microsoft Entra tenant IDs are UUIDs (or, for some supported identity
      // configurations, DNS-style tenant names). Both forms are
      // case-insensitive. A user can paste a mixed-case value that the token
      // endpoint accepts while Bot Framework emits the canonical lowercase
      // form, so normalize before enforcing the endpoint boundary.
      .map((value) => value.trim().toLowerCase())
  );
}

/** Chat SDK-normalized inbound message plus Paperclip endpoint identity. */
export interface ChatSdkMessageCallbackEvent {
  context?: MessageContext;
  endpointId: string;
  message: Message;
  /** Telegram's monotonic webhook update id, when this callback came from a webhook. */
  providerUpdateId?: number;
  provider: ChatSdkProvider;
  thread: Thread;
  trigger: ChatSdkMessageTrigger;
}

export interface ChatSdkMessageUpdatedCallbackEvent {
  endpointId: string;
  message: Message;
  previousMessage?: Message;
  provider: ChatSdkProvider;
  thread: Thread;
}

export interface ChatSdkCallbackEvent<T> {
  endpointId: string;
  event: T;
  provider: ChatSdkProvider;
  /** Runtime-assigned ingress context; never read from provider payloads. */
  transport?: "discord_gateway";
  /** Opaque runtime-owned proof from the authenticated Telegram callback. */
  telegramCallback?: TelegramCallbackProvenance;
}

/** Private command completion only; task publications use the ordinary FIFO. */
export type DiscordNativeCommandResponse =
  | { kind: "accepted"; content: string }
  | { kind: "denied" };

export interface DiscordRootMentionAdmissionEvent {
  channelId: string;
  endpointId: string;
  guildId: string;
  message?: Message;
  messageId: string;
  threadId: string;
  userId: string;
}

export type DiscordGatewayHealthEvent =
  | { type: "connecting" }
  | { type: "ready"; botUserId?: string }
  | {
      type: "failure";
      fatal: boolean;
      error: {
        name: string;
        code?: number | string;
        status?: number;
        retryAfter?: number;
      };
    }
  | { type: "disconnected"; fatal: boolean; code?: number }
  | { type: "guild_removed"; guildId: string }
  | { type: "guild_available"; guildId: string }
  | { type: "guild_unavailable"; guildId: string }
  | {
      type: "channel_removed";
      channelId: string;
      guildId?: string;
      label?: string;
    };

export interface DiscordGatewayCallbackEvent extends ChatSdkCallbackEvent<DiscordGatewayHealthEvent> {
  sequence: number;
}

/**
 * Provider-neutral callbacks consumed by the Paperclip control-plane service.
 * All provider events have already passed the installed adapter's verifier and
 * normalization. Raw provider payloads remain available only through the
 * Chat SDK event escape hatches; callers must never publish them directly.
 */
export interface ChatSdkRuntimeCallbacks {
  onMessage(event: ChatSdkMessageCallbackEvent): Promise<void> | void;
  onTelegramGenerationStopped?(
    event: ChatSdkCallbackEvent<TelegramGenerationStoppedProof>,
  ): Promise<void> | void;
  onDiscordRootMentionAdmission?(
    event: DiscordRootMentionAdmissionEvent,
  ): Promise<boolean> | boolean;
  onDiscordGatewayEvent?(
    event: DiscordGatewayCallbackEvent,
  ): Promise<void> | void;
  onAction?(event: ChatSdkCallbackEvent<ActionEvent>): Promise<void> | void;
  /** Optional personal-chat file lane; "recorded" is not file delivery. */
  onTeamsFileConsent?(
    event: ChatSdkCallbackEvent<TeamsFileConsentEvent>,
  ):
    | Promise<"recorded" | "ignored" | "denied">
    | "recorded"
    | "ignored"
    | "denied";
  onMessageDeleted?(
    event: ChatSdkCallbackEvent<MessageDeletedEvent>,
  ): Promise<void> | void;
  onMessageUpdated?(
    event: ChatSdkMessageUpdatedCallbackEvent,
  ): Promise<void> | void;
  onModalClose?(
    event: ChatSdkCallbackEvent<ModalCloseEvent>,
  ): Promise<void> | void;
  onModalSubmit?(
    event: ChatSdkCallbackEvent<ModalSubmitEvent>,
  ):
    | Promise<ModalResponse | undefined | void>
    | ModalResponse
    | undefined
    | void;
  onOptionsLoad?(
    event: ChatSdkCallbackEvent<OptionsLoadEvent>,
  ): Promise<OptionsLoadResult | undefined> | OptionsLoadResult | undefined;
  onReaction?(event: ChatSdkCallbackEvent<ReactionEvent>): Promise<void> | void;
  onSlashCommand?(
    event: ChatSdkCallbackEvent<SlashCommandEvent>,
  ):
    | Promise<DiscordNativeCommandResponse | void>
    | DiscordNativeCommandResponse
    | void;
}

export interface CreateChatSdkEndpointRuntimeOptions {
  callbacks: ChatSdkRuntimeCallbacks;
  companyId: string;
  concurrency?: ConcurrencyConfig | ConcurrencyStrategy;
  /** Start Discord's long-lived Gateway listener for the elected owner only. */
  enableDiscordGateway?: boolean;
  endpointId: string;
  logger?: Logger | "debug" | "error" | "info" | "silent" | "warn";
  maxStateValueBytes?: number;
  persistence: ChatSdkStatePersistence;
  providerConfig: ResolvedChatSdkProviderConfig;
  webhookIngressTimeoutMs?: number;
}

function adapterKey(provider: ChatSdkProvider): ChatSdkAdapterKey {
  return provider === "microsoft-teams" ? "teams" : provider;
}

function adapterLogger(
  logger: CreateChatSdkEndpointRuntimeOptions["logger"],
): Logger | undefined {
  return logger && typeof logger !== "string" ? logger : undefined;
}

const TEAMS_THREAD_SCOPED_METHODS = [
  "postMessage",
  "postEphemeral",
  "editMessage",
  "deleteMessage",
  "addReaction",
  "removeReaction",
  "startTyping",
  "stream",
  "postChannelMessage",
] as const;

const OFFICIAL_TEAMS_CONNECTOR_HOST_SUFFIXES = [
  // Signed Teams activity can carry regional Microsoft-owned Bot Framework
  // service URLs, so the egress trust boundary recognizes these exact domain
  // families. Host acceptance is defensive routing validation, not a claim
  // that Paperclip's commercial-cloud-only credential flow supports every
  // Microsoft cloud represented by a first-party hostname.
  "botframework.com",
  "smba.trafficmanager.net",
  "teams.microsoft.com",
  "teams.microsoft.us",
] as const;

function isOfficialTeamsConnectorHost(hostname: string): boolean {
  return OFFICIAL_TEAMS_CONNECTOR_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function isCanonicalTeamsConnectorPath(pathname: string): boolean {
  // A Bot Connector service URL is a base URL, not an arbitrary connector API
  // route. Microsoft-owned URLs use either no path or one bounded
  // region/service segment such as /amer, /amer-client-ss.msg, or /teams.
  return (
    pathname === "/" || /^\/[a-z0-9][a-z0-9._-]{0,127}\/?$/i.test(pathname)
  );
}

export class TeamsServiceUrlValidationError extends Error {
  readonly code = "CHAT_PROVIDER_PRETRANSPORT_REJECTED";
  readonly provider = "microsoft-teams";

  constructor(message: string) {
    super(message);
    this.name = "TeamsServiceUrlValidationError";
  }
}

export class TeamsAdapterCompatibilityError extends Error {
  readonly code = "CHAT_ADAPTER_COMPATIBILITY_ERROR";

  constructor(detail: string) {
    super(`The pinned Microsoft Teams adapter is incompatible: ${detail}`);
    this.name = "TeamsAdapterCompatibilityError";
  }
}

export class DiscordAdapterCompatibilityError extends Error {
  readonly code = "CHAT_ADAPTER_COMPATIBILITY_ERROR";

  constructor(detail: string) {
    super(`The pinned Discord adapter is incompatible: ${detail}`);
    this.name = "DiscordAdapterCompatibilityError";
  }
}

export class SlackAdapterCompatibilityError extends Error {
  readonly code = "CHAT_ADAPTER_COMPATIBILITY_ERROR";

  constructor(detail: string) {
    super(`The pinned Slack adapter is incompatible: ${detail}`);
    this.name = "SlackAdapterCompatibilityError";
  }
}

export interface SlackFileUploadAcceptedReceipt {
  version: 1;
  channelId: string;
  fileIds: string[];
  threadTs: string | null;
}

interface SlackAdapterInternals {
  paperclipFileUploadReceiptContext?: AsyncLocalStorage<
    (receipt: SlackFileUploadAcceptedReceipt) => Promise<void>
  >;
  paperclipResolveFileUploadReceipt?: (
    fileIds: string[],
    threadId: string,
  ) => Promise<string | null>;
}

interface DiscordAdapterInternals {
  ensureRootThread?: unknown;
  paperclipCompatibilityRevision?: unknown;
  startGatewayListener?: unknown;
}

interface DiscordChatInternals {
  handleActionEvent?: unknown;
  handleIncomingMessage?: unknown;
  handleReactionEvent?: unknown;
  processMessageDeleted?: unknown;
  processMessageUpdated?: unknown;
}

interface DiscordCommandDispatch {
  raw: unknown;
  response?: unknown;
}

interface DiscordCommandInteraction {
  id: string;
  applicationId: string;
  commandId: string;
  commandName: string;
  commandType: number;
  type: number;
  context: number | null;
  guildId: string | null;
  channelId: string | null;
  channel: { id: string; type: number; parentId?: string } | null;
  authorizingIntegrationOwners: {
    guildId: string | null;
    userId: string | null;
  };
  user: { id: string; bot?: boolean };
  options: {
    data: Array<{
      name: string;
      type: number;
      options?: unknown[];
      value?: unknown;
    }>;
  };
  createdTimestamp: number;
  replied: boolean;
  deferred: boolean;
  isChatInputCommand(): boolean;
  deferReply(options: { flags: number }): Promise<unknown>;
  editReply(options: {
    content: string;
    allowedMentions: { parse: never[] };
  }): Promise<unknown>;
}

interface DiscordCommandAdapter {
  handleGatewayInteraction(
    interaction: DiscordCommandInteraction,
  ): Promise<void>;
  normalizeGatewaySlashCommandInteraction(
    interaction: DiscordCommandInteraction,
  ): Record<string, unknown>;
  getApplicationCommandContext(raw: Record<string, unknown>): {
    channelId: string;
    user: { id: string; username: string; global_name?: string; bot?: boolean };
  } | null;
}

/**
 * The pinned adapter's slash path is fire-and-forget and redirects postMessage
 * into interaction webhooks. Keep this opt-in path outside that requestContext,
 * while still using its channel normalization and Chat's real awaited dispatch.
 */
function installDiscordNativeCommands(
  adapter: Adapter,
  chat: Chat,
  applicationId: string,
  guildId: string,
  dispatchContext: AsyncLocalStorage<DiscordCommandDispatch>,
): void {
  const discord = adapter as unknown as DiscordCommandAdapter;
  const sdk = chat as unknown as {
    handleSlashCommandEvent(event: Record<string, unknown>): Promise<void>;
  };
  if (
    typeof discord.handleGatewayInteraction !== "function" ||
    typeof discord.normalizeGatewaySlashCommandInteraction !== "function" ||
    typeof discord.getApplicationCommandContext !== "function" ||
    typeof sdk.handleSlashCommandEvent !== "function"
  ) {
    throw new DiscordAdapterCompatibilityError(
      "awaited native command dispatch is unavailable",
    );
  }
  const original = discord.handleGatewayInteraction.bind(discord);
  // Only IDs/timestamps are retained, never interaction objects or their tokens.
  // This suppresses same-process redelivery; service receipt dedupe is still
  // required across restarts. Expired snowflakes are never acknowledged anew.
  const attempted = new Map<string, number>();
  const snowflake = (value: unknown): value is string =>
    typeof value === "string" && /^[1-9][0-9]{16,19}$/.test(value);
  const denied =
    "This command is not available here. Open the Paperclip task or ask an operator to check your chat access.";
  const unconfirmed =
    "This command could not be confirmed. Check the Paperclip task before trying again.";
  discord.handleGatewayInteraction = async (interaction) => {
    if (!interaction.isChatInputCommand()) return await original(interaction);
    const startedAt = Date.now();
    for (const [id, expiresAt] of attempted)
      if (expiresAt <= startedAt) attempted.delete(id);
    if (
      !snowflake(interaction.id) ||
      attempted.has(interaction.id) ||
      attempted.size >= 1024
    )
      return;
    // Reserve 500ms for the initial REST response. No database work precedes it.
    if (
      !Number.isFinite(interaction.createdTimestamp) ||
      startedAt >= interaction.createdTimestamp + 2500 ||
      interaction.createdTimestamp > startedAt + 1000
    )
      return;
    attempted.set(interaction.id, interaction.createdTimestamp + 15 * 60_000);
    if (interaction.deferred || interaction.replied) return;
    try {
      await interaction.deferReply({ flags: 64 });
    } catch {
      // The initial write may have succeeded. Never retry it, call the service,
      // send a second initial response, or expose provider error/token details.
      return;
    }
    let content = denied;
    const options = interaction.options?.data;
    const option =
      Array.isArray(options) && options.length === 1 ? options[0] : undefined;
    const isGuild =
      interaction.context === 0 &&
      interaction.guildId === guildId &&
      interaction.authorizingIntegrationOwners?.guildId === guildId;
    const isDm =
      interaction.context === 1 &&
      interaction.guildId === null &&
      interaction.authorizingIntegrationOwners?.guildId === "0" &&
      interaction.channel?.type === 1;
    const channel = interaction.channel;
    const thread = channel?.type === 11 || channel?.type === 12;
    const valid =
      interaction.type === 2 &&
      interaction.commandType === 1 &&
      interaction.applicationId === applicationId &&
      interaction.commandName === "paperclip" &&
      snowflake(interaction.commandId) &&
      snowflake(interaction.user?.id) &&
      !interaction.user.bot &&
      interaction.user.id !== applicationId &&
      !interaction.authorizingIntegrationOwners?.userId &&
      (isGuild || isDm) &&
      snowflake(interaction.channelId) &&
      channel?.id === interaction.channelId &&
      (!thread || snowflake(channel?.parentId)) &&
      option?.type === 1 &&
      ["status", "new", "close"].includes(option.name) &&
      option.value === undefined &&
      (option.options === undefined ||
        (Array.isArray(option.options) && option.options.length === 0));
    if (valid && option) {
      const normalized =
        discord.normalizeGatewaySlashCommandInteraction(interaction);
      // Explicit allowlist: the adapter's normalized raw currently has a token.
      // Do not pass it (or the discord.js interaction object) to Chat or storage.
      const raw = {
        id: interaction.id,
        application_id: applicationId,
        type: 2,
        version: 1,
        channel: normalized.channel,
        channel_id: interaction.channelId,
        guild_id: interaction.guildId ?? "@me",
        user: normalized.user,
        context: interaction.context,
        authorizing_integration_owners: { "0": isGuild ? guildId : "0" },
        data: {
          id: interaction.commandId,
          type: 1,
          name: "paperclip",
          options: [{ type: 1, name: option.name }],
        },
      };
      const context = discord.getApplicationCommandContext(raw);
      if (context) {
        const dispatch: DiscordCommandDispatch = { raw };
        content = unconfirmed;
        try {
          await dispatchContext.run(dispatch, () =>
            sdk.handleSlashCommandEvent({
              command: `/paperclip ${option.name}`,
              text: "",
              adapter,
              raw,
              channelId: context.channelId,
              user: {
                userId: context.user.id,
                userName: context.user.username,
                fullName: context.user.global_name || context.user.username,
                isBot: false,
                isMe: false,
              },
            }),
          );
          const response = dispatch.response;
          if (
            response &&
            typeof response === "object" &&
            !Array.isArray(response)
          ) {
            const record = response as Record<string, unknown>;
            if (record.kind === "denied" && Object.keys(record).length === 1)
              content = denied;
            else if (
              record.kind === "accepted" &&
              Object.keys(record).length === 2 &&
              typeof record.content === "string" &&
              record.content.trim().length > 0 &&
              record.content.length <= 2000 &&
              !record.content.includes("\0")
            )
              content = record.content;
          }
        } catch {
          // The application may already have committed. No synthetic success or
          // raw exception text, and no replay of the command in this adapter.
        }
      }
    }
    if (Date.now() >= interaction.createdTimestamp + 14 * 60_000) return;
    try {
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
    } catch {
      /* Outcome unknown; no second response or callback replay. */
    }
  };
}

function assertDiscordAdapterCompatibility(adapter: Adapter, chat: Chat): void {
  const discord = adapter as unknown as DiscordAdapterInternals;
  if (discord.paperclipCompatibilityRevision !== "paperclip-discord-v6") {
    throw new DiscordAdapterCompatibilityError(
      "Paperclip patch revision paperclip-discord-v6 is unavailable",
    );
  }
  if (typeof discord.startGatewayListener !== "function") {
    throw new DiscordAdapterCompatibilityError(
      "startGatewayListener is unavailable",
    );
  }
  if (typeof discord.ensureRootThread !== "function") {
    throw new DiscordAdapterCompatibilityError(
      "ensureRootThread is unavailable",
    );
  }
  const internals = chat as unknown as DiscordChatInternals;
  for (const method of [
    "handleActionEvent",
    "handleIncomingMessage",
    "handleReactionEvent",
    "processMessageDeleted",
    "processMessageUpdated",
  ] as const) {
    if (typeof internals[method] !== "function") {
      throw new DiscordAdapterCompatibilityError(
        `Chat.${method} is unavailable`,
      );
    }
  }
}

interface TeamsApiClientInternals {
  _apiClientSettings?: unknown;
  constructor: Function;
  http: unknown;
  serviceUrl: string;
}

interface TeamsAdapterInternals {
  app?: {
    api: TeamsApiClientInternals;
    id?: unknown;
    on?: TeamsConsentApp["on"];
    send?: (conversationId: string, activity: unknown) => Promise<unknown>;
  };
  chat?: {
    getState(): {
      get(key: string): Promise<unknown>;
      set(key: string, value: string, ttlMs?: number): Promise<void>;
    };
  };
  decodeThreadId?: (threadId: string) => {
    conversationId?: unknown;
    conversationType?: unknown;
    serviceUrl?: unknown;
  };
  cacheUserContext?: (activity: unknown) => void;
  getIncomingUser?: (...args: unknown[]) => Promise<unknown>;
  getUser?: (...args: unknown[]) => Promise<unknown>;
  openDM?: (userId: string) => Promise<unknown>;
  paperclipRecordAcceptedActivity?: (activity: unknown) => Promise<void>;
  paperclipRecordThreadServiceUrl?: (
    threadId: string,
    serviceUrl: unknown,
  ) => Promise<void>;
  paperclipSendFileCard?: (
    threadId: string,
    kind: "consent" | "file_info",
    card: unknown,
  ) => Promise<{ id: string }>;
  [key: string]: unknown;
}

function teamsConversationRouteStateKey(conversationId: string): string {
  const baseConversationId = conversationId.replace(/;messageid=[^;]+/i, "");
  return `teams:serviceUrl:conversation:${Buffer.from(baseConversationId).toString("base64url")}`;
}

const TEAMS_ACCEPTED_ACTIVITY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

function normalizedTeamsServiceUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new TeamsServiceUrlValidationError(
      "Teams destination is missing its verified service URL",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TeamsServiceUrlValidationError(
      "Teams destination contains an invalid service URL",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TeamsServiceUrlValidationError(
      "Teams destination contains an invalid service URL",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

function trustedTeamsServiceUrl(
  value: unknown,
  configuredApiUrl: string | null,
): string {
  const rawValue = typeof value === "string" ? value : "";
  const normalized = normalizedTeamsServiceUrl(value);
  const parsed = new URL(normalized);
  const rawParsed = new URL(rawValue);
  const officialHost =
    rawValue === rawValue.trim() &&
    parsed.port === "" &&
    isOfficialTeamsConnectorHost(parsed.hostname) &&
    // Encoded path bytes can be normalized away by URL parsing. Microsoft
    // connector base URLs do not require them, so reject them before applying
    // the canonical one-segment path policy.
    !/%[0-9a-f]{2}/i.test(rawValue) &&
    isCanonicalTeamsConnectorPath(rawParsed.pathname);
  if (officialHost || normalized === configuredApiUrl) return normalized;
  throw new TeamsServiceUrlValidationError(
    "Teams destination contains an untrusted service URL",
  );
}

/**
 * Microsoft binds serviceUrl into the authenticated Bot Connector JWT and
 * requires replies to target that matching URL. The URL is mutable routing
 * state, not conversation identity, so current thread ids omit it. Persist the
 * latest verified route under the stable conversation id and scope each
 * outbound call to a fresh API client rooted at that route. Legacy thread ids
 * that embedded a URL remain readable, but a newer persisted route wins. A
 * context-local getter keeps simultaneous conversations isolated without
 * forcing unrelated Teams threads through a single network queue.
 */
export function scopeMicrosoftTeamsEgress(
  adapter: Adapter,
  configuredApiUrl?: string,
  enableFileConsent = false,
): Adapter {
  const teams = adapter as unknown as TeamsAdapterInternals;
  if (!teams.app?.api) {
    throw new TeamsAdapterCompatibilityError("app.api is unavailable");
  }
  if (typeof teams.decodeThreadId !== "function") {
    throw new TeamsAdapterCompatibilityError("decodeThreadId is unavailable");
  }
  if (typeof teams.openDM !== "function") {
    throw new TeamsAdapterCompatibilityError("openDM is unavailable");
  }
  if (typeof teams.cacheUserContext !== "function") {
    throw new TeamsAdapterCompatibilityError("cacheUserContext is unavailable");
  }
  if (typeof teams.getIncomingUser !== "function") {
    throw new TeamsAdapterCompatibilityError("getIncomingUser is unavailable");
  }
  if (typeof teams.getUser !== "function") {
    throw new TeamsAdapterCompatibilityError("getUser is unavailable");
  }
  for (const methodName of TEAMS_THREAD_SCOPED_METHODS) {
    if (typeof teams[methodName] !== "function") {
      throw new TeamsAdapterCompatibilityError(`${methodName} is unavailable`);
    }
  }
  if (
    typeof teams.app.api.constructor !== "function" ||
    !("http" in teams.app.api)
  ) {
    throw new TeamsAdapterCompatibilityError(
      "the API client constructor or HTTP transport is unavailable",
    );
  }
  const apiDescriptor = Object.getOwnPropertyDescriptor(teams.app, "api");
  if (apiDescriptor && apiDescriptor.configurable === false) {
    throw new TeamsAdapterCompatibilityError(
      "app.api cannot be scoped per asynchronous conversation",
    );
  }
  const trustedConfiguredApiUrl = configuredApiUrl
    ? normalizedTeamsServiceUrl(configuredApiUrl)
    : null;

  // The pinned Teams adapter caches activity/user metadata and may query the
  // members or Graph APIs before Chat dispatches to Paperclip's reach and
  // tenant checks. Keep authenticated but unadmitted events observationally
  // inert. Accepted activities explicitly persist the minimum routing context
  // through paperclipRecordAcceptedActivity below.
  teams.cacheUserContext = () => {};
  teams.getIncomingUser = async () => null;
  teams.getUser = async () => null;

  teams.paperclipRecordAcceptedActivity = async (activityValue: unknown) => {
    if (!isRecord(activityValue)) return;
    const from = isRecord(activityValue.from) ? activityValue.from : null;
    const conversation = isRecord(activityValue.conversation)
      ? activityValue.conversation
      : null;
    const channelData = isRecord(activityValue.channelData)
      ? activityValue.channelData
      : null;
    const userId =
      typeof from?.id === "string" && from.id.length > 0 ? from.id : null;
    if (!userId) return;
    const state = teams.chat?.getState();
    if (!state) {
      throw new TeamsAdapterCompatibilityError(
        "durable accepted-activity state is unavailable",
      );
    }
    const ttl = TEAMS_ACCEPTED_ACTIVITY_CACHE_TTL_MS;
    const writes: Promise<void>[] = [];
    if (activityValue.serviceUrl !== undefined) {
      writes.push(
        state.set(
          `teams:serviceUrl:${userId}`,
          trustedTeamsServiceUrl(
            activityValue.serviceUrl,
            trustedConfiguredApiUrl,
          ),
          ttl,
        ),
      );
    }
    if (typeof from?.aadObjectId === "string" && from.aadObjectId.length > 0) {
      writes.push(
        state.set(`teams:aadObjectId:${userId}`, from.aadObjectId, ttl),
      );
    }
    const tenantId = microsoftTeamsTenantIds(activityValue)[0];
    if (tenantId) {
      writes.push(state.set(`teams:tenantId:${userId}`, tenantId, ttl));
    }
    const conversationId =
      typeof conversation?.id === "string" ? conversation.id : "";
    const baseConversationId = conversationId.replace(/;messageid=[^;]+/i, "");
    const conversationType =
      typeof conversation?.conversationType === "string"
        ? conversation.conversationType
        : null;
    const isPersonalConversation = conversationType
      ? conversationType === "personal"
      : !baseConversationId.startsWith("19:");
    const team =
      channelData && isRecord(channelData.team) ? channelData.team : null;
    const channel =
      channelData && isRecord(channelData.channel) ? channelData.channel : null;
    if (
      baseConversationId &&
      !isPersonalConversation &&
      typeof team?.aadGroupId === "string" &&
      team.aadGroupId.length > 0 &&
      typeof channel?.id === "string" &&
      channel.id.length > 0
    ) {
      writes.push(
        state.set(
          `teams:channelContext:${baseConversationId}`,
          JSON.stringify({
            teamId: team.aadGroupId,
            channelId: channel.id,
          }),
          ttl,
        ),
      );
    }
    if (
      baseConversationId &&
      typeof from?.aadObjectId === "string" &&
      from.aadObjectId.length > 0 &&
      isPersonalConversation
    ) {
      const appId = teams.app?.id;
      if (typeof appId === "string" && appId.length > 0) {
        writes.push(
          state.set(
            `teams:channelContext:${baseConversationId}`,
            JSON.stringify({
              type: "dm",
              graphChatId: `19:${from.aadObjectId}_${appId}@unq.gbl.spaces`,
            }),
            ttl,
          ),
        );
      }
    }
    await Promise.all(writes);
  };
  let defaultApi = teams.app.api;
  const apiScope = new AsyncLocalStorage<TeamsApiClientInternals>();
  Object.defineProperty(teams.app, "api", {
    configurable: true,
    enumerable: true,
    get: () => apiScope.getStore() ?? defaultApi,
    set: (value: TeamsApiClientInternals) => {
      defaultApi = value;
    },
  });
  const withServiceUrl = async <T>(
    serviceUrlValue: unknown,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const serviceUrl = trustedTeamsServiceUrl(
      serviceUrlValue,
      trustedConfiguredApiUrl,
    );
    const ApiClient = defaultApi.constructor as new (
      serviceUrl: string,
      http: unknown,
      settings?: unknown,
    ) => TeamsApiClientInternals;
    const scopedApi = new ApiClient(
      serviceUrl,
      defaultApi.http,
      defaultApi._apiClientSettings,
    );
    return await apiScope.run(scopedApi, operation);
  };
  const withThreadServiceUrl = async <T>(
    threadId: string,
    operation: () => Promise<T>,
    requireRoute = false,
  ): Promise<T> => {
    const decoded = teams.decodeThreadId!(threadId);
    if (typeof decoded.conversationId !== "string" || !decoded.conversationId) {
      throw new TeamsServiceUrlValidationError(
        "Teams destination is missing its conversation identity",
      );
    }
    const persistedServiceUrl = await teams.chat
      ?.getState()
      .get(teamsConversationRouteStateKey(decoded.conversationId));
    if (
      requireRoute &&
      persistedServiceUrl == null &&
      decoded.serviceUrl == null
    ) {
      throw new TeamsServiceUrlValidationError(
        "Teams file destination is missing its verified route",
      );
    }
    return await withServiceUrl(
      persistedServiceUrl ?? decoded.serviceUrl ?? defaultApi.serviceUrl,
      operation,
    );
  };

  if (enableFileConsent) {
    if (
      typeof teams.app.send !== "function" ||
      typeof teams.app.on !== "function"
    ) {
      throw new TeamsAdapterCompatibilityError(
        "file-consent App hooks are unavailable",
      );
    }
    teams.paperclipSendFileCard = async (threadId, kind, input) => {
      const card =
        kind === "consent"
          ? parseTeamsFileConsentCard(input)
          : kind === "file_info"
            ? parseTeamsUploadedFileCard(input)
            : null;
      if (!card)
        throw new TeamsAdapterCompatibilityError("invalid file-card shape");
      const decoded = teams.decodeThreadId!(threadId);
      // Never infer personal scope from a missing type or conversation prefix.
      if (
        decoded.conversationType !== "personal" ||
        typeof decoded.conversationId !== "string" ||
        !decoded.conversationId ||
        decoded.conversationId.length > 1024 ||
        /[\x00-\x20\x7f]/.test(decoded.conversationId) ||
        /;messageid=/i.test(decoded.conversationId)
      ) {
        throw new TeamsServiceUrlValidationError(
          "Teams file cards require an exact personal conversation",
        );
      }
      return await withThreadServiceUrl(
        threadId,
        async () => {
          let result: unknown;
          try {
            // Direct App attachment send is deliberately inside the same route
            // ALS as ordinary thread operations. Thread.post would turn these
            // provider-native cards into AdaptiveCards.
            result = await teams.app!.send!(decoded.conversationId as string, {
              type: "message",
              attachments: [card],
            });
          } catch {
            // Provider errors may contain private card contexts. No implicit
            // retry: an uncertain POST remains caller-owned durable evidence.
            throw new Error("Teams file-card send result is unknown");
          }
          if (
            !isRecord(result) ||
            typeof result.id !== "string" ||
            !result.id ||
            result.id.length > 1024 ||
            /[\x00-\x20\x7f]/.test(result.id)
          ) {
            throw new Error("Teams file-card send receipt is unproven");
          }
          return { id: result.id };
        },
        true,
      );
    };
  }

  teams.paperclipRecordThreadServiceUrl = async (
    threadId: string,
    serviceUrlValue: unknown,
  ) => {
    const decoded = teams.decodeThreadId!(threadId);
    if (typeof decoded.conversationId !== "string" || !decoded.conversationId) {
      throw new TeamsServiceUrlValidationError(
        "Teams destination is missing its conversation identity",
      );
    }
    const serviceUrl = trustedTeamsServiceUrl(
      serviceUrlValue,
      trustedConfiguredApiUrl,
    );
    const state = teams.chat?.getState();
    if (!state) {
      throw new TeamsAdapterCompatibilityError(
        "durable route state is unavailable",
      );
    }
    await state.set(
      teamsConversationRouteStateKey(decoded.conversationId),
      serviceUrl,
    );
  };

  for (const methodName of TEAMS_THREAD_SCOPED_METHODS) {
    const original = teams[methodName];
    if (typeof original !== "function") continue;
    teams[methodName] = (threadId: string, ...args: unknown[]) =>
      withThreadServiceUrl(threadId, async () =>
        Reflect.apply(original, teams, [threadId, ...args]),
      );
  }
  const originalOpenDM = teams.openDM;
  teams.openDM = async (userId: string) => {
    const cachedServiceUrl = await teams.chat
      ?.getState()
      .get(`teams:serviceUrl:${userId}`);
    const serviceUrl = cachedServiceUrl ?? defaultApi.serviceUrl;
    return await withServiceUrl(serviceUrl, async () => {
      const threadId = await Reflect.apply(originalOpenDM, teams, [userId]);
      if (typeof threadId === "string") {
        await teams.paperclipRecordThreadServiceUrl!(threadId, serviceUrl);
      }
      return threadId;
    });
  };
  return adapter;
}

function createProviderAdapter(
  config: ResolvedChatSdkProviderConfig,
  logger: CreateChatSdkEndpointRuntimeOptions["logger"],
  callbacks: ChatSdkRuntimeCallbacks,
  endpointId: string,
  observeDiscordGatewayFatal?: (fatal: boolean) => void,
): Adapter {
  const resolvedLogger = adapterLogger(logger);
  switch (config.provider) {
    case "slack": {
      const adapterConfig: SlackAdapterConfig = {
        ...config.credentials,
        logger: resolvedLogger,
        mode: "webhook",
        nativeStreaming: true,
        userName: config.userName,
        // Paperclip's durable publication outbox owns retry timing and
        // ambiguous-delivery handling. Slack's default client can otherwise
        // retry for roughly 30 minutes, well beyond the 60-second streaming
        // lease, allowing another worker to quarantine an in-flight send.
        webClientOptions: {
          rejectRateLimitedCalls: true,
          retryConfig: { retries: 0 },
          timeout: SLACK_WEB_API_TIMEOUT_MS,
        },
      };
      const adapter = createSlackAdapter(adapterConfig);
      (
        adapter as unknown as SlackAdapterInternals
      ).paperclipFileUploadReceiptContext = new AsyncLocalStorage<
        (receipt: SlackFileUploadAcceptedReceipt) => Promise<void>
      >();
      return adapter;
    }
    case "github": {
      // GitHub's API identifies an App actor as `<slug>[bot]`, while people
      // invoke the App in issue and PR comments with `@<slug>`. The shared
      // mention detector deliberately supports the bracketed actor form when
      // configured with the bare slug, but the inverse is not true.
      const mentionUserName = config.userName.replace(/\[bot\]$/i, "");
      const adapterConfig = {
        ...config.credentials,
        logger: resolvedLogger,
        userName: mentionUserName,
      } as GitHubAdapterConfig;
      const adapter = createGitHubAdapter(adapterConfig);
      // Octokit otherwise delegates to fetch without a deadline. A hung token
      // exchange or API request could outlive Paperclip's publication lease
      // and make another worker quarantine a still-running send as ambiguous.
      // Wrap every request with a fresh deadline instead of creating one at
      // adapter construction time, which would expire for the whole runtime.
      adapter.octokit?.hook?.wrap?.("request", async (request, options) => {
        const timeoutSignal = AbortSignal.timeout(GITHUB_API_TIMEOUT_MS);
        const existingSignal = options.request?.signal;
        const signal = existingSignal
          ? AbortSignal.any([existingSignal, timeoutSignal])
          : timeoutSignal;
        let rejectOnAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          rejectOnAbort = () =>
            reject(signal.reason ?? new Error("GitHub API request timed out"));
          if (signal.aborted) rejectOnAbort();
          else signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
        try {
          // The race also bounds Octokit's internal installation-token
          // exchange, which does not inherit the final API request's signal.
          options.request = { ...options.request, signal };
          return await Promise.race([request(options), aborted]);
        } finally {
          signal.removeEventListener("abort", rejectOnAbort);
        }
      });
      return adapter;
    }
    case "discord": {
      let gatewaySequence = 0;
      const adapterConfig: DiscordAdapterConfig = {
        apiUrl: config.credentials.apiUrl,
        applicationId: config.credentials.applicationId,
        botToken: config.credentials.botToken,
        // Paperclip receives Discord messages and interactions over its
        // authenticated Gateway session. Keep the unused public HTTP
        // interaction surface closed instead of making setup collect a key it
        // does not need.
        webhookVerifier: async () => false,
        logger: resolvedLogger,
        onGatewayEvent: async (event) => {
          if (
            "guildId" in event &&
            (!event.guildId || event.guildId !== config.credentials.guildId)
          ) {
            return;
          }
          const fatal =
            ((event.type === "failure" || event.type === "disconnected") &&
              event.fatal === true) ||
            event.type === "guild_removed";
          await callbacks.onDiscordGatewayEvent?.({
            endpointId,
            event,
            provider: "discord",
            sequence: ++gatewaySequence,
          });
          if (fatal) observeDiscordGatewayFatal?.(true);
          else if (event.type === "ready") observeDiscordGatewayFatal?.(false);
        },
        shouldCreateThread: async (input) => {
          if (input.guildId !== config.credentials.guildId) return false;
          return (
            (await callbacks.onDiscordRootMentionAdmission?.({
              ...input,
              endpointId,
            })) ?? false
          );
        },
        userName: config.userName,
      };
      return createDiscordAdapter(adapterConfig);
    }
    case "microsoft-teams": {
      const adapterConfig: TeamsAdapterConfig = {
        ...config.credentials,
        logger: resolvedLogger,
        userName: config.userName,
      };
      return scopeMicrosoftTeamsEgress(
        createTeamsAdapter(adapterConfig),
        config.credentials.apiUrl,
        typeof callbacks.onTeamsFileConsent === "function",
      );
    }
    case "telegram": {
      const adapterConfig: TelegramAdapterConfig = {
        ...config.credentials,
        logger: resolvedLogger,
        maxDownloadBytes: config.maxDownloadBytes,
        mentionOnReply: true,
        mode: "webhook",
        nativeStreaming: true,
        userName: config.userName,
      };
      const adapter = createTelegramAdapter(adapterConfig);
      const parser = adapter as unknown as {
        extractAttachments(raw: TelegramRawMessage): Attachment[];
        parseTelegramMessage(
          raw: TelegramRawMessage,
          threadId: string,
          content?: { text: string; formatted: Message["formatted"] },
        ): Message;
        createAttachment(
          type: Attachment["type"],
          fileId: string,
          metadata: Record<string, unknown>,
        ): Attachment;
      };
      if (
        typeof parser.extractAttachments !== "function" ||
        typeof parser.createAttachment !== "function" ||
        typeof parser.parseTelegramMessage !== "function"
      ) {
        throw new Error("Telegram attachment parser contract is unavailable");
      }
      const extractAttachments = parser.extractAttachments.bind(adapter);
      const create = (
        type: Attachment["type"],
        fileId: string,
        metadata: Record<string, unknown>,
      ) => parser.createAttachment(type, fileId, metadata);
      parser.extractAttachments = (raw) =>
        normalizeTelegramRichMessage(raw, create)?.attachments ??
        normalizeTelegramMediaAttachments(
          raw,
          normalizeTelegramVideoNoteAttachments(raw, extractAttachments(raw)),
          create,
        );
      const parseTelegramMessage = parser.parseTelegramMessage.bind(adapter);
      parser.parseTelegramMessage = (raw, threadId, content) => {
        const rich = normalizeTelegramRichMessage(raw, create);
        if (!rich) return parseTelegramMessage(raw, threadId, content);
        // Remove the rich tree before the legacy converter can recursively
        // traverse it. Keep provider identity/raw only for verified source
        // binding; exported text/AST contains the bounded readable projection.
        const safeRaw = {
          ...raw,
          rich_message: undefined,
          text: rich.text,
          caption: undefined,
          entities: [],
          caption_entities: [],
          reply_to_message: undefined,
        } as TelegramRawMessage;
        const message = parseTelegramMessage(safeRaw, threadId, {
          text: rich.text,
          formatted: {
            type: "root",
            children: [
              {
                type: "paragraph",
                children: [{ type: "text", value: rich.text }],
              },
            ],
          },
        });
        message.raw = raw;
        message.attachments = rich.attachments;
        return message;
      };
      return adapter;
    }
  }
}

function createAttachmentRecoveryDescriptor(
  provider: ChatSdkProvider,
  attachment: Attachment,
): ChatSdkAttachmentRecoveryDescriptor | null {
  const metadata = durableAttachmentMetadata(attachment);
  if (!metadata) return null;
  const fetchMetadata = attachment.fetchMetadata ?? {};

  if (provider === "github") {
    const locator = githubAttachmentLocator(attachment);
    return locator
      ? { version: 1, provider, attachment: metadata, locator }
      : null;
  }

  if (provider === "slack") {
    const url = sanitizedRecoveryUrl(fetchMetadata.url ?? attachment.url);
    if (!url) return null;
    const teamId = boundedAttachmentText(fetchMetadata.teamId, 512);
    const enterpriseId = boundedAttachmentText(fetchMetadata.enterpriseId, 512);
    return {
      version: 1,
      provider,
      attachment: metadata,
      locator: {
        kind: "slack_private_url",
        url,
        ...(teamId ? { teamId } : {}),
        ...(enterpriseId ? { enterpriseId } : {}),
        ...(fetchMetadata.isEnterpriseInstall === "true"
          ? { isEnterpriseInstall: true }
          : {}),
      },
    };
  }

  if (provider === "microsoft-teams") {
    const rawUrl = fetchMetadata.url ?? attachment.url;
    if (fetchMetadata.auth === "bot") {
      const connectorOrigin = sanitizedRecoveryOrigin(
        fetchMetadata.connectorOrigin,
      );
      if (!connectorOrigin) return null;
      const url = sanitizedRecoveryUrl(rawUrl, {
        requiredOrigin: connectorOrigin,
      });
      if (!url) return null;
      return {
        version: 1,
        provider,
        attachment: metadata,
        locator: { kind: "teams_bot_url", url, connectorOrigin },
      };
    }
    // Anonymous Teams download URLs can be short-lived bearer URLs. Only a
    // query-free HTTPS locator is safe to persist in ordinary delivery JSON.
    const url = sanitizedRecoveryUrl(rawUrl);
    if (!url) return null;
    return {
      version: 1,
      provider,
      attachment: metadata,
      locator: { kind: "teams_anonymous_url", url },
    };
  }

  if (provider === "discord") {
    const url = sanitizedRecoveryUrl(
      attachment.fetchMetadata?.url ?? attachment.url,
      { allowQuery: true },
    );
    if (!url) return null;
    const hostname = new URL(url).hostname.toLowerCase();
    if (
      hostname !== "cdn.discordapp.com" &&
      hostname !== "media.discordapp.net"
    )
      return null;
    return {
      version: 1,
      provider,
      attachment: metadata,
      locator: { kind: "discord_cdn_url", url },
    };
  }

  if (provider === "telegram") {
    const fileId = boundedAttachmentText(fetchMetadata.fileId, 2048);
    if (!fileId) return null;
    const fileUniqueId = boundedAttachmentText(
      fetchMetadata.fileUniqueId,
      2048,
    );
    return {
      version: 1,
      provider,
      attachment: metadata,
      locator: {
        kind: "telegram_file_id",
        fileId,
        ...(fileUniqueId ? { fileUniqueId } : {}),
      },
    };
  }

  return null;
}

function validatedAttachmentRecoveryDescriptor(
  provider: ChatSdkProvider,
  value: unknown,
): ChatSdkAttachmentRecoveryDescriptor | null {
  if (!isRecord(value) || value.version !== 1 || value.provider !== provider)
    return null;
  if (!isRecord(value.attachment) || !isRecord(value.locator)) return null;
  const metadata = value.attachment as unknown as Attachment;
  const kind = value.locator.kind;
  if (provider === "github" && kind === "github_public_attachment") {
    const locator = validateGitHubAttachmentLocator(value.locator);
    const attachment = durableAttachmentMetadata(metadata);
    return locator && attachment
      ? { version: 1, provider, attachment, locator }
      : null;
  }
  if (provider === "slack" && kind === "slack_private_url") {
    return createAttachmentRecoveryDescriptor(provider, {
      ...metadata,
      fetchMetadata: {
        url: value.locator.url as string,
        ...(typeof value.locator.teamId === "string"
          ? { teamId: value.locator.teamId }
          : {}),
        ...(typeof value.locator.enterpriseId === "string"
          ? { enterpriseId: value.locator.enterpriseId }
          : {}),
        ...(value.locator.isEnterpriseInstall === true
          ? { isEnterpriseInstall: "true" }
          : {}),
      },
    });
  }
  if (provider === "microsoft-teams" && kind === "teams_bot_url") {
    return createAttachmentRecoveryDescriptor(provider, {
      ...metadata,
      fetchMetadata: {
        auth: "bot",
        url: value.locator.url as string,
        connectorOrigin: value.locator.connectorOrigin as string,
      },
    });
  }
  if (provider === "discord" && kind === "discord_cdn_url") {
    return createAttachmentRecoveryDescriptor(provider, {
      ...metadata,
      fetchMetadata: { url: value.locator.url as string },
    });
  }
  if (provider === "microsoft-teams" && kind === "teams_anonymous_url") {
    return createAttachmentRecoveryDescriptor(provider, {
      ...metadata,
      fetchMetadata: { url: value.locator.url as string },
    });
  }
  if (provider === "telegram" && kind === "telegram_file_id") {
    return createAttachmentRecoveryDescriptor(provider, {
      ...metadata,
      fetchMetadata: {
        fileId: value.locator.fileId as string,
        ...(typeof value.locator.fileUniqueId === "string"
          ? { fileUniqueId: value.locator.fileUniqueId }
          : {}),
      },
    });
  }
  return null;
}

interface WebhookIngressAttempt {
  receivedAtMs: number;
  callbackError: unknown;
  callbackPromises: Set<Promise<unknown>>;
  providerUpdateId?: number;
}

async function telegramWebhookUpdateId(
  request: Request,
): Promise<number | undefined> {
  try {
    const payload = (await request.clone().json()) as unknown;
    if (!isRecord(payload)) return undefined;
    const updateId = payload.update_id;
    return typeof updateId === "number" &&
      Number.isSafeInteger(updateId) &&
      updateId >= 0
      ? updateId
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Chat SDK's message and provider-level retry markers are written before the
 * application callback runs. That ordering is unsafe for Paperclip: if the
 * `chat_deliveries` insert fails, a provider retry can be discarded by the SDK
 * even though Paperclip never durably accepted it. Paperclip's delivery ledger
 * is the authoritative dedupe boundary, so these early SDK markers are
 * deliberately bypassed while subscriptions and all other adapter state stay
 * durable.
 */
function paperclipAuthoritativeIngressState(
  state: StateAdapter,
  recordFailure: (error: unknown) => void,
): StateAdapter {
  const isCoreMessageDedupe = (key: string) => key.startsWith("dedupe:");
  const isSlackDeliveryMarker = (key: string) =>
    key.startsWith("slack:event-delivered:");
  const isTelegramDeliveryMarker = (key: string) =>
    key.startsWith("telegram:webhook-update:");

  return new Proxy(state, {
    get(target, property, receiver) {
      if (property === "setIfNotExists") {
        return async (key: string, value: unknown, ttlMs?: number) => {
          if (isCoreMessageDedupe(key) || isTelegramDeliveryMarker(key)) {
            return true;
          }
          try {
            return await target.setIfNotExists(key, value, ttlMs);
          } catch (error) {
            recordFailure(error);
            throw error;
          }
        };
      }
      if (property === "set") {
        return async (key: string, value: unknown, ttlMs?: number) => {
          if (isSlackDeliveryMarker(key)) return;
          try {
            await target.set(key, value, ttlMs);
          } catch (error) {
            recordFailure(error);
            throw error;
          }
        };
      }
      if (property === "get") {
        return async <T = unknown>(key: string): Promise<T | null> => {
          if (isSlackDeliveryMarker(key)) return null;
          try {
            return await target.get<T>(key);
          } catch (error) {
            recordFailure(error);
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const result = Reflect.apply(value, target, args) as unknown;
          if (!(result instanceof Promise)) return result;
          return result.catch((error: unknown) => {
            recordFailure(error);
            throw error;
          });
        } catch (error) {
          recordFailure(error);
          throw error;
        }
      };
    },
  });
}

function registerCallbacks(
  chat: Chat,
  endpointId: string,
  provider: ChatSdkProvider,
  callbacks: ChatSdkRuntimeCallbacks,
  trackCallback: <T>(callback: () => Promise<T> | T) => Promise<T>,
  acceptsProviderScope: (raw: unknown) => boolean,
  providerUpdateId: () => number | undefined,
  actionTransport: () => ChatSdkCallbackEvent<ActionEvent>["transport"],
  discordCommandDispatch: () => DiscordCommandDispatch | undefined,
  telegramCallback: (raw: unknown) => TelegramCallbackProvenance | undefined,
): void {
  const messageCallback =
    (trigger: ChatSdkMessageTrigger) =>
    async (
      thread: Thread,
      message: Message,
      context?: MessageContext,
    ): Promise<void> => {
      if (!acceptsProviderScope(message.raw)) return;
      if (provider === "github" && message.attachments.length === 0) {
        message.attachments.push(
          ...githubPublicAttachmentsFromMessage(message),
        );
      }
      await trackCallback(
        async () =>
          await callbacks.onMessage({
            endpointId,
            providerUpdateId: providerUpdateId(),
            provider,
            trigger,
            thread,
            message,
            context,
          }),
      );
    };

  chat.onDirectMessage(async (thread, message, _channel, context) => {
    await messageCallback("direct_message")(thread, message, context);
  });
  chat.onNewMention(messageCallback("mention"));
  chat.onSubscribedMessage(messageCallback("subscribed_message"));
  // The core service records and applies policy to fresh unaddressed messages;
  // the runtime deliberately does not subscribe or respond on its own.
  chat.onNewMessage(/[\s\S]*/, messageCallback("unaddressed_message"));

  if (callbacks.onMessageUpdated) {
    chat.onMessageUpdated(async (thread, message, previousMessage) => {
      if (!acceptsProviderScope(message.raw)) return;
      await trackCallback(
        async () =>
          await callbacks.onMessageUpdated?.({
            endpointId,
            provider,
            thread,
            message,
            previousMessage,
          }),
      );
    });
  }
  if (callbacks.onMessageDeleted) {
    chat.onMessageDeleted(async (event) => {
      if (!acceptsProviderScope(event.raw)) return;
      await trackCallback(
        async () =>
          await callbacks.onMessageDeleted?.({ endpointId, provider, event }),
      );
    });
  }
  if (callbacks.onReaction) {
    chat.onReaction(async (event) => {
      if (!acceptsProviderScope(event.raw)) return;
      await trackCallback(
        async () =>
          await callbacks.onReaction?.({ endpointId, provider, event }),
      );
    });
  }
  if (callbacks.onAction) {
    chat.onAction(async (event) => {
      const transport = actionTransport();
      if (!acceptsProviderScope(event.raw)) {
        if (transport === "discord_gateway") {
          // Resolving would tell the Gateway adapter to acknowledge a click
          // that never reached Paperclip's scoped action authorization.
          throw Object.assign(
            new Error("Discord Gateway action is outside the configured guild"),
            { code: "chat_discord_gateway_action_rejected" },
          );
        }
        return;
      }
      await trackCallback(
        async () =>
          await callbacks.onAction?.({
            endpointId,
            provider,
            event,
            ...(transport ? { transport } : {}),
            ...(telegramCallback(event.raw)
              ? { telegramCallback: telegramCallback(event.raw) }
              : {}),
          }),
      );
    });
  }
  if (callbacks.onOptionsLoad) {
    chat.onOptionsLoad(async (event) => {
      if (!acceptsProviderScope(event.raw)) return undefined;
      return await trackCallback(
        async () =>
          await callbacks.onOptionsLoad?.({ endpointId, provider, event }),
      );
    });
  }
  if (callbacks.onModalSubmit) {
    chat.onModalSubmit(async (event) => {
      if (!acceptsProviderScope(event.raw)) return undefined;
      const transport = actionTransport();
      return await trackCallback(
        async () =>
          await callbacks.onModalSubmit?.({
            endpointId,
            provider,
            event,
            ...(transport ? { transport } : {}),
          }),
      );
    });
  }
  if (callbacks.onModalClose) {
    chat.onModalClose(async (event) => {
      if (!acceptsProviderScope(event.raw)) return;
      await trackCallback(
        async () =>
          await callbacks.onModalClose?.({ endpointId, provider, event }),
      );
    });
  }
  if (callbacks.onSlashCommand) {
    chat.onSlashCommand(async (event) => {
      const dispatch = discordCommandDispatch();
      if (provider === "discord" && (!dispatch || dispatch.raw !== event.raw))
        return;
      if (!acceptsProviderScope(event.raw)) return;
      const response = await trackCallback(
        async () =>
          await callbacks.onSlashCommand?.({
            endpointId,
            provider,
            event,
            ...(dispatch ? { transport: "discord_gateway" as const } : {}),
          }),
      );
      if (dispatch) dispatch.response = response;
    });
  }
}

/** One isolated Chat instance and provider adapter for one Paperclip endpoint. */
export class ChatSdkEndpointRuntime {
  readonly companyId: string;
  readonly endpointId: string;
  readonly provider: ChatSdkProvider;
  readonly sdkAdapterKey: ChatSdkAdapterKey;
  private readonly adapter: Adapter;
  private readonly chat: Chat;
  private readonly webhookIngress =
    new AsyncLocalStorage<WebhookIngressAttempt>();
  private readonly discordCommandDispatch =
    new AsyncLocalStorage<DiscordCommandDispatch>();
  private readonly webhookIngressTimeoutMs: number;
  private readonly slackReceiptBotToken: string | null;
  private readonly githubReceiptApp: {
    appId: string;
    installationId: number;
  } | null;
  private readonly telegramEphemeralBotToken: string | null;
  private readonly telegramCallbackProofs = new WeakMap<
    object,
    TelegramCallbackProvenance
  >();
  private readonly microsoftTeamsTenantId: string | null;
  private readonly microsoftTeamsAppId: string | null;
  private readonly teamsInlineImageDescriptors = new WeakMap<
    Attachment,
    ChatSdkAttachmentRecoveryDescriptor
  >();
  private readonly teamsInlineImageFetchers = new WeakMap<
    Attachment,
    (signal?: AbortSignal) => Promise<Buffer>
  >();
  private readonly discordGuildId: string | null;
  private readonly discordGatewayEnabled: boolean;
  private readonly githubAttachmentAppAuthority: boolean;
  private readonly teamsFileConsentEnabled: boolean;
  private discordGatewayAbort: AbortController | null = null;
  private discordGatewayTask: Promise<void> | null = null;
  private discordGatewayFatal = false;
  private initialization: Promise<void> | null = null;
  private retired = false;
  private shutdownTask: Promise<void> | null = null;
  private shutdownCompleted = false;

  constructor(options: CreateChatSdkEndpointRuntimeOptions) {
    this.companyId = options.companyId;
    this.endpointId = options.endpointId;
    this.provider = options.providerConfig.provider;
    this.githubReceiptApp =
      options.providerConfig.provider === "github" &&
      "appId" in options.providerConfig.credentials &&
      options.providerConfig.credentials.installationId &&
      (!options.providerConfig.credentials.apiUrl ||
        options.providerConfig.credentials.apiUrl === "https://api.github.com")
        ? {
            appId: String(options.providerConfig.credentials.appId),
            installationId: options.providerConfig.credentials.installationId,
          }
        : null;
    this.slackReceiptBotToken =
      options.providerConfig.provider === "slack"
        ? options.providerConfig.credentials.botToken
        : null;
    this.telegramEphemeralBotToken = options.providerConfig.provider === "telegram"
      ? options.providerConfig.credentials.botToken : null;
    this.sdkAdapterKey = adapterKey(this.provider);
    this.teamsFileConsentEnabled =
      this.provider === "microsoft-teams" &&
      typeof options.callbacks.onTeamsFileConsent === "function";
    this.githubAttachmentAppAuthority =
      options.providerConfig.provider === "github" &&
      "appId" in options.providerConfig.credentials &&
      Boolean(options.providerConfig.credentials.installationId) &&
      (!options.providerConfig.credentials.apiUrl ||
        options.providerConfig.credentials.apiUrl === "https://api.github.com");
    this.microsoftTeamsTenantId =
      options.providerConfig.provider === "microsoft-teams"
        ? options.providerConfig.credentials.appTenantId
            ?.trim()
            .toLowerCase() || null
        : null;
    this.microsoftTeamsAppId =
      options.providerConfig.provider === "microsoft-teams"
        ? options.providerConfig.credentials.appId
        : null;
    this.discordGuildId =
      options.providerConfig.provider === "discord"
        ? options.providerConfig.credentials.guildId
        : null;
    this.discordGatewayEnabled = options.enableDiscordGateway !== false;
    this.webhookIngressTimeoutMs = Math.max(
      1,
      Math.min(options.webhookIngressTimeoutMs ?? 2_500, 10_000),
    );
    this.adapter = createProviderAdapter(
      options.providerConfig,
      options.logger,
      options.callbacks,
      options.endpointId,
      (fatal) => {
        this.discordGatewayFatal = fatal;
      },
    );
    if (this.provider === "telegram") {
      const adapter = this.adapter as unknown as {
        botUserId?: string;
        processUpdate(update: unknown, options?: WebhookOptions): void;
      };
      if (typeof adapter.processUpdate !== "function") {
        throw new Error(
          "Telegram authenticated dispatch contract is unavailable",
        );
      }
      const processUpdate = adapter.processUpdate.bind(this.adapter);
      adapter.processUpdate = (update, webhookOptions) => {
        // The pinned webhook verifier calls processUpdate only after checking
        // the secret. No parser-normalized chat:0 input may enter ordinary work.
        if (hasTelegramEphemeralInput(update)) return;
        const attempt = this.webhookIngress.getStore();
        if (isRecord(update) && "stopped_message_generation" in update) {
          // This wrapper is reached only after the pinned webhook secret check.
          // Join the durable callback to the same HTTP acknowledgement barrier.
          const proof =
            attempt && adapter.botUserId
              ? captureTelegramGenerationStopped(adapter.botUserId, update)
              : null;
          if (proof && options.callbacks.onTelegramGenerationStopped) {
            const task = Promise.resolve().then(() =>
              options.callbacks.onTelegramGenerationStopped!({
                provider: "telegram",
                endpointId: this.endpointId,
                event: proof,
              }),
            );
            attempt!.callbackPromises.add(task);
            const handled = task
              .catch((error) => {
                if (attempt!.callbackError === undefined)
                  attempt!.callbackError = error;
              })
              .finally(() => attempt!.callbackPromises.delete(task));
            webhookOptions?.waitUntil?.(handled);
          }
          return;
        }
        if (attempt && adapter.botUserId) {
          const captured = captureTelegramCallbackProvenance(
            {
              companyId: this.companyId,
              endpointId: this.endpointId,
              botUserId: adapter.botUserId,
            },
            update,
            attempt.receivedAtMs,
          );
          if (captured)
            this.telegramCallbackProofs.set(captured.raw, captured.proof);
        }
        processUpdate(update, webhookOptions);
      };
    }
    const durableState = createPaperclipChatSdkState({
      companyId: options.companyId,
      endpointId: options.endpointId,
      persistence: options.persistence,
      maxValueBytes: options.maxStateValueBytes,
    });
    const state = paperclipAuthoritativeIngressState(durableState, (error) => {
      const attempt = this.webhookIngress.getStore();
      if (attempt && attempt.callbackError === undefined) {
        attempt.callbackError = error;
      }
    });
    this.chat = new Chat({
      adapters: { [this.sdkAdapterKey]: this.adapter },
      // Paperclip acknowledges only after its own durable ledger write and
      // drains that ledger under database leases. An SDK-side queue can accept
      // a webhook before the application callback has run, so it must not sit
      // in front of the authoritative receipt boundary.
      concurrency: "concurrent",
      logger: options.logger,
      state,
      userName: options.providerConfig.userName,
    });
    if (this.provider === "discord") {
      assertDiscordAdapterCompatibility(this.adapter, this.chat);
    }
    registerCallbacks(
      this.chat,
      this.endpointId,
      this.provider,
      options.callbacks,
      async <T>(callback: () => Promise<T> | T): Promise<T> => {
        const attempt = this.webhookIngress.getStore();
        const promise = Promise.resolve().then(callback);
        if (!attempt) return await promise;
        attempt.callbackPromises.add(promise);
        try {
          return await promise;
        } catch (error) {
          if (attempt.callbackError === undefined)
            attempt.callbackError = error;
          throw error;
        } finally {
          attempt.callbackPromises.delete(promise);
        }
      },
      (raw) => this.acceptsProviderScope(raw),
      () => this.webhookIngress.getStore()?.providerUpdateId,
      () =>
        this.provider === "discord" && !this.webhookIngress.getStore()
          ? "discord_gateway"
          : undefined,
      () => this.discordCommandDispatch.getStore(),
      (raw) => isRecord(raw) ? this.telegramCallbackProofs.get(raw) : undefined,
    );
    if (
      options.providerConfig.provider === "discord" &&
      options.callbacks.onSlashCommand
    ) {
      installDiscordNativeCommands(
        this.adapter,
        this.chat,
        options.providerConfig.credentials.applicationId,
        options.providerConfig.credentials.guildId,
        this.discordCommandDispatch,
      );
    }
    if (this.teamsFileConsentEnabled) {
      const app = (this.adapter as unknown as TeamsAdapterInternals).app;
      if (
        !app ||
        typeof app.on !== "function" ||
        !this.microsoftTeamsTenantId ||
        options.providerConfig.provider !== "microsoft-teams"
      ) {
        throw new TeamsAdapterCompatibilityError(
          "file-consent requires a configured tenant and App hook",
        );
      }
      const callback = options.callbacks.onTeamsFileConsent!;
      installTeamsFileConsentHook(app as TeamsConsentApp, {
        companyId: this.companyId,
        endpointId: this.endpointId,
        tenantId: this.microsoftTeamsTenantId,
        botAppId: options.providerConfig.credentials.appId,
        onConsent: async (event) => {
          const attempt = this.webhookIngress.getStore();
          const promise = Promise.resolve().then(() =>
            callback({
              endpointId: this.endpointId,
              provider: this.provider,
              event,
            }),
          );
          if (!attempt) return await promise;
          attempt.callbackPromises.add(promise);
          try {
            return await promise;
          } catch (error) {
            if (attempt.callbackError === undefined)
              attempt.callbackError = error;
            throw error;
          } finally {
            attempt.callbackPromises.delete(promise);
          }
        },
      });
    }
  }

  async initialize(): Promise<void> {
    await this.initializeChat();
    this.assertNotRetired();
    if (this.provider === "discord" && this.discordGatewayEnabled) {
      this.startDiscordGateway();
    }
  }

  private async initializeChat(): Promise<void> {
    this.assertNotRetired();
    // The service still chooses when to initialize, after installing callback
    // context. Retirement owns the settlement of that exact SDK operation.
    this.initialization ??= this.chat.initialize();
    await this.initialization;
    this.assertNotRetired();
  }

  private assertNotRetired(): void {
    if (this.retired) throw new Error("Chat SDK endpoint runtime was retired");
  }

  private startDiscordGateway(): void {
    this.assertNotRetired();
    if (this.discordGatewayTask) return;
    const adapter = this.adapter as DiscordAdapter;
    if (typeof adapter.startGatewayListener !== "function") return;
    const abort = new AbortController();
    this.discordGatewayAbort = abort;
    this.discordGatewayTask = (async () => {
      let rapidRestartCount = 0;
      while (!abort.signal.aborted) {
        const sessionStartedAt = Date.now();
        let listener: Promise<unknown> | null = null;
        try {
          await adapter.startGatewayListener(
            {
              waitUntil: (task) => {
                listener = Promise.resolve(task);
              },
            },
            DISCORD_GATEWAY_SESSION_MS,
            abort.signal,
          );
          if (listener) await listener;
        } catch {
          // The adapter logs provider-specific failures. Keep the supervisor
          // alive so a transient start failure cannot become an unhandled
          // rejection that tears down the server.
        }
        if (abort.signal.aborted || this.discordGatewayFatal) break;
        rapidRestartCount =
          Date.now() - sessionStartedAt >= DISCORD_GATEWAY_HEALTHY_SESSION_MS
            ? 0
            : Math.min(rapidRestartCount + 1, 16);
        const restartDelayMs = Math.min(
          1_000 * 2 ** Math.max(0, rapidRestartCount - 1),
          DISCORD_GATEWAY_RESTART_MAX_DELAY_MS,
        );
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            abort.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, restartDelayMs);
          timer.unref?.();
          if (abort.signal.aborted) finish();
          else abort.signal.addEventListener("abort", finish, { once: true });
        });
      }
    })().finally(() => {
      this.discordGatewayTask = null;
    });
  }

  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
    responseDeadlineAt?: number,
    serviceReceivedAtMs?: number,
  ): Promise<Response> {
    this.assertNotRetired();
    // A body read, identity initialization or durable queue wait cannot mint
    // a fresh provider response window for an already received callback.
    const runtimeReceivedAtMs = Date.now();
    const receivedAtMs =
      typeof serviceReceivedAtMs === "number" &&
      Number.isSafeInteger(serviceReceivedAtMs) &&
      serviceReceivedAtMs > 0
        ? Math.min(serviceReceivedAtMs, runtimeReceivedAtMs)
        : runtimeReceivedAtMs;
    const handler = this.chat.webhooks[this.sdkAdapterKey];
    if (!handler) {
      throw new Error(
        `Chat SDK webhook handler is unavailable for ${this.provider}`,
      );
    }
    const providerUpdateId =
      this.provider === "telegram"
        ? await telegramWebhookUpdateId(request)
        : undefined;
    const attempt: WebhookIngressAttempt = {
      receivedAtMs,
      callbackError: undefined,
      callbackPromises: new Set(),
      ...(providerUpdateId !== undefined ? { providerUpdateId } : {}),
    };
    const sdkTasks: Promise<unknown>[] = [];
    const deadlineAt = Math.min(
      Date.now() + this.webhookIngressTimeoutMs,
      responseDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
    const retryableTimeout = () =>
      new Response("Paperclip could not durably accept the event in time", {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": "1",
        },
      });
    const beforeDeadline = async <T>(
      task: Promise<T>,
    ): Promise<
      { completed: true; value: T } | { completed: false; value?: never }
    > => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return { completed: false };
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timedOut = new Promise<{ completed: false }>((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), remaining);
        timer.unref?.();
      });
      const result = await Promise.race([
        task.then((value) => ({ completed: true as const, value })),
        timedOut,
      ]);
      if (timer) clearTimeout(timer);
      return result;
    };
    return await this.webhookIngress.run(attempt, async () => {
      // The SDK also auto-initializes through its webhook entry. Keep that
      // operation inside the ingress deadline and the same retirement fence,
      // without starting the caller-owned Discord Gateway here.
      if (!(await beforeDeadline(this.initializeChat())).completed)
        return retryableTimeout();
      this.assertNotRetired();
      const handlerResult = await beforeDeadline(
        handler(request, {
          ...options,
          waitUntil: (task) => {
            sdkTasks.push(task);
            options?.waitUntil?.(task);
          },
        }),
      );
      if (!handlerResult.completed) return retryableTimeout();
      const response = handlerResult.value;
      // Adapters return their provider acknowledgement immediately and put
      // normalized message dispatch behind waitUntil. Production callbacks do
      // only the delivery-ledger insert here, so this wait preserves Slack's
      // response budget while guaranteeing no 2xx precedes durable receipt.
      if (!(await beforeDeadline(Promise.allSettled(sdkTasks))).completed)
        return retryableTimeout();
      while (attempt.callbackPromises.size > 0) {
        if (
          !(
            await beforeDeadline(
              Promise.allSettled([...attempt.callbackPromises]),
            )
          ).completed
        )
          return retryableTimeout();
      }
      if (response.ok && attempt.callbackError !== undefined) {
        return new Response("Paperclip could not durably accept the event", {
          status: 503,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "retry-after": "1",
          },
        });
      }
      return response;
    });
  }

  thread(threadId: string): Thread {
    return this.chat.thread(threadId);
  }

  async streamTelegramDraft(
    threadId: string,
    textStream: AsyncIterable<string>,
    control: TelegramDraftControl,
  ): Promise<{ id: string } | TelegramDraftStopped> {
    const adapter = this.adapter as unknown as {
      paperclipDraftStopVersion?: number;
      stream(
        threadId: string,
        stream: AsyncIterable<string>,
        options: unknown,
      ): Promise<{ id: string } | TelegramDraftStopped>;
    };
    if (
      this.provider !== "telegram" ||
      !telegramPrivateDraftDestination(threadId) ||
      adapter.paperclipDraftStopVersion !== 1
    ) {
      throw new Error("Telegram durable draft transport is unavailable");
    }
    return adapter.stream(threadId, textStream, {
      paperclipDraftControl: control,
    });
  }

  /**
   * Post one Slack file-only publication while durably recording the accepted
   * upload IDs before the adapter performs its eventually-consistent share
   * lookup. This specialized receipt scope is deliberately unavailable for
   * cards, edits, and ordinary text sends; the send still uses Thread.post.
   */
  async postSlackFilePublication(
    threadId: string,
    message: Parameters<Thread["post"]>[0],
    onUploadAccepted: (
      receipt: SlackFileUploadAcceptedReceipt,
    ) => Promise<void>,
  ): Promise<{ id: string }> {
    if (this.provider !== "slack") {
      throw new SlackAdapterCompatibilityError(
        "file publication receipt capture was called for a non-Slack endpoint",
      );
    }
    const slack = this.adapter as unknown as SlackAdapterInternals;
    if (
      !slack.paperclipFileUploadReceiptContext ||
      typeof slack.paperclipResolveFileUploadReceipt !== "function"
    ) {
      throw new SlackAdapterCompatibilityError(
        "file publication receipt capture is unavailable",
      );
    }
    return await slack.paperclipFileUploadReceiptContext.run(
      onUploadAccepted,
      async () => await this.chat.thread(threadId).post(message),
    );
  }

  /** Resolve a previously accepted Slack upload using metadata reads only. */
  async resolveSlackFileUploadReceipt(
    threadId: string,
    fileIds: string[],
  ): Promise<string | null> {
    if (this.provider !== "slack") {
      throw new SlackAdapterCompatibilityError(
        "file publication receipt lookup was called for a non-Slack endpoint",
      );
    }
    const slack = this.adapter as unknown as SlackAdapterInternals;
    if (typeof slack.paperclipResolveFileUploadReceipt !== "function") {
      throw new SlackAdapterCompatibilityError(
        "file publication receipt lookup is unavailable",
      );
    }
    return await slack.paperclipResolveFileUploadReceipt.call(
      this.adapter,
      fileIds,
      threadId,
    );
  }

  /**
   * Persist a Teams activity's authenticated reply route only after the
   * control plane has accepted the callback under the current runtime and
   * credential generation. The route is intentionally separate from the
   * durable provider thread id because Microsoft can move a conversation
   * between regional Bot Connector service URLs.
   */
  async recordMicrosoftTeamsRoute(
    threadId: string,
    serviceUrl: unknown,
    raw?: unknown,
  ): Promise<void> {
    if (this.provider !== "microsoft-teams") return;
    const teams = this.adapter as unknown as TeamsAdapterInternals;
    const recorder = teams.paperclipRecordThreadServiceUrl;
    if (typeof recorder !== "function") {
      throw new TeamsAdapterCompatibilityError(
        "durable route recorder is unavailable",
      );
    }
    await recorder.call(this.adapter, threadId, serviceUrl);
    if (raw !== undefined) {
      const acceptedActivityRecorder = teams.paperclipRecordAcceptedActivity;
      if (typeof acceptedActivityRecorder !== "function") {
        throw new TeamsAdapterCompatibilityError(
          "durable accepted-activity recorder is unavailable",
        );
      }
      await acceptedActivityRecorder.call(this.adapter, raw);
    }
  }

  async sendTeamsFileConsentCard(
    threadId: string,
    card: ReturnType<typeof buildTeamsFileConsentCard>,
  ): Promise<{ id: string }> {
    return await this.sendTeamsFileCard(threadId, "consent", card);
  }

  async sendTeamsUploadedFileCard(
    threadId: string,
    card: ReturnType<typeof buildTeamsUploadedFileCard>,
  ): Promise<{ id: string }> {
    return await this.sendTeamsFileCard(threadId, "file_info", card);
  }

  private async sendTeamsFileCard(
    threadId: string,
    kind: "consent" | "file_info",
    card: unknown,
  ): Promise<{ id: string }> {
    const teams = this.adapter as unknown as TeamsAdapterInternals;
    if (
      !this.teamsFileConsentEnabled ||
      typeof teams.paperclipSendFileCard !== "function"
    ) {
      throw new TeamsAdapterCompatibilityError(
        "file-consent runtime is not enabled",
      );
    }
    return await teams.paperclipSendFileCard(threadId, kind, card);
  }

  channel(channelId: string): Channel {
    return this.chat.channel(channelId);
  }

  async openDirectMessage(user: string | Author): Promise<Thread> {
    return await this.chat.openDM(user);
  }

  async getUser(user: string | Author): Promise<UserInfo | null> {
    return await this.chat.getUser(user);
  }

  async abortTurn(threadId: string): Promise<void> {
    await this.chat.abortTurn(threadId);
  }

  getProviderAdapter(): Adapter {
    return this.adapter;
  }

  async ensureDiscordRootThread(input: {
    channelId: string;
    content: string;
    messageId: string;
  }): Promise<void> {
    if (this.provider !== "discord") {
      throw new DiscordAdapterCompatibilityError(
        "ensureDiscordRootThread was called for a non-Discord endpoint",
      );
    }
    const discord = this.adapter as unknown as DiscordAdapterInternals & {
      ensureRootThread?: (
        channelId: string,
        messageId: string,
        content: string,
      ) => Promise<unknown>;
    };
    if (typeof discord.ensureRootThread !== "function") {
      throw new DiscordAdapterCompatibilityError(
        "ensureRootThread is unavailable",
      );
    }
    await discord.ensureRootThread.call(
      this.adapter,
      input.channelId,
      input.messageId,
      input.content,
    );
  }

  /**
   * Reuse the pinned provider parser when a Telegram slash command also
   * carries media in its caption. The Chat SDK exposes slash-command fields
   * separately from the parsed Message, so without this bridge Paperclip
   * would silently discard a captioned document/photo/audio/video.
   */
  parseTelegramCommandMessage(raw: unknown): Message | null {
    if (this.provider !== "telegram" || !raw || typeof raw !== "object")
      return null;
    return (this.adapter as TelegramAdapter).parseMessage(
      raw as TelegramRawMessage,
    );
  }

  /**
   * Reuse the pinned Teams parser for verified messageUpdate/messageDelete
   * activities. The adapter exposes a public parser but does not currently
   * dispatch those activities through Chat's lifecycle callbacks.
   */
  parseMicrosoftTeamsMessage(raw: unknown): Message | null {
    if (this.provider !== "microsoft-teams" || !raw || typeof raw !== "object")
      return null;
    return (this.adapter as TeamsAdapter).parseMessage(raw);
  }

  /**
   * Keep a dedicated Teams endpoint bound to the configured organization.
   * Bot Framework authentication validates the service token, app audience,
   * and service URL, but its service-issued JWT is not tenant-scoped. The
   * verified activity body therefore remains the authoritative tenant claim.
   */
  acceptsProviderScope(raw: unknown): boolean {
    if (this.provider === "discord" && this.discordGuildId) {
      if (!isRecord(raw)) return false;
      const guildId = raw.guild_id;
      return (
        guildId === this.discordGuildId || guildId === null || guildId === "@me"
      );
    }
    if (this.provider !== "microsoft-teams") return true;
    if (
      isRecord(raw) &&
      isRecord(raw.recipient) &&
      raw.recipient.isTargeted === true
    ) {
      return false;
    }
    if (!this.microsoftTeamsTenantId) return true;
    const tenantIds = microsoftTeamsTenantIds(raw);
    return (
      tenantIds.length > 0 &&
      tenantIds.every((tenantId) => tenantId === this.microsoftTeamsTenantId)
    );
  }

  /** Build the closed, credential-free locator stored with durable ingress. */
  attachmentRecoveryDescriptor(
    attachment: Attachment,
    source?: ChatSdkAttachmentSource,
  ): ChatSdkAttachmentRecoveryDescriptor | null {
    if (this.provider === "telegram" && hasTelegramMediaProvenance(attachment)) {
      const scope = this.telegramMediaScope(source);
      const locator = scope && telegramMediaLocator(attachment, scope);
      const metadata = durableAttachmentMetadata(attachment);
      return locator && metadata ? { version: 1, provider: "telegram", attachment: metadata, locator } : null;
    }
    const retained = this.teamsInlineImageDescriptors.get(attachment);
    if (retained) {
      if (!source) return retained;
      const scope = this.teamsInlineImageScope(source);
      return scope && parseTeamsInlineImageLocator(retained.locator, scope)
        ? retained
        : null;
    }
    if (
      this.provider === "microsoft-teams" &&
      source?.isDirectMessage === false
    ) {
      const scope = this.teamsInlineImageScope(source);
      const locator =
        scope && source.message
          ? deriveTeamsInlineImageLocator(source.message, attachment, scope)
          : null;
      const metadata = durableAttachmentMetadata(attachment);
      return locator && metadata
        ? { version: 1, provider: this.provider, attachment: metadata, locator }
        : null;
    }
    return createAttachmentRecoveryDescriptor(this.provider, attachment);
  }

  private telegramMediaScope(source?: ChatSdkAttachmentSource): TelegramMediaScope | null {
    if (!source || source.runtimeGeneration === undefined || !source.credentialFingerprint || !source.principalExternalId) return null;
    return { companyId: this.companyId, endpointId: this.endpointId, runtimeGeneration: source.runtimeGeneration,
      credentialFingerprint: source.credentialFingerprint, threadId: source.threadId, messageId: source.messageId,
      principalExternalId: source.principalExternalId };
  }

  private teamsInlineImageScope(
    source?: ChatSdkAttachmentSource,
  ): TeamsInlineImageScope | null {
    if (
      !source ||
      !this.microsoftTeamsTenantId ||
      !this.microsoftTeamsAppId ||
      source.runtimeGeneration === undefined ||
      !source.credentialFingerprint ||
      !source.principalExternalId
    )
      return null;
    return {
      companyId: this.companyId,
      endpointId: this.endpointId,
      tenantId: this.microsoftTeamsTenantId,
      botAppId: this.microsoftTeamsAppId,
      runtimeGeneration: source.runtimeGeneration,
      credentialFingerprint: source.credentialFingerprint,
      threadId: source.threadId,
      messageId: source.messageId,
      principalExternalId: source.principalExternalId,
    };
  }

  /** Service-owned receipt action; no ordinary message or native status retry. */
  async applyGitHubReceiptReaction(
    input: GitHubReceiptMutation,
    assertCurrent: () => Promise<void>,
    fetchImpl?: typeof globalThis.fetch,
  ) {
    if (this.provider !== "github" || !this.githubReceiptApp)
      throw new Error("GitHub receipt runtime unavailable");
    return applyGitHubReceiptReaction(
      this.adapter,
      this.githubReceiptApp.appId,
      this.githubReceiptApp.installationId,
      input,
      assertCurrent,
      fetchImpl,
    );
  }

  async applySlackReceiptReaction(
    input: SlackReceiptMutation,
    fetchImpl?: typeof globalThis.fetch,
  ): Promise<void> {
    if (this.provider !== "slack" || !this.slackReceiptBotToken)
      throw new Error("Slack receipt runtime unavailable");
    await applySlackReceiptReaction(
      { ...input, botToken: this.slackReceiptBotToken },
      fetchImpl,
    );
  }

  async sendTelegramCallbackNotice(
    receipt: TelegramCallbackReceipt,
    text: string,
    fetchImpl?: typeof globalThis.fetch,
  ): Promise<{ id: string; threadId: string }> {
    if (
      this.provider !== "telegram" ||
      !this.telegramEphemeralBotToken ||
      receipt.companyId !== this.companyId ||
      receipt.endpointId !== this.endpointId
    ) {
      throw Object.assign(
        new Error("Telegram private response runtime unavailable"),
        { code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" },
      );
    }
    return sendTelegramCallbackNotice(
      { receipt, text, botToken: this.telegramEphemeralBotToken },
      fetchImpl,
    );
  }

  /** Only attachments reconstructed by this runtime can use the batch budget. */
  async fetchTeamsInlineImage(
    attachment: Attachment,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const fetcher = this.teamsInlineImageFetchers.get(attachment);
    if (!fetcher || signal.aborted)
      throw new Error("Teams inline image download unavailable");
    return await fetcher(signal);
  }

  /** Called only after current inbound admission; installation App authority only. */
  async resolveGitHubAttachmentComment(
    request: GitHubAttachmentCommentRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!this.githubAttachmentAppAuthority)
      throw new GitHubAttachmentUnavailableError(
        "github_attachment_canonical_authority_unavailable",
      );
    if (!isGitHubAttachmentCommentRequest(request))
      throw new GitHubAttachmentUnavailableError(
        "github_attachment_source_mismatch",
      );
    try {
      signal.throwIfAborted();
      const result = await (this.adapter as GitHubAdapter).octokit.request(
        `GET ${request.url}`,
        {
          headers: {
            accept: request.accept,
            "x-github-api-version": "2022-11-28",
          },
          request: {
            signal,
            redirect: "manual",
            fetch: githubAttachmentCommentFetch(request, signal),
          },
        },
      );
      signal.throwIfAborted();
      return result.data;
    } catch (error) {
      // Octokit errors can carry request headers or authenticated HTML. Neither
      // belongs in adapter logs, durable ingress, nor agent-visible results.
      throw new GitHubAttachmentUnavailableError(
        githubAttachmentDiagnosticCode(error) ??
          "github_attachment_canonical_api_request_failed",
      );
    }
  }

  /**
   * Rebuild an adapter-authenticated download closure after process restart.
   * Invalid, cross-provider, or no-longer-safe descriptors fail closed.
   */
  rehydrateAttachment(
    descriptor: unknown,
    source?: ChatSdkAttachmentSource,
  ): Attachment | null {
    if (
      this.provider === "microsoft-teams" &&
      isRecord(descriptor) &&
      isRecord(descriptor.locator) &&
      descriptor.locator.kind === "teams_inline_image"
    ) {
      const scope = this.teamsInlineImageScope(source);
      const locator = scope
        ? parseTeamsInlineImageLocator(descriptor.locator, scope)
        : null;
      const metadata = isRecord(descriptor.attachment)
        ? durableAttachmentMetadata(
            descriptor.attachment as unknown as Attachment,
          )
        : null;
      if (
        !locator ||
        !metadata ||
        source?.isDirectMessage !== false ||
        descriptor.version !== 1 ||
        descriptor.provider !== this.provider ||
        Object.keys(descriptor).sort().join(",") !==
          "attachment,locator,provider,version" ||
        Object.keys(descriptor.attachment as object).some(
          (key) =>
            !["type", "mimeType", "name", "size", "height", "width"].includes(
              key,
            ),
        ) ||
        metadata.type !== "image" ||
        metadata.mimeType !== locator.mimeType ||
        (metadata.size !== undefined && metadata.size > MAX_ATTACHMENT_BYTES)
      )
        return null;
      const normalized: ChatSdkAttachmentRecoveryDescriptor = {
        version: 1,
        provider: this.provider,
        attachment: metadata,
        locator,
      };
      const fetchData = async (batchSignal?: AbortSignal): Promise<Buffer> => {
        const controller = new AbortController();
        const signal = batchSignal
          ? AbortSignal.any([batchSignal, controller.signal])
          : controller.signal;
        let rejectDeadline!: () => void;
        const deadline = new Promise<never>((_resolve, reject) => {
          rejectDeadline = () =>
            reject(new Error("Teams inline image download unavailable"));
        });
        signal.addEventListener("abort", rejectDeadline, { once: true });
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          // Same authenticated SDK HTTP client as the pinned parser, with an
          // explicit allocation/deadline bound and no redirects. Never use
          // a caller-supplied fetchData closure or bearer URL.
          const http = (
            this.adapter as unknown as {
              app: {
                api: {
                  http: {
                    get(
                      url: string,
                      options: unknown,
                    ): Promise<{ data: ArrayBuffer | Uint8Array }>;
                  };
                };
              };
            }
          ).app.api.http;
          signal.throwIfAborted();
          const result = await Promise.race([
            http.get(teamsInlineImageDownloadUrl(locator), {
              responseType: "arraybuffer",
              maxRedirects: 0,
              maxContentLength: MAX_ATTACHMENT_BYTES,
              maxBodyLength: MAX_ATTACHMENT_BYTES,
              timeout: 10_000,
              signal,
            }),
            deadline,
          ]);
          signal.throwIfAborted();
          if (
            !result.data ||
            (!(result.data instanceof ArrayBuffer) &&
              !ArrayBuffer.isView(result.data)) ||
            result.data.byteLength > MAX_ATTACHMENT_BYTES
          )
            throw new Error("Image exceeds attachment bound");
          return Buffer.from(
            result.data instanceof ArrayBuffer
              ? new Uint8Array(result.data)
              : result.data,
          );
        } catch {
          throw new Error("Teams inline image download unavailable");
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", rejectDeadline);
        }
      };

      const attachment: Attachment = { ...metadata, fetchData: () => fetchData() };
      this.teamsInlineImageDescriptors.set(attachment, normalized);
      this.teamsInlineImageFetchers.set(attachment, fetchData);
      return attachment;
    }
    if (
      this.provider === "telegram" &&
      isRecord(descriptor) &&
      descriptor.version === 1 &&
      descriptor.provider === "telegram" &&
      isRecord(descriptor.locator) &&
      descriptor.locator.kind === "telegram_media"
    ) {
      const scope = this.telegramMediaScope(source);
      const metadata =
        isRecord(descriptor.attachment) &&
        durableAttachmentMetadata(
          descriptor.attachment as unknown as Attachment,
        );
      const locator =
        scope &&
        metadata &&
        validateTelegramMediaLocator(descriptor.locator, metadata, scope);
      if (!locator || !metadata || !this.adapter.rehydrateAttachment)
        return null;
      const attachment = this.adapter.rehydrateAttachment({
        ...metadata,
        fetchMetadata: {
          fileId: locator.fileId,
          fileUniqueId: locator.fileUniqueId,
        },
      });
      return attachment
        ? retainTelegramMediaProvenance(attachment, locator)
        : null;
    }
    const validated = validatedAttachmentRecoveryDescriptor(
      this.provider,
      descriptor,
    );
    if (!validated) return null;
    if (validated.locator.kind === "github_public_attachment") {
      return source
        ? rehydrateGitHubPublicAttachment(validated.locator, source)
        : null;
    }
    if (!this.adapter.rehydrateAttachment) return null;
    let fetchMetadata: Record<string, string>;
    switch (validated.locator.kind) {
      case "slack_private_url":
        fetchMetadata = {
          url: validated.locator.url,
          ...(validated.locator.teamId
            ? { teamId: validated.locator.teamId }
            : {}),
          ...(validated.locator.enterpriseId
            ? { enterpriseId: validated.locator.enterpriseId }
            : {}),
          ...(validated.locator.isEnterpriseInstall
            ? { isEnterpriseInstall: "true" }
            : {}),
        };
        break;
      case "teams_bot_url":
        fetchMetadata = {
          url: validated.locator.url,
          auth: "bot",
          connectorOrigin: validated.locator.connectorOrigin,
        };
        break;
      case "teams_inline_image":
        return null; // Only the exact source-bound branch above may authorize it.
      case "telegram_media":
        return null; // Only the exact source-bound branch above may authorize it.
      case "teams_anonymous_url":
        fetchMetadata = { url: validated.locator.url };
        break;
      case "discord_cdn_url":
        fetchMetadata = { url: validated.locator.url };
        break;
      case "telegram_file_id":
        fetchMetadata = {
          fileId: validated.locator.fileId,
          ...(validated.locator.fileUniqueId
            ? { fileUniqueId: validated.locator.fileUniqueId }
            : {}),
        };
        break;
    }
    return this.adapter.rehydrateAttachment({
      ...validated.attachment,
      fetchMetadata,
    });
  }

  async shutdown(): Promise<void> {
    // Set synchronously: an already-resolving initialize must not start a
    // Gateway after retirement, and this runtime can never be reinitialized.
    this.retired = true;
    if (this.shutdownCompleted) return;
    if (this.shutdownTask) return await this.shutdownTask;
    this.discordGatewayAbort?.abort();
    const task = (async () => {
      // Even a rejected initialization may have connected state or partially
      // initialized an adapter. Join it before disconnecting that ownership.
      await this.initialization?.catch(() => undefined);
      await this.discordGatewayTask?.catch(() => undefined);
      this.discordGatewayAbort = null;
      await this.chat.shutdown();
      this.shutdownCompleted = true;
    })();
    this.shutdownTask = task;
    try {
      await task;
    } finally {
      // A failed disconnect retains a permanently retired owner, allowing the
      // registry to retry shutdown without permitting another initialization.
      if (this.shutdownTask === task) this.shutdownTask = null;
    }
  }
}

export function createChatSdkEndpointRuntime(
  options: CreateChatSdkEndpointRuntimeOptions,
): ChatSdkEndpointRuntime {
  return new ChatSdkEndpointRuntime(options);
}

export class ChatSdkEndpointNotRegisteredError extends Error {
  readonly endpointId: string;

  constructor(endpointId: string) {
    super(`No Chat SDK runtime is registered for endpoint ${endpointId}`);
    this.name = "ChatSdkEndpointNotRegisteredError";
    this.endpointId = endpointId;
  }
}

/** Process-local lifecycle registry; durable state remains in Paperclip persistence. */
export class ChatSdkRuntime {
  private readonly endpoints = new Map<string, ChatSdkEndpointRuntime>();
  private readonly retiringEndpoints = new Map<
    string,
    ChatSdkEndpointRuntime
  >();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly replacementGenerations = new Map<string, number>();
  private shuttingDown = false;

  get(endpointId: string): ChatSdkEndpointRuntime | null {
    if (this.shuttingDown) return null;
    return this.endpoints.get(endpointId) ?? null;
  }

  list(): ChatSdkEndpointRuntime[] {
    if (this.shuttingDown) return [];
    return [...this.endpoints.values()];
  }

  private enqueueLifecycle<T>(
    endpointId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleTails.get(endpointId) ?? Promise.resolve();
    const result = previous.then(operation);
    // A failed shutdown must not poison the queue or release ownership of a
    // possibly still-running predecessor. Only an explicit later operation
    // retries retirement; callers still receive the original failure.
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleTails.set(endpointId, settled);
    void settled.then(() => {
      if (this.lifecycleTails.get(endpointId) === settled) {
        this.lifecycleTails.delete(endpointId);
      }
    });
    return result;
  }

  private async retireEndpoint(endpointId: string): Promise<boolean> {
    const previous =
      this.endpoints.get(endpointId) ?? this.retiringEndpoints.get(endpointId);
    if (!previous) return false;
    this.endpoints.delete(endpointId);
    this.retiringEndpoints.set(endpointId, previous);
    await previous.shutdown();
    this.retiringEndpoints.delete(endpointId);
    return true;
  }

  private nextReplacementGeneration(endpointId: string): number {
    const next = (this.replacementGenerations.get(endpointId) ?? 0) + 1;
    this.replacementGenerations.set(endpointId, next);
    return next;
  }

  private assertReplacementCurrent(
    endpointId: string,
    generation: number,
  ): void {
    if (this.shuttingDown) throw new Error("Chat SDK runtime is shutting down");
    if (this.replacementGenerations.get(endpointId) !== generation) {
      throw new Error(
        `Chat SDK runtime replacement for endpoint ${endpointId} was superseded`,
      );
    }
  }

  async replaceEndpoint(
    options: CreateChatSdkEndpointRuntimeOptions,
  ): Promise<ChatSdkEndpointRuntime> {
    if (this.shuttingDown) throw new Error("Chat SDK runtime is shutting down");
    const generation = this.nextReplacementGeneration(options.endpointId);
    return await this.enqueueLifecycle(options.endpointId, async () => {
      this.assertReplacementCurrent(options.endpointId, generation);
      await this.retireEndpoint(options.endpointId);
      this.assertReplacementCurrent(options.endpointId, generation);
      const next = createChatSdkEndpointRuntime(options);
      this.endpoints.set(options.endpointId, next);
      // The service installs callback context before initialize() starts the
      // Discord gateway. Preserve that caller-owned initialization boundary.
      return next;
    });
  }

  async removeEndpoint(endpointId: string): Promise<boolean> {
    this.nextReplacementGeneration(endpointId);
    return await this.enqueueLifecycle(
      endpointId,
      async () => await this.retireEndpoint(endpointId),
    );
  }

  async handleWebhook(
    endpointId: string,
    request: Request,
    options?: WebhookOptions,
    responseDeadlineAt?: number,
  ): Promise<Response> {
    const runtime = this.get(endpointId);
    if (!runtime) throw new ChatSdkEndpointNotRegisteredError(endpointId);
    return await runtime.handleWebhook(request, options, responseDeadlineAt);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const endpointIds = new Set([
      ...this.endpoints.keys(),
      ...this.retiringEndpoints.keys(),
      ...this.lifecycleTails.keys(),
    ]);
    const results = await Promise.allSettled(
      [...endpointIds].map(
        async (endpointId) =>
          await this.enqueueLifecycle(
            endpointId,
            async () => await this.retireEndpoint(endpointId),
          ),
      ),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

export function createChatSdkRuntime(): ChatSdkRuntime {
  return new ChatSdkRuntime();
}
