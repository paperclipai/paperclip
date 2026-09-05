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
  type ChatSdkCallbackEvent,
  type ChatSdkEndpointRuntime,
  type ChatSdkMessageCallbackEvent,
  type ChatSdkMessageUpdatedCallbackEvent,
  type ChatSdkProvider,
  type ChatSdkRuntime,
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
  listGitHubInstallationRepositories,
  listSlackBotChannels,
  type ChatProviderInventoryResult,
} from "./chat-provider-inventory.js";
import {
  parseChatProviderLifecycle,
  type ChatProviderLifecycleEffect,
} from "./chat-provider-lifecycle.js";
import {
  nativeChatQuestion,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  telegramChatSdkCallbackData,
} from "./chat-interaction-publications.js";
import { chatProviderConversationUrl } from "./chat-provider-links.js";
import { classifyChatPublicationError } from "./chat-publication-errors.js";
import {
  shouldStreamSafePublicationText,
  streamSafePublicationText,
} from "./chat-publication-stream.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { questionResponseDeliveryService } from "./question-response-delivery.js";
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
  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
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

const UNAVOIDABLE_GITHUB_EVENTS = [
  "github_app_authorization",
  "installation",
  "installation_repositories",
] as const;

const SUPPLIED_CREDENTIAL_KEYS: Record<ChatProvider, readonly string[]> = {
  slack: ["botToken", "signingSecret"],
  github: ["appId", "privateKey"],
  "microsoft-teams": ["clientId", "tenantId", "clientSecret"],
  telegram: ["botToken"],
};

const MAX_INBOUND_TEXT = 100_000;
const MAX_ERROR_TEXT = 2_000;
const DELIVERY_PROCESSING_STALE_MS = 60_000;
const DELIVERY_LEASE_TTL_MS = 90_000;
const DELIVERY_DRAIN_LIMIT = 100;
const SLACK_COMMAND_OWNER_WAIT_MS = 2_000;
const SLACK_COMMAND_POST_STALE_MS = 60_000;
const ORPHAN_FOLLOW_UP_GRACE_MS = 5_000;
const CREDENTIAL_MUTATION_LEASE_TTL_MS = 90_000;
const CREDENTIAL_MUTATION_LEASE_WAIT_MS = 10_000;
const CREDENTIAL_MUTATION_LEASE_POLL_MS = 25;
const RECEIPT_REACTION_MAX_ATTEMPTS = 3;
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
  // Telegram's webhook max_connections setting permits concurrent delivery.
  // Its message timestamp has only one-second resolution, so the drain also
  // uses message_id/update_id below to order callbacks within this fixed,
  // non-sliding window without serializing separate chats.
  telegram: 750,
};

type EndpointRow = typeof chatEndpoints.$inferSelect;
type ResourceRow = typeof chatEndpointResources.$inferSelect;
type VerifiedProviderIdentity = {
  providerAccountId?: string | null;
  providerAccountLabel?: string | null;
  botExternalId?: string | null;
  botUsername?: string | null;
  botLabel?: string | null;
};
type ConversationRow = typeof chatConversations.$inferSelect;
type DeliveryRow = typeof chatDeliveries.$inferSelect;
type LiveInboundMessage = {
  endpoint: EndpointRow;
  message: Message;
  thread: Thread;
  trigger: ChatSdkMessageCallbackEvent["trigger"];
};

export interface ChatChannelServiceOptions {
  /**
   * Provider webhooks await only the durable ingress write, then finish task
   * processing outside the provider response budget. Tests may leave this off
   * when they need direct callback assertions.
   */
  deferWebhookProcessing?: boolean;
  fetch?: typeof globalThis.fetch;
  heartbeat: IssueAssignmentWakeupDeps;
  publicBaseUrl?: string | null;
  runtime?: ChatSdkRuntime;
  /** Testable scheduler hook; production defaults to the next event-loop turn. */
  scheduleDeferredWork?: (task: () => void) => void;
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
  return typeof aadObjectId === "string" && aadObjectId.trim()
    ? aadObjectId
    : author.userId;
}

function safeTitle(text: string, fallback: string): string {
  const line = text
    .replace(/<@[A-Z0-9]+>/gi, "")
    .replace(/@[\w.-]+/g, "")
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
  eventKind: "message_updated" | "message_deleted";
  messageId: string;
  revision: string;
  text: string;
  threadId: string;
};

type TelegramLifecycleEvent = {
  eventKind: "message_updated";
  messageId: string;
  revision: string;
  text: string;
  threadId: string;
};

function telegramLifecycleEventFromPayload(
  payload: unknown,
): TelegramLifecycleEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const edited = (payload as { edited_message?: unknown }).edited_message;
  if (!edited || typeof edited !== "object" || Array.isArray(edited))
    return null;
  const message = edited as {
    caption?: unknown;
    chat?: { id?: unknown };
    edit_date?: unknown;
    message_id?: unknown;
    message_thread_id?: unknown;
    text?: unknown;
  };
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const editDate = message.edit_date;
  if (
    (typeof chatId !== "string" && typeof chatId !== "number") ||
    typeof messageId !== "number" ||
    typeof editDate !== "number"
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
  return {
    eventKind: "message_updated",
    messageId: `${chat}:${messageId}`,
    revision: String(editDate),
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

function telegramMessageSequence(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as { message_id?: unknown }).message_id;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

async function githubLifecycleEventFromRequest(
  request: Request,
): Promise<GitHubLifecycleEvent | null> {
  const eventType = request.headers.get("x-github-event");
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
  return {
    eventKind,
    messageId: String(messageId),
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

function providerSetupState(
  endpoint: Pick<EndpointRow, "provider" | "publicId" | "status" | "setup">,
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
        command: assignedAgentName
          ? slackCommandForAgent(assignedAgentName, endpoint.publicId)
          : null,
      } as const;
    case "github":
      return {
        step,
        authorizationUrl: "https://github.com/settings/apps/new",
        providerUrl: "https://github.com/settings/installations",
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
  const runtimeGenerations = new Map<string, number>();
  const persistence = createChatSdkStatePersistence(db);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const publicBaseUrl = absoluteBaseUrl(options.publicBaseUrl);
  const issuesSvc = issueService(db);
  const secrets = secretService(db);
  const backgroundMessageTasks = new Set<Promise<void>>();
  const scheduledConversationDrains = new Map<string, number>();
  const liveInboundMessages = new Map<string, LiveInboundMessage>();
  let shuttingDown = false;

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
      .select({ id: agents.id, name: agents.name })
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

    const endpointId = randomUUID();
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
        publicId: randomBytes(32).toString("base64url"),
        assignedAgentId: agent.id,
        sponsorUserId: actorUserId ?? null,
        capabilities: CAPABILITIES[input.provider],
        setup: { step: "provider_setup" },
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
    return values;
  }

  async function verifyCredentials(
    provider: ChatProvider,
    credentials: Record<string, string>,
  ): Promise<VerifiedProviderIdentity> {
    if (provider === "slack") {
      const response = await fetchImpl("https://slack.com/api/auth.test", {
        method: "POST",
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
    if (provider === "telegram") {
      const response = await fetchImpl(
        `https://api.telegram.org/bot${encodeURIComponent(credentials.botToken)}/getMe`,
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
        // GET /app returns the app registration id, not the bot user's id.
        // Passing it as botUserId would break self-message suppression.
        botExternalId: undefined,
        botUsername: result.slug ? `${result.slug}[bot]` : undefined,
        botLabel: result.name ?? result.slug,
      };
    }
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "client_credentials",
      scope: "https://api.botframework.com/.default",
    });
    const response = await fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
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
      providerAccountId: credentials.tenantId,
      providerAccountLabel: credentials.tenantId,
      botExternalId: credentials.clientId,
    };
  }

  function nativeBotIdentityKey(
    provider: ChatProvider,
    identity: VerifiedProviderIdentity,
  ): string | null {
    const account = identity.providerAccountId?.trim().toLowerCase();
    const bot = identity.botExternalId?.trim().toLowerCase();
    const username = identity.botUsername?.trim().toLowerCase();
    if (provider === "github") {
      if (!account || !username) return null;
      return `${provider}:${account}:${username}`;
    }
    if (!account || !bot) return null;
    return `${provider}:${account}:${bot}`;
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
    const conflictEndpoint = candidates.find(
      (candidate) => nativeBotIdentityKey(endpoint.provider, candidate) === key,
    );
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
          { code: "chat_endpoint_credentials_busy" },
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
          { code: "chat_endpoint_setup_secret_unavailable" },
        );
      }
      const webhookSecret = randomBytes(32).toString("hex");
      // Rotation must fail closed if any existing credential cannot be resolved.
      // Falling back to an empty object here would replace the full credential
      // set with only the new webhook secret and strand an otherwise-live App.
      const existing = await resolveCredentials(endpoint);
      const rotated = record.credentialSecretRefs.some(
        (ref) => ref.configPath === "credentials.webhookSecret",
      );
      await persistCredentials(
        endpoint,
        { ...existing, webhookSecret },
        actorUserId,
      );
      if (rotated) {
        await runtime.removeEndpoint(endpoint.id).catch(() => undefined);
        const updatedAt = new Date();
        await db.transaction(async (tx) => {
          await tx
            .update(chatEndpoints)
            .set({
              status: "attention",
              healthMessage:
                "Update the GitHub webhook secret, then reconnect this App",
              lastError: null,
              setup: { ...endpoint.setup, step: "provider_setup" },
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
      }
      await logActivity(db, {
        companyId: endpoint.companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "chat_endpoint.setup_secret_generated",
        entityType: "tool_connection",
        entityId: endpoint.connectionId,
        details: {
          endpointId: endpoint.id,
          provider: endpoint.provider,
          rotated,
        },
      });
      return { webhookSecret };
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
        botUserId: endpoint.botExternalId
          ? Number(endpoint.botExternalId)
          : undefined,
      },
    };
  }

  async function runtimeFor(
    endpoint: EndpointRow,
  ): Promise<ChatSdkEndpointRuntime> {
    const generation = Number(
      (
        endpoint.setup as ChatEndpointSetupState & {
          runtimeGeneration?: number;
        }
      ).runtimeGeneration ?? 0,
    );
    const current = runtime.get(endpoint.id);
    if (current && (runtimeGenerations.get(endpoint.id) ?? 0) === generation)
      return current;
    if (current) await runtime.removeEndpoint(endpoint.id);
    const agent = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, endpoint.assignedAgentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Assigned agent not found");
    const credentials = await resolveCredentials(endpoint);
    const instance = await runtime.replaceEndpoint({
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
      providerConfig: runtimeConfig(
        endpoint,
        endpoint.botUsername ?? agent.name,
        credentials,
      ),
      persistence,
      concurrency: endpoint.concurrencyPolicy,
      callbacks: {
        onMessage: (event) => handleSdkMessage(event, generation),
        onAction:
          endpoint.capabilities.actions === true ? handleAction : undefined,
        onModalSubmit:
          endpoint.capabilities.modals === true ? handleModalSubmit : undefined,
        onMessageDeleted: handleMessageDeleted,
        onMessageUpdated: handleMessageUpdated,
        onReaction:
          endpoint.capabilities.reactions === true ? handleReaction : undefined,
        // Dynamic options remain unregistered. Native question buttons and
        // forms resolve only through issued durable rows. Reactions are an
        // auditable social signal, never an approval or task instruction.
        // Telegram exposes bot commands through Chat SDK's slash-command
        // callback even though it does not support arbitrary registered slash
        // commands. Paperclip still needs that callback for /new, /close, and
        // /status session controls.
        onSlashCommand:
          endpoint.capabilities.slashCommands ||
          endpoint.provider === "telegram"
            ? handleSlashCommand
            : undefined,
      },
    });
    try {
      await instance.initialize();
      runtimeGenerations.set(endpoint.id, generation);
      return instance;
    } catch (error) {
      await runtime.removeEndpoint(endpoint.id).catch(() => undefined);
      runtimeGenerations.delete(endpoint.id);
      throw error;
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
      await runtime.removeEndpoint(endpoint.id);
      await db.transaction(async (tx) => {
        const pausedAt = new Date();
        await tx
          .update(chatEndpoints)
          .set({ status: "paused", updatedAt: pausedAt })
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
          { code: "chat_endpoint_not_resumable" },
        );
      }
      let credentials = await resolveCredentials(endpoint).catch(() => {
        throw conflict("Reconnect the provider credentials before resuming", {
          code: "chat_endpoint_credentials_missing",
        });
      });
      const identity = await verifyCredentials(endpoint.provider, credentials);
      const currentIdentity = nativeBotIdentityKey(endpoint.provider, endpoint);
      if (
        !currentIdentity ||
        nativeBotIdentityKey(endpoint.provider, identity) !== currentIdentity
      ) {
        throw conflict(
          "The provider credentials now identify a different bot; reconnect this connection instead",
          { code: "chat_bot_identity_changed" },
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
      try {
        await runtime.removeEndpoint(endpoint.id);
        await runtimeFor(endpoint);
        await db.transaction(async (tx) => {
          const resumedAt = new Date();
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
          await tx
            .update(chatEndpoints)
            .set({
              status: "active",
              healthMessage: "Connected",
              lastError: null,
              setup: {
                ...endpoint.setup,
                runtimeGeneration:
                  Number(
                    (
                      endpoint.setup as ChatEndpointSetupState & {
                        runtimeGeneration?: number;
                      }
                    ).runtimeGeneration ?? 0,
                  ) + 1,
              } as ChatEndpointSetupState,
              updatedAt: resumedAt,
            })
            .where(eq(chatEndpoints.id, endpoint.id));
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
      } catch (error) {
        await runtime.removeEndpoint(endpoint.id).catch(() => undefined);
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
        throw conflict("This chat connection has already been removed", {
          code: "chat_endpoint_already_removed",
        });
      }
      await runtime.removeEndpoint(endpoint.id);
      if (endpoint.provider === "telegram") {
        const existingCredentials = await resolveCredentials(endpoint).catch(
          () => null,
        );
        if (existingCredentials?.botToken) {
          try {
            const response = await fetchImpl(
              `https://api.telegram.org/bot${encodeURIComponent(existingCredentials.botToken)}/deleteWebhook`,
              {
                method: "POST",
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
      await db.transaction(async (tx) => {
        await tx
          .update(chatEndpoints)
          .set({
            status: "archived",
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
      return get(endpoint.id);
    }
    if (
      input.action !== "configure" &&
      input.action !== "reconnect" &&
      input.action !== "verify"
    ) {
      throw unprocessable("Unsupported chat endpoint setup action");
    }
    if (!publicBaseUrl) {
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
          { code: "chat_endpoint_invalid_setup_step" },
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
        { code: "chat_endpoint_already_configured" },
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
      const currentIdentity = nativeBotIdentityKey(endpoint.provider, endpoint);
      if (
        !currentIdentity ||
        nativeBotIdentityKey(endpoint.provider, identity) !== currentIdentity
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
              step: waitingForSlackConfiguration ? "provider_setup" : "test",
              testStartedAt: waitingForSlackConfiguration
                ? null
                : updatedAt.toISOString(),
              webhookVerifiedAt: waitingForSlackConfiguration
                ? null
                : (endpoint.setup.webhookVerifiedAt ?? null),
            },
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
      await runtime.removeEndpoint(endpoint.id);
      await runtimeFor(next.endpoint);

      if (endpoint.provider === "telegram" && publicBaseUrl) {
        const webhookUrl = `${publicBaseUrl}/api/chat-webhooks/${endpoint.publicId}/telegram`;
        const infoResponse = await fetchImpl(
          `https://api.telegram.org/bot${encodeURIComponent(credentials.botToken)}/getWebhookInfo`,
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
      }
    } catch (error) {
      const failure = redactError(error);
      await runtime.removeEndpoint(endpoint.id).catch(() => undefined);
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
        { code: "chat_test_message_missing" },
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
        { code: "chat_test_round_trip_incomplete" },
      );
    }
    await db.transaction(async (tx) => {
      await tx
        .update(chatEndpoints)
        .set({
          status: "active",
          setup: { step: "complete", testStartedAt: null },
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

  async function ensureResource(
    endpoint: EndpointRow,
    thread: Thread,
    enabledBySetupActivation: boolean,
  ) {
    const type = providerResourceType(
      endpoint.provider,
      chatSurfaceKind(endpoint.provider, thread),
    );
    const providerResourceId = canonicalProviderResourceId(
      endpoint.provider,
      thread,
    );
    const [resource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        type,
        providerResourceId,
        label: thread.channel.name ?? thread.channelId,
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
          label: thread.channel.name ?? thread.channelId,
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
  }) {
    if (!options.storage) return [];
    const storedIds: string[] = [];
    for (const attachment of input.attachments.slice(0, 20)) {
      try {
        if (
          attachment.size !== undefined &&
          attachment.size > MAX_ATTACHMENT_BYTES
        )
          continue;
        if (!attachment.fetchData) continue;
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
        if (!isAllowedContentType(contentType)) continue;
        const fetched = await attachment.fetchData();
        const body = Buffer.isBuffer(fetched) ? fetched : Buffer.from(fetched);
        if (body.length === 0 || body.length > MAX_ATTACHMENT_BYTES) continue;
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
    return storedIds;
  }

  async function processMessage(
    endpoint: EndpointRow,
    thread: Thread,
    message: Message,
    trigger: ChatSdkMessageCallbackEvent["trigger"],
    ingressOnly = false,
    recoveredProviderUrl: string | null = null,
    runtimeGeneration?: number,
    providerUpdateId?: number,
  ) {
    // The Telegram adapter currently emits edited_message through the normal
    // message callback with the original message id. Paperclip records that
    // verified payload through its supplemental message_updated lifecycle
    // ledger instead; letting it reach normal dedupe would falsely report the
    // edit as a duplicate provider delivery.
    if (
      endpoint.provider === "telegram" &&
      isTelegramEditedMessageRaw(message.raw)
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
    const endpointRuntime = await runtimeFor(endpoint);
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
          recovery: endpointRuntime.attachmentRecoveryDescriptor(attachment),
        })),
      },
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
      const currentRuntimeGeneration = Number(
        (
          currentEndpoint.setup as ChatEndpointSetupState & {
            runtimeGeneration?: number;
          }
        ).runtimeGeneration ?? 0,
      );
      const staleActivation =
        ingressOnly &&
        runtimeGeneration !== undefined &&
        runtimeGeneration !== currentRuntimeGeneration;
      const accepting =
        ["verifying", "active"].includes(currentEndpoint.status) &&
        !staleActivation;
      const ignoredAt = accepting ? null : new Date();
      const inactiveReason = staleActivation
        ? "Connection activation changed before admission"
        : "Connection is not active";
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
          normalizedEvent: normalized,
          state: accepting ? "received" : "filtered",
          nextAttemptAt:
            accepting && scheduledAt ? new Date(scheduledAt) : null,
          redactedError: accepting ? null : inactiveReason,
          processedAt: ignoredAt,
        })
        .onConflictDoNothing()
        .returning();
      let candidate = delivery ?? null;
      if (!candidate) {
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
          [candidate] = await tx
            .update(chatDeliveries)
            .set({
              // Increment under PostgreSQL's row lock so simultaneous handler
              // fanout and provider retries cannot lose duplicate telemetry.
              normalizedEvent: sql`coalesce(${chatDeliveries.normalizedEvent}, '{}'::jsonb)
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
      if (!accepting && ignoredAt) {
        await tx
          .update(chatEndpoints)
          .set({ lastEventAt: ignoredAt, updatedAt: ignoredAt })
          .where(eq(chatEndpoints.id, endpoint.id));
      }
      return { accepting, candidate: candidate ?? null };
    });
    const candidate = admission?.candidate ?? null;
    if (!admission || !candidate) return;
    if (!admission.accepting) {
      liveInboundMessages.delete(candidate.id);
      return;
    }
    if (["processed", "filtered", "failed"].includes(candidate.state)) return;
    const now = new Date();
    if (
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
      });
      scheduleConversationDrain(
        endpoint.id,
        thread.id,
        scheduledAt ?? Date.now(),
      );
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
            eq(chatMessageLinks.providerMessageId, message.id),
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
        await db
          .update(chatDeliveries)
          .set({
            conversationId: existingMessageLink.conversationId,
            state: "processed",
            processedAt: new Date(),
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
      const enabledResourceCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.endpointId, endpoint.id),
            eq(chatEndpointResources.enabled, true),
            eq(chatEndpointResources.availability, "available"),
            ne(chatEndpointResources.type, "direct_message"),
          ),
        )
        .then((rows) => rows[0]?.count ?? 0);
      const enableSetupDestination =
        !thread.isDM &&
        endpoint.status === "verifying" &&
        addressed &&
        enabledResourceCount === 0;
      let resource = await ensureResource(
        endpoint,
        thread,
        enableSetupDestination,
      );
      if (enableSetupDestination && !resource.enabled) {
        resource = await db
          .update(chatEndpointResources)
          .set({ enabled: true, updatedAt: new Date() })
          .where(eq(chatEndpointResources.id, resource.id))
          .returning()
          .then((rows) => rows[0] ?? resource);
      }
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
      const controlCommand = isLinear
        ? linearControlCommand(message.text)
        : null;
      const endpointAllowed =
        endpoint.status === "verifying" || endpoint.status === "active";
      const destinationAllowed = thread.isDM
        ? endpoint.allowDirectMessages
        : nonDirectDestinationAllowed(endpoint, resource);
      const guestSponsorAllowed =
        principalResolution.userId === null &&
        !principalResolution.linkedDenied &&
        endpoint.allowUnlinkedPeople
          ? await sponsorAllowsGuest(endpoint)
          : false;
      const principalAllowed =
        !principalResolution.linkedDenied &&
        (principalResolution.userId !== null || guestSponsorAllowed);
      const activationAllowed = addressed || existingConversation !== null;
      const allowed =
        endpointAllowed &&
        destinationAllowed &&
        principalAllowed &&
        activationAllowed;
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
        (endpoint.provider === "slack" &&
          Boolean(slackRootMessageId) &&
          slackRootMessageId !== message.id) ||
        (endpoint.provider === "microsoft-teams" &&
          Boolean(teamsRootMessageId) &&
          teamsRootMessageId !== message.id);
      const setupDestinationCanBeEnabledByEarlierMention =
        endpoint.provider === "github" &&
        !thread.isDM &&
        endpoint.status === "verifying" &&
        enabledResourceCount === 0 &&
        resource.availability === "available";
      if (
        !allowed &&
        isPlausibleOrphanFollowUp &&
        !addressed &&
        existingConversation === null &&
        activeDelivery.attempts === 1 &&
        endpointAllowed &&
        principalAllowed &&
        (destinationAllowed || setupDestinationCanBeEnabledByEarlierMention)
      ) {
        // GitHub, Slack, and Teams can deliver a thread reply before the older
        // root callback that creates its Paperclip task. Keep this exact
        // delivery once, without admitting or waking it, so the durable thread
        // drain can sort again if the root arrives shortly afterward. A
        // standalone unaddressed message reaches the normal filtered path on
        // attempt two.
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
        await db.transaction(async (tx) => {
          // Admission locks endpoint -> delivery. Keep completion in the same
          // order so a provider redelivery cannot deadlock with the original
          // message while both contend on the same delivery row.
          await tx
            .update(chatEndpoints)
            .set({ lastEventAt: new Date(), updatedAt: new Date() })
            .where(eq(chatEndpoints.id, endpoint.id));
          await tx
            .update(chatDeliveries)
            .set({
              state: "processed",
              processedAt: new Date(),
              redactedError: null,
              updatedAt: new Date(),
            })
            .where(eq(chatDeliveries.id, activeDelivery.id));
        });
        // Mark the durable delivery complete before provider-visible effects.
        // An exact Slack redelivery can therefore never create duplicate
        // guidance or accidentally fall through into task creation.
        await Promise.allSettled([
          addReceiptReaction({
            deliveryId: activeDelivery.id,
            endpoint,
            message,
            thread,
          }),
          thread.post("Please include a request after mentioning me."),
        ]);
        return;
      }

      if (controlCommand) {
        const taskLabel = existingIssue
          ? `${existingIssue.identifier}: ${existingIssue.title}`
          : "No task is active in this conversation.";
        const responseText =
          controlCommand === "status"
            ? existingIssue
              ? `${taskLabel} — ${existingIssue.status}`
              : taskLabel
            : controlCommand === "new"
              ? "Send your request to start a new Paperclip task."
              : existingConversation
                ? "This task is closed. Send another message to start a new task."
                : "No task is active. Send a message to start one.";
        if (controlCommand !== "status") {
          if (existingConversation) {
            await db
              .update(chatConversations)
              .set({ state: "completed", updatedAt: new Date() })
              .where(eq(chatConversations.id, existingConversation.id));
          }
        }
        await db.transaction(async (tx) => {
          await tx
            .update(chatEndpoints)
            .set({ lastEventAt: new Date(), updatedAt: new Date() })
            .where(eq(chatEndpoints.id, endpoint.id));
          await tx
            .update(chatDeliveries)
            .set({
              conversationId: existingConversation?.id ?? null,
              state: "processed",
              processedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(chatDeliveries.id, activeDelivery.id));
        });
        await Promise.allSettled([
          addReceiptReaction({
            deliveryId: activeDelivery.id,
            endpoint,
            message,
            thread,
          }),
          addressed && !thread.isDM ? thread.subscribe() : Promise.resolve(),
        ]);
        await thread.post(responseText);
        return;
      }

      let conversation = existingConversation;
      if (!conversation) {
        const sessionGeneration = isLinear
          ? (latestConversation?.sessionGeneration ?? 0) + 1
          : 1;
        const issue = await issuesSvc.create(endpoint.companyId, {
          title: safeTitle(
            message.text,
            `${PROVIDER_LABELS[endpoint.provider]} conversation`,
          ),
          description: `Started from ${PROVIDER_LABELS[endpoint.provider]}: ${resource.label}`,
          status: "todo",
          priority: "medium",
          assigneeAgentId: endpoint.assignedAgentId,
          createdByUserId: principalResolution.userId ?? endpoint.sponsorUserId,
          responsibleUserId:
            principalResolution.userId ?? endpoint.sponsorUserId,
          originKind: "chat_channel",
          originId: `${endpoint.id}:${thread.id}:${sessionGeneration}`,
          idempotencyKey: `chat:${endpoint.id}:${thread.id}:${sessionGeneration}`,
        });
        if (!principalResolution.userId) {
          const reviewPreset = {
            id: LOW_TRUST_REVIEW_PRESET,
            version: LOW_TRUST_REVIEW_PRESET_VERSION,
            rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
          } as const;
          await db
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
        await db
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
        conversation = await db
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
          : await db
              .select()
              .from(issues)
              .where(eq(issues.id, conversation.issueId))
              .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Bound task not found");
      if (issue.status === "done" || issue.status === "cancelled") {
        await issuesSvc.update(issue.id, {
          status: "todo",
          actorUserId: principalResolution.userId ?? endpoint.sponsorUserId,
        });
      }
      const body =
        message.text.trim() ||
        (message.attachments.length > 0
          ? `Shared ${message.attachments.length} file${message.attachments.length === 1 ? "" : "s"}.`
          : "Sent an empty message.");
      let comment!: typeof issueComments.$inferSelect;
      await db.transaction(async (tx) => {
        await tx
          .update(chatEndpoints)
          .set({
            status: endpoint.status,
            setup: endpoint.setup,
            healthMessage:
              endpoint.status === "verifying"
                ? "Test conversation received"
                : "Connected",
            lastEventAt: new Date(),
            activatedAt:
              endpoint.status === "active" ? endpoint.activatedAt : null,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        comment = await issuesSvc.addComment(
          conversation!.issueId,
          body.slice(0, MAX_INBOUND_TEXT),
          principalResolution.userId
            ? { userId: principalResolution.userId }
            : {},
          {
            authorType: principalResolution.userId ? "user" : "system",
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
                      value: principalResolution.userId
                        ? "Linked Paperclip user"
                        : "Sponsored external guest (restricted)",
                    },
                  ],
                },
              ],
            },
            sourceTrust: principalResolution.userId
              ? null
              : {
                  preset: LOW_TRUST_REVIEW_PRESET,
                  disposition: "quarantined",
                  sourceIssueId: conversation!.issueId,
                },
          },
          tx,
        );
        await tx
          .update(chatDeliveries)
          .set({
            conversationId: conversation!.id,
            updatedAt: new Date(),
          })
          .where(eq(chatDeliveries.id, activeDelivery.id));
        await tx
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
        await tx
          .update(chatConversations)
          .set({
            state: "active",
            lastActivityAt: new Date(),
            ...(providerUrl ? { providerUrl } : {}),
            updatedAt: new Date(),
          })
          .where(eq(chatConversations.id, conversation!.id));
        await tx
          .update(toolConnections)
          .set({
            status: "active",
            enabled: true,
            healthStatus: "healthy",
            healthMessage: "Connected",
            lastHealthAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, endpoint.connectionId));
      });
      await ingestAttachments({
        endpoint,
        issueId: conversation.issueId,
        issueCommentId: comment.id,
        attachments: message.attachments,
        actorUserId: principalResolution.userId,
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
        requestedByActorType: principalResolution.userId ? "user" : "system",
        requestedByActorId:
          principalResolution.userId ?? principalResolution.principal.id,
        taskKey: issue.identifier,
        wakeCommentId: comment.id,
        rethrowOnError: true,
      });
      await db
        .update(chatDeliveries)
        .set({
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
      // Provider-visible acknowledgement begins only after the task, external
      // comment, durable wakeup request, delivery state, and message link commit.
      await Promise.allSettled([
        addReceiptReaction({
          deliveryId: activeDelivery.id,
          endpoint,
          message,
          thread,
        }),
        // Slack implements this through assistant.threads.setStatus, which
        // requires assistant:write. The least-privilege Paperclip manifest
        // deliberately does not request that scope; the coalesced lifecycle
        // reply below is the visible working state instead.
        endpoint.provider === "slack"
          ? Promise.resolve()
          : thread.startTyping("Working…"),
        addressed && !thread.isDM ? thread.subscribe() : Promise.resolve(),
      ]);
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

  function normalizedDeliveryThreadId(delivery: DeliveryRow): string | null {
    const normalized = delivery.normalizedEvent as {
      conversation?: { externalThreadId?: unknown };
    };
    return typeof normalized.conversation?.externalThreadId === "string"
      ? normalized.conversation.externalThreadId
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
    return db
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
        asc(chatDeliveries.receivedAt),
        asc(chatDeliveries.id),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function acquireConversationDeliveryLease(input: {
    companyId: string;
    endpointId: string;
    threadId: string;
  }): Promise<{ leaseKey: string; token: string } | null> {
    const now = new Date();
    const token = randomUUID();
    const leaseKey = `inbound:${createHash("sha256")
      .update(input.threadId)
      .digest("hex")}`;
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
    trigger: ChatSdkMessageCallbackEvent["trigger"];
    providerUrl: string | null;
  } | null {
    const normalized = delivery.normalizedEvent as {
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
    const renewTimer = setInterval(() => {
      if (renewal) return;
      renewal = db
        .update(chatEndpointLeases)
        .set({
          expiresAt: new Date(Date.now() + DELIVERY_LEASE_TTL_MS),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpointId),
            eq(chatEndpointLeases.leaseKey, lease.leaseKey),
            eq(chatEndpointLeases.token, lease.token),
          ),
        )
        .returning({ id: chatEndpointLeases.id })
        .then((rows) => {
          if (rows.length === 0) leaseOwned = false;
        })
        .catch((error) => {
          logger.warn(
            { endpointId, error: redactError(error) },
            "could not renew external chat conversation lease",
          );
        })
        .finally(() => {
          renewal = null;
        });
    }, DELIVERY_LEASE_TTL_MS / 3);
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

        const live = liveInboundMessages.get(delivery.id);
        try {
          if (live) {
            await processMessage(
              endpoint,
              live.thread,
              live.message,
              live.trigger,
              false,
            );
          } else {
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
    runtimeGeneration?: number,
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
        runtimeGeneration,
        event.providerUpdateId,
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

  async function recordLifecycleDelivery(input: {
    endpointId: string;
    threadId: string;
    messageId: string;
    eventKind: "message_updated" | "message_deleted";
    text: string;
    revision?: string | null;
  }) {
    const providerEventId = `${input.eventKind}:${input.threadId}:${input.messageId}:${input.revision ?? "once"}`;
    await db.transaction(async (tx) => {
      const endpoint = await tx
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, input.endpointId))
        .then((rows) => rows[0] ?? null);
      if (!endpoint) throw notFound("Chat endpoint not found");
      // A provider has already authenticated this callback. During setup the
      // message can belong to the test conversation, so retain its correction.
      // Paused or unhealthy connections acknowledge late callbacks without
      // mutating the bound task or causing provider retry storms.
      if (endpoint.status !== "verifying" && endpoint.status !== "active")
        return;
      const originalMessageIsPending = () =>
        tx
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, input.endpointId),
              eq(
                chatDeliveries.providerEventId,
                `${input.threadId}:${input.messageId}`,
              ),
              inArray(chatDeliveries.state, [
                "received",
                "processing",
                "retry",
              ]),
            ),
          )
          .then((rows) => rows.length > 0);
      const waitForOriginalMessage = async () => {
        if (await originalMessageIsPending()) {
          // The provider will retry this authenticated lifecycle callback.
          // Acknowledging it now would lose an edit that raced the deferred
          // creation of the original message's conversation and link.
          throw new Error(
            "Original chat message is still being durably processed",
          );
        }
      };
      const conversation = await tx
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.endpointId, input.endpointId),
            eq(chatConversations.externalThreadId, input.threadId),
          ),
        )
        .orderBy(desc(chatConversations.sessionGeneration))
        .then((rows) => rows[0] ?? null);
      if (!conversation) {
        await waitForOriginalMessage();
        return;
      }
      const linkedMessage = await tx
        .select({ id: chatMessageLinks.id })
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.endpointId, input.endpointId),
            eq(chatMessageLinks.conversationId, conversation.id),
            eq(chatMessageLinks.providerMessageId, input.messageId),
            eq(chatMessageLinks.direction, "inbound"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!linkedMessage) {
        await waitForOriginalMessage();
        return;
      }
      const [delivery] = await tx
        .insert(chatDeliveries)
        .values({
          companyId: endpoint.companyId,
          endpointId: input.endpointId,
          conversationId: conversation.id,
          providerEventId,
          deduplicationKey: createHash("sha256")
            .update(providerEventId)
            .digest("hex"),
          eventKind: input.eventKind,
          normalizedEvent: {
            providerEventId,
            kind: input.eventKind,
            conversation: { externalThreadId: input.threadId },
            message: {
              providerMessageId: input.messageId,
              text: input.text,
            },
          },
          state: "received",
        })
        .onConflictDoNothing()
        .returning();
      if (!delivery) return;
      await issuesSvc.addComment(
        conversation.issueId,
        input.text,
        {},
        { authorType: "system" },
        tx,
      );
      await tx
        .update(chatDeliveries)
        .set({
          state: "processed",
          attempts: 1,
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(chatDeliveries.id, delivery.id));
    });
  }

  async function handleMessageUpdated(
    event: ChatSdkMessageUpdatedCallbackEvent,
  ) {
    const text = `An external message was edited:\n\n${event.message.text.slice(0, MAX_INBOUND_TEXT)}`;
    await recordLifecycleDelivery({
      endpointId: event.endpointId,
      threadId: event.thread.id,
      messageId: event.message.id,
      eventKind: "message_updated",
      text,
      revision:
        event.message.metadata.editedAt?.toISOString() ??
        createHash("sha256").update(event.message.text).digest("hex"),
    });
  }

  async function handleMessageDeleted(
    event: ChatSdkCallbackEvent<MessageDeletedEvent>,
  ) {
    await recordLifecycleDelivery({
      endpointId: event.endpointId,
      threadId: event.event.threadId,
      messageId: event.event.messageId,
      eventKind: "message_deleted",
      text: "An external message in this conversation was deleted.",
      revision: event.event.deletedAt?.toISOString() ?? null,
    });
  }

  async function handleReaction(event: ChatSdkCallbackEvent<ReactionEvent>) {
    const record = await endpointRecord(event.endpointId);
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
    const conversation = await conversationForThread(
      event.endpointId,
      event.event.threadId,
    );
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
    await db
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
  }

  async function denyExternalAction(
    endpoint: EndpointRow,
    event: ChatSdkCallbackEvent<ActionEvent>,
    safelyKnown: {
      conversationId?: string | null;
      principalId?: string | null;
    } = {},
  ): Promise<never> {
    const denied = forbidden(
      "This chat action is not a current Paperclip question",
    );
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
    try {
      await db
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
        .onConflictDoNothing();
    } catch (error) {
      logger.warn(
        {
          endpointId: endpoint.id,
          provider: endpoint.provider,
          error: redactError(error),
        },
        "could not record denied external chat action",
      );
    }
    throw denied;
  }

  async function handleAction(event: ChatSdkCallbackEvent<ActionEvent>) {
    const record = await endpointRecord(event.endpointId);
    if (!record) {
      throw forbidden("This chat action is not a current Paperclip question");
    }
    const deny = (safelyKnown?: {
      conversationId?: string | null;
      principalId?: string | null;
    }) => denyExternalAction(record.endpoint, event, safelyKnown);
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
    const conversation = await conversationForThread(
      event.endpointId,
      event.event.threadId,
    );
    if (!conversation || !["active", "waiting"].includes(conversation.state)) {
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

    const issued = await db
      .select({
        publication: chatPublications,
        link: chatMessageLinks,
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
      .then((rows) => rows[0] ?? null);
    if (!issued) return deny(safelyKnown);

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
      interaction.issueId !== conversation.issueId ||
      interaction.kind !== "ask_user_questions" ||
      interaction.status !== "pending"
    ) {
      return deny(safelyKnown);
    }
    if (isChatQuestionFormOpenActionId(event.event.actionId)) {
      if (event.provider !== "slack" && event.provider !== "microsoft-teams") {
        return deny(safelyKnown);
      }
      const resolved = await resolveChatQuestionFormOpen(db, {
        companyId: record.endpoint.companyId,
        endpointId: record.endpoint.id,
        conversationId: conversation.id,
        interaction,
        openActionId: event.event.actionId,
      });
      if (!resolved || resolved.publicationId !== issued.publication.id) {
        return deny(safelyKnown);
      }
      const opened = await event.event.openModal(resolved.modal);
      if (!opened) return deny(safelyKnown);
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

    // Claim the durable token before changing the interaction. This is the
    // single-use replay barrier; concurrent callbacks can observe the same
    // pending interaction, but only one can transition issued -> processing.
    const [claimedAction] = await db
      .update(chatActions)
      .set({
        principalId: principal.principal.id,
        status: "processing",
        payload: {
          ...tokenPayload,
          messageId: event.event.messageId,
          actionId: event.event.actionId,
          value: event.event.value ?? null,
        },
        updatedAt: new Date(),
      })
      .where(
        and(eq(chatActions.id, action.id), eq(chatActions.status, "issued")),
      )
      .returning();
    if (!claimedAction) return deny(safelyKnown);

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
          afterResolveInTransaction: async (tx, resolved) => {
            await tx
              .update(chatActions)
              .set({
                status: "processed",
                result: {
                  interactionId: resolved.id,
                  interactionStatus: resolved.status,
                },
                updatedAt: new Date(),
              })
              .where(eq(chatActions.id, claimedAction.id));
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
                  ne(chatActions.id, claimedAction.id),
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
          },
        },
      );
      await questionResponseDeliveryService(db, {
        heartbeat: options.heartbeat as Parameters<
          typeof questionResponseDeliveryService
        >[1]["heartbeat"],
      })
        .deliver(answered.id)
        .catch((error) => {
          logger.warn(
            {
              error: redactError(error),
              endpointId: record.endpoint.id,
              interactionId: answered.id,
            },
            "external chat question response delivery will retry from its durable outbox",
          );
        });
    } catch (error) {
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: { code: "question_resolution_rejected" },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, claimedAction.id));
      throw error;
    }
  }

  async function handleModalSubmit(
    event: ChatSdkCallbackEvent<ModalSubmitEvent>,
  ): Promise<ModalResponse> {
    const deny = () =>
      forbidden("This chat form is not a current Paperclip question");
    const record = await endpointRecord(event.endpointId);
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

    const issued = await db
      .select({
        publication: chatPublications,
        link: chatMessageLinks,
      })
      .from(chatPublications)
      .innerJoin(
        chatMessageLinks,
        and(
          eq(chatMessageLinks.companyId, chatPublications.companyId),
          eq(chatMessageLinks.endpointId, chatPublications.endpointId),
          eq(chatMessageLinks.conversationId, chatPublications.conversationId),
          eq(chatMessageLinks.publicationId, chatPublications.id),
          eq(chatMessageLinks.direction, "outbound"),
        ),
      )
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
                chatMessageLinks.providerMessageId,
                event.event.relatedMessage.id,
              )
            : undefined,
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!issued) throw deny();
    const payload = issued.publication.payload as SafeChatPublicationPayload;
    if (payload.interactionId !== loaded.interactionId) throw deny();
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
    const answered = await issueThreadInteractionService(db).answerQuestions(
      issue,
      interaction.id,
      { answers: validation.answers },
      { userId: principal.userId },
      {
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
    await questionResponseDeliveryService(db, {
      heartbeat: options.heartbeat as Parameters<
        typeof questionResponseDeliveryService
      >[1]["heartbeat"],
    })
      .deliver(answered.id)
      .catch((error) => {
        logger.warn(
          {
            error: redactError(error),
            endpointId: record.endpoint.id,
            interactionId: answered.id,
          },
          "external chat form response delivery will retry from its durable outbox",
        );
      });
    return { action: "clear" };
  }

  async function handleSlashCommand(
    event: ChatSdkCallbackEvent<SlashCommandEvent>,
  ) {
    const command = event.event.command.toLowerCase().split("@")[0];
    const text = event.event.text.trim();
    const telegramControl =
      event.provider === "telegram" &&
      ["/new", "/close", "/status"].includes(command);
    if (telegramControl) {
      const record = await endpointRecord(event.endpointId);
      if (!record) throw notFound("Chat endpoint not found");
      const endpointRuntime =
        runtime.get(event.endpointId) ?? (await runtimeFor(record.endpoint));
      const thread = endpointRuntime.thread(event.event.channel.id);
      const synthetic = {
        id:
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
        text: command,
        formatted: { type: "root", children: [] },
        raw: event.event.raw,
        author: event.event.user,
        metadata: { dateSent: new Date(), edited: false },
        attachments: [],
        links: [],
        isMention: true,
      } as unknown as Message;
      await handleSdkMessage({
        endpointId: event.endpointId,
        provider: event.provider,
        thread,
        message: synthetic,
        trigger: thread.isDM ? "direct_message" : "mention",
      });
      return;
    }
    if (event.provider === "telegram") {
      const record = await endpointRecord(event.endpointId);
      if (!record || !["verifying", "active"].includes(record.endpoint.status))
        return;
      if (command === "/start") {
        await event.event.channel.post(
          `Send a message to start work with ${record.assignedAgentName}. Use /status, /new, or /close to manage the active task in this chat.`,
        );
        return;
      }
      await event.event.channel.post(
        "Available commands: /status, /new, and /close.",
      );
      return;
    }
    const record = await endpointRecord(event.endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    if (!["verifying", "active"].includes(record.endpoint.status)) {
      await event.event.channel.postEphemeral(
        event.event.user,
        "This Paperclip connection is not active.",
        { fallbackToDM: false },
      );
      return;
    }
    const expectedCommand = slackCommandForAgent(
      record.assignedAgentName,
      record.endpoint.publicId,
    );
    if (event.provider !== "slack" || command !== expectedCommand) {
      await event.event.channel.postEphemeral(
        event.event.user,
        `This connection only accepts ${expectedCommand}.`,
        { fallbackToDM: false },
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
    const destinationAllowed = event.event.channel.isDM
      ? record.endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(record.endpoint, resource);
    const authorized =
      destinationAllowed &&
      !principal.linkedDenied &&
      (principal.userId !== null ||
        (record.endpoint.allowUnlinkedPeople &&
          (await sponsorAllowsGuest(record.endpoint))));
    if (!authorized) {
      await event.event.channel.postEphemeral(
        event.event.user,
        "This channel or account is not allowed to start Paperclip work.",
        { fallbackToDM: false },
      );
      return;
    }
    const slackControl = /^(status|new|close)$/i
      .exec(text)?.[1]
      ?.toLowerCase() as "status" | "new" | "close" | undefined;
    if (slackControl) {
      if (!event.event.channel.isDM) {
        // Slack slash-command payloads are channel-scoped and do not carry a
        // thread timestamp, so they cannot safely identify one of several
        // Paperclip tasks in the channel. Native @mention threads remain the
        // task-management surface there; the control vocabulary is exact only
        // in a DM, whose provider channel identity is stable.
        await event.event.channel.postEphemeral(
          event.event.user,
          "Use status, new, and close in a direct message with this agent. In a channel, open the Paperclip task from its Slack thread.",
          { fallbackToDM: false },
        );
        return;
      }
      const endpointRuntime =
        runtime.get(event.endpointId) ?? (await runtimeFor(record.endpoint));
      const rawChannelId = event.event.channel.id.replace(/^slack:/, "");
      const thread = endpointRuntime.thread(`slack:${rawChannelId}:`);
      const providerCommandId =
        event.event.triggerId ??
        createHash("sha256")
          .update(JSON.stringify(event.event.raw))
          .digest("hex");
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
      await handleSdkMessage({
        endpointId: event.endpointId,
        provider: event.provider,
        thread,
        message: synthetic,
        trigger: "direct_message",
      });
      return;
    }
    if (!text) {
      await event.event.channel.postEphemeral(
        event.event.user,
        "Use this command followed by a task for the agent.",
        { fallbackToDM: false },
      );
      return;
    }
    const providerCommandId =
      event.event.triggerId ??
      createHash("sha256")
        .update(JSON.stringify(event.event.raw))
        .digest("hex");
    const providerActionId = `slash_task:${createHash("sha256")
      .update(
        `${event.event.command}:${event.event.user.userId}:${providerCommandId}`,
      )
      .digest("hex")}`;
    const [insertedAction] = await db
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
        },
        status: "received",
      })
      .onConflictDoNothing()
      .returning();
    const loadAction = () =>
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, record.endpoint.id),
            eq(chatActions.providerActionId, providerActionId),
          ),
        )
        .then((rows) => rows[0] ?? null);
    let action = insertedAction ?? (await loadAction());
    if (!action) throw new Error("Slack command admission was not persisted");

    let ownsProviderPost = Boolean(insertedAction);
    if (!ownsProviderPost && action.status === "received") {
      if (
        action.updatedAt.getTime() <=
        Date.now() - SLACK_COMMAND_POST_STALE_MS
      ) {
        await db
          .update(chatActions)
          .set({
            status: "delivery_unknown",
            result: { code: "slash_task_delivery_unknown" },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, action.id),
              eq(chatActions.status, "received"),
              lte(
                chatActions.updatedAt,
                new Date(Date.now() - SLACK_COMMAND_POST_STALE_MS),
              ),
            ),
          );
        return;
      }
      // A concurrent Slack retry can arrive while the first callback is still
      // posting the native root. Wait briefly so it can take over durable
      // inbound processing if that first request disappears after persisting
      // the provider thread id.
      const ownerDeadline = Date.now() + SLACK_COMMAND_OWNER_WAIT_MS;
      while (action.status === "received" && Date.now() < ownerDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        action = (await loadAction()) ?? action;
      }
    }
    if (
      !ownsProviderPost &&
      action.status === "failed" &&
      action.result?.retryable === true
    ) {
      const [reclaimedAction] = await db
        .update(chatActions)
        .set({ status: "received", result: null, updatedAt: new Date() })
        .where(
          and(eq(chatActions.id, action.id), eq(chatActions.status, "failed")),
        )
        .returning();
      if (reclaimedAction) {
        action = reclaimedAction;
        ownsProviderPost = true;
      } else {
        action = (await loadAction()) ?? action;
      }
    }

    let starterThreadId =
      action.status === "processed" &&
      typeof action.result?.threadId === "string"
        ? action.result.threadId
        : null;
    if (!starterThreadId) {
      if (!ownsProviderPost) {
        // Another callback owns the provider-visible root post, or a prior
        // ambiguous attempt is deliberately quarantined. A later provider
        // retry can resume from the persisted thread id after the owner wins.
        return;
      }
      try {
        // Slash commands are channel-scoped. Start one terse native root
        // message and use the thread returned by the provider as the task
        // boundary, matching the @mention one-thread/one-task model.
        const starter = await event.event.channel.post("Starting a task…");
        starterThreadId = starter.threadId;
        const [completedAction] = await db
          .update(chatActions)
          .set({
            status: "processed",
            result: {
              threadId: starter.threadId,
              providerMessageId: starter.id,
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, action.id),
              eq(chatActions.status, "received"),
            ),
          )
          .returning();
        action = completedAction ?? action;
      } catch (error) {
        const disposition = classifyChatPublicationError(error, 1);
        const failure = redactSensitiveText(disposition.reason).slice(
          0,
          MAX_ERROR_TEXT,
        );
        await db.transaction(async (tx) => {
          await tx
            .update(chatActions)
            .set({
              status:
                disposition.kind === "delivery_unknown"
                  ? "delivery_unknown"
                  : "failed",
              result: {
                code: `slash_task_${disposition.kind}`,
                retryable: disposition.kind === "retry",
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, action.id),
                eq(chatActions.status, "received"),
              ),
            );
          if (disposition.kind === "endpoint_attention") {
            await tx
              .update(chatEndpoints)
              .set({
                status: "attention",
                healthMessage:
                  "Provider credentials or permissions need attention",
                lastError: failure,
                updatedAt: new Date(),
              })
              .where(eq(chatEndpoints.id, record.endpoint.id));
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
              .where(eq(toolConnections.id, record.endpoint.connectionId));
          } else if (disposition.kind === "resource_unavailable" && resource) {
            await tx
              .update(chatEndpointResources)
              .set({ availability: "unavailable", updatedAt: new Date() })
              .where(eq(chatEndpointResources.id, resource.id));
          }
        });
        if (disposition.kind === "endpoint_attention") {
          await runtime
            .removeEndpoint(record.endpoint.id)
            .catch(() => undefined);
        }
        throw error;
      }
    }
    const endpointRuntime =
      runtime.get(event.endpointId) ?? (await runtimeFor(record.endpoint));
    const thread = endpointRuntime.thread(starterThreadId);
    const synthetic = {
      id: createHash("sha256")
        .update(
          `${event.event.command}:${event.event.user.userId}:${providerCommandId}`,
        )
        .digest("hex"),
      threadId: thread.id,
      text,
      formatted: { type: "root", children: [] },
      raw: {},
      author: event.event.user,
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
      links: [],
      isMention: true,
    } as unknown as Message;
    await handleSdkMessage({
      endpointId: event.endpointId,
      provider: event.provider,
      thread,
      message: synthetic,
      trigger: "mention",
    });
  }

  async function applyProviderLifecycleEffect(
    endpoint: EndpointRow,
    effect: ChatProviderLifecycleEffect,
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
    try {
      // A recovered GitHub installation can have a different installation id
      // while retaining the same App credentials. Resolve it server-side and
      // keep it only in the connection's vault-backed credential references.
      if (effect.kind === "endpoint" && effect.availability === "available") {
        await withCredentialMutationLease(endpoint, async () => {
          const currentRecord = await endpointRecord(endpoint.id);
          if (!currentRecord) throw notFound("Chat endpoint not found");
          const currentEndpoint = currentRecord.endpoint;
          const currentCredentials = await resolveCredentials(currentEndpoint);
          const prepared = await prepareProviderInventory(
            currentEndpoint,
            currentCredentials,
          );
          if (
            currentEndpoint.provider === "github" &&
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
        });
      }

      await db.transaction(async (tx) => {
        const now = new Date();
        if (effect.kind === "resource") {
          const providerResourceId =
            endpoint.provider === "github" &&
            typeof effect.metadata?.fullName === "string"
              ? effect.metadata.fullName.toLowerCase()
              : endpoint.provider === "microsoft-teams"
                ? baseTeamsConversationId(effect.providerResourceId)
                : effect.providerResourceId;
          const resourceMetadata =
            endpoint.provider === "github" &&
            providerResourceId !== effect.providerResourceId
              ? {
                  ...effect.metadata,
                  providerRepositoryId: effect.providerResourceId,
                }
              : (effect.metadata ?? {});
          const [resource] = await tx
            .insert(chatEndpointResources)
            .values({
              companyId: endpoint.companyId,
              endpointId: endpoint.id,
              type: effect.resourceType,
              providerResourceId,
              parentProviderResourceId: effect.parentProviderResourceId ?? null,
              label: effect.label,
              providerUrl: effect.providerUrl ?? null,
              availability: effect.availability,
              enabled: false,
              metadata: resourceMetadata,
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
                label: effect.label,
                providerUrl: effect.providerUrl ?? null,
                availability: effect.availability,
                metadata: resourceMetadata,
                updatedAt: now,
              },
            })
            .returning({ id: chatEndpointResources.id });
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
                  eq(chatConversations.companyId, endpoint.companyId),
                  eq(chatConversations.endpointId, endpoint.id),
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
            .where(eq(chatEndpoints.id, endpoint.id));
        } else {
          const reason = redactSensitiveText(effect.reason).slice(
            0,
            MAX_ERROR_TEXT,
          );
          if (effect.availability === "available") {
            const current = await tx
              .select({
                status: chatEndpoints.status,
                setup: chatEndpoints.setup,
              })
              .from(chatEndpoints)
              .where(eq(chatEndpoints.id, endpoint.id))
              .then((rows) => rows[0] ?? null);
            const status =
              current?.setup.step === "complete"
                ? "active"
                : current?.status === "attention"
                  ? "verifying"
                  : (current?.status ?? endpoint.status);
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
              .where(eq(chatEndpoints.id, endpoint.id));
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
              .where(eq(toolConnections.id, endpoint.connectionId));
          } else {
            const resourceAvailability =
              effect.availability === "revoked" &&
              endpoint.provider === "github"
                ? "removed"
                : "unavailable";
            await tx
              .update(chatEndpoints)
              .set({
                status: effect.availability,
                healthMessage: reason,
                lastError: reason,
                lastEventAt: now,
                updatedAt: now,
              })
              .where(eq(chatEndpoints.id, endpoint.id));
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
              .where(eq(toolConnections.id, endpoint.connectionId));
            await tx
              .update(chatEndpointResources)
              .set({ availability: resourceAvailability, updatedAt: now })
              .where(
                and(
                  eq(chatEndpointResources.companyId, endpoint.companyId),
                  eq(chatEndpointResources.endpointId, endpoint.id),
                ),
              );
            await tx
              .update(chatConversations)
              .set({ state: "unavailable", updatedAt: now })
              .where(
                and(
                  eq(chatConversations.companyId, endpoint.companyId),
                  eq(chatConversations.endpointId, endpoint.id),
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
    } catch (error) {
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
      throw error;
    }

    if (refreshRuntimeAfterLifecycle) {
      // The verified reinstall may have assigned a new installation id. Drop
      // the runtime that authenticated the lifecycle webhook with the prior
      // id; the next send recreates it from the newly persisted credentials.
      await runtime.removeEndpoint(endpoint.id).catch((error) => {
        logger.warn(
          { endpointId: endpoint.id, error: redactError(error) },
          "failed to refresh recovered GitHub chat endpoint runtime",
        );
      });
    }
    if (
      effect.kind === "endpoint" &&
      (effect.availability === "attention" || effect.availability === "revoked")
    ) {
      await runtime.removeEndpoint(endpoint.id).catch((error) => {
        logger.warn(
          { endpointId: endpoint.id, error: redactError(error) },
          "failed to stop unavailable chat endpoint runtime",
        );
      });
    }
    return true;
  }

  async function applyProviderLifecycleEffects(
    endpoint: EndpointRow,
    effects: ChatProviderLifecycleEffect[],
  ) {
    for (const effect of effects) {
      if (effect.provider !== endpoint.provider) continue;
      await applyProviderLifecycleEffect(endpoint, effect);
    }
  }

  async function handleWebhook(
    publicId: string,
    provider: ChatSdkProvider,
    request: Request,
  ) {
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
    if (provider === "github" && !recoveringRevokedGitHubInstallation) {
      const inspection = request.clone();
      const body = await inspection.text();
      const signature = inspection.headers.get("x-hub-signature-256");
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
      if (signatureValid) {
        try {
          const payload = JSON.parse(body) as {
            installation?: { id?: unknown };
          };
          const incomingInstallationId = payload.installation?.id;
          if (
            incomingInstallationId !== undefined &&
            String(incomingInstallationId) !== credentials.installationId
          ) {
            // A dedicated endpoint represents exactly one GitHub App
            // installation. GitHub sends every installation's events to the
            // App webhook, so acknowledge foreign signed traffic without
            // admitting it to Paperclip or prompting endless redelivery.
            return new Response("ignored", { status: 200 });
          }
        } catch {
          // Let the adapter return its normal invalid-JSON response.
        }
      }
    }
    const lifecycleInspection = request.clone();
    const githubInspection = provider === "github" ? request.clone() : null;
    const endpointRuntime = await runtimeFor(endpoint);
    const response = await endpointRuntime.handleWebhook(request);
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
        await db
          .update(chatEndpoints)
          .set({
            setup: {
              ...endpoint.setup,
              webhookVerifiedAt: new Date().toISOString(),
            },
            healthMessage: "Slack Request URL verified",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatEndpoints.id, endpoint.id),
              eq(chatEndpoints.status, "verifying"),
            ),
          );
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
      await applyProviderLifecycleEffects(endpoint, effects);
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
        await recordLifecycleDelivery({
          endpointId: endpoint.id,
          ...lifecycle,
        });
      }
    }
    if (provider === "telegram" && response.ok && lifecyclePayload) {
      const lifecycle = telegramLifecycleEventFromPayload(lifecyclePayload);
      if (lifecycle) {
        await recordLifecycleDelivery({
          endpointId: endpoint.id,
          ...lifecycle,
        });
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
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    if (updates.length === 0) return listResources(endpointId);
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
        { code: "chat_resource_unavailable", resourceId: unavailable.id },
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
    const existingLink = await db
      .select({ status: chatIdentityLinks.status })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.endpointId, endpointId),
          eq(chatIdentityLinks.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existingLink?.status === "linked") {
      throw conflict("This external identity is already linked", {
        code: "chat_identity_already_linked",
      });
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    await db
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
    const membership = await db
      .select({ status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, link.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, paperclipUserId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (membership?.status !== "active")
      throw forbidden(
        "The signed-in Paperclip account is not a member of this company",
      );
    const confirmed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${link.companyId}:${link.principalId}`}, 0))`,
      );
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
          { code: "chat_identity_link_conflict" },
        );
      }
      const now = new Date();
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
    const rows = await db
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
          eq(chatIdentityLinks.endpointId, endpointId),
          eq(chatIdentityLinks.principalId, principalId),
        ),
      )
      .returning({ id: chatIdentityLinks.id });
    if (!rows.length) throw notFound("Identity link not found");
  }

  async function listConversations(endpointId: string) {
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
      return {
        id: conversation.id,
        companyId: conversation.companyId,
        endpointId: conversation.endpointId,
        resourceId: conversation.resourceId,
        externalLabel: conversation.externalLabel,
        externalUrl: conversation.providerUrl,
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
    const [deliveries, publications, actions] = await Promise.all([
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
    ]);
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
          replayable: row.state === "failed" && Boolean(row.conversationId),
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
      ...actions.map((row) => ({
        id: row.id,
        kind: "delivery" as const,
        status: row.status,
        summary: `Slack slash-command task start ${row.status.replaceAll("_", " ")}`,
        detail:
          row.status === "delivery_unknown"
            ? "Slack may have accepted the task-start message, so Paperclip will not replay it automatically. Check the channel before submitting a new command."
            : row.status === "failed"
              ? "Slack rejected the task-start message. Submit the command again to retry."
              : null,
        createdAt: row.createdAt.toISOString(),
        replayable: false,
        resolutionActions: [],
      })),
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
    await db.transaction(async (tx) => {
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
          { code: "chat_publication_resolution_not_required" },
        );
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
      if (action === "mark_delivered") {
        await tx
          .update(chatEndpoints)
          .set({ lastPublicationAt: now, updatedAt: now })
          .where(eq(chatEndpoints.id, endpointId));
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
    });
    await processPendingPublications();
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
      if (existing) return existing;

      const comment = await issueService(tx as unknown as Db).addComment(
        conversation.issueId,
        body,
        { userId },
        { authorType: "user" },
        tx,
      );
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
        })
        .returning();
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
      return created;
    });
    await processPendingPublications();
    return (
      (await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.id, publication.id))
        .then((rows) => rows[0] ?? null)) ?? publication
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
        !(
          input.endpoint.provider === "microsoft-teams" &&
          !input.conversation.isDirectMessage
        );
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
    if (files.length)
      return await attemptProviderPublication(async () =>
        input.replaceProviderMessageId
          ? await editOrPostProviderPublication(
              () =>
                thread.adapter.editMessage(
                  thread.id,
                  input.replaceProviderMessageId!,
                  { markdown: text, files },
                ),
              () => thread.post({ markdown: text, files }),
            )
          : await thread.post({ markdown: text, files }),
      );
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

  function runIdFromMilestonePublication(
    publication: typeof chatPublications.$inferSelect,
  ): string | null {
    if (!publication.payload.progressState) return null;
    const match = /^run:([^:]+):(?:queued|working|failed):/.exec(
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
      .orderBy(desc(chatPublications.createdAt))
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
        return (
          rows.find(
            (row) =>
              Boolean(row.providerMessageId) &&
              row.payload.progressState !== undefined,
          )?.providerMessageId ?? null
        );
      });
  }

  async function processPendingPublications(limit = 25) {
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
          if (endpoint.status === "paused" || endpoint.status === "attention") {
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
                ),
              );
            continue;
          }
          // The setup conversation is a real end-to-end test: once provider
          // credentials are verified, its safe agent response must be able to
          // reach the provider before the operator confirms the final wizard
          // step. Draft, paused, revoked, and archived endpoints remain closed.
          if (
            !["active", "verifying"].includes(endpoint.status) ||
            ["unavailable", "endpoint_removed"].includes(conversation.state)
          ) {
            await db
              .update(chatPublications)
              .set({
                state: "cancelled",
                redactedError: "External destination is no longer active",
                updatedAt: new Date(),
              })
              .where(eq(chatPublications.id, publication.id));
            continue;
          }
          if (conversation.isDirectMessage) {
            if (!endpoint.allowDirectMessages)
              throw new Error(
                "Direct messages are disabled for this connection",
              );
          } else {
            const resource = conversation.resourceId
              ? await db
                  .select()
                  .from(chatEndpointResources)
                  .where(
                    and(
                      eq(chatEndpointResources.id, conversation.resourceId),
                      eq(chatEndpointResources.endpointId, endpoint.id),
                      eq(chatEndpointResources.companyId, endpoint.companyId),
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
                .where(eq(chatPublications.id, publication.id));
              continue;
            }
          }
          const payload = publication.payload as SafeChatPublicationPayload;
          const replaceProviderMessageId = CAPABILITIES[endpoint.provider]
            .messageEdits
            ? await runPublicationToReplace(publication, payload)
            : null;
          const sent = await postSafePublication({
            endpoint,
            conversation,
            publication,
            payload,
            replaceProviderMessageId,
          });
          await db.transaction(async (tx) => {
            await tx
              .update(chatPublications)
              .set({
                state: "published",
                providerMessageId: sent.id,
                publishedAt: new Date(),
                redactedError: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatPublications.id, publication.id),
                  eq(chatPublications.state, "streaming"),
                ),
              );
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
              .set({ lastPublicationAt: new Date(), updatedAt: new Date() })
              .where(eq(chatEndpoints.id, endpoint.id));
          });
        } catch (error) {
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
          await db.transaction(async (tx) => {
            if (disposition.kind === "endpoint_attention") {
              await tx
                .update(chatEndpoints)
                .set({
                  status: "attention",
                  healthMessage:
                    "Provider credentials or permissions need attention",
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

            const state =
              disposition.kind === "retry" && !terminalRetry
                ? "retry"
                : disposition.kind === "delivery_unknown"
                  ? "delivery_unknown"
                  : disposition.kind === "resource_unavailable"
                    ? "cancelled"
                    : "failed";
            await tx
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
              .where(eq(chatPublications.id, publication.id));
          });
          if (disposition.kind === "endpoint_attention") {
            await runtime
              .removeEndpoint(publication.endpointId)
              .catch(() => undefined);
          }
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
      }
    }
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
    resolvePublication,
    publishComment,
    publishBoardMessage,
    processPendingPublications,
    processPendingDeliveries,
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
