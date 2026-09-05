import {
  createGitHubAdapter,
  type GitHubAdapterConfig,
} from "@chat-adapter/github";
import {
  createSlackAdapter,
  type SlackAdapterConfig,
} from "@chat-adapter/slack";
import {
  createTeamsAdapter,
  type TeamsAdapterConfig,
} from "@chat-adapter/teams";
import {
  createTelegramAdapter,
  type TelegramAdapterConfig,
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

/** Public Paperclip provider ids. The Teams SDK name remains an internal detail. */
export type ChatSdkProvider =
  "slack" | "github" | "microsoft-teams" | "telegram";
type ChatSdkAdapterKey = "slack" | "github" | "teams" | "telegram";

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
  credentials: {
    apiUrl?: string;
    botToken: string;
    secretToken: string;
  };
}

export type ResolvedChatSdkProviderConfig =
  | ResolvedSlackChatConfig
  | ResolvedGitHubChatConfig
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

/**
 * Provider-neutral callbacks consumed by the Paperclip control-plane service.
 * All provider events have already passed the installed adapter's verifier and
 * normalization. Raw provider payloads remain available only through the
 * Chat SDK event escape hatches; callers must never publish them directly.
 */
export interface ChatSdkRuntimeCallbacks {
  onMessage(event: ChatSdkMessageCallbackEvent): Promise<void> | void;
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

function createProviderAdapter(
  config: ResolvedChatSdkProviderConfig,
  logger: CreateChatSdkEndpointRuntimeOptions["logger"],
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
      return createGitHubAdapter(adapterConfig);
    }
    case "microsoft-teams": {
      const adapterConfig: TeamsAdapterConfig = {
        ...config.credentials,
        logger: resolvedLogger,
        userName: config.userName,
      };
      return createTeamsAdapter(adapterConfig);
    }
    case "telegram": {
      const adapterConfig: TelegramAdapterConfig = {
        ...config.credentials,
        logger: resolvedLogger,
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
    this.webhookIngressTimeoutMs = Math.max(
      1,
      Math.min(options.webhookIngressTimeoutMs ?? 2_500, 10_000),
    );
    this.adapter = createProviderAdapter(
      options.providerConfig,
      options.logger,
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
  }

  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
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
    const deadlineAt = Date.now() + this.webhookIngressTimeoutMs;
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

  /**
   * Keep a dedicated Teams endpoint bound to the configured organization.
   * Bot Framework authentication validates the service token, app audience,
   * and service URL, but its service-issued JWT is not tenant-scoped. The
   * verified activity body therefore remains the authoritative tenant claim.
   */
  acceptsProviderScope(raw: unknown): boolean {
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
  ): Promise<Response> {
    const runtime = this.endpoints.get(endpointId);
    if (!runtime) throw new ChatSdkEndpointNotRegisteredError(endpointId);
    return await runtime.handleWebhook(request, options);
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
