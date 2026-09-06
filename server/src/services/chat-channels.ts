import {
  createHash,
  createHmac,
  createPrivateKey,
  createSign,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  assets,
  authUsers,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointLeases,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  chatSdkState,
  companies,
  companyMemberships,
  issueComments,
  issueAttachments,
  issueThreadInteractions,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatAdapterCapabilities,
  ChatEventKind,
  ChatEndpoint,
  ChatEndpointSetupState,
  ChatProvider,
  ConfigureChatEndpointInput,
  CreateChatEndpointInput,
  ExternalChannelBindingSummary,
  SafeChatPublicationPayload,
  ToolCredentialSecretRef,
  UpdateChatEndpointInput,
} from "@paperclipai/shared";
import {
  isAgentStatusInvokable,
  LOW_TRUST_REVIEW_PRESET,
  LOW_TRUST_REVIEW_PRESET_VERSION,
  LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
} from "@paperclipai/shared";
import {
  isAllowedContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeContentType,
  normalizeUploadAttachmentContentType,
} from "../attachment-types.js";
import { isUniqueViolation } from "../db-errors.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { redactSensitiveText } from "../redaction.js";
import type { StorageService } from "../storage/types.js";
import {
  createChatSdkRuntime,
  DiscordAdapterCompatibilityError,
  type ChatSdkCallbackEvent,
  type ChatSdkEndpointRuntime,
  type ChatSdkMessageCallbackEvent,
  type ChatSdkMessageUpdatedCallbackEvent,
  type ChatSdkProvider,
  type ChatSdkRuntime,
  type DiscordRootMentionAdmissionEvent,
  type ResolvedChatSdkProviderConfig,
} from "./chat-sdk-runtime.js";
import type {
  ChatSdkStateCompareAndSetInput,
  ChatSdkStateDeleteInput,
  ChatSdkStatePersistence,
  ChatSdkStateScope,
} from "./chat-sdk-state.js";
import { logActivity } from "./activity-log.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { getExternalChannelBindingSummary } from "./chat-channel-binding.js";
import {
  discoverDedicatedGitHubAppInstallation,
  getSlackBotChannel,
  listGitHubInstallationRepositories,
  listSlackBotChannels,
  type ChatProviderInventoryResult,
  type ChatProviderResourceInventoryItem,
} from "./chat-provider-inventory.js";
import { listDiscordBotChannels, verifyDiscordBot } from "./chat-discord.js";
import {
  parseChatProviderLifecycle,
  type ChatProviderLifecycleEffect,
} from "./chat-provider-lifecycle.js";
import {
  enqueueTerminalIssueInteractionChatPublications,
  nativeChatQuestion,
  nativeTelegramConfirmation,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  telegramChatSdkCallbackData,
} from "./chat-interaction-publications.js";
import { chatProviderConversationUrl } from "./chat-provider-links.js";
import { classifyChatPublicationError } from "./chat-publication-errors.js";
import {
  normalizeMicrosoftTeamsCredentialIds,
  normalizeMicrosoftTeamsExternalPrincipalId,
} from "./chat-teams-credentials.js";
import {
  shouldStreamSafePublicationText,
  streamSafePublicationText,
} from "./chat-publication-stream.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import {
  questionResponseDeliveryService,
  type QuestionResponseDeliveryServiceOptions,
} from "./question-response-delivery.js";
import {
  claimChatQuestionFormSubmission,
  completeChatQuestionFormSubmission,
  isChatQuestionFormOpenActionId,
  loadChatQuestionFormSubmissionToken,
  resolveChatQuestionFormOpen,
  validateChatQuestionFormSubmission,
} from "./chat-question-forms.js";
import { secretService } from "./secrets.js";
import type {
  ActionEvent,
  AdapterPostableMessage,
  Attachment,
  Author,
  FileUpload,
  Message,
  MessageDeletedEvent,
  ModalResponse,
  ModalSubmitEvent,
  ReactionEvent,
  SlashCommandEvent,
  Thread,
} from "chat";
import { Actions, Button, Card, CardText, LinkButton } from "chat";

const PROVIDER_LABELS: Record<ChatProvider, string> = {
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
};

function slackRequestSignatureIsValid(
  request: Request,
  body: string,
  signingSecret: string,
): boolean {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 300
  )
    return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function slackRequestWorkspaceId(
  body: string,
  contentType: string,
): string | null {
  let payload: unknown;
  try {
    if (contentType.includes("application/json")) {
      payload = JSON.parse(body);
    } else {
      const form = new URLSearchParams(body);
      const interactivePayload = form.get("payload");
      payload = interactivePayload
        ? JSON.parse(interactivePayload)
        : Object.fromEntries(form.entries());
    }
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const nestedId = (value: unknown): string | null => {
    if (!value || typeof value !== "object") return null;
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? id : null;
  };
  const stringField = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const authorization = Array.isArray(record.authorizations)
    ? record.authorizations.find(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === "object",
      )
    : null;
  const authorizationField = (key: string): string | null => {
    const value = authorization?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  // A Grid event may carry both an enterprise id and the concrete workspace
  // id. The bot identity is verified against auth.test's team_id, so prefer a
  // team id and use the enterprise id only when Slack omitted team context.
  return (
    stringField("team_id") ??
    nestedId(record.team) ??
    authorizationField("team_id") ??
    stringField("enterprise_id") ??
    nestedId(record.enterprise) ??
    authorizationField("enterprise_id")
  );
}

const CAPABILITIES: Record<ChatProvider, ChatAdapterCapabilities> = {
  slack: {
    threads: true,
    directMessages: true,
    nativeStreaming: true,
    messageEdits: true,
    messageDeletes: true,
    reactions: true,
    files: true,
    cards: true,
    actions: true,
    modals: true,
    slashCommands: true,
    ephemeralMessages: true,
    proactiveDirectMessages: false,
  },
  github: {
    threads: true,
    directMessages: false,
    nativeStreaming: false,
    messageEdits: true,
    messageDeletes: true,
    reactions: true,
    files: false,
    cards: true,
    actions: false,
    modals: false,
    slashCommands: false,
    ephemeralMessages: false,
    proactiveDirectMessages: false,
  },
  discord: {
    threads: true,
    directMessages: true,
    nativeStreaming: false,
    messageEdits: true,
    messageDeletes: true,
    reactions: true,
    files: true,
    cards: true,
    actions: true,
    modals: false,
    // The root mention/thread path is automatic. Paperclip does not register a
    // Discord application command yet, so do not advertise an unusable command.
    slashCommands: false,
    ephemeralMessages: false,
    proactiveDirectMessages: false,
  },
  "microsoft-teams": {
    threads: true,
    directMessages: true,
    // Production webhook processing is deferred into Paperclip's durable
    // ingress queue. The Teams adapter's request-scoped DM streamer is gone by
    // the time agent output is published, so advertise the durable behavior we
    // can actually provide. editMessage still lets one run coalesce its
    // queued, working, and final states in place.
    nativeStreaming: false,
    // The pinned Teams adapter does not yet normalize inbound Bot Framework
    // messageUpdate activities.
    messageEdits: true,
    messageDeletes: false,
    reactions: true,
    files: true,
    cards: true,
    actions: true,
    modals: true,
    slashCommands: false,
    ephemeralMessages: true,
    proactiveDirectMessages: false,
  },
  telegram: {
    threads: true,
    directMessages: true,
    nativeStreaming: true,
    messageEdits: true,
    // Telegram's Bot API does not emit an update when a user deletes a
    // message, so this capability cannot be offered truthfully.
    messageDeletes: false,
    reactions: true,
    files: true,
    cards: true,
    actions: true,
    modals: false,
    slashCommands: false,
    ephemeralMessages: false,
    proactiveDirectMessages: false,
  },
};

const REQUIRED_CREDENTIALS: Record<
  Exclude<ChatProvider, "github">,
  readonly string[]
> = {
  slack: ["botToken", "signingSecret"],
  discord: ["botToken", "applicationId", "guildId"],
  "microsoft-teams": ["clientId", "tenantId", "clientSecret"],
  telegram: ["botToken"],
};

const REQUIRED_SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users:read",
] as const;

const REQUIRED_GITHUB_EVENTS = [
  "issue_comment",
  "pull_request_review_comment",
] as const;

const REQUIRED_GITHUB_PERMISSIONS = {
  issues: "write",
  metadata: "read",
  pull_requests: "write",
} as const;

const TELEGRAM_COMMANDS = [
  { command: "task", description: "Start or continue a Paperclip task" },
  { command: "status", description: "Show the active Paperclip task" },
  { command: "new", description: "Start a new task after the current one" },
  { command: "close", description: "Close the active Paperclip task" },
] as const;

const UNAVOIDABLE_GITHUB_EVENTS = [
  "github_app_authorization",
  "installation",
  "installation_repositories",
] as const;

const SUPPLIED_CREDENTIAL_KEYS: Record<ChatProvider, readonly string[]> = {
  slack: ["botToken", "signingSecret"],
  github: ["appId", "privateKey"],
  discord: ["botToken", "applicationId", "guildId"],
  "microsoft-teams": ["clientId", "tenantId", "clientSecret"],
  telegram: ["botToken"],
};

const MAX_INBOUND_TEXT = 100_000;
const MAX_ERROR_TEXT = 2_000;
const DELIVERY_PROCESSING_STALE_MS = 60_000;
// A Discord root mention is durably staged before the adapter creates its
// provider thread. Give the bounded provider retry loop ample time to finish;
// if the process disappears, the delivery worker verifies that thread over
// Discord's read-only API before it permits any Paperclip task mutation.
const DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS = 5 * 60_000;
const DELIVERY_LEASE_TTL_MS = 90_000;
const DELIVERY_DRAIN_LIMIT = 100;
const SLACK_COMMAND_POST_STALE_MS = 60_000;
const SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS = 5 * 60_000;
const SLACK_COMMAND_ADMISSION_STALE_MS = 60_000;
const PROVIDER_EFFECT_STALE_MS = 60_000;
const ORPHAN_FOLLOW_UP_GRACE_MS = 5_000;
const ORPHAN_FOLLOW_UP_MAX_ATTEMPTS = 12;
const CREDENTIAL_MUTATION_LEASE_TTL_MS = 90_000;
const CREDENTIAL_MUTATION_LEASE_WAIT_MS = 10_000;
const CREDENTIAL_MUTATION_LEASE_POLL_MS = 25;
const PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS = 25_000;
const GITHUB_WEBHOOK_RESPONSE_BUDGET_MS = 8_000;
const GITHUB_WEBHOOK_INTERNAL_RETRY_MAX = 3;
const RECEIPT_REACTION_MAX_ATTEMPTS = 3;
const CONFIRMATION_WAKEUP_RETRY_BACKOFF_MS = 30_000;
const RECEIPT_REACTION_MAX_RETRY_DELAY_MS = 2_000;
// Providers can deliver adjacent callbacks on separate HTTP requests out of
// order. Hold the first callback briefly so a rapid burst can be sorted by the
// provider's own timestamp and sequence before any run is started.
const INGRESS_REORDER_WINDOW_MS: Partial<Record<ChatProvider, number>> = {
  // Both providers deliver adjacent comments as independent HTTP requests and
  // do not guarantee callback arrival order. A fixed, non-sliding window lets
  // the durable drain sort a short burst before the first agent wake starts.
  slack: 750,
  github: 750,
  discord: 750,
  // Bot Framework can dispatch adjacent activities over independent requests.
  // Keep Teams bursts inside the same provider-timestamp ordering boundary as
  // Slack and GitHub so a faster later reply cannot wake the agent first.
  "microsoft-teams": 750,
  // Telegram's webhook max_connections setting permits concurrent delivery.
  // Its message timestamp has only one-second resolution, so the drain also
  // uses message_id/update_id below to order callbacks within this fixed,
  // non-sliding window without serializing separate chats.
  telegram: 750,
};

type EndpointRow = typeof chatEndpoints.$inferSelect;
type ResourceRow = typeof chatEndpointResources.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;
type InternalSetupState = ChatEndpointSetupState & {
  runtimeGeneration?: number;
};
type RuntimeContext = {
  credentialFingerprint: string;
  endpointRuntime?: ChatSdkEndpointRuntime;
  generation: number;
  localEpoch: number;
  version: string;
};
type LifecycleRuntimeFence = Pick<
  RuntimeContext,
  "credentialFingerprint" | "generation"
>;
type VerifiedProviderIdentity = {
  providerAccountId?: string | null;
  providerAccountLabel?: string | null;
  botExternalId?: string | null;
  botUsername?: string | null;
  botLabel?: string | null;
};

function runtimeGeneration(setup: ChatEndpointSetupState): number {
  const value = Number((setup as InternalSetupState).runtimeGeneration ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function credentialFingerprint(refs: ToolCredentialSecretRef[]): string {
  const stable = refs
    .map((ref) => ({
      configPath: ref.configPath,
      secretId: ref.secretId,
      versionSelector: ref.versionSelector ?? "latest",
    }))
    .sort((left, right) =>
      `${left.configPath}:${left.secretId}:${left.versionSelector}`.localeCompare(
        `${right.configPath}:${right.secretId}:${right.versionSelector}`,
      ),
    );
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
type ConversationRow = typeof chatConversations.$inferSelect;
type DeliveryRow = typeof chatDeliveries.$inferSelect;
type LiveInboundMessage = {
  endpoint: EndpointRow;
  message: Message;
  receiptReactionSupported: boolean;
  thread: Thread;
  trigger: ChatSdkMessageCallbackEvent["trigger"];
};
type ProviderEffectTarget = {
  post: Thread["post"];
  postEphemeral?: Thread["postEphemeral"];
};
type ProviderEffectPayload = {
  version: 1;
  effect: "thread_message" | "ephemeral_message";
  authorizationMode?: "principal" | "safe_notice";
  threadId: string;
  userId?: string;
  text: string;
  fallbackText?: string;
  settleDelivery: boolean;
  completeConversationId?: string;
  resourceId?: string;
  runtimeGeneration: number;
  credentialFingerprint: string;
};

function providerEffectPayload(
  payload: Record<string, unknown>,
): ProviderEffectPayload | null {
  if (
    payload.version !== 1 ||
    (payload.effect !== "thread_message" &&
      payload.effect !== "ephemeral_message") ||
    typeof payload.threadId !== "string" ||
    !payload.threadId ||
    typeof payload.text !== "string" ||
    !payload.text ||
    typeof payload.settleDelivery !== "boolean" ||
    typeof payload.runtimeGeneration !== "number" ||
    !Number.isSafeInteger(payload.runtimeGeneration) ||
    typeof payload.credentialFingerprint !== "string"
  ) {
    return null;
  }
  if (
    payload.effect === "ephemeral_message" &&
    (typeof payload.userId !== "string" || !payload.userId)
  ) {
    return null;
  }
  for (const key of [
    "authorizationMode",
    "userId",
    "fallbackText",
    "completeConversationId",
    "resourceId",
  ] as const) {
    const value = payload[key];
    if (value !== undefined && (typeof value !== "string" || !value)) {
      return null;
    }
  }
  if (
    payload.authorizationMode !== undefined &&
    payload.authorizationMode !== "principal" &&
    payload.authorizationMode !== "safe_notice"
  ) {
    return null;
  }
  return payload as ProviderEffectPayload;
}

export interface ChatChannelServiceOptions {
  /**
   * Provider webhooks await only the durable ingress write, then finish task
   * processing outside the provider response budget. Tests may leave this off
   * when they need direct callback assertions.
   */
  deferWebhookProcessing?: boolean;
  /** Test override for GitHub's end-to-end webhook response budget. */
  githubWebhookResponseBudgetMs?: number;
  fetch?: typeof globalThis.fetch;
  heartbeat: IssueAssignmentWakeupDeps;
  /** Production bridge for resuming a native run that owns the question. */
  resolveNativeQuestion?: QuestionResponseDeliveryServiceOptions["resolveNativeQuestion"];
  publicBaseUrl?: string | null;
  runtime?: ChatSdkRuntime;
  /** Testable scheduler hook; production defaults to the next event-loop turn. */
  scheduleDeferredWork?: (task: () => void) => void;
  /** Narrow fault-injection boundary for the one-time setup-secret audit. */
  setupSecretActivityLogger?: typeof logActivity;
  /** Testable barrier after fail-closed state and before secret-ref mutation. */
  setupSecretCredentialPersistBarrier?: () => Promise<void>;
  /** Testable crash boundary after interaction commit and before chat settlement. */
  confirmationResolutionPersistBarrier?: () => Promise<void>;
  /** Testable boundary after a question callback claim and before resolution. */
  questionResolutionPersistBarrier?: () => Promise<void>;
  /** Testable boundary before the final question-form opener authorization fence. */
  questionFormOpenAuthorizationBarrier?: () => Promise<void>;
  /** Testable boundary immediately before the final inbound reach row lock. */
  reachAuthorizationBarrier?: () => Promise<void>;
  /** Test override for the conversation-delivery lease renewal cadence. */
  conversationLeaseRenewalIntervalMs?: number;
  /** Narrow fault-injection boundary for renewing a conversation lease. */
  renewConversationDeliveryLease?: (input: {
    endpointId: string;
    leaseKey: string;
    token: string;
    expiresAt: Date;
  }) => Promise<boolean>;
  storage?: StorageService;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function providerResourceType(
  provider: ChatProvider,
  surfaceKind: ChatSurfaceKind,
): string {
  if (surfaceKind === "direct_message") return "direct_message";
  if (provider === "github") return "repository";
  if (provider === "discord") return "channel";
  if (provider === "microsoft-teams")
    return surfaceKind === "linear_group" ? "group_chat" : "channel";
  // Telegram topics are task/thread boundaries inside one group resource. The
  // operator grants access to the chat once rather than having to rediscover
  // and enable every topic independently.
  if (provider === "telegram") return "chat";
  return "channel";
}

type ChatSurfaceKind = "direct_message" | "linear_group" | "native_thread";

function teamsConversationId(threadId: string): string | null {
  const match = /^teams:([^:]+):/.exec(threadId);
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function baseTeamsConversationId(value: string): string {
  return value.replace(/;messageid=[^;]+/i, "");
}

function teamsThreadRootMessageId(threadId: string): string | null {
  const conversationId = teamsConversationId(threadId);
  if (!conversationId) return null;
  return /;messageid=([^;]+)/i.exec(conversationId)?.[1] ?? null;
}

function canonicalProviderResourceId(
  provider: ChatProvider,
  thread: Pick<Thread, "channelId" | "id">,
): string {
  if (provider === "slack") return thread.channelId.replace(/^slack:/, "");
  if (provider === "github")
    return thread.channelId.replace(/^github:/, "").toLowerCase();
  if (provider === "discord") {
    const parts = thread.channelId.split(":");
    return parts[2] ?? thread.channelId;
  }
  if (provider === "microsoft-teams") {
    const conversationId =
      teamsConversationId(thread.channelId) ?? teamsConversationId(thread.id);
    return conversationId
      ? baseTeamsConversationId(conversationId)
      : baseTeamsConversationId(thread.channelId);
  }
  if (provider === "telegram")
    return thread.channelId.replace(/^telegram:/, "");
  return thread.channelId;
}

function slackResourceLabelIsFallback(
  providerResourceId: string,
  label: string,
): boolean {
  const candidate = label.trim();
  return (
    candidate === providerResourceId ||
    candidate === `slack:${providerResourceId}`
  );
}

function telegramResourceLabelIsFallback(
  providerResourceId: string,
  label: string,
): boolean {
  const candidate = label.trim();
  return (
    candidate === providerResourceId ||
    candidate === `telegram:${providerResourceId}`
  );
}

function providerResourceLabelFromThread(
  provider: ChatProvider,
  thread: Pick<Thread, "channelId" | "id" | "channel">,
): { label: string; fallback: boolean } {
  const providerResourceId = canonicalProviderResourceId(provider, thread);
  const candidate = thread.channel.name?.trim();
  if (!candidate) return { label: providerResourceId, fallback: true };
  if (
    (provider === "slack" &&
      slackResourceLabelIsFallback(providerResourceId, candidate)) ||
    (provider === "telegram" &&
      telegramResourceLabelIsFallback(providerResourceId, candidate))
  ) {
    return { label: providerResourceId, fallback: true };
  }
  return { label: candidate, fallback: false };
}

/**
 * Native channel threads keep one issue forever. Linear surfaces instead
 * advance through Paperclip task generations because their provider id is
 * reused after a task completes or the user explicitly starts a new task.
 */
function chatSurfaceKind(
  provider: ChatProvider,
  thread: Thread,
): ChatSurfaceKind {
  if (thread.isDM) return "direct_message";
  if (provider === "telegram") {
    return /^telegram:[^:]+:[^:]+$/.test(thread.id)
      ? "native_thread"
      : "linear_group";
  }
  if (provider === "microsoft-teams") {
    const conversationId = teamsConversationId(thread.id);
    return conversationId?.includes(";messageid=")
      ? "native_thread"
      : "linear_group";
  }
  return "native_thread";
}

/**
 * Teams group chats are admitted as a class: installation at the provider and
 * the endpoint's group-chat toggle are the two gates the operator can
 * actually control. Teams channels, and every other non-DM destination,
 * retain the explicit per-resource enablement gate shown in Settings.
 */
function nonDirectDestinationAllowed(
  endpoint: EndpointRow,
  resource: ResourceRow | null | undefined,
): boolean {
  if (!resource || resource.availability !== "available") return false;
  if (
    endpoint.provider === "microsoft-teams" &&
    resource.type === "group_chat"
  ) {
    return endpoint.allowGroupChats;
  }
  return resource.enabled;
}

function linearControlCommand(text: string): "new" | "close" | "status" | null {
  const match = /^\/(new|close|status)(?:@[\w.-]+)?\s*$/i.exec(text.trim());
  return (
    (match?.[1]?.toLowerCase() as "new" | "close" | "status" | undefined) ??
    null
  );
}

function telegramGuidanceCommand(
  text: string,
): "start" | "task" | "unknown" | null {
  const match = /^\/([a-z][\w-]*)(?:@[\w.-]+)?(?:\s|$)/i.exec(text.trim());
  const command = match?.[1]?.toLowerCase();
  if (
    !command ||
    command === "new" ||
    command === "close" ||
    command === "status"
  )
    return null;
  if (command === "start") return "start";
  if (command === "task") return "task";
  return "unknown";
}

function stableExternalPrincipalId(
  provider: ChatProvider,
  author: Author,
  raw?: unknown,
): string {
  if (provider !== "microsoft-teams" || !raw || typeof raw !== "object")
    return author.userId;
  const from = (raw as { from?: unknown }).from;
  if (!from || typeof from !== "object") return author.userId;
  const aadObjectId = (from as { aadObjectId?: unknown }).aadObjectId;
  return normalizeMicrosoftTeamsExternalPrincipalId(aadObjectId, author.userId);
}

function safeTitle(text: string, fallback: string): string {
  const line = text
    .replace(/<@[A-Z0-9]+>/gi, "")
    .replace(/@[\w.-]+(?:\[bot\])?/gi, "")
    .trim()
    .split(/\r?\n/)[0];
  return (line || fallback).slice(0, 160);
}

function hasMeaningfulSlackMentionRequest(text: string): boolean {
  const withoutMentions = text
    .replace(/<@[^>|\s]+(?:\|[^>]+)?>/gi, " ")
    .replace(/(^|\s)@[A-Z0-9._-]+(?=\s|$)/gi, " ");
  return withoutMentions.replace(/[\s\p{P}\p{S}\p{Cf}]/gu, "").length > 0;
}

type SlackSlashTaskRecoveryPayload = {
  channelId: string;
  command: string;
  syntheticMessageId: string;
  taskText: string;
};

function slackSlashTaskRecoveryPayload(
  payload: Record<string, unknown>,
): SlackSlashTaskRecoveryPayload | null {
  const channelId = payload.channelId;
  const command = payload.command;
  const syntheticMessageId = payload.syntheticMessageId;
  const taskText = payload.taskText;
  if (
    typeof channelId !== "string" ||
    !channelId.trim() ||
    typeof command !== "string" ||
    !command.trim() ||
    typeof syntheticMessageId !== "string" ||
    !syntheticMessageId.trim() ||
    typeof taskText !== "string" ||
    !taskText.trim()
  ) {
    return null;
  }
  return { channelId, command, syntheticMessageId, taskText };
}

function slackTaskStarterThreadId(
  channelId: string,
  providerMessageId: string,
): string {
  return `slack:${channelId.replace(/^slack:/, "")}:${providerMessageId}`;
}

function slackThreadChannelId(threadId: string): string | null {
  if (!threadId.startsWith("slack:")) return null;
  const channelAndThread = threadId.slice("slack:".length);
  const separator = channelAndThread.indexOf(":");
  const channelId =
    separator === -1 ? channelAndThread : channelAndThread.slice(0, separator);
  return channelId || null;
}

function actionThreadMatchesConversation(
  provider: ChatProvider,
  actionThreadId: string,
  conversationThreadId: string,
): boolean {
  if (provider !== "slack") return actionThreadId === conversationThreadId;
  const actionChannelId = slackThreadChannelId(actionThreadId);
  return (
    actionChannelId !== null &&
    actionChannelId === slackThreadChannelId(conversationThreadId)
  );
}

function slackTaskStartActivityStatus(action: {
  status: string;
  updatedAt: Date;
}): string {
  const age = Date.now() - action.updatedAt.getTime();
  if (action.status === "validating" && age >= SLACK_COMMAND_POST_STALE_MS) {
    return "queued";
  }
  if (
    (action.status === "received" && age >= SLACK_COMMAND_POST_STALE_MS) ||
    (action.status === "resolving" &&
      age >= SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS)
  ) {
    return "delivery_unknown";
  }
  return action.status;
}

function confirmedSlackTaskStartResult(
  result: Record<string, unknown> | null,
): {
  authorizedUserId?: string | null;
  providerMessageId: string;
  threadId: string;
} | null {
  if (
    !result ||
    typeof result.providerMessageId !== "string" ||
    !result.providerMessageId ||
    typeof result.threadId !== "string" ||
    !result.threadId
  ) {
    return null;
  }
  const hasAuthorizedUserId = Object.prototype.hasOwnProperty.call(
    result,
    "authorizedUserId",
  );
  if (
    hasAuthorizedUserId &&
    result.authorizedUserId !== null &&
    (typeof result.authorizedUserId !== "string" || !result.authorizedUserId)
  ) {
    return null;
  }
  return {
    ...(hasAuthorizedUserId
      ? { authorizedUserId: result.authorizedUserId as string | null }
      : {}),
    providerMessageId: result.providerMessageId,
    threadId: result.threadId,
  };
}

function sanitizeFilename(value: string | undefined): string | null {
  if (!value) return null;
  const leaf = value.replaceAll("\\", "/").split("/").pop()?.trim();
  return leaf ? leaf.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) : null;
}

function redactError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Telegram authenticates Bot API calls with a token embedded in the URL
  // path. Generic key/value redaction cannot recognize that shape, so scrub
  // both literal and URL-encoded forms before an error reaches logs, health
  // state, or an HTTP response.
  const withoutTelegramBotTokens = text
    .replace(/(\/bot)\d{5,}(?::|%3A)[A-Za-z0-9_-]{20,}/gi, "$1***REDACTED***")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "***REDACTED***");
  return redactSensitiveText(withoutTelegramBotTokens).slice(0, MAX_ERROR_TEXT);
}

function receiptReactionTransportRetryDelay(
  error: unknown,
  attempt: number,
): number | null {
  const disposition = classifyChatPublicationError(error, attempt);
  if (disposition.kind === "retry") {
    return Math.max(
      1,
      Math.min(RECEIPT_REACTION_MAX_RETRY_DELAY_MS, disposition.retryAfterMs),
    );
  }
  if (disposition.kind !== "delivery_unknown") return null;
  const value =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          name?: unknown;
          response?: { status?: unknown };
          status?: unknown;
          statusCode?: unknown;
        })
      : null;
  const name = typeof value?.name === "string" ? value.name : "";
  const code = typeof value?.code === "string" ? value.code.toUpperCase() : "";
  const status = [
    value?.status,
    value?.statusCode,
    value?.response?.status,
  ].find((candidate): candidate is number => typeof candidate === "number");
  const retryableTransport =
    name === "NetworkError" ||
    name === "FetchError" ||
    name === "TypeError" ||
    [
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENETUNREACH",
      "ETIMEDOUT",
    ].includes(code) ||
    status === 408 ||
    status === 425 ||
    (status !== undefined && status >= 500 && status <= 599);
  if (!retryableTransport) return null;
  return Math.min(
    RECEIPT_REACTION_MAX_RETRY_DELAY_MS,
    100 * 2 ** Math.max(0, attempt - 1),
  );
}

async function attemptProviderPublication<T>(
  send: () => Promise<T>,
): Promise<T> {
  return await send();
}

async function editOrPostProviderPublication<T>(
  edit: () => Promise<T>,
  post: () => Promise<T>,
): Promise<T> {
  try {
    return await edit();
  } catch (error) {
    // A definite 404 proves the old progress comment no longer exists. It is
    // therefore safe to create a replacement without risking a duplicate.
    // Ambiguous transport failures must still enter delivery_unknown.
    if (classifyChatPublicationError(error, 1).kind !== "resource_unavailable")
      throw error;
    return await post();
  }
}

function safeCardForPublication(
  payload: SafeChatPublicationPayload,
  provider: ChatProvider,
) {
  if (!payload.card) return null;
  const children = [];
  if (payload.card.body) children.push(CardText(payload.card.body));
  const actions = (payload.card.actions ?? []).map((action) =>
    action.type === "callback"
      ? Button({
          id: action.actionId,
          label: action.label,
          style: action.style ?? "default",
          // Telegram encodes both id and value into callback_data, whose hard
          // limit is 64 bytes. Its opaque action id resolves through the
          // durable token ledger, so repeating the interaction UUID is both
          // unnecessary and too large. Other adapters retain the value as a
          // defense-in-depth binding supported by their larger envelopes.
          value: provider === "telegram" ? undefined : payload.interactionId,
          actionType: isChatQuestionFormOpenActionId(action.actionId)
            ? "modal"
            : undefined,
        })
      : LinkButton({ label: action.label, url: action.url }),
  );
  if (actions.length) children.push(Actions(actions));
  return Card({ title: payload.card.title, children });
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function githubAppJwt(
  appId: string,
  privateKey: string,
  now = new Date(),
): string {
  const epoch = Math.floor(now.getTime() / 1000);
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({ iat: epoch - 60, exp: epoch + 540, iss: appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(createPrivateKey(privateKey)).toString("base64url")}`;
}

function absoluteBaseUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

type GitHubLifecycleEvent = {
  actor?: LifecycleActor;
  eventKind: "message_updated" | "message_deleted";
  messageId: string;
  providerEventId?: string;
  providerMessageSequence: number | null;
  providerSentAt: string | null;
  revision: string;
  text: string;
  threadId: string;
};

type TelegramLifecycleEvent = {
  actor: LifecycleActor;
  eventKind: "message_updated";
  messageId: string;
  providerEventId?: string;
  providerMessageSequence: number;
  providerSentAt: string;
  providerUpdateId: number | null;
  revision: string;
  text: string;
  threadId: string;
};

type LifecycleActor = {
  displayName: string;
  externalId: string;
  handle: string;
};

type MicrosoftTeamsLifecycleEvent = {
  actor: LifecycleActor;
  eventKind: "message_updated";
  messageId: string;
  providerSentAt: string | null;
  revision: string;
  text: string;
  threadId: string;
};

function lifecycleActorFromAuthor(
  provider: ChatProvider,
  author: Author,
  raw?: unknown,
): LifecycleActor {
  return {
    externalId: stableExternalPrincipalId(provider, author, raw),
    displayName: author.fullName,
    handle: author.userName,
  };
}

function telegramLifecycleActor(message: {
  from?: unknown;
  sender_chat?: unknown;
}): LifecycleActor | null {
  const candidate =
    message.from &&
    typeof message.from === "object" &&
    !Array.isArray(message.from)
      ? (message.from as Record<string, unknown>)
      : message.sender_chat &&
          typeof message.sender_chat === "object" &&
          !Array.isArray(message.sender_chat)
        ? (message.sender_chat as Record<string, unknown>)
        : null;
  if (!candidate) return null;
  const id = candidate.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const handle =
    typeof candidate.username === "string" ? candidate.username : "";
  const displayName =
    [candidate.first_name, candidate.last_name]
      .filter(
        (value): value is string => typeof value === "string" && Boolean(value),
      )
      .join(" ") ||
    (typeof candidate.title === "string" ? candidate.title : "") ||
    handle ||
    String(id);
  return { externalId: String(id), displayName, handle };
}

function microsoftTeamsLifecycleEventFromPayload(
  payload: unknown,
  endpointRuntime: ChatSdkEndpointRuntime,
): MicrosoftTeamsLifecycleEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const activity = payload as {
    channelData?: { eventType?: unknown };
    timestamp?: unknown;
    type?: unknown;
  };
  if (
    activity.type !== "messageUpdate" ||
    activity.channelData?.eventType !== "editMessage"
  )
    return null;
  const message = endpointRuntime.parseMicrosoftTeamsMessage(payload);
  if (!message?.id || !message.threadId) return null;
  const body = message.text.slice(0, MAX_INBOUND_TEXT);
  const providerSentAt =
    typeof activity.timestamp === "string" &&
    Number.isFinite(Date.parse(activity.timestamp))
      ? new Date(activity.timestamp).toISOString()
      : null;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const revision = providerSentAt ? `${providerSentAt}:${bodyHash}` : bodyHash;
  return {
    actor: lifecycleActorFromAuthor(
      "microsoft-teams",
      message.author,
      message.raw,
    ),
    eventKind: "message_updated",
    messageId: message.id,
    providerSentAt,
    revision,
    text: `An external message was edited:\n\n${body}`,
    threadId: message.threadId,
  };
}

function telegramLifecycleEventFromPayload(
  payload: unknown,
): TelegramLifecycleEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const update = payload as {
    edited_message?: unknown;
    update_id?: unknown;
  };
  const edited = update.edited_message;
  if (!edited || typeof edited !== "object" || Array.isArray(edited))
    return null;
  const message = edited as {
    caption?: unknown;
    chat?: { id?: unknown };
    edit_date?: unknown;
    from?: unknown;
    message_id?: unknown;
    message_thread_id?: unknown;
    sender_chat?: unknown;
    text?: unknown;
  };
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const editDate = message.edit_date;
  if (
    (typeof chatId !== "string" && typeof chatId !== "number") ||
    typeof messageId !== "number" ||
    !Number.isSafeInteger(messageId) ||
    messageId < 0 ||
    typeof editDate !== "number" ||
    !Number.isSafeInteger(editDate) ||
    editDate <= 0
  )
    return null;
  const topicId = message.message_thread_id;
  if (topicId !== undefined && typeof topicId !== "number") return null;
  const body =
    typeof message.text === "string"
      ? message.text
      : typeof message.caption === "string"
        ? message.caption
        : "";
  const chat = String(chatId);
  const providerUpdateId =
    typeof update.update_id === "number" &&
    Number.isSafeInteger(update.update_id) &&
    update.update_id >= 0
      ? update.update_id
      : null;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const actor = telegramLifecycleActor(message);
  if (!actor) return null;
  return {
    actor,
    eventKind: "message_updated",
    messageId: `${chat}:${messageId}`,
    ...(providerUpdateId === null
      ? {}
      : { providerEventId: `telegram:update:${providerUpdateId}` }),
    providerMessageSequence: messageId,
    providerSentAt: new Date(editDate * 1_000).toISOString(),
    providerUpdateId,
    // Bot API timestamps have one-second resolution. The update id is the
    // authoritative identity when present; retaining a content hash keeps the
    // fallback path from collapsing two distinct edits in that same second.
    revision: `${editDate}:${bodyHash}`,
    text: `An external message was edited:\n\n${body.slice(0, MAX_INBOUND_TEXT)}`,
    threadId:
      topicId === undefined
        ? `telegram:${chat}`
        : `telegram:${chat}:${topicId}`,
  };
}

function isTelegramEditedMessageRaw(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    typeof (raw as { edit_date?: unknown }).edit_date === "number"
  );
}

function isTelegramMigrationRaw(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as {
    migrate_from_chat_id?: unknown;
    migrate_to_chat_id?: unknown;
  };
  return (
    value.migrate_from_chat_id !== undefined ||
    value.migrate_to_chat_id !== undefined
  );
}

function telegramMessageSequence(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as { message_id?: unknown }).message_id;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function telegramMessageId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as {
    chat?: { id?: unknown };
    message_id?: unknown;
  };
  const messageId = value.message_id;
  const chatId = value.chat?.id;
  if (
    typeof messageId !== "number" ||
    !Number.isSafeInteger(messageId) ||
    messageId < 0
  )
    return null;
  const normalizedChatId =
    typeof chatId === "number" && Number.isSafeInteger(chatId)
      ? String(chatId)
      : typeof chatId === "string" && /^-?\d+$/.test(chatId)
        ? chatId
        : null;
  return normalizedChatId ? `${normalizedChatId}:${messageId}` : null;
}

function telegramMessageSentAt(raw: unknown): Date | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as { date?: unknown }).date;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return null;
  const sentAt = new Date(value * 1_000);
  return Number.isFinite(sentAt.getTime()) ? sentAt : null;
}

async function githubLifecycleEventFromRequest(
  request: Request,
): Promise<GitHubLifecycleEvent | null> {
  const eventType = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery")?.trim() || null;
  if (
    eventType !== "issue_comment" &&
    eventType !== "pull_request_review_comment"
  )
    return null;
  const payload = (await request.json()) as {
    action?: unknown;
    comment?: {
      id?: unknown;
      in_reply_to_id?: unknown;
      body?: unknown;
      updated_at?: unknown;
    };
    issue?: { number?: unknown; pull_request?: unknown };
    pull_request?: { number?: unknown };
    repository?: { name?: unknown; owner?: { login?: unknown } };
    sender?: { id?: unknown; login?: unknown };
  };
  if (payload.action !== "edited" && payload.action !== "deleted") return null;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const messageId = payload.comment?.id;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    (typeof messageId !== "string" && typeof messageId !== "number")
  )
    return null;
  let threadId: string;
  if (eventType === "issue_comment") {
    const number = payload.issue?.number;
    if (typeof number !== "number") return null;
    threadId = payload.issue?.pull_request
      ? `github:${owner}/${repo}:${number}`
      : `github:${owner}/${repo}:issue:${number}`;
  } else {
    const number = payload.pull_request?.number;
    const rootCommentId =
      payload.comment?.in_reply_to_id ?? payload.comment?.id;
    if (
      typeof number !== "number" ||
      (typeof rootCommentId !== "string" && typeof rootCommentId !== "number")
    )
      return null;
    threadId = `github:${owner}/${repo}:${number}:rc:${rootCommentId}`;
  }
  const eventKind =
    payload.action === "edited" ? "message_updated" : "message_deleted";
  const body =
    typeof payload.comment?.body === "string"
      ? payload.comment.body.slice(0, MAX_INBOUND_TEXT)
      : "";
  const providerRevision =
    typeof payload.comment?.updated_at === "string"
      ? payload.comment.updated_at
      : payload.action;
  const parsedProviderSentAt = new Date(providerRevision);
  const providerSentAt = Number.isFinite(parsedProviderSentAt.getTime())
    ? parsedProviderSentAt.toISOString()
    : null;
  const numericMessageId =
    typeof messageId === "number"
      ? messageId
      : typeof messageId === "string" && /^\d+$/.test(messageId)
        ? Number(messageId)
        : null;
  const providerMessageSequence =
    numericMessageId !== null &&
    Number.isSafeInteger(numericMessageId) &&
    numericMessageId >= 0
      ? numericMessageId
      : null;
  const senderId = payload.sender?.id;
  const senderLogin = payload.sender?.login;
  const actor =
    (typeof senderId === "string" || typeof senderId === "number") &&
    typeof senderLogin === "string" &&
    senderLogin.length > 0
      ? {
          externalId: String(senderId),
          displayName: senderLogin,
          handle: senderLogin,
        }
      : undefined;
  return {
    ...(actor ? { actor } : {}),
    eventKind,
    messageId: String(messageId),
    ...(deliveryId ? { providerEventId: `github:delivery:${deliveryId}` } : {}),
    providerMessageSequence,
    providerSentAt,
    // GitHub's updated_at value can have coarser resolution than a quick
    // sequence of edits. Include the normalized body so distinct edits at the
    // same timestamp remain durable while an exact webhook redelivery still
    // deduplicates.
    revision:
      eventKind === "message_updated"
        ? `${providerRevision}:${createHash("sha256").update(body).digest("hex")}`
        : providerRevision,
    text:
      eventKind === "message_updated"
        ? `An external message was edited:\n\n${body}`
        : "An external message in this conversation was deleted.",
    threadId,
  };
}

function githubRepositoryInventoryItemFromPayload(
  payload: unknown,
): ChatProviderResourceInventoryItem | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const repository = (payload as { repository?: unknown }).repository;
  if (
    !repository ||
    typeof repository !== "object" ||
    Array.isArray(repository)
  )
    return null;
  const value = repository as {
    id?: unknown;
    full_name?: unknown;
    html_url?: unknown;
    name?: unknown;
    owner?: { id?: unknown; login?: unknown };
    private?: unknown;
  };
  const repositoryId =
    typeof value.id === "number" && Number.isSafeInteger(value.id)
      ? String(value.id)
      : typeof value.id === "string" && /^\d+$/.test(value.id)
        ? value.id
        : null;
  const owner =
    typeof value.owner?.login === "string" ? value.owner.login.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const fullName =
    typeof value.full_name === "string" && value.full_name.includes("/")
      ? value.full_name.trim()
      : owner && name
        ? `${owner}/${name}`
        : "";
  if (!repositoryId || !fullName) return null;
  const ownerId =
    typeof value.owner?.id === "number" && Number.isSafeInteger(value.owner.id)
      ? String(value.owner.id)
      : typeof value.owner?.id === "string" && /^\d+$/.test(value.owner.id)
        ? value.owner.id
        : undefined;
  return {
    providerResourceId: fullName.toLowerCase(),
    parentProviderResourceId: ownerId,
    type: "repository",
    label: fullName,
    providerUrl:
      typeof value.html_url === "string" && value.html_url.length > 0
        ? value.html_url
        : `https://github.com/${fullName}`,
    metadata: {
      providerRepositoryId: repositoryId,
      fullName,
      ...(owner ? { owner } : {}),
      private: value.private === true,
      source: "provider_webhook",
    },
  };
}

function providerSetupState(
  endpoint: Pick<
    EndpointRow,
    "provider" | "providerAccountId" | "publicId" | "status" | "setup"
  >,
  publicBaseUrl: string | null,
  assignedAgentName?: string | null,
) {
  const path = `/api/chat-webhooks/${endpoint.publicId}/${endpoint.provider}`;
  const webhookUrl = publicBaseUrl ? `${publicBaseUrl}${path}` : null;
  const step = endpoint.status === "active" ? "complete" : endpoint.setup.step;
  switch (endpoint.provider) {
    case "slack":
      return {
        step,
        authorizationUrl: "https://api.slack.com/apps?new_app=1",
        providerUrl: "https://app.slack.com/",
        webhookUrl,
        webhookVerifiedAt: endpoint.setup.webhookVerifiedAt ?? null,
        // Slack registers the slash command in the provider configuration.
        // Keep that identity immutable when the assigned agent is renamed;
        // deriving it remains only a compatibility path for older rows.
        command:
          typeof endpoint.setup.command === "string"
            ? endpoint.setup.command
            : assignedAgentName
              ? slackCommandForAgent(assignedAgentName, endpoint.publicId)
              : null,
      } as const;
    case "github":
      return {
        step,
        authorizationUrl: "https://github.com/settings/apps/new",
        providerUrl: "https://github.com/settings/installations",
        webhookUrl,
        webhookVerifiedAt: endpoint.setup.webhookVerifiedAt ?? null,
      } as const;
    case "discord":
      return {
        step,
        authorizationUrl: "https://discord.com/developers/applications",
        providerUrl: endpoint.providerAccountId
          ? `https://discord.com/channels/${encodeURIComponent(endpoint.providerAccountId)}`
          : "https://discord.com/channels/@me",
        webhookUrl,
      } as const;
    case "microsoft-teams":
      return {
        step,
        authorizationUrl: "https://dev.teams.microsoft.com/apps",
        providerUrl: "https://teams.microsoft.com/",
        messagingEndpoint: webhookUrl,
      } as const;
    case "telegram":
      return {
        step,
        providerUrl: "https://t.me/BotFather",
        webhookUrl,
      } as const;
  }
}

function slackCommandForAgent(agentName: string, publicId: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  const suffix = publicId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6);
  return `/${slug || "paperclip"}-${suffix || "agent"}`;
}

export function createChatSdkStatePersistence(db: Db): ChatSdkStatePersistence {
  return {
    async read(scope: ChatSdkStateScope, key: string) {
      return db
        .select({
          value: chatSdkState.value,
          version: chatSdkState.version,
          expiresAt: chatSdkState.expiresAt,
        })
        .from(chatSdkState)
        .where(
          and(
            eq(chatSdkState.companyId, scope.companyId),
            eq(chatSdkState.endpointId, scope.endpointId),
            eq(chatSdkState.stateKey, key),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },
    async compareAndSet(input: ChatSdkStateCompareAndSetInput) {
      if (input.expectedVersion === null) {
        const inserted = await db
          .insert(chatSdkState)
          .values({
            companyId: input.companyId,
            endpointId: input.endpointId,
            stateKey: input.key,
            version: 1,
            value: input.value,
            expiresAt: input.expiresAt,
          })
          .onConflictDoNothing()
          .returning({ id: chatSdkState.id });
        return inserted.length === 1;
      }
      const updated = await db
        .update(chatSdkState)
        .set({
          version: input.expectedVersion + 1,
          value: input.value,
          expiresAt: input.expiresAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatSdkState.companyId, input.companyId),
            eq(chatSdkState.endpointId, input.endpointId),
            eq(chatSdkState.stateKey, input.key),
            eq(chatSdkState.version, input.expectedVersion),
          ),
        )
        .returning({ id: chatSdkState.id });
      return updated.length === 1;
    },
    async deleteIfVersion(input: ChatSdkStateDeleteInput) {
      const deleted = await db
        .delete(chatSdkState)
        .where(
          and(
            eq(chatSdkState.companyId, input.companyId),
            eq(chatSdkState.endpointId, input.endpointId),
            eq(chatSdkState.stateKey, input.key),
            eq(chatSdkState.version, input.expectedVersion),
          ),
        )
        .returning({ id: chatSdkState.id });
      return deleted.length === 1;
    },
  };
}

export function chatChannelService(db: Db, options: ChatChannelServiceOptions) {
  const runtime = options.runtime ?? createChatSdkRuntime();
  const runtimeVersions = new Map<string, string>();
  const runtimeLocalEpochs = new Map<string, number>();
  const runtimeContexts = new WeakMap<object, RuntimeContext>();
  const runtimeInitializations = new Map<
    string,
    { promise: Promise<ChatSdkEndpointRuntime>; version: string }
  >();
  const persistence = createChatSdkStatePersistence(db);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const publicBaseUrl = absoluteBaseUrl(options.publicBaseUrl);
  const issuesSvc = issueService(db);
  const secrets = secretService(db);
  const questionResponses = questionResponseDeliveryService(db, {
    heartbeat:
      options.heartbeat as QuestionResponseDeliveryServiceOptions["heartbeat"],
    resolveNativeQuestion: options.resolveNativeQuestion,
  });
  const backgroundMessageTasks = new Set<Promise<void>>();
  const scheduledConversationDrains = new Map<string, number>();
  const liveInboundMessages = new Map<string, LiveInboundMessage>();
  let shuttingDown = false;

  function localRuntimeEpoch(endpointId: string): number {
    return runtimeLocalEpochs.get(endpointId) ?? 0;
  }

  function runtimeContextForRecord(
    record: NonNullable<Awaited<ReturnType<typeof endpointRecord>>>,
  ): RuntimeContext {
    const generation = runtimeGeneration(record.endpoint.setup);
    const refsFingerprint = credentialFingerprint(record.credentialSecretRefs);
    const localEpoch = localRuntimeEpoch(record.endpoint.id);
    return {
      credentialFingerprint: refsFingerprint,
      generation,
      localEpoch,
      version: `${generation}:${refsFingerprint}:${localEpoch}`,
    };
  }

  async function invalidateRuntime(endpointId: string): Promise<boolean> {
    runtimeLocalEpochs.set(endpointId, localRuntimeEpoch(endpointId) + 1);
    runtimeVersions.delete(endpointId);
    return await runtime.removeEndpoint(endpointId);
  }

  function scheduleMessageProcessing(task: () => Promise<void>) {
    if (shuttingDown) return;
    const schedule = options.scheduleDeferredWork ?? setImmediate;
    schedule(() => {
      if (shuttingDown) return;
      const pending = task().catch((error) => {
        logger.error(
          { error: redactError(error) },
          "deferred external chat message processing failed",
        );
      });
      backgroundMessageTasks.add(pending);
      void pending.finally(() => backgroundMessageTasks.delete(pending));
    });
  }

  function retryableGitHubWebhookResponse(): Response {
    return new Response(
      "Paperclip could not durably accept the event in time",
      {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": "1",
        },
      },
    );
  }

  function scheduleGitHubWebhookRetry(
    publicId: string,
    request: Request,
  ): void {
    const currentAttempt = Number.parseInt(
      request.headers.get("x-paperclip-internal-webhook-retry") ?? "0",
      10,
    );
    const attempt = Number.isSafeInteger(currentAttempt) ? currentAttempt : 0;
    if (attempt >= GITHUB_WEBHOOK_INTERNAL_RETRY_MAX) {
      logger.error(
        { publicId, attempts: attempt },
        "GitHub webhook exhausted Paperclip internal acceptance retries",
      );
      return;
    }
    const headers = new Headers(request.headers);
    headers.set("x-paperclip-internal-webhook-retry", String(attempt + 1));
    const retryRequest = new Request(request, { headers });
    scheduleMessageProcessing(async () => {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(4_000, 250 * 2 ** attempt)),
      );
      const response = await handleWebhook(publicId, "github", retryRequest);
      if (!response.ok) {
        throw new Error(
          `GitHub webhook internal retry returned HTTP ${response.status}`,
        );
      }
    });
  }

  async function addReceiptReaction(input: {
    deliveryId: string;
    endpoint: EndpointRow;
    message: Message;
    thread: Thread;
  }): Promise<void> {
    let attempts = 0;
    let lastError: unknown = new Error("Receipt reaction was not attempted");
    while (attempts < RECEIPT_REACTION_MAX_ATTEMPTS) {
      attempts += 1;
      try {
        await input.thread.adapter.addReaction(
          input.thread.id,
          input.message.id,
          "eyes",
        );
        return;
      } catch (error) {
        lastError = error;
        const retryDelay = receiptReactionTransportRetryDelay(error, attempts);
        if (retryDelay === null || attempts >= RECEIPT_REACTION_MAX_ATTEMPTS) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    const disposition = classifyChatPublicationError(lastError, attempts);
    const diagnostic =
      `Receipt reaction failed after ${attempts} attempt${attempts === 1 ? "" : "s"} (${disposition.kind}): ${redactError(lastError)}`.slice(
        0,
        MAX_ERROR_TEXT,
      );
    logger.warn(
      {
        endpointId: input.endpoint.id,
        deliveryId: input.deliveryId,
        provider: input.endpoint.provider,
        attempts,
        disposition: disposition.kind,
      },
      "external chat receipt reaction failed",
    );
    try {
      // The inbound task/comment/wakeup is already authoritative and remains
      // processed. Activity carries this non-fatal provider-side diagnostic
      // without turning a cosmetic acknowledgement into a replayable message.
      await db
        .update(chatDeliveries)
        .set({ redactedError: diagnostic, updatedAt: new Date() })
        .where(
          and(
            eq(chatDeliveries.id, input.deliveryId),
            eq(chatDeliveries.state, "processed"),
          ),
        );
    } catch (error) {
      // Never replay an accepted task because observability for its optional
      // receipt reaction failed. Keep the secondary failure redacted in logs.
      logger.error(
        {
          endpointId: input.endpoint.id,
          deliveryId: input.deliveryId,
          error: redactError(error),
        },
        "could not persist receipt reaction diagnostic",
      );
    }
  }

  function conversationDrainKey(endpointId: string, threadId: string) {
    return `${endpointId}:${createHash("sha256").update(threadId).digest("hex")}`;
  }

  function scheduleConversationDrain(
    endpointId: string,
    threadId: string,
    drainAt = Date.now(),
  ) {
    if (shuttingDown) return;
    const key = conversationDrainKey(endpointId, threadId);
    const scheduledAt = scheduledConversationDrains.get(key);
    if (scheduledAt !== undefined) return;
    scheduledConversationDrains.set(key, drainAt);
    scheduleMessageProcessing(async () => {
      try {
        while (!shuttingDown) {
          const target = scheduledConversationDrains.get(key);
          if (target === undefined) return;
          const remaining = target - Date.now();
          if (remaining > 0) {
            await new Promise((resolve) => setTimeout(resolve, remaining));
            continue;
          }
          const shouldContinue = await drainConversationDeliveries(
            endpointId,
            threadId,
          );
          if (shouldContinue) {
            scheduledConversationDrains.set(key, Date.now());
            continue;
          }
          return;
        }
      } finally {
        scheduledConversationDrains.delete(key);
      }
    });
  }

  async function endpointRecord(endpointId: string) {
    return db
      .select({
        endpoint: chatEndpoints,
        assignedAgentName: agents.name,
        connectionName: toolConnections.name,
        applicationId: toolConnections.applicationId,
        credentialSecretRefs: toolConnections.credentialSecretRefs,
      })
      .from(chatEndpoints)
      .innerJoin(
        agents,
        and(
          eq(agents.id, chatEndpoints.assignedAgentId),
          eq(agents.companyId, chatEndpoints.companyId),
        ),
      )
      .innerJoin(
        toolConnections,
        and(
          eq(toolConnections.id, chatEndpoints.connectionId),
          eq(toolConnections.companyId, chatEndpoints.companyId),
        ),
      )
      .where(eq(chatEndpoints.id, endpointId))
      .then((rows) => rows[0] ?? null);
  }

  async function stageProviderEffect(
    database: DbOrTransaction,
    input: {
      endpoint: EndpointRow;
      deliveryId?: string | null;
      conversationId?: string | null;
      principalId?: string | null;
      providerActionId: string;
      payload: Omit<
        ProviderEffectPayload,
        "runtimeGeneration" | "credentialFingerprint"
      >;
      runtimeContext: LifecycleRuntimeFence;
    },
  ) {
    const [inserted] = await database
      .insert(chatActions)
      .values({
        companyId: input.endpoint.companyId,
        endpointId: input.endpoint.id,
        deliveryId: input.deliveryId ?? null,
        conversationId: input.conversationId ?? null,
        principalId: input.principalId ?? null,
        kind: "provider_effect",
        providerActionId: input.providerActionId,
        payload: {
          ...input.payload,
          runtimeGeneration: input.runtimeContext.generation,
          credentialFingerprint: input.runtimeContext.credentialFingerprint,
        },
        status: "received",
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    return database
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, input.endpoint.id),
          eq(chatActions.providerActionId, input.providerActionId),
          eq(chatActions.kind, "provider_effect"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function stageAuthorizedTaskControlPublication(
    tx: DbOrTransaction,
    input: {
      companyId: string;
      conversationId: string;
      endpointId: string;
      idempotencyKey: string;
      issueId: string;
      payload: SafeChatPublicationPayload;
      principalId: string;
    },
  ) {
    const [inserted] = await tx
      .insert(chatPublications)
      .values({
        companyId: input.companyId,
        endpointId: input.endpointId,
        conversationId: input.conversationId,
        issueId: input.issueId,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
        state: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: chatPublications.id });
    const publication =
      inserted ??
      (await tx
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, input.companyId),
            eq(chatPublications.idempotencyKey, input.idempotencyKey),
          ),
        )
        .then((rows) => rows[0] ?? null));
    if (!publication) {
      throw new Error("Task-control publication was not persisted");
    }
    await tx
      .insert(chatActions)
      .values({
        companyId: input.companyId,
        endpointId: input.endpointId,
        conversationId: input.conversationId,
        principalId: input.principalId,
        kind: "task_control_authorization",
        providerActionId: `task-control-authorization:${publication.id}`,
        payload: { publicationId: publication.id },
        status: "issued",
      })
      .onConflictDoNothing();
    return publication;
  }

  function providerEffectDisposition(
    error: unknown,
    attempt: number,
    providerEffectCompleted: boolean,
  ) {
    if (!providerEffectCompleted)
      return classifyChatPublicationError(error, attempt);
    return {
      kind: "delivery_unknown" as const,
      reason:
        "Provider effect completed, but Paperclip could not confirm its durable result",
    };
  }

  async function finalizeProviderEffectFailure(input: {
    action: typeof chatActions.$inferSelect;
    endpoint: EndpointRow;
    payload: ProviderEffectPayload;
    disposition: ReturnType<typeof providerEffectDisposition>;
    attempt: number;
  }): Promise<boolean> {
    const failure = redactSensitiveText(input.disposition.reason).slice(
      0,
      MAX_ERROR_TEXT,
    );
    const retryable = input.disposition.kind === "retry";
    const retryAt =
      input.disposition.kind === "retry"
        ? new Date(Date.now() + input.disposition.retryAfterMs)
        : null;
    const finalized = await db.transaction(async (tx) => {
      const [ownedAction] = await tx
        .update(chatActions)
        .set({
          status:
            input.disposition.kind === "delivery_unknown"
              ? "delivery_unknown"
              : "failed",
          result: {
            code: `provider_effect_${input.disposition.kind}`,
            attempts: input.attempt,
            redactedError: failure,
            retryable,
            retryAt: retryAt?.toISOString() ?? null,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, input.action.id),
            eq(chatActions.status, "processing"),
            sql`(${chatActions.result}->>'attempts')::int = ${input.attempt}`,
          ),
        )
        .returning({ id: chatActions.id });
      if (!ownedAction) return false;
      if (input.payload.settleDelivery && input.action.deliveryId) {
        await tx
          .update(chatDeliveries)
          .set({
            state: retryable ? "retry" : "failed",
            nextAttemptAt: retryAt,
            redactedError:
              input.disposition.kind === "delivery_unknown"
                ? `Provider response is unconfirmed: ${failure}`.slice(
                    0,
                    MAX_ERROR_TEXT,
                  )
                : failure,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatDeliveries.id, input.action.deliveryId),
              eq(chatDeliveries.state, "processing"),
            ),
          );
      }
      if (input.disposition.kind === "endpoint_attention") {
        await tx
          .update(chatEndpoints)
          .set({
            status: "attention",
            healthMessage: "Provider credentials or permissions need attention",
            lastError: failure,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, input.endpoint.id));
        await tx
          .update(toolConnections)
          .set({
            status: "disabled",
            enabled: false,
            healthStatus: "degraded",
            healthMessage: "Provider credentials or permissions need attention",
            lastError: failure,
            healthCheckedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, input.endpoint.connectionId));
      } else if (
        input.disposition.kind === "resource_unavailable" &&
        input.payload.resourceId
      ) {
        await tx
          .update(chatEndpointResources)
          .set({ availability: "unavailable", updatedAt: new Date() })
          .where(
            and(
              eq(chatEndpointResources.id, input.payload.resourceId),
              eq(chatEndpointResources.endpointId, input.endpoint.id),
            ),
          );
      }
      return true;
    });
    if (finalized && input.disposition.kind === "endpoint_attention") {
      await invalidateRuntime(input.endpoint.id).catch(() => undefined);
    }
    return finalized;
  }

  async function quarantineStaleProviderEffect(
    action: typeof chatActions.$inferSelect,
  ) {
    const payload = providerEffectPayload(action.payload);
    const failure =
      "Provider delivery could not be confirmed after the worker stopped. The effect will not be replayed automatically.";
    await db.transaction(async (tx) => {
      const [quarantined] = await tx
        .update(chatActions)
        .set({
          status: "delivery_unknown",
          result: {
            code: "provider_effect_delivery_unknown",
            redactedError: failure,
            retryable: false,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
            eq(chatActions.updatedAt, action.updatedAt),
            sql`(${chatActions.result}->>'attempts')::int = ${
              typeof action.result?.attempts === "number"
                ? action.result.attempts
                : -1
            }`,
            lte(
              chatActions.updatedAt,
              new Date(Date.now() - PROVIDER_EFFECT_STALE_MS),
            ),
          ),
        )
        .returning({ id: chatActions.id });
      if (quarantined && payload?.settleDelivery && action.deliveryId) {
        await tx
          .update(chatDeliveries)
          .set({
            state: "failed",
            nextAttemptAt: null,
            redactedError: failure,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatDeliveries.id, action.deliveryId),
              eq(chatDeliveries.state, "processing"),
            ),
          );
      }
    });
  }

  function providerEffectThreadResourceId(
    provider: ChatProvider,
    threadId: string,
  ): string | null {
    if (provider === "slack") {
      return (
        slackThreadChannelId(threadId) ??
        (!threadId.includes(":") ? threadId : null)
      );
    }
    if (provider === "telegram") {
      return /^telegram:([^:]+)/.exec(threadId)?.[1] ?? null;
    }
    if (provider === "github") {
      return /^github:([^:]+)/.exec(threadId)?.[1]?.toLowerCase() ?? null;
    }
    if (provider === "discord") {
      return /^discord:[^:]+:([^:]+)/.exec(threadId)?.[1] ?? null;
    }
    const conversationId = teamsConversationId(threadId);
    return conversationId ? baseTeamsConversationId(conversationId) : null;
  }

  async function lockCurrentProviderEffectAuthorization(
    tx: DbTransaction,
    action: typeof chatActions.$inferSelect,
    endpoint: EndpointRow,
    payload: ProviderEffectPayload,
  ): Promise<boolean> {
    const conversation = action.conversationId
      ? await tx
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.companyId, endpoint.companyId),
              eq(chatConversations.endpointId, endpoint.id),
              eq(chatConversations.id, action.conversationId),
              inArray(chatConversations.state, ["active", "waiting"]),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null)
      : null;
    if (action.conversationId && !conversation) return false;
    const inferredResourceId = providerEffectThreadResourceId(
      endpoint.provider,
      payload.threadId,
    );
    const resource = await tx
      .select()
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.companyId, endpoint.companyId),
          eq(chatEndpointResources.endpointId, endpoint.id),
          payload.resourceId || conversation?.resourceId
            ? eq(
                chatEndpointResources.id,
                payload.resourceId ?? conversation!.resourceId!,
              )
            : inferredResourceId
              ? eq(chatEndpointResources.providerResourceId, inferredResourceId)
              : sql`false`,
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    const slackChannelId =
      endpoint.provider === "slack"
        ? slackThreadChannelId(payload.threadId)
        : null;
    const isDirectMessage =
      conversation?.isDirectMessage === true ||
      resource?.type === "direct_message" ||
      Boolean(slackChannelId && /^D[A-Z0-9]+$/i.test(slackChannelId));
    const destinationAllowed = isDirectMessage
      ? endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(endpoint, resource);
    if (payload.authorizationMode === "safe_notice") return true;
    if (!destinationAllowed) return false;
    if (!action.principalId) return false;
    return (
      await lockCurrentPrincipalAuthorization(tx, endpoint, action.principalId)
    ).allowed;
  }

  async function cancelUnauthorizedProviderEffect(
    tx: DbTransaction,
    action: typeof chatActions.$inferSelect,
    attempt: number,
  ): Promise<boolean> {
    const [cancelled] = await tx
      .update(chatActions)
      .set({
        status: "cancelled",
        result: {
          attempts: attempt,
          code: "provider_effect_no_longer_authorized",
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatActions.id, action.id),
          eq(chatActions.status, "processing"),
          sql`(${chatActions.result}->>'attempts')::int = ${attempt}`,
        ),
      )
      .returning({ id: chatActions.id });
    if (!cancelled) return false;
    if (action.deliveryId) {
      await tx
        .update(chatDeliveries)
        .set({
          state: "filtered",
          processedAt: new Date(),
          nextAttemptAt: null,
          redactedError:
            "Provider reply was suppressed because current chat authorization changed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatDeliveries.id, action.deliveryId),
            eq(chatDeliveries.state, "processing"),
          ),
        );
    }
    return true;
  }

  async function processProviderEffect(
    actionId: string,
    liveTarget?: ProviderEffectTarget,
    credentialLeaseHeld = false,
  ): Promise<"processed" | "pending" | "failed" | "delivery_unknown"> {
    const initial = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "provider_effect"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!initial) return "failed";
    const initialEndpoint = await endpointRecord(initial.endpointId);
    if (!initialEndpoint) return "failed";

    const processClaimedEffect = async () => {
      let action = await db
        .select()
        .from(chatActions)
        .where(eq(chatActions.id, actionId))
        .then((rows) => rows[0] ?? null);
      if (!action) return "failed";
      const payload = providerEffectPayload(action.payload);
      if (!payload) {
        await db
          .update(chatActions)
          .set({
            status: "failed",
            result: { code: "provider_effect_payload_invalid" },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, action.id));
        return "failed";
      }
      if (action.status === "processed") return "processed";
      if (action.status === "delivery_unknown") return "delivery_unknown";
      if (action.status === "processing") {
        if (action.updatedAt > new Date(Date.now() - PROVIDER_EFFECT_STALE_MS))
          return "pending";
        await quarantineStaleProviderEffect(action);
        return "delivery_unknown";
      }
      if (action.status === "failed") {
        if (action.result?.retryable !== true) return "failed";
        const retryAt =
          typeof action.result.retryAt === "string"
            ? new Date(action.result.retryAt)
            : null;
        if (retryAt && retryAt > new Date()) return "pending";
      } else if (action.status !== "received") {
        return "failed";
      }

      const attempt =
        (typeof action.result?.attempts === "number"
          ? action.result.attempts
          : 0) + 1;
      const [claimed] = await db
        .update(chatActions)
        .set({
          status: "processing",
          result: { attempts: attempt },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, action.status),
          ),
        )
        .returning();
      if (!claimed) return "pending";
      action = claimed;

      const record = await endpointRecord(action.endpointId);
      let providerEffectCompleted = false;
      try {
        if (
          !record ||
          !["verifying", "active"].includes(record.endpoint.status)
        ) {
          throw Object.assign(
            new Error("Chat endpoint is not active for this provider effect"),
            {
              code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
            },
          );
        }
        const target =
          liveTarget ??
          (await runtimeFor(record.endpoint)).thread(payload.threadId);
        const outcome = await db.transaction(async (tx) => {
          const currentEndpoint = await runtimeCallbackEndpoint(
            tx,
            action!.endpointId,
            {
              generation: payload.runtimeGeneration,
              credentialFingerprint: payload.credentialFingerprint,
            },
            ["verifying", "active"],
          );
          if (!currentEndpoint) {
            throw Object.assign(
              new Error("Provider effect belonged to a superseded runtime"),
              { code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" },
            );
          }
          if (
            !(await lockCurrentProviderEffectAuthorization(
              tx,
              action!,
              currentEndpoint,
              payload,
            ))
          ) {
            const cancelled = await cancelUnauthorizedProviderEffect(
              tx,
              action!,
              attempt,
            );
            if (!cancelled) {
              throw new Error(
                "Provider effect ownership changed before authorization cancellation",
              );
            }
            return "cancelled" as const;
          }

          let sent: { id: string; threadId: string } | null = null;
          if (payload.effect === "ephemeral_message") {
            if (!target.postEphemeral) {
              if (!payload.fallbackText) {
                throw Object.assign(
                  new Error("Provider does not support ephemeral messages"),
                  { code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" },
                );
              }
              sent = await target.post(payload.fallbackText);
            } else {
              try {
                sent = await target.postEphemeral(
                  payload.userId!,
                  payload.text,
                  { fallbackToDM: false },
                );
              } catch (error) {
                if (
                  !payload.fallbackText ||
                  classifyChatPublicationError(error, attempt).kind !== "failed"
                ) {
                  throw error;
                }
              }
              if (!sent && payload.fallbackText) {
                sent = await target.post(payload.fallbackText);
              }
            }
          } else {
            sent = await target.post(payload.text);
          }
          if (!sent) {
            throw Object.assign(
              new Error("Provider did not accept the message"),
              { code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" },
            );
          }
          providerEffectCompleted = true;
          const [completed] = await tx
            .update(chatActions)
            .set({
              status: "processed",
              result: {
                attempts: attempt,
                providerMessageId: sent.id,
                threadId: sent.threadId,
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, action!.id),
                eq(chatActions.status, "processing"),
                sql`(${chatActions.result}->>'attempts')::int = ${attempt}`,
              ),
            )
            .returning({ id: chatActions.id });
          if (!completed) {
            throw new Error("Provider effect ownership changed before commit");
          }
          if (payload.completeConversationId) {
            await tx
              .update(chatConversations)
              .set({ state: "completed", updatedAt: new Date() })
              .where(
                and(
                  eq(chatConversations.id, payload.completeConversationId),
                  eq(chatConversations.endpointId, currentEndpoint.id),
                ),
              );
          }
          if (payload.settleDelivery && action!.deliveryId) {
            const [settled] = await tx
              .update(chatDeliveries)
              .set({
                state: "processed",
                processedAt: new Date(),
                nextAttemptAt: null,
                redactedError: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatDeliveries.id, action!.deliveryId),
                  eq(chatDeliveries.state, "processing"),
                ),
              )
              .returning({ id: chatDeliveries.id });
            if (!settled) {
              throw new Error(
                "Provider effect delivery ownership changed before commit",
              );
            }
          }
          await tx
            .update(chatEndpoints)
            .set({ lastEventAt: new Date(), updatedAt: new Date() })
            .where(eq(chatEndpoints.id, currentEndpoint.id));
          return "processed" as const;
        });
        return outcome === "processed" ? "processed" : "failed";
      } catch (error) {
        const disposition = providerEffectDisposition(
          error,
          attempt,
          providerEffectCompleted,
        );
        try {
          await finalizeProviderEffectFailure({
            action,
            endpoint: record?.endpoint ?? initialEndpoint.endpoint,
            payload,
            disposition,
            attempt,
          });
        } catch (finalizationError) {
          if (disposition.kind === "delivery_unknown") {
            throw Object.assign(
              new Error(
                "Provider effect is ambiguous and its durable quarantine failed",
                { cause: finalizationError },
              ),
              { code: "CHAT_PROVIDER_EFFECT_AMBIGUOUS" },
            );
          }
          throw finalizationError;
        }
        throw error;
      }
    };
    return credentialLeaseHeld
      ? processClaimedEffect()
      : withCredentialMutationLease(
          initialEndpoint.endpoint,
          processClaimedEffect,
        );
  }

  function scheduleProviderEffect(
    actionId: string,
    liveTarget?: ProviderEffectTarget,
  ) {
    scheduleMessageProcessing(async () => {
      await processProviderEffect(actionId, liveTarget);
    });
  }

  async function processPendingProviderEffects(limit = 25) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROVIDER_EFFECT_STALE_MS);
    const actions = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, "provider_effect"),
          or(
            eq(chatActions.status, "received"),
            and(
              eq(chatActions.status, "processing"),
              lte(chatActions.updatedAt, staleBefore),
            ),
            and(
              eq(chatActions.status, "failed"),
              sql`coalesce(${chatActions.result}->>'retryable', 'false') = 'true'`,
              sql`(${chatActions.result}->>'retryAt' is null or (${chatActions.result}->>'retryAt')::timestamptz <= ${now.toISOString()}::timestamptz)`,
            ),
          ),
        ),
      )
      .orderBy(asc(chatActions.createdAt))
      .limit(limit);
    for (const action of actions) {
      if (action.status === "processing" && action.updatedAt <= staleBefore) {
        await quarantineStaleProviderEffect(action);
        continue;
      }
      try {
        await processProviderEffect(action.id);
      } catch (error) {
        logger.warn(
          {
            endpointId: action.endpointId,
            actionId: action.id,
            error: redactError(error),
          },
          "chat provider effect reconciliation failed",
        );
      }
    }
    return actions.length;
  }

  async function runtimeCallbackEndpoint(
    tx: DbTransaction,
    endpointId: string,
    context: LifecycleRuntimeFence,
    allowedStatuses: EndpointRow["status"][],
  ): Promise<EndpointRow | null> {
    const endpoint = await tx
      .select()
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpointId))
      // Serialize endpoint mutations without taking the stronger row lock
      // that conflicts with the Chat SDK state table's endpoint foreign-key
      // check. Provider transports may persist SDK state on another pooled
      // connection while this transaction deliberately remains open through
      // provider acceptance; FOR UPDATE would self-deadlock that child insert.
      .for("no key update")
      .then((rows) => rows[0] ?? null);
    if (
      !endpoint ||
      !allowedStatuses.includes(endpoint.status) ||
      runtimeGeneration(endpoint.setup) !== context.generation
    )
      return null;
    const refs = await tx
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, endpoint.companyId),
          eq(toolConnections.id, endpoint.connectionId),
        ),
      )
      .then((rows) => rows[0]?.refs ?? []);
    return credentialFingerprint(refs) === context.credentialFingerprint
      ? endpoint
      : null;
  }

  async function runtimeCallbackRecord(
    endpointId: string,
    context: RuntimeContext,
    allowedStatuses: EndpointRow["status"][],
  ) {
    const record = await endpointRecord(endpointId);
    return record &&
      allowedStatuses.includes(record.endpoint.status) &&
      runtimeGeneration(record.endpoint.setup) === context.generation &&
      credentialFingerprint(record.credentialSecretRefs) ===
        context.credentialFingerprint
      ? record
      : null;
  }

  function serializeEndpoint(
    row: Awaited<ReturnType<typeof endpointRecord>>,
  ): ChatEndpoint {
    if (!row) throw notFound("Chat endpoint not found");
    const endpoint = row.endpoint;
    return {
      id: endpoint.id,
      companyId: endpoint.companyId,
      connectionId: endpoint.connectionId,
      provider: endpoint.provider,
      publicId: endpoint.publicId,
      status: endpoint.status,
      deploymentMode: endpoint.deploymentMode,
      assignedAgentId: endpoint.assignedAgentId,
      assignedAgentName: row.assignedAgentName,
      sponsorUserId: endpoint.sponsorUserId,
      providerAccountId: endpoint.providerAccountId,
      providerAccountLabel: endpoint.providerAccountLabel,
      botExternalId: endpoint.botExternalId,
      botUsername: endpoint.botUsername,
      botLabel: endpoint.botDisplayName ?? row.assignedAgentName,
      botAvatarUrl: endpoint.botAvatarUrl,
      allowDirectMessages: endpoint.allowDirectMessages,
      allowGroupChats: endpoint.allowGroupChats,
      allowUnlinkedPeople: endpoint.allowUnlinkedPeople,
      replyMode: "subscribed",
      capabilities: endpoint.capabilities,
      setup: {
        ...providerSetupState(endpoint, publicBaseUrl, row.assignedAgentName),
        ...(endpoint.provider === "github"
          ? {
              webhookSecretConfigured: row.credentialSecretRefs.some(
                (ref) => ref.configPath === "credentials.webhookSecret",
              ),
            }
          : {}),
      },
      healthMessage: endpoint.healthMessage,
      lastError: endpoint.lastError,
      lastActivityAt: iso(endpoint.lastEventAt),
      lastPublicationAt: iso(endpoint.lastPublicationAt),
      activatedAt: iso(endpoint.activatedAt),
      createdAt: endpoint.createdAt.toISOString(),
      updatedAt: endpoint.updatedAt.toISOString(),
    };
  }

  async function list(companyId: string) {
    const rows = await db
      .select({
        endpoint: chatEndpoints,
        assignedAgentName: agents.name,
        connectionName: toolConnections.name,
        applicationId: toolConnections.applicationId,
        credentialSecretRefs: toolConnections.credentialSecretRefs,
      })
      .from(chatEndpoints)
      .innerJoin(
        agents,
        and(
          eq(agents.id, chatEndpoints.assignedAgentId),
          eq(agents.companyId, chatEndpoints.companyId),
        ),
      )
      .innerJoin(
        toolConnections,
        and(
          eq(toolConnections.id, chatEndpoints.connectionId),
          eq(toolConnections.companyId, chatEndpoints.companyId),
        ),
      )
      .where(
        and(
          eq(chatEndpoints.companyId, companyId),
          ne(chatEndpoints.status, "archived"),
        ),
      )
      .orderBy(desc(chatEndpoints.updatedAt));
    return rows.map((row) => serializeEndpoint(row));
  }

  async function get(endpointId: string) {
    return serializeEndpoint(await endpointRecord(endpointId));
  }

  async function create(
    companyId: string,
    input: CreateChatEndpointInput,
    actorUserId?: string | null,
  ) {
    const agent = await db
      .select({ id: agents.id, name: agents.name, status: agents.status })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.id, input.assignedAgentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!agent)
      throw unprocessable("The selected agent does not belong to this company");
    if (!isAgentStatusInvokable(agent.status)) {
      throw unprocessable(
        "The selected agent must be active before it can be connected to chat",
        {
          code: "chat_agent_not_invokable",
        },
      );
    }

    const endpointId = randomUUID();
    const publicId = randomBytes(32).toString("base64url");
    const applicationId = input.applicationId ?? randomUUID();
    const connectionId = randomUUID();
    const suffix = endpointId.slice(0, 8);
    const name = (
      input.name?.trim() || `${PROVIDER_LABELS[input.provider]} — ${agent.name}`
    ).slice(0, 145);
    await db.transaction(async (tx) => {
      if (input.applicationId) {
        const application = await tx
          .select({
            id: toolApplications.id,
            applicationKey: toolApplications.applicationKey,
            metadata: toolApplications.metadata,
            status: toolApplications.status,
          })
          .from(toolApplications)
          .where(
            and(
              eq(toolApplications.companyId, companyId),
              eq(toolApplications.id, input.applicationId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!application) throw notFound("App not found");
        const sourceTemplateKey =
          typeof application.metadata.sourceTemplateKey === "string"
            ? application.metadata.sourceTemplateKey
            : null;
        if (
          application.status === "archived" ||
          (application.applicationKey !== input.provider &&
            sourceTemplateKey !== input.provider)
        ) {
          throw unprocessable(
            `The selected App is not the ${PROVIDER_LABELS[input.provider]} connector`,
          );
        }
      } else {
        await tx.insert(toolApplications).values({
          id: applicationId,
          companyId,
          applicationKey: `chat:${input.provider}:${endpointId}`,
          name: `${name} ${suffix}`,
          description: `People talk to ${agent.name} through ${PROVIDER_LABELS[input.provider]}.`,
          type: "chat",
          status: "draft",
          metadata: { sourceTemplateKey: input.provider, purpose: "channel" },
          ownerUserId: actorUserId ?? null,
        });
      }
      await tx.insert(toolConnections).values({
        id: connectionId,
        companyId,
        applicationId,
        name,
        uid: `chat-${input.provider}-${endpointId}`,
        connectionKind: "managed",
        connectionPurpose: "channel",
        ownership: "customer",
        transport: "chat_sdk",
        authKind: "api_key",
        credentialPolicy: "shared",
        status: "draft",
        enabled: false,
        config: { provider: input.provider },
        transportConfig: {},
        createdByUserId: actorUserId ?? null,
      });
      await tx.insert(chatEndpoints).values({
        id: endpointId,
        companyId,
        connectionId,
        provider: input.provider,
        publicId,
        assignedAgentId: agent.id,
        sponsorUserId: actorUserId ?? null,
        // Group chat is a broad Teams reach grant rather than a discovered
        // destination toggle. Keep it closed until the operator explicitly
        // enables that surface, even when this process is running against a
        // database created before the column default was hardened.
        allowGroupChats: input.provider !== "microsoft-teams",
        capabilities: CAPABILITIES[input.provider],
        setup: {
          step: "provider_setup",
          ...(input.provider === "slack"
            ? { command: slackCommandForAgent(agent.name, publicId) }
            : {}),
        },
      });
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId ?? "board",
      action: "chat_endpoint.created",
      entityType: "tool_connection",
      entityId: connectionId,
      details: {
        endpointId,
        provider: input.provider,
        assignedAgentId: agent.id,
      },
    });
    return get(endpointId);
  }

  async function update(
    endpointId: string,
    input: UpdateChatEndpointInput,
    actorUserId?: string | null,
  ) {
    const initial = await endpointRecord(endpointId);
    if (!initial) throw notFound("Chat endpoint not found");
    await withCredentialMutationLease(initial.endpoint, async () => {
      // Reach changes share the provider-transport lane with publications.
      // Once a disable returns, no send that sampled the previous grant can
      // still begin or finish behind it.
      const existing = await endpointRecord(endpointId);
      if (!existing) throw notFound("Chat endpoint not found");
      const values: Partial<typeof chatEndpoints.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.allowDirectMessages !== undefined)
        values.allowDirectMessages = input.allowDirectMessages;
      if (input.allowGroupChats !== undefined)
        values.allowGroupChats = input.allowGroupChats;
      if (input.allowUnlinkedPeople !== undefined)
        values.allowUnlinkedPeople = input.allowUnlinkedPeople;
      await db
        .update(chatEndpoints)
        .set(values)
        .where(eq(chatEndpoints.id, endpointId));
      await logActivity(db, {
        companyId: existing.endpoint.companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "chat_endpoint.updated",
        entityType: "tool_connection",
        entityId: existing.endpoint.connectionId,
        details: { endpointId, fields: Object.keys(input) },
      });
    });
    return get(endpointId);
  }

  async function normalizedCredentials(
    endpoint: EndpointRow,
    supplied: Record<string, string> | undefined,
  ) {
    const values = await resolveCredentials(endpoint).catch(
      () => ({}) as Record<string, string>,
    );
    for (const [key, rawValue] of Object.entries(supplied ?? {})) {
      if (typeof rawValue === "string" && rawValue.trim())
        values[key] = key === "privateKey" ? rawValue : rawValue.trim();
    }
    if (endpoint.provider === "telegram" && !values.webhookSecret) {
      values.webhookSecret = randomBytes(32).toString("hex");
    }
    const required =
      endpoint.provider === "github"
        ? ["appId", "privateKey", "webhookSecret"]
        : REQUIRED_CREDENTIALS[endpoint.provider];
    const missing = required.filter((key) => !values[key]);
    if (missing.length > 0) {
      throw unprocessable(
        `Missing required ${PROVIDER_LABELS[endpoint.provider]} credentials: ${missing.join(", ")}`,
      );
    }
    return endpoint.provider === "microsoft-teams"
      ? normalizeMicrosoftTeamsCredentialIds(values)
      : values;
  }

  async function verifyCredentials(
    provider: ChatProvider,
    credentials: Record<string, string>,
  ): Promise<VerifiedProviderIdentity> {
    if (provider === "slack") {
      const response = await fetchImpl("https://slack.com/api/auth.test", {
        method: "POST",
        signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${credentials.botToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "",
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        team_id?: string;
        team?: string;
        user_id?: string;
        user?: string;
      };
      if (!response.ok || !result.ok)
        throw unprocessable(
          `Slack rejected the bot token: ${result.error ?? response.status}`,
        );
      const grantedScopes = new Set(
        (response.headers.get("x-oauth-scopes") ?? "")
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean),
      );
      const missingScopes = REQUIRED_SLACK_BOT_SCOPES.filter(
        (scope) => !grantedScopes.has(scope),
      );
      if (missingScopes.length > 0) {
        throw unprocessable(
          `Slack app is missing required bot scopes: ${missingScopes.join(", ")}`,
          {
            code: "chat_provider_permissions_missing",
            provider: "slack",
            missingScopes,
          },
        );
      }
      return {
        providerAccountId: result.team_id,
        providerAccountLabel: result.team,
        botExternalId: result.user_id,
        botUsername: result.user,
        botLabel: result.user,
      };
    }
    if (provider === "discord") {
      const identity = await verifyDiscordBot({
        applicationId: credentials.applicationId,
        botToken: credentials.botToken,
        fetch: fetchImpl,
        guildId: credentials.guildId,
      }).catch((error) => {
        throw unprocessable(redactError(error), {
          code: "chat_provider_permissions_missing",
          provider: "discord",
        });
      });
      return identity;
    }
    if (provider === "telegram") {
      const response = await fetchImpl(
        `https://api.telegram.org/bot${encodeURIComponent(credentials.botToken)}/getMe`,
        { signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS) },
      );
      const result = (await response.json()) as {
        ok?: boolean;
        description?: string;
        result?: { id?: number; username?: string; first_name?: string };
      };
      if (!response.ok || !result.ok)
        throw unprocessable(
          `Telegram rejected the bot token: ${result.description ?? response.status}`,
        );
      return {
        providerAccountId: String(result.result?.id ?? ""),
        botExternalId: String(result.result?.id ?? ""),
        botUsername: result.result?.username,
        botLabel: result.result?.first_name,
      };
    }
    if (provider === "github") {
      const token = githubAppJwt(credentials.appId, credentials.privateKey);
      const response = await fetchImpl("https://api.github.com/app", {
        signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
      });
      const result = (await response.json()) as {
        id?: number;
        login?: string;
        slug?: string;
        name?: string;
        message?: string;
        owner?: { login?: string };
        permissions?: Record<string, string>;
        events?: string[];
      };
      if (!response.ok)
        throw unprocessable(
          `GitHub rejected the app credentials: ${result.message ?? response.status}`,
        );
      const missingPermissions = Object.entries(REQUIRED_GITHUB_PERMISSIONS)
        .filter(
          ([permission, access]) => result.permissions?.[permission] !== access,
        )
        .map(([permission]) => permission);
      const excessivePermissions = Object.keys(result.permissions ?? {}).filter(
        (permission) => !(permission in REQUIRED_GITHUB_PERMISSIONS),
      );
      const configuredEvents = new Set(result.events ?? []);
      const missingEvents = REQUIRED_GITHUB_EVENTS.filter(
        (event) => !configuredEvents.has(event),
      );
      const allowedEvents = new Set<string>([
        ...REQUIRED_GITHUB_EVENTS,
        ...UNAVOIDABLE_GITHUB_EVENTS,
      ]);
      const excessiveEvents = [...configuredEvents].filter(
        (event) => !allowedEvents.has(event),
      );
      if (
        missingPermissions.length > 0 ||
        excessivePermissions.length > 0 ||
        missingEvents.length > 0 ||
        excessiveEvents.length > 0
      ) {
        throw unprocessable(
          [
            missingPermissions.length > 0
              ? `GitHub App needs the documented minimum access for: ${missingPermissions.join(", ")}`
              : null,
            excessivePermissions.length > 0
              ? `GitHub App has broader permissions than Paperclip needs: ${excessivePermissions.join(", ")}`
              : null,
            missingEvents.length > 0
              ? `GitHub App must subscribe to: ${missingEvents.join(", ")}`
              : null,
            excessiveEvents.length > 0
              ? `GitHub App subscribes to broader events than Paperclip needs: ${excessiveEvents.join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join(". "),
          {
            code: "chat_provider_permissions_missing",
            provider: "github",
            missingPermissions,
            excessivePermissions,
            missingEvents,
            excessiveEvents,
          },
        );
      }
      return {
        providerAccountId: result.owner?.login,
        providerAccountLabel: result.owner?.login ?? result.name,
        // The App registration id is the stable, immutable endpoint identity.
        // The adapter discovers the separate bot-user id while initializing.
        botExternalId:
          typeof result.id === "number" && Number.isFinite(result.id)
            ? String(result.id)
            : undefined,
        botUsername: result.slug ? `${result.slug}[bot]` : undefined,
        botLabel: result.name ?? result.slug,
      };
    }
    const teamsCredentials = normalizeMicrosoftTeamsCredentialIds(credentials);
    const body = new URLSearchParams({
      client_id: teamsCredentials.clientId,
      client_secret: teamsCredentials.clientSecret,
      grant_type: "client_credentials",
      scope: "https://api.botframework.com/.default",
    });
    const response = await fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(teamsCredentials.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    const result = (await response.json()) as {
      access_token?: string;
      error_description?: string;
    };
    if (!response.ok || !result.access_token)
      throw unprocessable(
        `Microsoft rejected the app credentials: ${result.error_description ?? response.status}`,
      );
    return {
      providerAccountId: teamsCredentials.tenantId,
      providerAccountLabel: teamsCredentials.tenantId,
      botExternalId: teamsCredentials.clientId,
    };
  }

  function nativeBotIdentityKey(
    provider: ChatProvider,
    identity: VerifiedProviderIdentity,
  ): string | null {
    const account = identity.providerAccountId?.trim().toLowerCase();
    const bot = identity.botExternalId?.trim().toLowerCase();
    if (provider === "github" || provider === "discord") {
      if (bot) return `${provider}:app:${bot}`;
      return null;
    }
    if (!account || !bot) return null;
    return `${provider}:${account}:${bot}`;
  }

  function nativeBotIdentityMatches(
    provider: ChatProvider,
    current: VerifiedProviderIdentity,
    incoming: VerifiedProviderIdentity,
  ): boolean {
    const currentKey = nativeBotIdentityKey(provider, current);
    return (
      currentKey !== null &&
      currentKey === nativeBotIdentityKey(provider, incoming)
    );
  }

  function legacyGitHubLabelsMatchVerifiedCredentials(
    current: VerifiedProviderIdentity,
    verified: VerifiedProviderIdentity,
  ): boolean {
    return (
      !current.botExternalId &&
      Boolean(verified.botExternalId) &&
      current.providerAccountId?.trim().toLowerCase() ===
        verified.providerAccountId?.trim().toLowerCase() &&
      current.botUsername?.trim().toLowerCase() ===
        verified.botUsername?.trim().toLowerCase()
    );
  }

  async function assertNativeBotIdentityAvailable(
    endpoint: EndpointRow,
    identity: VerifiedProviderIdentity,
  ): Promise<void> {
    const key = nativeBotIdentityKey(endpoint.provider, identity);
    if (!key) {
      throw unprocessable(
        `${PROVIDER_LABELS[endpoint.provider]} did not return a stable native bot identity`,
      );
    }
    const candidates = await db
      .select({
        id: chatEndpoints.id,
        assignedAgentId: chatEndpoints.assignedAgentId,
        providerAccountId: chatEndpoints.providerAccountId,
        botExternalId: chatEndpoints.botExternalId,
        botUsername: chatEndpoints.botUsername,
      })
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.companyId, endpoint.companyId),
          eq(chatEndpoints.provider, endpoint.provider),
          ne(chatEndpoints.id, endpoint.id),
          inArray(chatEndpoints.status, [
            "verifying",
            "active",
            "paused",
            "attention",
          ]),
        ),
      );
    const conflictEndpoint = candidates.find((candidate) => {
      if (endpoint.provider !== "github" && endpoint.provider !== "discord") {
        return nativeBotIdentityKey(endpoint.provider, candidate) === key;
      }
      const candidateAppId = candidate.botExternalId?.trim().toLowerCase();
      const incomingAppId = identity.botExternalId?.trim().toLowerCase();
      if (candidateAppId && incomingAppId)
        return candidateAppId === incomingAppId;
      return (
        candidate.providerAccountId?.trim().toLowerCase() ===
          identity.providerAccountId?.trim().toLowerCase() &&
        candidate.botUsername?.trim().toLowerCase() ===
          identity.botUsername?.trim().toLowerCase()
      );
    });
    if (conflictEndpoint) {
      throw conflict(
        `This ${PROVIDER_LABELS[endpoint.provider]} bot already represents another Paperclip agent connection`,
        {
          code: "chat_bot_identity_in_use",
          endpointId: conflictEndpoint.id,
          assignedAgentId: conflictEndpoint.assignedAgentId,
        },
      );
    }
  }

  async function persistCredentials(
    endpoint: EndpointRow,
    credentials: Record<string, string>,
    actorUserId?: string | null,
  ) {
    const previousRefs = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, endpoint.companyId),
          eq(toolConnections.id, endpoint.connectionId),
        ),
      )
      .then((rows) => rows[0]?.refs ?? []);
    const refs: ToolCredentialSecretRef[] = [];
    let refsReplaced = false;
    try {
      for (const [key, value] of Object.entries(credentials)) {
        const suffix = randomUUID();
        const secret = await secrets.create(
          endpoint.companyId,
          {
            name: `chat.${endpoint.provider}.${endpoint.id.slice(0, 8)}.${key}.${suffix.slice(0, 8)}`,
            key: `CHAT_${endpoint.provider.replaceAll("-", "_")}_${endpoint.id.replaceAll("-", "_")}_${key}_${suffix}`.toUpperCase(),
            provider: "local_encrypted",
            managedMode: "paperclip_managed",
            value,
            description: `${PROVIDER_LABELS[endpoint.provider]} channel credential for endpoint ${endpoint.id}`,
          },
          { userId: actorUserId ?? undefined },
        );
        refs.push({
          secretId: secret.id,
          versionSelector: "latest",
          configPath: `credentials.${key}`,
          required: true,
          label: key,
          projectionClass: "unclassified",
        });
      }
      await secrets.syncSecretRefsForTarget(
        endpoint.companyId,
        {
          targetType: "tool_connection",
          targetId: endpoint.connectionId,
        },
        refs,
        { replaceAll: true },
      );
      refsReplaced = true;
      await db
        .update(toolConnections)
        .set({ credentialSecretRefs: refs, updatedAt: new Date() })
        .where(eq(toolConnections.id, endpoint.connectionId));
    } catch (error) {
      if (refsReplaced) {
        await secrets
          .syncSecretRefsForTarget(
            endpoint.companyId,
            {
              targetType: "tool_connection",
              targetId: endpoint.connectionId,
            },
            previousRefs,
            { replaceAll: true },
          )
          .catch(() => undefined);
        await db
          .update(toolConnections)
          .set({ credentialSecretRefs: previousRefs, updatedAt: new Date() })
          .where(eq(toolConnections.id, endpoint.connectionId))
          .catch(() => undefined);
      }
      await Promise.allSettled(refs.map((ref) => secrets.remove(ref.secretId)));
      throw error;
    }
    const currentIds = new Set(refs.map((ref) => ref.secretId));
    const retired = previousRefs.filter((ref) => !currentIds.has(ref.secretId));
    const results = await Promise.allSettled(
      retired.map((ref) => secrets.remove(ref.secretId)),
    );
    if (results.some((result) => result.status === "rejected")) {
      logger.warn(
        { endpointId: endpoint.id },
        "chat credential rotation left an unbound retired secret for later cleanup",
      );
    }
  }

  async function clearCredentials(endpoint: EndpointRow) {
    const refs = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, endpoint.companyId),
          eq(toolConnections.id, endpoint.connectionId),
        ),
      )
      .then((rows) => rows[0]?.refs ?? []);
    await secrets.syncSecretRefsForTarget(
      endpoint.companyId,
      {
        targetType: "tool_connection",
        targetId: endpoint.connectionId,
      },
      [],
      { replaceAll: true },
    );
    await db
      .update(toolConnections)
      .set({ credentialSecretRefs: [], updatedAt: new Date() })
      .where(eq(toolConnections.id, endpoint.connectionId));
    const results = await Promise.allSettled(
      refs.map((ref) => secrets.remove(ref.secretId)),
    );
    if (results.some((result) => result.status === "rejected")) {
      logger.warn(
        { endpointId: endpoint.id },
        "chat endpoint removal left an unbound retired secret for later cleanup",
      );
    }
  }

  async function resolveCredentials(
    endpoint: EndpointRow,
  ): Promise<Record<string, string>> {
    const connection = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, endpoint.companyId),
          eq(toolConnections.id, endpoint.connectionId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!connection) throw notFound("Chat connection not found");
    const values: Record<string, string> = {};
    for (const ref of connection.refs) {
      const key = ref.configPath.replace(/^credentials\./, "");
      values[key] = await secrets.resolveSecretValue(
        endpoint.companyId,
        ref.secretId,
        ref.versionSelector ?? "latest",
        {
          consumerType: "tool_connection",
          consumerId: endpoint.connectionId,
          configPath: ref.configPath,
          actorType: "system",
          actorId: null,
        },
      );
    }
    return values;
  }

  async function acquireCredentialMutationLease(endpoint: EndpointRow) {
    const token = randomUUID();
    const leaseKey = "credentials";
    const deadline = Date.now() + CREDENTIAL_MUTATION_LEASE_WAIT_MS;
    while (true) {
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + CREDENTIAL_MUTATION_LEASE_TTL_MS,
      );
      const inserted = await db
        .insert(chatEndpointLeases)
        .values({
          companyId: endpoint.companyId,
          endpointId: endpoint.id,
          leaseKey,
          token,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: chatEndpointLeases.id });
      if (inserted.length > 0) return { leaseKey, token };
      const reclaimed = await db
        .update(chatEndpointLeases)
        .set({ token, expiresAt, updatedAt: now })
        .where(
          and(
            eq(chatEndpointLeases.companyId, endpoint.companyId),
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, leaseKey),
            lte(chatEndpointLeases.expiresAt, now),
          ),
        )
        .returning({ id: chatEndpointLeases.id });
      if (reclaimed.length > 0) return { leaseKey, token };
      if (Date.now() >= deadline) {
        throw conflict(
          "Another credential update is still in progress; try again",
          {
            code: "chat_endpoint_credentials_busy",
          },
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, CREDENTIAL_MUTATION_LEASE_POLL_MS),
      );
    }
  }

  async function withCredentialMutationLease<T>(
    endpoint: EndpointRow,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const lease = await acquireCredentialMutationLease(endpoint);
    let renewal: Promise<void> | null = null;
    const renewTimer = setInterval(() => {
      if (renewal) return;
      const now = new Date();
      renewal = db
        .update(chatEndpointLeases)
        .set({
          expiresAt: new Date(now.getTime() + CREDENTIAL_MUTATION_LEASE_TTL_MS),
          updatedAt: now,
        })
        .where(
          and(
            eq(chatEndpointLeases.companyId, endpoint.companyId),
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, lease.leaseKey),
            eq(chatEndpointLeases.token, lease.token),
          ),
        )
        .then(() => undefined)
        .catch((error) => {
          logger.warn(
            { endpointId: endpoint.id, error: redactError(error) },
            "could not renew chat credential mutation lease",
          );
        })
        .finally(() => {
          renewal = null;
        });
    }, CREDENTIAL_MUTATION_LEASE_TTL_MS / 3);
    renewTimer.unref?.();
    try {
      return await mutation();
    } finally {
      clearInterval(renewTimer);
      await renewal;
      await db
        .delete(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.companyId, endpoint.companyId),
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, lease.leaseKey),
            eq(chatEndpointLeases.token, lease.token),
          ),
        )
        .catch((error) => {
          logger.warn(
            { endpointId: endpoint.id, error: redactError(error) },
            "could not release chat credential mutation lease",
          );
        });
    }
  }

  async function generateSetupSecret(
    endpointId: string,
    actorUserId?: string | null,
  ) {
    const initial = await endpointRecord(endpointId);
    if (!initial) throw notFound("Chat endpoint not found");
    if (initial.endpoint.provider !== "github") {
      throw unprocessable(
        "Setup secret generation is only available for GitHub",
      );
    }
    return withCredentialMutationLease(initial.endpoint, async () => {
      // A competing request may have completed while this request waited for
      // the durable lease. Reload both endpoint state and credential refs only
      // after ownership so each successful rotation starts from its immediate
      // predecessor instead of replacing the credential set from a stale read.
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("Chat endpoint not found");
      const endpoint = record.endpoint;
      if (
        ![
          "draft",
          "verifying",
          "active",
          "attention",
          "revoked",
          "paused",
        ].includes(endpoint.status)
      ) {
        throw conflict(
          "The GitHub webhook secret cannot be rotated in this connection state",
          {
            code: "chat_endpoint_setup_secret_unavailable",
          },
        );
      }
      const webhookSecret = randomBytes(32).toString("hex");
      // Rotation must fail closed if any existing credential cannot be resolved.
      // Falling back to an empty object here would replace the full credential
      // set with only the new webhook secret and strand an otherwise-live App.
      const existing = await resolveCredentials(endpoint);
      const replacedExistingSecret = record.credentialSecretRefs.some(
        (ref) => ref.configPath === "credentials.webhookSecret",
      );
      const rotatingConfiguredApp =
        Boolean(endpoint.providerAccountId || endpoint.botExternalId) ||
        record.credentialSecretRefs.some((ref) =>
          ["credentials.appId", "credentials.privateKey"].includes(
            ref.configPath,
          ),
        );
      const rotationId = randomUUID();
      const auditDetails = {
        endpointId: endpoint.id,
        provider: endpoint.provider,
        rotationId,
        rotated: rotatingConfiguredApp,
        replacedPrevious: replacedExistingSecret,
      };
      const writeSetupSecretActivity =
        options.setupSecretActivityLogger ?? logActivity;
      // This durable intent is the audit boundary. If it cannot be written,
      // fail before changing state or refs so retry is safe. Endpoint/tool
      // state moves fail-closed before ref replacement. Once refs change, only
      // best-effort work remains and the plaintext must still be returned.
      await writeSetupSecretActivity(db, {
        companyId: endpoint.companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "chat_endpoint.setup_secret_rotation_started",
        entityType: "tool_connection",
        entityId: endpoint.connectionId,
        details: auditDetails,
      });
      try {
        if (rotatingConfiguredApp) {
          const updatedAt = new Date();
          await db.transaction(async (tx) => {
            const current = await tx
              .select({ setup: chatEndpoints.setup })
              .from(chatEndpoints)
              .where(eq(chatEndpoints.id, endpoint.id))
              .for("update")
              .then((rows) => rows[0] ?? null);
            if (!current) throw notFound("Chat endpoint not found");
            await tx
              .update(chatEndpoints)
              .set({
                status: "attention",
                healthMessage:
                  "Update the GitHub webhook secret, then reconnect this App",
                lastError: null,
                setup: {
                  ...current.setup,
                  step: "provider_setup",
                  webhookVerifiedAt: null,
                  runtimeGeneration: runtimeGeneration(current.setup) + 1,
                } as InternalSetupState,
                updatedAt,
              })
              .where(eq(chatEndpoints.id, endpoint.id));
            await tx
              .update(toolConnections)
              .set({
                status: "disabled",
                enabled: false,
                healthStatus: "degraded",
                healthMessage: "GitHub webhook secret rotation needs reconnect",
                lastError: null,
                healthCheckedAt: updatedAt,
                updatedAt,
              })
              .where(eq(toolConnections.id, endpoint.connectionId));
          });
          await invalidateRuntime(endpoint.id).catch(() => undefined);
        } else {
          // Replacing a secret while the operator is still creating the GitHub
          // App is not a live credential rotation. Keep first-time setup in its
          // draft state, clear any ping for the superseded value, and also heal
          // endpoints affected by the earlier pre-connect rotation trap.
          const updatedAt = new Date();
          await db.transaction(async (tx) => {
            const current = await tx
              .select({ setup: chatEndpoints.setup })
              .from(chatEndpoints)
              .where(eq(chatEndpoints.id, endpoint.id))
              .for("update")
              .then((rows) => rows[0] ?? null);
            if (!current) throw notFound("Chat endpoint not found");
            await tx
              .update(chatEndpoints)
              .set({
                status: "draft",
                healthMessage: null,
                lastError: null,
                setup: {
                  ...current.setup,
                  step: "provider_setup",
                  webhookVerifiedAt: null,
                },
                updatedAt,
              })
              .where(eq(chatEndpoints.id, endpoint.id));
            await tx
              .update(toolConnections)
              .set({
                status: "draft",
                enabled: false,
                healthStatus: "unchecked",
                healthMessage: null,
                lastError: null,
                healthCheckedAt: null,
                updatedAt,
              })
              .where(eq(toolConnections.id, endpoint.connectionId));
          });
        }
        await options.setupSecretCredentialPersistBarrier?.();
        // Make credential refs the final required mutation. Once this returns,
        // only the best-effort completion audit remains, so the request cannot
        // fail after making the newly generated secret authoritative.
        await persistCredentials(
          endpoint,
          { ...existing, webhookSecret },
          actorUserId,
        );
      } catch (error) {
        await writeSetupSecretActivity(db, {
          companyId: endpoint.companyId,
          actorType: "user",
          actorId: actorUserId ?? "board",
          action: "chat_endpoint.setup_secret_rotation_failed",
          entityType: "tool_connection",
          entityId: endpoint.connectionId,
          details: auditDetails,
        }).catch((auditError) => {
          logger.warn(
            {
              endpointId: endpoint.id,
              error: redactError(auditError),
              rotationId,
            },
            "could not audit failed GitHub setup-secret rotation",
          );
        });
        throw error;
      }
      await writeSetupSecretActivity(db, {
        companyId: endpoint.companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "chat_endpoint.setup_secret_generated",
        entityType: "tool_connection",
        entityId: endpoint.connectionId,
        details: auditDetails,
      }).catch((error) => {
        logger.warn(
          {
            endpointId: endpoint.id,
            error: redactError(error),
            rotationId,
          },
          "GitHub setup secret rotated but completion audit failed",
        );
      });
      return { webhookSecret };
    });
  }

  function githubRepositoryStableId(
    item: ChatProviderResourceInventoryItem,
  ): string | null {
    const value = item.metadata?.providerRepositoryId;
    return typeof value === "string" && /^\d+$/.test(value) ? value : null;
  }

  async function upsertProviderResourceRow(
    tx: DbTransaction,
    endpoint: EndpointRow,
    item: ChatProviderResourceInventoryItem,
  ) {
    const stableGitHubId =
      endpoint.provider === "github" ? githubRepositoryStableId(item) : null;
    if (stableGitHubId) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-github-repository:${endpoint.id}:${stableGitHubId}`}, 0))`,
      );
      const stableResource = await tx
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.companyId, endpoint.companyId),
            eq(chatEndpointResources.endpointId, endpoint.id),
            eq(chatEndpointResources.type, "repository"),
            sql`${chatEndpointResources.metadata}->>'providerRepositoryId' = ${stableGitHubId}`,
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        stableResource &&
        stableResource.providerResourceId !== item.providerResourceId
      ) {
        const coordinateResource = await tx
          .select()
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.companyId, endpoint.companyId),
              eq(chatEndpointResources.endpointId, endpoint.id),
              eq(chatEndpointResources.type, "repository"),
              eq(
                chatEndpointResources.providerResourceId,
                item.providerResourceId,
              ),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (coordinateResource && coordinateResource.id !== stableResource.id) {
          const coordinateConversation = await tx
            .select({ id: chatConversations.id })
            .from(chatConversations)
            .where(
              and(
                eq(chatConversations.endpointId, endpoint.id),
                eq(chatConversations.resourceId, coordinateResource.id),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (coordinateConversation) {
            throw conflict(
              "GitHub repository identity is already bound to two coordinates",
              { code: "chat_github_repository_identity_conflict" },
            );
          }
          await tx
            .delete(chatEndpointResources)
            .where(eq(chatEndpointResources.id, coordinateResource.id));
        }

        const oldRepository = stableResource.providerResourceId;
        const oldThreadPrefix = `github:${oldRepository}`;
        const newThreadPrefix = `github:${item.providerResourceId}`;
        const oldProviderUrl = `https://github.com/${oldRepository}`;
        const newProviderUrl = `https://github.com/${item.providerResourceId}`;
        await tx
          .update(chatEndpointResources)
          .set({
            providerResourceId: item.providerResourceId,
            parentProviderResourceId: item.parentProviderResourceId ?? null,
            label: item.label,
            providerUrl: item.providerUrl ?? null,
            availability: "available",
            enabled:
              stableResource.enabled || coordinateResource?.enabled === true,
            metadata: item.metadata ?? {},
            updatedAt: new Date(),
          })
          .where(eq(chatEndpointResources.id, stableResource.id));
        await tx
          .update(chatConversations)
          .set({
            externalConversationId: sql<string>`case
              when lower(${chatConversations.externalConversationId}) = ${oldRepository} then ${item.providerResourceId}
              when lower(${chatConversations.externalConversationId}) = ${oldThreadPrefix} then ${newThreadPrefix}
              else ${chatConversations.externalConversationId}
            end`,
            externalThreadId: sql<string>`case
              when lower(${chatConversations.externalThreadId}) = ${oldThreadPrefix} then ${newThreadPrefix}
              when lower(${chatConversations.externalThreadId}) like ${`${oldThreadPrefix}:%`}
                then ${newThreadPrefix} || substring(
                  ${chatConversations.externalThreadId}
                  from char_length(${oldThreadPrefix}) + 1
                )
              else ${chatConversations.externalThreadId}
            end`,
            externalLabel: item.label,
            providerUrl: sql<string | null>`case
              when lower(${chatConversations.providerUrl}) like ${`${oldProviderUrl}/%`}
                then ${newProviderUrl} || substring(
                  ${chatConversations.providerUrl}
                  from char_length(${oldProviderUrl}) + 1
                )
              else ${chatConversations.providerUrl}
            end`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatConversations.companyId, endpoint.companyId),
              eq(chatConversations.endpointId, endpoint.id),
              eq(chatConversations.resourceId, stableResource.id),
            ),
          );
        return { id: stableResource.id };
      }
    }

    const [resource] = await tx
      .insert(chatEndpointResources)
      .values({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        type: item.type,
        providerResourceId: item.providerResourceId,
        parentProviderResourceId: item.parentProviderResourceId ?? null,
        label: item.label,
        providerUrl: item.providerUrl ?? null,
        availability: "available",
        enabled: false,
        metadata: item.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [
          chatEndpointResources.endpointId,
          chatEndpointResources.type,
          chatEndpointResources.providerResourceId,
        ],
        set: {
          parentProviderResourceId: item.parentProviderResourceId ?? null,
          label: item.label,
          providerUrl: item.providerUrl ?? null,
          availability: "available",
          metadata: item.metadata ?? {},
          updatedAt: new Date(),
        },
      })
      .returning({ id: chatEndpointResources.id });
    return resource ?? null;
  }

  async function reconcileGitHubWebhookRepository(
    endpoint: EndpointRow,
    payload: unknown,
  ) {
    const item = githubRepositoryInventoryItemFromPayload(payload);
    if (!item) return;
    await db.transaction(async (tx) => {
      const resource = await upsertProviderResourceRow(tx, endpoint, item);
      if (!resource) return;
      // A correctly signed repository callback is current provider proof. Keep
      // Paperclip's enabled choice, and reopen only conversations previously
      // quarantined for provider availability loss.
      await tx
        .update(chatConversations)
        .set({ state: "active", updatedAt: new Date() })
        .where(
          and(
            eq(chatConversations.companyId, endpoint.companyId),
            eq(chatConversations.endpointId, endpoint.id),
            eq(chatConversations.resourceId, resource.id),
            eq(chatConversations.state, "unavailable"),
          ),
        );
    });
  }

  async function reconcileProviderResourceRows(
    endpoint: EndpointRow,
    inventory: ChatProviderInventoryResult,
  ) {
    const resourceType =
      endpoint.provider === "github" ? "repository" : "channel";
    const discovered = new Set(
      inventory.resources.map((resource) => resource.providerResourceId),
    );
    const absentAvailability =
      endpoint.provider === "github" ? "removed" : "unavailable";
    await db.transaction(async (tx) => {
      for (const item of inventory.resources) {
        const resource = await upsertProviderResourceRow(tx, endpoint, item);
        if (resource) {
          // Resource recovery reopens only bindings that Paperclip marked
          // unavailable. Completed historical tasks stay completed.
          await tx
            .update(chatConversations)
            .set({ state: "active", updatedAt: new Date() })
            .where(
              and(
                eq(chatConversations.companyId, endpoint.companyId),
                eq(chatConversations.endpointId, endpoint.id),
                eq(chatConversations.resourceId, resource.id),
                eq(chatConversations.state, "unavailable"),
              ),
            );
        }
      }

      const existing = await tx
        .select({
          id: chatEndpointResources.id,
          providerResourceId: chatEndpointResources.providerResourceId,
        })
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.companyId, endpoint.companyId),
            eq(chatEndpointResources.endpointId, endpoint.id),
            eq(chatEndpointResources.type, resourceType),
          ),
        );
      for (const resource of existing) {
        if (discovered.has(resource.providerResourceId)) continue;
        await tx
          .update(chatEndpointResources)
          .set({ availability: absentAvailability, updatedAt: new Date() })
          .where(eq(chatEndpointResources.id, resource.id));
        await tx
          .update(chatConversations)
          .set({ state: "unavailable", updatedAt: new Date() })
          .where(
            and(
              eq(chatConversations.companyId, endpoint.companyId),
              eq(chatConversations.endpointId, endpoint.id),
              eq(chatConversations.resourceId, resource.id),
              inArray(chatConversations.state, ["active", "waiting"]),
            ),
          );
      }
    });
  }

  async function hydrateSlackResourceLabel(
    endpointId: string,
    providerResourceId: string,
  ): Promise<void> {
    const record = await endpointRecord(endpointId);
    if (
      !record ||
      record.endpoint.provider !== "slack" ||
      record.endpoint.status === "archived" ||
      record.endpoint.status === "revoked"
    ) {
      return;
    }
    const credentials = await resolveCredentials(record.endpoint);
    const resource = await getSlackBotChannel({
      botToken: credentials.botToken,
      channelId: providerResourceId,
      fetch: fetchImpl,
    });
    if (
      !resource ||
      slackResourceLabelIsFallback(providerResourceId, resource.label)
    )
      return;
    await db
      .update(chatEndpointResources)
      .set({ label: resource.label, updatedAt: new Date() })
      .where(
        and(
          eq(chatEndpointResources.companyId, record.endpoint.companyId),
          eq(chatEndpointResources.endpointId, endpointId),
          eq(chatEndpointResources.type, "channel"),
          eq(chatEndpointResources.providerResourceId, providerResourceId),
          eq(chatEndpointResources.availability, "available"),
        ),
      );
  }

  async function prepareProviderInventory(
    endpoint: EndpointRow,
    credentials: Record<string, string>,
  ): Promise<{
    credentials: Record<string, string>;
    inventory: ChatProviderInventoryResult | null;
  }> {
    try {
      if (endpoint.provider === "slack") {
        return {
          credentials,
          inventory: await listSlackBotChannels({
            botToken: credentials.botToken,
            fetch: fetchImpl,
          }),
        };
      }
      if (endpoint.provider === "github") {
        const appJwt = githubAppJwt(credentials.appId, credentials.privateKey);
        const installation = await discoverDedicatedGitHubAppInstallation({
          appJwt,
          fetch: fetchImpl,
        });
        const preparedCredentials = {
          ...credentials,
          installationId: installation.installationId,
        };
        const inventory = await listGitHubInstallationRepositories({
          appJwt,
          installationId: installation.installationId,
          fetch: fetchImpl,
        });
        return {
          credentials: preparedCredentials,
          inventory: {
            ...inventory,
            resources: inventory.resources.map((resource) => {
              const fullName =
                typeof resource.metadata?.fullName === "string"
                  ? resource.metadata.fullName
                  : resource.label.includes("/")
                    ? resource.label
                    : null;
              return fullName
                ? {
                    ...resource,
                    providerResourceId: fullName.toLowerCase(),
                    metadata: {
                      ...resource.metadata,
                      providerRepositoryId: resource.providerResourceId,
                      fullName,
                    },
                  }
                : resource;
            }),
          },
        };
      }
      if (endpoint.provider === "discord") {
        return {
          credentials,
          inventory: await listDiscordBotChannels({
            botToken: credentials.botToken,
            fetch: fetchImpl,
            guildId: credentials.guildId,
          }),
        };
      }
      return { credentials, inventory: null };
    } catch (error) {
      throw unprocessable(redactError(error), {
        code: "chat_provider_inventory_failed",
      });
    }
  }

  function runtimeConfig(
    endpoint: EndpointRow,
    userName: string,
    credentials: Record<string, string>,
  ): ResolvedChatSdkProviderConfig {
    if (endpoint.provider === "slack")
      return {
        provider: "slack",
        userName,
        credentials: {
          botToken: credentials.botToken,
          signingSecret: credentials.signingSecret,
          botUserId: endpoint.botExternalId ?? undefined,
        },
      };
    if (endpoint.provider === "telegram")
      return {
        provider: "telegram",
        userName,
        credentials: {
          botToken: credentials.botToken,
          secretToken: credentials.webhookSecret,
        },
      };
    if (endpoint.provider === "discord")
      return {
        provider: "discord",
        userName,
        credentials: {
          applicationId: credentials.applicationId,
          botToken: credentials.botToken,
          guildId: credentials.guildId,
        },
      };
    if (endpoint.provider === "microsoft-teams")
      return {
        provider: "microsoft-teams",
        userName,
        credentials: {
          appId: credentials.clientId,
          appPassword: credentials.clientSecret,
          appTenantId: credentials.tenantId,
          appType: "SingleTenant",
        },
      };
    return {
      provider: "github",
      userName,
      credentials: {
        appId: credentials.appId,
        privateKey: credentials.privateKey,
        installationId: credentials.installationId
          ? Number(credentials.installationId)
          : undefined,
        webhookSecret: credentials.webhookSecret,
      },
    };
  }

  async function runtimeFor(
    endpoint: EndpointRow,
  ): Promise<ChatSdkEndpointRuntime> {
    for (;;) {
      const record = await endpointRecord(endpoint.id);
      if (!record) throw notFound("Chat endpoint not found");
      if (
        record.endpoint.status === "archived" ||
        record.endpoint.status === "paused" ||
        record.endpoint.status === "draft"
      ) {
        throw conflict("Chat endpoint runtime is not available in this state", {
          code: "chat_endpoint_runtime_unavailable",
        });
      }
      const context = runtimeContextForRecord(record);
      const current = runtime.get(endpoint.id);
      if (current && runtimeVersions.get(endpoint.id) === context.version)
        return current;

      const pending = runtimeInitializations.get(endpoint.id);
      if (pending) {
        try {
          const instance = await pending.promise;
          if (pending.version === context.version) return instance;
        } catch (error) {
          if (pending.version === context.version) throw error;
        }
        continue;
      }

      const promise = (async () => {
        const stale = runtime.get(endpoint.id);
        if (stale) {
          runtimeVersions.delete(endpoint.id);
          await runtime.removeEndpoint(endpoint.id);
        }
        const credentials = await resolveCredentials(record.endpoint);
        const instance = await runtime.replaceEndpoint({
          companyId: record.endpoint.companyId,
          endpointId: record.endpoint.id,
          providerConfig: runtimeConfig(
            record.endpoint,
            record.endpoint.botUsername ?? record.assignedAgentName,
            credentials,
          ),
          persistence,
          concurrency: record.endpoint.concurrencyPolicy,
          callbacks: {
            onMessage: (event) => handleSdkMessage(event, context),
            onDiscordRootMentionAdmission:
              record.endpoint.provider === "discord"
                ? (event) =>
                    admitDiscordRootMention(record.endpoint, event, context)
                : undefined,
            onAction:
              record.endpoint.capabilities.actions === true
                ? (event) => handleAction(event, context)
                : undefined,
            onModalSubmit:
              record.endpoint.capabilities.modals === true
                ? (event) => handleModalSubmit(event, context)
                : undefined,
            onMessageDeleted: (event) => handleMessageDeleted(event, context),
            onMessageUpdated: (event) => handleMessageUpdated(event, context),
            onReaction:
              record.endpoint.capabilities.reactions === true
                ? (event) => handleReaction(event, context)
                : undefined,
            // Dynamic options remain unregistered. Native question buttons and
            // forms resolve only through issued durable rows. Reactions are an
            // auditable social signal, never an approval or task instruction.
            // Telegram exposes bot commands through Chat SDK's slash-command
            // callback even though it does not support arbitrary registered slash
            // commands. Paperclip still needs that callback for /new, /close, and
            // /status session controls.
            onSlashCommand:
              record.endpoint.capabilities.slashCommands ||
              record.endpoint.provider === "telegram"
                ? (event) => handleSlashCommand(event, context)
                : undefined,
          },
        });
        context.endpointRuntime = instance;
        runtimeContexts.set(instance as object, context);
        try {
          await instance.initialize();
          const latest = await endpointRecord(endpoint.id);
          const stillRegistered = runtime.get(endpoint.id) === instance;
          const stillCurrent =
            latest !== null &&
            latest.endpoint.status === record.endpoint.status &&
            runtimeContextForRecord(latest).version === context.version;
          if (!stillRegistered || !stillCurrent) {
            if (stillRegistered) {
              await runtime.removeEndpoint(endpoint.id);
              runtimeVersions.delete(endpoint.id);
            }
            throw conflict(
              "Chat endpoint runtime changed while it was initializing",
              {
                code: "chat_endpoint_runtime_superseded",
              },
            );
          }
          runtimeVersions.set(endpoint.id, context.version);
          return instance;
        } catch (error) {
          if (runtime.get(endpoint.id) === instance) {
            await runtime.removeEndpoint(endpoint.id).catch(() => undefined);
            runtimeVersions.delete(endpoint.id);
          } else if (!runtime.get(endpoint.id)) {
            runtimeVersions.delete(endpoint.id);
          }
          throw error;
        }
      })();
      const initialization = { promise, version: context.version };
      runtimeInitializations.set(endpoint.id, initialization);
      try {
        return await promise;
      } finally {
        if (runtimeInitializations.get(endpoint.id) === initialization) {
          runtimeInitializations.delete(endpoint.id);
        }
      }
    }
  }

  async function configure(
    endpointId: string,
    input: ConfigureChatEndpointInput,
    actorUserId?: string | null,
  ) {
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const suppliedCredentialKeys = Object.keys(input.credentials ?? {});
    if (suppliedCredentialKeys.length > 0) {
      const credentialAction =
        input.action === "configure" || input.action === "reconnect";
      const allowedKeys = new Set(
        credentialAction
          ? SUPPLIED_CREDENTIAL_KEYS[record.endpoint.provider]
          : [],
      );
      const unsupportedKeys = suppliedCredentialKeys.filter(
        (key) => !allowedKeys.has(key),
      );
      if (unsupportedKeys.length > 0) {
        throw unprocessable(
          `Unsupported ${PROVIDER_LABELS[record.endpoint.provider]} credential fields for ${input.action}: ${unsupportedKeys.join(", ")}`,
          {
            code: "chat_endpoint_credentials_invalid",
            provider: record.endpoint.provider,
            action: input.action,
            unsupportedKeys,
          },
        );
      }
    }
    if (
      input.action !== "configure" &&
      input.action !== "reconnect" &&
      input.action !== "verify" &&
      input.action !== "pause" &&
      input.action !== "resume" &&
      input.action !== "remove"
    ) {
      return configureWithoutCredentialLease(endpointId, input, actorUserId);
    }
    return withCredentialMutationLease(record.endpoint, () =>
      configureWithoutCredentialLease(endpointId, input, actorUserId),
    );
  }

  async function configureWithoutCredentialLease(
    endpointId: string,
    input: ConfigureChatEndpointInput,
    actorUserId?: string | null,
  ) {
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const endpoint = record.endpoint;
    if (input.action === "pause") {
      if (endpoint.status !== "active") {
        throw conflict("Only an active chat connection can be paused", {
          code: "chat_endpoint_not_active",
        });
      }
      await db.transaction(async (tx) => {
        const pausedAt = new Date();
        const current = await tx
          .select({ setup: chatEndpoints.setup, status: chatEndpoints.status })
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current || current.status !== "active") {
          throw conflict("Only an active chat connection can be paused", {
            code: "chat_endpoint_not_active",
          });
        }
        await tx
          .update(chatEndpoints)
          .set({
            status: "paused",
            setup: {
              ...current.setup,
              runtimeGeneration: runtimeGeneration(current.setup) + 1,
            } as InternalSetupState,
            updatedAt: pausedAt,
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        await tx
          .update(toolConnections)
          .set({ status: "disabled", enabled: false, updatedAt: new Date() })
          .where(eq(toolConnections.id, endpoint.connectionId));
        await tx
          .update(chatDeliveries)
          .set({
            state: "filtered",
            nextAttemptAt: null,
            redactedError: "Connection was paused before processing",
            processedAt: pausedAt,
            updatedAt: pausedAt,
          })
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              inArray(chatDeliveries.state, ["received", "retry"]),
            ),
          );
      });
      await invalidateRuntime(endpoint.id);
      await logActivity(db, {
        companyId: endpoint.companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "chat_endpoint.paused",
        entityType: "tool_connection",
        entityId: endpoint.connectionId,
        details: { endpointId: endpoint.id },
      });
      return get(endpoint.id);
    }
    if (input.action === "resume") {
      if (endpoint.status !== "paused" || endpoint.setup.step !== "complete") {
        throw conflict(
          "Only a previously active chat connection can be resumed",
          {
            code: "chat_endpoint_not_resumable",
          },
        );
      }
      let credentials = await resolveCredentials(endpoint).catch(() => {
        throw conflict("Reconnect the provider credentials before resuming", {
          code: "chat_endpoint_credentials_missing",
        });
      });
      const identity = await verifyCredentials(endpoint.provider, credentials);
      const upgradingLegacyGitHubIdentity =
        endpoint.provider === "github" &&
        !endpoint.botExternalId &&
        legacyGitHubLabelsMatchVerifiedCredentials(endpoint, identity);
      if (
        !upgradingLegacyGitHubIdentity &&
        !nativeBotIdentityMatches(endpoint.provider, endpoint, identity)
      ) {
        throw conflict(
          "The provider credentials now identify a different bot; reconnect this connection instead",
          {
            code: "chat_bot_identity_changed",
          },
        );
      }
      await assertNativeBotIdentityAvailable(endpoint, identity);
      const prepared = await prepareProviderInventory(endpoint, credentials);
      if (
        endpoint.provider === "github" &&
        prepared.credentials.installationId !== credentials.installationId
      ) {
        await persistCredentials(endpoint, prepared.credentials, actorUserId);
      }
      credentials = prepared.credentials;
      if (prepared.inventory)
        await reconcileProviderResourceRows(endpoint, prepared.inventory);
      let activatedEndpoint!: EndpointRow;
      try {
        await db.transaction(async (tx) => {
          const resumedAt = new Date();
          const current = await tx
            .select()
            .from(chatEndpoints)
            .where(eq(chatEndpoints.id, endpoint.id))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!current || current.status !== "paused") {
            throw conflict(
              "Only a previously active chat connection can be resumed",
              {
                code: "chat_endpoint_not_resumable",
              },
            );
          }
          // Fail closed for any legacy or racing delivery that remained open
          // while this endpoint was paused. Resume must never execute traffic
          // that Paperclip acknowledged during the inactive interval.
          await tx
            .update(chatDeliveries)
            .set({
              state: "filtered",
              nextAttemptAt: null,
              redactedError: "Connection was paused when this event arrived",
              processedAt: resumedAt,
              updatedAt: resumedAt,
            })
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                inArray(chatDeliveries.state, ["received", "retry"]),
              ),
            );
          [activatedEndpoint] = await tx
            .update(chatEndpoints)
            .set({
              status: "active",
              ...(upgradingLegacyGitHubIdentity
                ? { botExternalId: identity.botExternalId }
                : {}),
              healthMessage: "Connected",
              lastError: null,
              setup: {
                ...current.setup,
                runtimeGeneration: runtimeGeneration(current.setup) + 1,
              } as InternalSetupState,
              updatedAt: resumedAt,
            })
            .where(eq(chatEndpoints.id, endpoint.id))
            .returning();
          await tx
            .update(toolConnections)
            .set({
              status: "active",
              enabled: true,
              healthStatus: "healthy",
              healthMessage: "Connected",
              lastError: null,
              healthCheckedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(toolConnections.id, endpoint.connectionId));
        });
        await invalidateRuntime(endpoint.id);
        await runtimeFor(activatedEndpoint);
      } catch (error) {
        await invalidateRuntime(endpoint.id).catch(() => undefined);
        if (activatedEndpoint) {
          const failure = redactError(error);
          const failedAt = new Date();
          await db.transaction(async (tx) => {
            await tx
              .update(chatEndpoints)
              .set({
                status: "attention",
                healthMessage: "Provider resume needs attention",
                lastError: failure,
                updatedAt: failedAt,
              })
              .where(
                and(
                  eq(chatEndpoints.id, endpoint.id),
                  eq(chatEndpoints.status, "active"),
                  sql`coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0) = ${runtimeGeneration(activatedEndpoint.setup)}`,
                ),
              );
            await tx
              .update(toolConnections)
              .set({
                status: "disabled",
                enabled: false,
                healthStatus: "degraded",
                healthMessage: "Provider resume failed",
                lastError: failure,
                healthCheckedAt: failedAt,
                updatedAt: failedAt,
              })
              .where(eq(toolConnections.id, endpoint.connectionId));
            await tx
              .update(chatDeliveries)
              .set({
                state: "filtered",
                nextAttemptAt: null,
                redactedError: "Connection activation failed",
                processedAt: failedAt,
                updatedAt: failedAt,
              })
              .where(
                and(
                  eq(chatDeliveries.endpointId, endpoint.id),
                  inArray(chatDeliveries.state, ["received", "retry"]),
                ),
              );
          });
        }
        throw error;
      }
      await logActivity(db, {
        companyId: endpoint.companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "chat_endpoint.resumed",
        entityType: "tool_connection",
        entityId: endpoint.connectionId,
        details: { endpointId: endpoint.id },
      });
      return get(endpoint.id);
    }
    if (input.action === "remove") {
      if (endpoint.status === "archived") {
        // Archival is the durable ingress fence and intentionally commits
        // before secret-store cleanup. If that cleanup failed, a repeated
        // remove is the recovery operation; once refs are empty, retain the
        // normal already-removed conflict contract.
        if (record.credentialSecretRefs.length > 0) {
          await invalidateRuntime(endpoint.id).catch(() => undefined);
          await clearCredentials(endpoint);
          return get(endpoint.id);
        }
        throw conflict("This chat connection has already been removed", {
          code: "chat_endpoint_already_removed",
        });
      }
      const existingTelegramCredentials =
        endpoint.provider === "telegram"
          ? await resolveCredentials(endpoint).catch(() => null)
          : null;
      await db.transaction(async (tx) => {
        const current = await tx
          .select({ setup: chatEndpoints.setup, status: chatEndpoints.status })
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current || current.status === "archived") {
          throw conflict("This chat connection has already been removed", {
            code: "chat_endpoint_already_removed",
          });
        }
        await tx
          .update(chatEndpoints)
          .set({
            status: "archived",
            setup: {
              ...current.setup,
              runtimeGeneration: runtimeGeneration(current.setup) + 1,
            } as InternalSetupState,
            archivedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        await tx
          .update(chatConversations)
          .set({ state: "endpoint_removed", updatedAt: new Date() })
          .where(eq(chatConversations.endpointId, endpoint.id));
        await tx
          .update(toolConnections)
          .set({ status: "archived", enabled: false, updatedAt: new Date() })
          .where(eq(toolConnections.id, endpoint.connectionId));
        const otherConnection = await tx
          .select({ id: toolConnections.id })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.companyId, endpoint.companyId),
              eq(toolConnections.applicationId, record.applicationId),
              ne(toolConnections.id, endpoint.connectionId),
              ne(toolConnections.status, "archived"),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!otherConnection) {
          await tx
            .update(toolApplications)
            .set({
              status: "archived",
              archivedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(toolApplications.id, record.applicationId));
        }
      });
      await invalidateRuntime(endpoint.id).catch(() => undefined);
      if (endpoint.provider === "telegram") {
        const existingCredentials = existingTelegramCredentials;
        if (existingCredentials?.botToken) {
          try {
            const response = await fetchImpl(
              `https://api.telegram.org/bot${encodeURIComponent(existingCredentials.botToken)}/deleteWebhook`,
              {
                method: "POST",
                signal: AbortSignal.timeout(
                  PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS,
                ),
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ drop_pending_updates: false }),
              },
            );
            const result = (await response.json()) as {
              ok?: boolean;
              description?: string;
            };
            if (!response.ok || !result.ok) {
              logger.warn(
                {
                  endpointId: endpoint.id,
                  error: result.description ?? String(response.status),
                },
                "Telegram webhook cleanup was rejected",
              );
            }
          } catch (error) {
            logger.warn(
              { endpointId: endpoint.id, error: redactError(error) },
              "Telegram webhook cleanup failed",
            );
          }
        }
      }
      await clearCredentials(endpoint);
      return get(endpoint.id);
    }
    if (
      input.action !== "configure" &&
      input.action !== "reconnect" &&
      input.action !== "verify"
    ) {
      throw unprocessable("Unsupported chat endpoint setup action");
    }
    if (!publicBaseUrl && endpoint.provider !== "discord") {
      throw unprocessable(
        `A public HTTPS Paperclip URL is required before connecting ${PROVIDER_LABELS[endpoint.provider]}`,
      );
    }
    if (input.action === "verify") {
      if (
        endpoint.provider !== "slack" ||
        endpoint.status !== "verifying" ||
        endpoint.setup.step !== "provider_setup"
      ) {
        throw conflict(
          "Provider verification is not available at this setup step",
          {
            code: "chat_endpoint_invalid_setup_step",
          },
        );
      }
      if (!endpoint.setup.webhookVerifiedAt) {
        throw conflict("Slack has not verified the Paperclip Request URL yet", {
          code: "chat_webhook_not_verified",
        });
      }
    } else if (
      input.action === "configure" &&
      !["draft", "attention", "revoked"].includes(endpoint.status)
    ) {
      throw conflict(
        "This connection is already configured; use its reconnect flow if credentials need repair",
        {
          code: "chat_endpoint_already_configured",
        },
      );
    } else if (
      input.action === "reconnect" &&
      !["verifying", "active", "attention", "revoked", "paused"].includes(
        endpoint.status,
      )
    ) {
      throw conflict(
        "This chat connection does not currently need reconnecting",
        {
          code: "chat_endpoint_not_reconnectable",
        },
      );
    }
    if (
      endpoint.provider === "github" &&
      (input.action === "configure" || input.action === "reconnect") &&
      !endpoint.setup.webhookVerifiedAt
    ) {
      throw conflict(
        "GitHub has not delivered a signed webhook ping for this secret yet",
        {
          code: "chat_webhook_not_verified",
        },
      );
    }

    let verifiedCurrentIdentity: VerifiedProviderIdentity = endpoint;
    if (
      input.action === "reconnect" &&
      endpoint.provider === "github" &&
      !endpoint.botExternalId
    ) {
      const storedCredentials = await resolveCredentials(endpoint).catch(() => {
        throw conflict(
          "Reconnect the existing GitHub App credentials before changing them",
          {
            code: "chat_bot_identity_unverifiable",
          },
        );
      });
      const storedIdentity = await verifyCredentials(
        "github",
        storedCredentials,
      );
      if (
        !legacyGitHubLabelsMatchVerifiedCredentials(endpoint, storedIdentity)
      ) {
        throw conflict(
          "The stored credentials no longer verify the GitHub App that owns this connection",
          {
            code: "chat_bot_identity_unverifiable",
          },
        );
      }
      verifiedCurrentIdentity = storedIdentity;
    }

    let credentials =
      input.credentials && Object.keys(input.credentials).length > 0
        ? await normalizedCredentials(endpoint, input.credentials)
        : await resolveCredentials(endpoint).catch(() => {
            throw unprocessable(
              `${PROVIDER_LABELS[endpoint.provider]} credentials are required`,
            );
          });
    const identity = await verifyCredentials(endpoint.provider, credentials);
    if (input.action === "reconnect") {
      if (
        !nativeBotIdentityMatches(
          endpoint.provider,
          verifiedCurrentIdentity,
          identity,
        )
      ) {
        throw conflict(
          "The provider credentials identify a different bot; create a new connection for that bot instead",
          { code: "chat_bot_identity_changed" },
        );
      }
    }
    await assertNativeBotIdentityAvailable(endpoint, identity);
    const prepared = await prepareProviderInventory(endpoint, credentials);
    const credentialsChangedByDiscovery =
      endpoint.provider === "github" &&
      prepared.credentials.installationId !== credentials.installationId;
    credentials = prepared.credentials;
    if (
      (input.credentials && Object.keys(input.credentials).length > 0) ||
      credentialsChangedByDiscovery
    )
      await persistCredentials(endpoint, credentials, actorUserId);
    if (prepared.inventory)
      await reconcileProviderResourceRows(endpoint, prepared.inventory);
    const updatedAt = new Date();
    const waitingForSlackConfiguration =
      endpoint.provider === "slack" &&
      (input.action === "configure" || input.action === "reconnect");
    try {
      await db.transaction(async (tx) => {
        const current = await tx
          .select({ setup: chatEndpoints.setup })
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current) throw notFound("Chat endpoint not found");
        await tx
          .update(chatEndpoints)
          .set({
            status: "verifying",
            providerAccountId: identity.providerAccountId ?? null,
            providerAccountLabel: identity.providerAccountLabel ?? null,
            botExternalId: identity.botExternalId ?? null,
            botUsername: identity.botUsername ?? null,
            botDisplayName:
              identity.botLabel ??
              endpoint.botDisplayName ??
              record.assignedAgentName,
            healthMessage: waitingForSlackConfiguration
              ? "Finish provider webhook configuration"
              : "Waiting for a test conversation",
            lastError: null,
            lastEventAt: null,
            setup: {
              ...current.setup,
              step: waitingForSlackConfiguration ? "provider_setup" : "test",
              testStartedAt: waitingForSlackConfiguration
                ? null
                : updatedAt.toISOString(),
              webhookVerifiedAt: waitingForSlackConfiguration
                ? null
                : (current.setup.webhookVerifiedAt ?? null),
              runtimeGeneration: runtimeGeneration(current.setup) + 1,
            } as InternalSetupState,
            updatedAt,
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        await tx
          .update(toolConnections)
          .set({
            status: "active",
            enabled: true,
            healthStatus: "healthy",
            healthMessage: "Provider credentials verified",
            healthCheckedAt: updatedAt,
            updatedAt,
          })
          .where(eq(toolConnections.id, endpoint.connectionId));
        await tx
          .update(toolApplications)
          .set({ status: "active", archivedAt: null, updatedAt })
          .where(eq(toolApplications.id, record.applicationId));
      });
    } catch (error) {
      if (
        isUniqueViolation(error, "chat_endpoints_live_bot_external_uq") ||
        isUniqueViolation(
          error,
          "chat_endpoints_live_discord_bot_external_uq",
        ) ||
        isUniqueViolation(error, "chat_endpoints_live_bot_username_uq")
      ) {
        throw conflict(
          `This ${PROVIDER_LABELS[endpoint.provider]} bot already represents another Paperclip agent connection`,
          { code: "chat_bot_identity_in_use" },
        );
      }
      throw error;
    }
    try {
      const next = await endpointRecord(endpoint.id);
      if (!next) throw notFound("Chat endpoint not found");
      await invalidateRuntime(endpoint.id);
      await runtimeFor(next.endpoint);

      if (endpoint.provider === "telegram" && publicBaseUrl) {
        const webhookUrl = `${publicBaseUrl}/api/chat-webhooks/${endpoint.publicId}/telegram`;
        const infoResponse = await fetchImpl(
          `https://api.telegram.org/bot${encodeURIComponent(credentials.botToken)}/getWebhookInfo`,
          { signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS) },
        );
        const infoResult = (await infoResponse.json()) as {
          ok?: boolean;
          description?: string;
          result?: { url?: string };
        };
        if (!infoResponse.ok || !infoResult.ok) {
          throw unprocessable(
            `Telegram could not inspect the existing webhook: ${infoResult.description ?? infoResponse.status}`,
          );
        }
        const existingWebhookUrl = infoResult.result?.url?.trim() ?? "";
        const response = await fetchImpl(
          `https://api.telegram.org/bot${encodeURIComponent(credentials.botToken)}/setWebhook`,
          {
            method: "POST",
            signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              url: webhookUrl,
              secret_token: credentials.webhookSecret,
              allowed_updates: [
                "message",
                "edited_message",
                "callback_query",
                "message_reaction",
                "my_chat_member",
              ],
              drop_pending_updates:
                input.action === "configure" ||
                (existingWebhookUrl.length > 0 &&
                  existingWebhookUrl !== webhookUrl),
            }),
          },
        );
        const result = (await response.json()) as {
          ok?: boolean;
          description?: string;
        };
        if (!response.ok || !result.ok)
          throw unprocessable(
            `Telegram could not register the webhook: ${result.description ?? response.status}`,
          );
        try {
          const commandsResponse = await fetchImpl(
            `https://api.telegram.org/bot${encodeURIComponent(credentials.botToken)}/setMyCommands`,
            {
              method: "POST",
              signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS),
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ commands: TELEGRAM_COMMANDS }),
            },
          );
          const commandsResult = (await commandsResponse.json()) as {
            ok?: boolean;
            description?: string;
          };
          if (!commandsResponse.ok || !commandsResult.ok) {
            logger.warn(
              {
                endpointId: endpoint.id,
                error:
                  commandsResult.description ?? String(commandsResponse.status),
              },
              "Telegram command menu registration was rejected",
            );
          }
        } catch (error) {
          // Command discovery improves group usability but is not an ingress
          // credential or webhook requirement. Preserve a working connection
          // when Telegram temporarily rejects this optional registration.
          logger.warn(
            { endpointId: endpoint.id, error: redactError(error) },
            "Telegram command menu registration failed",
          );
        }
      }
    } catch (error) {
      const failure = redactError(error);
      await invalidateRuntime(endpoint.id).catch(() => undefined);
      await Promise.all([
        db
          .update(chatEndpoints)
          .set({
            status: "attention",
            healthMessage: "Provider setup needs attention",
            lastError: failure,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, endpoint.id)),
        db
          .update(toolConnections)
          .set({
            healthStatus: "degraded",
            healthMessage: "Provider setup failed",
            lastError: failure,
            healthCheckedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, endpoint.connectionId)),
      ]);
      throw unprocessable(failure, { code: "chat_provider_setup_failed" });
    }

    await logActivity(db, {
      companyId: endpoint.companyId,
      actorType: "user",
      actorId: actorUserId ?? "board",
      action: "chat_endpoint.credentials_verified",
      entityType: "tool_connection",
      entityId: endpoint.connectionId,
      details: { endpointId: endpoint.id, provider: endpoint.provider },
    });
    return get(endpoint.id);
  }

  async function test(endpointId: string) {
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const endpoint = record.endpoint;
    if (endpoint.status !== "verifying" || endpoint.setup.step !== "test") {
      throw conflict("This connection is not waiting for a setup test", {
        code: "chat_endpoint_not_testing",
      });
    }
    const testStartedAt = endpoint.setup.testStartedAt
      ? new Date(endpoint.setup.testStartedAt)
      : null;
    if (
      !endpoint.lastEventAt ||
      !testStartedAt ||
      Number.isNaN(testStartedAt.getTime()) ||
      endpoint.lastEventAt < testStartedAt
    ) {
      throw conflict(
        "Send the test message in the provider before completing setup",
        {
          code: "chat_test_message_missing",
        },
      );
    }
    const requiredTrigger =
      endpoint.provider === "telegram"
        ? "direct_message"
        : "subscribed_message";
    const qualifyingDelivery = await db
      .select({
        id: chatDeliveries.id,
        conversationId: chatDeliveries.conversationId,
        processedAt: chatDeliveries.processedAt,
      })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.companyId, endpoint.companyId),
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.state, "processed"),
          gte(chatDeliveries.processedAt, testStartedAt),
          sql`${chatDeliveries.normalizedEvent}->>'trigger' = ${requiredTrigger}`,
        ),
      )
      .orderBy(desc(chatDeliveries.processedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !qualifyingDelivery?.conversationId ||
      !qualifyingDelivery.processedAt
    ) {
      throw conflict(
        endpoint.provider === "telegram"
          ? "Send the test direct message before completing setup"
          : "Reply once without mentioning the agent before completing setup",
        { code: "chat_test_follow_up_missing" },
      );
    }
    const finalPublication = await db
      .select({
        commentId: chatPublications.commentId,
        payload: chatPublications.payload,
      })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, endpoint.companyId),
          eq(chatPublications.endpointId, endpoint.id),
          eq(
            chatPublications.conversationId,
            qualifyingDelivery.conversationId,
          ),
          eq(chatPublications.state, "published"),
          gte(chatPublications.publishedAt, qualifyingDelivery.processedAt),
        ),
      )
      .orderBy(desc(chatPublications.publishedAt))
      .then((rows) =>
        rows.find(
          (row) =>
            row.payload.interactionId === undefined &&
            ((row.payload.progressState === undefined &&
              row.commentId !== null) ||
              row.payload.progressState === "failed"),
        ),
      );
    if (!finalPublication) {
      throw conflict(
        "Wait for the Paperclip agent to reply to the setup turn before completing setup",
        {
          code: "chat_test_round_trip_incomplete",
        },
      );
    }
    await db.transaction(async (tx) => {
      await tx
        .update(chatEndpoints)
        .set({
          status: "active",
          setup: {
            ...endpoint.setup,
            step: "complete",
            testStartedAt: null,
          },
          healthMessage: "Connected",
          activatedAt: endpoint.activatedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatEndpoints.id, endpointId),
            eq(chatEndpoints.status, "verifying"),
          ),
        );
      await tx
        .update(toolConnections)
        .set({
          status: "active",
          enabled: true,
          healthStatus: "healthy",
          healthMessage: "Connected",
          lastError: null,
          healthCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(toolConnections.id, endpoint.connectionId));
    });
    return get(endpointId);
  }

  async function ensurePrincipal(
    endpoint: EndpointRow,
    author: Author,
    raw?: unknown,
  ) {
    const providerAccountId = endpoint.providerAccountId ?? "unknown";
    const externalId = stableExternalPrincipalId(
      endpoint.provider,
      author,
      raw,
    );
    const [principal] = await db
      .insert(chatExternalPrincipals)
      .values({
        companyId: endpoint.companyId,
        provider: endpoint.provider,
        providerAccountId,
        externalId,
        kind:
          author.isBot === true ? "bot" : author.isSystem ? "system" : "user",
        displayName: author.fullName,
        handle: author.userName,
        isBot: author.isBot === true || author.isMe,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          chatExternalPrincipals.companyId,
          chatExternalPrincipals.provider,
          chatExternalPrincipals.providerAccountId,
          chatExternalPrincipals.externalId,
        ],
        set: {
          displayName: author.fullName,
          handle: author.userName,
          isBot: author.isBot === true || author.isMe,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
    const link = await db
      .select({
        userId: chatIdentityLinks.paperclipUserId,
        status: chatIdentityLinks.status,
      })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.endpointId, endpoint.id),
          eq(chatIdentityLinks.principalId, principal.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (link?.status === "linked" && link.userId) {
      const membership = await db
        .select({
          status: companyMemberships.status,
          membershipRole: companyMemberships.membershipRole,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, endpoint.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, link.userId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      // External chat performs the same task mutations as the board. A linked
      // viewer therefore remains read-only instead of gaining write authority
      // merely by using a provider account.
      if (
        membership?.status !== "active" ||
        membership.membershipRole === "viewer"
      ) {
        return { principal, userId: null, linkedDenied: true };
      }
      return { principal, userId: link.userId, linkedDenied: false };
    }
    return { principal, userId: null, linkedDenied: false };
  }

  async function sponsorAllowsGuest(endpoint: EndpointRow): Promise<boolean> {
    // A null sponsor is the local board/operator context used by self-hosted
    // instances. Cloud endpoints retain the creating user and must revalidate
    // that user's current company authority on every sponsored guest turn.
    if (!endpoint.sponsorUserId) return true;
    const membership = await db
      .select({
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, endpoint.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, endpoint.sponsorUserId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return (
      membership?.status === "active" && membership.membershipRole !== "viewer"
    );
  }

  async function lockCurrentPrincipalAuthorization(
    tx: DbOrTransaction,
    endpoint: EndpointRow,
    principalId: string,
  ): Promise<{
    allowed: boolean;
    linkedDenied: boolean;
    userId: string | null;
  }> {
    // Link confirmation already uses this transaction-scoped identity key.
    // Taking it at the final task mutation boundary prevents a newly confirmed
    // identity from racing the authorization snapshot. Row locks below also
    // serialize revocation and membership changes that do not use this key.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${endpoint.companyId}:${principalId}`}, 0))`,
    );
    const link = await tx
      .select({
        status: chatIdentityLinks.status,
        userId: chatIdentityLinks.paperclipUserId,
      })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.companyId, endpoint.companyId),
          eq(chatIdentityLinks.endpointId, endpoint.id),
          eq(chatIdentityLinks.principalId, principalId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (link?.status === "linked") {
      if (!link.userId) {
        return { allowed: false, linkedDenied: true, userId: null };
      }
      const membership = await tx
        .select({
          status: companyMemberships.status,
          membershipRole: companyMemberships.membershipRole,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, endpoint.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, link.userId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const allowed =
        membership?.status === "active" &&
        membership.membershipRole !== "viewer";
      return {
        allowed,
        linkedDenied: !allowed,
        userId: allowed ? link.userId : null,
      };
    }
    if (!endpoint.allowUnlinkedPeople) {
      return { allowed: false, linkedDenied: false, userId: null };
    }
    if (!endpoint.sponsorUserId) {
      return { allowed: true, linkedDenied: false, userId: null };
    }
    const sponsorMembership = await tx
      .select({
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, endpoint.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, endpoint.sponsorUserId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    return {
      allowed:
        sponsorMembership?.status === "active" &&
        sponsorMembership.membershipRole !== "viewer",
      linkedDenied: false,
      userId: null,
    };
  }

  async function requireCurrentExternalActionAuthorization(
    tx: DbTransaction,
    input: {
      conversationId: string;
      endpointId: string;
      expectedUserId: string;
      principalId: string;
      runtimeContext: LifecycleRuntimeFence;
    },
  ): Promise<void> {
    const endpoint = await runtimeCallbackEndpoint(
      tx,
      input.endpointId,
      input.runtimeContext,
      ["active"],
    );
    if (!endpoint) {
      throw forbidden("This chat action is no longer authorized", {
        code: "chat_action_authorization_changed",
      });
    }
    const conversation = await tx
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.id, input.conversationId),
          inArray(chatConversations.state, ["active", "waiting"]),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!conversation) {
      throw forbidden("This chat action is no longer authorized", {
        code: "chat_action_authorization_changed",
      });
    }
    const resource = conversation.resourceId
      ? await tx
          .select()
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.companyId, endpoint.companyId),
              eq(chatEndpointResources.endpointId, endpoint.id),
              eq(chatEndpointResources.id, conversation.resourceId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null)
      : null;
    const destinationAllowed = conversation.isDirectMessage
      ? endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(endpoint, resource);
    const authorization = await lockCurrentPrincipalAuthorization(
      tx,
      endpoint,
      input.principalId,
    );
    // Governed actions never fall back to sponsored-guest authority. If the
    // provider identity was relinked while this callback waited, reject this
    // stale actor snapshot and let a fresh callback use the new identity.
    if (
      !destinationAllowed ||
      !authorization.allowed ||
      authorization.userId !== input.expectedUserId
    ) {
      throw forbidden("This chat action is no longer authorized", {
        code: "chat_action_authorization_changed",
      });
    }
  }

  function isExternalActionAuthorizationChange(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const value = error as { details?: unknown };
    return (
      Boolean(value.details) &&
      typeof value.details === "object" &&
      (value.details as { code?: unknown }).code ===
        "chat_action_authorization_changed"
    );
  }

  async function ensureResource(
    endpoint: EndpointRow,
    thread: Thread,
    enabledBySetupActivation: boolean,
    database: DbOrTransaction = db,
  ) {
    const type = providerResourceType(
      endpoint.provider,
      chatSurfaceKind(endpoint.provider, thread),
    );
    const providerResourceId = canonicalProviderResourceId(
      endpoint.provider,
      thread,
    );
    const resourceLabel = providerResourceLabelFromThread(
      endpoint.provider,
      thread,
    );
    const [resource] = await database
      .insert(chatEndpointResources)
      .values({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        type,
        providerResourceId,
        label: resourceLabel.label,
        availability: "available",
        enabled: thread.isDM || enabledBySetupActivation,
      })
      .onConflictDoUpdate({
        target: [
          chatEndpointResources.endpointId,
          chatEndpointResources.type,
          chatEndpointResources.providerResourceId,
        ],
        set: {
          // Provider inventory and membership lifecycle own availability.
          // A delayed message must not resurrect a destination after the bot
          // was removed or an installation lost access.
          // Slack callbacks are not guaranteed to carry a channel name. Keep
          // an inventory- or conversations.info-derived label instead of
          // downgrading it to C… / slack:C… when a delayed message arrives.
          ...(resourceLabel.fallback
            ? {}
            : {
                label: sql<string>`case
                  when ${chatEndpointResources.availability} = 'available' then ${resourceLabel.label}
                  else ${chatEndpointResources.label}
                end`,
              }),
          updatedAt: new Date(),
        },
      })
      .returning();
    return resource;
  }

  async function ingestAttachments(input: {
    endpoint: EndpointRow;
    issueId: string;
    issueCommentId: string;
    attachments: Attachment[];
    actorUserId: string | null;
  }): Promise<{
    storedIds: string[];
    omissionReasons: Record<string, number>;
  }> {
    const omissionReasons: Record<string, number> = {};
    const omit = (reason: string, count = 1) => {
      omissionReasons[reason] = (omissionReasons[reason] ?? 0) + count;
    };
    const boundedAttachments = input.attachments.slice(0, 20);
    if (input.attachments.length > boundedAttachments.length) {
      omit(
        "attachment_limit",
        input.attachments.length - boundedAttachments.length,
      );
    }
    if (!options.storage) {
      if (boundedAttachments.length)
        omit("storage_unavailable", boundedAttachments.length);
      return { storedIds: [], omissionReasons };
    }
    const existingByFingerprint = new Map<string, string[]>();
    const existingAttachments = await db
      .select({
        id: issueAttachments.id,
        byteSize: assets.byteSize,
        contentType: assets.contentType,
        originalFilename: assets.originalFilename,
        sha256: assets.sha256,
      })
      .from(issueAttachments)
      .innerJoin(
        assets,
        and(
          eq(assets.companyId, issueAttachments.companyId),
          eq(assets.id, issueAttachments.assetId),
        ),
      )
      .where(
        and(
          eq(issueAttachments.companyId, input.endpoint.companyId),
          eq(issueAttachments.issueId, input.issueId),
          eq(issueAttachments.issueCommentId, input.issueCommentId),
        ),
      );
    for (const existing of existingAttachments) {
      const fingerprint = JSON.stringify([
        existing.sha256,
        existing.byteSize,
        existing.contentType,
        existing.originalFilename,
      ]);
      const ids = existingByFingerprint.get(fingerprint) ?? [];
      ids.push(existing.id);
      existingByFingerprint.set(fingerprint, ids);
    }
    const storedIds: string[] = [];
    for (const attachment of boundedAttachments) {
      try {
        if (
          attachment.size !== undefined &&
          attachment.size > MAX_ATTACHMENT_BYTES
        ) {
          omit("declared_too_large");
          continue;
        }
        if (!attachment.fetchData) {
          omit("download_unavailable");
          continue;
        }
        const originalFilename = sanitizeFilename(attachment.name);
        const contentType = normalizeUploadAttachmentContentType({
          contentType: normalizeContentType(
            attachment.mimeType ?? "application/octet-stream",
          ),
          originalFilename,
          isAllowedContentType,
        });
        // Reject a provider-declared type before allocating the downloaded
        // payload. The actual byte length is checked again after the adapter's
        // bounded fetch contract resolves.
        if (!isAllowedContentType(contentType)) {
          omit("unsupported_type");
          continue;
        }
        const fetched = await attachment.fetchData();
        const body = Buffer.isBuffer(fetched) ? fetched : Buffer.from(fetched);
        if (body.length === 0) {
          omit("empty_download");
          continue;
        }
        if (body.length > MAX_ATTACHMENT_BYTES) {
          omit("downloaded_too_large");
          continue;
        }
        const fingerprint = JSON.stringify([
          createHash("sha256").update(body).digest("hex"),
          body.length,
          contentType,
          originalFilename,
        ]);
        const existingIds = existingByFingerprint.get(fingerprint);
        const existingId = existingIds?.shift();
        if (existingId) {
          storedIds.push(existingId);
          continue;
        }
        const stored = await options.storage.putFile({
          companyId: input.endpoint.companyId,
          namespace: `issues/${input.issueId}`,
          originalFilename,
          contentType,
          body,
        });
        const row = await issuesSvc.createAttachment({
          issueId: input.issueId,
          issueCommentId: input.issueCommentId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByUserId: input.actorUserId,
        });
        storedIds.push(row.id);
      } catch (error) {
        omit("processing_failed");
        // A malformed or unavailable provider attachment must not strand the
        // durable text delivery. The rejected file is intentionally omitted;
        // the delivery remains auditable through its normalized attachment
        // metadata without persisting provider credentials or download URLs.
        logger.warn(
          {
            endpointId: input.endpoint.id,
            issueId: input.issueId,
            attachmentName: sanitizeFilename(attachment.name),
            error: redactError(error),
          },
          "external chat attachment was rejected",
        );
      }
    }
    return { storedIds, omissionReasons };
  }

  function attachmentOmissionDetail(result: {
    omissionReasons: Record<string, number>;
  }): string | null {
    const entries = Object.entries(result.omissionReasons).filter(
      ([, count]) => count > 0,
    );
    const omitted = entries.reduce((total, [, count]) => total + count, 0);
    if (!omitted) return null;
    const reasons = entries
      .map(([reason, count]) => `${reason.replaceAll("_", " ")}: ${count}`)
      .join(", ");
    return `${omitted} external attachment${omitted === 1 ? " was" : "s were"} omitted (${reasons})`;
  }

  async function admitDiscordRootMention(
    configuredEndpoint: EndpointRow,
    event: DiscordRootMentionAdmissionEvent,
    context: RuntimeContext,
  ): Promise<boolean> {
    const threadId = `discord:${event.guildId}:${event.channelId}:${event.messageId}`;
    const providerEventId = `${threadId}:${event.messageId}`;
    const allowed = await db.transaction(async (tx) => {
      const endpoint = await runtimeCallbackEndpoint(
        tx,
        configuredEndpoint.id,
        context,
        ["verifying", "active"],
      );
      const existing = await tx
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, configuredEndpoint.id),
            eq(chatDeliveries.providerEventId, providerEventId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (
        existing &&
        ["processed", "filtered", "failed"].includes(existing.state)
      )
        return false;

      let reason: string | null = null;
      if (!endpoint || endpoint.providerAccountId !== event.guildId) {
        reason = "Connection is not active";
      }
      const resource = endpoint
        ? await tx
            .select()
            .from(chatEndpointResources)
            .where(
              and(
                eq(chatEndpointResources.endpointId, endpoint.id),
                eq(chatEndpointResources.type, "channel"),
                eq(chatEndpointResources.providerResourceId, event.channelId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      const enabledCount =
        endpoint?.status === "verifying"
          ? await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(chatEndpointResources)
              .where(
                and(
                  eq(chatEndpointResources.endpointId, endpoint.id),
                  eq(chatEndpointResources.type, "channel"),
                  eq(chatEndpointResources.enabled, true),
                  eq(chatEndpointResources.availability, "available"),
                ),
              )
              .then((rows) => rows[0]?.count ?? 0)
          : 0;
      const setupDestination =
        endpoint?.status === "verifying" &&
        enabledCount === 0 &&
        resource?.availability === "available";
      if (
        !reason &&
        !(
          endpoint?.allowGroupChats &&
          resource?.availability === "available" &&
          (resource.enabled || setupDestination)
        )
      ) {
        reason = "Destination is not enabled in Paperclip";
      }

      if (!reason && endpoint) {
        const principal = await tx
          .select({ id: chatExternalPrincipals.id })
          .from(chatExternalPrincipals)
          .where(
            and(
              eq(chatExternalPrincipals.companyId, endpoint.companyId),
              eq(chatExternalPrincipals.provider, "discord"),
              eq(chatExternalPrincipals.providerAccountId, event.guildId),
              eq(chatExternalPrincipals.externalId, event.userId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        let allowed: boolean;
        let linkedDenied = false;
        if (principal) {
          const authorization = await lockCurrentPrincipalAuthorization(
            tx,
            endpoint,
            principal.id,
          );
          allowed = authorization.allowed;
          linkedDenied = authorization.linkedDenied;
        } else if (!endpoint.allowUnlinkedPeople) {
          allowed = false;
        } else if (!endpoint.sponsorUserId) {
          allowed = true;
        } else {
          const sponsor = await tx
            .select({
              status: companyMemberships.status,
              membershipRole: companyMemberships.membershipRole,
            })
            .from(companyMemberships)
            .where(
              and(
                eq(companyMemberships.companyId, endpoint.companyId),
                eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.principalId, endpoint.sponsorUserId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          allowed =
            sponsor?.status === "active" && sponsor.membershipRole !== "viewer";
        }
        if (!allowed) {
          reason = linkedDenied
            ? "Linked Paperclip account is not currently permitted"
            : endpoint.allowUnlinkedPeople
              ? "Endpoint sponsor can no longer authorize external guests"
              : "External identity must be linked to a Paperclip account";
        }
      }
      if (!reason) return true;

      const filteredAt = new Date();
      const normalizedEvent = {
        providerEventId,
        kind: "mention",
        trigger: "mention",
        resource: {
          type: "channel",
          providerResourceId: event.channelId,
        },
        conversation: { externalThreadId: threadId },
        message: { providerMessageId: event.messageId },
        filtering: { contentRetained: false, providerThreadCreated: false },
      };
      await tx
        .insert(chatDeliveries)
        .values({
          companyId: configuredEndpoint.companyId,
          endpointId: configuredEndpoint.id,
          providerEventId,
          deduplicationKey: createHash("sha256")
            .update(providerEventId)
            .digest("hex"),
          eventKind: "mention",
          normalizedEvent,
          state: "filtered",
          redactedError: reason,
          processedAt: filteredAt,
        })
        .onConflictDoUpdate({
          target: [chatDeliveries.endpointId, chatDeliveries.providerEventId],
          set: {
            normalizedEvent,
            principalId: null,
            state: "filtered",
            nextAttemptAt: null,
            redactedError: reason,
            processedAt: filteredAt,
            updatedAt: filteredAt,
          },
        });
      await tx
        .update(chatEndpoints)
        .set({ lastEventAt: filteredAt, updatedAt: filteredAt })
        .where(eq(chatEndpoints.id, configuredEndpoint.id));
      return false;
    });
    if (!allowed || !event.message || !context.endpointRuntime) return false;
    const thread = context.endpointRuntime.thread(event.threadId);
    await processMessage(
      configuredEndpoint,
      thread,
      event.message,
      "mention",
      true,
      null,
      context,
      undefined,
      null,
      true,
      undefined,
      true,
    );
    const staged = await db
      .select({ state: chatDeliveries.state })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, configuredEndpoint.id),
          eq(chatDeliveries.providerEventId, providerEventId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(
      staged && ["received", "retry", "processing"].includes(staged.state),
    );
  }

  async function processMessage(
    endpoint: EndpointRow,
    thread: Thread,
    message: Message,
    trigger: ChatSdkMessageCallbackEvent["trigger"],
    ingressOnly = false,
    recoveredProviderUrl: string | null = null,
    runtimeContext?: RuntimeContext,
    providerUpdateId?: number,
    admittedDeliveryId: string | null = null,
    receiptReactionSupported = true,
    preauthorizedUserId?: string | null,
    deferDrainUntilFollowup = false,
  ) {
    // The Telegram adapter currently emits edited_message through the normal
    // message callback with the original message id. Paperclip records that
    // verified payload through its supplemental message_updated lifecycle
    // ledger instead; letting it reach normal dedupe would falsely report the
    // edit as a duplicate provider delivery.
    if (
      endpoint.provider === "telegram" &&
      (isTelegramEditedMessageRaw(message.raw) ||
        isTelegramMigrationRaw(message.raw))
    )
      return;
    if (
      message.author.isMe ||
      message.author.isBot === true ||
      message.author.isSystem
    )
      return;
    // One provider message can match both a mention handler and the catch-all
    // new-message handler. The trigger is policy metadata, not provider event
    // identity, so it must not defeat durable deduplication.
    const providerEventId = `${thread.id}:${message.id}`;
    const surfaceKind = chatSurfaceKind(endpoint.provider, thread);
    // Teams' bot file APIs support native file transfer only in personal
    // chats. Channel and group-chat attachments are provider references that
    // require a separate Graph grant, which this endpoint deliberately does
    // not hold. Retain bounded metadata for audit, but never persist a
    // recovery locator or invoke the adapter download closure on those
    // surfaces.
    const nativeInboundAttachments =
      endpoint.provider === "microsoft-teams" && !thread.isDM
        ? []
        : message.attachments;
    const addressed =
      trigger === "mention" ||
      trigger === "direct_message" ||
      message.isMention === true;
    const eventKind: ChatEventKind =
      trigger === "direct_message"
        ? "direct_message"
        : trigger === "mention"
          ? "mention"
          : "message";
    // A callback remains tied to the runtime that authenticated and parsed it.
    // In particular, do not resolve the registry again here: pause or rotation
    // may already have removed that instance, and recreating a runtime before
    // the durable admission fence would either throw or bind old payload data
    // to new credentials.
    const endpointRuntime =
      runtimeContext?.endpointRuntime ?? (await runtimeFor(endpoint));
    const providerSentAt =
      message.metadata.dateSent instanceof Date &&
      Number.isFinite(message.metadata.dateSent.getTime())
        ? message.metadata.dateSent
        : null;
    const providerUrl =
      chatProviderConversationUrl({
        provider: endpoint.provider,
        providerAccountId: endpoint.providerAccountId,
        botUsername: endpoint.botUsername,
        threadId: thread.id,
        providerMessageId: message.id,
        raw: message.raw,
      }) ?? recoveredProviderUrl;
    const normalized = {
      providerEventId,
      kind: eventKind,
      trigger,
      acknowledgement: {
        // Some provider callbacks represent an auditable user command without
        // a provider message that can receive a reaction. Persist the
        // distinction so a crash/retry cannot mistake the synthetic ledger id
        // for a native message id.
        receiptReactionSupported,
      },
      principal: {
        externalId: stableExternalPrincipalId(
          endpoint.provider,
          message.author,
          message.raw,
        ),
        displayName: message.author.fullName,
        handle: message.author.userName,
      },
      resource: {
        type: providerResourceType(endpoint.provider, surfaceKind),
        providerResourceId: canonicalProviderResourceId(
          endpoint.provider,
          thread,
        ),
        label: thread.channel.name ?? thread.channelId,
      },
      conversation: {
        externalConversationId: thread.channelId,
        externalThreadId: thread.id,
        label: thread.channel.name ?? thread.channelId,
        isDirectMessage: thread.isDM,
        providerUrl,
      },
      message: {
        providerMessageId: message.id,
        providerMessageSequence:
          endpoint.provider === "telegram"
            ? telegramMessageSequence(message.raw)
            : null,
        providerUpdateId:
          endpoint.provider === "telegram" ? (providerUpdateId ?? null) : null,
        text: message.text.slice(0, MAX_INBOUND_TEXT),
        mentionedBot: message.isMention === true,
        providerSentAt: providerSentAt?.toISOString() ?? null,
        attachments: message.attachments.slice(0, 20).map((attachment) => ({
          name: sanitizeFilename(attachment.name),
          mimeType: normalizeContentType(attachment.mimeType),
          size: attachment.size ?? null,
          recovery: nativeInboundAttachments.includes(attachment)
            ? endpointRuntime.attachmentRecoveryDescriptor(attachment)
            : null,
        })),
      },
    };
    // Teams RSC can deliver messages from every installed channel, and a
    // Telegram bot can receive addressed traffic from a provider-available
    // group that the operator has not enabled in Paperclip. Until the reach
    // gate admits that destination, retain only identifiers required for
    // deduplication and operator-visible filtering—not user text, attachment
    // metadata, or an external principal profile.
    const redactedDestinationNormalized = {
      providerEventId,
      kind: eventKind,
      trigger,
      resource: {
        type: providerResourceType(endpoint.provider, surfaceKind),
        providerResourceId: canonicalProviderResourceId(
          endpoint.provider,
          thread,
        ),
      },
      conversation: { externalThreadId: thread.id },
      message: {
        providerMessageId: message.id,
        providerSentAt: providerSentAt?.toISOString() ?? null,
      },
      filtering: { contentRetained: false },
    };
    const reorderWindow = INGRESS_REORDER_WINDOW_MS[endpoint.provider];
    const scheduledAt =
      ingressOnly && reorderWindow
        ? (scheduledConversationDrains.get(
            conversationDrainKey(endpoint.id, thread.id),
          ) ?? Date.now() + reorderWindow)
        : null;
    const admission = await db.transaction(async (tx) => {
      const currentEndpoint = await tx
        .select({
          status: chatEndpoints.status,
          setup: chatEndpoints.setup,
          allowDirectMessages: chatEndpoints.allowDirectMessages,
          allowGroupChats: chatEndpoints.allowGroupChats,
        })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpoint.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!currentEndpoint) return null;
      // An SDK callback can finish parsing after a pause/resume cycle. Each
      // runtime captures the durable endpoint generation at registration;
      // resume advances it under the same row lock used by admission. This
      // rejects stale callbacks without relying on provider/server clock sync.
      const currentRuntimeGeneration = runtimeGeneration(currentEndpoint.setup);
      const currentCredentialFingerprint = runtimeContext
        ? await tx
            .select({ refs: toolConnections.credentialSecretRefs })
            .from(toolConnections)
            .where(
              and(
                eq(toolConnections.companyId, endpoint.companyId),
                eq(toolConnections.id, endpoint.connectionId),
              ),
            )
            .then((rows) => credentialFingerprint(rows[0]?.refs ?? []))
        : null;
      const staleActivation =
        runtimeContext !== undefined &&
        (runtimeContext.generation !== currentRuntimeGeneration ||
          runtimeContext.credentialFingerprint !==
            currentCredentialFingerprint);
      const endpointAccepting =
        ["verifying", "active"].includes(currentEndpoint.status) &&
        !staleActivation;
      let provisionalTeamsSetupReply = false;
      let destinationAccepting = true;
      if (endpointAccepting && thread.isDM) {
        destinationAccepting = currentEndpoint.allowDirectMessages;
      }
      if (
        endpointAccepting &&
        endpoint.provider === "microsoft-teams" &&
        !thread.isDM
      ) {
        let resource = await ensureResource(endpoint, thread, false, tx);
        const enabledChannelCount = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.endpointId, endpoint.id),
              eq(chatEndpointResources.enabled, true),
              eq(chatEndpointResources.availability, "available"),
              eq(chatEndpointResources.type, "channel"),
            ),
          )
          .then((rows) => rows[0]?.count ?? 0);
        const canActivateFirstSetupChannel =
          currentEndpoint.status === "verifying" &&
          resource.type === "channel" &&
          resource.availability === "available" &&
          enabledChannelCount === 0 &&
          addressed;
        if (canActivateFirstSetupChannel && !resource.enabled) {
          resource = await tx
            .update(chatEndpointResources)
            .set({ enabled: true, updatedAt: new Date() })
            .where(eq(chatEndpointResources.id, resource.id))
            .returning()
            .then((rows) => rows[0] ?? resource);
        }
        const teamsRootMessageId = teamsThreadRootMessageId(thread.id);
        provisionalTeamsSetupReply =
          currentEndpoint.status === "verifying" &&
          resource.type === "channel" &&
          resource.availability === "available" &&
          enabledChannelCount === 0 &&
          !addressed &&
          Boolean(teamsRootMessageId) &&
          teamsRootMessageId !== message.id;
        destinationAccepting =
          nonDirectDestinationAllowed(
            { ...endpoint, allowGroupChats: currentEndpoint.allowGroupChats },
            resource,
          ) || provisionalTeamsSetupReply;
      }
      if (
        endpointAccepting &&
        endpoint.provider === "telegram" &&
        !thread.isDM
      ) {
        let resource = await ensureResource(endpoint, thread, false, tx);
        const enabledResourceCount = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.endpointId, endpoint.id),
              eq(chatEndpointResources.enabled, true),
              eq(chatEndpointResources.availability, "available"),
              ne(chatEndpointResources.type, "direct_message"),
              ne(chatEndpointResources.type, "group_chat"),
            ),
          )
          .then((rows) => rows[0]?.count ?? 0);
        const canActivateFirstSetupGroup =
          currentEndpoint.status === "verifying" &&
          resource.availability === "available" &&
          enabledResourceCount === 0 &&
          addressed;
        if (canActivateFirstSetupGroup && !resource.enabled) {
          resource = await tx
            .update(chatEndpointResources)
            .set({ enabled: true, updatedAt: new Date() })
            .where(eq(chatEndpointResources.id, resource.id))
            .returning()
            .then((rows) => rows[0] ?? resource);
        }
        // Telegram's privacy-mode contract is explicit: in a group or forum
        // topic, every admitted turn must address the bot. A direct reply to a
        // bot message is normalized as a mention by the pinned adapter, while
        // unrelated subscribed traffic remains unaddressed and is filtered.
        destinationAccepting =
          addressed &&
          nonDirectDestinationAllowed(
            { ...endpoint, allowGroupChats: currentEndpoint.allowGroupChats },
            resource,
          );
      }
      const accepting = endpointAccepting && destinationAccepting;
      const redactDestinationDelivery =
        (!accepting && thread.isDM) ||
        (!thread.isDM &&
          (endpoint.provider === "microsoft-teams" ||
            endpoint.provider === "telegram") &&
          (!accepting || provisionalTeamsSetupReply));
      const ignoredAt = accepting ? null : new Date();
      const inactiveReason = !endpointAccepting
        ? staleActivation
          ? "Connection activation changed before admission"
          : "Connection is not active"
        : endpoint.provider === "telegram" && !thread.isDM && !addressed
          ? "Message did not address the agent"
          : "Destination is not enabled in Paperclip";
      let candidate = admittedDeliveryId
        ? await tx
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.id, admittedDeliveryId),
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(chatDeliveries.providerEventId, providerEventId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      if (!admittedDeliveryId) {
        const [delivery] = await tx
          .insert(chatDeliveries)
          .values({
            companyId: endpoint.companyId,
            endpointId: endpoint.id,
            providerEventId,
            deduplicationKey: createHash("sha256")
              .update(providerEventId)
              .digest("hex"),
            eventKind,
            normalizedEvent: redactDestinationDelivery
              ? redactedDestinationNormalized
              : deferDrainUntilFollowup && accepting
                ? { ...normalized, providerThreadPending: true }
                : normalized,
            state: accepting
              ? deferDrainUntilFollowup
                ? "retry"
                : "received"
              : "filtered",
            nextAttemptAt:
              accepting && deferDrainUntilFollowup
                ? new Date(
                    Date.now() + DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS,
                  )
                : accepting && scheduledAt
                  ? new Date(scheduledAt)
                  : null,
            redactedError:
              accepting && deferDrainUntilFollowup
                ? "Waiting for Discord thread creation confirmation"
                : accepting
                  ? null
                  : inactiveReason,
            processedAt: ignoredAt,
          })
          .onConflictDoNothing()
          .returning();
        candidate = delivery ?? null;
      }
      if (!candidate && !admittedDeliveryId) {
        const existingDelivery = await tx
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.providerEventId, providerEventId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (existingDelivery) {
          const hydrateTeamsDelivery =
            endpoint.provider === "microsoft-teams" &&
            !thread.isDM &&
            accepting &&
            !provisionalTeamsSetupReply &&
            ["received", "retry", "processing"].includes(
              existingDelivery.state,
            ) &&
            deliveryContentWasRedacted(existingDelivery.normalizedEvent);
          [candidate] = await tx
            .update(chatDeliveries)
            .set({
              // Increment under PostgreSQL's row lock so simultaneous handler
              // fanout and provider retries cannot lose duplicate telemetry.
              normalizedEvent: redactDestinationDelivery
                ? sql`${JSON.stringify(redactedDestinationNormalized)}::jsonb
                    || jsonb_build_object(
                      'deduplication',
                      jsonb_build_object(
                        'duplicateCount',
                        coalesce((${chatDeliveries.normalizedEvent}#>>'{deduplication,duplicateCount}')::integer, 0) + 1,
                        'lastDuplicateAt',
                        ${new Date().toISOString()}::text
                      )
                    )`
                : hydrateTeamsDelivery
                  ? sql`${JSON.stringify(normalized)}::jsonb
                    || jsonb_build_object(
                      'deduplication',
                      coalesce(${chatDeliveries.normalizedEvent}->'deduplication', '{}'::jsonb)
                        || jsonb_build_object(
                          'duplicateCount',
                          coalesce((${chatDeliveries.normalizedEvent}#>>'{deduplication,duplicateCount}')::integer, 0) + 1,
                          'lastDuplicateAt',
                          ${new Date().toISOString()}::text
                        )
                    )`
                  : sql`coalesce(${chatDeliveries.normalizedEvent}, '{}'::jsonb)
                    || jsonb_build_object(
                      'deduplication',
                      coalesce(${chatDeliveries.normalizedEvent}->'deduplication', '{}'::jsonb)
                        || jsonb_build_object(
                          'duplicateCount',
                          coalesce((${chatDeliveries.normalizedEvent}#>>'{deduplication,duplicateCount}')::integer, 0) + 1,
                          'lastDuplicateAt',
                          ${new Date().toISOString()}::text
                        )
                    )`,
              ...(!accepting &&
              ["received", "retry"].includes(existingDelivery.state)
                ? {
                    state: "filtered" as const,
                    nextAttemptAt: null,
                    redactedError: inactiveReason,
                    processedAt: ignoredAt,
                  }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(chatDeliveries.id, existingDelivery.id))
            .returning();
        }
      }
      if (
        candidate &&
        admittedDeliveryId &&
        accepting &&
        !provisionalTeamsSetupReply &&
        endpoint.provider === "microsoft-teams" &&
        !thread.isDM &&
        ["received", "retry", "processing"].includes(candidate.state) &&
        deliveryContentWasRedacted(candidate.normalizedEvent)
      ) {
        [candidate] = await tx
          .update(chatDeliveries)
          .set({ normalizedEvent: normalized, updatedAt: new Date() })
          .where(eq(chatDeliveries.id, candidate.id))
          .returning();
      }
      if (
        candidate &&
        admittedDeliveryId &&
        !accepting &&
        ["received", "retry"].includes(candidate.state)
      ) {
        [candidate] = await tx
          .update(chatDeliveries)
          .set({
            state: "filtered",
            ...(redactDestinationDelivery
              ? {
                  normalizedEvent: redactedDestinationNormalized,
                  principalId: null,
                }
              : {}),
            nextAttemptAt: null,
            redactedError: inactiveReason,
            processedAt: ignoredAt,
            updatedAt: new Date(),
          })
          .where(eq(chatDeliveries.id, candidate.id))
          .returning();
      }
      if (!accepting && ignoredAt) {
        await tx
          .update(chatEndpoints)
          .set({ lastEventAt: ignoredAt, updatedAt: ignoredAt })
          .where(eq(chatEndpoints.id, endpoint.id));
      }
      return {
        accepting,
        candidate: candidate ?? null,
        provisionalTeamsSetupReply,
      };
    });
    let candidate = admission?.candidate ?? null;
    if (!admission || !candidate) return;
    if (!admission.accepting) {
      liveInboundMessages.delete(candidate.id);
      return;
    }
    if (["processed", "filtered", "failed"].includes(candidate.state)) return;
    if (
      !deferDrainUntilFollowup &&
      endpoint.provider === "discord" &&
      discordRootThreadPending(candidate)
    ) {
      // The adapter invokes the ordinary message callback only after Discord
      // has returned the created thread. Promote the pre-admission receipt
      // atomically so the normal ordered drain can begin immediately.
      const [promoted] = await db
        .update(chatDeliveries)
        .set({
          state: "received",
          normalizedEvent: sql`${chatDeliveries.normalizedEvent} - 'providerThreadPending'`,
          nextAttemptAt: scheduledAt ? new Date(scheduledAt) : null,
          redactedError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatDeliveries.id, candidate.id),
            eq(chatDeliveries.state, "retry"),
            sql`${chatDeliveries.normalizedEvent}->>'providerThreadPending' = 'true'`,
          ),
        )
        .returning();
      if (promoted) candidate = promoted;
    }
    const now = new Date();
    if (
      !deferDrainUntilFollowup &&
      candidate.state === "retry" &&
      candidate.nextAttemptAt &&
      candidate.nextAttemptAt > now
    )
      return;
    const staleBefore = new Date(now.getTime() - DELIVERY_PROCESSING_STALE_MS);
    if (candidate.state === "processing" && candidate.updatedAt > staleBefore)
      return;
    if (ingressOnly) {
      // The verified provider request owns only the durable ingress write.
      // Task mutation, attachment download, wakeup, and provider-visible
      // acknowledgement continue under a durable conversation lease after the
      // HTTP response. Keeping the original SDK objects process-locally lets
      // the first attempt retain attachment download handles; another process
      // can still reconstruct the delivery solely from the durable ledger.
      liveInboundMessages.set(candidate.id, {
        endpoint,
        thread,
        message,
        trigger,
        receiptReactionSupported,
      });
      if (!deferDrainUntilFollowup) {
        scheduleConversationDrain(
          endpoint.id,
          thread.id,
          scheduledAt ?? Date.now(),
        );
      }
      return;
    }
    const claimConditions = [
      eq(chatDeliveries.id, candidate.id),
      eq(chatDeliveries.state, candidate.state),
    ];
    if (candidate.state === "processing")
      claimConditions.push(lte(chatDeliveries.updatedAt, staleBefore));
    const claimed = await db
      .update(chatDeliveries)
      .set({
        state: "processing",
        attempts: candidate.attempts + 1,
        nextAttemptAt: null,
        redactedError: null,
        updatedAt: now,
      })
      .where(and(...claimConditions))
      .returning();
    const activeDelivery = claimed[0];
    if (!activeDelivery) return;

    try {
      if (admission.provisionalTeamsSetupReply) {
        const resolutionAt = new Date();
        const waitForSetupRoot =
          activeDelivery.attempts <= ORPHAN_FOLLOW_UP_MAX_ATTEMPTS;
        await db
          .update(chatDeliveries)
          .set(
            waitForSetupRoot
              ? {
                  state: "retry",
                  nextAttemptAt: new Date(
                    resolutionAt.getTime() + ORPHAN_FOLLOW_UP_GRACE_MS,
                  ),
                  redactedError: "Waiting briefly for an earlier root mention",
                  updatedAt: resolutionAt,
                }
              : {
                  state: "filtered",
                  normalizedEvent: redactedDestinationNormalized,
                  principalId: null,
                  nextAttemptAt: null,
                  processedAt: resolutionAt,
                  redactedError: "Destination is not enabled in Paperclip",
                  updatedAt: resolutionAt,
                },
          )
          .where(eq(chatDeliveries.id, activeDelivery.id));
        return;
      }
      // A committed inbound message link proves that a prior attempt completed
      // its task mutation even if it crashed before returning to the provider.
      const existingMessageLink = await db
        .select({
          id: chatMessageLinks.id,
          conversationId: chatMessageLinks.conversationId,
          commentId: chatMessageLinks.commentId,
        })
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.endpointId, endpoint.id),
            eq(chatMessageLinks.deliveryId, activeDelivery.id),
            eq(chatMessageLinks.direction, "inbound"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existingMessageLink) {
        const inboundCommentId = existingMessageLink.commentId;
        if (!inboundCommentId) {
          throw new Error("Inbound message link is missing its task comment");
        }
        const rebound = await db
          .select({
            issueId: chatConversations.issueId,
            assigneeAgentId: issues.assigneeAgentId,
            issueStatus: issues.status,
            issueIdentifier: issues.identifier,
            authorUserId: issueComments.authorUserId,
          })
          .from(chatConversations)
          .innerJoin(
            issues,
            and(
              eq(issues.companyId, chatConversations.companyId),
              eq(issues.id, chatConversations.issueId),
            ),
          )
          .leftJoin(issueComments, eq(issueComments.id, inboundCommentId))
          .where(
            and(
              eq(chatConversations.id, existingMessageLink.conversationId),
              eq(chatConversations.endpointId, endpoint.id),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!rebound) throw notFound("Bound task not found");
        // Attachment storage follows the atomic task/comment/link mutation.
        // If a later wakeup or provider subscription failed, retry from the
        // committed delivery link and fill in only files that are still
        // missing from this exact inbound comment.
        const attachmentResult = await ingestAttachments({
          endpoint,
          issueId: rebound.issueId,
          issueCommentId: inboundCommentId,
          attachments: nativeInboundAttachments,
          actorUserId: rebound.authorUserId,
        });
        await queueIssueAssignmentWakeup({
          heartbeat: options.heartbeat,
          issue: {
            id: rebound.issueId,
            assigneeAgentId: rebound.assigneeAgentId,
            status: rebound.issueStatus,
          },
          reason: "External chat message received",
          mutation: "chat_message_received",
          contextSource: `chat:${endpoint.provider}:recovery`,
          requestedByActorType: rebound.authorUserId ? "user" : "system",
          requestedByActorId:
            rebound.authorUserId ?? activeDelivery.principalId,
          taskKey: rebound.issueIdentifier,
          wakeCommentId: inboundCommentId,
          rethrowOnError: true,
        });
        // Subscription is part of the durable acceptance boundary. If it
        // fails, keep the delivery retryable; the committed message link makes
        // the retry resume here without duplicating the task or comment.
        if (addressed && !thread.isDM) await thread.subscribe();
        await db
          .update(chatDeliveries)
          .set({
            conversationId: existingMessageLink.conversationId,
            state: "processed",
            processedAt: new Date(),
            redactedError: attachmentOmissionDetail(attachmentResult),
            updatedAt: new Date(),
          })
          .where(eq(chatDeliveries.id, activeDelivery.id));
        return;
      }

      const principalResolution = await ensurePrincipal(
        endpoint,
        message.author,
        message.raw,
      );
      const mayEnableSetupDestination =
        !thread.isDM &&
        endpoint.status === "verifying" &&
        addressed &&
        !(
          endpoint.provider === "microsoft-teams" &&
          surfaceKind === "linear_group"
        );
      const resourceAdmission = mayEnableSetupDestination
        ? await db.transaction(async (tx) => {
            const currentEndpoint = await tx
              .select({ status: chatEndpoints.status })
              .from(chatEndpoints)
              .where(eq(chatEndpoints.id, endpoint.id))
              .for("update")
              .then((rows) => rows[0] ?? null);
            if (!currentEndpoint) throw notFound("Chat endpoint not found");
            const enabledResourceCount = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(chatEndpointResources)
              .where(
                and(
                  eq(chatEndpointResources.endpointId, endpoint.id),
                  eq(chatEndpointResources.enabled, true),
                  eq(chatEndpointResources.availability, "available"),
                  ne(chatEndpointResources.type, "direct_message"),
                  ne(chatEndpointResources.type, "group_chat"),
                ),
              )
              .then((rows) => rows[0]?.count ?? 0);
            const enableSetupDestination =
              currentEndpoint.status === "verifying" &&
              enabledResourceCount === 0;
            let resource = await ensureResource(
              endpoint,
              thread,
              enableSetupDestination,
              tx,
            );
            if (enableSetupDestination && !resource.enabled) {
              resource = await tx
                .update(chatEndpointResources)
                .set({ enabled: true, updatedAt: new Date() })
                .where(eq(chatEndpointResources.id, resource.id))
                .returning()
                .then((rows) => rows[0] ?? resource);
            }
            return { enabledResourceCount, resource };
          })
        : {
            enabledResourceCount: await db
              .select({ count: sql<number>`count(*)::int` })
              .from(chatEndpointResources)
              .where(
                and(
                  eq(chatEndpointResources.endpointId, endpoint.id),
                  eq(chatEndpointResources.enabled, true),
                  eq(chatEndpointResources.availability, "available"),
                  ne(chatEndpointResources.type, "direct_message"),
                  ne(chatEndpointResources.type, "group_chat"),
                ),
              )
              .then((rows) => rows[0]?.count ?? 0),
            resource: await ensureResource(endpoint, thread, false),
          };
      const { enabledResourceCount, resource } = resourceAdmission;
      await db
        .update(chatDeliveries)
        .set({
          principalId: principalResolution.principal.id,
          updatedAt: new Date(),
        })
        .where(eq(chatDeliveries.id, activeDelivery.id));

      const latestConversation = await db
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.endpointId, endpoint.id),
            eq(chatConversations.externalConversationId, thread.channelId),
            eq(chatConversations.externalThreadId, thread.id),
          ),
        )
        .orderBy(desc(chatConversations.sessionGeneration))
        .then((rows) => rows[0] ?? null);
      const isLinear = surfaceKind !== "native_thread";
      let existingConversation: ConversationRow | null = latestConversation;
      let existingIssue: typeof issues.$inferSelect | null =
        existingConversation
          ? await db
              .select()
              .from(issues)
              .where(
                and(
                  eq(issues.companyId, endpoint.companyId),
                  eq(issues.id, existingConversation.issueId),
                ),
              )
              .then((rows) => rows[0] ?? null)
          : null;
      if (
        isLinear &&
        existingConversation &&
        (existingConversation.state === "completed" ||
          existingIssue?.status === "done" ||
          existingIssue?.status === "cancelled")
      ) {
        if (existingConversation.state !== "completed") {
          await db
            .update(chatConversations)
            .set({ state: "completed", updatedAt: new Date() })
            .where(eq(chatConversations.id, existingConversation.id));
        }
        existingConversation = null;
        existingIssue = null;
      }
      // Telegram exposes its small command vocabulary in forum topics too.
      // A forum topic is a native provider thread and therefore stays bound to
      // one immutable Paperclip task, but the command must still be consumed
      // as control-plane input instead of becoming a task comment/wakeup.
      const controlCommand =
        isLinear || endpoint.provider === "telegram"
          ? linearControlCommand(message.text)
          : null;
      const guidanceCommand =
        endpoint.provider === "telegram"
          ? telegramGuidanceCommand(message.text)
          : null;
      const endpointAllowed =
        endpoint.status === "verifying" || endpoint.status === "active";
      const destinationAllowed = thread.isDM
        ? endpoint.allowDirectMessages
        : nonDirectDestinationAllowed(endpoint, resource);
      const preauthorized = preauthorizedUserId !== undefined;
      const guestSponsorAllowed =
        !preauthorized &&
        principalResolution.userId === null &&
        !principalResolution.linkedDenied &&
        endpoint.allowUnlinkedPeople
          ? await sponsorAllowsGuest(endpoint)
          : false;
      const principalAllowed =
        preauthorized ||
        (!principalResolution.linkedDenied &&
          (principalResolution.userId !== null || guestSponsorAllowed));
      const activationAllowed = addressed || existingConversation !== null;
      const allowed =
        preauthorized ||
        (endpointAllowed &&
          destinationAllowed &&
          principalAllowed &&
          activationAllowed);
      const slackRootMessageId =
        endpoint.provider === "slack"
          ? /^slack:[^:]+:(.+)$/.exec(thread.id)?.[1]
          : null;
      const teamsRootMessageId =
        endpoint.provider === "microsoft-teams"
          ? teamsThreadRootMessageId(thread.id)
          : null;
      const isPlausibleOrphanFollowUp =
        endpoint.provider === "github" ||
        endpoint.provider === "discord" ||
        (endpoint.provider === "slack" &&
          Boolean(slackRootMessageId) &&
          slackRootMessageId !== message.id) ||
        (endpoint.provider === "microsoft-teams" &&
          Boolean(teamsRootMessageId) &&
          teamsRootMessageId !== message.id);
      const setupDestinationCanBeEnabledByEarlierMention =
        (endpoint.provider === "github" ||
          endpoint.provider === "discord" ||
          (endpoint.provider === "microsoft-teams" &&
            resource?.type === "channel")) &&
        !thread.isDM &&
        endpoint.status === "verifying" &&
        enabledResourceCount === 0 &&
        resource.availability === "available";
      if (
        !allowed &&
        isPlausibleOrphanFollowUp &&
        !addressed &&
        existingConversation === null &&
        activeDelivery.attempts <= ORPHAN_FOLLOW_UP_MAX_ATTEMPTS &&
        endpointAllowed &&
        principalAllowed &&
        (destinationAllowed || setupDestinationCanBeEnabledByEarlierMention)
      ) {
        // GitHub, Slack, and Teams can deliver a thread reply before the older
        // root callback that creates its Paperclip task. Keep this exact
        // delivery for a bounded minute, without admitting or waking it, so
        // the durable thread drain can sort again if a delayed root arrives.
        // A standalone unaddressed message is filtered after the bounded
        // retention window.
        await db
          .update(chatDeliveries)
          .set({
            state: "retry",
            nextAttemptAt: new Date(Date.now() + ORPHAN_FOLLOW_UP_GRACE_MS),
            redactedError: "Waiting briefly for an earlier root mention",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatDeliveries.id, activeDelivery.id),
              eq(chatDeliveries.state, "processing"),
            ),
          );
        return;
      }
      if (!allowed) {
        const filteredReason = !endpointAllowed
          ? "Connection is not active"
          : !destinationAllowed
            ? "Destination is not enabled in Paperclip"
            : principalResolution.linkedDenied
              ? "Linked Paperclip account is not currently permitted"
              : !principalAllowed
                ? endpoint.allowUnlinkedPeople
                  ? "Endpoint sponsor can no longer authorize external guests"
                  : "External identity must be linked to a Paperclip account"
                : "Message did not address the agent or an active task thread";
        await db
          .update(chatDeliveries)
          .set({
            state: "filtered",
            redactedError: filteredReason,
            processedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(chatDeliveries.id, activeDelivery.id));
        return;
      }

      const emptySlackMention =
        endpoint.provider === "slack" &&
        (trigger === "mention" || message.isMention === true) &&
        message.attachments.length === 0 &&
        !hasMeaningfulSlackMentionRequest(message.text);
      if (emptySlackMention) {
        const effectContext =
          runtimeContext ??
          runtimeContextForRecord(
            (await endpointRecord(endpoint.id)) ??
              (() => {
                throw new Error("Chat endpoint is unavailable");
              })(),
          );
        const effect = await db.transaction((tx) =>
          stageProviderEffect(tx, {
            endpoint,
            deliveryId: activeDelivery.id,
            principalId: principalResolution.principal.id,
            providerActionId: `provider_effect:delivery:${activeDelivery.id}`,
            payload: {
              version: 1,
              effect: "thread_message",
              threadId: thread.id,
              text: "Please include a request after mentioning me.",
              settleDelivery: true,
              resourceId: resource.id,
            },
            runtimeContext: effectContext,
          }),
        );
        if (!effect) throw new Error("Provider effect was not persisted");
        if ((await processProviderEffect(effect.id, thread)) !== "processed")
          return;
        if (receiptReactionSupported) {
          await addReceiptReaction({
            deliveryId: activeDelivery.id,
            endpoint,
            message,
            thread,
          });
        }
        return;
      }

      if (guidanceCommand) {
        const assignedAgentName =
          guidanceCommand === "start"
            ? await db
                .select({ name: agents.name })
                .from(agents)
                .where(
                  and(
                    eq(agents.companyId, endpoint.companyId),
                    eq(agents.id, endpoint.assignedAgentId),
                  ),
                )
                .then((rows) => rows[0]?.name ?? "this agent")
            : null;
        const responseText =
          guidanceCommand === "start"
            ? `Send a direct message to start work with ${assignedAgentName}. In a group, use /task@${endpoint.botUsername ?? "your_bot"} followed by your request. Use /status, /new, or /close to manage the active task in this chat.`
            : guidanceCommand === "task"
              ? `Please include a request after /task@${endpoint.botUsername ?? "your_bot"}.`
              : `Available commands: /task@${endpoint.botUsername ?? "your_bot"} followed by your request, /status, /new, and /close.`;
        const publicationBinding =
          existingConversation && existingIssue
            ? { conversation: existingConversation, issue: existingIssue }
            : null;
        let effect: typeof chatActions.$inferSelect | null = null;
        if (publicationBinding) {
          await db.transaction(async (tx) => {
            await tx
              .update(chatEndpoints)
              .set({ lastEventAt: new Date(), updatedAt: new Date() })
              .where(eq(chatEndpoints.id, endpoint.id));
            await tx
              .update(chatDeliveries)
              .set({
                conversationId: publicationBinding.conversation.id,
                state: "processed",
                processedAt: new Date(),
                redactedError: null,
                updatedAt: new Date(),
              })
              .where(eq(chatDeliveries.id, activeDelivery.id));
            await stageAuthorizedTaskControlPublication(tx, {
              companyId: endpoint.companyId,
              endpointId: endpoint.id,
              conversationId: publicationBinding.conversation.id,
              issueId: publicationBinding.issue.id,
              idempotencyKey: `control:guidance:${activeDelivery.id}`,
              payload: projectSafeChatPublication({
                classification: "external",
                source: "task_control",
                text: responseText,
              }),
              principalId: principalResolution.principal.id,
            });
          });
        } else {
          const effectContext =
            runtimeContext ??
            runtimeContextForRecord(
              (await endpointRecord(endpoint.id)) ??
                (() => {
                  throw new Error("Chat endpoint is unavailable");
                })(),
            );
          effect = await db.transaction((tx) =>
            stageProviderEffect(tx, {
              endpoint,
              deliveryId: activeDelivery.id,
              principalId: principalResolution.principal.id,
              providerActionId: `provider_effect:delivery:${activeDelivery.id}`,
              payload: {
                version: 1,
                effect: "thread_message",
                threadId: thread.id,
                text: responseText,
                settleDelivery: true,
                resourceId: resource.id,
              },
              runtimeContext: effectContext,
            }),
          );
          if (!effect) throw new Error("Provider effect was not persisted");
          if ((await processProviderEffect(effect.id, thread)) !== "processed")
            return;
        }
        await Promise.allSettled([
          receiptReactionSupported
            ? addReceiptReaction({
                deliveryId: activeDelivery.id,
                endpoint,
                message,
                thread,
              })
            : Promise.resolve(),
          addressed && !thread.isDM ? thread.subscribe() : Promise.resolve(),
        ]);
        return;
      }

      if (controlCommand) {
        const isTelegramForumTopic =
          endpoint.provider === "telegram" && surfaceKind === "native_thread";
        const taskLabel = existingIssue
          ? `${existingIssue.identifier}: ${existingIssue.title}`
          : "No task is active in this conversation.";
        const responseText =
          controlCommand === "status"
            ? existingIssue
              ? `${taskLabel} — ${existingIssue.status}`
              : taskLabel
            : controlCommand === "new"
              ? isTelegramForumTopic
                ? existingIssue
                  ? `${taskLabel} stays bound to this forum topic. Open a new Telegram forum topic to start a new Paperclip task.`
                  : "Open a new Telegram forum topic to start a new Paperclip task."
                : "Send your request to start a new Paperclip task."
              : existingConversation
                ? isTelegramForumTopic
                  ? "This forum topic is closed. A later message here will continue the same Paperclip task."
                  : "This task is closed. Send another message to start a new task."
                : "No task is active. Send a message to start one.";
        const publicationBinding =
          existingConversation && existingIssue
            ? { conversation: existingConversation, issue: existingIssue }
            : null;
        if (publicationBinding) {
          const publicationControl =
            controlCommand === "new" && isTelegramForumTopic
              ? "new_guidance"
              : controlCommand;
          await db.transaction(async (tx) => {
            await tx
              .update(chatEndpoints)
              .set({ lastEventAt: new Date(), updatedAt: new Date() })
              .where(eq(chatEndpoints.id, endpoint.id));
            await tx
              .update(chatDeliveries)
              .set({
                conversationId: publicationBinding.conversation.id,
                state: "processed",
                processedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(chatDeliveries.id, activeDelivery.id));
            await stageAuthorizedTaskControlPublication(tx, {
              companyId: endpoint.companyId,
              endpointId: endpoint.id,
              conversationId: publicationBinding.conversation.id,
              issueId: publicationBinding.issue.id,
              idempotencyKey: `control:${publicationControl}:${activeDelivery.id}`,
              payload: projectSafeChatPublication({
                classification: "external",
                source: "task_control",
                text: responseText,
              }),
              principalId: principalResolution.principal.id,
            });
          });
        } else {
          const effectContext =
            runtimeContext ??
            runtimeContextForRecord(
              (await endpointRecord(endpoint.id)) ??
                (() => {
                  throw new Error("Chat endpoint is unavailable");
                })(),
            );
          const effect = await db.transaction(async (tx) => {
            return stageProviderEffect(tx, {
              endpoint,
              deliveryId: activeDelivery.id,
              principalId: principalResolution.principal.id,
              providerActionId: `provider_effect:delivery:${activeDelivery.id}`,
              payload: {
                version: 1,
                effect: "thread_message",
                threadId: thread.id,
                text: responseText,
                settleDelivery: true,
                resourceId: resource.id,
              },
              runtimeContext: effectContext,
            });
          });
          if (!effect) throw new Error("Provider effect was not persisted");
          if ((await processProviderEffect(effect.id, thread)) !== "processed")
            return;
        }
        await Promise.allSettled([
          receiptReactionSupported
            ? addReceiptReaction({
                deliveryId: activeDelivery.id,
                endpoint,
                message,
                thread,
              })
            : Promise.resolve(),
          addressed && !thread.isDM ? thread.subscribe() : Promise.resolve(),
        ]);
        return;
      }

      const persistTaskMutation = async (
        taskTx: DbOrTransaction,
        taskEndpoint: EndpointRow,
        taskUserId: string | null,
      ) => {
        let conversation = existingConversation;
        if (!conversation) {
          const sessionGeneration = isLinear
            ? (latestConversation?.sessionGeneration ?? 0) + 1
            : 1;
          const issue = await issuesSvc.create(
            endpoint.companyId,
            {
              title: safeTitle(
                message.text,
                `${PROVIDER_LABELS[endpoint.provider]} conversation`,
              ),
              description: `Started from ${PROVIDER_LABELS[endpoint.provider]}: ${resource.label}`,
              status: "todo",
              priority: "medium",
              assigneeAgentId: endpoint.assignedAgentId,
              createdByUserId: taskUserId ?? endpoint.sponsorUserId,
              responsibleUserId: taskUserId ?? endpoint.sponsorUserId,
              originKind: "chat_channel",
              originId: `${endpoint.id}:${thread.id}:${sessionGeneration}`,
              idempotencyKey: `chat:${endpoint.id}:${thread.id}:${sessionGeneration}`,
            },
            taskTx,
          );
          if (!taskUserId) {
            const reviewPreset = {
              id: LOW_TRUST_REVIEW_PRESET,
              version: LOW_TRUST_REVIEW_PRESET_VERSION,
              rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
            } as const;
            await taskTx
              .update(issues)
              .set({
                sourceTrust: {
                  preset: LOW_TRUST_REVIEW_PRESET,
                  disposition: "quarantined",
                  sourceIssueId: issue.id,
                },
                executionPolicy: {
                  mode: "normal",
                  commentRequired: true,
                  stages: [],
                  reviewPreset,
                  authorizationPolicy: {
                    trustPreset: LOW_TRUST_REVIEW_PRESET,
                    reviewPreset,
                    trustBoundary: {
                      mode: LOW_TRUST_REVIEW_PRESET,
                      companyId: endpoint.companyId,
                      rootIssueId: issue.id,
                      issueIds: [issue.id],
                      allowedAgentIds: [endpoint.assignedAgentId],
                      allowedToolClasses: [
                        "git.read",
                        "github.pr.read",
                        "tests.local",
                      ],
                    },
                  },
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(issues.id, issue.id),
                  eq(issues.companyId, endpoint.companyId),
                ),
              );
          }
          await taskTx
            .insert(chatConversations)
            .values({
              companyId: endpoint.companyId,
              endpointId: endpoint.id,
              resourceId: resource.id,
              issueId: issue.id,
              externalConversationId: thread.channelId,
              externalThreadId: thread.id,
              sessionGeneration,
              externalLabel: resource.label,
              providerUrl,
              isDirectMessage: thread.isDM,
              state: "active",
              lastActivityAt: new Date(),
            })
            .onConflictDoNothing();
          conversation = await taskTx
            .select()
            .from(chatConversations)
            .where(
              and(
                eq(chatConversations.endpointId, endpoint.id),
                eq(chatConversations.externalConversationId, thread.channelId),
                eq(chatConversations.externalThreadId, thread.id),
                eq(chatConversations.sessionGeneration, sessionGeneration),
              ),
            )
            .then((rows) => rows[0] ?? null);
        }
        if (!conversation)
          throw conflict(
            "Could not bind external conversation to a Paperclip task",
          );

        const issue =
          existingIssue?.id === conversation.issueId
            ? existingIssue
            : await taskTx
                .select()
                .from(issues)
                .where(eq(issues.id, conversation.issueId))
                .then((rows) => rows[0] ?? null);
        if (!issue) throw notFound("Bound task not found");
        if (issue.status === "done" || issue.status === "cancelled") {
          await issuesSvc.update(
            issue.id,
            {
              status: "todo",
              actorUserId: taskUserId ?? taskEndpoint.sponsorUserId,
            },
            taskTx,
          );
        }
        const body =
          message.text.trim() ||
          (message.attachments.length > 0
            ? taskEndpoint.provider === "microsoft-teams" && !thread.isDM
              ? `Shared ${message.attachments.length} Microsoft Teams file reference${message.attachments.length === 1 ? "" : "s"}.${providerUrl ? ` Open in Microsoft Teams: ${providerUrl}` : ""}`
              : `Shared ${message.attachments.length} file${message.attachments.length === 1 ? "" : "s"}.`
            : "Sent an empty message.");
        let comment!: typeof issueComments.$inferSelect;
        await taskTx
          .update(chatEndpoints)
          .set({
            status: taskEndpoint.status,
            setup: taskEndpoint.setup,
            healthMessage:
              taskEndpoint.status === "verifying"
                ? "Test conversation received"
                : "Connected",
            lastEventAt: new Date(),
            activatedAt:
              taskEndpoint.status === "active"
                ? taskEndpoint.activatedAt
                : null,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, taskEndpoint.id));
        comment = await issuesSvc.addComment(
          conversation!.issueId,
          body.slice(0, MAX_INBOUND_TEXT),
          taskUserId ? { userId: taskUserId } : {},
          {
            authorType: taskUserId ? "user" : "system",
            metadata: {
              version: 1,
              sections: [
                {
                  title: `${PROVIDER_LABELS[endpoint.provider]} sender`,
                  rows: [
                    {
                      type: "key_value",
                      label: "Name",
                      value: message.author.fullName || message.author.userName,
                    },
                    {
                      type: "key_value",
                      label: "Provider ID",
                      value: stableExternalPrincipalId(
                        endpoint.provider,
                        message.author,
                        message.raw,
                      ),
                    },
                    {
                      type: "key_value",
                      label: "Authority",
                      value: taskUserId
                        ? "Linked Paperclip user"
                        : "Sponsored external guest (restricted)",
                    },
                  ],
                },
              ],
            },
            sourceTrust: taskUserId
              ? null
              : {
                  preset: LOW_TRUST_REVIEW_PRESET,
                  disposition: "quarantined",
                  sourceIssueId: conversation!.issueId,
                },
          },
          taskTx,
        );
        await taskTx
          .update(chatDeliveries)
          .set({
            conversationId: conversation!.id,
            updatedAt: new Date(),
          })
          .where(eq(chatDeliveries.id, activeDelivery.id));
        await taskTx
          .insert(chatMessageLinks)
          .values({
            companyId: endpoint.companyId,
            endpointId: endpoint.id,
            conversationId: conversation!.id,
            deliveryId: activeDelivery.id,
            commentId: comment.id,
            providerMessageId: message.id,
            direction: "inbound",
          })
          .onConflictDoNothing();
        await taskTx
          .update(chatConversations)
          .set({
            state: "active",
            lastActivityAt: new Date(),
            ...(providerUrl ? { providerUrl } : {}),
            updatedAt: new Date(),
          })
          .where(eq(chatConversations.id, conversation!.id));
        await taskTx
          .update(toolConnections)
          .set({
            status: "active",
            enabled: true,
            healthStatus: "healthy",
            healthMessage: "Connected",
            lastHealthAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, taskEndpoint.connectionId));
        return { actorUserId: taskUserId, comment, conversation, issue };
      };
      const taskMutation = await db.transaction(async (tx) => {
        // Admission and durable task mutation are separate so the provider
        // webhook can return inside its response budget. Take the endpoint and
        // destination locks again at the authoritative mutation boundary for
        // every provider: either a reach revocation commits first and this
        // event is redacted, or this task/comment commits first and the
        // revocation waits. There is no stale-snapshot middle.
        await options.reachAuthorizationBarrier?.();
        const currentEndpoint = await tx
          .select()
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!currentEndpoint) throw notFound("Chat endpoint not found");
        const currentResource = thread.isDM
          ? resource
          : await tx
              .select()
              .from(chatEndpointResources)
              .where(
                and(
                  eq(chatEndpointResources.id, resource.id),
                  eq(chatEndpointResources.endpointId, endpoint.id),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null);
        const currentPrincipalAuthorization = preauthorized
          ? {
              allowed: true,
              linkedDenied: false,
              userId: preauthorizedUserId ?? null,
            }
          : await lockCurrentPrincipalAuthorization(
              tx,
              currentEndpoint,
              principalResolution.principal.id,
            );
        const endpointStillAllowed =
          preauthorized ||
          currentEndpoint.status === "verifying" ||
          currentEndpoint.status === "active";
        const destinationStillAllowed =
          preauthorized ||
          (thread.isDM
            ? currentEndpoint.allowDirectMessages
            : nonDirectDestinationAllowed(currentEndpoint, currentResource));
        if (
          !endpointStillAllowed ||
          !destinationStillAllowed ||
          !currentPrincipalAuthorization.allowed
        ) {
          const filteredAt = new Date();
          await tx
            .update(chatDeliveries)
            .set({
              state: "filtered",
              normalizedEvent: redactedDestinationNormalized,
              principalId: null,
              nextAttemptAt: null,
              processedAt: filteredAt,
              redactedError: endpointStillAllowed
                ? destinationStillAllowed
                  ? currentPrincipalAuthorization.linkedDenied
                    ? "Linked Paperclip account is not currently permitted"
                    : currentEndpoint.allowUnlinkedPeople
                      ? "Endpoint sponsor can no longer authorize external guests"
                      : "External identity must be linked to a Paperclip account"
                  : "Destination is not enabled in Paperclip"
                : "Connection is not active",
              updatedAt: filteredAt,
            })
            .where(
              and(
                eq(chatDeliveries.id, activeDelivery.id),
                eq(chatDeliveries.state, "processing"),
              ),
            );
          // A principal first observed only by this now-revoked event must not
          // survive as a side-channel. Preserve established or linked
          // identities referenced by any other durable record.
          await tx
            .delete(chatExternalPrincipals)
            .where(
              and(
                eq(chatExternalPrincipals.id, principalResolution.principal.id),
                notExists(
                  tx
                    .select({ id: chatDeliveries.id })
                    .from(chatDeliveries)
                    .where(
                      eq(
                        chatDeliveries.principalId,
                        principalResolution.principal.id,
                      ),
                    ),
                ),
                notExists(
                  tx
                    .select({ id: chatIdentityLinks.id })
                    .from(chatIdentityLinks)
                    .where(
                      eq(
                        chatIdentityLinks.principalId,
                        principalResolution.principal.id,
                      ),
                    ),
                ),
                notExists(
                  tx
                    .select({ id: chatActions.id })
                    .from(chatActions)
                    .where(
                      eq(
                        chatActions.principalId,
                        principalResolution.principal.id,
                      ),
                    ),
                ),
              ),
            );
          return null;
        }
        return persistTaskMutation(
          tx,
          currentEndpoint,
          currentPrincipalAuthorization.userId,
        );
      });
      if (!taskMutation) return;
      const { actorUserId, comment, conversation, issue } = taskMutation;
      const attachmentResult = await ingestAttachments({
        endpoint,
        issueId: conversation.issueId,
        issueCommentId: comment.id,
        attachments: nativeInboundAttachments,
        actorUserId,
      });
      await queueIssueAssignmentWakeup({
        heartbeat: options.heartbeat,
        issue: {
          id: issue.id,
          assigneeAgentId: endpoint.assignedAgentId,
          status: issue.status === "backlog" ? "todo" : issue.status,
        },
        reason: "External chat message received",
        mutation: "chat_message_received",
        contextSource: `chat:${endpoint.provider}`,
        requestedByActorType: actorUserId ? "user" : "system",
        requestedByActorId: actorUserId ?? principalResolution.principal.id,
        taskKey: issue.identifier,
        wakeCommentId: comment.id,
        rethrowOnError: true,
      });
      // Do not discard a subscription failure after marking the delivery
      // processed. A retry reuses the committed message link above and tries
      // this idempotent subscription again before completing the delivery.
      if (addressed && !thread.isDM) await thread.subscribe();
      await db
        .update(chatDeliveries)
        .set({
          state: "processed",
          processedAt: new Date(),
          redactedError: attachmentOmissionDetail(attachmentResult),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatDeliveries.id, activeDelivery.id),
            eq(chatDeliveries.state, "processing"),
          ),
        );
      // Provider-visible acknowledgement begins only after the task, external
      // comment, durable wakeup request, delivery state, and message link commit.
      await Promise.allSettled([
        receiptReactionSupported
          ? addReceiptReaction({
              deliveryId: activeDelivery.id,
              endpoint,
              message,
              thread,
            })
          : Promise.resolve(),
        // Slack implements this through assistant.threads.setStatus, which
        // requires assistant:write. The least-privilege Paperclip manifest
        // deliberately does not request that scope; the coalesced lifecycle
        // reply below is the visible working state instead.
        endpoint.provider === "slack"
          ? Promise.resolve()
          : thread.startTyping("Working…"),
      ]);
    } catch (error) {
      const providerEffectAmbiguous =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "CHAT_PROVIDER_EFFECT_AMBIGUOUS";
      const terminal = providerEffectAmbiguous || activeDelivery.attempts >= 5;
      await db
        .update(chatDeliveries)
        .set({
          state: terminal ? "failed" : "retry",
          nextAttemptAt: terminal
            ? null
            : new Date(
                Date.now() +
                  Math.min(60_000, 1000 * 2 ** activeDelivery.attempts),
              ),
          redactedError: redactError(error),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatDeliveries.id, activeDelivery.id),
            eq(chatDeliveries.state, "processing"),
          ),
        );
      throw error;
    }
  }

  function deliveryContentWasRedacted(normalizedEvent: unknown): boolean {
    if (
      !normalizedEvent ||
      typeof normalizedEvent !== "object" ||
      Array.isArray(normalizedEvent)
    )
      return false;
    const filtering = (normalizedEvent as { filtering?: unknown }).filtering;
    return (
      Boolean(filtering) &&
      typeof filtering === "object" &&
      !Array.isArray(filtering) &&
      (filtering as { contentRetained?: unknown }).contentRetained === false
    );
  }

  function discordRootThreadPending(
    delivery: Pick<DeliveryRow, "normalizedEvent">,
  ): boolean {
    return (
      Boolean(delivery.normalizedEvent) &&
      typeof delivery.normalizedEvent === "object" &&
      !Array.isArray(delivery.normalizedEvent) &&
      (delivery.normalizedEvent as { providerThreadPending?: unknown })
        .providerThreadPending === true
    );
  }

  async function reconcileDiscordRootThread(
    endpoint: EndpointRow,
    delivery: DeliveryRow,
    threadId: string,
  ): Promise<boolean> {
    try {
      const endpointRuntime = await runtimeFor(endpoint);
      const normalized = delivery.normalizedEvent as {
        message?: { providerMessageId?: unknown; text?: unknown };
        resource?: { providerResourceId?: unknown };
      };
      const discordThreadParts = threadId.split(":");
      const channelId =
        discordThreadParts[0] === "discord" && discordThreadParts.length >= 4
          ? discordThreadParts[2]
          : normalized.resource?.providerResourceId;
      const messageId = normalized.message?.providerMessageId;
      if (typeof channelId !== "string" || typeof messageId !== "string") {
        throw new DiscordAdapterCompatibilityError(
          "the provisional root receipt is missing its channel or message id",
        );
      }
      await endpointRuntime.ensureDiscordRootThread({
        channelId,
        messageId,
        content:
          typeof normalized.message?.text === "string"
            ? normalized.message.text
            : "Paperclip task",
      });
      const [promoted] = await db
        .update(chatDeliveries)
        .set({
          state: "received",
          normalizedEvent: sql`${chatDeliveries.normalizedEvent} - 'providerThreadPending'`,
          nextAttemptAt: null,
          redactedError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatDeliveries.id, delivery.id),
            eq(chatDeliveries.state, "retry"),
            sql`${chatDeliveries.normalizedEvent}->>'providerThreadPending' = 'true'`,
          ),
        )
        .returning({ id: chatDeliveries.id });
      return Boolean(promoted);
    } catch (error) {
      const disposition = classifyChatPublicationError(
        error,
        delivery.attempts + 1,
      );
      const terminal =
        disposition.kind === "resource_unavailable" ||
        disposition.kind === "failed";
      const retryAfterMs =
        disposition.kind === "retry"
          ? disposition.retryAfterMs
          : DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS;
      const now = new Date();
      await db
        .update(chatDeliveries)
        .set({
          state: terminal ? "filtered" : "retry",
          attempts: delivery.attempts + 1,
          nextAttemptAt: terminal
            ? null
            : new Date(now.getTime() + retryAfterMs),
          processedAt: terminal ? now : null,
          redactedError: terminal
            ? "Discord thread creation was not confirmed"
            : redactError(error),
          updatedAt: now,
        })
        .where(
          and(
            eq(chatDeliveries.id, delivery.id),
            eq(chatDeliveries.state, "retry"),
            sql`${chatDeliveries.normalizedEvent}->>'providerThreadPending' = 'true'`,
          ),
        );
      return false;
    }
  }

  function normalizedDeliveryThreadId(delivery: DeliveryRow): string | null {
    const normalized = delivery.normalizedEvent as {
      conversation?: { externalThreadId?: unknown };
    };
    return typeof normalized.conversation?.externalThreadId === "string"
      ? normalized.conversation.externalThreadId
      : null;
  }

  function normalizedLifecycleTargetEventId(
    delivery: DeliveryRow,
  ): string | null {
    if (
      delivery.eventKind !== "message_updated" &&
      delivery.eventKind !== "message_deleted"
    )
      return null;
    const normalized = delivery.normalizedEvent as {
      message?: { targetProviderEventId?: unknown };
    };
    return typeof normalized.message?.targetProviderEventId === "string"
      ? normalized.message.targetProviderEventId
      : null;
  }

  function normalizedLifecycleEffect(
    delivery: DeliveryRow,
  ): ChatProviderLifecycleEffect | null {
    const normalized = delivery.normalizedEvent as { lifecycle?: unknown };
    const value = normalized.lifecycle;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const effect = value as Record<string, unknown>;
    if (
      (effect.provider !== "slack" &&
        effect.provider !== "github" &&
        effect.provider !== "discord" &&
        effect.provider !== "microsoft-teams" &&
        effect.provider !== "telegram") ||
      typeof effect.providerEventId !== "string"
    )
      return null;
    if (
      effect.kind === "endpoint" &&
      (effect.availability === "available" ||
        effect.availability === "attention" ||
        effect.availability === "revoked") &&
      typeof effect.reason === "string"
    )
      return effect as ChatProviderLifecycleEffect;
    if (
      effect.kind === "resource" &&
      (effect.availability === "available" ||
        effect.availability === "unavailable" ||
        effect.availability === "removed") &&
      typeof effect.providerResourceId === "string" &&
      (effect.previousProviderResourceId === undefined ||
        typeof effect.previousProviderResourceId === "string") &&
      typeof effect.resourceType === "string" &&
      typeof effect.label === "string"
    )
      return effect as ChatProviderLifecycleEffect;
    return null;
  }

  function deliveryReady(delivery: DeliveryRow, now: Date): boolean {
    if (delivery.state === "received")
      return !delivery.nextAttemptAt || delivery.nextAttemptAt <= now;
    if (delivery.state === "retry") {
      return !delivery.nextAttemptAt || delivery.nextAttemptAt <= now;
    }
    return (
      delivery.state === "processing" &&
      delivery.updatedAt <=
        new Date(now.getTime() - DELIVERY_PROCESSING_STALE_MS)
    );
  }

  async function earliestOpenConversationDelivery(
    endpointId: string,
    threadId: string,
  ): Promise<DeliveryRow | null> {
    const candidate = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpointId),
          inArray(chatDeliveries.state, ["received", "retry", "processing"]),
          sql`${chatDeliveries.normalizedEvent}->'conversation'->>'externalThreadId' = ${threadId}`,
        ),
      )
      .orderBy(
        asc(
          sql`coalesce(nullif(${chatDeliveries.normalizedEvent}->'message'->>'providerSentAt', '')::timestamptz, ${chatDeliveries.receivedAt})`,
        ),
        // GitHub timestamps and Telegram message dates have one-second
        // resolution. GitHub's numeric comment id and Telegram's message_id
        // are monotonic within one conversation, so use them before receipt
        // order. The Telegram update_id is a final provider-native tie-breaker
        // for unusual payloads that lack a usable message_id.
        asc(sql`coalesce(
          case
            when ${chatDeliveries.normalizedEvent}->'message'->>'providerMessageSequence' ~ '^[0-9]+$'
            then (${chatDeliveries.normalizedEvent}->'message'->>'providerMessageSequence')::numeric
            else null
          end,
          case
            when ${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' ~ '^[0-9]+$'
            then (${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId')::numeric
            else null
          end
        )`),
        asc(sql`case
          when ${chatDeliveries.normalizedEvent}->'message'->>'providerUpdateId' ~ '^[0-9]+$'
          then (${chatDeliveries.normalizedEvent}->'message'->>'providerUpdateId')::numeric
          else null
        end`),
        // GitHub exposes no sortable webhook sequence. When an edit and delete
        // share its whole-second updated_at value, preserve the only valid
        // lifecycle state transition: update before delete. Provider-native
        // update ids (Telegram) remain the stronger preceding key.
        asc(sql`case ${chatDeliveries.eventKind}
          when 'message_updated' then 1
          when 'message_deleted' then 2
          else 0
        end`),
        asc(chatDeliveries.receivedAt),
        asc(chatDeliveries.id),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!candidate) return null;

    // A lifecycle callback can reach Paperclip before its create callback. If
    // the root becomes durable while the lifecycle row is waiting, always
    // return that exact dependency first even when a coarse or malformed
    // provider timestamp would otherwise put the edit/delete at the head.
    const targetProviderEventId = normalizedLifecycleTargetEventId(candidate);
    if (!targetProviderEventId) return candidate;
    return db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpointId),
          eq(chatDeliveries.providerEventId, targetProviderEventId),
          inArray(chatDeliveries.state, ["received", "retry", "processing"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? candidate);
  }

  async function acquireConversationDeliveryLease(input: {
    companyId: string;
    endpointId: string;
    threadId: string;
  }): Promise<{ leaseKey: string; token: string } | null> {
    const now = new Date();
    const token = randomUUID();
    const leaseKey = `inbound:${createHash("sha256").update(input.threadId).digest("hex")}`;
    const expiresAt = new Date(now.getTime() + DELIVERY_LEASE_TTL_MS);
    const inserted = await db
      .insert(chatEndpointLeases)
      .values({
        companyId: input.companyId,
        endpointId: input.endpointId,
        leaseKey,
        token,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: chatEndpointLeases.id });
    if (inserted.length > 0) return { leaseKey, token };
    const reclaimed = await db
      .update(chatEndpointLeases)
      .set({ token, expiresAt, updatedAt: now })
      .where(
        and(
          eq(chatEndpointLeases.companyId, input.companyId),
          eq(chatEndpointLeases.endpointId, input.endpointId),
          eq(chatEndpointLeases.leaseKey, leaseKey),
          lte(chatEndpointLeases.expiresAt, now),
        ),
      )
      .returning({ id: chatEndpointLeases.id });
    return reclaimed.length > 0 ? { leaseKey, token } : null;
  }

  async function releaseConversationDeliveryLease(input: {
    endpointId: string;
    leaseKey: string;
    token: string;
  }): Promise<void> {
    await db
      .delete(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.endpointId, input.endpointId),
          eq(chatEndpointLeases.leaseKey, input.leaseKey),
          eq(chatEndpointLeases.token, input.token),
        ),
      );
  }

  function messageFromDelivery(
    delivery: DeliveryRow,
    thread: Thread,
    endpointRuntime: ChatSdkEndpointRuntime,
  ): {
    message: Message;
    receiptReactionSupported: boolean;
    trigger: ChatSdkMessageCallbackEvent["trigger"];
    providerUrl: string | null;
  } | null {
    const normalized = delivery.normalizedEvent as {
      acknowledgement?: { receiptReactionSupported?: unknown };
      kind?: unknown;
      trigger?: unknown;
      principal?: {
        externalId?: unknown;
        displayName?: unknown;
        handle?: unknown;
      };
      message?: {
        providerMessageId?: unknown;
        text?: unknown;
        mentionedBot?: unknown;
        attachments?: Array<{ recovery?: unknown }>;
      };
      conversation?: { providerUrl?: unknown };
    };
    const providerMessageId = normalized.message?.providerMessageId;
    const externalId = normalized.principal?.externalId;
    if (typeof providerMessageId !== "string" || typeof externalId !== "string")
      return null;
    const attachments = (normalized.message?.attachments ?? [])
      .map((attachment) =>
        attachment.recovery
          ? endpointRuntime.rehydrateAttachment(attachment.recovery)
          : null,
      )
      .filter((attachment): attachment is Attachment => Boolean(attachment));
    const message = {
      id: providerMessageId,
      threadId: thread.id,
      text:
        typeof normalized.message?.text === "string"
          ? normalized.message.text
          : "",
      formatted: { type: "root", children: [] },
      raw: {},
      author: {
        userId: externalId,
        userName:
          typeof normalized.principal?.handle === "string"
            ? normalized.principal.handle
            : externalId,
        fullName:
          typeof normalized.principal?.displayName === "string"
            ? normalized.principal.displayName
            : externalId,
        isBot: false,
        isMe: false,
        isSystem: false,
      },
      metadata: { dateSent: delivery.receivedAt, edited: false },
      attachments,
      links: [],
      isMention: normalized.message?.mentionedBot === true,
    } as unknown as Message;
    const normalizedTrigger = normalized.trigger;
    const trigger: ChatSdkMessageCallbackEvent["trigger"] =
      normalizedTrigger === "direct_message" ||
      normalizedTrigger === "mention" ||
      normalizedTrigger === "subscribed_message" ||
      normalizedTrigger === "unaddressed_message"
        ? normalizedTrigger
        : normalized.kind === "direct_message"
          ? "direct_message"
          : normalized.kind === "mention"
            ? "mention"
            : "subscribed_message";
    return {
      message,
      // Legacy deliveries all originated from native provider messages and
      // therefore retain the historical default.
      receiptReactionSupported:
        normalized.acknowledgement?.receiptReactionSupported !== false,
      trigger,
      providerUrl:
        typeof normalized.conversation?.providerUrl === "string"
          ? normalized.conversation.providerUrl
          : null,
    };
  }

  /**
   * Drain one external conversation in durable receipt order. The database
   * lease is endpoint + thread scoped, so separate server processes can work
   * on different conversations concurrently but can never mutate the same
   * Paperclip task from two inbound turns at once.
   */
  async function drainConversationDeliveries(
    endpointId: string,
    threadId: string,
  ): Promise<boolean> {
    const endpoint = await db
      .select()
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpointId))
      .then((rows) => rows[0] ?? null);
    if (!endpoint) return false;
    if (endpoint.status === "paused" || endpoint.status === "attention")
      return false;

    const lease = await acquireConversationDeliveryLease({
      companyId: endpoint.companyId,
      endpointId,
      threadId,
    });
    if (!lease) return false;

    let leaseOwned = true;
    let renewal: Promise<void> | null = null;
    const renewTimer = setInterval(
      () => {
        if (!leaseOwned || renewal) return;
        const expiresAt = new Date(Date.now() + DELIVERY_LEASE_TTL_MS);
        renewal = Promise.resolve()
          .then(async () => {
            const renewed = options.renewConversationDeliveryLease
              ? await options.renewConversationDeliveryLease({
                  endpointId,
                  leaseKey: lease.leaseKey,
                  token: lease.token,
                  expiresAt,
                })
              : await db
                  .update(chatEndpointLeases)
                  .set({ expiresAt, updatedAt: new Date() })
                  .where(
                    and(
                      eq(chatEndpointLeases.endpointId, endpointId),
                      eq(chatEndpointLeases.leaseKey, lease.leaseKey),
                      eq(chatEndpointLeases.token, lease.token),
                    ),
                  )
                  .returning({ id: chatEndpointLeases.id })
                  .then((rows) => rows.length > 0);
            if (!renewed) leaseOwned = false;
          })
          .catch((error) => {
            // A failed renewal has unknown durability. Stop this local drain at
            // the next delivery boundary so another worker can never overlap
            // later turns after the original lease expires or is reclaimed.
            leaseOwned = false;
            logger.warn(
              { endpointId, error: redactError(error) },
              "could not renew external chat conversation lease",
            );
          })
          .finally(() => {
            renewal = null;
          });
      },
      options.conversationLeaseRenewalIntervalMs ?? DELIVERY_LEASE_TTL_MS / 3,
    );
    renewTimer.unref?.();

    try {
      for (
        let processed = 0;
        processed < DELIVERY_DRAIN_LIMIT;
        processed += 1
      ) {
        if (!leaseOwned) break;
        const delivery = await earliestOpenConversationDelivery(
          endpointId,
          threadId,
        );
        if (!delivery || !deliveryReady(delivery, new Date())) break;
        if (endpoint.status === "archived" || endpoint.status === "revoked") {
          await db
            .update(chatDeliveries)
            .set({
              state: "filtered",
              redactedError: "Connection was removed before processing",
              processedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(chatDeliveries.id, delivery.id));
          liveInboundMessages.delete(delivery.id);
          continue;
        }

        if (
          endpoint.provider === "discord" &&
          discordRootThreadPending(delivery)
        ) {
          // This is the only recovery path for the narrow crash window after
          // pre-admission but before Chat's ordinary callback. A successful
          // read proves the root thread exists; an explicit 404/410 proves it
          // does not. Ambiguous transport and auth failures remain retryable.
          if (await reconcileDiscordRootThread(endpoint, delivery, threadId)) {
            continue;
          }
          break;
        }

        const live = liveInboundMessages.get(delivery.id);
        try {
          if (
            delivery.eventKind === "message_updated" ||
            delivery.eventKind === "message_deleted"
          ) {
            await processLifecycleDelivery(endpoint, delivery);
          } else if (live) {
            await processMessage(
              endpoint,
              live.thread,
              live.message,
              live.trigger,
              false,
              null,
              undefined,
              undefined,
              delivery.id,
              live.receiptReactionSupported,
            );
          } else {
            if (deliveryContentWasRedacted(delivery.normalizedEvent)) {
              const filteredAt = new Date();
              await db
                .update(chatDeliveries)
                .set({
                  state: "filtered",
                  principalId: null,
                  nextAttemptAt: null,
                  processedAt: filteredAt,
                  redactedError:
                    "Provisional Teams setup reply could not be hydrated from a current provider event",
                  updatedAt: filteredAt,
                })
                .where(
                  and(
                    eq(chatDeliveries.id, delivery.id),
                    inArray(chatDeliveries.state, [
                      "received",
                      "retry",
                      "processing",
                    ]),
                  ),
                );
              continue;
            }
            const endpointRuntime = await runtimeFor(endpoint);
            const thread = endpointRuntime.thread(threadId);
            const reconstructed = messageFromDelivery(
              delivery,
              thread,
              endpointRuntime,
            );
            if (!reconstructed) {
              await db
                .update(chatDeliveries)
                .set({
                  state: "failed",
                  redactedError: "Normalized delivery is incomplete",
                  updatedAt: new Date(),
                })
                .where(eq(chatDeliveries.id, delivery.id));
              continue;
            }
            await processMessage(
              endpoint,
              thread,
              reconstructed.message,
              reconstructed.trigger,
              false,
              reconstructed.providerUrl,
              undefined,
              undefined,
              delivery.id,
              reconstructed.receiptReactionSupported,
            );
          }
        } catch (error) {
          logger.warn(
            {
              endpointId,
              deliveryId: delivery.id,
              error: redactError(error),
            },
            "external chat delivery will retry in receipt order",
          );
        }

        const state = await db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.id, delivery.id))
          .then((rows) => rows[0]?.state ?? null);
        if (
          state === "processed" ||
          state === "filtered" ||
          state === "failed"
        ) {
          liveInboundMessages.delete(delivery.id);
          continue;
        }
        // A retry delay or another still-live processing claim is a strict
        // head-of-line barrier; later replies may not overtake it.
        break;
      }
    } finally {
      clearInterval(renewTimer);
      await renewal;
      await releaseConversationDeliveryLease({ endpointId, ...lease });
    }

    const next = await earliestOpenConversationDelivery(endpointId, threadId);
    return Boolean(next && deliveryReady(next, new Date()));
  }

  async function handleSdkMessage(
    event: ChatSdkMessageCallbackEvent,
    runtimeContext?: RuntimeContext,
    messageOptions: { receiptReactionSupported?: boolean } = {},
  ) {
    const record = await endpointRecord(event.endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const messages = [...(event.context?.skipped ?? []), event.message];
    for (const message of messages)
      await processMessage(
        record.endpoint,
        event.thread,
        message,
        message === event.message ? event.trigger : "subscribed_message",
        options.deferWebhookProcessing === true,
        null,
        runtimeContext,
        event.providerUpdateId,
        null,
        messageOptions.receiptReactionSupported !== false,
      );
  }

  async function conversationForThread(endpointId: string, threadId: string) {
    return db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.endpointId, endpointId),
          eq(chatConversations.externalThreadId, threadId),
        ),
      )
      .orderBy(desc(chatConversations.sessionGeneration))
      .then((rows) => rows[0] ?? null);
  }

  async function recordLifecycleDelivery(
    input: {
      actor?: LifecycleActor;
      endpointId: string;
      threadId: string;
      messageId: string;
      eventKind: "message_updated" | "message_deleted";
      text: string;
      providerEventId?: string;
      providerMessageSequence?: number | null;
      providerSentAt?: string | null;
      providerUpdateId?: number | null;
      revision?: string | null;
    },
    runtimeContext?: RuntimeContext,
  ) {
    const providerEventId =
      input.providerEventId ??
      `${input.eventKind}:${input.threadId}:${input.messageId}:${input.revision ?? "once"}`;
    const targetProviderEventId = `${input.threadId}:${input.messageId}`;
    const admission = await db.transaction(async (tx) => {
      const endpoint = await tx
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, input.endpointId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!endpoint) throw notFound("Chat endpoint not found");
      if (
        runtimeContext &&
        !(await runtimeCallbackEndpoint(tx, endpoint.id, runtimeContext, [
          "verifying",
          "active",
        ]))
      )
        return null;
      // A provider has already authenticated this callback. During setup the
      // message can belong to the test conversation, so retain its correction.
      // Paused or unhealthy connections acknowledge late callbacks without
      // mutating the bound task or causing provider retry storms.
      if (endpoint.status !== "verifying" && endpoint.status !== "active")
        return null;
      const reorderWindow = INGRESS_REORDER_WINDOW_MS[endpoint.provider];
      const scheduledAt =
        options.deferWebhookProcessing === true && reorderWindow
          ? (scheduledConversationDrains.get(
              conversationDrainKey(input.endpointId, input.threadId),
            ) ?? Date.now() + reorderWindow)
          : null;
      const [delivery] = await tx
        .insert(chatDeliveries)
        .values({
          companyId: endpoint.companyId,
          endpointId: input.endpointId,
          providerEventId,
          deduplicationKey: createHash("sha256")
            .update(providerEventId)
            .digest("hex"),
          eventKind: input.eventKind,
          normalizedEvent: {
            providerEventId,
            kind: input.eventKind,
            ...(runtimeContext
              ? {
                  runtimeContext: {
                    credentialFingerprint: runtimeContext.credentialFingerprint,
                    generation: runtimeContext.generation,
                  },
                }
              : {}),
            ...(input.actor ? { principal: input.actor } : {}),
            conversation: { externalThreadId: input.threadId },
            message: {
              providerMessageId: input.messageId,
              targetProviderEventId,
              providerMessageSequence: input.providerMessageSequence ?? null,
              providerSentAt: input.providerSentAt ?? null,
              providerUpdateId: input.providerUpdateId ?? null,
              text: input.text,
            },
          },
          state: "received",
          nextAttemptAt: scheduledAt ? new Date(scheduledAt) : null,
        })
        .onConflictDoNothing()
        .returning();
      if (delivery) return { delivery, scheduledAt };
      const existing = await tx
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, input.endpointId),
            eq(chatDeliveries.providerEventId, providerEventId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return existing ? { delivery: existing, scheduledAt } : null;
    });
    if (
      !admission ||
      admission.delivery.state === "processed" ||
      admission.delivery.state === "filtered" ||
      admission.delivery.state === "failed"
    )
      return;
    if (options.deferWebhookProcessing === true) {
      scheduleConversationDrain(
        input.endpointId,
        input.threadId,
        admission.scheduledAt ?? Date.now(),
      );
      return;
    }
    await drainConversationDeliveries(input.endpointId, input.threadId);
  }

  function lifecycleMessageFromDelivery(delivery: DeliveryRow): {
    actor: LifecycleActor | null;
    messageId: string;
    targetProviderEventId: string;
    text: string;
    threadId: string;
  } | null {
    if (
      delivery.eventKind !== "message_updated" &&
      delivery.eventKind !== "message_deleted"
    )
      return null;
    const normalized = delivery.normalizedEvent as {
      principal?: {
        displayName?: unknown;
        externalId?: unknown;
        handle?: unknown;
      };
      message?: {
        providerMessageId?: unknown;
        targetProviderEventId?: unknown;
        text?: unknown;
      };
    };
    const messageId = normalized.message?.providerMessageId;
    const targetProviderEventId = normalized.message?.targetProviderEventId;
    const text = normalized.message?.text;
    const threadId = normalizedDeliveryThreadId(delivery);
    const externalId = normalized.principal?.externalId;
    const actor =
      typeof externalId === "string" && externalId
        ? {
            externalId,
            displayName:
              typeof normalized.principal?.displayName === "string"
                ? normalized.principal.displayName
                : externalId,
            handle:
              typeof normalized.principal?.handle === "string"
                ? normalized.principal.handle
                : externalId,
          }
        : null;
    return typeof messageId === "string" &&
      typeof targetProviderEventId === "string" &&
      typeof text === "string" &&
      threadId !== null
      ? { actor, messageId, targetProviderEventId, text, threadId }
      : null;
  }

  async function processLifecycleDelivery(
    endpoint: EndpointRow,
    candidate: DeliveryRow,
  ): Promise<void> {
    const lifecycle = lifecycleMessageFromDelivery(candidate);
    if (!lifecycle) {
      await db
        .update(chatDeliveries)
        .set({
          state: "failed",
          redactedError: "Normalized lifecycle delivery is incomplete",
          updatedAt: new Date(),
        })
        .where(eq(chatDeliveries.id, candidate.id));
      return;
    }

    const now = new Date();
    const staleBefore = new Date(now.getTime() - DELIVERY_PROCESSING_STALE_MS);
    const claimConditions = [
      eq(chatDeliveries.id, candidate.id),
      eq(chatDeliveries.state, candidate.state),
    ];
    if (candidate.state === "processing")
      claimConditions.push(lte(chatDeliveries.updatedAt, staleBefore));
    const [activeDelivery] = await db
      .update(chatDeliveries)
      .set({
        state: "processing",
        attempts: candidate.attempts + 1,
        nextAttemptAt: null,
        redactedError: null,
        updatedAt: now,
      })
      .where(and(...claimConditions))
      .returning();
    if (!activeDelivery) return;

    try {
      await db.transaction(async (tx) => {
        const admittedRuntimeContext = lifecycleRuntimeFence(activeDelivery);
        const currentEndpoint = admittedRuntimeContext
          ? await runtimeCallbackEndpoint(
              tx,
              endpoint.id,
              admittedRuntimeContext,
              ["verifying", "active"],
            )
          : null;
        if (!admittedRuntimeContext || !currentEndpoint) {
          const filteredAt = new Date();
          await tx
            .update(chatDeliveries)
            .set({
              state: "filtered",
              nextAttemptAt: null,
              processedAt: filteredAt,
              redactedError:
                "Message lifecycle callback belonged to a superseded runtime",
              updatedAt: filteredAt,
            })
            .where(
              and(
                eq(chatDeliveries.id, activeDelivery.id),
                eq(chatDeliveries.state, "processing"),
              ),
            );
          return;
        }
        if (activeDelivery.eventKind === "message_updated") {
          const terminalDelete = await tx
            .select({ id: chatDeliveries.id })
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.companyId, activeDelivery.companyId),
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(chatDeliveries.eventKind, "message_deleted"),
                eq(chatDeliveries.state, "processed"),
                sql`${chatDeliveries.normalizedEvent}->'conversation'->>'externalThreadId' = ${lifecycle.threadId}`,
                sql`${chatDeliveries.normalizedEvent}->'message'->>'targetProviderEventId' = ${lifecycle.targetProviderEventId}`,
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (terminalDelete) {
            const filteredAt = new Date();
            await tx
              .update(chatDeliveries)
              .set({
                state: "filtered",
                nextAttemptAt: null,
                processedAt: filteredAt,
                redactedError:
                  "Message edit arrived after the provider message was deleted",
                updatedAt: filteredAt,
              })
              .where(
                and(
                  eq(chatDeliveries.id, activeDelivery.id),
                  eq(chatDeliveries.state, "processing"),
                ),
              );
            return;
          }
        }
        const originalDelivery = await tx
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(
                chatDeliveries.providerEventId,
                lifecycle.targetProviderEventId,
              ),
            ),
          )
          .then((rows) => rows[0] ?? null);
        const linkedTarget = await tx
          .select({
            conversationId: chatConversations.id,
            issueId: chatConversations.issueId,
          })
          .from(chatMessageLinks)
          .innerJoin(
            chatConversations,
            and(
              eq(chatConversations.companyId, chatMessageLinks.companyId),
              eq(chatConversations.id, chatMessageLinks.conversationId),
            ),
          )
          .where(
            and(
              eq(chatMessageLinks.endpointId, endpoint.id),
              eq(chatMessageLinks.providerMessageId, lifecycle.messageId),
              eq(chatMessageLinks.direction, "inbound"),
              eq(chatConversations.externalThreadId, lifecycle.threadId),
            ),
          )
          .orderBy(desc(chatConversations.sessionGeneration))
          .then((rows) => rows[0] ?? null);

        if (!linkedTarget) {
          const originalIsOpen =
            originalDelivery !== null &&
            ["received", "processing", "retry"].includes(
              originalDelivery.state,
            );
          const waitForRoot =
            originalIsOpen ||
            activeDelivery.attempts <= ORPHAN_FOLLOW_UP_MAX_ATTEMPTS;
          const resolutionAt = new Date();
          await tx
            .update(chatDeliveries)
            .set(
              waitForRoot
                ? {
                    state: "retry",
                    nextAttemptAt: new Date(
                      resolutionAt.getTime() + ORPHAN_FOLLOW_UP_GRACE_MS,
                    ),
                    redactedError: originalIsOpen
                      ? "Waiting for the original message to finish processing"
                      : "Waiting briefly for the original message",
                    updatedAt: resolutionAt,
                  }
                : {
                    state: "filtered",
                    nextAttemptAt: null,
                    redactedError:
                      "Original message was not admitted to this conversation",
                    processedAt: resolutionAt,
                    updatedAt: resolutionAt,
                  },
            )
            .where(
              and(
                eq(chatDeliveries.id, activeDelivery.id),
                eq(chatDeliveries.state, "processing"),
              ),
            );
          return;
        }

        const currentConversation = await tx
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.companyId, currentEndpoint.companyId),
              eq(chatConversations.endpointId, currentEndpoint.id),
              eq(chatConversations.id, linkedTarget.conversationId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        const currentResource =
          currentConversation?.resourceId &&
          !currentConversation.isDirectMessage
            ? await tx
                .select()
                .from(chatEndpointResources)
                .where(
                  and(
                    eq(
                      chatEndpointResources.companyId,
                      currentEndpoint.companyId,
                    ),
                    eq(chatEndpointResources.endpointId, currentEndpoint.id),
                    eq(
                      chatEndpointResources.id,
                      currentConversation.resourceId,
                    ),
                  ),
                )
                .for("update")
                .then((rows) => rows[0] ?? null)
            : null;
        const destinationAllowed =
          currentConversation !== null &&
          ["active", "waiting"].includes(currentConversation.state) &&
          (currentConversation.isDirectMessage
            ? currentEndpoint.allowDirectMessages
            : nonDirectDestinationAllowed(currentEndpoint, currentResource));
        if (!destinationAllowed) {
          const filteredAt = new Date();
          await tx
            .update(chatDeliveries)
            .set({
              state: "filtered",
              normalizedEvent: {
                providerEventId:
                  activeDelivery.normalizedEvent.providerEventId ??
                  activeDelivery.providerEventId,
                kind: activeDelivery.eventKind,
                conversation: { externalThreadId: lifecycle.threadId },
                message: {
                  providerMessageId: lifecycle.messageId,
                  targetProviderEventId: lifecycle.targetProviderEventId,
                },
                filtering: { contentRetained: false },
              },
              nextAttemptAt: null,
              processedAt: filteredAt,
              redactedError:
                "Destination is no longer enabled for message lifecycle events",
              updatedAt: filteredAt,
            })
            .where(
              and(
                eq(chatDeliveries.id, activeDelivery.id),
                eq(chatDeliveries.state, "processing"),
              ),
            );
          return;
        }

        let lifecyclePrincipalId: string | null = null;
        const requiresLifecycleActorAuthorization =
          activeDelivery.eventKind === "message_updated" &&
          (lifecycle.actor !== null ||
            currentEndpoint.provider === "github" ||
            currentEndpoint.provider === "telegram" ||
            currentEndpoint.provider === "microsoft-teams");
        if (requiresLifecycleActorAuthorization) {
          const lifecyclePrincipal = lifecycle.actor
            ? await tx
                .select({
                  id: chatExternalPrincipals.id,
                  isBot: chatExternalPrincipals.isBot,
                  kind: chatExternalPrincipals.kind,
                })
                .from(chatExternalPrincipals)
                .where(
                  and(
                    eq(
                      chatExternalPrincipals.companyId,
                      currentEndpoint.companyId,
                    ),
                    eq(
                      chatExternalPrincipals.provider,
                      currentEndpoint.provider,
                    ),
                    eq(
                      chatExternalPrincipals.providerAccountId,
                      currentEndpoint.providerAccountId ?? "unknown",
                    ),
                    eq(
                      chatExternalPrincipals.externalId,
                      lifecycle.actor.externalId,
                    ),
                  ),
                )
                .for("update")
                .then((rows) => rows[0] ?? null)
            : null;
          const authorization =
            lifecyclePrincipal &&
            lifecyclePrincipal.kind === "user" &&
            !lifecyclePrincipal.isBot
              ? await lockCurrentPrincipalAuthorization(
                  tx,
                  currentEndpoint,
                  lifecyclePrincipal.id,
                )
              : null;
          const authorizedPrincipalId = authorization?.allowed
            ? (lifecyclePrincipal?.id ?? null)
            : null;
          if (!authorizedPrincipalId) {
            const filteredAt = new Date();
            await tx
              .update(chatDeliveries)
              .set({
                principalId: lifecyclePrincipal?.id ?? null,
                state: "filtered",
                normalizedEvent: {
                  providerEventId:
                    activeDelivery.normalizedEvent.providerEventId ??
                    activeDelivery.providerEventId,
                  kind: activeDelivery.eventKind,
                  conversation: { externalThreadId: lifecycle.threadId },
                  message: {
                    providerMessageId: lifecycle.messageId,
                    targetProviderEventId: lifecycle.targetProviderEventId,
                  },
                  filtering: { contentRetained: false },
                },
                nextAttemptAt: null,
                processedAt: filteredAt,
                redactedError:
                  "External message actor is no longer authorized for lifecycle events",
                updatedAt: filteredAt,
              })
              .where(
                and(
                  eq(chatDeliveries.id, activeDelivery.id),
                  eq(chatDeliveries.state, "processing"),
                ),
              );
            return;
          }
          lifecyclePrincipalId = authorizedPrincipalId;
        }

        await issuesSvc.addComment(
          linkedTarget.issueId,
          lifecycle.text,
          {},
          { authorType: "system" },
          tx,
        );
        await tx
          .update(chatDeliveries)
          .set({
            conversationId: linkedTarget.conversationId,
            principalId: lifecyclePrincipalId,
            state: "processed",
            processedAt: new Date(),
            redactedError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatDeliveries.id, activeDelivery.id),
              eq(chatDeliveries.state, "processing"),
            ),
          );
      });
    } catch (error) {
      const terminal = activeDelivery.attempts >= 5;
      await db
        .update(chatDeliveries)
        .set({
          state: terminal ? "failed" : "retry",
          nextAttemptAt: terminal
            ? null
            : new Date(
                Date.now() +
                  Math.min(60_000, 1000 * 2 ** activeDelivery.attempts),
              ),
          redactedError: redactError(error),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatDeliveries.id, activeDelivery.id),
            eq(chatDeliveries.state, "processing"),
          ),
        );
      throw error;
    }
  }

  async function handleMessageUpdated(
    event: ChatSdkMessageUpdatedCallbackEvent,
    runtimeContext: RuntimeContext,
  ) {
    const text = `An external message was edited:\n\n${event.message.text.slice(0, MAX_INBOUND_TEXT)}`;
    await recordLifecycleDelivery(
      {
        actor: lifecycleActorFromAuthor(
          event.provider,
          event.message.author,
          event.message.raw,
        ),
        endpointId: event.endpointId,
        threadId: event.thread.id,
        messageId: event.message.id,
        eventKind: "message_updated",
        text,
        providerMessageSequence:
          event.provider === "telegram"
            ? telegramMessageSequence(event.message.raw)
            : null,
        providerSentAt:
          (
            event.message.metadata.editedAt ?? event.message.metadata.dateSent
          )?.toISOString() ?? null,
        revision:
          event.message.metadata.editedAt?.toISOString() ??
          createHash("sha256").update(event.message.text).digest("hex"),
      },
      runtimeContext,
    );
  }

  async function handleMessageDeleted(
    event: ChatSdkCallbackEvent<MessageDeletedEvent>,
    runtimeContext: RuntimeContext,
  ) {
    await recordLifecycleDelivery(
      {
        endpointId: event.endpointId,
        threadId: event.event.threadId,
        messageId: event.event.messageId,
        eventKind: "message_deleted",
        text: "An external message in this conversation was deleted.",
        providerSentAt: event.event.deletedAt?.toISOString() ?? null,
        revision: event.event.deletedAt?.toISOString() ?? null,
      },
      runtimeContext,
    );
  }

  async function handleReaction(
    event: ChatSdkCallbackEvent<ReactionEvent>,
    runtimeContext: RuntimeContext,
  ) {
    const record = await runtimeCallbackRecord(
      event.endpointId,
      runtimeContext,
      ["active"],
    );
    if (
      !record ||
      record.endpoint.status !== "active" ||
      record.endpoint.provider !== event.provider ||
      record.endpoint.capabilities.reactions !== true ||
      event.event.user.isMe ||
      event.event.user.isBot === true ||
      event.event.user.isSystem
    ) {
      return;
    }
    let conversation: ConversationRow | null = await conversationForThread(
      event.endpointId,
      event.event.threadId,
    );
    // Slack's reaction callback represents a top-level DM message as
    // `slack:D...:<message-ts>`, while ordinary top-level DM ingestion binds
    // the conversation to the channel-only `slack:D...:` thread. Limit the
    // normalization fallback to D-prefixed Slack conversations and anchor it
    // on the exact durable message link. A newer task generation can already
    // be active in the same DM, while a reaction still belongs to the prior
    // completed generation. Channel roots and replies retain exact provider-
    // thread matching.
    if (!conversation && event.provider === "slack") {
      const channelId = slackThreadChannelId(event.event.threadId);
      if (channelId && /^D[A-Z0-9-]*$/i.test(channelId)) {
        const linkedConversation = await db
          .select({ conversationId: chatMessageLinks.conversationId })
          .from(chatMessageLinks)
          .innerJoin(
            chatConversations,
            and(
              eq(chatConversations.companyId, chatMessageLinks.companyId),
              eq(chatConversations.endpointId, chatMessageLinks.endpointId),
              eq(chatConversations.id, chatMessageLinks.conversationId),
            ),
          )
          .where(
            and(
              eq(chatConversations.companyId, record.endpoint.companyId),
              eq(chatConversations.endpointId, event.endpointId),
              eq(chatConversations.externalThreadId, `slack:${channelId}:`),
              eq(chatConversations.isDirectMessage, true),
              eq(chatMessageLinks.providerMessageId, event.event.messageId),
            ),
          )
          .orderBy(desc(chatConversations.sessionGeneration))
          .then((rows) => rows[0] ?? null);
        conversation = linkedConversation
          ? await db
              .select()
              .from(chatConversations)
              .where(
                eq(chatConversations.id, linkedConversation.conversationId),
              )
              .then((rows) => rows[0] ?? null)
          : null;
      }
    }
    if (!conversation) return;
    const linkedMessage = await db
      .select({ id: chatMessageLinks.id })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, event.endpointId),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.providerMessageId, event.event.messageId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!linkedMessage) return;

    const principal = await ensurePrincipal(
      record.endpoint,
      event.event.user,
      event.event.raw,
    );
    let rawFingerprint: string;
    try {
      rawFingerprint = createHash("sha256")
        .update(JSON.stringify(event.event.raw ?? null))
        .digest("hex")
        .slice(0, 24);
    } catch {
      rawFingerprint = "unavailable";
    }
    const eventKind: ChatEventKind = event.event.added
      ? "reaction_added"
      : "reaction_removed";
    const providerEventId = [
      eventKind,
      event.event.threadId,
      event.event.messageId,
      stableExternalPrincipalId(
        record.endpoint.provider,
        event.event.user,
        event.event.raw,
      ),
      event.event.rawEmoji,
      rawFingerprint,
    ].join(":");
    await db.transaction(async (tx) => {
      const currentEndpoint = await runtimeCallbackEndpoint(
        tx,
        event.endpointId,
        runtimeContext,
        ["active"],
      );
      if (!currentEndpoint) return;
      const currentConversation = await tx
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.companyId, currentEndpoint.companyId),
            eq(chatConversations.endpointId, currentEndpoint.id),
            eq(chatConversations.id, conversation.id),
            inArray(
              chatConversations.state,
              conversation.isDirectMessage
                ? ["active", "waiting", "completed"]
                : ["active", "waiting"],
            ),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!currentConversation) return;
      const currentResource =
        currentConversation.resourceId && !currentConversation.isDirectMessage
          ? await tx
              .select()
              .from(chatEndpointResources)
              .where(
                and(
                  eq(
                    chatEndpointResources.companyId,
                    currentEndpoint.companyId,
                  ),
                  eq(chatEndpointResources.endpointId, currentEndpoint.id),
                  eq(chatEndpointResources.id, currentConversation.resourceId),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null)
          : null;
      const destinationAllowed = currentConversation.isDirectMessage
        ? currentEndpoint.allowDirectMessages
        : nonDirectDestinationAllowed(currentEndpoint, currentResource);
      if (!destinationAllowed) return;
      const authorization = await lockCurrentPrincipalAuthorization(
        tx,
        currentEndpoint,
        principal.principal.id,
      );
      if (!authorization.allowed) return;
      await tx
        .insert(chatDeliveries)
        .values({
          companyId: record.endpoint.companyId,
          endpointId: event.endpointId,
          conversationId: conversation.id,
          principalId: principal.principal.id,
          providerEventId,
          deduplicationKey: createHash("sha256")
            .update(providerEventId)
            .digest("hex"),
          eventKind,
          normalizedEvent: {
            providerEventId,
            kind: eventKind,
            conversation: { externalThreadId: event.event.threadId },
            message: { providerMessageId: event.event.messageId },
            reaction: {
              emoji: event.event.emoji.name,
              rawEmoji: event.event.rawEmoji,
              added: event.event.added,
            },
          },
          state: "processed",
          attempts: 1,
          processedAt: new Date(),
        })
        .onConflictDoNothing();
    });
  }

  async function denyExternalAction(
    endpoint: EndpointRow,
    event: ChatSdkCallbackEvent<ActionEvent>,
    runtimeContext: LifecycleRuntimeFence,
    safelyKnown: {
      conversationId?: string | null;
      principalId?: string | null;
    } = {},
  ): Promise<void> {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          endpoint.id,
          event.provider,
          event.event.threadId,
          event.event.messageId,
          event.event.user.userId,
          event.event.actionId,
        ]),
      )
      .digest("hex");
    const providerEventId = `action-denied:${fingerprint}`;
    const processedAt = new Date();
    const actionThread = event.event.thread;
    const effectPayload =
      actionThread &&
      typeof actionThread.postEphemeral === "function" &&
      CAPABILITIES[endpoint.provider].ephemeralMessages
        ? ({
            version: 1,
            effect: "ephemeral_message",
            authorizationMode: "safe_notice",
            threadId: event.event.threadId,
            userId: event.event.user.userId,
            text: "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
            fallbackText: "This Paperclip action is no longer available.",
            settleDelivery: false,
          } as const)
        : actionThread && endpoint.provider === "telegram"
          ? ({
              version: 1,
              effect: "thread_message",
              authorizationMode: "safe_notice",
              threadId: event.event.threadId,
              text: "This Paperclip action is no longer available.",
              settleDelivery: false,
            } as const)
          : null;
    let effect: typeof chatActions.$inferSelect | null = null;
    try {
      effect = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(chatDeliveries)
          .values({
            companyId: endpoint.companyId,
            endpointId: endpoint.id,
            conversationId: safelyKnown.conversationId ?? null,
            principalId: safelyKnown.principalId ?? null,
            providerEventId,
            deduplicationKey: fingerprint,
            eventKind: "action",
            normalizedEvent: {
              providerEventId,
              kind: "action",
              authorization: { outcome: "denied" },
            },
            state: "filtered",
            attempts: 1,
            redactedError: "External action denied by Paperclip authorization",
            processedAt,
            updatedAt: processedAt,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted || !effectPayload) return null;
        return stageProviderEffect(tx, {
          endpoint,
          deliveryId: inserted.id,
          conversationId: safelyKnown.conversationId ?? null,
          principalId: safelyKnown.principalId ?? null,
          providerActionId: `provider_effect:${providerEventId}`,
          payload: effectPayload,
          runtimeContext,
        });
      });
    } catch (error) {
      logger.warn(
        {
          endpointId: endpoint.id,
          provider: endpoint.provider,
          error: redactError(error),
        },
        "could not record denied external chat action",
      );
      // Provider retries are useful only while the authoritative denial could
      // not be recorded. Once the filtered delivery exists, a policy denial
      // is a successfully handled webhook and must not be surfaced as a
      // callback failure (which the Chat SDK correctly converts to a 503).
      throw error;
    }
    if (effect && actionThread) {
      // The callback is acknowledged after the authoritative denial and its
      // provider effect are durable. Slow provider I/O runs out of band; a
      // redelivery finds the same action and cannot enqueue another notice.
      scheduleProviderEffect(effect.id, actionThread);
    }
  }

  async function settleTerminalConfirmationAction(
    actionId: string,
  ): Promise<boolean> {
    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "confirmation_response"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (action?.status === "processed") return true;
    if (!action || action.status !== "processing" || !action.conversationId)
      return false;
    const token = action.payload;
    if (
      token.version !== 1 ||
      typeof token.publicationId !== "string" ||
      typeof token.interactionId !== "string" ||
      (token.decision !== "accept" && token.decision !== "reject")
    ) {
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: { code: "confirmation_action_payload_invalid" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        );
      return false;
    }
    const [conversation, publication, endpoint] = await Promise.all([
      db
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.companyId, action.companyId),
            eq(chatConversations.endpointId, action.endpointId),
            eq(chatConversations.id, action.conversationId),
          ),
        )
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, action.companyId),
            eq(chatPublications.endpointId, action.endpointId),
            eq(chatPublications.id, token.publicationId as string),
          ),
        )
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(chatEndpoints)
        .where(
          and(
            eq(chatEndpoints.companyId, action.companyId),
            eq(chatEndpoints.id, action.endpointId),
          ),
        )
        .then((rows) => rows[0] ?? null),
    ]);
    if (
      !conversation ||
      !publication ||
      !endpoint ||
      endpoint.provider !== "telegram" ||
      publication.conversationId !== conversation.id ||
      publication.payload.interactionId !== token.interactionId
    ) {
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: { code: "confirmation_action_binding_invalid" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        );
      return false;
    }
    const interaction = (
      await issueThreadInteractionService(db).listForIssue(conversation.issueId)
    ).find((candidate) => candidate.id === token.interactionId);
    if (
      !interaction ||
      interaction.kind !== "request_confirmation" ||
      !nativeTelegramConfirmation(interaction)
    ) {
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: { code: "confirmation_interaction_invalid" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        );
      return false;
    }
    if (
      interaction.status !== "accepted" &&
      interaction.status !== "rejected"
    ) {
      if (interaction.status === "pending") return false;
      const [retired] = await db
        .update(chatActions)
        .set({
          status: "expired",
          result: {
            code: "confirmation_interaction_resolved_elsewhere",
            interactionId: interaction.id,
            interactionStatus: interaction.status,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        )
        .returning({ id: chatActions.id });
      if (retired) return true;
      const winner = await db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, action.id))
        .then((rows) => rows[0] ?? null);
      return winner?.status === "expired" || winner?.status === "processed";
    }
    const decisionMatches =
      (token.decision === "accept" && interaction.status === "accepted") ||
      (token.decision === "reject" && interaction.status === "rejected");
    if (!decisionMatches) {
      await db
        .update(chatActions)
        .set({
          status: "expired",
          result: { code: "interaction_resolved_by_sibling_action" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        );
      return false;
    }
    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, action.companyId),
          eq(issues.id, conversation.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!issue || !interaction.resolvedByUserId) {
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: { code: "confirmation_resolution_context_missing" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        );
      return false;
    }
    const resolvedByUserId = interaction.resolvedByUserId;
    const shouldWake =
      Boolean(issue.assigneeAgentId) &&
      issue.status !== "done" &&
      issue.status !== "cancelled" &&
      (interaction.continuationPolicy === "wake_assignee" ||
        (interaction.continuationPolicy === "wake_assignee_on_accept" &&
          interaction.status === "accepted"));
    const resolutionLabel =
      interaction.status === "accepted" ? "Accepted" : "Rejected";
    const resolvedByThisProviderAction =
      action.result?.code === "confirmation_resolution_committed_by_provider";
    return db.transaction(async (tx) => {
      const [completed] = await tx
        .update(chatActions)
        .set({
          status: "processed",
          result: {
            code: resolvedByThisProviderAction
              ? "confirmation_resolution_committed_by_provider"
              : "confirmation_resolution_reconciled",
            interactionId: interaction.id,
            interactionStatus: interaction.status,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        )
        .returning({ id: chatActions.id });
      if (!completed) {
        // A publication sweep may reconcile the durable action while the
        // original provider callback is still in flight. Treat that CAS loss
        // as success once the winner has processed the same action so the
        // provider does not receive a spurious 5xx and redeliver it.
        const winner = await tx
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(eq(chatActions.id, action.id))
          .then((rows) => rows[0] ?? null);
        return winner?.status === "processed";
      }
      await tx
        .update(chatActions)
        .set({
          status: "expired",
          result: { code: "interaction_resolved_by_sibling_action" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.companyId, issue.companyId),
            eq(chatActions.endpointId, action.endpointId),
            eq(chatActions.conversationId, conversation.id),
            eq(chatActions.kind, "confirmation_response"),
            inArray(chatActions.status, ["issued", "processing"]),
            ne(chatActions.id, action.id),
            eq(
              sql<string>`${chatActions.payload}->>'interactionId'`,
              interaction.id,
            ),
          ),
        );
      await tx
        .insert(chatPublications)
        .values({
          companyId: issue.companyId,
          endpointId: action.endpointId,
          conversationId: conversation.id,
          issueId: issue.id,
          idempotencyKey: `interaction-resolution:${interaction.id}:${action.endpointId}`,
          payload: projectSafeChatPublication({
            classification: "external",
            source: "issue_interaction",
            text: `${resolutionLabel}: ${interaction.payload.prompt}`,
            interaction: {
              id: interaction.id,
              card: {
                kind: "confirmation",
                title: interaction.payload.prompt,
                body: resolutionLabel,
                actions: [],
              },
            },
          }),
          state: "pending",
        })
        .onConflictDoNothing();
      if (shouldWake && issue.assigneeAgentId) {
        await tx
          .insert(chatActions)
          .values({
            companyId: issue.companyId,
            endpointId: action.endpointId,
            conversationId: conversation.id,
            principalId: action.principalId,
            kind: "interaction_wakeup",
            providerActionId: `interaction_wakeup:${interaction.id}`,
            payload: {
              version: 1,
              interactionId: interaction.id,
              interactionKind: interaction.kind,
              interactionStatus: interaction.status,
              issueId: issue.id,
              agentId: issue.assigneeAgentId,
              sourceCommentId: interaction.sourceCommentId ?? null,
              sourceRunId: interaction.sourceRunId ?? null,
              requestedByUserId: resolvedByUserId,
              requestedByActorType: "user",
              requestedByActorId: resolvedByUserId,
            },
            status: "issued",
          })
          .onConflictDoNothing();
      }
      // A provider callback can lose the pending -> terminal interaction race
      // to the Paperclip UI. In that case this transaction only retires the
      // now-redundant provider action and must not fabricate a second external
      // resolution event attributed to the board winner.
      if (resolvedByThisProviderAction) {
        await logActivity(tx as unknown as Db, {
          companyId: issue.companyId,
          actorType: "user",
          actorId: resolvedByUserId,
          action:
            interaction.status === "accepted"
              ? "issue.thread_interaction_accepted"
              : "issue.thread_interaction_rejected",
          entityType: "issue",
          entityId: issue.id,
          details: {
            source: "external_chat",
            endpointId: action.endpointId,
            provider: endpoint.provider,
            conversationId: conversation.id,
            publicationId: publication.id,
            providerMessageId: publication.providerMessageId,
            interactionId: interaction.id,
            interactionKind: interaction.kind,
            interactionStatus: interaction.status,
            resolutionActorKind: "user",
            requestedResolverPolicy: interaction.requestedResolverPolicy,
            effectiveResolverPolicy: interaction.effectiveResolverPolicy,
          },
        });
      }
      return true;
    });
  }

  async function reconcileTerminalConfirmationActions(
    limit = 100,
  ): Promise<number> {
    const candidates = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, "confirmation_response"),
          eq(chatActions.status, "processing"),
        ),
      )
      .orderBy(asc(chatActions.updatedAt), asc(chatActions.id))
      .limit(limit);
    let settled = 0;
    for (const candidate of candidates) {
      if (await settleTerminalConfirmationAction(candidate.id)) settled += 1;
    }
    return settled;
  }

  async function processPendingInteractionWakeups(
    limit = 100,
  ): Promise<number> {
    const staleBefore = new Date(Date.now() - 30_000);
    const retryBefore = new Date(
      Date.now() - CONFIRMATION_WAKEUP_RETRY_BACKOFF_MS,
    );
    const candidates = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, "interaction_wakeup"),
          or(
            and(
              eq(chatActions.status, "issued"),
              or(
                isNull(chatActions.result),
                lte(chatActions.updatedAt, retryBefore),
              ),
            ),
            and(
              eq(chatActions.status, "processing"),
              lte(chatActions.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .orderBy(asc(chatActions.updatedAt), asc(chatActions.id))
      .limit(limit);
    let processed = 0;
    for (const candidate of candidates) {
      const [claimed] = await db
        .update(chatActions)
        .set({ status: "processing", updatedAt: new Date() })
        .where(
          and(
            eq(chatActions.id, candidate.id),
            or(
              and(
                eq(chatActions.status, "issued"),
                or(
                  isNull(chatActions.result),
                  lte(chatActions.updatedAt, retryBefore),
                ),
              ),
              and(
                eq(chatActions.status, "processing"),
                lte(chatActions.updatedAt, staleBefore),
              ),
            ),
          ),
        )
        .returning();
      if (!claimed) continue;
      const payload = claimed.payload;
      const requestedByActorType =
        payload.requestedByActorType === "user" ||
        payload.requestedByActorType === "agent" ||
        payload.requestedByActorType === "system"
          ? payload.requestedByActorType
          : typeof payload.requestedByUserId === "string"
            ? "user"
            : null;
      const requestedByActorId =
        typeof payload.requestedByActorId === "string"
          ? payload.requestedByActorId
          : typeof payload.requestedByUserId === "string"
            ? payload.requestedByUserId
            : null;
      if (
        payload.version !== 1 ||
        typeof payload.interactionId !== "string" ||
        typeof payload.interactionKind !== "string" ||
        !["accepted", "rejected", "answered", "cancelled", "failed"].includes(
          String(payload.interactionStatus),
        ) ||
        typeof payload.issueId !== "string" ||
        typeof payload.agentId !== "string" ||
        !requestedByActorType ||
        !requestedByActorId
      ) {
        await db
          .update(chatActions)
          .set({
            status: "failed",
            result: { code: "interaction_wakeup_payload_invalid" },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, claimed.id),
              eq(chatActions.status, "processing"),
            ),
          );
        continue;
      }
      const currentIssue = await db
        .select({
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, claimed.companyId),
            eq(issues.id, payload.issueId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const currentInteraction = currentIssue
        ? (
            await issueThreadInteractionService(db).listForIssue(
              payload.issueId,
            )
          ).find((interaction) => interaction.id === payload.interactionId)
        : null;
      if (
        !currentIssue ||
        !currentInteraction ||
        currentInteraction.companyId !== claimed.companyId ||
        currentInteraction.kind !== payload.interactionKind ||
        currentInteraction.status !== payload.interactionStatus ||
        currentIssue.assigneeAgentId !== payload.agentId ||
        currentIssue.status === "done" ||
        currentIssue.status === "cancelled"
      ) {
        await db
          .update(chatActions)
          .set({
            status: "processed",
            result: { code: "interaction_wakeup_no_longer_applicable" },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, claimed.id),
              eq(chatActions.status, "processing"),
            ),
          );
        processed += 1;
        continue;
      }
      const idempotencyKey = `interaction:${payload.interactionId}:${payload.interactionStatus}`;
      try {
        const sourceCommentId = currentInteraction.sourceCommentId ?? null;
        const sourceRunId = currentInteraction.sourceRunId ?? null;
        // A resolved interaction is still part of the originating external
        // turn. Preserve one verified inbound comment edge on the continuation
        // run so queued/working/failure milestones return to this exact
        // endpoint and conversation instead of disappearing as an internal
        // automation run.
        const chatOrigin = claimed.conversationId
          ? await db
              .select({
                commentId: chatMessageLinks.commentId,
                provider: chatEndpoints.provider,
              })
              .from(chatEndpoints)
              .innerJoin(
                chatMessageLinks,
                and(
                  eq(chatMessageLinks.companyId, chatEndpoints.companyId),
                  eq(chatMessageLinks.endpointId, chatEndpoints.id),
                ),
              )
              .where(
                and(
                  eq(chatEndpoints.companyId, claimed.companyId),
                  eq(chatEndpoints.id, claimed.endpointId),
                  eq(chatMessageLinks.conversationId, claimed.conversationId),
                  eq(chatMessageLinks.direction, "inbound"),
                  isNotNull(chatMessageLinks.commentId),
                ),
              )
              .orderBy(
                desc(chatMessageLinks.createdAt),
                desc(chatMessageLinks.id),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        const wakeCommentId = sourceCommentId ?? chatOrigin?.commentId ?? null;
        const existing = await db
          .select({
            agentId: agentWakeupRequests.agentId,
            id: agentWakeupRequests.id,
          })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, claimed.companyId),
              eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
              notInArray(agentWakeupRequests.status, [
                "skipped",
                "failed",
                "cancelled",
              ]),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const queuedRun = !existing
          ? await options.heartbeat.wakeup(payload.agentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "issue_commented",
              payload: {
                issueId: payload.issueId,
                interactionId: payload.interactionId,
                interactionKind: payload.interactionKind,
                interactionStatus: payload.interactionStatus,
                sourceCommentId,
                sourceRunId,
                ...(wakeCommentId
                  ? {
                      wakeCommentId,
                      wakeCommentIds: [wakeCommentId],
                    }
                  : {}),
                ...(payload.planReviewInteraction &&
                typeof payload.planReviewInteraction === "object"
                  ? { planReviewInteraction: payload.planReviewInteraction }
                  : {}),
                mutation: "interaction",
              },
              idempotencyKey,
              allowRunCoalescing: false,
              requestedByActorType,
              requestedByActorId,
              contextSnapshot: {
                issueId: payload.issueId,
                taskId: payload.issueId,
                interactionId: payload.interactionId,
                interactionKind: payload.interactionKind,
                interactionStatus: payload.interactionStatus,
                sourceCommentId,
                sourceRunId,
                ...(payload.planReviewInteraction &&
                typeof payload.planReviewInteraction === "object"
                  ? { planReviewInteraction: payload.planReviewInteraction }
                  : {}),
                wakeReason: "issue_commented",
                source: chatOrigin
                  ? `chat:${chatOrigin.provider}`
                  : "external_chat.interaction.resolve",
                ...(wakeCommentId
                  ? {
                      wakeCommentId,
                      wakeCommentIds: [wakeCommentId],
                    }
                  : {}),
                ...(payload.forceFreshSession === true
                  ? { forceFreshSession: true }
                  : {}),
                ...(typeof payload.workspaceRefreshReason === "string"
                  ? {
                      workspaceRefreshReason: payload.workspaceRefreshReason,
                    }
                  : {}),
              },
            })
          : null;
        const durable =
          existing ??
          (await db
            .select({
              agentId: agentWakeupRequests.agentId,
              id: agentWakeupRequests.id,
            })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, claimed.companyId),
                eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
                notInArray(agentWakeupRequests.status, [
                  "skipped",
                  "failed",
                  "cancelled",
                ]),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null));
        if (!queuedRun && !durable) {
          await db
            .update(chatActions)
            .set({
              status: "issued",
              result: { code: "interaction_wakeup_deferred" },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, claimed.id),
                eq(chatActions.status, "processing"),
              ),
            );
          continue;
        }
        await db
          .update(chatActions)
          .set({
            status: "processed",
            result: {
              code: durable
                ? durable.agentId === payload.agentId
                  ? "interaction_wakeup_already_durable"
                  : "interaction_wakeup_coalesced_after_reassignment"
                : "interaction_wakeup_queued",
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, claimed.id),
              eq(chatActions.status, "processing"),
            ),
          );
        processed += 1;
      } catch (error) {
        const durable = isUniqueViolation(error)
          ? await db
              .select({
                agentId: agentWakeupRequests.agentId,
                id: agentWakeupRequests.id,
              })
              .from(agentWakeupRequests)
              .where(
                and(
                  eq(agentWakeupRequests.companyId, claimed.companyId),
                  eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
                  notInArray(agentWakeupRequests.status, [
                    "skipped",
                    "failed",
                    "cancelled",
                  ]),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        const previousResult =
          claimed.result && typeof claimed.result === "object"
            ? (claimed.result as Record<string, unknown>)
            : {};
        const previousAttempts =
          typeof previousResult.attemptCount === "number" &&
          Number.isInteger(previousResult.attemptCount) &&
          previousResult.attemptCount >= 0
            ? previousResult.attemptCount
            : 0;
        const attemptCount = previousAttempts + 1;
        await db
          .update(chatActions)
          .set({
            status: durable ? "processed" : "issued",
            result: {
              code: durable
                ? durable.agentId === payload.agentId
                  ? "interaction_wakeup_already_durable"
                  : "interaction_wakeup_coalesced_after_reassignment"
                : "interaction_wakeup_failed",
              ...(!durable ? { attemptCount } : {}),
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, claimed.id),
              eq(chatActions.status, "processing"),
            ),
          );
        if (!durable) {
          logger.warn(
            {
              endpointId: claimed.endpointId,
              interactionId: payload.interactionId,
              attemptCount,
              error: redactError(error),
            },
            "failed to queue external interaction continuation wake",
          );
        }
      }
    }
    return processed;
  }

  async function handleAction(
    event: ChatSdkCallbackEvent<ActionEvent>,
    runtimeContext: RuntimeContext,
  ) {
    const record = await runtimeCallbackRecord(
      event.endpointId,
      runtimeContext,
      ["active"],
    );
    if (!record) {
      throw forbidden("This chat action is not a current Paperclip question");
    }
    const deny = (safelyKnown?: {
      conversationId?: string | null;
      principalId?: string | null;
    }) =>
      denyExternalAction(record.endpoint, event, runtimeContext, safelyKnown);
    if (
      record.endpoint.status !== "active" ||
      record.endpoint.provider !== event.provider ||
      record.endpoint.capabilities.actions !== true
    ) {
      return deny();
    }
    const principal = await ensurePrincipal(
      record.endpoint,
      event.event.user,
      event.event.raw,
    );
    // Executable external actions are deliberately stricter than ordinary
    // sponsored-guest messages. They require a current endpoint-scoped link to
    // an active non-viewer Paperclip member, and never run as a guest sponsor.
    if (
      principal.linkedDenied ||
      !principal.userId ||
      principal.principal.kind !== "user" ||
      principal.principal.isBot
    ) {
      return deny({ principalId: principal.principal.id });
    }
    const actionBinding = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, record.endpoint.companyId),
          eq(chatActions.endpointId, record.endpoint.id),
          inArray(chatActions.kind, [
            "question_answer",
            "question_form_open",
            "confirmation_response",
          ]),
          eq(chatActions.providerActionId, event.event.actionId),
        ),
      )
      .then((rows) => (rows.length === 1 ? rows[0]! : null));
    const originalPublicationId = actionBinding?.payload.publicationId;
    const actionInteractionId = actionBinding?.payload.interactionId;
    if (
      !actionBinding?.conversationId ||
      typeof originalPublicationId !== "string" ||
      typeof actionInteractionId !== "string"
    ) {
      return deny({ principalId: principal.principal.id });
    }
    // The opaque provider action is the immutable link to the original
    // publication. Resolve the conversation from that token, then verify the
    // provider's thread independently; never trust a callback message id to
    // select a Paperclip task.
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, record.endpoint.companyId),
          eq(chatConversations.endpointId, record.endpoint.id),
          eq(chatConversations.id, actionBinding.conversationId),
          inArray(chatConversations.state, ["active", "waiting"]),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (
      !conversation ||
      !actionThreadMatchesConversation(
        event.provider,
        event.event.threadId,
        conversation.externalThreadId,
      )
    ) {
      return deny({ principalId: principal.principal.id });
    }
    const safelyKnown = {
      conversationId: conversation.id,
      principalId: principal.principal.id,
    };
    const resource = conversation.resourceId
      ? await db
          .select()
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.companyId, record.endpoint.companyId),
              eq(chatEndpointResources.endpointId, record.endpoint.id),
              eq(chatEndpointResources.id, conversation.resourceId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const resourceAllowed = conversation.isDirectMessage
      ? record.endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(record.endpoint, resource);
    if (!resourceAllowed) return deny(safelyKnown);

    let originalPublication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, record.endpoint.companyId),
          eq(chatPublications.endpointId, record.endpoint.id),
          eq(chatPublications.conversationId, conversation.id),
          eq(chatPublications.issueId, conversation.issueId),
          eq(chatPublications.id, originalPublicationId),
          inArray(chatPublications.state, ["published", "delivery_unknown"]),
          or(
            isNull(chatPublications.providerMessageId),
            eq(chatPublications.providerMessageId, event.event.messageId),
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!originalPublication) return deny(safelyKnown);
    if (!originalPublication.providerMessageId) {
      const reconciledPublication = await db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.id, originalPublicationId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !current ||
          current.companyId !== record.endpoint.companyId ||
          current.endpointId !== record.endpoint.id ||
          current.conversationId !== conversation.id ||
          current.issueId !== conversation.issueId ||
          !["published", "delivery_unknown"].includes(current.state) ||
          (current.providerMessageId !== null &&
            current.providerMessageId !== event.event.messageId)
        ) {
          return null;
        }
        const occupied = await tx
          .select({ publicationId: chatMessageLinks.publicationId })
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.endpointId, record.endpoint.id),
              eq(chatMessageLinks.conversationId, conversation.id),
              eq(chatMessageLinks.providerMessageId, event.event.messageId),
              eq(chatMessageLinks.direction, "outbound"),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (occupied && occupied.publicationId !== current.id) return null;
        const reconciledAt = new Date();
        const [reconciled] = await tx
          .update(chatPublications)
          .set({
            state: "published",
            providerMessageId: event.event.messageId,
            publishedAt: current.publishedAt ?? reconciledAt,
            nextAttemptAt: null,
            redactedError: null,
            updatedAt: reconciledAt,
          })
          .where(
            and(
              eq(chatPublications.id, current.id),
              inArray(chatPublications.state, [
                "published",
                "delivery_unknown",
              ]),
              isNull(chatPublications.providerMessageId),
            ),
          )
          .returning();
        if (!reconciled) return null;
        await tx
          .insert(chatMessageLinks)
          .values({
            companyId: current.companyId,
            endpointId: current.endpointId,
            conversationId: current.conversationId,
            publicationId: current.id,
            commentId: current.commentId,
            providerMessageId: event.event.messageId,
            direction: "outbound",
          })
          .onConflictDoNothing();
        const linked = await tx
          .select({ publicationId: chatMessageLinks.publicationId })
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.endpointId, record.endpoint.id),
              eq(chatMessageLinks.conversationId, conversation.id),
              eq(chatMessageLinks.providerMessageId, event.event.messageId),
              eq(chatMessageLinks.direction, "outbound"),
            ),
          )
          .then((rows) => rows[0] ?? null);
        return linked?.publicationId === reconciled.id ? reconciled : null;
      });
      if (!reconciledPublication) return deny(safelyKnown);
      originalPublication = reconciledPublication;
    }
    const messageBinding = await db
      .select({
        link: chatMessageLinks,
        linkedPublication: chatPublications,
      })
      .from(chatMessageLinks)
      .innerJoin(
        chatPublications,
        and(
          eq(chatPublications.companyId, chatMessageLinks.companyId),
          eq(chatPublications.endpointId, chatMessageLinks.endpointId),
          eq(chatPublications.conversationId, chatMessageLinks.conversationId),
          eq(chatPublications.id, chatMessageLinks.publicationId),
        ),
      )
      .where(
        and(
          eq(chatMessageLinks.companyId, record.endpoint.companyId),
          eq(chatMessageLinks.endpointId, record.endpoint.id),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.providerMessageId, event.event.messageId),
          eq(chatMessageLinks.direction, "outbound"),
          eq(chatPublications.issueId, conversation.issueId),
          eq(chatPublications.state, "published"),
          eq(chatPublications.providerMessageId, event.event.messageId),
        ),
      )
      .then((rows) => (rows.length === 1 ? rows[0]! : null));
    if (!messageBinding) return deny(safelyKnown);
    const linkedPayload = messageBinding.linkedPublication
      .payload as SafeChatPublicationPayload;
    const linkStillAuthoritative =
      messageBinding.link.publicationId === originalPublicationId ||
      (messageBinding.linkedPublication.idempotencyKey ===
        `interaction-resolution:${actionInteractionId}:${record.endpoint.id}` &&
        linkedPayload.interactionId === actionInteractionId);
    if (!originalPublication || !linkStillAuthoritative) {
      return deny(safelyKnown);
    }
    const issued = {
      publication: originalPublication,
      link: messageBinding.link,
      conversation,
    };

    const payload = issued.publication.payload as SafeChatPublicationPayload;
    if (event.provider === "telegram") {
      const raw = event.event.raw;
      const callbackData =
        raw && typeof raw === "object" && "data" in raw
          ? (raw as { data?: unknown }).data
          : null;
      if (
        typeof callbackData !== "string" ||
        Buffer.byteLength(callbackData, "utf8") >
          TELEGRAM_CALLBACK_DATA_LIMIT_BYTES ||
        callbackData !== telegramChatSdkCallbackData(event.event.actionId) ||
        event.event.value !== undefined
      ) {
        return deny(safelyKnown);
      }
    }
    if (
      !payload.interactionId ||
      (event.provider !== "telegram" &&
        event.event.value !== payload.interactionId) ||
      !payload.card?.actions?.some(
        (action) =>
          action.type === "callback" &&
          action.actionId === event.event.actionId,
      )
    ) {
      return deny(safelyKnown);
    }

    const interaction = (
      await issueThreadInteractionService(db).listForIssue(conversation.issueId)
    ).find((candidate) => candidate.id === payload.interactionId);
    if (
      !interaction ||
      interaction.companyId !== record.endpoint.companyId ||
      interaction.issueId !== conversation.issueId
    ) {
      return deny(safelyKnown);
    }
    if (interaction.status !== "pending") {
      const completedAction = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.companyId, record.endpoint.companyId),
            eq(chatActions.endpointId, record.endpoint.id),
            eq(chatActions.conversationId, conversation.id),
            eq(chatActions.providerActionId, event.event.actionId),
            eq(chatActions.principalId, principal.principal.id),
            eq(chatActions.status, "processed"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const completedPayload = completedAction?.payload;
      const completedResult = completedAction?.result;
      const completedResultMatches =
        completedResult?.interactionId === interaction.id &&
        completedResult?.interactionStatus === interaction.status &&
        (interaction.kind !== "request_confirmation" ||
          completedResult.code ===
            "confirmation_resolution_committed_by_provider");
      if (
        completedAction &&
        completedResultMatches &&
        completedPayload?.publicationId === issued.publication.id &&
        completedPayload?.interactionId === interaction.id &&
        completedPayload?.messageId === event.event.messageId &&
        completedPayload?.actionId === event.event.actionId
      ) {
        return;
      }
      return deny(safelyKnown);
    }
    if (interaction.kind === "request_confirmation") {
      if (
        event.provider !== "telegram" ||
        !nativeTelegramConfirmation(interaction)
      ) {
        return deny(safelyKnown);
      }
      const action = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.companyId, record.endpoint.companyId),
            eq(chatActions.endpointId, record.endpoint.id),
            eq(chatActions.conversationId, conversation.id),
            eq(chatActions.kind, "confirmation_response"),
            eq(chatActions.providerActionId, event.event.actionId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!action || action.status !== "issued") return deny(safelyKnown);
      const tokenPayload = action.payload;
      const tokenExpiresAt =
        typeof tokenPayload.expiresAt === "string"
          ? Date.parse(tokenPayload.expiresAt)
          : Number.NaN;
      if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= Date.now()) {
        await db
          .update(chatActions)
          .set({
            status: "expired",
            result: { code: "confirmation_action_token_expired" },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, action.id),
              eq(chatActions.status, "issued"),
            ),
          );
        return deny(safelyKnown);
      }
      if (
        tokenPayload.version !== 1 ||
        tokenPayload.publicationId !== issued.publication.id ||
        tokenPayload.interactionId !== interaction.id ||
        (tokenPayload.decision !== "accept" &&
          tokenPayload.decision !== "reject")
      ) {
        return deny(safelyKnown);
      }

      const issue = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          goalId: issues.goalId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, record.endpoint.companyId),
            eq(issues.id, conversation.issueId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!issue) {
        return deny(safelyKnown);
      }

      const decision = tokenPayload.decision;
      try {
        if (decision === "accept") {
          await issueThreadInteractionService(db).acceptInteraction(
            issue,
            interaction.id,
            {},
            { userId: principal.userId },
            {
              beforeResolveInTransaction: async (tx) => {
                await requireCurrentExternalActionAuthorization(tx, {
                  conversationId: conversation.id,
                  endpointId: record.endpoint.id,
                  expectedUserId: principal.userId!,
                  principalId: principal.principal.id,
                  runtimeContext,
                });
              },
              afterResolveInTransaction: async (tx, resolved) => {
                const [owned] = await tx
                  .update(chatActions)
                  .set({
                    principalId: principal.principal.id,
                    status: "processing",
                    payload: {
                      ...tokenPayload,
                      messageId: event.event.messageId,
                      actionId: event.event.actionId,
                      value: null,
                    },
                    result: {
                      code: "confirmation_resolution_committed_by_provider",
                      interactionId: resolved.id,
                      interactionStatus: resolved.status,
                    },
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(chatActions.id, action.id),
                      eq(chatActions.status, "issued"),
                    ),
                  )
                  .returning({ id: chatActions.id });
                if (!owned) {
                  throw new Error(
                    "External confirmation action ownership changed before interaction commit",
                  );
                }
              },
            },
          );
        } else {
          await issueThreadInteractionService(db).rejectInteraction(
            issue,
            interaction.id,
            {},
            { userId: principal.userId },
            {
              beforeResolveInTransaction: async (tx) => {
                await requireCurrentExternalActionAuthorization(tx, {
                  conversationId: conversation.id,
                  endpointId: record.endpoint.id,
                  expectedUserId: principal.userId!,
                  principalId: principal.principal.id,
                  runtimeContext,
                });
              },
              afterResolveInTransaction: async (tx, resolved) => {
                const [owned] = await tx
                  .update(chatActions)
                  .set({
                    principalId: principal.principal.id,
                    status: "processing",
                    payload: {
                      ...tokenPayload,
                      messageId: event.event.messageId,
                      actionId: event.event.actionId,
                      value: null,
                    },
                    result: {
                      code: "confirmation_resolution_committed_by_provider",
                      interactionId: resolved.id,
                      interactionStatus: resolved.status,
                    },
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(chatActions.id, action.id),
                      eq(chatActions.status, "issued"),
                    ),
                  )
                  .returning({ id: chatActions.id });
                if (!owned) {
                  throw new Error(
                    "External confirmation action ownership changed before interaction commit",
                  );
                }
              },
            },
          );
        }
      } catch (error) {
        if (isExternalActionAuthorizationChange(error)) {
          return deny(safelyKnown);
        }
        const currentStatus = await db
          .select({ status: issueThreadInteractions.status })
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, interaction.id))
          .then((rows) => rows[0]?.status ?? null);
        if (currentStatus !== null && currentStatus !== "pending") {
          await settleTerminalConfirmationAction(action.id);
          const completedAction = await db
            .select({ status: chatActions.status, result: chatActions.result })
            .from(chatActions)
            .where(eq(chatActions.id, action.id))
            .then((rows) => rows[0] ?? null);
          if (
            completedAction?.status === "processed" &&
            completedAction.result?.code ===
              "confirmation_resolution_committed_by_provider"
          ) {
            return;
          }
          return deny(safelyKnown);
        }
        throw error;
      }

      await options.confirmationResolutionPersistBarrier?.();
      if (!(await settleTerminalConfirmationAction(action.id))) {
        throw new Error(
          "External confirmation action ownership changed before settlement",
        );
      }

      scheduleMessageProcessing(async () => {
        await processPendingPublications();
      });
      return;
    }
    if (interaction.kind !== "ask_user_questions") {
      return deny(safelyKnown);
    }
    if (isChatQuestionFormOpenActionId(event.event.actionId)) {
      if (event.provider !== "slack" && event.provider !== "microsoft-teams") {
        return deny(safelyKnown);
      }
      await options.questionFormOpenAuthorizationBarrier?.();
      try {
        const opened = await db.transaction(async (tx) => {
          await requireCurrentExternalActionAuthorization(tx, {
            conversationId: conversation.id,
            endpointId: record.endpoint.id,
            expectedUserId: principal.userId!,
            principalId: principal.principal.id,
            runtimeContext,
          });
          const resolved = await resolveChatQuestionFormOpen(tx, {
            companyId: record.endpoint.companyId,
            endpointId: record.endpoint.id,
            conversationId: conversation.id,
            interaction,
            openActionId: event.event.actionId,
          });
          if (!resolved || resolved.publicationId !== issued.publication.id) {
            return null;
          }
          return await event.event.openModal(resolved.modal);
        });
        if (!opened) return deny(safelyKnown);
      } catch (error) {
        if (isExternalActionAuthorizationChange(error)) {
          return deny(safelyKnown);
        }
        throw error;
      }
      return;
    }

    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, record.endpoint.companyId),
          eq(chatActions.endpointId, record.endpoint.id),
          eq(chatActions.conversationId, conversation.id),
          eq(chatActions.kind, "question_answer"),
          eq(chatActions.providerActionId, event.event.actionId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!action || action.status !== "issued") return deny(safelyKnown);
    const tokenPayload = action.payload;
    const tokenExpiresAt =
      typeof tokenPayload.expiresAt === "string"
        ? Date.parse(tokenPayload.expiresAt)
        : Number.NaN;
    if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= Date.now()) {
      await db
        .update(chatActions)
        .set({
          status: "expired",
          result: { code: "question_action_token_expired" },
          updatedAt: new Date(),
        })
        .where(
          and(eq(chatActions.id, action.id), eq(chatActions.status, "issued")),
        );
      return deny(safelyKnown);
    }
    if (
      tokenPayload.version !== 1 ||
      tokenPayload.publicationId !== issued.publication.id ||
      tokenPayload.interactionId !== payload.interactionId ||
      typeof tokenPayload.questionId !== "string" ||
      typeof tokenPayload.optionId !== "string"
    ) {
      return deny(safelyKnown);
    }

    const question = nativeChatQuestion(interaction);
    const option = question?.options.find(
      (candidate) => candidate.id === tokenPayload.optionId,
    );
    if (!question || question.id !== tokenPayload.questionId || !option)
      return deny(safelyKnown);

    await options.questionResolutionPersistBarrier?.();

    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, record.endpoint.companyId),
          eq(issues.id, conversation.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!issue) return deny(safelyKnown);
    try {
      const answered = await issueThreadInteractionService(db).answerQuestions(
        issue,
        interaction.id,
        {
          answers: [{ questionId: question.id, optionIds: [option.id] }],
        },
        { userId: principal.userId },
        {
          beforeResolveInTransaction: async (tx) => {
            await requireCurrentExternalActionAuthorization(tx, {
              conversationId: conversation.id,
              endpointId: record.endpoint.id,
              expectedUserId: principal.userId!,
              principalId: principal.principal.id,
              runtimeContext,
            });
          },
          afterResolveInTransaction: async (tx, resolved) => {
            const [completed] = await tx
              .update(chatActions)
              .set({
                principalId: principal.principal.id,
                status: "processed",
                payload: {
                  ...tokenPayload,
                  messageId: event.event.messageId,
                  actionId: event.event.actionId,
                  value: event.event.value ?? null,
                },
                result: {
                  interactionId: resolved.id,
                  interactionStatus: resolved.status,
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  eq(chatActions.status, "issued"),
                ),
              )
              .returning({ id: chatActions.id });
            if (!completed) {
              throw new Error(
                "External question action ownership changed before commit",
              );
            }
            await tx
              .update(chatActions)
              .set({
                status: "expired",
                result: { code: "interaction_resolved_by_sibling_action" },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.companyId, issue.companyId),
                  eq(chatActions.endpointId, record.endpoint.id),
                  eq(chatActions.conversationId, conversation.id),
                  eq(chatActions.kind, "question_answer"),
                  eq(chatActions.status, "issued"),
                  ne(chatActions.id, action.id),
                  eq(
                    sql<string>`${chatActions.payload}->>'interactionId'`,
                    resolved.id,
                  ),
                ),
              );
            await logActivity(tx as unknown as Db, {
              companyId: issue.companyId,
              actorType: "user",
              actorId: principal.userId!,
              action: "issue.thread_interaction_answered",
              entityType: "issue",
              entityId: issue.id,
              details: {
                source: "external_chat",
                endpointId: record.endpoint.id,
                provider: record.endpoint.provider,
                conversationId: conversation.id,
                publicationId: issued.publication.id,
                providerMessageId: event.event.messageId,
                interactionId: resolved.id,
                interactionKind: resolved.kind,
                interactionStatus: resolved.status,
                resolutionActorKind: "user",
                answeredQuestionCount: 1,
              },
            });
            await tx
              .insert(chatPublications)
              .values({
                companyId: issue.companyId,
                endpointId: record.endpoint.id,
                conversationId: conversation.id,
                issueId: issue.id,
                idempotencyKey: `interaction-resolution:${resolved.id}:${record.endpoint.id}`,
                payload: projectSafeChatPublication({
                  classification: "external",
                  source: "issue_interaction",
                  text: `Answered: ${option.label}.`,
                  interaction: {
                    id: resolved.id,
                    card: {
                      kind: "question",
                      title: question.prompt,
                      body: `Answered: ${option.label}.`,
                      actions: [],
                    },
                  },
                }),
                state: "pending",
              })
              .onConflictDoNothing();
          },
        },
      );
      scheduleMessageProcessing(async () => {
        await processPendingPublications();
      });
      // The interaction, provider token, and response-delivery receipt are
      // already durable. A provider callback must not wait for agent startup;
      // drain the outbox after acknowledging the provider callback.
      scheduleMessageProcessing(async () => {
        await questionResponses.deliver(answered.id);
      });
    } catch (error) {
      if (isExternalActionAuthorizationChange(error)) {
        return deny(safelyKnown);
      }
      // `answerQuestions` commits the interaction and this action in one
      // transaction, then performs a best-effort issue timestamp touch. If
      // that post-commit touch fails, the provider callback is nevertheless
      // durably complete. Do not corrupt the processed token to `failed` or
      // return a retryable webhook response that turns Telegram's redelivery
      // into a misleading stale-action notice.
      try {
        const raceResult = await db.transaction(async (tx) => {
          const currentAction = await tx
            .select({ status: chatActions.status })
            .from(chatActions)
            .where(eq(chatActions.id, action.id))
            .then((rows) => rows[0] ?? null);
          const currentInteraction = (
            await issueThreadInteractionService(
              tx as unknown as Db,
            ).listForIssue(issue.id)
          ).find((candidate) => candidate.id === interaction.id);
          if (currentInteraction && currentInteraction.status !== "pending") {
            await tx
              .update(chatActions)
              .set({
                status: "expired",
                result: { code: "interaction_resolved_elsewhere" },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  inArray(chatActions.status, ["issued", "processing"]),
                ),
              );
            await enqueueTerminalIssueInteractionChatPublications(
              tx,
              currentInteraction,
            );
            return { actionStatus: currentAction?.status, settledRace: true };
          }
          return { actionStatus: currentAction?.status, settledRace: false };
        });
        if (raceResult.actionStatus === "processed") {
          logger.warn(
            {
              endpointId: record.endpoint.id,
              interactionId: interaction.id,
              error: redactError(error),
            },
            "external chat question resolved but post-commit follow-up failed",
          );
          return;
        }
        if (raceResult.settledRace) {
          scheduleMessageProcessing(async () => {
            await processPendingPublications();
          });
          return;
        }
      } catch (recoveryError) {
        logger.warn(
          {
            endpointId: record.endpoint.id,
            interactionId: interaction.id,
            error: redactError(recoveryError),
          },
          "could not reconcile an external chat question after resolution failed",
        );
      }
      throw error;
    }
  }

  async function handleModalSubmit(
    event: ChatSdkCallbackEvent<ModalSubmitEvent>,
    runtimeContext: RuntimeContext,
  ): Promise<ModalResponse> {
    const deny = () =>
      forbidden("This chat form is not a current Paperclip question");
    const record = await runtimeCallbackRecord(
      event.endpointId,
      runtimeContext,
      ["active"],
    );
    if (
      !record ||
      record.endpoint.status !== "active" ||
      record.endpoint.provider !== event.provider ||
      record.endpoint.capabilities.modals !== true ||
      (event.provider !== "slack" && event.provider !== "microsoft-teams")
    ) {
      throw deny();
    }
    const loaded = await loadChatQuestionFormSubmissionToken(db, {
      callbackId: event.event.callbackId,
      companyId: record.endpoint.companyId,
      endpointId: record.endpoint.id,
      includeProcessed: true,
    });
    if (!loaded) throw deny();
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, record.endpoint.companyId),
          eq(chatConversations.endpointId, record.endpoint.id),
          eq(chatConversations.id, loaded.conversationId),
          inArray(chatConversations.state, ["active", "waiting"]),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (
      !conversation ||
      (event.event.relatedThread &&
        event.event.relatedThread.id !== conversation.externalThreadId)
    ) {
      throw deny();
    }
    const principal = await ensurePrincipal(
      record.endpoint,
      event.event.user,
      event.event.raw,
    );
    if (
      principal.linkedDenied ||
      !principal.userId ||
      principal.principal.kind !== "user" ||
      principal.principal.isBot
    ) {
      throw deny();
    }
    const resource = conversation.resourceId
      ? await db
          .select()
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.companyId, record.endpoint.companyId),
              eq(chatEndpointResources.endpointId, record.endpoint.id),
              eq(chatEndpointResources.id, conversation.resourceId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const resourceAllowed = conversation.isDirectMessage
      ? record.endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(record.endpoint, resource);
    if (!resourceAllowed) throw deny();

    const originalPublication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, record.endpoint.companyId),
          eq(chatPublications.endpointId, record.endpoint.id),
          eq(chatPublications.conversationId, conversation.id),
          eq(chatPublications.issueId, conversation.issueId),
          eq(chatPublications.id, loaded.publicationId),
          eq(chatPublications.state, "published"),
          event.event.relatedMessage
            ? eq(
                chatPublications.providerMessageId,
                event.event.relatedMessage.id,
              )
            : undefined,
        ),
      )
      .then((rows) => rows[0] ?? null);
    const providerMessageId =
      event.event.relatedMessage?.id ??
      originalPublication?.providerMessageId ??
      null;
    if (!originalPublication || !providerMessageId) throw deny();
    const currentMessageBinding = await db
      .select({
        link: chatMessageLinks,
        publication: chatPublications,
      })
      .from(chatMessageLinks)
      .innerJoin(
        chatPublications,
        and(
          eq(chatPublications.companyId, chatMessageLinks.companyId),
          eq(chatPublications.endpointId, chatMessageLinks.endpointId),
          eq(chatPublications.conversationId, chatMessageLinks.conversationId),
          eq(chatPublications.id, chatMessageLinks.publicationId),
        ),
      )
      .where(
        and(
          eq(chatMessageLinks.companyId, record.endpoint.companyId),
          eq(chatMessageLinks.endpointId, record.endpoint.id),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.providerMessageId, providerMessageId),
          eq(chatMessageLinks.direction, "outbound"),
          eq(chatPublications.issueId, conversation.issueId),
          eq(chatPublications.state, "published"),
          eq(chatPublications.providerMessageId, providerMessageId),
        ),
      )
      .then((rows) => (rows.length === 1 ? rows[0]! : null));
    const linkedPayload = currentMessageBinding?.publication.payload as
      SafeChatPublicationPayload | undefined;
    const linkStillAuthoritative =
      currentMessageBinding?.link.publicationId === originalPublication.id ||
      (currentMessageBinding?.publication.idempotencyKey ===
        `interaction-resolution:${loaded.interactionId}:${record.endpoint.id}` &&
        linkedPayload?.interactionId === loaded.interactionId);
    if (!currentMessageBinding || !linkStillAuthoritative) throw deny();
    const issued = {
      publication: originalPublication,
      link: currentMessageBinding.link,
    };
    const payload = issued.publication.payload as SafeChatPublicationPayload;
    if (payload.interactionId !== loaded.interactionId) throw deny();
    if (loaded.status === "processed") {
      if (
        loaded.principalId !== principal.principal.id ||
        loaded.result?.code !== "question_form_answered" ||
        loaded.result?.interactionId !== loaded.interactionId
      ) {
        throw deny();
      }
      return { action: "clear" };
    }
    const interaction = (
      await issueThreadInteractionService(db).listForIssue(conversation.issueId)
    ).find((candidate) => candidate.id === loaded.interactionId);
    if (
      !interaction ||
      interaction.companyId !== record.endpoint.companyId ||
      interaction.issueId !== conversation.issueId ||
      interaction.kind !== "ask_user_questions" ||
      interaction.status !== "pending"
    ) {
      throw deny();
    }
    const validation = validateChatQuestionFormSubmission({
      callbackId: event.event.callbackId,
      privateMetadata: event.event.privateMetadata,
      interaction,
      payload: loaded.payload,
      values: event.event.values,
    });
    if (!validation.ok) {
      if (validation.code === "invalid_form") {
        return { action: "errors", errors: validation.fieldErrors };
      }
      throw deny();
    }
    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, record.endpoint.companyId),
          eq(issues.id, conversation.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!issue) throw deny();
    await options.questionResolutionPersistBarrier?.();
    let answered: Awaited<
      ReturnType<
        ReturnType<typeof issueThreadInteractionService>["answerQuestions"]
      >
    >;
    try {
      answered = await issueThreadInteractionService(db).answerQuestions(
        issue,
        interaction.id,
        { answers: validation.answers },
        { userId: principal.userId },
        {
          beforeResolveInTransaction: async (tx) => {
            await requireCurrentExternalActionAuthorization(tx, {
              conversationId: conversation.id,
              endpointId: event.endpointId,
              expectedUserId: principal.userId!,
              principalId: principal.principal.id,
              runtimeContext,
            });
          },
          afterResolveInTransaction: async (tx, resolved) => {
            const claimed = await claimChatQuestionFormSubmission(tx, {
              actionRowId: loaded.actionRowId,
              principalId: principal.principal.id,
            });
            if (!claimed) throw deny();
            const completed = await completeChatQuestionFormSubmission(tx, {
              actionRowId: loaded.actionRowId,
              interactionId: resolved.id,
            });
            if (!completed) throw deny();
            await tx
              .update(chatActions)
              .set({
                status: "expired",
                result: { code: "question_form_submitted" },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.companyId, issue.companyId),
                  eq(chatActions.endpointId, record.endpoint.id),
                  eq(chatActions.conversationId, conversation.id),
                  eq(chatActions.kind, "question_form_open"),
                  eq(chatActions.status, "issued"),
                  eq(
                    sql<string>`${chatActions.payload}->>'interactionId'`,
                    resolved.id,
                  ),
                ),
              );
            await logActivity(tx as unknown as Db, {
              companyId: issue.companyId,
              actorType: "user",
              actorId: principal.userId!,
              action: "issue.thread_interaction_answered",
              entityType: "issue",
              entityId: issue.id,
              details: {
                source: "external_chat_modal",
                endpointId: record.endpoint.id,
                provider: record.endpoint.provider,
                conversationId: conversation.id,
                publicationId: issued.publication.id,
                interactionId: resolved.id,
                interactionKind: resolved.kind,
                interactionStatus: resolved.status,
                resolutionActorKind: "user",
                answeredQuestionCount: validation.answers.length,
              },
            });
          },
        },
      );
    } catch (error) {
      if (isExternalActionAuthorizationChange(error)) {
        await db
          .update(chatActions)
          .set({
            status: "expired",
            result: { code: "chat_action_authorization_changed" },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, loaded.actionRowId),
              eq(chatActions.status, "issued"),
            ),
          );
        return { action: "clear" };
      }
      const settledRace = await db.transaction(async (tx) => {
        const currentInteraction = (
          await issueThreadInteractionService(tx as unknown as Db).listForIssue(
            issue.id,
          )
        ).find((candidate) => candidate.id === interaction.id);
        if (!currentInteraction || currentInteraction.status === "pending") {
          return false;
        }
        await enqueueTerminalIssueInteractionChatPublications(
          tx,
          currentInteraction,
        );
        return true;
      });
      if (!settledRace) throw error;
      scheduleMessageProcessing(async () => {
        await processPendingPublications();
      });
      return { action: "clear" };
    }
    scheduleMessageProcessing(async () => {
      await questionResponses.deliver(answered.id);
    });
    return { action: "clear" };
  }

  async function latestSlackDmControlThreadId(
    endpointId: string,
    rawChannelId: string,
  ): Promise<string | null> {
    const conversationIds = [rawChannelId, `slack:${rawChannelId}`];
    return db
      .select({ externalThreadId: chatConversations.externalThreadId })
      .from(chatConversations)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, chatConversations.companyId),
          eq(issues.id, chatConversations.issueId),
        ),
      )
      .where(
        and(
          eq(chatConversations.endpointId, endpointId),
          inArray(chatConversations.externalConversationId, conversationIds),
          eq(chatConversations.isDirectMessage, true),
          inArray(chatConversations.state, ["active", "waiting"]),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(
        desc(chatConversations.lastActivityAt),
        desc(chatConversations.createdAt),
      )
      .limit(1)
      .then((rows) => rows[0]?.externalThreadId ?? null);
  }

  async function finalizeSlackTaskStartFailure(input: {
    actionId: string;
    actionStatus: "received" | "validating" | "resolving";
    attempt?: number;
    connectionId: string;
    endpoint: EndpointRow;
    error: unknown;
    providerAttempted?: boolean;
    resource: ResourceRow | null;
  }): Promise<boolean> {
    const attempt = input.attempt ?? 1;
    const classified = classifyChatPublicationError(input.error, attempt);
    // Runtime construction, lease acquisition, and authorization validation
    // happen before the transport fence. Even a socket-shaped error in that
    // phase is known not to have sent a Slack message and remains safely
    // retryable instead of entering the ambiguous-delivery quarantine.
    const disposition =
      input.providerAttempted === false &&
      classified.kind === "delivery_unknown"
        ? {
            kind: "retry" as const,
            retryAfterMs: Math.min(60_000, 2 ** Math.max(0, attempt) * 1000),
            reason: classified.reason,
          }
        : classified;
    const failure = redactSensitiveText(disposition.reason).slice(
      0,
      MAX_ERROR_TEXT,
    );
    const finalized = await db.transaction(async (tx) => {
      const [ownedAction] = await tx
        .update(chatActions)
        .set({
          status:
            disposition.kind === "delivery_unknown"
              ? "delivery_unknown"
              : disposition.kind === "retry"
                ? "queued"
                : "failed",
          result: {
            code: `slash_task_${disposition.kind}`,
            redactedError: failure,
            retryable: disposition.kind === "retry",
            attemptCount: attempt,
            ...(disposition.kind === "retry"
              ? {
                  retryAt: new Date(
                    Date.now() + disposition.retryAfterMs,
                  ).toISOString(),
                }
              : {}),
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, input.actionId),
            eq(chatActions.status, input.actionStatus),
            sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
          ),
        )
        .returning({ id: chatActions.id });
      if (!ownedAction) return false;
      if (disposition.kind === "endpoint_attention") {
        await tx
          .update(chatEndpoints)
          .set({
            status: "attention",
            healthMessage: "Provider credentials or permissions need attention",
            lastError: failure,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, input.endpoint.id));
        await tx
          .update(toolConnections)
          .set({
            status: "disabled",
            enabled: false,
            healthStatus: "degraded",
            healthMessage: "Provider credentials or permissions need attention",
            lastError: failure,
            healthCheckedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, input.connectionId));
      } else if (
        disposition.kind === "resource_unavailable" &&
        input.resource
      ) {
        await tx
          .update(chatEndpointResources)
          .set({ availability: "unavailable", updatedAt: new Date() })
          .where(eq(chatEndpointResources.id, input.resource.id));
      }
      return true;
    });
    if (finalized && disposition.kind === "endpoint_attention") {
      await invalidateRuntime(input.endpoint.id).catch(() => undefined);
    }
    return finalized;
  }

  async function admitConfirmedSlackTaskStart(
    actionId: string,
    ingressOnly = true,
  ): Promise<boolean> {
    const staleAdmission = new Date(
      Date.now() - SLACK_COMMAND_ADMISSION_STALE_MS,
    );
    const [action] = await db
      .update(chatActions)
      .set({ status: "admitting", updatedAt: new Date() })
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "slash_task_start"),
          or(
            eq(chatActions.status, "provider_confirmed"),
            and(
              eq(chatActions.status, "admitting"),
              lte(chatActions.updatedAt, staleAdmission),
            ),
          ),
        ),
      )
      .returning();
    if (!action) return false;

    const recovery = slackSlashTaskRecoveryPayload(action.payload);
    const confirmed = confirmedSlackTaskStartResult(action.result);
    const failAdmission = async (code: string, detail: string) => {
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: {
            ...(confirmed ?? {}),
            code,
            redactedError: redactSensitiveText(detail).slice(0, MAX_ERROR_TEXT),
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "admitting"),
          ),
        );
    };
    if (!recovery || !confirmed || !action.principalId) {
      await failAdmission(
        "slash_task_admission_context_missing",
        "Confirmed Slack task start lacks durable admission context",
      );
      return true;
    }

    const record = await endpointRecord(action.endpointId);
    if (!record || record.endpoint.provider !== "slack") {
      await failAdmission(
        "slash_task_endpoint_missing",
        "Slack endpoint is no longer available",
      );
      return true;
    }
    if (!["verifying", "active"].includes(record.endpoint.status)) {
      if (record.endpoint.status === "archived") {
        await failAdmission(
          "slash_task_endpoint_archived",
          "Slack endpoint was archived before task admission completed",
        );
      } else {
        // The provider-visible send is already confirmed. Wait for an
        // operator to repair/resume the endpoint, then continue Paperclip-only
        // admission without sending another Slack message.
        await db
          .update(chatActions)
          .set({ status: "provider_confirmed", updatedAt: new Date() })
          .where(
            and(
              eq(chatActions.id, action.id),
              eq(chatActions.status, "admitting"),
            ),
          );
      }
      return true;
    }
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.id, action.principalId),
          eq(chatExternalPrincipals.companyId, record.endpoint.companyId),
          eq(chatExternalPrincipals.provider, "slack"),
          eq(
            chatExternalPrincipals.providerAccountId,
            record.endpoint.providerAccountId ?? "unknown",
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!principal || principal.isBot || principal.kind !== "user") {
      await failAdmission(
        "slash_task_principal_missing",
        "Original Slack account is no longer available",
      );
      return true;
    }

    const author = {
      userId: principal.externalId,
      userName: principal.handle ?? principal.externalId,
      fullName:
        principal.displayName ?? principal.handle ?? principal.externalId,
      isBot: false,
      isMe: false,
      isSystem: false,
    } satisfies Author;
    try {
      const endpointRuntime = await runtimeFor(record.endpoint);
      const thread = endpointRuntime.thread(confirmed.threadId);
      await processMessage(
        record.endpoint,
        thread,
        {
          id: recovery.syntheticMessageId,
          threadId: thread.id,
          text: recovery.taskText,
          formatted: { type: "root", children: [] },
          raw: { recoveredFromActionId: action.id },
          author,
          metadata: { dateSent: action.createdAt, edited: false },
          attachments: [],
          links: [],
          isMention: true,
        } as unknown as Message,
        "mention",
        ingressOnly,
        null,
        undefined,
        undefined,
        null,
        false,
        confirmed.authorizedUserId,
      );
      await db
        .update(chatActions)
        .set({ status: "processed", updatedAt: new Date() })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "admitting"),
          ),
        );
      return true;
    } catch (error) {
      // The provider post is already confirmed, so this retry is strictly a
      // Paperclip admission retry. Preserve the root tuple and let the durable
      // reconciler resume without ever posting to Slack again.
      await db
        .update(chatActions)
        .set({
          status: "provider_confirmed",
          result: {
            ...confirmed,
            code: "slash_task_admission_retry",
            redactedError: redactError(error),
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "admitting"),
          ),
        );
      throw error;
    }
  }

  async function processSlackTaskStart(
    actionId: string,
    ingressOnly = true,
  ): Promise<boolean> {
    let action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "slash_task_start"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!action) return false;

    if (
      action.status === "provider_confirmed" ||
      action.status === "admitting"
    ) {
      return await admitConfirmedSlackTaskStart(action.id, ingressOnly);
    }
    if (action.status === "resolving") {
      if (
        action.updatedAt.getTime() <=
        Date.now() - SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS
      ) {
        const staleRecord = await endpointRecord(action.endpointId);
        if (!staleRecord) return false;
        await withCredentialMutationLease(staleRecord.endpoint, async () => {
          await db
            .update(chatActions)
            .set({
              status: "delivery_unknown",
              result: {
                ...(action.result ?? {}),
                code: "slash_task_delivery_unknown",
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, action.id),
                eq(chatActions.status, "resolving"),
                eq(chatActions.updatedAt, action.updatedAt),
                lte(
                  chatActions.updatedAt,
                  new Date(Date.now() - SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS),
                ),
              ),
            );
        });
      }
      return false;
    }
    if (action.status === "validating") {
      if (
        action.updatedAt.getTime() <=
        Date.now() - SLACK_COMMAND_POST_STALE_MS
      ) {
        const staleRecord = await endpointRecord(action.endpointId);
        if (!staleRecord) return false;
        await withCredentialMutationLease(staleRecord.endpoint, async () => {
          await db
            .update(chatActions)
            .set({ status: "queued", updatedAt: new Date() })
            .where(
              and(
                eq(chatActions.id, action.id),
                eq(chatActions.status, "validating"),
                eq(chatActions.updatedAt, action.updatedAt),
                lte(
                  chatActions.updatedAt,
                  new Date(Date.now() - SLACK_COMMAND_POST_STALE_MS),
                ),
              ),
            );
        });
      }
      return false;
    }
    if (action.status !== "queued") return false;
    const retryAt =
      typeof action.result?.retryAt === "string"
        ? new Date(action.result.retryAt)
        : null;
    if (
      retryAt &&
      !Number.isNaN(retryAt.getTime()) &&
      retryAt.getTime() > Date.now()
    ) {
      return false;
    }
    const attempt =
      (typeof action.result?.attemptCount === "number" &&
      Number.isSafeInteger(action.result.attemptCount)
        ? Math.max(0, action.result.attemptCount)
        : 0) + 1;

    const [claimed] = await db
      .update(chatActions)
      .set({
        status: "validating",
        result: { attemptCount: attempt },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatActions.id, action.id),
          eq(chatActions.kind, "slash_task_start"),
          eq(chatActions.status, action.status),
        ),
      )
      .returning();
    if (!claimed) return false;
    action = claimed;

    const recovery = slackSlashTaskRecoveryPayload(action.payload);
    const initialRecord = await endpointRecord(action.endpointId);
    if (
      !recovery ||
      !initialRecord ||
      initialRecord.endpoint.provider !== "slack"
    ) {
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: {
            code: "slash_task_provider_context_missing",
            retryable: false,
            attemptCount: attempt,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "validating"),
            sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
          ),
        );
      return true;
    }
    let providerPostStarted = false;
    let failureResource: ResourceRow | null = null;
    try {
      return await withCredentialMutationLease(
        initialRecord.endpoint,
        async () => {
          const record = await endpointRecord(action.endpointId);
          if (!record || record.endpoint.provider !== "slack") {
            await db
              .update(chatActions)
              .set({
                status: "failed",
                result: {
                  code: "slash_task_provider_context_missing",
                  retryable: false,
                  attemptCount: attempt,
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  eq(chatActions.status, "validating"),
                  sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
                ),
              );
            return true;
          }
          if (!["verifying", "active"].includes(record.endpoint.status)) {
            const terminallyArchived = record.endpoint.status === "archived";
            await db
              .update(chatActions)
              .set({
                status: terminallyArchived ? "cancelled" : "queued",
                result: {
                  code: terminallyArchived
                    ? "slash_task_endpoint_archived"
                    : "slash_task_endpoint_waiting",
                  attemptCount: attempt - 1,
                  ...(terminallyArchived
                    ? {}
                    : {
                        retryAt: new Date(Date.now() + 5_000).toISOString(),
                      }),
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  eq(chatActions.status, "validating"),
                  sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
                ),
              );
            return false;
          }

          const principal = action.principalId
            ? await db
                .select()
                .from(chatExternalPrincipals)
                .where(
                  and(
                    eq(chatExternalPrincipals.id, action.principalId),
                    eq(
                      chatExternalPrincipals.companyId,
                      record.endpoint.companyId,
                    ),
                    eq(chatExternalPrincipals.provider, "slack"),
                    eq(
                      chatExternalPrincipals.providerAccountId,
                      record.endpoint.providerAccountId ?? "unknown",
                    ),
                  ),
                )
                .then((rows) => rows[0] ?? null)
            : null;
          let principalAllowed = false;
          if (principal && !principal.isBot && principal.kind === "user") {
            const link = await db
              .select({
                paperclipUserId: chatIdentityLinks.paperclipUserId,
                status: chatIdentityLinks.status,
              })
              .from(chatIdentityLinks)
              .where(
                and(
                  eq(chatIdentityLinks.endpointId, record.endpoint.id),
                  eq(chatIdentityLinks.principalId, principal.id),
                ),
              )
              .then((rows) => rows[0] ?? null);
            if (link?.status === "linked" && link.paperclipUserId) {
              principalAllowed = await db
                .select({ id: companyMemberships.id })
                .from(companyMemberships)
                .where(
                  and(
                    eq(companyMemberships.companyId, record.endpoint.companyId),
                    eq(companyMemberships.principalType, "user"),
                    eq(companyMemberships.principalId, link.paperclipUserId),
                    eq(companyMemberships.status, "active"),
                    ne(companyMemberships.membershipRole, "viewer"),
                  ),
                )
                .then((rows) => rows.length > 0);
            } else if (record.endpoint.allowUnlinkedPeople) {
              principalAllowed = await sponsorAllowsGuest(record.endpoint);
            }
          }

          const rawChannelId = recovery.channelId.replace(/^slack:/, "");
          const isDirectMessage = /^D[A-Z0-9]+$/i.test(rawChannelId);
          const resource = await db
            .select()
            .from(chatEndpointResources)
            .where(
              and(
                eq(chatEndpointResources.endpointId, record.endpoint.id),
                eq(chatEndpointResources.providerResourceId, rawChannelId),
              ),
            )
            .then((rows) => rows[0] ?? null);
          failureResource = resource;
          const destinationAllowed = isDirectMessage
            ? record.endpoint.allowDirectMessages
            : nonDirectDestinationAllowed(record.endpoint, resource);
          if (!principalAllowed || !destinationAllowed) {
            await db
              .update(chatActions)
              .set({
                status: "cancelled",
                result: {
                  code: "slash_task_no_longer_authorized",
                  attemptCount: attempt,
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  eq(chatActions.status, "validating"),
                  sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
                ),
              );
            return true;
          }

          const endpointRuntime = await runtimeFor(record.endpoint);
          const baseThread = endpointRuntime.thread(`slack:${rawChannelId}:`);
          const [transportClaim] = await db
            .update(chatActions)
            .set({ status: "resolving", updatedAt: new Date() })
            .where(
              and(
                eq(chatActions.id, action.id),
                eq(chatActions.status, "validating"),
                sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
              ),
            )
            .returning({ id: chatActions.id });
          if (!transportClaim) return false;
          const providerConfirmed = await db.transaction(async (tx) => {
            const currentEndpoint = await runtimeCallbackEndpoint(
              tx,
              record.endpoint.id,
              runtimeContextForRecord(record),
              ["verifying", "active"],
            );
            const currentResource = currentEndpoint
              ? await tx
                  .select()
                  .from(chatEndpointResources)
                  .where(
                    and(
                      eq(
                        chatEndpointResources.companyId,
                        currentEndpoint.companyId,
                      ),
                      eq(chatEndpointResources.endpointId, currentEndpoint.id),
                      eq(
                        chatEndpointResources.providerResourceId,
                        rawChannelId,
                      ),
                    ),
                  )
                  .for("update")
                  .then((rows) => rows[0] ?? null)
              : null;
            const currentAuthorization =
              currentEndpoint && action!.principalId
                ? await lockCurrentPrincipalAuthorization(
                    tx,
                    currentEndpoint,
                    action!.principalId,
                  )
                : null;
            const currentDestinationAllowed = currentEndpoint
              ? isDirectMessage
                ? currentEndpoint.allowDirectMessages
                : nonDirectDestinationAllowed(currentEndpoint, currentResource)
              : false;
            if (
              !currentEndpoint ||
              !currentAuthorization?.allowed ||
              !currentDestinationAllowed
            ) {
              await tx
                .update(chatActions)
                .set({
                  status: "cancelled",
                  result: {
                    code: "slash_task_no_longer_authorized",
                    attemptCount: attempt,
                  },
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatActions.id, action!.id),
                    eq(chatActions.status, "resolving"),
                    sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
                  ),
                );
              return null;
            }

            // Keep endpoint, destination, identity-link, and membership rows
            // locked through provider acceptance. The durable authorization
            // snapshot below then lets Paperclip finish admission exactly once
            // even if access is revoked immediately after Slack accepted it.
            providerPostStarted = true;
            const starter = await baseThread.post("Starting a task…");
            const threadId = slackTaskStarterThreadId(rawChannelId, starter.id);
            return tx
              .update(chatActions)
              .set({
                status: "provider_confirmed",
                result: {
                  attemptCount: attempt,
                  authorizedUserId: currentAuthorization.userId,
                  threadId,
                  providerMessageId: starter.id,
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action!.id),
                  eq(chatActions.status, "resolving"),
                  sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? null);
          });
          if (!providerConfirmed) return false;
          await admitConfirmedSlackTaskStart(providerConfirmed.id, ingressOnly);
          return true;
        },
      );
    } catch (error) {
      await finalizeSlackTaskStartFailure({
        actionId: action.id,
        actionStatus: providerPostStarted ? "resolving" : "validating",
        attempt,
        connectionId: initialRecord.endpoint.connectionId,
        endpoint: initialRecord.endpoint,
        error,
        providerAttempted: providerPostStarted,
        resource: failureResource,
      });
      throw error;
    }
  }

  async function processPendingSlackTaskStarts(limit: number) {
    const now = new Date();
    const staleAdmission = new Date(
      now.getTime() - SLACK_COMMAND_ADMISSION_STALE_MS,
    );
    const staleProviderPost = new Date(
      now.getTime() - SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS,
    );
    const staleValidation = new Date(
      now.getTime() - SLACK_COMMAND_POST_STALE_MS,
    );
    const actions = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, "slash_task_start"),
          or(
            and(
              eq(chatActions.status, "queued"),
              sql`(${chatActions.result}->>'retryAt' is null or ${chatActions.result}->>'retryAt' <= ${now.toISOString()})`,
            ),
            eq(chatActions.status, "provider_confirmed"),
            and(
              eq(chatActions.status, "admitting"),
              lte(chatActions.updatedAt, staleAdmission),
            ),
            and(
              eq(chatActions.status, "resolving"),
              lte(chatActions.updatedAt, staleProviderPost),
            ),
            and(
              eq(chatActions.status, "validating"),
              lte(chatActions.updatedAt, staleValidation),
            ),
          ),
        ),
      )
      .orderBy(asc(chatActions.createdAt))
      .limit(limit);
    let processed = 0;
    for (let offset = 0; offset < actions.length; offset += 4) {
      const results = await Promise.all(
        actions.slice(offset, offset + 4).map(async (action) => {
          try {
            return await processSlackTaskStart(action.id);
          } catch (error) {
            logger.warn(
              { actionId: action.id, error: redactError(error) },
              "Slack task start will retry or await explicit resolution",
            );
            return false;
          }
        }),
      );
      processed += results.filter(Boolean).length;
    }
    return processed;
  }

  async function handleSlashCommand(
    event: ChatSdkCallbackEvent<SlashCommandEvent>,
    runtimeContext: RuntimeContext,
  ) {
    const record = await runtimeCallbackRecord(
      event.endpointId,
      runtimeContext,
      ["verifying", "active"],
    );
    if (!record) return;
    const command = event.event.command.toLowerCase().split("@")[0];
    const text = event.event.text.trim();
    if (event.provider === "telegram") {
      const endpointRuntime =
        runtime.get(event.endpointId) ?? (await runtimeFor(record.endpoint));
      const thread = endpointRuntime.thread(event.event.channel.id);
      const parsedCommandMessage =
        endpointRuntime.parseTelegramCommandMessage?.(event.event.raw) ?? null;
      const synthetic = {
        id:
          telegramMessageId(event.event.raw) ??
          event.event.triggerId ??
          createHash("sha256")
            .update(
              JSON.stringify({
                command,
                raw: event.event.raw,
                userId: event.event.user.userId,
              }),
            )
            .digest("hex"),
        threadId: thread.id,
        // Telegram privacy mode does not deliver an ordinary @mention in a
        // group. /task@bot <request> is therefore the provider-native root
        // activation path; direct replies and later /task commands can
        // continue the same active group/topic task.
        text: command === "/task" && text ? text : command,
        formatted: { type: "root", children: [] },
        raw: event.event.raw,
        author: event.event.user,
        metadata: {
          // Telegram slash commands carry the original message as `raw`.
          // Preserve its whole-second provider clock so the durable drain can
          // use message_id to order a command and the next rapid DM correctly.
          dateSent: telegramMessageSentAt(event.event.raw) ?? new Date(),
          edited: false,
        },
        // Telegram routes a captioned file command through onSlashCommand
        // instead of the ordinary message callback. Preserve the provider's
        // parsed attachment descriptors so the durable delivery worker can
        // rehydrate and ingest them exactly like non-command media.
        attachments: parsedCommandMessage?.attachments ?? [],
        links: [],
        isMention: true,
      } as unknown as Message;
      await handleSdkMessage(
        {
          endpointId: event.endpointId,
          provider: event.provider,
          thread,
          message: synthetic,
          trigger: thread.isDM ? "direct_message" : "mention",
        },
        runtimeContext,
      );
      return;
    }
    const providerCommandId =
      event.event.triggerId ??
      createHash("sha256")
        .update(JSON.stringify(event.event.raw))
        .digest("hex");
    const queueSlackNotice = async (
      notice: string,
      principalId?: string | null,
    ) => {
      const noticeKey = createHash("sha256")
        .update(
          JSON.stringify([
            event.event.command,
            event.event.user.userId,
            providerCommandId,
            event.event.text,
          ]),
        )
        .digest("hex");
      const effect = await db.transaction((tx) =>
        stageProviderEffect(tx, {
          endpoint: record.endpoint,
          principalId: principalId ?? null,
          providerActionId: `provider_effect:slash_notice:${noticeKey}`,
          payload: {
            version: 1,
            effect: "ephemeral_message",
            authorizationMode: "safe_notice",
            threadId: event.event.channel.id,
            userId: event.event.user.userId,
            text: notice,
            settleDelivery: false,
          },
          runtimeContext,
        }),
      );
      if (!effect) throw new Error("Slack notice was not persisted");
      scheduleProviderEffect(effect.id, event.event.channel);
    };
    if (!["verifying", "active"].includes(record.endpoint.status)) {
      await queueSlackNotice("This Paperclip connection is not active.");
      return;
    }
    const expectedCommand =
      typeof record.endpoint.setup.command === "string"
        ? record.endpoint.setup.command
        : slackCommandForAgent(
            record.assignedAgentName,
            record.endpoint.publicId,
          );
    if (event.provider !== "slack" || command !== expectedCommand) {
      await queueSlackNotice(
        `This connection only accepts ${expectedCommand}.`,
      );
      return;
    }
    const principal = await ensurePrincipal(
      record.endpoint,
      event.event.user,
      event.event.raw,
    );
    const resource = await db
      .select()
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.endpointId, event.endpointId),
          eq(
            chatEndpointResources.providerResourceId,
            canonicalProviderResourceId(event.provider, {
              channelId: event.event.channel.id,
              id: event.event.channel.id,
            }),
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    // Slack's SDK channel wrapper has reported false for isDM on real slash
    // callbacks even though the signed payload contains a D-prefixed channel
    // id. The provider id is authoritative for this routing decision.
    const rawSlackChannelId = event.event.channel.id.replace(/^slack:/, "");
    const slashIsDirectMessage = /^D[A-Z0-9]+$/i.test(rawSlackChannelId)
      ? true
      : event.event.channel.isDM;
    const destinationAllowed = slashIsDirectMessage
      ? record.endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(record.endpoint, resource);
    const authorized =
      destinationAllowed &&
      !principal.linkedDenied &&
      (principal.userId !== null ||
        (record.endpoint.allowUnlinkedPeople &&
          (await sponsorAllowsGuest(record.endpoint))));
    if (!authorized) {
      await queueSlackNotice(
        "This channel or account is not allowed to start Paperclip work.",
        principal.principal.id,
      );
      return;
    }
    const slackControl = /^(status|new|close)$/i
      .exec(text)?.[1]
      ?.toLowerCase() as "status" | "new" | "close" | undefined;
    if (slackControl) {
      if (!slashIsDirectMessage) {
        // Slack slash-command payloads are channel-scoped and do not carry a
        // thread timestamp, so they cannot safely identify one of several
        // Paperclip tasks in the channel. Native @mention threads remain the
        // task-management surface there; the control vocabulary is exact only
        // in a DM, whose provider channel identity is stable.
        await queueSlackNotice(
          "Use status, new, and close in a direct message with this agent. In a channel, open the Paperclip task from its Slack thread.",
          principal.principal.id,
        );
        return;
      }
      const endpointRuntime =
        runtime.get(event.endpointId) ?? (await runtimeFor(record.endpoint));
      // A slash-command task starts a real Slack root and binds Paperclip to
      // that returned thread id. Later slash controls carry only the DM channel
      // id, so target the most recently active task instead of synthesizing an
      // unrelated base-DM thread that cannot find the binding.
      const activeThreadId = await latestSlackDmControlThreadId(
        event.endpointId,
        rawSlackChannelId,
      );
      const thread = endpointRuntime.thread(
        activeThreadId ?? `slack:${rawSlackChannelId}:`,
      );
      const synthetic = {
        id: createHash("sha256")
          .update(
            `${event.event.command}:${event.event.user.userId}:${providerCommandId}:${slackControl}`,
          )
          .digest("hex"),
        threadId: thread.id,
        text: `/${slackControl}`,
        formatted: { type: "root", children: [] },
        raw: event.event.raw,
        author: event.event.user,
        metadata: { dateSent: new Date(), edited: false },
        attachments: [],
        links: [],
        isMention: true,
      } as unknown as Message;
      await handleSdkMessage(
        {
          endpointId: event.endpointId,
          provider: event.provider,
          thread,
          message: synthetic,
          trigger: "direct_message",
        },
        runtimeContext,
        { receiptReactionSupported: false },
      );
      return;
    }
    if (!text) {
      await queueSlackNotice(
        `Use ${expectedCommand} followed by a task, or ${expectedCommand} status, new, or close in a direct message.`,
        principal.principal.id,
      );
      return;
    }
    const providerActionId = `slash_task:${createHash("sha256")
      .update(
        `${event.event.command}:${event.event.user.userId}:${providerCommandId}`,
      )
      .digest("hex")}`;
    const syntheticMessageId = createHash("sha256")
      .update(
        `${event.event.command}:${event.event.user.userId}:${providerCommandId}`,
      )
      .digest("hex");
    // A duplicate Slack retry must acknowledge from the already-durable row
    // without waiting for the first worker's endpoint/identity locks or Web
    // API request. Slack otherwise treats a healthy in-flight command as an
    // acknowledgement timeout and retries it again.
    const existingAction = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, record.endpoint.id),
          eq(chatActions.providerActionId, providerActionId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    const insertedAction = existingAction
      ? null
      : await db.transaction(async (tx) => {
          if (
            !(await runtimeCallbackEndpoint(
              tx,
              event.endpointId,
              runtimeContext,
              ["verifying", "active"],
            ))
          )
            return null;
          return tx
            .insert(chatActions)
            .values({
              companyId: record.endpoint.companyId,
              endpointId: record.endpoint.id,
              principalId: principal.principal.id,
              kind: "slash_task_start",
              providerActionId,
              payload: {
                version: 1,
                channelId: event.event.channel.id,
                command,
                syntheticMessageId,
                taskText: text,
              },
              status: "queued",
            })
            .onConflictDoNothing()
            .returning()
            .then((rows) => rows[0] ?? null);
        });
    const action =
      existingAction ??
      insertedAction ??
      (await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, record.endpoint.id),
            eq(chatActions.providerActionId, providerActionId),
          ),
        )
        .then((rows) => rows[0] ?? null));
    if (!action) throw new Error("Slack command admission was not persisted");
    // Slack has a tight acknowledgement budget. The unique action row is the
    // durable receipt; provider publication and Paperclip admission run behind
    // the acknowledgement under an atomic `received -> resolving` claim.
    // Duplicate callbacks schedule the same id and converge without waiting
    // on Slack's Web API or creating a second root.
    scheduleMessageProcessing(async () => {
      await processSlackTaskStart(
        action.id,
        options.deferWebhookProcessing === true,
      );
    });
  }

  async function applyProviderLifecycleEffect(
    endpoint: EndpointRow,
    effect: ChatProviderLifecycleEffect,
    runtimeContext?: RuntimeContext,
  ): Promise<boolean> {
    const providerEventId = `lifecycle:${effect.providerEventId}`;
    const deduplicationKey = createHash("sha256")
      .update(`${effect.provider}:${providerEventId}`)
      .digest("hex");
    const eventKind: ChatEventKind =
      effect.availability === "available" ? "installation" : "uninstallation";
    const [inserted] = await db
      .insert(chatDeliveries)
      .values({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        providerEventId,
        deduplicationKey,
        eventKind,
        normalizedEvent: {
          providerEventId,
          kind: eventKind,
          lifecycle: effect,
          ...(runtimeContext
            ? {
                runtimeContext: {
                  credentialFingerprint: runtimeContext.credentialFingerprint,
                  generation: runtimeContext.generation,
                },
              }
            : {}),
        },
        state: "received",
      })
      .onConflictDoNothing()
      .returning();
    const candidate =
      inserted ??
      (await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.providerEventId, providerEventId),
          ),
        )
        .then((rows) => rows[0] ?? null));
    if (!candidate || candidate.state === "processed") return false;
    const staleBefore = new Date(Date.now() - DELIVERY_PROCESSING_STALE_MS);
    const [claimed] = await db
      .update(chatDeliveries)
      .set({
        state: "processing",
        attempts: candidate.attempts + 1,
        redactedError: null,
        nextAttemptAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatDeliveries.id, candidate.id),
          or(
            inArray(chatDeliveries.state, ["received", "retry"]),
            and(
              eq(chatDeliveries.state, "processing"),
              lte(chatDeliveries.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning({ id: chatDeliveries.id });
    if (!claimed) return false;

    let refreshRuntimeAfterLifecycle = false;
    let stopRuntimeAfterFailure = false;
    let stopRuntimeAfterLifecycle = false;
    let lifecycleFailurePersisted = false;
    try {
      await withCredentialMutationLease(endpoint, async () => {
        const currentRecord = await endpointRecord(endpoint.id);
        if (!currentRecord) throw notFound("Chat endpoint not found");
        const currentEndpoint = currentRecord.endpoint;
        const admittedRuntimeContext = lifecycleRuntimeFence(candidate);
        const currentRuntimeContext = runtimeContextForRecord(currentRecord);
        if (
          !admittedRuntimeContext ||
          admittedRuntimeContext.generation !==
            currentRuntimeContext.generation ||
          admittedRuntimeContext.credentialFingerprint !==
            currentRuntimeContext.credentialFingerprint
        ) {
          const filteredAt = new Date();
          await db
            .update(chatDeliveries)
            .set({
              state: "filtered",
              processedAt: filteredAt,
              nextAttemptAt: null,
              redactedError:
                "Provider lifecycle callback belonged to a superseded runtime",
              updatedAt: filteredAt,
            })
            .where(eq(chatDeliveries.id, claimed.id));
          return;
        }

        if (currentEndpoint.provider === "github") {
          try {
            const currentCredentials =
              await resolveCredentials(currentEndpoint);
            const identity = await verifyCredentials(
              "github",
              currentCredentials,
            );
            const upgradingLegacyIdentity =
              !currentEndpoint.botExternalId &&
              legacyGitHubLabelsMatchVerifiedCredentials(
                currentEndpoint,
                identity,
              );
            if (
              !upgradingLegacyIdentity &&
              !nativeBotIdentityMatches("github", currentEndpoint, identity)
            ) {
              throw conflict(
                "The GitHub App identity changed while reconciling this connection",
                {
                  code: "chat_bot_identity_changed",
                },
              );
            }
            await assertNativeBotIdentityAvailable(currentEndpoint, identity);
            if (upgradingLegacyIdentity) {
              await db
                .update(chatEndpoints)
                .set({
                  botExternalId: identity.botExternalId,
                  updatedAt: new Date(),
                })
                .where(eq(chatEndpoints.id, currentEndpoint.id));
            }

            // GitHub lifecycle payloads are wake-up signals, not provider
            // truth. Re-read the one active App installation and its complete
            // repository inventory while the credential lease excludes secret
            // rotation and every other lifecycle callback for this endpoint.
            const prepared = await prepareProviderInventory(
              currentEndpoint,
              currentCredentials,
            );
            if (
              prepared.credentials.installationId !==
              currentCredentials.installationId
            ) {
              await persistCredentials(currentEndpoint, prepared.credentials);
              refreshRuntimeAfterLifecycle = true;
            }
            if (prepared.inventory)
              await reconcileProviderResourceRows(
                currentEndpoint,
                prepared.inventory,
              );

            const canonical = await endpointRecord(currentEndpoint.id);
            if (!canonical) throw notFound("Chat endpoint not found");
            const now = new Date();
            const intentionallyUnavailable =
              canonical.endpoint.status === "paused" ||
              canonical.endpoint.status === "archived" ||
              !canonical.endpoint.setup.webhookVerifiedAt;
            const advanceRuntimeGeneration =
              refreshRuntimeAfterLifecycle ||
              !canonical.endpoint.setup.webhookVerifiedAt;
            await db.transaction(async (tx) => {
              if (intentionallyUnavailable) {
                await tx
                  .update(chatEndpoints)
                  .set({
                    ...(advanceRuntimeGeneration
                      ? {
                          setup: {
                            ...canonical.endpoint.setup,
                            runtimeGeneration:
                              runtimeGeneration(canonical.endpoint.setup) + 1,
                          } as InternalSetupState,
                        }
                      : {}),
                    lastEventAt: now,
                    updatedAt: now,
                  })
                  .where(eq(chatEndpoints.id, canonical.endpoint.id));
              } else {
                const status =
                  canonical.endpoint.setup.step === "complete"
                    ? "active"
                    : "verifying";
                await tx
                  .update(chatEndpoints)
                  .set({
                    status,
                    healthMessage:
                      status === "active"
                        ? "Connected"
                        : "Waiting for a test conversation",
                    lastError: null,
                    lastEventAt: now,
                    ...(advanceRuntimeGeneration
                      ? {
                          setup: {
                            ...canonical.endpoint.setup,
                            runtimeGeneration:
                              runtimeGeneration(canonical.endpoint.setup) + 1,
                          } as InternalSetupState,
                        }
                      : {}),
                    updatedAt: now,
                  })
                  .where(eq(chatEndpoints.id, canonical.endpoint.id));
                await tx
                  .update(toolConnections)
                  .set({
                    status: "active",
                    enabled: true,
                    healthStatus: "healthy",
                    healthMessage: "Connected",
                    lastError: null,
                    healthCheckedAt: now,
                    updatedAt: now,
                  })
                  .where(
                    eq(toolConnections.id, canonical.endpoint.connectionId),
                  );
              }
              await tx
                .update(chatDeliveries)
                .set({
                  state: "processed",
                  processedAt: now,
                  redactedError: null,
                  nextAttemptAt: null,
                  updatedAt: now,
                })
                .where(eq(chatDeliveries.id, claimed.id));
            });
            if (!canonical.endpoint.setup.webhookVerifiedAt) {
              stopRuntimeAfterLifecycle = true;
            }
          } catch (error) {
            const latest = await endpointRecord(currentEndpoint.id);
            const preserveIntentionalState =
              !latest ||
              latest.endpoint.status === "paused" ||
              latest.endpoint.status === "archived" ||
              !latest.endpoint.setup.webhookVerifiedAt;
            if (!preserveIntentionalState) {
              const failedAt = new Date();
              const failure = redactError(error);
              const nextGeneration =
                runtimeGeneration(latest.endpoint.setup) + 1;
              const retryRuntimeContext: LifecycleRuntimeFence = {
                credentialFingerprint: credentialFingerprint(
                  latest.credentialSecretRefs,
                ),
                generation: nextGeneration,
              };
              const terminal = candidate.attempts + 1 >= 5;
              await db.transaction(async (tx) => {
                await tx
                  .update(chatEndpoints)
                  .set({
                    status: "attention",
                    healthMessage:
                      "GitHub App credentials, permissions, events, or identity need attention",
                    lastError: failure,
                    lastEventAt: failedAt,
                    setup: {
                      ...latest.endpoint.setup,
                      runtimeGeneration: nextGeneration,
                    } as InternalSetupState,
                    updatedAt: failedAt,
                  })
                  .where(eq(chatEndpoints.id, currentEndpoint.id));
                await tx
                  .update(toolConnections)
                  .set({
                    status: "disabled",
                    enabled: false,
                    healthStatus: "degraded",
                    healthMessage:
                      "GitHub App credentials, permissions, events, or identity need attention",
                    lastError: failure,
                    healthCheckedAt: failedAt,
                    updatedAt: failedAt,
                  })
                  .where(eq(toolConnections.id, currentEndpoint.connectionId));
                await tx
                  .update(chatEndpointResources)
                  .set({ availability: "unavailable", updatedAt: failedAt })
                  .where(
                    and(
                      eq(
                        chatEndpointResources.companyId,
                        currentEndpoint.companyId,
                      ),
                      eq(chatEndpointResources.endpointId, currentEndpoint.id),
                    ),
                  );
                await tx
                  .update(chatConversations)
                  .set({ state: "unavailable", updatedAt: failedAt })
                  .where(
                    and(
                      eq(
                        chatConversations.companyId,
                        currentEndpoint.companyId,
                      ),
                      eq(chatConversations.endpointId, currentEndpoint.id),
                      inArray(chatConversations.state, ["active", "waiting"]),
                    ),
                  );
                await tx
                  .update(chatDeliveries)
                  .set({
                    state: terminal ? "failed" : "retry",
                    normalizedEvent: normalizedLifecycleWithRuntimeFence(
                      candidate,
                      retryRuntimeContext,
                    ),
                    redactedError: failure,
                    nextAttemptAt: terminal ? null : failedAt,
                    updatedAt: failedAt,
                  })
                  .where(eq(chatDeliveries.id, claimed.id));
              });
              stopRuntimeAfterFailure = true;
              lifecycleFailurePersisted = true;
            }
            throw error;
          }
          return;
        }

        const staleResourceEffect =
          effect.kind === "resource" &&
          (await hasNewerProcessedProviderLifecycleEffect(
            currentEndpoint,
            effect,
          ));

        const endpointEffectStopsRuntime =
          effect.kind === "endpoint" &&
          (effect.availability === "attention" ||
            effect.availability === "revoked");
        await db.transaction(async (tx) => {
          const now = new Date();
          if (staleResourceEffect) {
            // Persisted provider-native ordering wins over request arrival or
            // lease acquisition order. The older callback remains auditable,
            // but cannot roll a resource or conversation back.
            await tx
              .update(chatEndpoints)
              .set({ lastEventAt: now, updatedAt: now })
              .where(eq(chatEndpoints.id, currentEndpoint.id));
            await tx
              .update(chatDeliveries)
              .set({
                state: "processed",
                processedAt: now,
                redactedError: null,
                nextAttemptAt: null,
                updatedAt: now,
              })
              .where(eq(chatDeliveries.id, claimed.id));
            return;
          }
          if (effect.kind === "resource") {
            const providerResourceId =
              currentEndpoint.provider === "microsoft-teams"
                ? baseTeamsConversationId(effect.providerResourceId)
                : effect.providerResourceId;
            const previousProviderResourceId =
              currentEndpoint.provider === "telegram"
                ? effect.previousProviderResourceId
                : undefined;
            const previousResource = previousProviderResourceId
              ? await tx
                  .select()
                  .from(chatEndpointResources)
                  .where(
                    and(
                      eq(chatEndpointResources.endpointId, currentEndpoint.id),
                      eq(chatEndpointResources.type, "chat"),
                      eq(
                        chatEndpointResources.providerResourceId,
                        previousProviderResourceId,
                      ),
                    ),
                  )
                  .for("update")
                  .then((rows) => rows[0] ?? null)
              : null;
            const migratedLabel =
              previousResource &&
              telegramResourceLabelIsFallback(providerResourceId, effect.label)
                ? previousResource.label
                : effect.label;
            const migratedEnabled = previousResource?.enabled === true;
            if (
              previousResource &&
              previousProviderResourceId !== providerResourceId
            ) {
              await tx
                .update(chatEndpointResources)
                .set({
                  availability: "unavailable",
                  enabled: false,
                  metadata: {
                    ...previousResource.metadata,
                    source: "chat_migration",
                    migratedTo: providerResourceId,
                  },
                  updatedAt: now,
                })
                .where(eq(chatEndpointResources.id, previousResource.id));
            }
            const preserveProviderLabel =
              (currentEndpoint.provider === "slack" &&
                slackResourceLabelIsFallback(
                  providerResourceId,
                  migratedLabel,
                )) ||
              (currentEndpoint.provider === "telegram" &&
                telegramResourceLabelIsFallback(
                  providerResourceId,
                  migratedLabel,
                ));
            const [resource] = await tx
              .insert(chatEndpointResources)
              .values({
                companyId: currentEndpoint.companyId,
                endpointId: currentEndpoint.id,
                type: effect.resourceType,
                providerResourceId,
                parentProviderResourceId:
                  effect.parentProviderResourceId ?? null,
                label: migratedLabel,
                providerUrl: effect.providerUrl ?? null,
                availability: effect.availability,
                enabled: migratedEnabled,
                metadata: effect.metadata ?? {},
              })
              .onConflictDoUpdate({
                target: [
                  chatEndpointResources.endpointId,
                  chatEndpointResources.type,
                  chatEndpointResources.providerResourceId,
                ],
                set: {
                  parentProviderResourceId:
                    effect.parentProviderResourceId ?? null,
                  ...(preserveProviderLabel ? {} : { label: migratedLabel }),
                  providerUrl: effect.providerUrl ?? null,
                  availability: effect.availability,
                  ...(previousProviderResourceId
                    ? {
                        enabled: sql<boolean>`${chatEndpointResources.enabled} or ${migratedEnabled}`,
                      }
                    : {}),
                  metadata: effect.metadata ?? {},
                  updatedAt: now,
                },
              })
              .returning({ id: chatEndpointResources.id });
            if (
              resource &&
              previousResource &&
              previousProviderResourceId !== providerResourceId
            ) {
              const previousThreadPrefix = `telegram:${previousProviderResourceId}`;
              const migratedThreadPrefix = `telegram:${providerResourceId}`;
              await tx
                .update(chatConversations)
                .set({
                  resourceId: resource.id,
                  // Telegram SDK threads use the namespaced channel id. Keep
                  // the migrated row in that canonical shape so the first
                  // reply from the replacement supergroup finds this same
                  // task instead of creating a second conversation.
                  externalConversationId: migratedThreadPrefix,
                  externalThreadId: sql<string>`case
                    when ${chatConversations.externalThreadId} = ${previousThreadPrefix} then ${migratedThreadPrefix}
                    when ${chatConversations.externalThreadId} like ${`${previousThreadPrefix}:%`}
                      then ${migratedThreadPrefix} || substring(
                        ${chatConversations.externalThreadId}
                        from char_length(${previousThreadPrefix}) + 1
                      )
                    else ${chatConversations.externalThreadId}
                  end`,
                  externalLabel: migratedLabel,
                  state: "active",
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(chatConversations.companyId, currentEndpoint.companyId),
                    eq(chatConversations.endpointId, currentEndpoint.id),
                    eq(chatConversations.resourceId, previousResource.id),
                  ),
                );
            }
            if (resource) {
              await tx
                .update(chatConversations)
                .set({
                  state:
                    effect.availability === "available"
                      ? "active"
                      : "unavailable",
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(chatConversations.companyId, currentEndpoint.companyId),
                    eq(chatConversations.endpointId, currentEndpoint.id),
                    eq(chatConversations.resourceId, resource.id),
                    effect.availability === "available"
                      ? eq(chatConversations.state, "unavailable")
                      : inArray(chatConversations.state, ["active", "waiting"]),
                  ),
                );
            }
            await tx
              .update(chatEndpoints)
              .set({ lastEventAt: now, updatedAt: now })
              .where(eq(chatEndpoints.id, currentEndpoint.id));
          } else {
            const reason = redactSensitiveText(effect.reason).slice(
              0,
              MAX_ERROR_TEXT,
            );
            if (effect.availability === "available") {
              if (
                currentEndpoint.status !== "paused" &&
                currentEndpoint.status !== "archived"
              ) {
                const status =
                  currentEndpoint.setup.step === "complete"
                    ? "active"
                    : currentEndpoint.status === "attention"
                      ? "verifying"
                      : currentEndpoint.status;
                await tx
                  .update(chatEndpoints)
                  .set({
                    status,
                    healthMessage:
                      status === "active"
                        ? "Connected"
                        : "Waiting for a test conversation",
                    lastError: null,
                    lastEventAt: now,
                    updatedAt: now,
                  })
                  .where(eq(chatEndpoints.id, currentEndpoint.id));
                await tx
                  .update(toolConnections)
                  .set({
                    status: "active",
                    enabled: true,
                    healthStatus: "healthy",
                    healthMessage: "Connected",
                    lastError: null,
                    healthCheckedAt: now,
                    updatedAt: now,
                  })
                  .where(eq(toolConnections.id, currentEndpoint.connectionId));
              }
            } else {
              await tx
                .update(chatEndpoints)
                .set({
                  status: effect.availability,
                  healthMessage: reason,
                  lastError: reason,
                  lastEventAt: now,
                  setup: {
                    ...currentEndpoint.setup,
                    runtimeGeneration:
                      runtimeGeneration(currentEndpoint.setup) + 1,
                  } as InternalSetupState,
                  updatedAt: now,
                })
                .where(eq(chatEndpoints.id, currentEndpoint.id));
              await tx
                .update(toolConnections)
                .set({
                  status: "disabled",
                  enabled: false,
                  healthStatus:
                    effect.availability === "revoked" ? "failed" : "degraded",
                  healthMessage: reason,
                  lastError: reason,
                  healthCheckedAt: now,
                  updatedAt: now,
                })
                .where(eq(toolConnections.id, currentEndpoint.connectionId));
              await tx
                .update(chatEndpointResources)
                .set({ availability: "unavailable", updatedAt: now })
                .where(
                  and(
                    eq(
                      chatEndpointResources.companyId,
                      currentEndpoint.companyId,
                    ),
                    eq(chatEndpointResources.endpointId, currentEndpoint.id),
                  ),
                );
              await tx
                .update(chatConversations)
                .set({ state: "unavailable", updatedAt: now })
                .where(
                  and(
                    eq(chatConversations.companyId, currentEndpoint.companyId),
                    eq(chatConversations.endpointId, currentEndpoint.id),
                    inArray(chatConversations.state, ["active", "waiting"]),
                  ),
                );
            }
          }
          await tx
            .update(chatDeliveries)
            .set({
              state: "processed",
              processedAt: now,
              redactedError: null,
              nextAttemptAt: null,
              updatedAt: now,
            })
            .where(eq(chatDeliveries.id, claimed.id));
        });
        stopRuntimeAfterLifecycle = endpointEffectStopsRuntime;
      });
    } catch (error) {
      if (stopRuntimeAfterFailure) {
        await invalidateRuntime(endpoint.id).catch((runtimeError) => {
          logger.warn(
            { endpointId: endpoint.id, error: redactError(runtimeError) },
            "failed to stop GitHub endpoint after lifecycle revalidation failed",
          );
        });
      }
      if (!lifecycleFailurePersisted) {
        const terminal = candidate.attempts + 1 >= 5;
        await db
          .update(chatDeliveries)
          .set({
            state: terminal ? "failed" : "retry",
            redactedError: redactError(error),
            nextAttemptAt: terminal ? null : new Date(),
            updatedAt: new Date(),
          })
          .where(eq(chatDeliveries.id, claimed.id))
          .catch(() => undefined);
      }
      throw error;
    }

    if (refreshRuntimeAfterLifecycle) {
      // The verified reinstall may have assigned a new installation id. Drop
      // the runtime that authenticated the lifecycle webhook with the prior
      // id; the next send recreates it from the newly persisted credentials.
      await invalidateRuntime(endpoint.id).catch((error) => {
        logger.warn(
          { endpointId: endpoint.id, error: redactError(error) },
          "failed to refresh recovered GitHub chat endpoint runtime",
        );
      });
    }
    if (stopRuntimeAfterLifecycle) {
      await invalidateRuntime(endpoint.id).catch((error) => {
        logger.warn(
          { endpointId: endpoint.id, error: redactError(error) },
          "failed to stop unavailable chat endpoint runtime",
        );
      });
    }
    return true;
  }

  function lifecycleRuntimeFence(
    delivery: DeliveryRow,
  ): LifecycleRuntimeFence | null {
    const normalized = delivery.normalizedEvent;
    if (
      !normalized ||
      typeof normalized !== "object" ||
      Array.isArray(normalized)
    )
      return null;
    const value = (normalized as Record<string, unknown>).runtimeContext;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const context = value as Record<string, unknown>;
    return typeof context.generation === "number" &&
      Number.isSafeInteger(context.generation) &&
      typeof context.credentialFingerprint === "string"
      ? {
          generation: context.generation as number,
          credentialFingerprint: context.credentialFingerprint,
        }
      : null;
  }

  function normalizedLifecycleWithRuntimeFence(
    delivery: DeliveryRow,
    runtimeContext: LifecycleRuntimeFence,
  ): Record<string, unknown> {
    const normalized =
      delivery.normalizedEvent &&
      typeof delivery.normalizedEvent === "object" &&
      !Array.isArray(delivery.normalizedEvent)
        ? (delivery.normalizedEvent as Record<string, unknown>)
        : {};
    return { ...normalized, runtimeContext };
  }

  async function hasNewerProcessedProviderLifecycleEffect(
    endpoint: EndpointRow,
    effect: Extract<ChatProviderLifecycleEffect, { kind: "resource" }>,
  ): Promise<boolean> {
    const sequence = effect.providerOrder?.sequence;
    const occurredAt = effect.providerOrder?.occurredAt;
    if (!sequence && !occurredAt) return false;
    const providerResourceId =
      endpoint.provider === "microsoft-teams"
        ? baseTeamsConversationId(effect.providerResourceId)
        : effect.providerResourceId;
    const newerOrder = sequence
      ? sql`(
          ${chatDeliveries.normalizedEvent}#>>'{lifecycle,providerOrder,sequence}' ~ '^[0-9]+([.][0-9]+)?$'
          and (${chatDeliveries.normalizedEvent}#>>'{lifecycle,providerOrder,sequence}')::numeric > cast(${sequence} as numeric)
        )`
      : sql`(
          nullif(${chatDeliveries.normalizedEvent}#>>'{lifecycle,providerOrder,occurredAt}', '')::timestamptz > cast(${occurredAt!} as timestamptz)
        )`;
    const newer = await db
      .select({ id: chatDeliveries.id })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.state, "processed"),
          inArray(chatDeliveries.eventKind, ["installation", "uninstallation"]),
          sql`${chatDeliveries.normalizedEvent}#>>'{lifecycle,kind}' = 'resource'`,
          sql`${chatDeliveries.normalizedEvent}#>>'{lifecycle,provider}' = ${effect.provider}`,
          sql`${chatDeliveries.normalizedEvent}#>>'{lifecycle,providerResourceId}' = ${providerResourceId}`,
          newerOrder,
        ),
      )
      .limit(1);
    return newer.length > 0;
  }

  async function applyProviderLifecycleEffects(
    endpoint: EndpointRow,
    effects: ChatProviderLifecycleEffect[],
    runtimeContext: RuntimeContext,
  ) {
    for (const effect of effects) {
      if (effect.provider !== endpoint.provider) continue;
      const applied = await applyProviderLifecycleEffect(
        endpoint,
        effect,
        runtimeContext,
      );
      if (
        applied &&
        endpoint.provider === "slack" &&
        effect.kind === "resource" &&
        effect.availability === "available" &&
        slackResourceLabelIsFallback(effect.providerResourceId, effect.label)
      ) {
        const stillAvailable = await db
          .select({ id: chatEndpointResources.id })
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.endpointId, endpoint.id),
              eq(chatEndpointResources.type, "channel"),
              eq(
                chatEndpointResources.providerResourceId,
                effect.providerResourceId,
              ),
              eq(chatEndpointResources.availability, "available"),
            ),
          )
          .limit(1)
          .then((rows) => rows.length > 0);
        if (stillAvailable) {
          scheduleMessageProcessing(async () => {
            await hydrateSlackResourceLabel(
              endpoint.id,
              effect.providerResourceId,
            ).catch((error) => {
              logger.warn(
                {
                  endpointId: endpoint.id,
                  providerResourceId: effect.providerResourceId,
                  error: redactError(error),
                },
                "could not hydrate a newly available Slack channel label",
              );
            });
          });
        }
      }
    }
  }

  async function handleWebhook(
    publicId: string,
    provider: ChatSdkProvider,
    request: Request,
  ) {
    const githubResponseDeadlineAt =
      provider === "github"
        ? Date.now() +
          Math.max(
            1,
            Math.min(
              options.githubWebhookResponseBudgetMs ??
                GITHUB_WEBHOOK_RESPONSE_BUDGET_MS,
              9_000,
            ),
          )
        : null;
    const githubRetryRequest = provider === "github" ? request.clone() : null;
    const endpoint = await db
      .select()
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.publicId, publicId),
          eq(chatEndpoints.provider, provider),
        ),
      )
      .then((rows) => rows[0] ?? null);
    const recoveringRevokedGitHubInstallation =
      endpoint?.status === "revoked" &&
      provider === "github" &&
      request.headers.get("x-github-event") === "installation";
    if (
      !endpoint ||
      endpoint.status === "archived" ||
      (endpoint.status === "revoked" && !recoveringRevokedGitHubInstallation)
    )
      throw notFound("Chat endpoint not found");
    // A pause is a durable ingress fence. Providers generally retry non-2xx
    // webhooks, so acknowledge late callbacks without recreating a runtime or
    // admitting any Paperclip mutation.
    if (endpoint.status === "paused") {
      return new Response("ignored", { status: 200 });
    }
    if (provider === "slack" && endpoint.providerAccountId) {
      const inspection = request.clone();
      const body = await inspection.text();
      const credentials = await resolveCredentials(endpoint);
      if (
        slackRequestSignatureIsValid(
          inspection,
          body,
          credentials.signingSecret,
        )
      ) {
        const incomingWorkspaceId = slackRequestWorkspaceId(
          body,
          inspection.headers.get("content-type") ?? "",
        );
        if (
          incomingWorkspaceId &&
          incomingWorkspaceId !== endpoint.providerAccountId
        ) {
          // A Slack Request URL can be copied to another app/workspace. Even a
          // correctly signed callback belongs only to the bot identity verified
          // for this endpoint, so acknowledge foreign traffic without letting
          // it reach SDK callbacks, delivery admission, principals, or lifecycle.
          return new Response("ignored", { status: 200 });
        }
      }
    }
    if (provider === "github") {
      const inspection = request.clone();
      const body = await inspection.text();
      const signature = inspection.headers.get("x-hub-signature-256");
      const eventType = inspection.headers.get("x-github-event");
      // GitHub sends this signed connectivity check as soon as an App webhook
      // is saved, before the operator can generate a private key and submit
      // the App identity to Paperclip. Authenticating the ping needs only the
      // Paperclip-generated webhook secret; initializing the full provider
      // runtime here would incorrectly reject the valid setup check because
      // App API credentials are not available yet.
      if (eventType === "ping") {
        const verified = await withCredentialMutationLease(
          endpoint,
          async () => {
            const current = await endpointRecord(endpoint.id);
            if (!current || current.endpoint.provider !== "github")
              return false;
            const credentials = await resolveCredentials(current.endpoint);
            const expected = `sha256=${createHmac("sha256", credentials.webhookSecret).update(body).digest("hex")}`;
            let valid = false;
            try {
              valid =
                typeof signature === "string" &&
                timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
            } catch {
              valid = false;
            }
            if (!valid) return false;
            const verifiedAt = new Date();
            await db
              .update(chatEndpoints)
              .set({
                setup: {
                  ...current.endpoint.setup,
                  webhookVerifiedAt: verifiedAt.toISOString(),
                },
                healthMessage: "GitHub webhook verified",
                updatedAt: verifiedAt,
              })
              .where(eq(chatEndpoints.id, endpoint.id));
            await logActivity(db, {
              companyId: current.endpoint.companyId,
              actorType: "system",
              actorId: "github-webhook",
              action: "chat_endpoint.webhook_verified",
              entityType: "tool_connection",
              entityId: current.endpoint.connectionId,
              details: {
                endpointId: current.endpoint.id,
                provider: "github",
                providerDeliveryId:
                  inspection.headers.get("x-github-delivery") ?? null,
              },
            });
            return true;
          },
        );
        return verified
          ? new Response("pong", { status: 200 })
          : new Response("Invalid signature", { status: 401 });
      }
      const credentials = await resolveCredentials(endpoint);
      const expected = `sha256=${createHmac("sha256", credentials.webhookSecret).update(body).digest("hex")}`;
      let signatureValid = false;
      try {
        signatureValid =
          typeof signature === "string" &&
          timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      } catch {
        signatureValid = false;
      }
      if (!signatureValid) {
        return new Response("Invalid signature", { status: 401 });
      }
      let payload: {
        installation?: { id?: unknown };
        repository?: unknown;
      } | null = null;
      try {
        payload = JSON.parse(body) as {
          installation?: { id?: unknown };
          repository?: unknown;
        };
      } catch {
        // Let the native adapter return its normal invalid-JSON response.
      }
      if (payload) {
        const incomingInstallationId = payload.installation?.id;
        if (
          incomingInstallationId !== undefined &&
          String(incomingInstallationId) !== credentials.installationId &&
          !(
            eventType === "installation" &&
            (endpoint.status === "attention" || endpoint.status === "revoked")
          )
        ) {
          // A dedicated endpoint represents exactly one GitHub App
          // installation. GitHub sends every installation's events to the
          // App webhook, so acknowledge foreign signed traffic without
          // admitting it to Paperclip or prompting endless redelivery.
          // An installation event can carry a new id only after the current
          // endpoint has already failed closed into attention (revoked has a
          // separate recovery path above). Canonical App inventory under the
          // lifecycle lease then decides whether that replacement is the
          // endpoint's sole active installation.
          return new Response("ignored", { status: 200 });
        }
        await reconcileGitHubWebhookRepository(endpoint, payload);
      }
    }
    const lifecycleInspection = request.clone();
    const githubInspection = provider === "github" ? request.clone() : null;
    const runtimePromise = runtimeFor(endpoint);
    let endpointRuntime: ChatSdkEndpointRuntime;
    if (githubResponseDeadlineAt !== null) {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const outcome = await Promise.race([
          runtimePromise.then((value) => ({ completed: true as const, value })),
          new Promise<{ completed: false; value?: never }>((resolve) => {
            timeout = setTimeout(
              () => resolve({ completed: false }),
              Math.max(0, githubResponseDeadlineAt - Date.now()),
            );
            timeout.unref?.();
          }),
        ]);
        if (!outcome.completed) {
          if (githubRetryRequest)
            scheduleGitHubWebhookRetry(publicId, githubRetryRequest);
          return retryableGitHubWebhookResponse();
        }
        endpointRuntime = outcome.value;
      } catch (error) {
        if (githubRetryRequest)
          scheduleGitHubWebhookRetry(publicId, githubRetryRequest);
        logger.warn(
          { endpointId: endpoint.id, error: redactError(error) },
          "GitHub runtime initialization failed before durable webhook receipt",
        );
        return retryableGitHubWebhookResponse();
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } else {
      endpointRuntime = await runtimePromise;
    }
    const runtimeContext = runtimeContexts.get(endpointRuntime as object);
    if (!runtimeContext) {
      throw conflict("Chat endpoint runtime is not current", {
        code: "chat_endpoint_runtime_superseded",
      });
    }
    const response = await endpointRuntime.handleWebhook(
      request,
      undefined,
      githubResponseDeadlineAt ?? undefined,
    );
    if (provider === "github" && response.status >= 500 && githubRetryRequest) {
      scheduleGitHubWebhookRetry(publicId, githubRetryRequest);
    }
    let lifecyclePayload: unknown = null;
    if (response.ok) {
      try {
        const contentType =
          lifecycleInspection.headers.get("content-type") ?? "";
        if (contentType.includes("application/json"))
          lifecyclePayload = await lifecycleInspection.json();
      } catch {
        // The native adapter remains authoritative for non-JSON callback
        // envelopes such as Slack slash commands.
      }
    }
    if (provider === "slack" && response.ok && lifecyclePayload) {
      const payload = lifecyclePayload as {
        type?: unknown;
        challenge?: unknown;
      };
      if (
        payload.type === "url_verification" &&
        typeof payload.challenge === "string" &&
        payload.challenge.length > 0
      ) {
        await db.transaction(async (tx) => {
          const current = await runtimeCallbackEndpoint(
            tx,
            endpoint.id,
            runtimeContext,
            ["verifying"],
          );
          if (!current) return;
          const verifiedAt = new Date();
          await tx
            .update(chatEndpoints)
            .set({
              setup: {
                ...current.setup,
                webhookVerifiedAt: verifiedAt.toISOString(),
              },
              healthMessage: "Slack Request URL verified",
              updatedAt: verifiedAt,
            })
            .where(eq(chatEndpoints.id, endpoint.id));
        });
      }
    }
    if (
      response.ok &&
      lifecyclePayload &&
      endpointRuntime.acceptsProviderScope(lifecyclePayload)
    ) {
      const effects = parseChatProviderLifecycle({
        provider: endpoint.provider,
        headers: lifecycleInspection.headers,
        payload: lifecyclePayload,
        botExternalId: endpoint.botExternalId,
      });
      // Provider success is returned only after every recognized lifecycle
      // transition is durable. A persistence failure therefore becomes a
      // non-2xx webhook response and asks the provider to retry.
      await applyProviderLifecycleEffects(endpoint, effects, runtimeContext);
    }
    if (githubInspection && response.ok) {
      let lifecycle: GitHubLifecycleEvent | null = null;
      try {
        lifecycle = await githubLifecycleEventFromRequest(githubInspection);
      } catch {
        // Ignore only malformed or unsupported supplemental payloads. Once an
        // event is recognized, its durable persistence failure must escape.
      }
      if (lifecycle) {
        await recordLifecycleDelivery(
          {
            endpointId: endpoint.id,
            ...lifecycle,
          },
          runtimeContext,
        );
      }
    }
    if (provider === "telegram" && response.ok && lifecyclePayload) {
      const lifecycle = telegramLifecycleEventFromPayload(lifecyclePayload);
      if (lifecycle) {
        await recordLifecycleDelivery(
          {
            endpointId: endpoint.id,
            ...lifecycle,
          },
          runtimeContext,
        );
      }
    }
    if (provider === "microsoft-teams" && response.ok && lifecyclePayload) {
      const lifecycle = microsoftTeamsLifecycleEventFromPayload(
        lifecyclePayload,
        endpointRuntime,
      );
      if (lifecycle) {
        await recordLifecycleDelivery(
          {
            endpointId: endpoint.id,
            ...lifecycle,
          },
          runtimeContext,
        );
      }
    }
    return response;
  }

  /**
   * Reconcile a verified normalized delivery whose original request was
   * interrupted. Closed, credential-free provider descriptors reconstruct
   * authenticated attachment downloads through the endpoint runtime; unsafe
   * or no-longer-available files are omitted without losing the text turn.
   */
  async function processPendingDeliveries(limit = 25, onlyDeliveryId?: string) {
    // Provider-visible effects that are not backed by a task publication use
    // chat_actions as their outbox. Reconcile them before inbound deliveries
    // so a crashed processing claim is quarantined before the delivery worker
    // could otherwise replay it.
    const actionRecovery = onlyDeliveryId
      ? null
      : Promise.allSettled([
          processPendingProviderEffects(limit),
          // Slack task starts are an action-backed outbox. Queued work may
          // post once; provider-confirmed rows perform Paperclip-only
          // admission; a stale in-flight post is quarantined as unknown.
          processPendingSlackTaskStarts(limit),
        ]);
    const now = new Date();
    const staleBefore = new Date(now.getTime() - DELIVERY_PROCESSING_STALE_MS);
    const rows = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          onlyDeliveryId ? eq(chatDeliveries.id, onlyDeliveryId) : undefined,
          or(
            and(
              eq(chatDeliveries.state, "received"),
              or(
                isNull(chatDeliveries.nextAttemptAt),
                lte(chatDeliveries.nextAttemptAt, now),
              ),
            ),
            and(
              eq(chatDeliveries.state, "retry"),
              or(
                isNull(chatDeliveries.nextAttemptAt),
                lte(chatDeliveries.nextAttemptAt, now),
              ),
            ),
            and(
              eq(chatDeliveries.state, "processing"),
              lte(chatDeliveries.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .orderBy(asc(chatDeliveries.receivedAt))
      .limit(limit);
    const conversations = new Set<string>();
    for (const delivery of rows) {
      const lifecycleEffect = normalizedLifecycleEffect(delivery);
      if (lifecycleEffect) {
        const record = await endpointRecord(delivery.endpointId);
        if (!record || record.endpoint.status === "archived") {
          await db
            .update(chatDeliveries)
            .set({
              state: "failed",
              redactedError: "Chat endpoint is no longer available",
              updatedAt: new Date(),
            })
            .where(eq(chatDeliveries.id, delivery.id));
          continue;
        }
        try {
          await applyProviderLifecycleEffect(record.endpoint, lifecycleEffect);
        } catch (error) {
          logger.warn(
            {
              endpointId: delivery.endpointId,
              deliveryId: delivery.id,
              error: redactError(error),
            },
            "chat provider lifecycle retry failed",
          );
        }
        continue;
      }
      const externalThreadId = normalizedDeliveryThreadId(delivery);
      if (!externalThreadId) {
        await db
          .update(chatDeliveries)
          .set({
            state: "failed",
            redactedError: "Normalized delivery is incomplete",
            updatedAt: new Date(),
          })
          .where(eq(chatDeliveries.id, delivery.id));
        continue;
      }
      const key = conversationDrainKey(delivery.endpointId, externalThreadId);
      if (conversations.has(key)) continue;
      conversations.add(key);
      await drainConversationDeliveries(delivery.endpointId, externalThreadId);
    }
    // Provider recovery runs independently so a slow Slack Web API request
    // cannot hold unrelated verified inbound messages behind it. Callers that
    // explicitly replay one delivery skip these global sweeps entirely.
    if (actionRecovery) await actionRecovery;
    return rows.length;
  }

  async function listResources(endpointId: string) {
    return db
      .select()
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.endpointId, endpointId),
          ne(chatEndpointResources.type, "direct_message"),
        ),
      )
      .orderBy(asc(chatEndpointResources.label));
  }

  async function replaceResources(
    endpointId: string,
    updates: Array<{ id: string; enabled: boolean }>,
  ) {
    const initial = await endpointRecord(endpointId);
    if (!initial) throw notFound("Chat endpoint not found");
    if (updates.length === 0) return listResources(endpointId);
    await withCredentialMutationLease(initial.endpoint, async () => {
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("Chat endpoint not found");
      const ids = updates.map((entry) => entry.id);
      const rows = await db
        .select({
          id: chatEndpointResources.id,
          availability: chatEndpointResources.availability,
        })
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.endpointId, endpointId),
            inArray(chatEndpointResources.id, ids),
          ),
        );
      if (rows.length !== new Set(ids).size)
        throw unprocessable("Every resource must belong to this endpoint");
      const availabilityById = new Map(
        rows.map((row) => [row.id, row.availability]),
      );
      const unavailable = updates.find(
        (entry) =>
          entry.enabled && availabilityById.get(entry.id) !== "available",
      );
      if (unavailable) {
        throw conflict(
          "A destination must still be available from the provider before it can be enabled",
          {
            code: "chat_resource_unavailable",
            resourceId: unavailable.id,
          },
        );
      }
      await db.transaction(async (tx) => {
        for (const entry of updates)
          await tx
            .update(chatEndpointResources)
            .set({ enabled: entry.enabled, updatedAt: new Date() })
            .where(
              and(
                eq(chatEndpointResources.endpointId, endpointId),
                eq(chatEndpointResources.id, entry.id),
              ),
            );
      });
    });
    return listResources(endpointId);
  }

  async function listPrincipals(endpointId: string) {
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const principals = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, record.endpoint.companyId),
          eq(chatExternalPrincipals.provider, record.endpoint.provider),
          eq(
            chatExternalPrincipals.providerAccountId,
            record.endpoint.providerAccountId ?? "unknown",
          ),
        ),
      )
      .orderBy(asc(chatExternalPrincipals.displayName));
    const links = await db
      .select()
      .from(chatIdentityLinks)
      .where(eq(chatIdentityLinks.endpointId, endpointId));
    const userIds = links.flatMap((link) =>
      link.paperclipUserId ? [link.paperclipUserId] : [],
    );
    const users = userIds.length
      ? await db
          .select({
            id: authUsers.id,
            name: authUsers.name,
            email: authUsers.email,
          })
          .from(authUsers)
          .where(inArray(authUsers.id, userIds))
      : [];
    const linkByPrincipal = new Map(
      links.map((link) => [link.principalId, link]),
    );
    const userById = new Map(users.map((user) => [user.id, user]));
    return principals.map((principal) => {
      const link = linkByPrincipal.get(principal.id);
      const user = link?.paperclipUserId
        ? userById.get(link.paperclipUserId)
        : null;
      return {
        id: link?.id ?? principal.id,
        principalId: principal.id,
        externalLabel:
          principal.displayName ?? principal.handle ?? principal.externalId,
        externalDetail: principal.handle
          ? `@${principal.handle.replace(/^@/, "")}`
          : principal.externalId,
        paperclipUserId: link?.paperclipUserId ?? null,
        paperclipUserLabel: user?.name ?? user?.email ?? null,
        status: link?.status ?? "pending",
      };
    });
  }

  async function createLinkIntent(
    endpointId: string,
    principalId: string,
    expiresInSeconds: number,
  ) {
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, record.endpoint.companyId),
          eq(chatExternalPrincipals.id, principalId),
          eq(chatExternalPrincipals.provider, record.endpoint.provider),
          eq(
            chatExternalPrincipals.providerAccountId,
            record.endpoint.providerAccountId ?? "",
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!principal) throw notFound("External identity not found");
    if (principal.isBot || principal.kind !== "user") {
      throw unprocessable("Only a human external identity can be linked");
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${record.endpoint.companyId}:${principalId}`}, 0))`,
      );
      const existingLink = await tx
        .select({ status: chatIdentityLinks.status })
        .from(chatIdentityLinks)
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpointId),
            eq(chatIdentityLinks.principalId, principalId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (existingLink?.status === "linked") {
        throw conflict("This external identity is already linked", {
          code: "chat_identity_already_linked",
        });
      }
      await tx
        .insert(chatIdentityLinks)
        .values({
          companyId: record.endpoint.companyId,
          endpointId,
          principalId,
          status: "pending",
          confirmationTokenHash: tokenHash,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [chatIdentityLinks.endpointId, chatIdentityLinks.principalId],
          set: {
            paperclipUserId: null,
            status: "pending",
            confirmationTokenHash: tokenHash,
            expiresAt,
            confirmedAt: null,
            revokedAt: null,
            updatedAt: new Date(),
          },
        });
    });
    const path = `/chat-identity/confirm?token=${encodeURIComponent(token)}`;
    return {
      confirmationUrl: publicBaseUrl ? `${publicBaseUrl}${path}` : path,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async function previewIdentityLink(token: string) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = await db
      .select({
        link: chatIdentityLinks,
        principal: chatExternalPrincipals,
        endpoint: chatEndpoints,
        companyName: companies.name,
        companyPrefix: companies.issuePrefix,
      })
      .from(chatIdentityLinks)
      .innerJoin(
        chatExternalPrincipals,
        and(
          eq(chatExternalPrincipals.companyId, chatIdentityLinks.companyId),
          eq(chatExternalPrincipals.id, chatIdentityLinks.principalId),
        ),
      )
      .innerJoin(
        chatEndpoints,
        and(
          eq(chatEndpoints.companyId, chatIdentityLinks.companyId),
          eq(chatEndpoints.id, chatIdentityLinks.endpointId),
        ),
      )
      .innerJoin(companies, eq(companies.id, chatIdentityLinks.companyId))
      .where(
        and(
          eq(chatIdentityLinks.confirmationTokenHash, tokenHash),
          eq(chatIdentityLinks.status, "pending"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!row || !row.link.expiresAt || row.link.expiresAt <= new Date()) {
      throw unprocessable("This identity-link request is invalid or expired");
    }
    return {
      endpointId: row.endpoint.id,
      companyId: row.endpoint.companyId,
      companyName: row.companyName,
      companyPrefix: row.companyPrefix,
      provider: row.endpoint.provider,
      providerAccountLabel: row.endpoint.providerAccountLabel,
      botLabel: row.endpoint.botDisplayName,
      externalLabel:
        row.principal.displayName ??
        row.principal.handle ??
        row.principal.externalId,
      externalDetail: row.principal.handle
        ? `@${row.principal.handle.replace(/^@/, "")}`
        : row.principal.externalId,
      expiresAt: row.link.expiresAt.toISOString(),
    };
  }

  async function confirmIdentityLink(token: string, paperclipUserId: string) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const link = await db
      .select()
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.confirmationTokenHash, tokenHash),
          eq(chatIdentityLinks.status, "pending"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!link || !link.expiresAt || link.expiresAt <= new Date())
      throw unprocessable("This identity-link request is invalid or expired");
    const confirmed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${link.companyId}:${link.principalId}`}, 0))`,
      );
      const currentLink = await tx
        .select({
          id: chatIdentityLinks.id,
          companyId: chatIdentityLinks.companyId,
          endpointId: chatIdentityLinks.endpointId,
          principalId: chatIdentityLinks.principalId,
          expiresAt: chatIdentityLinks.expiresAt,
        })
        .from(chatIdentityLinks)
        .where(
          and(
            eq(chatIdentityLinks.id, link.id),
            eq(chatIdentityLinks.status, "pending"),
            eq(chatIdentityLinks.confirmationTokenHash, tokenHash),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const now = new Date();
      if (
        !currentLink ||
        !currentLink.expiresAt ||
        currentLink.expiresAt <= now
      ) {
        return null;
      }
      const membership = await tx
        .select({ status: companyMemberships.status })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, currentLink.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, paperclipUserId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (membership?.status !== "active") {
        throw forbidden(
          "The signed-in Paperclip account is not a member of this company",
        );
      }
      const conflictingLink = await tx
        .select({
          id: chatIdentityLinks.id,
          paperclipUserId: chatIdentityLinks.paperclipUserId,
        })
        .from(chatIdentityLinks)
        .where(
          and(
            eq(chatIdentityLinks.companyId, link.companyId),
            eq(chatIdentityLinks.principalId, link.principalId),
            eq(chatIdentityLinks.status, "linked"),
            ne(chatIdentityLinks.paperclipUserId, paperclipUserId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (conflictingLink) {
        throw conflict(
          "This provider identity is linked to a different Paperclip account",
          {
            code: "chat_identity_link_conflict",
          },
        );
      }
      return tx
        .update(chatIdentityLinks)
        .set({
          paperclipUserId,
          status: "linked",
          confirmationTokenHash: null,
          confirmedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatIdentityLinks.id, link.id),
            eq(chatIdentityLinks.status, "pending"),
            eq(chatIdentityLinks.confirmationTokenHash, tokenHash),
            gt(chatIdentityLinks.expiresAt, now),
          ),
        )
        .returning({ endpointId: chatIdentityLinks.endpointId })
        .then((rows) => rows[0] ?? null);
    });
    if (!confirmed) {
      throw conflict("This identity-link request was already used or expired", {
        code: "chat_identity_link_consumed",
      });
    }
    return { ok: true, endpointId: confirmed.endpointId };
  }

  async function revokeLink(endpointId: string, principalId: string) {
    const link = await db
      .select({ companyId: chatIdentityLinks.companyId })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.endpointId, endpointId),
          eq(chatIdentityLinks.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!link) throw notFound("Identity link not found");
    const revoked = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${link.companyId}:${principalId}`}, 0))`,
      );
      return tx
        .update(chatIdentityLinks)
        .set({
          paperclipUserId: null,
          status: "revoked",
          confirmationTokenHash: null,
          revokedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatIdentityLinks.companyId, link.companyId),
            eq(chatIdentityLinks.endpointId, endpointId),
            eq(chatIdentityLinks.principalId, principalId),
          ),
        )
        .returning({ id: chatIdentityLinks.id })
        .then((rows) => rows[0] ?? null);
    });
    if (!revoked) throw notFound("Identity link not found");
  }

  async function listConversations(endpointId: string) {
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const conversations = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpointId))
      .orderBy(
        desc(chatConversations.lastActivityAt),
        desc(chatConversations.createdAt),
      );
    if (!conversations.length) return [];
    const issueRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        inArray(
          issues.id,
          conversations.map((row) => row.issueId),
        ),
      );
    const publications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.endpointId, endpointId))
      .orderBy(desc(chatPublications.createdAt));
    const issueById = new Map(issueRows.map((row) => [row.id, row]));
    const lastPublication = new Map<
      string,
      typeof chatPublications.$inferSelect
    >();
    for (const publication of publications)
      if (!lastPublication.has(publication.conversationId))
        lastPublication.set(publication.conversationId, publication);
    return conversations.map((conversation) => {
      const issue = issueById.get(conversation.issueId);
      const externalUrl =
        conversation.providerUrl ??
        (record.endpoint.provider === "slack"
          ? chatProviderConversationUrl({
              provider: "slack",
              providerAccountId: record.endpoint.providerAccountId,
              threadId: conversation.externalThreadId,
              providerMessageId: "",
            })
          : null);
      return {
        id: conversation.id,
        companyId: conversation.companyId,
        endpointId: conversation.endpointId,
        resourceId: conversation.resourceId,
        externalLabel: conversation.externalLabel,
        externalUrl,
        externalConversationId: conversation.externalConversationId,
        externalThreadId: conversation.externalThreadId,
        sessionGeneration: conversation.sessionGeneration,
        issueId: conversation.issueId,
        issueIdentifier: issue?.identifier ?? null,
        issueTitle: issue?.title ?? null,
        isDirectMessage: conversation.isDirectMessage,
        state:
          issue?.status === "done" || issue?.status === "cancelled"
            ? "completed"
            : conversation.state,
        lastActivityAt: conversation.lastActivityAt?.toISOString() ?? null,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: (
          conversation.lastActivityAt ?? conversation.updatedAt
        ).toISOString(),
        lastPublicationStatus:
          lastPublication.get(conversation.id)?.state ?? null,
      };
    });
  }

  async function listActivity(endpointId: string) {
    const [deliveries, publications, slashActions, providerEffects] =
      await Promise.all([
        db
          .select()
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, endpointId))
          .orderBy(desc(chatDeliveries.createdAt))
          .limit(100),
        db
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.endpointId, endpointId))
          .orderBy(desc(chatPublications.createdAt))
          .limit(100),
        db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpointId),
              eq(chatActions.kind, "slash_task_start"),
            ),
          )
          .orderBy(desc(chatActions.createdAt))
          .limit(100),
        db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpointId),
              eq(chatActions.kind, "provider_effect"),
              eq(chatActions.status, "delivery_unknown"),
            ),
          )
          .orderBy(desc(chatActions.createdAt))
          .limit(100),
      ]);
    const ambiguousProviderEffectDeliveryIds = new Set(
      providerEffects.flatMap((action) =>
        action.deliveryId ? [action.deliveryId] : [],
      ),
    );
    return [
      ...deliveries.map((row) => {
        const normalized =
          row.normalizedEvent &&
          typeof row.normalizedEvent === "object" &&
          !Array.isArray(row.normalizedEvent)
            ? (row.normalizedEvent as Record<string, unknown>)
            : {};
        const deduplication =
          normalized.deduplication &&
          typeof normalized.deduplication === "object" &&
          !Array.isArray(normalized.deduplication)
            ? (normalized.deduplication as Record<string, unknown>)
            : null;
        const duplicateCount =
          typeof deduplication?.duplicateCount === "number"
            ? deduplication.duplicateCount
            : 0;
        const label = row.eventKind.replaceAll("_", " ");
        const outcome =
          row.state === "filtered"
            ? "ignored"
            : row.state === "processed"
              ? "processed"
              : row.state;
        return {
          id: row.id,
          kind: "delivery" as const,
          status: row.state,
          summary: `${label} ${outcome}${duplicateCount ? ` · ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} ignored` : ""}`,
          detail: row.redactedError,
          createdAt: row.createdAt.toISOString(),
          replayable:
            row.state === "failed" &&
            Boolean(row.conversationId) &&
            !ambiguousProviderEffectDeliveryIds.has(row.id),
          resolutionActions: [],
        };
      }),
      ...publications.map((row) => {
        const payload = row.payload as Partial<SafeChatPublicationPayload>;
        const summary = payload.progressState
          ? `${payload.progressState.replaceAll("_", " ")} update`
          : payload.interactionId
            ? "Interactive question"
            : "Response to external conversation";
        return {
          id: row.id,
          kind: "publication" as const,
          status: row.state,
          summary,
          detail: row.redactedError,
          createdAt: row.createdAt.toISOString(),
          replayable: row.state === "failed",
          resolutionActions:
            row.state === "delivery_unknown"
              ? (["mark_delivered", "retry_anyway", "cancel"] as const)
              : [],
        };
      }),
      ...slashActions.map((row) => {
        const recovery = slackSlashTaskRecoveryPayload(row.payload);
        // Keep this GET read-only while still surfacing a crashed attempt as
        // actionable. The resolution POST persists the derived quarantine
        // before it applies the operator's audited decision.
        const status = slackTaskStartActivityStatus(row);
        return {
          id: row.id,
          kind: "action" as const,
          actionType: "slash_task_start" as const,
          status,
          summary: `Slack slash-command task start ${status.replaceAll("_", " ")}`,
          detail:
            status === "delivery_unknown"
              ? recovery
                ? "Slack may have accepted the task-start message, so Paperclip will not replay it automatically. Check Slack first; an explicit retry can create a duplicate starter message and task."
                : "Slack may have accepted the task-start message. This older action lacks the context required for a safe explicit retry, so check Slack and cancel it here before submitting a new command."
              : status === "provider_confirmed"
                ? "Slack accepted the task-start message. Paperclip is completing durable task admission without sending another Slack message."
                : status === "admitting"
                  ? "Slack accepted the task-start message. A Paperclip worker is admitting the task without replaying the Slack send."
                  : status === "failed"
                    ? "Slack rejected the task-start message. Submit the command again to retry."
                    : status === "cancelled"
                      ? "An operator cancelled this unconfirmed task start."
                      : null,
          createdAt: row.createdAt.toISOString(),
          replayable: false,
          resolutionActions:
            status === "delivery_unknown"
              ? recovery
                ? (["retry_anyway", "cancel"] as const)
                : (["cancel"] as const)
              : [],
        };
      }),
      ...providerEffects.map((row) => {
        const payload = providerEffectPayload(row.payload);
        return {
          id: row.id,
          kind: "action" as const,
          actionType: "provider_effect" as const,
          status: row.status,
          summary: "Provider reply delivery unknown",
          detail: payload?.completeConversationId
            ? "The provider may have accepted this reply, but Paperclip could not confirm it or close the task conversation. Check the provider first. Marking it delivered closes the conversation; retrying can create a duplicate message."
            : "The provider may have accepted this reply, but Paperclip could not confirm it. Check the provider first. Retrying can create a duplicate message.",
          createdAt: row.createdAt.toISOString(),
          replayable: false,
          resolutionActions: [
            "mark_delivered",
            "retry_anyway",
            "cancel",
          ] as const,
        };
      }),
    ]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  }

  async function replayDelivery(endpointId: string, deliveryId: string) {
    const delivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpointId),
          eq(chatDeliveries.id, deliveryId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!delivery) throw notFound("Delivery not found");
    if (!delivery.conversationId)
      throw unprocessable(
        "Only a delivery already bound to a task can be replayed safely",
      );
    const ambiguousProviderEffect = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpointId),
          eq(chatActions.deliveryId, delivery.id),
          eq(chatActions.kind, "provider_effect"),
          eq(chatActions.status, "delivery_unknown"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (ambiguousProviderEffect) {
      throw conflict(
        "Resolve the unconfirmed provider reply before replaying this delivery",
        {
          code: "chat_delivery_provider_effect_resolution_required",
        },
      );
    }
    if (delivery.state !== "failed") {
      throw conflict("Only a failed delivery can be replayed", {
        code: "chat_delivery_not_failed",
      });
    }
    const claimed = await db
      .update(chatDeliveries)
      .set({
        state: "retry",
        nextAttemptAt: new Date(),
        redactedError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatDeliveries.id, delivery.id),
          eq(chatDeliveries.state, "failed"),
          eq(chatDeliveries.attempts, delivery.attempts),
        ),
      )
      .returning({ id: chatDeliveries.id });
    if (!claimed.length) {
      throw conflict("This delivery is already being replayed", {
        code: "chat_delivery_replay_conflict",
      });
    }
    await processPendingDeliveries(1, delivery.id);
    const replayed = await db
      .select({ state: chatDeliveries.state })
      .from(chatDeliveries)
      .where(eq(chatDeliveries.id, delivery.id))
      .then((rows) => rows[0] ?? null);
    if (replayed?.state !== "processed") {
      throw conflict("The delivery replay did not complete", {
        code: "chat_delivery_replay_incomplete",
        state: replayed?.state ?? "missing",
      });
    }
  }

  async function replayPublication(endpointId: string, publicationId: string) {
    const publication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpointId),
          eq(chatPublications.id, publicationId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!publication) throw notFound("Publication not found");
    if (publication.state !== "failed") {
      throw conflict("Only a failed publication can be replayed", {
        code:
          publication.state === "delivery_unknown"
            ? "chat_publication_resolution_required"
            : "chat_publication_not_replayable",
      });
    }
    const interactionId = publication.payload.interactionId;
    const isInteractionPrompt =
      Boolean(interactionId) &&
      publication.idempotencyKey ===
        `interaction:${interactionId}:${publication.endpointId}`;
    if (isInteractionPrompt) {
      if (!publication.issueId || !interactionId) {
        throw conflict(
          "This interaction prompt is missing its authoritative task binding and cannot be replayed safely",
          { code: "chat_terminal_interaction_publication_not_replayable" },
        );
      }
      const interaction = await db
        .select({ status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.id, interactionId),
            eq(issueThreadInteractions.companyId, publication.companyId),
            eq(issueThreadInteractions.issueId, publication.issueId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!interaction || interaction.status !== "pending") {
        throw conflict(
          "A resolved interaction prompt cannot be replayed into the provider",
          { code: "chat_terminal_interaction_publication_not_replayable" },
        );
      }
    }
    const claimed = await db
      .update(chatPublications)
      .set({
        state: "retry",
        nextAttemptAt: new Date(),
        redactedError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatPublications.id, publication.id),
          eq(chatPublications.state, publication.state),
          eq(chatPublications.attempts, publication.attempts),
        ),
      )
      .returning({ id: chatPublications.id });
    if (!claimed.length) {
      throw conflict("This publication is already being replayed", {
        code: "chat_publication_replay_conflict",
      });
    }
    await processPendingPublications(1);
  }

  async function resolvePublication(
    endpointId: string,
    publicationId: string,
    action: "mark_delivered" | "retry_anyway" | "cancel",
    userId: string,
  ) {
    const initialRecord = await endpointRecord(endpointId);
    if (!initialRecord) throw notFound("Chat endpoint not found");
    await withCredentialMutationLease(initialRecord.endpoint, () =>
      db.transaction(async (tx) => {
        const publication = await tx
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpointId),
              eq(chatPublications.id, publicationId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!publication) throw notFound("Publication not found");
        if (publication.state !== "delivery_unknown") {
          throw conflict(
            "Only an unconfirmed publication needs an operator resolution",
            {
              code: "chat_publication_resolution_not_required",
            },
          );
        }

        const interactionId = publication.payload.interactionId;
        const isInteractionPrompt =
          Boolean(interactionId) &&
          publication.idempotencyKey ===
            `interaction:${interactionId}:${publication.endpointId}`;
        if (action === "retry_anyway" && isInteractionPrompt) {
          if (!publication.issueId || !interactionId) {
            throw conflict(
              "This interaction prompt is missing its authoritative task binding and cannot be retried safely",
              {
                code: "chat_terminal_interaction_publication_not_replayable",
              },
            );
          }
          const interaction = await tx
            .select({ status: issueThreadInteractions.status })
            .from(issueThreadInteractions)
            .where(
              and(
                eq(issueThreadInteractions.id, interactionId),
                eq(issueThreadInteractions.companyId, publication.companyId),
                eq(issueThreadInteractions.issueId, publication.issueId),
              ),
            )
            .then((rows) => rows[0] ?? null);
          if (!interaction || interaction.status !== "pending") {
            throw conflict(
              "A resolved interaction prompt cannot be retried with stale provider actions; mark it delivered or cancel it instead",
              {
                code: "chat_terminal_interaction_publication_not_replayable",
              },
            );
          }
        }

        const now = new Date();
        await tx
          .update(chatPublications)
          .set(
            action === "mark_delivered"
              ? {
                  state: "published",
                  publishedAt: now,
                  nextAttemptAt: null,
                  redactedError: null,
                  updatedAt: now,
                }
              : action === "retry_anyway"
                ? {
                    state: "retry",
                    nextAttemptAt: now,
                    redactedError: null,
                    updatedAt: now,
                  }
                : {
                    state: "cancelled",
                    nextAttemptAt: null,
                    redactedError:
                      "Cancelled by an operator after an unconfirmed provider delivery",
                    updatedAt: now,
                  },
          )
          .where(
            and(
              eq(chatPublications.id, publication.id),
              eq(chatPublications.state, "delivery_unknown"),
            ),
          );
        if (
          publication.idempotencyKey.startsWith("control:") &&
          action !== "retry_anyway"
        ) {
          await tx
            .update(chatActions)
            .set({
              status: action === "mark_delivered" ? "processed" : "cancelled",
              result: {
                code:
                  action === "mark_delivered"
                    ? "task_control_marked_delivered_by_operator"
                    : "task_control_cancelled_by_operator",
              },
              updatedAt: now,
            })
            .where(
              and(
                eq(chatActions.endpointId, publication.endpointId),
                eq(
                  chatActions.providerActionId,
                  `task-control-authorization:${publication.id}`,
                ),
                eq(chatActions.status, "issued"),
              ),
            );
        }
        if (action === "mark_delivered") {
          await tx
            .update(chatEndpoints)
            .set({ lastPublicationAt: now, updatedAt: now })
            .where(eq(chatEndpoints.id, endpointId));
          await commitTaskControlCompletion(
            tx as unknown as Db,
            publication,
            now,
          );
        }
        await logActivity(tx as unknown as Db, {
          companyId: publication.companyId,
          actorType: "user",
          actorId: userId,
          action: `chat.publication_${action}`,
          entityType: "chat_publication",
          entityId: publication.id,
          issueId: publication.issueId,
          details: {
            endpointId,
            conversationId: publication.conversationId,
            previousState: "delivery_unknown",
            nextState:
              action === "mark_delivered"
                ? "published"
                : action === "retry_anyway"
                  ? "retry"
                  : "cancelled",
            duplicateRiskAccepted: action === "retry_anyway",
          },
        });
      }),
    );
    await processPendingPublications();
  }

  async function resolveProviderEffect(
    endpointId: string,
    actionId: string,
    resolution: "mark_delivered" | "retry_anyway" | "cancel",
    userId: string,
  ) {
    const initialRecord = await endpointRecord(endpointId);
    if (!initialRecord) throw notFound("Chat endpoint not found");

    if (resolution === "retry_anyway") {
      await withCredentialMutationLease(initialRecord.endpoint, async () => {
        const currentRecord = await endpointRecord(endpointId);
        if (
          !currentRecord ||
          !["verifying", "active"].includes(currentRecord.endpoint.status)
        ) {
          throw conflict(
            "The chat connection must be active before retrying this provider reply",
            {
              code: "chat_action_endpoint_unavailable",
            },
          );
        }
        await db.transaction(async (tx) => {
          const action = await tx
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpointId),
                eq(chatActions.id, actionId),
                eq(chatActions.kind, "provider_effect"),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!action) throw notFound("Provider action not found");
          if (action.status !== "delivery_unknown") {
            throw conflict(
              "Only an unconfirmed provider action needs operator resolution",
              {
                code: "chat_action_resolution_not_required",
              },
            );
          }
          const payload = providerEffectPayload(action.payload);
          if (!payload) {
            throw conflict("This provider action cannot be retried safely", {
              code: "chat_action_retry_context_missing",
            });
          }
          const delivery =
            payload.settleDelivery && action.deliveryId
              ? await tx
                  .select({ state: chatDeliveries.state })
                  .from(chatDeliveries)
                  .where(
                    and(
                      eq(chatDeliveries.endpointId, endpointId),
                      eq(chatDeliveries.id, action.deliveryId),
                    ),
                  )
                  .for("update")
                  .then((rows) => rows[0] ?? null)
              : null;
          if (payload.settleDelivery && action.deliveryId) {
            if (!delivery || delivery.state !== "failed") {
              throw conflict(
                "The provider action's delivery is no longer awaiting resolution",
                {
                  code: "chat_action_delivery_resolution_conflict",
                },
              );
            }
            await tx
              .update(chatDeliveries)
              .set({
                state: "processing",
                nextAttemptAt: null,
                redactedError: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatDeliveries.id, action.deliveryId),
                  eq(chatDeliveries.state, "failed"),
                ),
              );
          }
          const now = new Date();
          const [claimed] = await tx
            .update(chatActions)
            .set({
              status: "received",
              result: {
                ...(action.result ?? {}),
                code: "provider_effect_retry_requested",
                retryable: false,
                retryAt: null,
              },
              updatedAt: now,
            })
            .where(
              and(
                eq(chatActions.id, action.id),
                eq(chatActions.status, "delivery_unknown"),
              ),
            )
            .returning({ id: chatActions.id });
          if (!claimed) {
            throw conflict("This provider action is already being resolved", {
              code: "chat_action_resolution_conflict",
            });
          }
          await logActivity(tx as unknown as Db, {
            companyId: action.companyId,
            actorType: "user",
            actorId: userId,
            action: "chat.provider_effect_retry_anyway",
            entityType: "chat_action",
            entityId: action.id,
            details: {
              endpointId,
              conversationId: action.conversationId,
              deliveryId: action.deliveryId,
              previousState: "delivery_unknown",
              nextState: "received",
              duplicateRiskAccepted: true,
            },
          });
        });
        await processProviderEffect(actionId, undefined, true);
      });
      return;
    }

    await withCredentialMutationLease(initialRecord.endpoint, () =>
      db.transaction(async (tx) => {
        const action = await tx
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpointId),
              eq(chatActions.id, actionId),
              eq(chatActions.kind, "provider_effect"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!action) throw notFound("Provider action not found");
        if (action.status !== "delivery_unknown") {
          throw conflict(
            "Only an unconfirmed provider action needs operator resolution",
            {
              code: "chat_action_resolution_not_required",
            },
          );
        }
        const payload = providerEffectPayload(action.payload);
        if (!payload) {
          throw conflict("This provider action cannot be resolved safely", {
            code: "chat_action_resolution_context_missing",
          });
        }
        const delivery =
          payload.settleDelivery && action.deliveryId
            ? await tx
                .select({ state: chatDeliveries.state })
                .from(chatDeliveries)
                .where(
                  and(
                    eq(chatDeliveries.endpointId, endpointId),
                    eq(chatDeliveries.id, action.deliveryId),
                  ),
                )
                .for("update")
                .then((rows) => rows[0] ?? null)
            : null;
        if (
          payload.settleDelivery &&
          action.deliveryId &&
          (!delivery || delivery.state !== "failed")
        ) {
          throw conflict(
            "The provider action's delivery is no longer awaiting resolution",
            {
              code: "chat_action_delivery_resolution_conflict",
            },
          );
        }

        const now = new Date();
        const nextStatus =
          resolution === "mark_delivered" ? "processed" : "cancelled";
        const [resolved] = await tx
          .update(chatActions)
          .set({
            status: nextStatus,
            result: {
              ...(action.result ?? {}),
              code:
                resolution === "mark_delivered"
                  ? "provider_effect_marked_delivered_by_operator"
                  : "provider_effect_cancelled_by_operator",
              retryable: false,
              retryAt: null,
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(chatActions.id, action.id),
              eq(chatActions.status, "delivery_unknown"),
            ),
          )
          .returning({ id: chatActions.id });
        if (!resolved) {
          throw conflict("This provider action is already being resolved", {
            code: "chat_action_resolution_conflict",
          });
        }
        if (payload.settleDelivery && action.deliveryId) {
          await tx
            .update(chatDeliveries)
            .set(
              resolution === "mark_delivered"
                ? {
                    state: "processed",
                    processedAt: now,
                    nextAttemptAt: null,
                    redactedError: null,
                    updatedAt: now,
                  }
                : {
                    state: "filtered",
                    processedAt: now,
                    nextAttemptAt: null,
                    redactedError:
                      "Cancelled by an operator after an unconfirmed provider reply",
                    updatedAt: now,
                  },
            )
            .where(
              and(
                eq(chatDeliveries.id, action.deliveryId),
                eq(chatDeliveries.state, "failed"),
              ),
            );
        }
        if (resolution === "mark_delivered") {
          if (payload.completeConversationId) {
            await tx
              .update(chatConversations)
              .set({ state: "completed", updatedAt: now })
              .where(
                and(
                  eq(chatConversations.id, payload.completeConversationId),
                  eq(chatConversations.endpointId, endpointId),
                ),
              );
          }
          await tx
            .update(chatEndpoints)
            .set({ lastEventAt: now, updatedAt: now })
            .where(eq(chatEndpoints.id, endpointId));
        }
        await logActivity(tx as unknown as Db, {
          companyId: action.companyId,
          actorType: "user",
          actorId: userId,
          action: `chat.provider_effect_${resolution}`,
          entityType: "chat_action",
          entityId: action.id,
          details: {
            endpointId,
            conversationId: action.conversationId,
            deliveryId: action.deliveryId,
            completeConversationId: payload.completeConversationId ?? null,
            previousState: "delivery_unknown",
            nextState: nextStatus,
            duplicateRiskAccepted: false,
          },
        });
      }),
    );
  }

  async function resolveAction(
    endpointId: string,
    actionId: string,
    resolution: "mark_delivered" | "retry_anyway" | "cancel",
    userId: string,
  ) {
    const initialRecord = await endpointRecord(endpointId);
    if (!initialRecord) throw notFound("Chat endpoint not found");
    const initialAction = await db
      .select({ kind: chatActions.kind })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpointId),
          eq(chatActions.id, actionId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!initialAction) throw notFound("Provider action not found");
    if (initialAction.kind === "provider_effect") {
      await resolveProviderEffect(endpointId, actionId, resolution, userId);
      return;
    }
    if (initialRecord.endpoint.provider !== "slack") {
      throw conflict("This provider action cannot be resolved here", {
        code: "chat_action_resolution_unsupported",
      });
    }
    if (resolution === "mark_delivered") {
      throw conflict("A Slack task start cannot be marked delivered here", {
        code: "chat_action_resolution_unsupported",
      });
    }

    if (resolution === "cancel") {
      await withCredentialMutationLease(initialRecord.endpoint, async () => {
        await db
          .update(chatActions)
          .set({
            status: "delivery_unknown",
            result: { code: "slash_task_delivery_unknown" },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.endpointId, endpointId),
              eq(chatActions.id, actionId),
              eq(chatActions.kind, "slash_task_start"),
              or(
                and(
                  eq(chatActions.status, "received"),
                  lte(
                    chatActions.updatedAt,
                    new Date(Date.now() - SLACK_COMMAND_POST_STALE_MS),
                  ),
                ),
                and(
                  eq(chatActions.status, "resolving"),
                  lte(
                    chatActions.updatedAt,
                    new Date(
                      Date.now() - SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS,
                    ),
                  ),
                ),
              ),
            ),
          );
        await db.transaction(async (tx) => {
          const action = await tx
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpointId),
                eq(chatActions.id, actionId),
                eq(chatActions.kind, "slash_task_start"),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!action) throw notFound("Provider action not found");
          if (action.status !== "delivery_unknown") {
            throw conflict(
              "Only an unconfirmed provider action needs operator resolution",
              {
                code: "chat_action_resolution_not_required",
              },
            );
          }
          const now = new Date();
          await tx
            .update(chatActions)
            .set({
              status: "cancelled",
              result: { code: "slash_task_cancelled_by_operator" },
              updatedAt: now,
            })
            .where(
              and(
                eq(chatActions.id, action.id),
                eq(chatActions.status, "delivery_unknown"),
              ),
            );
          await logActivity(tx as unknown as Db, {
            companyId: action.companyId,
            actorType: "user",
            actorId: userId,
            action: "chat.slack_command_cancel",
            entityType: "chat_action",
            entityId: action.id,
            details: {
              endpointId,
              previousState: "delivery_unknown",
              nextState: "cancelled",
              duplicateRiskAccepted: false,
            },
          });
        });
      });
      return;
    }

    await withCredentialMutationLease(initialRecord.endpoint, async () => {
      await db
        .update(chatActions)
        .set({
          status: "delivery_unknown",
          result: { code: "slash_task_delivery_unknown" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.endpointId, endpointId),
            eq(chatActions.id, actionId),
            eq(chatActions.kind, "slash_task_start"),
            or(
              and(
                eq(chatActions.status, "received"),
                lte(
                  chatActions.updatedAt,
                  new Date(Date.now() - SLACK_COMMAND_POST_STALE_MS),
                ),
              ),
              and(
                eq(chatActions.status, "resolving"),
                lte(
                  chatActions.updatedAt,
                  new Date(Date.now() - SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS),
                ),
              ),
            ),
          ),
        );
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("Chat endpoint not found");
      if (
        record.endpoint.provider !== "slack" ||
        !["verifying", "active"].includes(record.endpoint.status)
      ) {
        throw conflict(
          "The Slack connection must be active before retrying this action",
          {
            code: "chat_action_endpoint_unavailable",
          },
        );
      }
      const action = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpointId),
            eq(chatActions.id, actionId),
            eq(chatActions.kind, "slash_task_start"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!action) throw notFound("Provider action not found");
      if (action.status !== "delivery_unknown") {
        throw conflict(
          "Only an unconfirmed provider action needs operator resolution",
          {
            code: "chat_action_resolution_not_required",
          },
        );
      }
      const recovery = slackSlashTaskRecoveryPayload(action.payload);
      if (!recovery) {
        throw conflict(
          "This action does not contain enough context for an explicit retry",
          {
            code: "chat_action_retry_context_missing",
          },
        );
      }
      if (!action.principalId) {
        throw conflict("The original Slack account is no longer available", {
          code: "chat_action_principal_missing",
        });
      }
      const principal = await db
        .select()
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.id, action.principalId),
            eq(chatExternalPrincipals.companyId, record.endpoint.companyId),
            eq(chatExternalPrincipals.provider, "slack"),
            eq(
              chatExternalPrincipals.providerAccountId,
              record.endpoint.providerAccountId ?? "unknown",
            ),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!principal || principal.isBot || principal.kind !== "user") {
        throw conflict("The original Slack account is no longer available", {
          code: "chat_action_principal_missing",
        });
      }
      const link = await db
        .select({
          paperclipUserId: chatIdentityLinks.paperclipUserId,
          status: chatIdentityLinks.status,
        })
        .from(chatIdentityLinks)
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpointId),
            eq(chatIdentityLinks.principalId, principal.id),
          ),
        )
        .then((rows) => rows[0] ?? null);
      let principalAllowed = false;
      if (link?.status === "linked" && link.paperclipUserId) {
        principalAllowed = await db
          .select({ membershipRole: companyMemberships.membershipRole })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, record.endpoint.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, link.paperclipUserId),
              eq(companyMemberships.status, "active"),
              ne(companyMemberships.membershipRole, "viewer"),
            ),
          )
          .then((rows) => rows.length > 0);
      } else if (record.endpoint.allowUnlinkedPeople) {
        principalAllowed = await sponsorAllowsGuest(record.endpoint);
      }

      const rawChannelId = recovery.channelId.replace(/^slack:/, "");
      const isDirectMessage = /^D[A-Z0-9]+$/i.test(rawChannelId);
      const resource = await db
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.endpointId, endpointId),
            eq(chatEndpointResources.providerResourceId, rawChannelId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const destinationAllowed = isDirectMessage
        ? record.endpoint.allowDirectMessages
        : nonDirectDestinationAllowed(record.endpoint, resource);
      if (!principalAllowed || !destinationAllowed) {
        throw conflict(
          "The original account or destination is no longer allowed",
          {
            code: "chat_action_no_longer_authorized",
          },
        );
      }

      // Resolve and validate the runtime before claiming the action. A local
      // setup failure at this point cannot have sent anything to Slack and
      // therefore leaves the original ambiguous action untouched.
      const endpointRuntime = await runtimeFor(record.endpoint);
      const baseThread = endpointRuntime.thread(`slack:${rawChannelId}:`);
      const retryAttempt =
        (typeof action.result?.attemptCount === "number" &&
        Number.isSafeInteger(action.result.attemptCount)
          ? Math.max(0, action.result.attemptCount)
          : 0) + 1;
      const [claimed] = await db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpointId),
              eq(chatActions.id, actionId),
              eq(chatActions.kind, "slash_task_start"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current) throw notFound("Provider action not found");
        if (current.status !== "delivery_unknown") {
          throw conflict(
            "Only an unconfirmed provider action needs operator resolution",
            {
              code: "chat_action_resolution_not_required",
            },
          );
        }
        const rows = await tx
          .update(chatActions)
          .set({
            status: "resolving",
            result: {
              code: "slash_task_retry_requested",
              attemptCount: retryAttempt,
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, current.id),
              eq(chatActions.status, "delivery_unknown"),
            ),
          )
          .returning();
        await logActivity(tx as unknown as Db, {
          companyId: current.companyId,
          actorType: "user",
          actorId: userId,
          action: "chat.slack_command_retry_anyway",
          entityType: "chat_action",
          entityId: current.id,
          details: {
            endpointId,
            previousState: "delivery_unknown",
            nextState: "resolving",
            duplicateRiskAccepted: true,
          },
        });
        return rows;
      });
      if (!claimed) {
        throw conflict("This provider action is already being resolved", {
          code: "chat_action_resolution_conflict",
        });
      }

      let starter: { id: string; threadId: string };
      try {
        starter = await baseThread.post("Starting a task…");
      } catch (error) {
        await finalizeSlackTaskStartFailure({
          actionId: action.id,
          actionStatus: "resolving",
          attempt: retryAttempt,
          connectionId: record.endpoint.connectionId,
          endpoint: record.endpoint,
          error,
          resource,
        });
        throw error;
      }
      const [completed] = await db
        .update(chatActions)
        .set({
          // The provider send is now confirmed, but task admission is a
          // separate durable phase. Persist this fence before constructing the
          // Paperclip delivery so a crash cannot turn into another Slack post.
          status: "provider_confirmed",
          result: {
            attemptCount: retryAttempt,
            threadId: slackTaskStarterThreadId(rawChannelId, starter.id),
            providerMessageId: starter.id,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "resolving"),
            sql`(${chatActions.result}->>'attemptCount')::int = ${retryAttempt}`,
          ),
        )
        .returning({ id: chatActions.id });
      // A deliberately cancelled action wins over a provider response that
      // arrived only after the operator's stale-action window. Keep the Slack
      // starter as an orphan rather than creating work the operator cancelled.
      if (!completed) return;
      await admitConfirmedSlackTaskStart(
        action.id,
        options.deferWebhookProcessing === true,
      );
    });
  }

  async function publishComment(
    endpointId: string,
    conversationId: string,
    commentId: string,
  ) {
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.id, conversationId),
          eq(chatConversations.endpointId, endpointId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!conversation) throw notFound("Conversation not found");
    const comment = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.id, commentId),
          eq(issueComments.issueId, conversation.issueId),
          isNull(issueComments.deletedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!comment) throw notFound("Task comment not found");
    const [publication] = await db
      .insert(chatPublications)
      .values({
        companyId: conversation.companyId,
        endpointId,
        conversationId,
        issueId: conversation.issueId,
        commentId,
        idempotencyKey: `explicit:${commentId}:${endpointId}`,
        payload: projectSafeChatPublication({
          classification: "external",
          source: "explicit_board_send",
          text: comment.body,
        }),
        state: "pending",
      })
      .onConflictDoNothing()
      .returning();
    await processPendingPublications();
    return (
      publication ??
      db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, conversation.companyId),
            eq(
              chatPublications.idempotencyKey,
              `explicit:${commentId}:${endpointId}`,
            ),
          ),
        )
        .then((rows) => rows[0])
    );
  }

  async function publishBoardMessage(
    endpointId: string,
    conversationId: string,
    body: string,
    clientIdempotencyKey: string,
    userId: string,
    attachmentIds: string[] = [],
  ) {
    const idempotencyKey = `explicit-board:${endpointId}:${clientIdempotencyKey}`;
    const publication = await db.transaction(async (tx) => {
      const conversation = await tx
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.id, conversationId),
            eq(chatConversations.endpointId, endpointId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!conversation) throw notFound("Conversation not found");

      const existing = await tx
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, conversation.companyId),
            eq(chatPublications.idempotencyKey, idempotencyKey),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const batch = await tx
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpointId),
              eq(chatPublications.conversationId, conversationId),
              eq(chatPublications.commentId, existing.commentId!),
            ),
          )
          .orderBy(asc(chatPublications.createdAt), asc(chatPublications.id));
        return (
          batch.find((candidate) => candidate.state !== "published") ??
          batch.at(-1) ??
          existing
        );
      }

      const comment = await issueService(tx as unknown as Db).addComment(
        conversation.issueId,
        body,
        { userId },
        { authorType: "user", attachmentIds },
        tx,
      );
      const attachedFiles = attachmentIds.length
        ? await tx
            .select({
              id: issueAttachments.id,
              originalFilename: assets.originalFilename,
            })
            .from(issueAttachments)
            .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
            .where(
              and(
                eq(issueAttachments.companyId, conversation.companyId),
                eq(issueAttachments.issueId, conversation.issueId),
                eq(issueAttachments.issueCommentId, comment.id),
                inArray(issueAttachments.id, attachmentIds),
              ),
            )
        : [];
      const attachedFileById = new Map(
        attachedFiles.map((file) => [file.id, file]),
      );
      const orderedFiles = attachmentIds.map((attachmentId) =>
        attachedFileById.get(attachmentId)!,
      );
      const publicationCreatedAt = new Date();
      const [created] = await tx
        .insert(chatPublications)
        .values({
          companyId: conversation.companyId,
          endpointId,
          conversationId,
          issueId: conversation.issueId,
          commentId: comment.id,
          idempotencyKey,
          payload: projectSafeChatPublication({
            classification: "external",
            source: "explicit_board_send",
            text: comment.body,
          }),
          state: "pending",
          createdAt: publicationCreatedAt,
          updatedAt: publicationCreatedAt,
        })
        .returning();
      let terminalPublication = created;
      for (const [index, file] of orderedFiles.entries()) {
        const attachmentCreatedAt = new Date(
          publicationCreatedAt.getTime() + index + 1,
        );
        const [attachmentPublication] = await tx
          .insert(chatPublications)
          .values({
            companyId: conversation.companyId,
            endpointId,
            conversationId,
            issueId: conversation.issueId,
            commentId: comment.id,
            idempotencyKey: `${idempotencyKey}:attachment:${file.id}`,
            payload: projectSafeChatPublication({
              classification: "external",
              source: "explicit_board_send",
              text: `Shared ${file.originalFilename ?? "a file"}.`,
              attachmentIds: [file.id],
            }),
            state: "pending",
            createdAt: attachmentCreatedAt,
            updatedAt: attachmentCreatedAt,
          })
          .returning();
        terminalPublication = attachmentPublication;
      }
      await logActivity(tx as unknown as Db, {
        companyId: conversation.companyId,
        actorType: "user",
        actorId: userId,
        action: "chat.publication_requested",
        entityType: "chat_publication",
        entityId: created.id,
        issueId: conversation.issueId,
        details: {
          endpointId,
          conversationId,
          commentId: comment.id,
          source: "explicit_board_send",
        },
      });
      return terminalPublication;
    });
    await processPendingPublications();
    const batch = publication.commentId
      ? await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpointId),
              eq(chatPublications.conversationId, conversationId),
              eq(chatPublications.commentId, publication.commentId),
            ),
          )
          .orderBy(asc(chatPublications.createdAt), asc(chatPublications.id))
      : [publication];
    // A multi-part send is successful only when every ordered publication is
    // published. Surface the first blocking row so the UI points operators at
    // the actual retry/duplicate-risk resolution instead of a later pending
    // attachment that cannot advance past it.
    return (
      batch.find((candidate) => candidate.state !== "published") ??
      batch.at(-1) ??
      publication
    );
  }

  async function publicationFiles(
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
  ): Promise<FileUpload[]> {
    if (!payload.attachmentIds?.length) return [];
    if (!options.storage)
      throw new Error("Attachment storage is unavailable for chat publication");
    const rows = await db
      .select({
        id: issueAttachments.id,
        issueId: issueAttachments.issueId,
        issueCommentId: issueAttachments.issueCommentId,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        originalFilename: assets.originalFilename,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .where(
        and(
          eq(issueAttachments.companyId, publication.companyId),
          eq(issueAttachments.issueId, publication.issueId),
          inArray(issueAttachments.id, payload.attachmentIds),
        ),
      );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const files: FileUpload[] = [];
    for (const attachmentId of payload.attachmentIds) {
      const row = byId.get(attachmentId);
      if (
        !row ||
        (publication.commentId &&
          row.issueCommentId !== publication.commentId) ||
        row.byteSize <= 0 ||
        row.byteSize > MAX_ATTACHMENT_BYTES ||
        !isAllowedContentType(row.contentType)
      )
        throw new Error(
          "Chat publication attachment is outside its authorized task comment",
        );
      const object = await options.storage.getObject(
        publication.companyId,
        row.objectKey,
      );
      if (
        object.contentLength !== undefined &&
        object.contentLength > MAX_ATTACHMENT_BYTES
      )
        throw new Error(
          "Chat publication attachment exceeds the configured size limit",
        );
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of object.stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_ATTACHMENT_BYTES)
          throw new Error(
            "Chat publication attachment exceeded its streaming byte limit",
          );
        chunks.push(buffer);
      }
      if (bytes !== row.byteSize)
        throw new Error(
          "Chat publication attachment size changed after registration",
        );
      files.push({
        data: Buffer.concat(chunks, bytes),
        filename: row.originalFilename ?? `attachment-${attachmentId}`,
        mimeType: row.contentType,
      });
    }
    return files;
  }

  async function postSafePublication(input: {
    endpoint: EndpointRow;
    conversation: ConversationRow;
    publication: typeof chatPublications.$inferSelect;
    payload: SafeChatPublicationPayload;
    replaceProviderMessageId?: string | null;
  }) {
    const endpointRuntime = await runtimeFor(input.endpoint);
    const thread = endpointRuntime.thread(input.conversation.externalThreadId);
    const card = safeCardForPublication(input.payload, input.endpoint.provider);
    let files: FileUpload[] = [];
    let text = input.payload.text;
    if (input.payload.attachmentIds?.length) {
      const nativeFileSurface =
        CAPABILITIES[input.endpoint.provider].files &&
        input.endpoint.provider !== "microsoft-teams";
      if (nativeFileSurface) {
        files = await publicationFiles(input.publication, input.payload);
      } else {
        const baseUrl = absoluteBaseUrl(options.publicBaseUrl);
        text = `${text}\n\n${
          baseUrl
            ? `Open the task in Paperclip: ${baseUrl}/issues/${input.publication.issueId}`
            : "Open the task in Paperclip to download the attachment."
        }`;
      }
    }
    if (card && CAPABILITIES[input.endpoint.provider].cards) {
      return await attemptProviderPublication(async () =>
        input.replaceProviderMessageId
          ? await editOrPostProviderPublication(
              () =>
                thread.adapter.editMessage(
                  thread.id,
                  input.replaceProviderMessageId!,
                  {
                    card,
                    fallbackText: text,
                    ...(files.length ? { files } : {}),
                  },
                ),
              () =>
                thread.post({
                  card,
                  fallbackText: text,
                  ...(files.length ? { files } : {}),
                }),
            )
          : await thread.post({
              card,
              fallbackText: text,
              ...(files.length ? { files } : {}),
            }),
      );
    }
    if (files.length) {
      // The pinned Slack adapter performs file upload and text publication as
      // two provider calls when both fields are present. A rate limit or
      // network failure on the second call would make an automatic retry
      // duplicate the already-shared file. File publications have their own
      // ordered outbox row, so Slack receives a single native upload here.
      const fileMessage: AdapterPostableMessage = {
        // Empty Slack markdown keeps the SDK call type-safe while its pinned
        // adapter treats this as a file-only upload and skips chat.postMessage.
        markdown: input.endpoint.provider === "slack" ? "" : text,
        files,
      };
      return await attemptProviderPublication(async () =>
        input.replaceProviderMessageId
          ? await editOrPostProviderPublication(
              () =>
                thread.adapter.editMessage(
                  thread.id,
                  input.replaceProviderMessageId!,
                  fileMessage,
                ),
              () => thread.post(fileMessage),
            )
          : await thread.post(fileMessage),
      );
    }
    if (
      !input.replaceProviderMessageId &&
      CAPABILITIES[input.endpoint.provider].nativeStreaming &&
      shouldStreamSafePublicationText(text)
    ) {
      return await attemptProviderPublication(
        async () => await thread.post(streamSafePublicationText(text)),
      );
    }
    return await attemptProviderPublication(async () =>
      input.replaceProviderMessageId
        ? await editOrPostProviderPublication(
            () =>
              thread.adapter.editMessage(
                thread.id,
                input.replaceProviderMessageId!,
                { markdown: text },
              ),
            () => thread.post({ markdown: text }),
          )
        : await thread.post({ markdown: text }),
    );
  }

  async function postPublicationWithCurrentTaskControlAuthorization(input: {
    endpoint: EndpointRow;
    conversation: ConversationRow;
    publication: typeof chatPublications.$inferSelect;
    payload: SafeChatPublicationPayload;
    replaceProviderMessageId?: string | null;
  }): Promise<{
    authorizationActionId: string | null;
    sent: Awaited<ReturnType<typeof postSafePublication>>;
  } | null> {
    if (!input.publication.idempotencyKey.startsWith("control:")) {
      return {
        authorizationActionId: null,
        sent: await postSafePublication(input),
      };
    }
    return db.transaction(async (tx) => {
      const endpoint = await tx
        .select()
        .from(chatEndpoints)
        .where(
          and(
            eq(chatEndpoints.companyId, input.publication.companyId),
            eq(chatEndpoints.id, input.publication.endpointId),
            inArray(chatEndpoints.status, ["verifying", "active"]),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const conversation = endpoint
        ? await tx
            .select()
            .from(chatConversations)
            .where(
              and(
                eq(chatConversations.companyId, endpoint.companyId),
                eq(chatConversations.endpointId, endpoint.id),
                eq(chatConversations.id, input.publication.conversationId),
                inArray(chatConversations.state, ["active", "waiting"]),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      const resource =
        endpoint && conversation?.resourceId && !conversation.isDirectMessage
          ? await tx
              .select()
              .from(chatEndpointResources)
              .where(
                and(
                  eq(chatEndpointResources.companyId, endpoint.companyId),
                  eq(chatEndpointResources.endpointId, endpoint.id),
                  eq(chatEndpointResources.id, conversation.resourceId),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null)
          : null;
      const authorizationAction = endpoint
        ? await tx
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.companyId, endpoint.companyId),
                eq(chatActions.endpointId, endpoint.id),
                eq(chatActions.conversationId, conversation?.id ?? ""),
                eq(chatActions.kind, "task_control_authorization"),
                eq(
                  chatActions.providerActionId,
                  `task-control-authorization:${input.publication.id}`,
                ),
                eq(chatActions.status, "issued"),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      const destinationAllowed =
        endpoint !== null &&
        conversation !== null &&
        (conversation.isDirectMessage
          ? endpoint.allowDirectMessages
          : nonDirectDestinationAllowed(endpoint, resource));
      if (
        !endpoint ||
        !conversation ||
        !authorizationAction?.principalId ||
        !destinationAllowed
      ) {
        return null;
      }
      const authorization = await lockCurrentPrincipalAuthorization(
        tx,
        endpoint,
        authorizationAction.principalId,
      );
      if (!authorization.allowed) return null;

      // Keep the principal/link/member rows locked until the provider accepts
      // the control reply. This is the command's authorization linearization
      // point: a concurrent revoke either commits before the send and blocks
      // it, or waits until this already-authorized provider action completes.
      return {
        authorizationActionId: authorizationAction.id,
        sent: await postSafePublication({
          ...input,
          endpoint,
          conversation,
        }),
      };
    });
  }

  function runIdFromMilestonePublication(
    publication: typeof chatPublications.$inferSelect,
  ): string | null {
    if (!publication.payload.progressState) return null;
    const match = /^run:([^:]+):(?:queued|working|completed|failed):/.exec(
      publication.idempotencyKey,
    );
    return match?.[1] ?? null;
  }

  async function runPublicationToReplace(
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
  ): Promise<string | null> {
    if (payload.attachmentIds?.length) return null;
    const currentRunId =
      runIdFromMilestonePublication(publication) ??
      (publication.commentId
        ? await db
            .select({ runId: issueComments.createdByRunId })
            .from(issueComments)
            .where(eq(issueComments.id, publication.commentId))
            .then((rows) => rows[0]?.runId ?? null)
        : null);
    if (!currentRunId) return null;
    return db
      .select({
        id: chatPublications.id,
        commentId: chatPublications.commentId,
        providerMessageId: chatPublications.providerMessageId,
        payload: chatPublications.payload,
      })
      .from(chatPublications)
      .leftJoin(issueComments, eq(issueComments.id, chatPublications.commentId))
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.state, "published"),
          isNotNull(chatPublications.providerMessageId),
          or(
            like(chatPublications.idempotencyKey, `run:${currentRunId}:%`),
            eq(issueComments.createdByRunId, currentRunId),
          ),
        ),
      )
      .orderBy(desc(chatPublications.createdAt), desc(chatPublications.id))
      .then((rows) => {
        // Progress updates are one replaceable provider-message lane per run.
        // The first durable agent comment may turn that placeholder into the
        // terminal response, but later comments from the same run are distinct
        // user-visible outputs and must be posted separately. Re-editing the
        // placeholder for each comment silently erases the earlier replies.
        if (
          publication.commentId &&
          rows.some(
            (row) =>
              row.commentId !== null && row.payload.progressState === undefined,
          )
        )
          return null;
        const replacement = rows.find(
          (row) =>
            Boolean(row.providerMessageId) &&
            row.payload.progressState !== undefined,
        );
        if (!replacement?.providerMessageId) return null;
        // Replacement identity belongs to the run, not to the provider-visible
        // tail. A status/control reply may legitimately interleave while the run
        // is active; making the tail the edit candidate would strand this run's
        // working placeholder forever. The query is bounded by endpoint,
        // conversation (the task generation), and run id, so an interleaved
        // control or another run can never donate its provider message here.
        return replacement.providerMessageId;
      });
  }

  async function interactionResolutionPublicationToReplace(
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
  ): Promise<string | null> {
    if (
      !publication.idempotencyKey.startsWith("interaction-resolution:") ||
      !payload.interactionId
    )
      return null;
    return db
      .select({ providerMessageId: chatPublications.providerMessageId })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.issueId, publication.issueId),
          eq(
            chatPublications.idempotencyKey,
            `interaction:${payload.interactionId}:${publication.endpointId}`,
          ),
          eq(chatPublications.state, "published"),
          isNotNull(chatPublications.providerMessageId),
        ),
      )
      .then((rows) => rows[0]?.providerMessageId ?? null);
  }

  async function interactionPromptPublicationToReplace(
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
  ): Promise<string | null> {
    if (
      !payload.interactionId ||
      publication.idempotencyKey !==
        `interaction:${payload.interactionId}:${publication.endpointId}`
    ) {
      return null;
    }
    const interaction = await db
      .select({
        kind: issueThreadInteractions.kind,
        sourceRunId: issueThreadInteractions.sourceRunId,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.id, payload.interactionId),
          eq(issueThreadInteractions.companyId, publication.companyId),
          eq(issueThreadInteractions.issueId, publication.issueId),
          inArray(issueThreadInteractions.kind, [
            "ask_user_questions",
            "request_confirmation",
          ]),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!interaction?.sourceRunId) return null;

    // A provider-visible interaction is this run's response, not an additional
    // message beside its progress indicator. Move the durable interaction
    // publication onto the exact source run's provider-message lane. This
    // retires both the normal working placeholder and the queued placeholder
    // when a very fast run asks before the working update is published.
    for (const progressState of ["working", "queued"] as const) {
      const providerMessageId = await db
        .select({ providerMessageId: chatPublications.providerMessageId })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, publication.companyId),
            eq(chatPublications.endpointId, publication.endpointId),
            eq(chatPublications.conversationId, publication.conversationId),
            eq(chatPublications.issueId, publication.issueId),
            eq(
              chatPublications.idempotencyKey,
              `run:${interaction.sourceRunId}:${progressState}:${publication.endpointId}`,
            ),
            eq(chatPublications.state, "published"),
            isNotNull(chatPublications.providerMessageId),
          ),
        )
        .then((rows) => rows[0]?.providerMessageId ?? null);
      if (providerMessageId) return providerMessageId;
    }
    return null;
  }

  async function runProgressSupersededByPublishedInteraction(
    publication: typeof chatPublications.$inferSelect,
  ): Promise<boolean> {
    if (
      !["queued", "working"].includes(publication.payload.progressState ?? "")
    ) {
      return false;
    }
    const sourceRunId = runIdFromMilestonePublication(publication);
    if (!sourceRunId) return false;
    const interactionIds = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, publication.companyId),
          eq(issueThreadInteractions.issueId, publication.issueId),
          eq(issueThreadInteractions.sourceRunId, sourceRunId),
          inArray(issueThreadInteractions.kind, [
            "ask_user_questions",
            "request_confirmation",
          ]),
        ),
      )
      .then((rows) => rows.map((row) => row.id));
    if (interactionIds.length === 0) return false;
    return db
      .select({ id: chatPublications.id })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.issueId, publication.issueId),
          eq(chatPublications.state, "published"),
          inArray(
            chatPublications.idempotencyKey,
            interactionIds.map(
              (interactionId) =>
                `interaction:${interactionId}:${publication.endpointId}`,
            ),
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
  }

  async function taskStatusPublicationToReplace(
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
  ): Promise<string | null> {
    if (
      !publication.idempotencyKey.startsWith("control:status:") ||
      payload.attachmentIds?.length
    )
      return null;
    const rows = await db
      .select({
        commentId: chatPublications.commentId,
        commentRunId: issueComments.createdByRunId,
        idempotencyKey: chatPublications.idempotencyKey,
        payload: chatPublications.payload,
        providerMessageId: chatPublications.providerMessageId,
      })
      .from(chatPublications)
      .leftJoin(issueComments, eq(issueComments.id, chatPublications.commentId))
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.state, "published"),
          isNotNull(chatPublications.providerMessageId),
        ),
      )
      .orderBy(desc(chatPublications.createdAt), desc(chatPublications.id));
    const rowRunId = (row: (typeof rows)[number]) => {
      const milestoneMatch =
        /^run:([^:]+):(?:queued|working|completed|failed):/.exec(
          row.idempotencyKey,
        );
      return milestoneMatch?.[1] ?? row.commentRunId ?? null;
    };
    for (const candidate of rows) {
      if (
        !candidate.providerMessageId ||
        !["queued", "working"].includes(candidate.payload.progressState ?? "")
      ) {
        continue;
      }
      const runId = rowRunId(candidate);
      if (!runId) continue;
      const laneClosed = rows.some((row) => {
        if (rowRunId(row) !== runId) return false;
        return (
          ["completed", "failed"].includes(row.payload.progressState ?? "") ||
          (row.commentId !== null && row.payload.progressState === undefined)
        );
      });
      if (!laneClosed) return candidate.providerMessageId;
    }
    return null;
  }

  async function currentTaskControlPayload(
    publication: typeof chatPublications.$inferSelect,
  ): Promise<SafeChatPublicationPayload> {
    const persisted = publication.payload as SafeChatPublicationPayload;
    if (!publication.idempotencyKey.startsWith("control:status:")) {
      return persisted;
    }
    const issue = await db
      .select({
        identifier: issues.identifier,
        status: issues.status,
        title: issues.title,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, publication.companyId),
          eq(issues.id, publication.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!issue) return persisted;
    return projectSafeChatPublication({
      classification: "external",
      source: "task_control",
      text: `${issue.identifier}: ${issue.title} — ${issue.status}`,
    });
  }

  function taskControlCompletesConversation(
    publication: Pick<typeof chatPublications.$inferSelect, "idempotencyKey">,
  ): boolean {
    return /^control:(?:new|close):/.test(publication.idempotencyKey);
  }

  function isExplicitOperatorPublication(
    publication: Pick<typeof chatPublications.$inferSelect, "idempotencyKey">,
  ): boolean {
    return /^(?:explicit:|explicit-board:)/.test(publication.idempotencyKey);
  }

  async function hasCommittedTaskControlCompletion(
    conversationId: string,
  ): Promise<boolean> {
    return db
      .select({ id: chatPublications.id })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.conversationId, conversationId),
          eq(chatPublications.state, "published"),
          or(
            like(chatPublications.idempotencyKey, "control:new:%"),
            like(chatPublications.idempotencyKey, "control:close:%"),
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
  }

  async function commitTaskControlCompletion(
    tx: Db,
    publication: Pick<
      typeof chatPublications.$inferSelect,
      | "companyId"
      | "conversationId"
      | "createdAt"
      | "endpointId"
      | "id"
      | "idempotencyKey"
    >,
    committedAt: Date,
  ): Promise<void> {
    if (!taskControlCompletesConversation(publication)) return;
    await tx
      .update(chatConversations)
      .set({ state: "completed", updatedAt: committedAt })
      .where(
        and(
          eq(chatConversations.companyId, publication.companyId),
          eq(chatConversations.endpointId, publication.endpointId),
          eq(chatConversations.id, publication.conversationId),
          inArray(chatConversations.state, ["active", "waiting"]),
        ),
      );
    // The provider-visible completion is the external boundary. Anything
    // enqueued later for this old generation stays internal even if its run
    // finishes after /new or /close. A racing insert that commits after this
    // transaction is rejected by the completed-conversation send guard.
    await tx
      .update(chatPublications)
      .set({
        state: "cancelled",
        nextAttemptAt: null,
        redactedError:
          "Conversation was completed by a task control before delivery",
        updatedAt: committedAt,
      })
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          or(
            gt(chatPublications.createdAt, publication.createdAt),
            and(
              eq(chatPublications.createdAt, publication.createdAt),
              gt(chatPublications.id, publication.id),
            ),
          ),
          inArray(chatPublications.state, ["pending", "retry", "streaming"]),
          sql`not (${chatPublications.idempotencyKey} like 'explicit:%' or ${chatPublications.idempotencyKey} like 'explicit-board:%')`,
        ),
      );
  }

  async function finalizePublicationFailure(
    publication: typeof chatPublications.$inferSelect,
    error: unknown,
  ): Promise<boolean> {
    const attempts = publication.attempts + 1;
    const disposition = classifyChatPublicationError(error, attempts);
    const failure = redactSensitiveText(disposition.reason).slice(
      0,
      MAX_ERROR_TEXT,
    );
    const terminalRetry = disposition.kind === "retry" && attempts >= 5;
    const failedEndpointRecord =
      disposition.kind === "endpoint_attention"
        ? await endpointRecord(publication.endpointId)
        : null;
    const finalized = await db.transaction(async (tx) => {
      const state =
        disposition.kind === "retry" && !terminalRetry
          ? "retry"
          : disposition.kind === "delivery_unknown"
            ? "delivery_unknown"
            : disposition.kind === "resource_unavailable"
              ? "cancelled"
              : "failed";
      const [ownedPublication] = await tx
        .update(chatPublications)
        .set({
          state,
          nextAttemptAt:
            disposition.kind === "retry" && !terminalRetry
              ? new Date(Date.now() + disposition.retryAfterMs)
              : null,
          redactedError: failure,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatPublications.id, publication.id),
            eq(chatPublications.state, "streaming"),
            eq(chatPublications.attempts, attempts),
          ),
        )
        .returning({ id: chatPublications.id });
      if (!ownedPublication) return false;

      if (disposition.kind === "endpoint_attention") {
        await tx
          .update(chatEndpoints)
          .set({
            status: "attention",
            healthMessage: "Provider credentials or permissions need attention",
            lastError: failure,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, publication.endpointId));
        if (failedEndpointRecord) {
          await tx
            .update(toolConnections)
            .set({
              status: "disabled",
              enabled: false,
              healthStatus: "degraded",
              healthMessage:
                "Provider credentials or permissions need attention",
              lastError: failure,
              healthCheckedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              eq(
                toolConnections.id,
                failedEndpointRecord.endpoint.connectionId,
              ),
            );
        }
      } else if (disposition.kind === "resource_unavailable") {
        const binding = await tx
          .select({ resourceId: chatConversations.resourceId })
          .from(chatConversations)
          .where(eq(chatConversations.id, publication.conversationId))
          .then((result) => result[0] ?? null);
        await tx
          .update(chatConversations)
          .set({ state: "unavailable", updatedAt: new Date() })
          .where(eq(chatConversations.id, publication.conversationId));
        if (binding?.resourceId) {
          await tx
            .update(chatEndpointResources)
            .set({ availability: "unavailable", updatedAt: new Date() })
            .where(eq(chatEndpointResources.id, binding.resourceId));
        }
      }

      return true;
    });
    if (finalized && disposition.kind === "endpoint_attention") {
      await invalidateRuntime(publication.endpointId).catch(() => undefined);
    }
    if (finalized) {
      logger.warn(
        {
          endpointId: publication.endpointId,
          publicationId: publication.id,
          error: failure,
          disposition: disposition.kind,
        },
        "chat publication failed",
      );
    }
    return finalized;
  }

  async function processPendingPublications(limit = 25) {
    await reconcileTerminalConfirmationActions(limit);
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 60_000);
    // A process that disappears after the provider accepted a post but before
    // Paperclip persisted its message id leaves an ambiguous delivery. Never
    // resend it automatically; an operator can explicitly replay after
    // checking the provider conversation.
    await db
      .update(chatPublications)
      .set({
        state: "delivery_unknown",
        nextAttemptAt: null,
        redactedError:
          "Provider delivery could not be confirmed after the worker stopped. Check the external conversation before replaying.",
        updatedAt: now,
      })
      .where(
        and(
          eq(chatPublications.state, "streaming"),
          lte(chatPublications.updatedAt, staleBefore),
        ),
      );
    const earlierPublication = alias(
      chatPublications,
      "earlier_chat_publications",
    );
    const attemptedIds: string[] = [];
    while (attemptedIds.length < limit) {
      // Select only each conversation's current head before applying the
      // global limit. Re-query after every batch so one invocation can still
      // drain a conversation's newly unblocked milestones in FIFO order.
      const rows = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            inArray(chatPublications.state, ["pending", "retry"]),
            or(
              isNull(chatPublications.nextAttemptAt),
              lte(chatPublications.nextAttemptAt, now),
            ),
            attemptedIds.length > 0
              ? notInArray(chatPublications.id, attemptedIds)
              : undefined,
            notExists(
              db
                .select({ id: earlierPublication.id })
                .from(earlierPublication)
                .where(
                  and(
                    eq(
                      earlierPublication.conversationId,
                      chatPublications.conversationId,
                    ),
                    or(
                      lt(
                        earlierPublication.createdAt,
                        chatPublications.createdAt,
                      ),
                      and(
                        eq(
                          earlierPublication.createdAt,
                          chatPublications.createdAt,
                        ),
                        lt(earlierPublication.id, chatPublications.id),
                      ),
                    ),
                    inArray(earlierPublication.state, [
                      "pending",
                      "retry",
                      "streaming",
                      "delivery_unknown",
                    ]),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(chatPublications.createdAt), asc(chatPublications.id))
        .limit(limit - attemptedIds.length);
      if (rows.length === 0) break;
      for (const publication of rows) {
        attemptedIds.push(publication.id);
        const earlierOpenPublication = await db
          .select({ id: chatPublications.id })
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.conversationId, publication.conversationId),
              or(
                lt(chatPublications.createdAt, publication.createdAt),
                and(
                  eq(chatPublications.createdAt, publication.createdAt),
                  lt(chatPublications.id, publication.id),
                ),
              ),
              inArray(chatPublications.state, [
                "pending",
                "retry",
                "streaming",
                "delivery_unknown",
              ]),
            ),
          )
          .limit(1)
          .then((result) => result[0] ?? null);
        if (earlierOpenPublication) continue;
        const claimWhere = [
          eq(chatPublications.id, publication.id),
          eq(chatPublications.state, publication.state),
        ];
        const claimed = await db
          .update(chatPublications)
          .set({
            state: "streaming",
            attempts: publication.attempts + 1,
            updatedAt: now,
          })
          .where(and(...claimWhere))
          .returning();
        if (!claimed.length) continue;
        let enteredEndpointLease = false;
        try {
          const endpointForLease = await db
            .select()
            .from(chatEndpoints)
            .where(eq(chatEndpoints.id, publication.endpointId))
            .then((result) => result[0] ?? null);
          if (!endpointForLease)
            throw new Error("Chat publication binding is unavailable");
          // Provider sends share the endpoint mutation lease with pause,
          // reconnect, credential rotation, and removal. A management action
          // therefore either wins before transport begins, or waits until the
          // provider result and publication ledger commit together. This also
          // serializes competing workers for one provider bot without reducing
          // concurrency across independent endpoints.
          await withCredentialMutationLease(endpointForLease, async () => {
            enteredEndpointLease = true;
            try {
              const [endpoint, conversation] = await Promise.all([
                db
                  .select()
                  .from(chatEndpoints)
                  .where(eq(chatEndpoints.id, publication.endpointId))
                  .then((result) => result[0] ?? null),
                db
                  .select()
                  .from(chatConversations)
                  .where(eq(chatConversations.id, publication.conversationId))
                  .then((result) => result[0] ?? null),
              ]);
              if (!endpoint || !conversation)
                throw new Error("Chat publication binding is unavailable");
              const providerVisibleCompletion =
                conversation.state === "completed" &&
                !isExplicitOperatorPublication(publication) &&
                (await hasCommittedTaskControlCompletion(conversation.id));
              if (
                endpoint.status === "paused" ||
                endpoint.status === "attention"
              ) {
                await db
                  .update(chatPublications)
                  .set({
                    state: "pending",
                    attempts: publication.attempts,
                    nextAttemptAt: null,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(chatPublications.id, publication.id),
                      eq(chatPublications.state, "streaming"),
                      eq(chatPublications.attempts, publication.attempts + 1),
                    ),
                  );
                return;
              }
              // The setup conversation is a real end-to-end test: once provider
              // credentials are verified, its safe agent response must be able to
              // reach the provider before the operator confirms the final wizard
              // step. Draft, paused, revoked, and archived endpoints remain closed.
              if (
                !["active", "verifying"].includes(endpoint.status) ||
                ["unavailable", "endpoint_removed"].includes(
                  conversation.state,
                ) ||
                providerVisibleCompletion
              ) {
                await db
                  .update(chatPublications)
                  .set({
                    state: "cancelled",
                    redactedError: providerVisibleCompletion
                      ? "Conversation was completed before delivery"
                      : "External destination is no longer active",
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(chatPublications.id, publication.id),
                      eq(chatPublications.state, "streaming"),
                      eq(chatPublications.attempts, publication.attempts + 1),
                    ),
                  );
                return;
              }
              if (conversation.isDirectMessage) {
                if (!endpoint.allowDirectMessages) {
                  await db
                    .update(chatPublications)
                    .set({
                      state: "cancelled",
                      redactedError:
                        "Direct messages are disabled in Paperclip",
                      updatedAt: new Date(),
                    })
                    .where(
                      and(
                        eq(chatPublications.id, publication.id),
                        eq(chatPublications.state, "streaming"),
                        eq(chatPublications.attempts, publication.attempts + 1),
                      ),
                    );
                  return;
                }
              } else {
                const resource = conversation.resourceId
                  ? await db
                      .select()
                      .from(chatEndpointResources)
                      .where(
                        and(
                          eq(chatEndpointResources.id, conversation.resourceId),
                          eq(chatEndpointResources.endpointId, endpoint.id),
                          eq(
                            chatEndpointResources.companyId,
                            endpoint.companyId,
                          ),
                        ),
                      )
                      .then((result) => result[0] ?? null)
                  : null;
                if (!nonDirectDestinationAllowed(endpoint, resource)) {
                  await db
                    .update(chatPublications)
                    .set({
                      state: "cancelled",
                      redactedError: "Destination is disabled in Paperclip",
                      updatedAt: new Date(),
                    })
                    .where(
                      and(
                        eq(chatPublications.id, publication.id),
                        eq(chatPublications.state, "streaming"),
                        eq(chatPublications.attempts, publication.attempts + 1),
                      ),
                    );
                  return;
                }
              }
              const interactionId = publication.payload.interactionId;
              const isInteractionPrompt =
                Boolean(interactionId) &&
                publication.idempotencyKey ===
                  `interaction:${interactionId}:${publication.endpointId}`;
              if (isInteractionPrompt && publication.issueId) {
                const currentInteraction = await db
                  .select({ status: issueThreadInteractions.status })
                  .from(issueThreadInteractions)
                  .where(
                    and(
                      eq(issueThreadInteractions.id, interactionId!),
                      eq(
                        issueThreadInteractions.companyId,
                        publication.companyId,
                      ),
                      eq(issueThreadInteractions.issueId, publication.issueId),
                    ),
                  )
                  .then((result) => result[0] ?? null);
                if (
                  !currentInteraction ||
                  currentInteraction.status !== "pending"
                ) {
                  await db
                    .update(chatPublications)
                    .set({
                      state: "cancelled",
                      attempts: publication.attempts,
                      nextAttemptAt: null,
                      redactedError:
                        "Interaction resolved before provider delivery",
                      updatedAt: new Date(),
                    })
                    .where(
                      and(
                        eq(chatPublications.id, publication.id),
                        eq(chatPublications.state, "streaming"),
                        eq(chatPublications.attempts, publication.attempts + 1),
                      ),
                    );
                  return;
                }
              }
              if (
                await runProgressSupersededByPublishedInteraction(publication)
              ) {
                await db
                  .update(chatPublications)
                  .set({
                    state: "cancelled",
                    attempts: publication.attempts,
                    nextAttemptAt: null,
                    redactedError:
                      "Run progress was superseded by its provider interaction",
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(chatPublications.id, publication.id),
                      eq(chatPublications.state, "streaming"),
                      eq(chatPublications.attempts, publication.attempts + 1),
                    ),
                  );
                return;
              }
              // Status is sampled when it reaches the head of the provider lane,
              // not when the command was admitted. If an already-streaming final
              // publication won the race, this reply reflects Paperclip's latest
              // authoritative task state after that earlier send commits.
              const payload = await currentTaskControlPayload(publication);
              const replaceProviderMessageId = CAPABILITIES[endpoint.provider]
                .messageEdits
                ? ((await interactionResolutionPublicationToReplace(
                    publication,
                    payload,
                  )) ??
                  (await interactionPromptPublicationToReplace(
                    publication,
                    payload,
                  )) ??
                  (await runPublicationToReplace(publication, payload)) ??
                  (await taskStatusPublicationToReplace(publication, payload)))
                : null;
              const authorizedSend =
                await postPublicationWithCurrentTaskControlAuthorization({
                  endpoint,
                  conversation,
                  publication,
                  payload,
                  replaceProviderMessageId,
                });
              if (!authorizedSend) {
                await db.transaction(async (tx) => {
                  await tx
                    .update(chatPublications)
                    .set({
                      state: "cancelled",
                      nextAttemptAt: null,
                      redactedError:
                        "Task control requester or destination is no longer authorized",
                      updatedAt: new Date(),
                    })
                    .where(
                      and(
                        eq(chatPublications.id, publication.id),
                        eq(chatPublications.state, "streaming"),
                        eq(chatPublications.attempts, publication.attempts + 1),
                      ),
                    );
                  await tx
                    .update(chatActions)
                    .set({
                      status: "cancelled",
                      result: {
                        code: "task_control_authorization_changed",
                      },
                      updatedAt: new Date(),
                    })
                    .where(
                      and(
                        eq(chatActions.endpointId, publication.endpointId),
                        eq(
                          chatActions.providerActionId,
                          `task-control-authorization:${publication.id}`,
                        ),
                        eq(chatActions.status, "issued"),
                      ),
                    );
                });
                return;
              }
              const { authorizationActionId, sent } = authorizedSend;
              await db.transaction(async (tx) => {
                const committedAt = new Date();
                const [completedPublication] = await tx
                  .update(chatPublications)
                  .set({
                    state: "published",
                    payload,
                    providerMessageId: sent.id,
                    publishedAt: committedAt,
                    redactedError: null,
                    updatedAt: committedAt,
                  })
                  .where(
                    and(
                      eq(chatPublications.id, publication.id),
                      eq(chatPublications.state, "streaming"),
                      eq(chatPublications.attempts, publication.attempts + 1),
                    ),
                  )
                  .returning({ id: chatPublications.id });
                if (!completedPublication) {
                  throw new Error(
                    "Chat publication ownership changed before commit",
                  );
                }
                const messageLinkInsert = tx.insert(chatMessageLinks).values({
                  companyId: publication.companyId,
                  endpointId: publication.endpointId,
                  conversationId: publication.conversationId,
                  publicationId: publication.id,
                  commentId: publication.commentId,
                  providerMessageId: sent.id,
                  direction: "outbound",
                });
                if (replaceProviderMessageId) {
                  await messageLinkInsert.onConflictDoUpdate({
                    target: [
                      chatMessageLinks.endpointId,
                      chatMessageLinks.conversationId,
                      chatMessageLinks.providerMessageId,
                    ],
                    set: {
                      publicationId: publication.id,
                      commentId: publication.commentId,
                    },
                  });
                } else {
                  await messageLinkInsert.onConflictDoNothing();
                }
                await tx
                  .update(chatEndpoints)
                  .set({
                    lastPublicationAt: committedAt,
                    updatedAt: committedAt,
                  })
                  .where(eq(chatEndpoints.id, endpoint.id));
                if (authorizationActionId) {
                  await tx
                    .update(chatActions)
                    .set({
                      status: "processed",
                      result: { code: "task_control_authorized_and_sent" },
                      updatedAt: committedAt,
                    })
                    .where(
                      and(
                        eq(chatActions.id, authorizationActionId),
                        eq(chatActions.status, "issued"),
                      ),
                    );
                }
                await commitTaskControlCompletion(
                  tx as unknown as Db,
                  publication,
                  committedAt,
                );
              });
            } catch (error) {
              // Failure disposition is part of the same serialized provider
              // operation as transport. Keeping it under the endpoint lease
              // prevents a stale 401/403 or destination error from landing
              // after a newer reconnect, pause, removal, or lifecycle recovery.
              await finalizePublicationFailure(publication, error);
            }
          });
        } catch (error) {
          if (enteredEndpointLease) {
            // The only error allowed to escape the leased callback is a
            // failure to persist its disposition. Retrying that write after
            // releasing the lease would reintroduce the stale-finalizer race.
            // Leave the publication streaming so the conservative stale scan
            // moves it to delivery_unknown instead of overwriting newer state.
            logger.error(
              {
                endpointId: publication.endpointId,
                publicationId: publication.id,
                error: redactError(error),
              },
              "could not durably finalize chat publication failure",
            );
          } else {
            // No provider transport began. Lease lookup/acquisition failures
            // are safe to classify outside the lease and normally retry.
            try {
              await finalizePublicationFailure(publication, error);
            } catch (finalizationError) {
              logger.error(
                {
                  endpointId: publication.endpointId,
                  publicationId: publication.id,
                  error: redactError(finalizationError),
                },
                "could not durably finalize chat publication failure",
              );
            }
          }
        }
      }
    }
    await processPendingInteractionWakeups(limit);
    return attemptedIds.length;
  }

  async function getIssueBinding(
    issueId: string,
  ): Promise<ExternalChannelBindingSummary | null> {
    const companyId = await db
      .select({ companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.companyId ?? null);
    return companyId
      ? getExternalChannelBindingSummary(db, companyId, issueId)
      : null;
  }

  return {
    runtime,
    list,
    get,
    create,
    update,
    generateSetupSecret,
    configure,
    test,
    handleWebhook,
    listResources,
    replaceResources,
    listPrincipals,
    createLinkIntent,
    previewIdentityLink,
    confirmIdentityLink,
    revokeLink,
    listConversations,
    listActivity,
    replayDelivery,
    replayPublication,
    resolveAction,
    resolvePublication,
    publishComment,
    publishBoardMessage,
    processPendingPublications,
    processPendingDeliveries,
    processPendingProviderEffects,
    getIssueBinding,
    shutdown: async () => {
      shuttingDown = true;
      await Promise.allSettled([...backgroundMessageTasks]);
      scheduledConversationDrains.clear();
      liveInboundMessages.clear();
      await runtime.shutdown();
    },
  };
}

export type ChatChannelService = ReturnType<typeof chatChannelService>;
