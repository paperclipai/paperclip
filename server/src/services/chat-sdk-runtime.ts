import {
  createGitHubAdapter,
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
  provider: Exclude<ChatSdkProvider, "github">;
  version: 1;
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
}

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
  onDiscordRootMentionAdmission?(
    event: DiscordRootMentionAdmissionEvent,
  ): Promise<boolean> | boolean;
  onDiscordGatewayEvent?(
    event: DiscordGatewayCallbackEvent,
  ): Promise<void> | void;
  onAction?(event: ChatSdkCallbackEvent<ActionEvent>): Promise<void> | void;
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
  ): Promise<void> | void;
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

function assertDiscordAdapterCompatibility(adapter: Adapter, chat: Chat): void {
  const discord = adapter as unknown as DiscordAdapterInternals;
  if (discord.paperclipCompatibilityRevision !== "paperclip-discord-v4") {
    throw new DiscordAdapterCompatibilityError(
      "Paperclip patch revision paperclip-discord-v4 is unavailable",
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
  app?: { api: TeamsApiClientInternals };
  chat?: {
    getState(): {
      get(key: string): Promise<unknown>;
      set(key: string, value: string, ttlMs?: number): Promise<void>;
    };
  };
  decodeThreadId?: (threadId: string) => {
    conversationId?: unknown;
    serviceUrl?: unknown;
  };
  openDM?: (userId: string) => Promise<unknown>;
  paperclipRecordThreadServiceUrl?: (
    threadId: string,
    serviceUrl: unknown,
  ) => Promise<void>;
  [key: string]: unknown;
}

function teamsConversationRouteStateKey(conversationId: string): string {
  const baseConversationId = conversationId.replace(/;messageid=[^;]+/i, "");
  return `teams:serviceUrl:conversation:${Buffer.from(baseConversationId).toString("base64url")}`;
}

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
    return await withServiceUrl(
      persistedServiceUrl ?? decoded.serviceUrl ?? defaultApi.serviceUrl,
      operation,
    );
  };

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
      return createSlackAdapter(adapterConfig);
    }
    case "github": {
      const adapterConfig = {
        ...config.credentials,
        logger: resolvedLogger,
        userName: config.userName,
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
      return createTelegramAdapter(adapterConfig);
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
): void {
  const messageCallback =
    (trigger: ChatSdkMessageTrigger) =>
    async (
      thread: Thread,
      message: Message,
      context?: MessageContext,
    ): Promise<void> => {
      if (!acceptsProviderScope(message.raw)) return;
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
      if (!acceptsProviderScope(event.raw)) return;
      await trackCallback(
        async () => await callbacks.onAction?.({ endpointId, provider, event }),
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
      return await trackCallback(
        async () =>
          await callbacks.onModalSubmit?.({ endpointId, provider, event }),
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
      if (!acceptsProviderScope(event.raw)) return;
      await trackCallback(
        async () =>
          await callbacks.onSlashCommand?.({ endpointId, provider, event }),
      );
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
  private readonly webhookIngressTimeoutMs: number;
  private readonly microsoftTeamsTenantId: string | null;
  private readonly discordGuildId: string | null;
  private readonly discordGatewayEnabled: boolean;
  private discordGatewayAbort: AbortController | null = null;
  private discordGatewayTask: Promise<void> | null = null;
  private discordGatewayFatal = false;

  constructor(options: CreateChatSdkEndpointRuntimeOptions) {
    this.companyId = options.companyId;
    this.endpointId = options.endpointId;
    this.provider = options.providerConfig.provider;
    this.sdkAdapterKey = adapterKey(this.provider);
    this.microsoftTeamsTenantId =
      options.providerConfig.provider === "microsoft-teams"
        ? options.providerConfig.credentials.appTenantId
            ?.trim()
            .toLowerCase() || null
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
    );
  }

  async initialize(): Promise<void> {
    await this.chat.initialize();
    if (this.provider === "discord" && this.discordGatewayEnabled) {
      this.startDiscordGateway();
    }
  }

  private startDiscordGateway(): void {
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
  ): Promise<Response> {
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
  ): Promise<void> {
    if (this.provider !== "microsoft-teams") return;
    const recorder = (this.adapter as unknown as TeamsAdapterInternals)
      .paperclipRecordThreadServiceUrl;
    if (typeof recorder !== "function") {
      throw new TeamsAdapterCompatibilityError(
        "durable route recorder is unavailable",
      );
    }
    await recorder.call(this.adapter, threadId, serviceUrl);
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
    if (this.provider !== "microsoft-teams" || !this.microsoftTeamsTenantId)
      return true;
    const tenantIds = microsoftTeamsTenantIds(raw);
    return (
      tenantIds.length > 0 &&
      tenantIds.every((tenantId) => tenantId === this.microsoftTeamsTenantId)
    );
  }

  /** Build the closed, credential-free locator stored with durable ingress. */
  attachmentRecoveryDescriptor(
    attachment: Attachment,
  ): ChatSdkAttachmentRecoveryDescriptor | null {
    return createAttachmentRecoveryDescriptor(this.provider, attachment);
  }

  /**
   * Rebuild an adapter-authenticated download closure after process restart.
   * Invalid, cross-provider, or no-longer-safe descriptors fail closed.
   */
  rehydrateAttachment(descriptor: unknown): Attachment | null {
    const validated = validatedAttachmentRecoveryDescriptor(
      this.provider,
      descriptor,
    );
    if (!validated || !this.adapter.rehydrateAttachment) return null;
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
    this.discordGatewayAbort?.abort();
    await this.discordGatewayTask?.catch(() => undefined);
    this.discordGatewayAbort = null;
    await this.chat.shutdown();
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

  get(endpointId: string): ChatSdkEndpointRuntime | null {
    return this.endpoints.get(endpointId) ?? null;
  }

  list(): ChatSdkEndpointRuntime[] {
    return [...this.endpoints.values()];
  }

  async replaceEndpoint(
    options: CreateChatSdkEndpointRuntimeOptions,
  ): Promise<ChatSdkEndpointRuntime> {
    const next = createChatSdkEndpointRuntime(options);
    const previous = this.endpoints.get(options.endpointId);
    this.endpoints.set(options.endpointId, next);
    await previous?.shutdown();
    return next;
  }

  async removeEndpoint(endpointId: string): Promise<boolean> {
    const runtime = this.endpoints.get(endpointId);
    if (!runtime) return false;
    this.endpoints.delete(endpointId);
    await runtime.shutdown();
    return true;
  }

  async handleWebhook(
    endpointId: string,
    request: Request,
    options?: WebhookOptions,
    responseDeadlineAt?: number,
  ): Promise<Response> {
    const runtime = this.endpoints.get(endpointId);
    if (!runtime) throw new ChatSdkEndpointNotRegisteredError(endpointId);
    return await runtime.handleWebhook(request, options, responseDeadlineAt);
  }

  async shutdown(): Promise<void> {
    const runtimes = [...this.endpoints.values()];
    this.endpoints.clear();
    await Promise.all(
      runtimes.map(async (runtime) => await runtime.shutdown()),
    );
  }
}

export function createChatSdkRuntime(): ChatSdkRuntime {
  return new ChatSdkRuntime();
}
