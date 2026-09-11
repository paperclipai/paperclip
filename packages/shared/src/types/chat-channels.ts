/** Provider-neutral contracts for Paperclip's native external chat subsystem. */
export const CHAT_PROVIDERS = [
  "slack",
  "github",
  "discord",
  "microsoft-teams",
  "telegram",
  "agentmail",
] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export const CHAT_ENDPOINT_STATUSES = [
  "draft",
  "verifying",
  "active",
  "paused",
  "attention",
  "revoked",
  "archived",
] as const;
export type ChatEndpointStatus = (typeof CHAT_ENDPOINT_STATUSES)[number];

export const CHAT_DEPLOYMENT_MODES = ["direct", "relay"] as const;
export type ChatDeploymentMode = (typeof CHAT_DEPLOYMENT_MODES)[number];

export const CHAT_CONCURRENCY_POLICIES = [
  "burst",
  "queue",
  "debounce",
  "drop",
  "concurrent",
] as const;
export type ChatConcurrencyPolicy = (typeof CHAT_CONCURRENCY_POLICIES)[number];

export const CHAT_EVENT_KINDS = [
  "mention",
  "message",
  "direct_message",
  "message_updated",
  "message_deleted",
  "message_restored",
  "reaction_added",
  "reaction_removed",
  "action",
  "modal_submitted",
  "modal_closed",
  "slash_command",
  "file_shared",
  "installation",
  "uninstallation",
  "unknown",
] as const;
export type ChatEventKind = (typeof CHAT_EVENT_KINDS)[number];

export const CHAT_DELIVERY_STATES = [
  "received",
  "filtered",
  "processing",
  "processed",
  "retry",
  "failed",
] as const;
export type ChatDeliveryState = (typeof CHAT_DELIVERY_STATES)[number];

export const CHAT_PUBLICATION_STATES = [
  "pending",
  "awaiting_consent",
  "streaming",
  "published",
  "retry",
  "delivery_unknown",
  "failed",
  "cancelled",
] as const;
export type ChatPublicationState = (typeof CHAT_PUBLICATION_STATES)[number];

export const CHAT_FILE_TRANSFER_PHASES = [
  "consent_pending",
  "consent_sending",
  "consent_unknown",
  "awaiting_consent",
  "upload_pending",
  "uploading",
  "upload_unknown",
  "file_info_pending",
  "file_info_sending",
  "file_info_unknown",
  "delivered",
  "declined",
  "expired",
  "cancelled",
  "conflict",
] as const;
export type ChatFileTransferPhase = (typeof CHAT_FILE_TRANSFER_PHASES)[number];

/** Closed presentation only: never provider URLs, credentials or private state. */
export interface ChatFileTransferSummary {
  provider: "microsoft-teams";
  phase: ChatFileTransferPhase;
  filename: string;
  expiresAt?: string | null;
  /** Monotonic durable row revision, not a schema version. */
  version: number;
}

export type ChatFileTransferResolutionPrecondition = Pick<
  ChatFileTransferSummary,
  "phase" | "version"
>;

export const CHAT_CONVERSATION_STATES = [
  "active",
  "waiting",
  "completed",
  "unavailable",
  "endpoint_removed",
] as const;
export type ChatConversationState = (typeof CHAT_CONVERSATION_STATES)[number];

export const CHAT_PRINCIPAL_KINDS = ["user", "bot", "app", "system"] as const;
export type ChatPrincipalKind = (typeof CHAT_PRINCIPAL_KINDS)[number];

export const CHAT_IDENTITY_LINK_STATUSES = [
  "pending",
  "linked",
  "revoked",
  "expired",
] as const;
export type ChatIdentityLinkStatus =
  (typeof CHAT_IDENTITY_LINK_STATUSES)[number];

export const CHAT_RESOURCE_AVAILABILITIES = [
  "available",
  "unavailable",
  "removed",
] as const;
export type ChatResourceAvailability =
  (typeof CHAT_RESOURCE_AVAILABILITIES)[number];

export interface ChatAdapterCapabilities {
  threads: boolean;
  directMessages: boolean;
  nativeStreaming: boolean;
  messageEdits: boolean;
  messageDeletes: boolean;
  reactions: boolean;
  files: boolean;
  cards: boolean;
  actions: boolean;
  modals: boolean;
  slashCommands: boolean;
  ephemeralMessages: boolean;
  proactiveDirectMessages: boolean;
}

export interface ChatEndpointBehaviorPolicy {
  /** Defaults to queue and is not exposed in the initial settings UI. */
  concurrency: ChatConcurrencyPolicy;
  allowDirectMessages: boolean;
  allowGroupChats: boolean;
  allowUnlinkedPeople: boolean;
}

export const CHAT_CALLBACK_SURFACE_STATUSES = [
  "current",
  "stale",
  "unverified",
] as const;
export type ChatCallbackSurfaceStatus =
  (typeof CHAT_CALLBACK_SURFACE_STATUSES)[number];

export interface ChatEndpointCallbackSurfaceState {
  status: ChatCallbackSurfaceStatus;
  observedAt?: string | null;
}

export interface ChatEndpointCallbackSurfaces {
  events: ChatEndpointCallbackSurfaceState;
  interactivity: ChatEndpointCallbackSurfaceState;
  slashCommands: ChatEndpointCallbackSurfaceState;
}

export interface ChatEndpointSetupState {
  step: "choose_agent" | "provider_setup" | "test" | "complete";
  /** Server-generated boundary; only provider events at or after this time can complete setup. */
  testStartedAt?: string | null;
  /** Set only after the provider has delivered a signed callback challenge. */
  webhookVerifiedAt?: string | null;
  authorizationUrl?: string | null;
  providerUrl?: string | null;
  command?: string | null;
  webhookUrl?: string | null;
  messagingEndpoint?: string | null;
  /** Safe presence signal only; the secret value is returned once by its generation endpoint. */
  webhookSecretConfigured?: boolean;
  /** Provider callback surfaces observed at the endpoint's current public URL. */
  callbackSurfaces?: ChatEndpointCallbackSurfaces;
  /** True when at least one previously observed callback still targets an old public URL. */
  callbacksNeedUpdate?: boolean;
}

export interface ChatEndpointSetupSecret {
  webhookSecret: string;
}

export type ChannelPublicationMode = "automatic" | "explicit";
export type ExternalMessageExecutionPolicy = "restricted" | "agent";

export interface ChatEndpoint {
  id: string;
  companyId: string;
  connectionId: string;
  /** Older clients omit these fields; defaults are automatic/restricted. */
  publicationMode?: ChannelPublicationMode;
  externalExecutionPolicy?: ExternalMessageExecutionPolicy;
  provider: ChatProvider;
  publicId: string;
  status: ChatEndpointStatus;
  deploymentMode: ChatDeploymentMode;
  assignedAgentId: string;
  assignedAgentName?: string | null;
  sponsorUserId?: string | null;
  providerAccountId?: string | null;
  providerAccountLabel?: string | null;
  botExternalId?: string | null;
  botUsername?: string | null;
  botLabel?: string | null;
  botAvatarUrl?: string | null;
  allowDirectMessages: boolean;
  allowGroupChats: boolean;
  allowUnlinkedPeople: boolean;
  replyMode: "subscribed";
  capabilities: ChatAdapterCapabilities;
  setup: ChatEndpointSetupState;
  healthMessage?: string | null;
  lastError?: string | null;
  lastActivityAt?: string | null;
  lastPublicationAt?: string | null;
  activatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatEndpointResource {
  id: string;
  companyId: string;
  endpointId: string;
  type: string;
  providerResourceId: string;
  parentProviderResourceId?: string | null;
  label: string;
  detail?: string | null;
  providerUrl?: string | null;
  availability: ChatResourceAvailability;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatExternalPrincipal {
  id: string;
  companyId: string;
  provider: ChatProvider;
  providerAccountId: string;
  externalId: string;
  kind: ChatPrincipalKind;
  displayName?: string | null;
  handle?: string | null;
  avatarUrl?: string | null;
  isBot: boolean;
  lastSeenAt?: string | null;
}

export interface ChatIdentityLink {
  id: string;
  companyId: string;
  endpointId: string;
  principalId: string;
  externalLabel: string;
  externalDetail?: string | null;
  paperclipUserId?: string | null;
  paperclipUserLabel?: string | null;
  status: ChatIdentityLinkStatus;
  expiresAt?: string | null;
  confirmedAt?: string | null;
  revokedAt?: string | null;
}

export interface ChatConversation {
  id: string;
  companyId: string;
  endpointId: string;
  resourceId?: string | null;
  issueId: string;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  externalConversationId: string;
  externalThreadId: string;
  sessionGeneration: number;
  externalLabel: string;
  externalUrl?: string | null;
  isDirectMessage: boolean;
  state: ChatConversationState;
  lastPublicationStatus?: ChatPublicationState | null;
  lastActivityAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatDelivery {
  id: string;
  companyId: string;
  endpointId: string;
  conversationId?: string | null;
  principalId?: string | null;
  providerEventId: string;
  deduplicationKey: string;
  eventKind: ChatEventKind;
  state: ChatDeliveryState;
  attempts: number;
  summary?: string | null;
  redactedError?: string | null;
  receivedAt: string;
  processedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SafeExternalChatCardKind = "status" | "question" | "confirmation";

export type SafeExternalChatCardAction =
  | {
      type: "callback";
      actionId: string;
      label: string;
      style?: "default" | "primary" | "danger";
    }
  | {
      type: "link";
      label: string;
      url: string;
    };

export interface SafeExternalChatCard {
  schema: "paperclip.chat.card.v1";
  kind: SafeExternalChatCardKind;
  title: string;
  body?: string;
  actions?: SafeExternalChatCardAction[];
}

export interface SafeChatPublicationPayload {
  text: string;
  attachmentIds?: string[];
  interactionId?: string;
  card?: SafeExternalChatCard;
  /** Server-managed metadata for a logical publication split into durable messages. */
  transportPart?: {
    batchId: string;
    count: number;
    index: number;
    /** Server-managed provider rendering for this transport part. */
    mode?:
      "inline" | "discord_markdown_attachment" | "telegram_markdown_attachment";
    orderKey: string;
    /** Closed, server-generated Markdown fence wrappers; text remains an exact source slice. */
    prefix?: string;
    suffix?: string;
  };
  progressState?:
    | "queued"
    | "working"
    | "waiting_for_input"
    | "approval_needed"
    | "completed"
    | "failed";
}

export interface ChatPublication {
  id: string;
  companyId: string;
  endpointId: string;
  conversationId: string;
  issueId: string;
  commentId?: string | null;
  idempotencyKey: string;
  state: ChatPublicationState;
  providerMessageId?: string | null;
  providerUrl?: string | null;
  attempts: number;
  redactedError?: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string | null;
}

export interface ChatPublicationSummary {
  id: string;
  state: ChatPublicationState;
  providerUrl?: string | null;
  attempts: number;
  redactedError?: string | null;
  nextAttemptAt?: string | null;
  publishedAt?: string | null;
  fileTransfer?: ChatFileTransferSummary;
}

export interface ChatPublicationBatchStatus {
  /** First unresolved part; a terminal nonpublished part for mixed outcomes. */
  publication: ChatPublicationSummary;
  total: number;
  published: number;
  /** Additive during rolling upgrades; missing settlement proof is not permission to dismiss. */
  parts?: ChatPublicationSummary[];
  awaitingConsent?: number;
  declined?: number;
  expired?: number;
  /** Excludes declined and expired. */
  cancelled?: number;
  /** published + declined + expired + cancelled, never failed or uncertain. */
  settled?: number;
  canDismiss?: boolean;
}

export interface ChatActivityItem {
  id: string;
  kind: "delivery" | "publication" | "action" | "health" | "repair";
  actionType?:
    | "slash_task_start"
    | "provider_effect"
    | "github_webhook_ingress"
    | "slack_session_sync"
    | "slack_session_stop";
  status: string;
  summary: string;
  detail?: string | null;
  createdAt: string;
  replayable?: boolean;
  resolutionActions?: Array<"mark_delivered" | "retry_anyway" | "cancel">;
  fileTransfer?: ChatFileTransferSummary;
}

export interface ExternalChannelBindingSummary {
  endpointId: string;
  provider: ChatProvider;
  botLabel?: string | null;
  externalLabel: string;
  externalUrl?: string | null;
  conversationId: string;
  publicationState?: ChatPublicationState | null;
  assignedAgentLocked: true;
}

export interface CreateChatEndpointInput {
  provider: ChatProvider;
  assignedAgentId: string;
  applicationId?: string;
  name?: string;
}

export interface UpdateChatEndpointInput {
  allowDirectMessages?: boolean;
  allowGroupChats?: boolean;
  allowUnlinkedPeople?: boolean;
}

export interface ConfigureChatEndpointInput {
  action: "configure" | "verify" | "pause" | "resume" | "reconnect" | "remove";
  credentials?: Record<string, string>;
}

export interface NormalizedChatEvent {
  providerEventId: string;
  kind: ChatEventKind;
  providerAccountId: string;
  principal: {
    externalId: string;
    kind: ChatPrincipalKind;
    displayName?: string;
    handle?: string;
    isBot?: boolean;
  };
  resource: {
    type: string;
    providerResourceId: string;
    parentProviderResourceId?: string;
    label: string;
    providerUrl?: string;
  };
  conversation: {
    externalConversationId: string;
    externalThreadId?: string;
    label: string;
    providerUrl?: string;
    isDirectMessage?: boolean;
  };
  message?: {
    providerMessageId: string;
    text: string;
    mentionedBot?: boolean;
    replyToProviderMessageId?: string;
    attachmentUrls?: string[];
  };
  raw: Record<string, unknown>;
}
