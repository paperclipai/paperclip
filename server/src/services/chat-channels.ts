import { createChatSdkMessageReceiver } from "./chat-channels/runtime/sdk-messages.js";
import { admitDiscordSdkMessage } from "./chat-channels/discord/messages.js";
import { resolveInboundConversationBinding } from "./chat-channels/inbound/conversation-binding.js";
import { createGitHubMaintenance } from "./chat-channels/github/maintenance.js";
import { createSpekoChannelService, authorizeSpekoPublicVoiceTask, replaceSpekoChannelRuntime, SPEKO_CONVERSATION_IS_LINEAR } from "./chat-channels/speko/runtime.js";
import { prepareDiscordRuntimeCommand } from "./chat-channels/discord/runtime-commands.js";
import { createSlackSetupServices } from "./chat-channels/slack/setup-services.js";
import { isSupportedTelegramWebhookBaseUrl } from "./chat-channels/telegram/setup.js";
import { initializeGitHubWebhookRuntime } from "./chat-channels/github/webhook-runtime.js";
import { githubInboundTaskTitle, githubInboundCommentText, githubAssignedAgentRequiresLowTrust, retainGitHubDeliveryAuthority, retainGitHubReviewReceipt } from "./chat-channels/github/task-preparation.js";
import { applyChatTaskReviewContainment } from "./chat-channels/inbound/task-trust.js";
import { photonConversationBindingIsComplete, photonControlTargetsConversation, photonReplyMetadata, recordPhotonInboundActivity } from "./chat-channels/imessage-photon/messages.js";
import { deferTeamsSetupReply } from "./chat-channels/microsoft-teams/setup-replies.js";
import { slackOrphanFollowUp, stripSlackTitleMentions, slackMessageMeetsMentionRequirement } from "./chat-channels/slack/messages.js";
import { createChatPublicationResolution } from "./chat-channels/publications/resolution.js";
import { createChatPublicationRequests } from "./chat-channels/publications/requests.js";
import { createTeamsBoardSendPreparation } from "./chat-channels/microsoft-teams/board-send-preparation.js";
import { createInboundWakeAuthority, inboundWakeScope } from "./chat-channels/inbound/wakeup-authorization.js";
import { createInboundWakeups } from "./chat-channels/inbound/wakeups.js";
import { createInboundWakeNotices } from "./chat-channels/inbound/wakeup-notices.js";
import { createDiscordRuntimeReconciliation } from "./chat-channels/discord/runtime-reconciliation.js";
import { createPhotonRuntimeCallbacks, discardPhotonInboundMessages, photonRuntimeStatusMayAdvance, PHOTON_MESSAGE_INGRESS_ONLY } from "./chat-channels/imessage-photon/runtime-callbacks.js";
import { createChatReceiverOwnership } from "./chat-channels/runtime/ownership.js";
import { createGitHubWebhookScope, githubWebhookCanRecoverRevokedInstallation } from "./chat-channels/github/webhook-scope.js";
import { createGitHubWebhookAuthentication, retryableGitHubWebhookResponse } from "./chat-channels/github/webhook-authentication.js";
import { createSlackWebhookCallbacks } from "./chat-channels/slack/webhook-callbacks.js";
import { createGitHubWebhookEvents } from "./chat-channels/github/webhook-events.js";
import { createSlackTaskStartResolution } from "./chat-channels/slack/task-start-resolution.js";
import { createSlackBoardMessages } from "./chat-channels/slack/board-messages.js";
import { PROVIDER_LABELS, CAPABILITIES } from "./chat-channels/provider-catalog.js";
import { createMessageResourceAdmission } from "./chat-channels/inbound/resource-admission.js";
import type { DiscordGatewayOwnership } from "./chat-channels/runtime-types.js";
import { createInboundAdmission } from "./chat-channels/inbound/admission.js";
import { createInboundEnvelope } from "./chat-channels/inbound/envelope.js";
import { sameTeamsThreadIdentity, durableExternalThreadIdentity, canonicalProviderResourceId, nonDirectDestinationAllowed, linearControlCommand, actionThreadMatchesConversation } from "./chat-channels/inbound/surfaces.js";
import { createChatInboundAuthority } from "./chat-channels/inbound/authorization.js";
import { createTeamsRoutes } from "./chat-channels/microsoft-teams/routes.js";
import type { LiveInboundMessage } from "./chat-channels/runtime-types.js";
import { DELIVERY_PROCESSING_STALE_MS, normalizedDeliveryThreadId, normalizedLifecycleEffect, deliveryReady, pendingInboundWakeupCondition, lifecycleRuntimeFence, normalizedLifecycleWithRuntimeFence } from "./chat-channels/inbound/delivery-ledger.js";
import { createChatMessageLifecycle } from "./chat-channels/inbound/lifecycle.js";
import { createChatConversationDeliveryQueue } from "./chat-channels/inbound/conversation-queue.js";

import { createChatPublicationTaskControl } from "./chat-channels/publications/task-control.js";
import { createChatPublicationTransport } from "./chat-channels/publications/transport.js";
import { createChatPublicationAuthorization } from "./chat-channels/publications/authorization.js";
import { createChatPublicationFailures } from "./chat-channels/publications/failures.js";
import { createChatPublicationPreparation } from "./chat-channels/publications/preparation.js";
import { createChatPublicationWorker } from "./chat-channels/publications/worker.js";
import { createChatPublicationQueue } from "./chat-channels/publications/queue.js";
import { isExplicitOperatorPublication } from "./chat-channels/publications/policy.js";

import { createChatCredentials } from "./chat-channels/credentials.js";
import { createChatEndpoints } from "./chat-channels/endpoints.js";
import { createChatConfiguration } from "./chat-channels/configuration.js";
import { createPhotonSetupInspection } from "./chat-channels/imessage-photon/setup.js";
import { createChatSdkStatePersistence } from "./chat-channels/sdk-state.js";
export { createChatSdkStatePersistence } from "./chat-channels/sdk-state.js";
import { createChatInteractionCallbacks } from "./chat-channels/interactions/callbacks.js";
import { createChatInteractionContinuations } from "./chat-channels/interactions/continuations.js";
import { createGitHubInstallationLifecycle } from "./chat-channels/github/installation-lifecycle.js";
import { githubChatReviewService } from "./chat-github-reviews.js";
import { createGitHubAppSetup } from "./chat-channels/github/app-setup.js";
import { createSlackTaskAuthorityRegistration } from "./chat-channels/slack/task-authority.js";
import { createGitHubPublicationPolicy } from "./chat-channels/github/publication-policy.js";
import { createTelegramAttachmentFailure } from "./chat-channels/telegram/attachment-failure.js";
import { createSlackCommands } from "./chat-channels/slack/commands.js";
import { createTelegramCommands, telegramInboundControls, telegramGuidanceResponse, telegramForumControlResponse } from "./chat-channels/telegram/commands.js";
import { createTeamsFileDelivery } from "./chat-channels/microsoft-teams/file-delivery.js";
import { createGitHubSetupSecret } from "./chat-channels/github/setup-secret.js";
import { createSlackInventory } from "./chat-channels/slack/inventory.js";

import { REQUIRED_GITHUB_EVENTS, UNAVOIDABLE_GITHUB_EVENTS } from "./chat-channels/github/credentials.js";

import { createPhotonCredentialChecks } from "./chat-channels/imessage-photon/credentials.js";

import { createSetupProbes } from "./chat-channels/setup-probes.js";
import { createChatActivity } from "./chat-channels/activity.js";

import { createProviderEffects, type ProviderEffectTarget } from "./chat-channels/provider-effects.js";
import { createTelegramCallbackNoticeAuthority } from "./chat-channels/telegram/callback-notices.js";
import { createOutboundAttachments } from "./chat-channels/outbound-attachments.js";
export { hydrateOutboundAttachment } from "./chat-channels/outbound-attachments.js";

import { createInboundAttachments } from "./chat-channels/inbound-attachments.js";
import { createInboundReactions } from "./chat-channels/reactions.js";

import { createReceiptReactions } from "./chat-channels/receipt-reactions.js";
import { createDiscordRootThreads } from "./chat-channels/discord/root-threads.js";
import { createDiscordGatewayEvents } from "./chat-channels/discord/gateway-events.js";
import { createTeamsFileAuthority } from "./chat-channels/microsoft-teams/file-transfer-authority.js";
import { createPhotonEvents } from "./chat-channels/imessage-photon/events.js";
import { createTelegramPublicationDrafts } from "./chat-channels/telegram/publication-drafts.js";
import { createSlackFileReceipts } from "./chat-channels/slack/file-receipts.js";
import { createSlackSessionStatus } from "./chat-channels/slack/session-status.js";
import { createDiscordCommands } from "./chat-channels/discord/commands.js";
import { createSlackTaskStart } from "./chat-channels/slack/task-start.js";
import { createGitHubWebhookIngress } from "./chat-channels/github/webhook-ingress.js";
import { createSlackSessionStop } from "./chat-channels/slack/session-stop.js";
import { createTelegramMaintenance } from "./chat-channels/telegram/maintenance.js";
import type { EndpointRow, DbTransaction, DbOrTransaction, RuntimeContext, LifecycleRuntimeFence, InboundRuntimeContext, InternalSetupState } from "./chat-channels/runtime-types.js";
import { createChatFailedRunRetry } from "./chat-channels/failed-run-retry.js";
import { createChatPublicationReplacement } from "./chat-channels/publication-replacement.js";
import { createChatIdentityLinks } from "./chat-channels/identity-links.js";
import { createChatResourceReconciliation } from "./chat-channels/resource-reconciliation.js";

import { scheduleSlackLifecycleResourceHydration } from "./chat-channels/slack/resources.js";

import {
  MAX_INBOUND_TEXT,
  stableExternalPrincipalId,
} from "./chat-channels/message-lifecycle.js";
import { telegramLifecycleEventFromPayload, telegramIgnoresInboundMessage } from "./chat-channels/telegram/messages.js";

import {
  teamsWebhookLifecycleEventFromPayload, teamsRootMentionCanEnableSetupDestination, teamsOrphanFollowUp, teamsAttachmentReferenceText,
} from "./chat-channels/microsoft-teams/messages.js";
import {
  githubSupplementalLifecycleFromRequest,
} from "./chat-channels/github/messages.js";
import { nextChatActionAt } from "./chat-action-work.js";
import type { ScheduledChatAction } from "./chat-work-notifications.js";
import { notifyChatDeliveryWork, notifyChatPublicationWork } from "./chat-work-notifications.js";

import { voiceSessionStore } from "./voice/voice-session-store.js";
import { createChatRuntime, type ChatRuntime } from "./chat-runtime.js";
import type { ChatEndpointRuntime } from "./voice/voice-runtime.js";

import { fastResponseService, fastResponseSourceCurrent } from "./fast-responses.js";
import { fastResponseRequests } from "@paperclipai/db";
import { chatCredentialMutationLease } from "./chat-credential-mutation-lease.js";
import type { AgentAvatarRequest } from "./agent-avatars.js";

import { canPublishIssueToChatAudience } from "./authorization.js";

import { buildChatCommunicationGuidance } from "./chat-communication-guidance.js";
import { assertChatTaskCreationAccess, resolveChatExecutionDefaults } from "./chat-execution-defaults.js";

import { githubAutomaticAdmission } from "./chat-github-events.js";
import type { GitHubReviewEventContext, GitHubIssueEventContext, GitHubReviewPolicy } from "@paperclipai/shared";

import { resumeExternalConversation } from "./slack-conversation-state.js";

import { runtimeCanonicalOrigin } from "./cloud-runtime-identity.js";

import { photonReplyReference } from "./photon/adapter.js";

import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import {
  recordChatWebhookReceipt,
  recordChatWebhookStage,
} from "./chat-webhook-diagnostics.js";
import {
  readChatControlChronology,
} from "./chat-control-chronology.js";

import type { Db } from "@paperclipai/db";

import { agentWakeupRequests, agents, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatMessageLinks, chatPublications, chatTeamsFileTransfers, companyMemberships, heartbeatRuns, issueComments, issueThreadInteractions, issues, toolConnections } from "@paperclipai/db";
import type { ChatEventKind, ChatEndpointSetupState, ChatProvider, ExternalChannelBindingSummary, SafeChatPublicationPayload, ToolCredentialSecretRef } from "@paperclipai/shared";
import {
  isUuidLike,
  LOW_TRUST_REVIEW_PRESET,
} from "@paperclipai/shared";

import {
  type TeamsFileTransferOptions,
} from "./chat-teams-file-transfers.js";

import { parseChatWebhookPublicBaseUrl } from "../chat-webhook-public-url.js";

import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { redactSensitiveText } from "../redaction.js";
import type { StorageService } from "../storage/types.js";
import {
  type ChatSdkCallbackEvent,
  type ChatSdkMessageCallbackEvent,
  type ChatSdkProvider,
  type ChatSdkRuntime,
  type DiscordGatewayCallbackEvent,
} from "./chat-sdk-runtime.js";

import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import { type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";
import {
  NativeChatReviewPresentationContentionError,
} from "./native-runtime/native-chat-review-presentation.js";
import { isExternalChatWaitAuthorizationContention } from "./native-runtime/chat-attachment-reuse.js";
import { projectSafeChatPublication } from "./chat-publication-projection.js";

import {
  githubAttachmentLimitOmissions,
} from "./chat-github-attachments.js";
import { getExternalChannelBindingSummary } from "./chat-channel-binding.js";



import {
  parseChatProviderLifecycle,
  type ChatProviderLifecycleEffect,
} from "./chat-provider-lifecycle.js";

import { parseInboundWakePublicationKey } from "./chat-inbound-wakeup-publications.js";

import {
  questionResponseDeliveryService,
  type QuestionResponseDeliveryServiceOptions,
} from "./question-response-delivery.js";

import { secretService } from "./secrets.js";
import type {
  Message,
  SlashCommandEvent,
  Thread,
} from "chat";

const REQUIRED_CREDENTIALS: Record<
  Exclude<ChatProvider, "github">,
  readonly string[]
> = {
  speko: ["apiKey", "signingSecret", "agentId"],
  "imessage-photon": ["projectSecret"],
  agentmail: [],
  slack: ["botToken", "signingSecret"],
  discord: ["botToken", "applicationId", "guildId"],
  "microsoft-teams": ["clientId", "tenantId", "clientSecret"],
  telegram: ["botToken"],
};

const SUPPORTED_GITHUB_WEBHOOK_EVENTS = new Set<string>([
  "issues",
  "pull_request",
  "pull_request_review",
  "ping",
  ...REQUIRED_GITHUB_EVENTS,
  ...UNAVOIDABLE_GITHUB_EVENTS,
]);

const SUPPLIED_CREDENTIAL_KEYS: Record<ChatProvider, readonly string[]> = {
  speko: ["apiKey", "signingSecret", "agentId"],
  "imessage-photon": ["projectSecret"],
  agentmail: [],
  slack: ["botToken", "signingSecret"],
  github: ["appId", "privateKey"],
  discord: ["botToken", "applicationId", "guildId"],
  "microsoft-teams": ["clientId", "tenantId", "clientSecret"],
  telegram: ["botToken"],
};

const MAX_ERROR_TEXT = 2_000;
// A Discord root mention is durably staged before the adapter creates its
// provider thread. Give the bounded provider retry loop ample time to finish;
// if the process disappears, the delivery worker verifies that thread over
// Discord's read-only API before it permits any Paperclip task mutation.
const DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS = 5 * 60_000;
const DELIVERY_LEASE_TTL_MS = 90_000;
const DELIVERY_DRAIN_LIMIT = 100;
const ORPHAN_FOLLOW_UP_GRACE_MS = 5_000;
const ORPHAN_FOLLOW_UP_MAX_ATTEMPTS = 12;
const PUBLICATION_ENDPOINT_CONCURRENCY = 4;

function leasedChatProvider(provider: string): boolean { return provider === "discord" || provider === "imessage-photon"; }

const DISCORD_GATEWAY_LEASE_POLL_MS = 100;
const PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS = 25_000;
const GITHUB_WEBHOOK_RESPONSE_BUDGET_MS = 8_000;
const CONFIRMATION_WAKEUP_RETRY_BACKOFF_MS = 30_000;
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
type ResourceRow = typeof chatEndpointResources.$inferSelect;

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

export interface ChatChannelServiceOptions {
  /**
   * Provider webhooks await only the durable ingress write, then finish task
   * processing outside the provider response budget. Tests may leave this off
   * when they need direct callback assertions.
   */
  deferWebhookProcessing?: boolean;
  /** Derived from instance deployment mode, never a provider request. */
  allowLocalVoiceBoard?: boolean;
  /** Test override for GitHub's end-to-end webhook response budget. */
  githubWebhookResponseBudgetMs?: number;
  /** Testable boundary after reading a GitHub webhook and before authentication. */
  githubWebhookAuthenticationBarrier?: () => Promise<void>;
  /** Testable boundary before a durable GitHub receipt re-enters provider handling. */
  githubWebhookReplayBarrier?: () => Promise<void>;
  /** Test override for the credential-mutation lease renewal cadence. */
  credentialMutationLeaseRenewalIntervalMs?: number;
  /** Narrow fault-injection boundary for credential-lease ownership checks. */
  renewCredentialMutationLease?: (input: {
    companyId: string;
    endpointId: string;
    expiresAt: Date;
    leaseKey: string;
    token: string;
  }) => Promise<boolean>;
  fetch?: typeof globalThis.fetch;
  /** Test-only private upload transport; production retains guarded egress. */
  teamsFileUploadRequest?: TeamsFileTransferOptions["uploadRequest"];
  heartbeat: IssueAssignmentWakeupDeps & {
    cancelRun?: (
      runId: string,
      reason?: string,
      options?: {
        errorCode?: string;
        eventMessage?: string;
        eventPayload?: Record<string, unknown>;
        resultJson?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
  };
  /** Production bridge for resuming a native run that owns the question. */
  resolveNativeQuestion?: QuestionResponseDeliveryServiceOptions["resolveNativeQuestion"];
  publicBaseUrl?: string | null;
  /** Canonical loopback browser return for Cloud-assisted GitHub registration. */
  githubWizardOrigin?: string | null;
  /** Optional verified ingress origin; never used for board or identity links. */
  webhookPublicBaseUrl?: string | null;
  runtime?: ChatSdkRuntime | ChatRuntime;
  /** Testable scheduler hook; its callback settles after the tracked work finishes. */
  scheduleDeferredWork?: (task: () => void | Promise<void>) => void;
  /** Test boundary after selecting due Slack status work and before claiming. */
  slackSessionSyncSelectionBarrier?: () => Promise<void>;
  /** Narrow fault-injection boundary for the one-time setup-secret audit. */
  setupSecretActivityLogger?: typeof logActivity;
  /** Testable barrier after fail-closed state and before secret-ref mutation. */
  setupSecretCredentialPersistBarrier?: () => Promise<void>;
  /** Testable boundary immediately before setup-secret's final lease check. */
  setupSecretFinalOwnershipBarrier?: () => Promise<void>;
  /** Testable boundary after setup qualification and before activation. */
  setupTestActivationBarrier?: () => Promise<void>;
  /** Testable boundary after identity preflight and before its database claim. */
  nativeBotIdentityClaimBarrier?: () => Promise<void>;
  /** Testable crash boundary after interaction commit and before chat settlement. */
  confirmationResolutionPersistBarrier?: () => Promise<void>;
  /** Testable boundary after a question callback claim and before resolution. */
  questionResolutionPersistBarrier?: () => Promise<void>;
  /** Testable boundary before the final question-form opener authorization fence. */
  questionFormOpenAuthorizationBarrier?: () => Promise<void>;
  /** Testable boundary immediately before the final inbound reach row lock. */
  reachAuthorizationBarrier?: () => Promise<void>;
  /** Testable boundary after receipt-reaction durability and before transport. */
  receiptReactionTransportBarrier?: () => Promise<void>;
  /** Testable boundary between the first reaction-link and streaming lookups. */
  reactionLinkPreflightBarrier?: () => Promise<void>;
  /** Testable boundary after replay locks its endpoint and before conversation. */
  reactionReplayEndpointLockBarrier?: () => Promise<void>;
  /** Testable boundary after replay locks its conversation. */
  reactionReplayConversationLockBarrier?: () => Promise<void>;
  /** Narrow fault-injection boundary before durable publication preparation. */
  publicationTransportPreparationBarrier?: (input: {
    publicationId: string;
  }) => Promise<void>;
  /** Test override for the conversation-delivery lease renewal cadence. */
  conversationLeaseRenewalIntervalMs?: number;
  /** Narrow fault-injection boundary for renewing a conversation lease. */
  renewConversationDeliveryLease?: (input: {
    endpointId: string;
    leaseKey: string;
    token: string;
    expiresAt: Date;
  }) => Promise<boolean>;
  /** Test override for Discord Gateway leader-lease expiry. */
  discordGatewayLeaseTtlMs?: number;
  /** Test override for Discord Gateway leader-lease renewal cadence. */
  discordGatewayLeaseRenewalIntervalMs?: number;
  /** Test override for lifecycle handoff while another replica is stopping. */
  discordGatewayLeaseWaitMs?: number;
  /** Narrow fault-injection boundary before renewing a Discord Gateway lease. */
  renewDiscordGatewayLease?: (input: {
    companyId: string;
    credentialFingerprint: string;
    endpointId: string;
    expiresAt: Date;
    generation: number;
    leaseKey: string;
    token: string;
  }) => Promise<boolean>;
  /** Testable barrier inside the serialized Discord Gateway event drain. */
  discordGatewayEventBarrier?: (
    event: DiscordGatewayCallbackEvent,
  ) => Promise<void>;
  /** Testable boundary after initial Gateway ownership and before admission. */
  discordGatewayMessageAdmissionBarrier?: () => Promise<void>;
  /** Testable barrier before the credential-leased Discord root creation. */
  discordRootThreadTransportBarrier?: () => Promise<void>;
  /** Testable boundary after a Slack task-admission worker claims its attempt. */
  slackTaskAdmissionClaimBarrier?: (input: {
    actionId: string;
    claimId: string;
  }) => Promise<void>;
  renderSlackAvatar?: (request: AgentAvatarRequest) => Promise<Buffer>;
  slackManaged?: import("./connectors/slack/setup/registration.js").SlackSetupOptions["managed"];
  storage?: StorageService;
}

function safeTitle(text: string, fallback: string): string {
  const line = stripSlackTitleMentions(text)
    .replace(/@[\w.-]+(?:\[bot\])?/gi, "")
    .trim()
    .split(/\r?\n/)[0];
  return (line || fallback).slice(0, 160);
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

export function chatChannelService(db: Db, options: ChatChannelServiceOptions) {
  const runtime = options.runtime ?? createChatRuntime();
  const githubManualMessages = new WeakMap<object, { policy: GitHubReviewPolicy; revision: number; event: "mention" | "comment" }>();
  const githubAutomaticMessages = new WeakMap<object, { context: GitHubReviewEventContext; revision: number; policy: GitHubReviewPolicy }>();
  const githubIssueMessages = new WeakMap<object, { context: GitHubIssueEventContext; revision: number; policy: GitHubReviewPolicy }>();
  const runtimeVersions = new Map<string, string>();
  const runtimeLocalEpochs = new Map<string, number>();
  // One bounded publication lane per endpoint; credential/reconnect fencing
  // still serializes a bot's sends while unrelated bots can make progress.
  const publicationEndpointTasks = new Map<string, Promise<void>>();
  // Scheduling-only cooldown for rejected/contended staged work. Do not alter
  // an unverified transfer or its publication merely because a worker saw it.
  const teamsFileRetryAfter = new Map<string, number>();
  const runtimeContexts = new WeakMap<object, RuntimeContext>();
  const runtimeInitializations = new Map<
    string,
    {
      discordGatewayOwned: boolean;
      promise: Promise<ChatEndpointRuntime>;
      version: string;
    }
  >();
  const { recordCurrentMicrosoftTeamsRoute } = createTeamsRoutes(db, { runtime, runtimeCallbackEndpoint });
  const persistence = createChatSdkStatePersistence(db);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const { inspectPhotonCredentials, verifyPhotonCredentials } = createPhotonCredentialChecks(fetchImpl);
  const { hydrateSlackResourceLabel } = createSlackInventory(db, { endpointRecord, resolveCredentials: (...args) => resolveCredentials(...args), fetchImpl });
  const configuredPublicBaseUrl = absoluteBaseUrl(options.publicBaseUrl);
  const configuredWebhookPublicBaseUrl = parseChatWebhookPublicBaseUrl(options.webhookPublicBaseUrl);
  // A warm Cloud instance is constructed before it receives its signed claim.
  // Resolve its live identity when producing URLs, not once at service startup.
  // An explicit webhook ingress remains separate from board/identity links.
  const getPublicBaseUrl = () => runtimeCanonicalOrigin() ?? configuredPublicBaseUrl;
  const { listPrincipals, createLinkIntent, previewIdentityLink, requestIdentityAccess, confirmIdentityLink, revokeLink } = createChatIdentityLinks(db, {
    endpointRecord, getPublicBaseUrl, stageProviderEffect: (...args) => stageProviderEffect(...args), scheduleProviderEffect,
    confirmationRuntimeFor: async (endpoint) => runtimeContexts.get((await runtimeFor(endpoint)) as object),
  });
  // Task links must validate the original configured URL before normalization
  // can remove credentials or other evidence that makes it unsafe to publish.
  const getTaskBaseUrl = () => runtimeCanonicalOrigin() ?? options.publicBaseUrl;
  const getWebhookPublicBaseUrl = () => configuredWebhookPublicBaseUrl ?? getPublicBaseUrl();
  const voiceStore = voiceSessionStore(db, { allowLocalBoard: options.allowLocalVoiceBoard === true });
  const { findAuthorizedIdentityLink, ensurePrincipal, sponsorAllowsGuest, lockCurrentPrincipalAuthorization, requireCurrentExternalActionAuthorization, isExternalActionAuthorizationChange, ensureResource } = createChatInboundAuthority(db, { voiceStore, runtimeCallbackEndpoint });
  const voice = createSpekoChannelService(db, { endpointRecord, resolveCredentialRefs: (...args) => resolveCredentialRefs(...args), fetchImpl,
    allowLocalBoard: options.allowLocalVoiceBoard === true,
    onQuestionAnswered: (interactionId) => scheduleMessageProcessing(async () => {
      await questionResponses.deliver(interactionId);
      await processPendingPublications();
    }),
  });
  const issuesSvc = issueService(db);
  const { runIdFromMilestonePublication, runOwnershipMilestoneSupersessionReason, runPublicationToReplace, receiptReactionCompletionRunId, inboundWakePublicationToReplace, interactionResolutionPublicationToReplace, interactionPromptPublicationToReplace, progressSupersededByFastResponse, runProgressSupersededByPublishedInteraction, taskStatusPublicationToReplace, closeProgressToReplace } = createChatPublicationReplacement(db, { endpointRecord, authorizeRetainedChatSourcePublication });
  const secrets = secretService(db);
  const { normalizedCredentials, verifyCredentials, nativeBotIdentityMatches, legacyGitHubLabelsMatchVerifiedCredentials, assertNativeBotIdentityAvailable, isNativeBotIdentityUniqueViolation, nativeBotIdentityConflict, persistCredentials, clearCredentials, resolveCredentialRefs, resolveCredentials, prepareProviderInventory } = createChatCredentials(db, {
    secrets, PROVIDER_LABELS, REQUIRED_CREDENTIALS, PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS,
    fetchImpl, redactError, credentialFingerprint, verifyPhotonCredentials,
  });
  const { inspectPhoton } = createPhotonSetupInspection(db, { endpointRecord, inspectPhotonCredentials });
  const questionResponses = questionResponseDeliveryService(db, {
    heartbeat:
      options.heartbeat as QuestionResponseDeliveryServiceOptions["heartbeat"],
    resolveNativeQuestion: options.resolveNativeQuestion,
  });
  const backgroundMessageTasks = new Set<Promise<void>>();
  const scheduledConversationDrains = new Map<string, number>();
  const liveInboundMessages = new Map<string, LiveInboundMessage>();
  const discordGatewayOwnerships = new Map<string, DiscordGatewayOwnership>();
  const discordGatewayStopTasks = new Set<Promise<void>>();
  let shuttingDown = false;
  const { discordGatewayNotOwnedError, isDiscordGatewayNotOwnedError, releaseDiscordGatewayLeaseRow, stopDiscordGatewayOwnership, renewDiscordGatewayOwnershipForMessageAdmission, ensureDiscordGatewayRuntimeIsCurrent, acquireDiscordGatewayOwnership, discordGatewayRuntimeIsCurrent } = createChatReceiverOwnership(db, { runtime, runtimeVersions, runtimeCallbackEndpoint, redactError, leasedChatProvider, discordGatewayOwnerships, discordGatewayStopTasks, isShuttingDown: () => shuttingDown, get discordGatewayLeaseTtlMs() { return options.discordGatewayLeaseTtlMs; }, get discordGatewayLeaseRenewalIntervalMs() { return options.discordGatewayLeaseRenewalIntervalMs; }, get discordGatewayLeaseWaitMs() { return options.discordGatewayLeaseWaitMs; }, get renewDiscordGatewayLease() { return options.renewDiscordGatewayLease; } });
  const { receiveSdkMessages } = createChatSdkMessageReceiver({
    endpointRecord, processMessage,
    ingressOnly: (provider) => provider === "imessage-photon"
      ? PHOTON_MESSAGE_INGRESS_ONLY
      : options.deferWebhookProcessing === true,
  });

  function localRuntimeEpoch(endpointId: string): number {
    return runtimeLocalEpochs.get(endpointId) ?? 0;
  }

  function runtimeContextForRecord(
    record: Pick<NonNullable<Awaited<ReturnType<typeof endpointRecord>>>, "endpoint" | "credentialSecretRefs">,
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
    discardPhotonInboundMessages(liveInboundMessages, () => runtime.get(endpointId));
    runtimeLocalEpochs.set(endpointId, localRuntimeEpoch(endpointId) + 1);
    runtimeVersions.delete(endpointId);
    const discordOwnership = discordGatewayOwnerships.get(endpointId);
    if (discordOwnership) {
      const hadRuntime = runtime.get(endpointId) !== null;
      await stopDiscordGatewayOwnership(discordOwnership);
      return hadRuntime;
    }
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
      return pending;
    });
  }

  function conversationDrainKey(endpointId: string, threadId: string) {
    return `${endpointId}:${createHash("sha256").update(durableExternalThreadIdentity(threadId)).digest("hex")}`;
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
        connectionHealthStatus: toolConnections.healthStatus,
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
    await notifyChatPublicationWork(tx);
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

  function scheduleProviderEffect(
    actionId: string,
    liveTarget?: ProviderEffectTarget,
  ) {
    scheduleMessageProcessing(async () => {
      await processProviderEffect(actionId, liveTarget);
    });
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
      // check. FOR UPDATE can self-deadlock an SDK-state write performed by a
      // provider callback on another pooled connection.
      .for("no key update")
      .then((rows) => rows[0] ?? null);
    if (
      !endpoint ||
      !allowedStatuses.includes(endpoint.status) ||
      runtimeGeneration(endpoint.setup) !== context.generation
    )
      return null;
    const connection = await tx
      .select({ refs: toolConnections.credentialSecretRefs, healthStatus: toolConnections.healthStatus })
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, endpoint.companyId),
          eq(toolConnections.id, endpoint.connectionId),
        ),
      )
      .then((rows) => rows[0]);
    if (
      (leasedChatProvider(endpoint.provider) && endpoint.status === "attention" && connection?.healthStatus === "failed") ||
      credentialFingerprint(connection?.refs ?? []) !== context.credentialFingerprint
    ) {
      return null;
    }
    const runtimeContext = context as RuntimeContext;
    if (
      leasedChatProvider(endpoint.provider) &&
      runtimeContext.discordGatewayOwned === true &&
      runtimeContext.endpointRuntime !== undefined &&
      !discordGatewayRuntimeIsCurrent(endpointId, runtimeContext)
    ) {
      return null;
    }
    return endpoint;
  }

  async function runtimeCallbackRecord(
    endpointId: string,
    context: RuntimeContext,
    allowedStatuses: EndpointRow["status"][],
  ) {
    const record = await endpointRecord(endpointId);
    if (
      record && leasedChatProvider(record.endpoint.provider) &&
      !(await ensureDiscordGatewayRuntimeIsCurrent(endpointId, context))
    ) {
      return null;
    }
    return record &&
      !(leasedChatProvider(record.endpoint.provider) && record.endpoint.status === "attention" && record.connectionHealthStatus === "failed") &&
      allowedStatuses.includes(record.endpoint.status) &&
      runtimeGeneration(record.endpoint.setup) === context.generation &&
      credentialFingerprint(record.credentialSecretRefs) ===
        context.credentialFingerprint &&
      runtime.get(endpointId) === context.endpointRuntime &&
      (!leasedChatProvider(record.endpoint.provider) ||
        discordGatewayRuntimeIsCurrent(endpointId, context))
      ? record
      : null;
  }

  const withCredentialMutationLease = chatCredentialMutationLease(db, options);
  const { list, get, create, update } = createChatEndpoints(db, {
    endpointRecord, CAPABILITIES, PROVIDER_LABELS, withCredentialMutationLease,
    getPublicBaseUrl, getWebhookPublicBaseUrl,
    get slackRegistration() { return slackRegistration; },
  });
  const { generateSetupSecret } = createGitHubSetupSecret(db, {
    endpointRecord, withCredentialMutationLease, resolveCredentials, persistCredentials,
    runtimeGeneration, credentialFingerprint, invalidateRuntime, redactError,
    get setupSecretActivityLogger() { return options.setupSecretActivityLogger; },
    get setupSecretCredentialPersistBarrier() { return options.setupSecretCredentialPersistBarrier; },
    get setupSecretFinalOwnershipBarrier() { return options.setupSecretFinalOwnershipBarrier; },
  });
  const { setupTestStatus, test } = createSetupProbes(db, { endpointRecord, withCredentialMutationLease, fetchImpl, findAuthorizedIdentityLink, runtimeGeneration, lockCurrentPrincipalAuthorization, get, setupTestActivationBarrier: () => options.setupTestActivationBarrier?.() ?? Promise.resolve() });
  const { listConversations, listActivity, listActivityPage } = createChatActivity(db, { endpointRecord, teamsTransferProtocol: (...args) => teamsTransferProtocol(...args) });
  const { lockTelegramCallbackNoticeAuthority } = createTelegramCallbackNoticeAuthority({ nonDirectDestinationAllowed, lockCurrentPrincipalAuthorization });
  const { stageProviderEffect, processProviderEffect, processPendingProviderEffects } = createProviderEffects(db, { endpointRecord, runtimeCallbackEndpoint, withCredentialMutationLease, runtimeFor, invalidateRuntime, lockCurrentPrincipalAuthorization, redactError, MAX_ERROR_TEXT, nonDirectDestinationAllowed, lockTelegramCallbackNoticeAuthority });
  const { publicationFiles } = createOutboundAttachments(db, { get storage() { return options.storage; } });
  const { authorizeInboundWakeup, authorizeInboundWorkStart, authorizeFastResponse } = createInboundWakeAuthority(db, { runtimeCallbackEndpoint, lockCurrentPrincipalAuthorization });
  const { ingestAttachments, attachmentOmissionDetail } = createInboundAttachments(db, { authorizeInboundWakeup, lifecycleRuntimeFence, sanitizeFilename, issuesSvc, isExternalActionAuthorizationChange, redactError, get storage() { return options.storage; } });
  const { stageInboundWakeup, acceptInboundWakeup, settleRejectedInboundWakeups, processInboundWakeup } = createInboundWakeups(db, { authorizeInboundWakeup, authorizeInboundWorkStart, attachmentOmissionDetail, isExternalActionAuthorizationChange, redactError, fetchImpl, get heartbeat() { return options.heartbeat; } });
  const { settleTelegramAttachmentOnlyFailure } = createTelegramAttachmentFailure(db, {
    attachmentOmissionDetail, runtimeContextForRecord, endpointRecord, stageProviderEffect, scheduleProviderEffect,
  });
  const { handleReaction, processPendingReactionDeliveries } = createInboundReactions(db, { lockCurrentPrincipalAuthorization, runtimeCallbackRecord, runtimeCallbackEndpoint, ensurePrincipal, durableExternalThreadIdentity, recordCurrentMicrosoftTeamsRoute, lifecycleRuntimeFence, deliveryReady, redactError, nonDirectDestinationAllowed, reactionLinkPreflightBarrier: () => options.reactionLinkPreflightBarrier?.() ?? Promise.resolve(), reactionReplayEndpointLockBarrier: () => options.reactionReplayEndpointLockBarrier?.() ?? Promise.resolve(), reactionReplayConversationLockBarrier: () => options.reactionReplayConversationLockBarrier?.() ?? Promise.resolve() });
  const { stageReceiptReaction, addReceiptReaction, processReceiptReaction, processPendingReceiptReactions } = createReceiptReactions(db, { endpointRecord, runtimeContextForRecord, withCredentialMutationLease, runtimeFor, fetchImpl, runtime, runtimeGeneration, credentialFingerprint, redactError, MAX_ERROR_TEXT, receiptReactionTransportBarrier: () => options.receiptReactionTransportBarrier?.() ?? Promise.resolve() });
  const { admitDiscordRootMention, discordRootThreadPending, reconcileDiscordRootThread, promoteDiscordRootReceipt } = createDiscordRootThreads(db, { ensureDiscordGatewayRuntimeIsCurrent, withCredentialMutationLease, runtimeCallbackEndpoint, lockCurrentPrincipalAuthorization, processMessage, redactError, scheduleConversationDrain, lifecycleRuntimeFence, runtimeFor, DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS, discordRootThreadTransportBarrier: () => options.discordRootThreadTransportBarrier?.() ?? Promise.resolve() });
  const { handleDiscordGatewayEvent } = createDiscordGatewayEvents(db, { ensureDiscordGatewayRuntimeIsCurrent, discordGatewayRuntimeIsCurrent, runtimeCallbackRecord, runtimeCallbackEndpoint, applyProviderLifecycleEffect, runtimeGeneration, discordGatewayEventBarrier: (event) => options.discordGatewayEventBarrier?.(event) ?? Promise.resolve() });
  const { handlePhotonFailure, handlePhotonEvent } = createPhotonEvents(db, { runtimeCallbackRecord, runtimeCallbackEndpoint, invalidateRuntime, ensurePrincipal, requireCurrentExternalActionAuthorization, isExternalActionAuthorizationChange, scheduleMessageProcessing, processPendingPublications, questionResponses, redactError, renewDiscordGatewayOwnershipForMessageAdmission, handleSdkMessage });
  const { handleTelegramGenerationStopped, reserveTelegramPublicationDraft } = createTelegramPublicationDrafts(db, { runtimeCallbackRecord, runtimeCallbackEndpoint, runtimeFor, runtime, runtimeContexts, credentialFingerprint, authorizeRetainedChatSourcePublication });
  const { recordSlackFileUploadReceipt, stageSlackFilePublicationSuccess, processPendingSlackFileUploadReceipts, nextSlackReceiptAt } = createSlackFileReceipts(db, { endpointRecord, withCredentialMutationLease, runtimeCallbackEndpoint, nonDirectDestinationAllowed, runtimeFor, isExplicitOperatorPublication, recordExactOutboundPublicationLink });
  const { processPendingSlackSessionSyncs } = createSlackSessionStatus(db, { endpointRecord, withCredentialMutationLease, runtimeCallbackEndpoint, nonDirectDestinationAllowed, runIdFromMilestonePublication, resolveCredentials, fetchImpl, redactError, get slackSessionSyncSelectionBarrier() { return options.slackSessionSyncSelectionBarrier; } });
  const { reconcileDiscordCommands, handleDiscordNativeCommand } = createDiscordCommands(db, { endpointRecord, runtimeContextForRecord, runtimeGeneration, credentialFingerprint, resolveCredentialRefs, fetchImpl, withCredentialMutationLease, runtimeCallbackRecord, ensurePrincipal, runtimeCallbackEndpoint, nonDirectDestinationAllowed, lockCurrentPrincipalAuthorization, getDiscordGatewayOwnership: (endpointId) => discordGatewayOwnerships.get(endpointId), discordGatewayRuntimeIsCurrent, stageAuthorizedTaskControlPublication, scheduleMessageProcessing, processPendingPublications });
  const { latestSlackDmControlThreadId, finalizeSlackTaskStartFailure, admitConfirmedSlackTaskStart, processSlackTaskStart, processPendingSlackTaskStarts } = createSlackTaskStart(db, { endpointRecord, runtimeGeneration, credentialFingerprint, invalidateRuntime, runtimeFor, processMessage, runtimeContextForRecord, redactError, withCredentialMutationLease, sponsorAllowsGuest, nonDirectDestinationAllowed, runtimeCallbackEndpoint, lockCurrentPrincipalAuthorization, get slackTaskAdmissionClaimBarrier() { return options.slackTaskAdmissionClaimBarrier; }, maxErrorText: MAX_ERROR_TEXT });
  const { resolveSlackTaskStart } = createSlackTaskStartResolution(db, { endpointRecord, withCredentialMutationLease, runtimeFor, runtimeContextForRecord, runtimeCallbackEndpoint, lockCurrentPrincipalAuthorization, sponsorAllowsGuest, nonDirectDestinationAllowed, finalizeSlackTaskStartFailure, admitConfirmedSlackTaskStart, get deferWebhookProcessing() { return options.deferWebhookProcessing; } });
  const { processPendingSlackBoardMessages } = createSlackBoardMessages(db, { endpointRecord, resolveCredentials, fetchImpl, get heartbeat() { return options.heartbeat; } });
  const { handleSlackSlashCommand } = createSlackCommands(db, {
    runtime, runtimeFor, handleSdkMessage, stageProviderEffect, scheduleProviderEffect, ensurePrincipal,
    runtimeCallbackEndpoint, getPublicBaseUrl, canonicalProviderResourceId, nonDirectDestinationAllowed,
    sponsorAllowsGuest, latestSlackDmControlThreadId, scheduleMessageProcessing, processSlackTaskStart,
    get deferWebhookProcessing() { return options.deferWebhookProcessing; },
  });
  const { handleTelegramSlashCommand } = createTelegramCommands({ runtime, runtimeFor, handleSdkMessage });
  const { stageGitHubWebhookIngress, githubIngressAcceptedResponse, processGitHubWebhookIngress, processFailedGitHubWebhookDeliveries, processPendingGitHubWebhookIngress } = createGitHubWebhookIngress(db, { endpointRecord, runtimeContextForRecord, resolveCredentialRefs, runtimeGeneration, credentialFingerprint, getWebhookPublicBaseUrl, redactError, handleWebhook, runtimeCallbackEndpoint, fetchImpl, persistence, withCredentialMutationLease, isShuttingDown: () => shuttingDown, get githubWebhookReplayBarrier() { return options.githubWebhookReplayBarrier; }, supportedWebhookEvents: SUPPORTED_GITHUB_WEBHOOK_EVENTS });
  const { stageSlackSessionStop, processSlackSessionStop, processPendingSlackSessionStops, handleSlackSessionStopPayload } = createSlackSessionStop(db, { scheduleMessageProcessing, get deferWebhookProcessing() { return options.deferWebhookProcessing; }, runtimeCallbackEndpoint, lockCurrentPrincipalAuthorization, nonDirectDestinationAllowed, stageAuthorizedTaskControlPublication, getPublicBaseUrl, get heartbeat() { return options.heartbeat; }, redactError });
  const { stageTelegramMaintenance, processTelegramMaintenance, processPendingTelegramMaintenance, processPendingTelegramActions, processTelegramSubscriptionDiscovery, scheduleTelegramSubscriptionDiscovery, hasPendingTelegramSubscriptionDiscovery, hasTelegramStopSubscription, recordTelegramStopSubscription } = createTelegramMaintenance(db, { endpointRecord, runtimeContextForRecord, withCredentialMutationLease, resolveCredentials, clearCredentials, runtimeCallbackEndpoint, getWebhookPublicBaseUrl, fetchImpl, runtimeGeneration, credentialFingerprint, redactError, credentialCheckTimeoutMs: PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS });
  const { reconcileGitHubWebhookRepository, reconcileProviderResourceRows, listResources, listGitHubRepositories, replaceResources, toggleAllGitHubRepositories, hasNewerProcessedProviderLifecycleEffect, applyProviderAvailability } = createChatResourceReconciliation(db, { endpointRecord, withCredentialMutationLease, runtimeGeneration, maxErrorText: MAX_ERROR_TEXT });
  const { applyGitHubInstallationLifecycle } = createGitHubInstallationLifecycle(db, {
    endpointRecord, resolveCredentials, runtimeCallbackEndpoint, runtimeGeneration, credentialFingerprint,
    verifyCredentials, legacyGitHubLabelsMatchVerifiedCredentials, nativeBotIdentityMatches, assertNativeBotIdentityAvailable,
    prepareProviderInventory, persistCredentials, reconcileProviderResourceRows, redactError,
    normalizedLifecycleWithRuntimeFence, MAX_ERROR_TEXT,
  });

  const { handleGitHubWebhookEvent } = createGitHubWebhookEvents(db, { processMessage, recordLifecycleDelivery: (...args) => recordLifecycleDelivery(...args), githubAutomaticMessages, githubIssueMessages, fetchImpl, runtimeCallbackEndpoint });

  const { authenticateGitHubWebhook } = createGitHubWebhookAuthentication(db, { endpointRecord, runtimeContextForRecord, withCredentialMutationLease, resolveCredentials, reconcileGitHubWebhookRepository, stageGitHubWebhookIngress, processGitHubWebhookIngress, githubIngressAcceptedResponse, scheduleMessageProcessing, backgroundMessageTasks, redactError, get githubWebhookAuthenticationBarrier() { return options.githubWebhookAuthenticationBarrier; }, get deferWebhookProcessing() { return options.deferWebhookProcessing; } });
  const { inspectSlackWebhookScope, recordSlackWebhookCallback } = createSlackWebhookCallbacks(db, { resolveCredentials, runtimeCallbackEndpoint, getWebhookPublicBaseUrl, scheduleMessageProcessing, slackRegistration: { notifyVerified: (endpointId) => slackRegistration.notifyVerified(endpointId) } });

  const { reconcileDiscordRuntime } = createDiscordRuntimeReconciliation(db, { reconcileDiscordCommands, endpointRecord, runtimeContexts, invalidateRuntime, runtimeFor, runtime, runtimeCallbackEndpoint, credentialFingerprint, discordGatewayRuntimeIsCurrent });

  async function runtimeFor(
    endpoint: EndpointRow,
    optionsForRuntime: {
      requireDiscordOwnership?: boolean;
      waitForDiscordOwnership?: boolean;
    } = {},
  ): Promise<ChatEndpointRuntime> {
    for (;;) {
      const record = await endpointRecord(endpoint.id);
      if (!record) throw notFound("Chat endpoint not found");
      if (
        record.endpoint.status === "archived" ||
        record.endpoint.status === "paused" ||
        record.endpoint.status === "draft" ||
        (leasedChatProvider(record.endpoint.provider) && record.endpoint.status === "attention" && record.connectionHealthStatus === "failed")
      ) {
        throw conflict("Chat endpoint runtime is not available in this state", {
          code: "chat_endpoint_runtime_unavailable",
        });
      }
      const context = runtimeContextForRecord(record);
      const current = runtime.get(endpoint.id);
      const currentDiscordOwnership = discordGatewayOwnerships.get(endpoint.id);
      const currentOwnsDiscordGateway =
        currentDiscordOwnership !== undefined &&
        !currentDiscordOwnership.stopping &&
        currentDiscordOwnership.context.version === context.version &&
        currentDiscordOwnership.context.endpointRuntime === current &&
        currentDiscordOwnership.expiresAt.getTime() > Date.now();
      if (
        current &&
        runtimeVersions.get(endpoint.id) === context.version &&
        (!leasedChatProvider(record.endpoint.provider) ||
          optionsForRuntime.requireDiscordOwnership !== true ||
          currentOwnsDiscordGateway)
      )
        return current;

      const pending = runtimeInitializations.get(endpoint.id);
      if (pending) {
        try {
          const instance = await pending.promise;
          if (
            pending.version === context.version &&
            (optionsForRuntime.requireDiscordOwnership !== true ||
              pending.discordGatewayOwned)
          ) {
            return instance;
          }
          if (
            pending.version === context.version &&
            optionsForRuntime.requireDiscordOwnership === true
          ) {
            await new Promise((resolve) =>
              setTimeout(resolve, DISCORD_GATEWAY_LEASE_POLL_MS),
            );
            continue;
          }
        } catch (error) {
          if (pending.version === context.version) {
            if (
              optionsForRuntime.waitForDiscordOwnership === true &&
              isDiscordGatewayNotOwnedError(error)
            ) {
              await new Promise((resolve) =>
                setTimeout(resolve, DISCORD_GATEWAY_LEASE_POLL_MS),
              );
              continue;
            }
            throw error;
          }
        }
        continue;
      }

      const initialization: {
        discordGatewayOwned: boolean;
        promise: Promise<ChatEndpointRuntime>;
        version: string;
      } = {
        discordGatewayOwned: false,
        promise: undefined as unknown as Promise<ChatEndpointRuntime>,
        version: context.version,
      };
      const promise = (async () => {
        const discordOwnership =
          leasedChatProvider(record.endpoint.provider)
            ? await acquireDiscordGatewayOwnership(
                record.endpoint,
                context,
                optionsForRuntime.waitForDiscordOwnership === true,
              )
            : null;
        if (
          leasedChatProvider(record.endpoint.provider) &&
          !discordOwnership &&
          optionsForRuntime.requireDiscordOwnership === true
        ) {
          throw discordGatewayNotOwnedError();
        }
        initialization.discordGatewayOwned = discordOwnership !== null;
        context.discordGatewayOwned = discordOwnership !== null;
        let instance: ChatEndpointRuntime | null = null;
        try {
          const stale = runtime.get(endpoint.id);
          if (stale) {
            runtimeVersions.delete(endpoint.id);
            await runtime.removeEndpoint(endpoint.id);
          }
          recordChatWebhookStage("runtime_initializing", record.endpoint.id);
          const credentials = await resolveCredentials(record.endpoint);
          await prepareDiscordRuntimeCommand(db, record.endpoint, context);
          instance = record.endpoint.provider === "speko"
            ? await replaceSpekoChannelRuntime(runtime, record, persistence)
            : await runtime.replaceEndpoint({
            companyId: record.endpoint.companyId,
            endpointId: record.endpoint.id,
            providerConfig: runtimeConfig(
              record.endpoint,
              record.endpoint.botUsername ?? record.assignedAgentName,
              credentials,
            ),
            persistence,
            concurrency: record.endpoint.concurrencyPolicy,
            enableDiscordGateway: discordOwnership !== null,
            callbacks: {
              onMessage: (event) => handleSdkMessage(event, context),
              ...createPhotonRuntimeCallbacks(db, { endpointId: endpoint.id, connectionId: endpoint.connectionId, companyId: record.endpoint.companyId, assignedAgentId: record.endpoint.assignedAgentId, context, lineId: credentials.lineId, runtimeCallbackRecord, runtimeCallbackEndpoint, renewDiscordGatewayOwnershipForMessageAdmission }),
              onPhotonEvent: (event) => handlePhotonEvent(endpoint.id, event, context),
              onPhotonFailure: (error) => handlePhotonFailure(endpoint.id, error, context),
              onDiscordRootMentionAdmission:
                record.endpoint.provider === "discord"
                  ? (event) =>
                      admitDiscordRootMention(record.endpoint, event, context)
                  : undefined,
              onDiscordGatewayEvent:
                record.endpoint.provider === "discord"
                  ? (event) => handleDiscordGatewayEvent(event, context)
                  : undefined,
              onAction:
                record.endpoint.capabilities.actions === true
                  ? (event) => handleAction(event, context)
                  : undefined,
              onModalSubmit:
                record.endpoint.capabilities.modals === true ||
                record.endpoint.provider === "discord"
                  ? (event) => handleModalSubmit(event, context)
                  : undefined,
              onMessageDeleted: (event) => handleMessageDeleted(event, context),
              onMessageUpdated: (event) => handleMessageUpdated(event, context),
              onTeamsFileConsent:
                record.endpoint.provider === "microsoft-teams"
                  ? (event) => handleTeamsFileConsent(event, context)
                  : undefined,
              onTelegramGenerationStopped:
                record.endpoint.provider === "telegram"
                  ? (event) => handleTelegramGenerationStopped(event, context)
                  : undefined,
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
              // Discord must always install the guarded private-response path:
              // an unavailable registration still needs a terminal denial for a
              // cached provider command, not the SDK's unhandled deferred reply.
              onSlashCommand:
                record.endpoint.provider === "discord" ||
                record.endpoint.capabilities.slashCommands ||
                record.endpoint.provider === "telegram"
                  ? (event) => handleSlashCommand(event, context)
                  : undefined,
            },
          });
          context.endpointRuntime = instance;
          runtimeContexts.set(instance as object, context);
          await instance.initialize();
          const latest = await endpointRecord(endpoint.id);
          const stillRegistered = runtime.get(endpoint.id) === instance;
          const stillCurrent =
            latest !== null &&
            (latest.endpoint.status === record.endpoint.status || record.endpoint.provider === "imessage-photon" && photonRuntimeStatusMayAdvance(record.endpoint, latest.endpoint)) &&
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
          if (
            discordOwnership &&
            (discordGatewayOwnerships.get(endpoint.id) !== discordOwnership ||
              discordOwnership.stopping ||
              discordOwnership.expiresAt.getTime() <= Date.now())
          ) {
            throw discordGatewayNotOwnedError();
          }
          runtimeVersions.set(endpoint.id, context.version);
          return instance;
        } catch (error) {
          if (instance && runtime.get(endpoint.id) === instance) {
            await runtime.removeEndpoint(endpoint.id).catch(() => undefined);
            runtimeVersions.delete(endpoint.id);
          } else if (!runtime.get(endpoint.id)) {
            runtimeVersions.delete(endpoint.id);
          }
          if (discordOwnership) {
            await stopDiscordGatewayOwnership(discordOwnership, false);
          }
          throw error;
        }
      })();
      initialization.promise = promise;
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

  async function reconcileProviderRuntimes() {
    if (shuttingDown) {
      return { eligible: 0, local: 0, ownedElsewhere: 0, failed: 0 };
    }
    const eligibleRows = await db
      .select({ endpointId: chatEndpoints.id })
      .from(chatEndpoints)
      .innerJoin(
        toolConnections,
        and(
          eq(toolConnections.id, chatEndpoints.connectionId),
          eq(toolConnections.companyId, chatEndpoints.companyId),
        ),
      )
      .where(
        and(
          inArray(chatEndpoints.provider, ["discord", "imessage-photon"]),
          inArray(chatEndpoints.status, ["verifying", "active", "attention"]),
          eq(toolConnections.status, "active"),
          eq(toolConnections.enabled, true),
          or(ne(chatEndpoints.status, "attention"), ne(toolConnections.healthStatus, "failed")),
        ),
      );
    const eligibleIds = new Set(eligibleRows.map((row) => row.endpointId));
    await Promise.all(
      [...discordGatewayOwnerships.values()]
        .filter((ownership) => !eligibleIds.has(ownership.endpointId))
        .map((ownership) => stopDiscordGatewayOwnership(ownership)),
    );

    let local = 0;
    let ownedElsewhere = 0;
    let failed = 0;
    for (const row of eligibleRows) {
      const record = await endpointRecord(row.endpointId);
      if (!record) continue;
      try {
        let instance = await runtimeFor(record.endpoint, {
          requireDiscordOwnership: true,
        });
        await reconcileDiscordRuntime(row.endpointId, instance);
        local += 1;
      } catch (error) {
        if (isDiscordGatewayNotOwnedError(error)) {
          ownedElsewhere += 1;
          continue;
        }
        failed += 1;
        logger.warn(
          { endpointId: row.endpointId, error: redactError(error) },
          "could not reconcile Discord Gateway runtime",
        );
      }
    }
    return {
      eligible: eligibleRows.length,
      local,
      ownedElsewhere,
      failed,
    };
  }

  const {
    retryCommentIds,
    assertFailedRetryReceipt,
    FailedChatRetryPublicationReadError,
    failedChatRetrySource,
    unregisterCommittedResponseAuthority,
    prepareFailedChatRunRetry,
    authorizeFailedChatRunRetry,
    unregisterFailedRetryAuthority,
    processFailedChatRunRetry,
    processFailedChatRunRetries,
    enqueueFailedChatRetryPublications,
    pendingFailedRetries,
  } = createChatFailedRunRetry(db, {
    authorizeInboundWakeup,
    isExternalActionAuthorizationChange,
    inboundWakeScope,
    lifecycleRuntimeFence,
    isShuttingDown: () => shuttingDown,
    wakeup: (...args) => options.heartbeat.wakeup(...args),
  });
  const { githubCurrentOmissionPreparedText, settleGitHubAutomaticPublication } = createGitHubPublicationPolicy(db, {
    isExplicitOperatorPublication, getTaskBaseUrl, failedChatRetrySource, isExternalActionAuthorizationChange,
    FailedChatRetryPublicationReadError, endpointRecord, runIdFromMilestonePublication, fetchImpl,
    stageTerminalReceiptReactionRemovals, runtimeContextForRecord, scheduleMessageProcessing, processReceiptReaction,
  });
  const { stageTeamsBoardFileIntent, deriveTeamsFileTransferAuthority } = createTeamsFileAuthority({ runtimeGeneration, credentialFingerprint, runtime, runtimeContexts, localRuntimeEpoch, runtimeVersions, lockCurrentPrincipalAuthorization, lifecycleRuntimeFence, assertFailedRetryReceipt, inboundWakeScope, failedChatRetrySource, isExplicitOperatorPublication, retryCommentIds });
  const { teamsTransferProtocol, handleTeamsFileConsent, tryProcessTeamsFilePublication, scheduleTeamsFileMaintenance } = createTeamsFileDelivery(db, {
    endpointRecord, runtimeContextForRecord, runtimeFor, runtimeContexts, localRuntimeEpoch, runtime,
    deriveTeamsFileTransferAuthority, publicationFiles, scheduleMessageProcessing, processPendingPublications,
    withCredentialMutationLease, teamsFileRetryAfter, isShuttingDown: () => shuttingDown,
    get teamsFileUploadRequest() { return options.teamsFileUploadRequest; },
  });
  const { enqueueInboundWakeupPublications, authorizeInboundWakePublication } = createInboundWakeNotices(db, { authorizeInboundWakeup, enqueueFailedChatRetryPublications, authorizeRetainedChatSourcePublication, isExternalActionAuthorizationChange, isShuttingDown: () => shuttingDown });

  async function authorizeRetainedChatSourcePublication(
    tx: DbOrTransaction,
    publication: typeof chatPublications.$inferSelect,
  ): Promise<boolean> {
    if (!(await canPublishIssueToChatAudience(tx, publication))) return false;
    if (publication.idempotencyKey.startsWith("fast-response:")) {
      const [request] = await tx.select().from(fastResponseRequests).where(and(eq(fastResponseRequests.companyId, publication.companyId), eq(fastResponseRequests.id, publication.idempotencyKey.slice("fast-response:".length))));
      if (!request || request.commentId !== publication.commentId || request.endpointId !== publication.endpointId || request.conversationId !== publication.conversationId || !(await fastResponseSourceCurrent(tx as unknown as Db, request))) return false;
      try { await fastResponseService(tx as unknown as Db).authorize(tx as unknown as Db, request); await authorizeFastResponse(tx as unknown as Db, request); return true; } catch { return false; }
    }
    const notice = parseInboundWakePublicationKey(publication.idempotencyKey);
    let runId = runIdFromMilestonePublication(publication);
    if (!runId && publication.commentId && !notice) {
      const [comment] = await tx
        .select({ runId: issueComments.createdByRunId })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.id, publication.commentId),
            eq(issueComments.companyId, publication.companyId),
          ),
        );
      runId = comment?.runId ?? null;
    }
    if (!runId && publication.payload.interactionId && !notice) {
      const [interaction] = await tx
        .select({ runId: issueThreadInteractions.sourceRunId })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(
              issueThreadInteractions.id,
              String(publication.payload.interactionId),
            ),
            eq(issueThreadInteractions.companyId, publication.companyId),
          ),
        );
      runId = interaction?.runId ?? null;
    }
    const [run] = runId
      ? await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, runId),
              eq(heartbeatRuns.companyId, publication.companyId),
            ),
          )
      : [];
    try {
      const committed = run?.resultJson?.nativeCommittedChatResponse;
      if (committed !== undefined) {
        if (
          !run ||
          !committed ||
          typeof committed !== "object" ||
          Array.isArray(committed)
        )
          return false;
        const marker = committed as Record<string, unknown>;
        if (
          marker.schema !== "paperclip.native_committed_chat_response.v1" ||
          typeof marker.resultId !== "string" ||
          !isUuidLike(marker.resultId) ||
          typeof marker.canonicalSha256 !== "string" ||
          typeof marker.decisionId !== "string" ||
          !isUuidLike(marker.decisionId)
        )
          return false;
        const source = await failedChatRetrySource(tx, {
          companyId: publication.companyId,
          issueId: publication.issueId,
          agentId: run.agentId,
          failedRunId: run.id,
          publication: true,
          committedResponse: {
            resultId: marker.resultId,
            canonicalSha256: marker.canonicalSha256,
            decisionId: marker.decisionId,
          },
        });
        if (
          source.endpointId !== publication.endpointId ||
          source.conversationId !== publication.conversationId
        )
          return false;
      }
      const actionId = notice?.wakeId ?? run?.wakeupRequestId;
      if (!actionId) return true;
      const [action] = await tx
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.id, actionId),
            eq(chatActions.companyId, publication.companyId),
          ),
        );
      if (action?.kind !== "failed_run_retry")
        return !run?.contextSnapshot?.chatFailedRunRetry;
      const source = await authorizeFailedChatRunRetry(tx, {
        companyId: publication.companyId,
        issueId: publication.issueId,
        agentId: String(action.payload.agentId),
        retryActionId: action.id,
        ...(run ? { runId: run.id } : {}),
        publication: true,
      });
      if (
        source.endpointId !== publication.endpointId ||
        source.conversationId !== publication.conversationId
      )
        return false;
      if (notice) {
        const [receipt] = await tx
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, action.id))
          .for("share", { noWait: true });
        return (
          publication.commentId === source.commentIds.at(-1) &&
          !receipt?.runId &&
          (notice.state === "queued"
            ? receipt?.status === "deferred_issue_execution"
            : notice.state === "not_started" &&
              ["cancelled", "failed", "skipped"].includes(
                receipt?.status ?? "",
              ))
        );
      }
      return (
        !!run &&
        JSON.stringify(retryCommentIds(run.contextSnapshot ?? {})) ===
          JSON.stringify(source.commentIds) &&
        run.contextSnapshot?.source === `chat:${source.provider}`
      );
    } catch (error) {
      if (
        isExternalChatWaitAuthorizationContention(error) ||
        error instanceof NativeChatReviewPresentationContentionError
      )
        throw new NativeChatReviewPresentationContentionError();
      if (
        isExternalActionAuthorizationChange(error) ||
        (error &&
          typeof error === "object" &&
          "details" in error &&
          error.details &&
          typeof error.details === "object" &&
          "code" in error.details &&
          error.details.code === "chat_failed_run_retry_not_authorized")
      )
        return false;
      throw error;
    }
  }

  async function processMessage(
    endpoint: EndpointRow,
    thread: Thread,
    message: Message,
    trigger: ChatSdkMessageCallbackEvent["trigger"],
    ingressOnly = false,
    recoveredProviderUrl: string | null = null,
    runtimeContext?: InboundRuntimeContext,
    providerUpdateId?: number,
    admittedDeliveryId: string | null = null,
    receiptReactionSupported = true,
    // Kept as a positional compatibility slot for already-normalized durable
    // deliveries. Authorization snapshots are intentionally ignored: task
    // mutation always rechecks current reach, identity link, and membership.
    _preauthorizedUserId?: string | null,
    deferDrainUntilFollowup = false,
    suppressSetupDestinationActivation = false,
    slackSlashControl = false,
  ) {
    if (endpoint.provider === "telegram" && telegramIgnoresInboundMessage(message)) return;
    if (
      message.author.isMe ||
      message.author.isBot === true ||
      message.author.isSystem
    )
      return;
    // One provider message can match both a mention handler and the catch-all
    // new-message handler. The trigger is policy metadata, not provider event
    // identity, so it must not defeat durable deduplication.
    const { githubAutomatic, githubIssue, githubManual, providerEventId, surfaceKind, addressed, eventKind, endpointRuntime, nativeInboundAttachments, unavailableTeamsReferences, providerSentAt, providerUrl, normalized, redactedDestinationNormalized } = await prepareInboundEnvelope({ endpoint, thread, message, trigger, receiptReactionSupported, recoveredProviderUrl, runtimeContext, providerUpdateId, admittedDeliveryId, suppressSetupDestinationActivation, slackSlashControl });
    const reorderWindow = INGRESS_REORDER_WINDOW_MS[endpoint.provider];
    const scheduledAt =
      ingressOnly && reorderWindow
        ? (scheduledConversationDrains.get(
            conversationDrainKey(endpoint.id, thread.id),
          ) ?? Date.now() + reorderWindow)
        : null;
    const discordGatewayAdmissionState: {
      lost?: DiscordGatewayOwnership;
      renewed?: {
        expiresAt: Date;
        ownership: DiscordGatewayOwnership;
      };
    } = {};
    const admission = await admitInboundMessage({ endpoint, thread, message, trigger, runtimeContext, admittedDeliveryId, deferDrainUntilFollowup, scheduledAt, envelope: { providerEventId, addressed, eventKind, normalized, redactedDestinationNormalized, githubAutomatic, githubIssue } }, discordGatewayAdmissionState);
    // The database token is authoritative. Publish its new expiry to the
    // process-local fast path only after the admission transaction commits.
    // Conversely, synchronously fence an obsolete local owner after a failed
    // token CAS, then stop it without awaiting the callback it may be serving.
    const renewedDiscordOwnership = discordGatewayAdmissionState.renewed;
    if (
      renewedDiscordOwnership &&
      discordGatewayOwnerships.get(endpoint.id) ===
        renewedDiscordOwnership.ownership &&
      !renewedDiscordOwnership.ownership.stopping
    ) {
      renewedDiscordOwnership.ownership.expiresAt =
        renewedDiscordOwnership.expiresAt;
    }
    const lostDiscordOwnership = discordGatewayAdmissionState.lost;
    if (
      lostDiscordOwnership &&
      discordGatewayOwnerships.get(endpoint.id) === lostDiscordOwnership
    ) {
      lostDiscordOwnership.stopping = true;
      void stopDiscordGatewayOwnership(lostDiscordOwnership);
    }
    if (!admittedDeliveryId && admission?.candidate) {
      recordChatWebhookReceipt(
        endpoint.id,
        admission.candidate.id,
        "message_delivery",
        providerSentAt,
      );
    }
    if (admission?.accepting) {
      // Persist the latest authenticated Teams reply route under a fresh
      // runtime/credential fence. The helper holds the endpoint's NO KEY
      // UPDATE lock through the SDK-state write, so reconnect, pause, and
      // credential rotation cannot overtake it while the state table's
      // foreign-key check remains deadlock-free. A failed write escapes so
      // Teams retries the already-idempotent delivery.
      await recordCurrentMicrosoftTeamsRoute(
        endpoint,
        runtimeContext,
        thread.id,
        message.raw,
      );
    }
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
      const promoted = await promoteDiscordRootReceipt(candidate.id, scheduledAt);
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
        providerUrl,
        runtimeContext,
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
    const claimed = await db.transaction(async (tx) => {
      await notifyChatDeliveryWork(tx);
      return tx
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
    });
    const activeDelivery = claimed[0];
    if (!activeDelivery) return;

    try {
      if (admission.provisionalTeamsSetupReply) {
        await deferTeamsSetupReply(db, activeDelivery, redactedDestinationNormalized, ORPHAN_FOLLOW_UP_MAX_ATTEMPTS, ORPHAN_FOLLOW_UP_GRACE_MS);
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
            conversation: chatConversations,
            issueId: chatConversations.issueId,
            resourceId: chatConversations.resourceId,
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
        if (!activeDelivery.principalId)
          throw new Error("chat_inbound_wakeup_principal_missing");
        await stageInboundWakeup(db, {
          endpoint,
          deliveryId: activeDelivery.id,
          conversation: rebound.conversation,
          commentId: inboundCommentId,
          principalId: activeDelivery.principalId,
          actorUserId: rebound.authorUserId,
        });
        // Attachment storage follows the atomic task/comment/link mutation.
        // If a later wakeup or provider subscription failed, retry from the
        // committed delivery link and fill in only files that are still
        // missing from this exact inbound comment.
        const attachmentResult = await ingestAttachments({
          endpoint,
          endpointRuntime,
          deliveryId: activeDelivery.id,
          issueId: rebound.issueId,
          issueCommentId: inboundCommentId,
          attachments: nativeInboundAttachments,
          attachmentLimitOmissions: githubAttachmentLimitOmissions(message),
          unavailableReferenceCount: unavailableTeamsReferences,
          actorUserId: rebound.authorUserId,
        });
        if (
          await settleTelegramAttachmentOnlyFailure({
            activeDelivery,
            attachmentResult,
            commentId: inboundCommentId,
            conversationId: existingMessageLink.conversationId,
            endpoint,
            message,
            principalId: activeDelivery.principalId,
            resourceId: rebound.resourceId,
            runtimeContext,
            thread,
          })
        ) {
          return;
        }
        // Subscription is part of the durable acceptance boundary. If it
        // fails, keep the delivery retryable; the committed message link makes
        // the retry resume here without duplicating the task or comment.
        if (addressed && !thread.isDM) await thread.subscribe();
        await acceptInboundWakeup(activeDelivery.id, attachmentResult);
        if (!(await processInboundWakeup(activeDelivery.id))) return;
        const acceptedWake = await db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.deliveryId, activeDelivery.id),
              eq(chatActions.kind, "inbound_wakeup"),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (acceptedWake?.status !== "processed") return;
        // Recover the visible receipt as well as the durable wake. The
        // receipt action is idempotent and resolves the current runtime fence.
        await Promise.allSettled([
          receiptReactionSupported
            ? addReceiptReaction({
                deliveryId: activeDelivery.id,
                endpoint,
                message,
                runtimeContext,
                thread,
              })
            : Promise.resolve(),
          endpoint.provider === "slack"
            ? Promise.resolve()
            : thread.startTyping("Working…"),
        ]);
        return;
      }

      const principalResolution = await ensurePrincipal(
        endpoint,
        message.author,
        message.raw,
      );
      const resourceAdmission = await admitMessageResource({ endpoint, thread, addressed, suppressSetupDestinationActivation, surfaceKind });
      const { enabledResourceCount, resource } = resourceAdmission;
      await db
        .update(chatDeliveries)
        .set({
          principalId: principalResolution.principal.id,
          updatedAt: new Date(),
        })
        .where(eq(chatDeliveries.id, activeDelivery.id));

      let { conversation: existingConversation, issue: existingIssue, latestConversation, isLinear } =
        await resolveInboundConversationBinding(db, {
          endpoint, thread,
          isLinear: () => endpoint.provider === "speko" ? SPEKO_CONVERSATION_IS_LINEAR : surfaceKind !== "native_thread",
          lookupConversation: endpoint.provider === "microsoft-teams"
            ? () => conversationForThread(endpoint.id, thread.id)
            : undefined,
          conversationIsComplete: endpoint.provider === "imessage-photon"
            ? (conversationId) => photonConversationBindingIsComplete(conversationId, hasCommittedTaskControlCompletion)
            : undefined,
        });
      const telegramControls = endpoint.provider === "telegram"
        ? telegramInboundControls(message.text, surfaceKind)
        : null;
      const controlCommand = telegramControls
        ? telegramControls.controlCommand
        : isLinear ? linearControlCommand(message.text) : null;
      const guidanceCommand = telegramControls?.guidanceCommand ?? null;
      const bypassesControlChronology = telegramControls?.bypassesControlChronology ?? controlCommand === "status";
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
      // This is a second authoritative check, not a provider-name exemption.
      // Public voice authority requires an opted-in line, accepted signed call,
      // and exact call-owned task with its low-trust containment still intact.
      let publicVoiceTaskAllowed = false;
      if (endpoint.provider === "speko" && principalResolution.userId === null && !principalResolution.linkedDenied) {
        publicVoiceTaskAllowed = await authorizeSpekoPublicVoiceTask(db, endpoint, principalResolution.principal.externalId, voiceStore.authorizePrincipal);
      }
      const principalAllowed =
        !principalResolution.linkedDenied &&
        (principalResolution.userId !== null || guestSponsorAllowed || publicVoiceTaskAllowed);
      const activationAllowed = addressed || existingConversation !== null;
      const allowed =
        endpointAllowed &&
        destinationAllowed &&
        principalAllowed &&
        activationAllowed;
      const isPlausibleOrphanFollowUp =
        endpoint.provider === "github" || endpoint.provider === "discord" ||
        (endpoint.provider === "slack" && slackOrphanFollowUp(thread.id, message.id)) ||
        (endpoint.provider === "microsoft-teams" && teamsOrphanFollowUp(thread.id, message.id));
      const setupDestinationCanBeEnabledByEarlierMention =
        (endpoint.provider === "github" ||
          endpoint.provider === "discord" ||
          (endpoint.provider === "microsoft-teams" &&
            teamsRootMentionCanEnableSetupDestination(resource))) &&
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
        await db.transaction(async (tx) => {
          await notifyChatDeliveryWork(tx);
          return tx
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
        });
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
        await db.transaction(async (tx) => {
          await notifyChatDeliveryWork(tx);
          return tx
            .update(chatDeliveries)
            .set({
              state: "filtered",
              normalizedEvent: redactedDestinationNormalized,
              principalId: null,
              nextAttemptAt: null,
              redactedError: filteredReason,
              processedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(chatDeliveries.id, activeDelivery.id));
        });
        return;
      }

      const filterPreControlSource = async (database: DbOrTransaction) => {
        if (
          bypassesControlChronology ||
          (await readChatControlChronology(
            database,
            endpoint,
            thread,
            activeDelivery,
          )) !== "before_or_unproven"
        )
          return false;
        const filteredAt = new Date();
        await database
          .update(chatDeliveries)
          .set({
            state: "filtered",
            nextAttemptAt: null,
            processedAt: filteredAt,
            updatedAt: filteredAt,
            redactedError:
              "Message predates or cannot be ordered after a completed chat close/new. Send a new request to start work.",
          })
          .where(
            and(
              eq(chatDeliveries.id, activeDelivery.id),
              eq(chatDeliveries.companyId, endpoint.companyId),
              eq(chatDeliveries.state, "processing"),
            ),
          );
        return true;
      };
      if (await filterPreControlSource(db)) return;
      const photonQuote =
        endpoint.provider === "imessage-photon"
          ? photonReplyReference(message.raw)
          : null;
      if (controlCommand && photonQuote) {
        if (!(await photonControlTargetsConversation(db, endpoint, photonQuote.guid, existingConversation?.id))) {
          await db.transaction(async (tx) => {
            await notifyChatDeliveryWork(tx);
            return tx
              .update(chatDeliveries)
              .set({
                state: "filtered",
                processedAt: new Date(),
                nextAttemptAt: null,
                redactedError:
                  "Quoted control does not belong to the current task generation",
                updatedAt: new Date(),
              })
              .where(eq(chatDeliveries.id, activeDelivery.id));
          });
          return;
        }
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
        const responseText = telegramGuidanceResponse(guidanceCommand, endpoint.botUsername, assignedAgentName);
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
            await notifyChatDeliveryWork(tx);
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
        // Telegram's command reply is the acknowledgement. A control-only
        // request starts no run that could later retire a processing receipt.
        await Promise.allSettled([
          receiptReactionSupported && endpoint.provider !== "telegram"
            ? addReceiptReaction({
                deliveryId: activeDelivery.id,
                endpoint,
                message,
                runtimeContext,
                thread,
              })
            : Promise.resolve(),
          addressed && !thread.isDM ? thread.subscribe() : Promise.resolve(),
        ]);
        return;
      }

      if (controlCommand) {
        const isTelegramForumTopic = telegramControls?.isForumTopic === true;
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
                ? telegramForumControlResponse("new", taskLabel, Boolean(existingIssue), Boolean(existingConversation))
                : "Send your request to start a new Paperclip task."
              : existingConversation
                ? isTelegramForumTopic
                  ? telegramForumControlResponse("close", taskLabel, Boolean(existingIssue), true)
                  : "This chat conversation is closed. Send another message to start a new task."
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
          const staged = await db.transaction(async (tx) => {
            await tx
              .update(chatEndpoints)
              .set({ lastEventAt: new Date(), updatedAt: new Date() })
              .where(eq(chatEndpoints.id, endpoint.id));
            if (await filterPreControlSource(tx)) return false;
            await notifyChatDeliveryWork(tx);
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
            return true;
          });
          if (!staged) return;
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
        // This command stages a reply, not new agent work to acknowledge.
        await Promise.allSettled([
          receiptReactionSupported && endpoint.provider !== "telegram"
            ? addReceiptReaction({
                deliveryId: activeDelivery.id,
                endpoint,
                message,
                runtimeContext,
                thread,
              })
            : Promise.resolve(),
          addressed && !thread.isDM ? thread.subscribe() : Promise.resolve(),
        ]);
        return;
      }

      const inboundActivityPublications: ActivityPublication[] = [];
      const persistTaskMutation = async (
        taskTx: DbOrTransaction,
        taskEndpoint: EndpointRow,
        taskUserId: string | null,
      ) => {
        let conversation = existingConversation;
        if (!conversation) {
          const [taskResource] = await taskTx.select({ executionDefaults: chatEndpointResources.executionDefaults })
            .from(chatEndpointResources).where(and(eq(chatEndpointResources.id, resource.id), eq(chatEndpointResources.endpointId, taskEndpoint.id)));
          const executionDefaults = resolveChatExecutionDefaults(taskEndpoint.executionDefaults, taskResource?.executionDefaults);
          const responsibleUserId = taskUserId ?? taskEndpoint.sponsorUserId;
          await assertChatTaskCreationAccess(db, {
            companyId: taskEndpoint.companyId,
            assigneeAgentId: taskEndpoint.assignedAgentId,
            actor: responsibleUserId ? { type: "board", userId: responsibleUserId, source: "session", ignoreInstanceAdmin: true } : { type: "none" },
            defaults: executionDefaults,
          }, taskTx);
          await assertChatTaskCreationAccess(db, {
            companyId: taskEndpoint.companyId,
            assigneeAgentId: taskEndpoint.assignedAgentId,
            actor: { type: "agent", agentId: taskEndpoint.assignedAgentId, companyId: taskEndpoint.companyId, onBehalfOfUserId: responsibleUserId, source: "agent_key" },
            defaults: executionDefaults,
          }, taskTx);
          const sessionGeneration = isLinear
            ? (latestConversation?.sessionGeneration ?? 0) + 1
            : 1;
          const issue = await issuesSvc.create(
            taskEndpoint.companyId,
            {
              title: safeTitle(
                githubInboundTaskTitle(message.text, githubAutomatic, githubIssue),
                `${PROVIDER_LABELS[taskEndpoint.provider]} conversation`,
              ),
              description: `Started from ${PROVIDER_LABELS[taskEndpoint.provider]}: ${resource.label}`,
              status: "todo",
              priority: "medium",
              assigneeAgentId: taskEndpoint.assignedAgentId,
              createdByUserId: taskUserId ?? taskEndpoint.sponsorUserId,
              responsibleUserId: taskUserId ?? taskEndpoint.sponsorUserId,
              originKind: "chat_channel",
              originId: `${taskEndpoint.id}:${thread.id}:${sessionGeneration}`,
              idempotencyKey: `chat:${taskEndpoint.id}:${thread.id}:${sessionGeneration}`,
              ...(executionDefaults.projectId !== undefined ? { projectId: executionDefaults.projectId } : {}),
              ...(executionDefaults.workspace ? { workspaceSelection: executionDefaults.workspace, workspaceSelectionSource: "channel" as const } : {}),
            },
            taskTx,
          );
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
              communicationGuidance: buildChatCommunicationGuidance({
                provider: taskEndpoint.provider,
                isDirectMessage: thread.isDM,
                communicationInstructions: taskEndpoint.communicationInstructions,
              }),
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
        const githubAgentRequiresLowTrust = taskEndpoint.provider === "github" && await githubAssignedAgentRequiresLowTrust(taskTx, taskEndpoint);
        if (!taskUserId || ((githubAutomatic || githubIssue) && !principalResolution.userId) || githubAgentRequiresLowTrust) {
          await applyChatTaskReviewContainment(taskTx, endpoint, issue);
          }

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
          githubInboundCommentText({ manual: githubManual, repository: resource.providerResourceId, thread: thread.id, sender: { id: principalResolution.principal.externalId, login: principalResolution.principal.handle }, message: message.text }) ||
          (message.attachments.length > 0
            ? taskEndpoint.provider === "microsoft-teams" &&
              !thread.isDM &&
              nativeInboundAttachments.length === 0
              ? teamsAttachmentReferenceText(message.attachments.length, providerUrl)
              : `Shared ${message.attachments.length} file${message.attachments.length === 1 ? "" : "s"}.`
            : taskEndpoint.provider === "slack" && (trigger === "mention" || message.isMention === true)
              ? "Started a conversation by mentioning the agent."
              : "Sent an empty message.");
        let comment!: Awaited<ReturnType<typeof issuesSvc.addComment>>;
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
              ...(endpoint.provider === "imessage-photon"
                ? { sourceChannel: "imessage-photon" as const }
                : {}),
              sections: [
                {
                  title: `${PROVIDER_LABELS[endpoint.provider]} sender`,
                  rows: [
                    ...(endpoint.provider === "imessage-photon" ? photonReplyMetadata(message.raw) : []),
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
        if (taskEndpoint.provider === "slack" || taskEndpoint.provider === "speko") {
          await resumeExternalConversation(taskTx as unknown as Db, endpoint.companyId, conversation.issueId);
        }
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
        if (endpoint.provider === "github") {
          await retainGitHubDeliveryAuthority(taskTx, taskEndpoint, activeDelivery.id, principalResolution.userId, taskUserId);
        }
        if (githubAutomatic) {
          await retainGitHubReviewReceipt(taskTx, endpoint, issue.id, activeDelivery.id, githubAutomatic);
        }
        await stageInboundWakeup(taskTx, {
          endpoint: taskEndpoint,
          deliveryId: activeDelivery.id,
          conversation,
          commentId: comment.id,
          principalId: principalResolution.principal.id,
          actorUserId: taskUserId,
        });
        const receiptActionId = taskEndpoint.provider === "slack" && receiptReactionSupported && runtimeContext
          ? await stageReceiptReaction(taskTx, {
              deliveryId: activeDelivery.id,
              endpoint: taskEndpoint,
              threadId: thread.id,
              messageId: message.id,
              runtimeContext,
            })
          : null;
        if (taskEndpoint.provider === "imessage-photon") {
          await recordPhotonInboundActivity(taskTx, taskEndpoint, issue, comment.id, taskUserId, inboundActivityPublications);
        }
        return { actorUserId: taskUserId, comment, conversation, issue, receiptActionId };
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
        const currentPrincipalAuthorization =
          await lockCurrentPrincipalAuthorization(
            tx,
            currentEndpoint,
            principalResolution.principal.id,
          );
        const automaticContext = githubAutomatic?.context ?? githubIssue?.context;
        const automaticAdmission = automaticContext ? await githubAutomaticAdmission(tx, currentEndpoint, automaticContext) : null;
        if (automaticContext && !automaticAdmission?.allowed) currentPrincipalAuthorization.allowed = false;
        if (automaticAdmission?.allowed) currentPrincipalAuthorization.userId = automaticAdmission.responsibleUserId ?? null;
        const endpointStillAllowed =
          currentEndpoint.status === "verifying" ||
          currentEndpoint.status === "active";
        const destinationStillAllowed = thread.isDM
          ? currentEndpoint.allowDirectMessages
          : nonDirectDestinationAllowed(currentEndpoint, currentResource);
        const mentionStillAllowed =
          currentEndpoint.provider !== "slack" ||
          slackMessageMeetsMentionRequirement(currentEndpoint, thread, trigger, message);
        if (
          !endpointStillAllowed ||
          !mentionStillAllowed ||
          !destinationStillAllowed ||
          !currentPrincipalAuthorization.allowed
        ) {
          const filteredAt = new Date();
          await notifyChatDeliveryWork(tx);
          await tx
            .update(chatDeliveries)
            .set({
              state: "filtered",
              normalizedEvent: redactedDestinationNormalized,
              principalId: null,
              nextAttemptAt: null,
              processedAt: filteredAt,
              redactedError: !mentionStillAllowed
                ? "Message did not @mention the bot"
                : endpointStillAllowed
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
        // Close completion takes this endpoint lock in its receipt transaction.
        // Recheck after the lock: an old input held between precheck and task
        // mutation must not create work after that control commits.
        if (await filterPreControlSource(tx)) return null;
        return persistTaskMutation(
          tx,
          currentPrincipalAuthorization.sponsorUserId ? { ...currentEndpoint, sponsorUserId: currentPrincipalAuthorization.sponsorUserId } : currentEndpoint,
          currentPrincipalAuthorization.userId,
        );
      });
      if (!taskMutation) return;
      // Slack's eyes mean the authorized message has been durably received.
      // Dispatch immediately after commit, independently of file downloads,
      // subscriptions and scheduler admission. The durable action owns retry;
      // slow Slack I/O must not hold up the task's remaining acceptance work.
      const earlyReceiptReaction = taskMutation.receiptActionId
        ? processReceiptReaction(taskMutation.receiptActionId).catch((error) => {
            logger.warn({ error: redactError(error) }, "early chat receipt dispatch failed; durable worker will recover");
          })
        : null;
      if (earlyReceiptReaction) {
        backgroundMessageTasks.add(earlyReceiptReaction);
        void earlyReceiptReaction.finally(() => backgroundMessageTasks.delete(earlyReceiptReaction));
      }
      // The open task can fetch the comment immediately, before attachments
      // finish preparing or the agent starts. Never publish an uncommitted row.
      for (const publication of inboundActivityPublications) {
        publishActivity(publication);
      }
      const { actorUserId, comment, conversation, issue } = taskMutation;
      const attachmentResult = await ingestAttachments({
        endpoint,
        endpointRuntime,
        deliveryId: activeDelivery.id,
        issueId: conversation.issueId,
        issueCommentId: comment.id,
        attachments: nativeInboundAttachments,
        attachmentLimitOmissions: githubAttachmentLimitOmissions(message),
        unavailableReferenceCount: unavailableTeamsReferences,
        actorUserId,
      });
      if (
        await settleTelegramAttachmentOnlyFailure({
          activeDelivery,
          attachmentResult,
          commentId: comment.id,
          conversationId: conversation.id,
          endpoint,
          message,
          principalId: principalResolution.principal.id,
          resourceId: resource.id,
          runtimeContext,
          thread,
        })
      ) {
        return;
      }
      // Do not discard a subscription failure after marking the delivery
      // processed. A retry reuses the committed message link above and tries
      // this idempotent subscription again before completing the delivery.
      if (addressed && !thread.isDM) await thread.subscribe();
      await acceptInboundWakeup(activeDelivery.id, attachmentResult);
      if (!(await processInboundWakeup(activeDelivery.id))) return;
      const acceptedWake = await db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.deliveryId, activeDelivery.id),
            eq(chatActions.kind, "inbound_wakeup"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (acceptedWake?.status !== "processed") return;
      // Other providers acknowledge accepted wakeup requests here. Slack's
      // receipt was already staged with the authorized task/comment above;
      // this idempotent reconciliation also covers older recovered deliveries.
      await Promise.allSettled([
        earlyReceiptReaction ?? (receiptReactionSupported
          ? addReceiptReaction({
              deliveryId: activeDelivery.id,
              endpoint,
              message,
              runtimeContext,
              thread,
            })
          : Promise.resolve()),
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
      const terminal =
        providerEffectAmbiguous ||
        isExternalActionAuthorizationChange(error) ||
        activeDelivery.attempts >= 5;
      await db.transaction(async (tx) => {
        await notifyChatDeliveryWork(tx);
        return tx
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
      });
      if (terminal) await settleRejectedInboundWakeups(activeDelivery.id);
      throw error;
    }
  }
  async function drainConversationDeliveries(...args: Parameters<ReturnType<typeof createChatConversationDeliveryQueue>["drainConversationDeliveries"]>) {
    return conversationDeliveryQueue.drainConversationDeliveries(...args);
  }

  async function handleSdkMessage(
    event: ChatSdkMessageCallbackEvent,
    runtimeContext?: RuntimeContext,
    messageOptions: {
      receiptReactionSupported?: boolean;
      slackSlashControl?: boolean;
    } = {},
  ) {
    if (event.provider === "discord" && !(await admitDiscordSdkMessage(
      event.endpointId,
      runtimeContext,
      {
        ensureRuntimeIsCurrent: ensureDiscordGatewayRuntimeIsCurrent,
        messageAdmissionBarrier: () => options.discordGatewayMessageAdmissionBarrier?.(),
      },
    ))) return;
    return receiveSdkMessages(event, runtimeContext, messageOptions);
  }
  async function handleMessageUpdated(...args: Parameters<ReturnType<typeof createChatMessageLifecycle>["handleMessageUpdated"]>) {
    return messageLifecycle.handleMessageUpdated(...args);
  }

  async function handleMessageDeleted(...args: Parameters<ReturnType<typeof createChatMessageLifecycle>["handleMessageDeleted"]>) {
    return messageLifecycle.handleMessageDeleted(...args);
  }

  async function handleSlashCommand(
    event: ChatSdkCallbackEvent<SlashCommandEvent>,
    runtimeContext: RuntimeContext,
  ) {
    if (event.provider === "discord")
      return handleDiscordNativeCommand(event, runtimeContext);
    const record = await runtimeCallbackRecord(
      event.endpointId,
      runtimeContext,
      ["verifying", "active"],
    );
    if (!record) return;
    const command = event.event.command.toLowerCase().split("@")[0];
    const text = event.event.text.trim();
    if (event.provider === "telegram") return handleTelegramSlashCommand(event, runtimeContext, record, command, text);
    return handleSlackSlashCommand(event, runtimeContext, record, command, text);
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
    const [inserted] = await db.transaction(async (tx) => {
      await notifyChatDeliveryWork(tx);
      return tx
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
    });
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
    const [claimed] = await db.transaction(async (tx) => {
      await notifyChatDeliveryWork(tx);
      return tx
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
    });
    if (!claimed) return false;

    let refreshRuntimeAfterLifecycle = false;
    let stopRuntimeAfterFailure = false;
    let stopRuntimeAfterLifecycle = false;
    let lifecycleFailurePersisted = false;
    try {
      await withCredentialMutationLease(endpoint, async (credentialLease) => {
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
          await db.transaction(async (tx) => {
            await credentialLease.assertOwned(tx);
            await notifyChatDeliveryWork(tx);
            await tx
              .update(chatDeliveries)
              .set({
                state: "filtered",
                processedAt: filteredAt,
                nextAttemptAt: null,
                redactedError:
                  "Provider lifecycle callback belonged to a superseded runtime",
                updatedAt: filteredAt,
              })
              .where(
                and(
                  eq(chatDeliveries.id, claimed.id),
                  eq(chatDeliveries.state, "processing"),
                  eq(chatDeliveries.attempts, candidate.attempts + 1),
                ),
              );
            await credentialLease.assertOwned(tx);
          });
          return;
        }

        if (currentEndpoint.provider === "github") {
          const outcome = await applyGitHubInstallationLifecycle({
            currentEndpoint, effect, credentialLease, admittedRuntimeContext, claimed, candidate,
            onFailurePersisted: () => {
              stopRuntimeAfterFailure = true;
              lifecycleFailurePersisted = true;
            },
          });
          refreshRuntimeAfterLifecycle = outcome.refreshRuntimeAfterLifecycle;
          stopRuntimeAfterLifecycle = outcome.stopRuntimeAfterLifecycle;
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
        await applyProviderAvailability({ currentEndpoint, effect, credentialLease, staleResourceEffect, claimed, candidate });
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
        await db.transaction(async (tx) => {
          await notifyChatDeliveryWork(tx);
          return tx
            .update(chatDeliveries)
            .set({
              state: terminal ? "failed" : "retry",
              redactedError: redactError(error),
              nextAttemptAt: terminal ? null : new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatDeliveries.id, claimed.id),
                eq(chatDeliveries.state, "processing"),
                eq(chatDeliveries.attempts, candidate.attempts + 1),
              ),
            )
            .catch(() => undefined);
        });
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
      if (applied && endpoint.provider === "slack") {
        await scheduleSlackLifecycleResourceHydration(db, endpoint, effect, { scheduleMessageProcessing, hydrateSlackResourceLabel, redactError });
      }
    }
  }

  async function handleWebhook(
    publicId: string,
    provider: ChatSdkProvider,
    request: Request,
    internalContext?: {
      githubIngressActionId: string;
      githubIngressFence: LifecycleRuntimeFence;
      superseded?: boolean;
    },
  ) {
    const serviceReceivedAtMs = Date.now();
    const githubScope = createGitHubWebhookScope(provider, internalContext, options.githubWebhookResponseBudgetMs, GITHUB_WEBHOOK_RESPONSE_BUDGET_MS);
    const { replayingDurableGitHubIngress, ignoreSupersededIngress, matchesGitHubIngressFence, githubResponseDeadlineAt } = githubScope;
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
      githubWebhookCanRecoverRevokedInstallation(endpoint?.status, provider, request);
    if (
      !endpoint ||
      endpoint.status === "archived" ||
      (endpoint.status === "revoked" && !recoveringRevokedGitHubInstallation)
    ) {
      if (replayingDurableGitHubIngress) return ignoreSupersededIngress();
      throw notFound("Chat endpoint not found");
    }
    recordChatWebhookStage("endpoint_resolved", endpoint.id);
    // A pause is a durable ingress fence. Providers generally retry non-2xx
    // webhooks, so acknowledge late callbacks without recreating a runtime or
    // admitting any Paperclip mutation.
    if (endpoint.status === "paused") {
      if (replayingDurableGitHubIngress) return ignoreSupersededIngress();
      return new Response("ignored", { status: 200 });
    }
    if (provider === "slack") {
      const verification = await verifySlackRequestUrl(endpoint, request);
      if (verification) return verification;
    }
    if (provider === "github") {
      const response = await authenticateGitHubWebhook(endpoint, request, githubScope);
      if (response) return response;
    }
    if (provider === "slack") {
      const response = await inspectSlackWebhookScope(endpoint, request);
      if (response) return response;
    }

    const lifecycleInspection = request.clone();
    const slackCallbackInspection =
      provider === "slack" ? request.clone() : null;
    const githubInspection = provider === "github" ? request.clone() : null;
    recordChatWebhookStage("runtime_requested");
    const runtimePromise = runtimeFor(endpoint);
    const initialized = await initializeGitHubWebhookRuntime(endpoint, runtimePromise, githubResponseDeadlineAt, redactError);
    if (initialized.response) return initialized.response;
    const endpointRuntime = initialized.runtime;
    recordChatWebhookStage("runtime_ready");
    const runtimeContext = runtimeContexts.get(endpointRuntime as object);
    if (!runtimeContext) {
      throw conflict("Chat endpoint runtime is not current", {
        code: "chat_endpoint_runtime_superseded",
      });
    }
    // runtimeFor can return a newer instance than the leased preflight saw.
    // Keep the exact staged epoch; callbacks on a matching instance retain
    // their normal transactional fences if a pause wins after this check.
    if (!matchesGitHubIngressFence(runtimeContext))
      return ignoreSupersededIngress();
    if (provider === "github") {
      const response = await handleGitHubWebhookEvent(endpoint, request, endpointRuntime, runtimeContext);
      if (response) return response;
    }
    const response = await endpointRuntime.handleWebhook(
      request,
      undefined,
      githubResponseDeadlineAt ?? undefined,
      provider === "telegram" ? serviceReceivedAtMs : undefined,
    );
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
    if (
      response.ok &&
      lifecyclePayload &&
      endpointRuntime.acceptsProviderScope(lifecyclePayload)
    ) {
      if (endpoint.provider === "slack") {
        await handleSlackSessionStopPayload(endpoint, lifecyclePayload, runtimeContext);
      }
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
    if (slackCallbackInspection && response.ok) {
      await recordSlackWebhookCallback(endpoint, request, slackCallbackInspection, runtimeContext);
    }
    if (response.ok) {
      const lifecycle = githubInspection
        ? await githubSupplementalLifecycleFromRequest(githubInspection)
        : provider === "telegram" && lifecyclePayload
          ? telegramLifecycleEventFromPayload(lifecyclePayload)
          : provider === "microsoft-teams"
            ? teamsWebhookLifecycleEventFromPayload(lifecyclePayload, endpointRuntime)
            : null;
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

  async function processPendingChatMaintenance(limit = 25) {
    return Promise.allSettled([
      processPendingTelegramMaintenance(limit),
    ]);
  }

  async function processPendingDeliveries(limit = 25, onlyDeliveryId?: string, maintenance = true) {
    await settleRejectedInboundWakeups(onlyDeliveryId);
    // Provider-visible effects that are not backed by a task publication use
    // chat_actions as their outbox. Reconcile them before inbound deliveries
    // so a crashed processing claim is quarantined before the delivery worker
    // could otherwise replay it.
    const actionRecovery = onlyDeliveryId || !maintenance ? null : Promise.allSettled([
      processPendingChatMaintenance(limit), processFailedChatRunRetries(limit),
      processPendingGitHubWebhookIngress(limit),
      processPendingProviderEffects(limit), processPendingSlackBoardMessages(limit),
      processPendingSlackTaskStarts(limit), processPendingReceiptReactions(limit),
      processPendingSlackSessionStops(limit), slackRegistration.processPendingVerificationMessages(limit),
    ]);
    const reactionRecovery = processPendingReactionDeliveries(
      limit,
      onlyDeliveryId,
    ).catch((error) => {
      logger.warn(
        { error: redactError(error) },
        "chat reaction-link recovery selection failed",
      );
      return 0;
    });
    let ordinaryFailed = false;
    let ordinaryError: unknown = null;
    let rows: DeliveryRow[] = [];
    try {
      const now = new Date();
      const staleBefore = new Date(
        now.getTime() - DELIVERY_PROCESSING_STALE_MS,
      );
      rows = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            sql`not exists (select 1 from chat_endpoints e where e.id = ${chatDeliveries.endpointId} and e.provider = 'agentmail')`,
            onlyDeliveryId ? eq(chatDeliveries.id, onlyDeliveryId) : undefined,
            notInArray(chatDeliveries.eventKind, [
              "reaction_added",
              "reaction_removed",
            ]),
            or(
              and(
                eq(chatDeliveries.state, "processed"),
                pendingInboundWakeupCondition(true),
              ),
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
            await db.transaction(async (tx) => {
              await notifyChatDeliveryWork(tx);
              return tx
                .update(chatDeliveries)
                .set({
                  state: "failed",
                  redactedError: "Chat endpoint is no longer available",
                  updatedAt: new Date(),
                })
                .where(eq(chatDeliveries.id, delivery.id));
            });
            continue;
          }
          try {
            await applyProviderLifecycleEffect(
              record.endpoint,
              lifecycleEffect,
            );
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
          await db.transaction(async (tx) => {
            await notifyChatDeliveryWork(tx);
            return tx
              .update(chatDeliveries)
              .set({
                state: "failed",
                redactedError: "Normalized delivery is incomplete",
                updatedAt: new Date(),
              })
              .where(eq(chatDeliveries.id, delivery.id));
          });
          continue;
        }
        const key = conversationDrainKey(delivery.endpointId, externalThreadId);
        if (conversations.has(key)) continue;
        conversations.add(key);
        await drainConversationDeliveries(
          delivery.endpointId,
          externalThreadId,
        );
      }
    } catch (error) {
      ordinaryFailed = true;
      ordinaryError = error;
    }
    // Provider recovery runs independently so a slow Slack Web API request
    // cannot hold unrelated verified inbound messages behind it. Callers that
    // explicitly replay one delivery skip these global sweeps entirely.
    if (actionRecovery) await actionRecovery;
    const reactionCount = await reactionRecovery;
    if (ordinaryFailed) throw ordinaryError;
    return reactionCount + rows.length;
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
    await db.transaction(async (tx) => {
      await notifyChatDeliveryWork(tx);
      const claimed = await tx
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
      // The operator requested a fresh attempt at an input that never reached
      // scheduling. Preserve its immutable scope; acceptance rechecks the
      // original external actor and current reach before any admission.
      await tx
        .update(chatActions)
        .set({ status: "preparing", result: null, updatedAt: new Date() })
        .where(
          and(
            eq(chatActions.endpointId, endpointId),
            eq(chatActions.deliveryId, delivery.id),
            eq(chatActions.kind, "inbound_wakeup"),
            eq(chatActions.status, "failed"),
            sql`not exists (select 1 from ${agentWakeupRequests} where ${agentWakeupRequests.id} = ${chatActions.id})`,
          ),
        );
    });
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
    return resolveSlackTaskStart(endpointId, actionId, resolution, userId, initialRecord);
  }

  async function recordExactOutboundPublicationLink(...args: Parameters<ReturnType<typeof createChatPublicationTransport>["recordExactOutboundPublicationLink"]>) {
    return publicationTransport.recordExactOutboundPublicationLink(...args);
  }

  async function stageTerminalReceiptReactionRemovals(...args: Parameters<ReturnType<typeof createChatPublicationWorker>["stageTerminalReceiptReactionRemovals"]>) {
    return publicationWorker.stageTerminalReceiptReactionRemovals(...args);
  }

  async function processPendingPublications(...args: Parameters<ReturnType<typeof createChatPublicationQueue>["processPendingPublications"]>) {
    return publicationQueue.processPendingPublications(...args);
  }

  const githubReviews = githubChatReviewService(db, fetchImpl);
  const { scheduleGitHubMaintenance } = createGitHubMaintenance(db, fetchImpl, {
    scheduleMessageProcessing, isShuttingDown: () => shuttingDown,
  });

  async function processPublicationMaintenance(limit = 25) {
    scheduleTeamsFileMaintenance();
    scheduleGitHubMaintenance();
    await enqueueInboundWakeupPublications();
    await reconcileTerminalConfirmationActions(limit);
    await processPendingInteractionWakeups(limit);
  }

  // The app refills free endpoint slots on commits and durable deadlines.
  // Work remains tracked by this service and is joined before runtime shutdown.
  async function schedulePendingPublications(limit = 25) {
    await processPublicationMaintenance(limit);
    return processPendingPublications(limit, { waitForCompletion: false, maintenance: false });
  }

  let wakePublications = () => {};

  async function nextPublicationAt(): Promise<number | null> {
    const cooldowns = Object.fromEntries([...teamsFileRetryAfter].map(([id, at]) => [id, new Date(at).toISOString()]));
    const [queued, streaming] = await Promise.all([
      db.select({ at: sql<string | null>`min(greatest(coalesce(${chatPublications.nextAttemptAt}, now()),
        (${JSON.stringify(cooldowns)}::jsonb->>${chatPublications.id}::text)::timestamptz))` })
        .from(chatPublications).where(publicationEligibility({ busyEndpointIds: [...publicationEndpointTasks.keys()] })),
      db.select({ at: sql<string | null>`min(greatest(${chatPublications.updatedAt} + interval '60 seconds',
        (select max(l.expires_at) from chat_endpoint_leases l
          where l.company_id = chat_publications.company_id and l.endpoint_id = chat_publications.endpoint_id
          and l.lease_key = 'publication:' || chat_publications.id::text || ':' || chat_publications.attempts::text)))` })
        .from(chatPublications).where(and(
          eq(chatPublications.state, "streaming"),
          sql`not exists (select 1 from chat_endpoints e where e.id = ${chatPublications.endpointId} and e.publication_mode = 'explicit')`,
          sql`not exists (select 1 from ${chatTeamsFileTransfers} f where f.company_id = ${chatPublications.companyId} and f.publication_id = ${chatPublications.id})`,
        )),
    ]);
    const deadlines = [queued[0]?.at, streaming[0]?.at].filter(at => at != null).map(at => new Date(at!).getTime());
    return deadlines.length ? Math.min(...deadlines) : null;
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

  const { configure, configureWithCredentialLease, runtimeConfig } = createChatConfiguration(db, {
    endpointRecord, get, withCredentialMutationLease, getWebhookPublicBaseUrl, invalidateRuntime,
    nativeBotIdentityMatches, assertNativeBotIdentityAvailable, isNativeBotIdentityUniqueViolation, nativeBotIdentityConflict,
    legacyGitHubLabelsMatchVerifiedCredentials, normalizedCredentials, verifyCredentials,
    persistCredentials, clearCredentials, resolveCredentials, prepareProviderInventory,
    reconcileProviderResourceRows, reconcileDiscordCommands, runtimeFor, runtimeContextForRecord,
    stageTelegramMaintenance, processTelegramMaintenance, recordTelegramStopSubscription,
    fetchImpl, redactError, runtimeGeneration, leasedChatProvider, PROVIDER_LABELS, SUPPLIED_CREDENTIAL_KEYS,
    PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS, isSupportedTelegramWebhookBaseUrl,
    get slackRegistration() { return slackRegistration; },
    get githubWizard() { return githubWizard; },
    get nativeBotIdentityClaimBarrier() { return options.nativeBotIdentityClaimBarrier; },
    get allowLocalVoiceBoard() { return options.allowLocalVoiceBoard; },
  });
  const { slackRegistration, verifySlackRequestUrl, sendSlackTestMessage } = createSlackSetupServices(db, {
    endpointRecord, ensurePrincipal, withCredentialMutationLease, resolveCredentials,
    resolveCredentialRefs, configureWithCredentialLease, createLinkIntent,
    getPublicBaseUrl, getWebhookPublicBaseUrl, fetchImpl, scheduleMessageProcessing,
    renderSlackAvatar: options.renderSlackAvatar, slackManaged: options.slackManaged,
  });
  const { storeGitHubApp, githubRegistration, refreshGitHubRepositories, githubWizard, unregisterGitHubCloudIngress, saveGitHubSetupProgress } = createGitHubAppSetup(db, {
    endpointRecord, withCredentialMutationLease, normalizedCredentials, verifyCredentials, nativeBotIdentityMatches,
    assertNativeBotIdentityAvailable, isNativeBotIdentityUniqueViolation, nativeBotIdentityConflict,
    persistCredentials, resolveCredentials, fetchImpl, get, getPublicBaseUrl, getWebhookPublicBaseUrl,
    prepareProviderInventory, reconcileProviderResourceRows, listResources, replaceResources, update, configure, test, handleWebhook,
    get githubWizardOrigin() { return options.githubWizardOrigin; },
  });
  const { prepareInboundEnvelope } = createInboundEnvelope(db, { runtimeFor, sanitizeFilename, githubManualMessages, githubAutomaticMessages, githubIssueMessages });
  const { admitInboundMessage } = createInboundAdmission(db, { runtimeGeneration, credentialFingerprint, leasedChatProvider, renewDiscordGatewayOwnershipForMessageAdmission, ensureResource, DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS });
  const { admitMessageResource } = createMessageResourceAdmission(db, { ensureResource });
  const messageLifecycle = createChatMessageLifecycle(db, {
    DELIVERY_PROCESSING_STALE_MS, ORPHAN_FOLLOW_UP_GRACE_MS, ORPHAN_FOLLOW_UP_MAX_ATTEMPTS,
    INGRESS_REORDER_WINDOW_MS, issuesSvc, lockCurrentPrincipalAuthorization, nonDirectDestinationAllowed,
    redactError, runtimeCallbackEndpoint, sameTeamsThreadIdentity, durableExternalThreadIdentity,
    recordCurrentMicrosoftTeamsRoute, conversationDrainKey, scheduleConversationDrain, scheduledConversationDrains,
    drainConversationDeliveries, ensureDiscordGatewayRuntimeIsCurrent,
    get deferWebhookProcessing() { return options.deferWebhookProcessing; },
  });
  const { recordLifecycleDelivery, processLifecycleDelivery, conversationForThread } = messageLifecycle;
  const conversationDeliveryQueue = createChatConversationDeliveryQueue(db, {
    DELIVERY_DRAIN_LIMIT, DELIVERY_LEASE_TTL_MS, discordRootThreadPending, reconcileDiscordRootThread,
    durableExternalThreadIdentity, liveInboundMessages, processInboundWakeup, processLifecycleDelivery, processMessage,
    redactError, runtimeContexts, runtimeFor, settleRejectedInboundWakeups, sanitizeFilename,
    githubManualMessages, githubAutomaticMessages, githubIssueMessages, conversationDrainKey,
    get conversationLeaseRenewalIntervalMs() { return options.conversationLeaseRenewalIntervalMs; },
    get renewConversationDeliveryLease() { return options.renewConversationDeliveryLease; },
  });
  const { nextInboundDeliveryAt } = conversationDeliveryQueue;
  const { currentTaskControlPayload, hasCommittedTaskControlCompletion, commitTaskControlCompletion } = createChatPublicationTaskControl(db);
  const publicationTransport = createChatPublicationTransport(db, {
    endpointRecord, fetchImpl, getTaskBaseUrl, publicationFiles, receiptReactionCompletionRunId,
    runIdFromMilestonePublication, runtime, runtimeFor, runtimeGeneration, CAPABILITIES,
    voice, voiceStore, scheduleMessageProcessing,
  });
  const { postSafePublication } = publicationTransport;
  const { claimPublicationTransportAuthorization } = createChatPublicationAuthorization(db, {
    authorizeInboundWakePublication, authorizeRetainedChatSourcePublication, fetchImpl,
    githubCurrentOmissionPreparedText, hasCommittedTaskControlCompletion, lockCurrentPrincipalAuthorization,
    nonDirectDestinationAllowed, resolveCredentials, runtimeCallbackEndpoint, FailedChatRetryPublicationReadError,
  });
  const { finalizePublicationFailure } = createChatPublicationFailures(db, {
    FailedChatRetryPublicationReadError, MAX_ERROR_TEXT, getTaskBaseUrl, invalidateRuntime, runtimeCallbackEndpoint,
  });
  const { ensureDurablePublicationTransport } = createChatPublicationPreparation(db, {
    runPublicationToReplace,
    get publicationTransportPreparationBarrier() { return options.publicationTransportPreparationBarrier; },
  });
  const publicationWorker = createChatPublicationWorker(db, {
    CAPABILITIES, authorizeRetainedChatSourcePublication, claimPublicationTransportAuthorization,
    closeProgressToReplace, commitTaskControlCompletion, currentTaskControlPayload, endpointRecord,
    ensureDurablePublicationTransport, finalizePublicationFailure, hasCommittedTaskControlCompletion,
    hasTelegramStopSubscription, inboundWakePublicationToReplace, interactionPromptPublicationToReplace,
    interactionResolutionPublicationToReplace, nonDirectDestinationAllowed, postSafePublication,
    processReceiptReaction, progressSupersededByFastResponse, recordSlackFileUploadReceipt, redactError,
    reserveTelegramPublicationDraft, runOwnershipMilestoneSupersessionReason, runProgressSupersededByPublishedInteraction,
    runPublicationToReplace, runtimeContextForRecord, scheduleMessageProcessing, settleGitHubAutomaticPublication,
    stageSlackFilePublicationSuccess, taskStatusPublicationToReplace, tryProcessTeamsFilePublication,
    withCredentialMutationLease, receiptReactionCompletionRunId,
  });
  const { processSelectedPublication } = publicationWorker;
  const { processPendingInteractionWakeups } = createChatInteractionContinuations(db, {
    redactError, CONFIRMATION_WAKEUP_RETRY_BACKOFF_MS, get heartbeat() { return options.heartbeat; },
  });
  const { handleAction, handleModalSubmit, reconcileTerminalConfirmationActions } = createChatInteractionCallbacks(db, {
    CAPABILITIES, MAX_ERROR_TEXT, actionThreadMatchesConversation, nonDirectDestinationAllowed, sameTeamsThreadIdentity,
    ensurePrincipal, endpointRecord, runtimeCallbackRecord, runtimeCallbackEndpoint,
    requireCurrentExternalActionAuthorization, isExternalActionAuthorizationChange,
    recordCurrentMicrosoftTeamsRoute, lockTelegramCallbackNoticeAuthority, stageProviderEffect,
    scheduleProviderEffect, invalidateRuntime, redactError, persistence, questionResponses,
    scheduleMessageProcessing, processPendingPublications,
    get confirmationResolutionPersistBarrier() { return options.confirmationResolutionPersistBarrier; },
    get questionFormOpenAuthorizationBarrier() { return options.questionFormOpenAuthorizationBarrier; },
    get questionResolutionPersistBarrier() { return options.questionResolutionPersistBarrier; },
  });
  const publicationQueue = createChatPublicationQueue(db, {
    PUBLICATION_ENDPOINT_CONCURRENCY, enqueueInboundWakeupPublications, processPendingInteractionWakeups,
    reconcileTerminalConfirmationActions, processSelectedPublication, publicationEndpointTasks,
    teamsFileRetryAfter, redactError, isShuttingDown: () => shuttingDown, wakePublications: () => wakePublications(),
  });
  const { publicationEligibility } = publicationQueue;
  const { unregisterSlackTaskAuthority } = createSlackTaskAuthorityRegistration(db, { authorizeInboundWakeup, resolveCredentials });

  const { replayPublication, resolvePublication, resolveProviderEffect } = createChatPublicationResolution(db, { endpointRecord, withCredentialMutationLease, teamsTransferProtocol, commitTaskControlCompletion, processPendingPublications, processProviderEffect });
  const { prepareTeamsBoardSend } = createTeamsBoardSendPreparation(db, { endpointRecord, runtimeFor });
  const { getPublicationBatchStatus, publishComment, publishBoardMessage } = createChatPublicationRequests(db, { endpointRecord, stageTeamsBoardFileIntent, processPendingSlackBoardMessages, processPendingPublications, prepareTeamsBoardSend });
return {
    voice,
    authorizeFastResponse,
    slackRegistration,
    sendSlackTestMessage,
    saveGitHubSetupProgress,
    githubWizard,
    startGitHubRegistration: githubRegistration.start,
    completeGitHubRegistration: githubRegistration.complete,
    storeGitHubApp,
    refreshGitHubRepositories,
    runtime,
    list,
    get,
    create,
    update,
    generateSetupSecret,
    configure,
    inspectPhoton,
    test,
    finishSlackSetup: (endpointId: string, userId: string) => test(endpointId, { optionalSlackTestForUser: userId }),
    setupTestStatus,
    handleWebhook,
    listResources,
    listGitHubRepositories,
    toggleAllGitHubRepositories,
    replaceResources,
    listPrincipals,
    createLinkIntent,
    previewIdentityLink,
    requestIdentityAccess,
    confirmIdentityLink,
    revokeLink,
    listConversations,
    listActivity,
    listActivityPage,
    replayDelivery,
    replayPublication,
    resolveAction,
    resolvePublication,
    publishComment,
    getPublicationBatchStatus,
    publishBoardMessage,
    reconcileProviderRuntimes,
    processPendingPublications,
    enqueueInboundWakeupPublications,
    schedulePendingPublications,
    processPendingDeliveries,
    processQueuedDeliveries: () => processPendingDeliveries(25, undefined, false),
    scheduleQueuedPublications: () => processPendingPublications(25, { waitForCompletion: false, maintenance: false }),
    processPendingChatMaintenance,
    processPendingTelegramActions,
    processTelegramSubscriptionDiscovery,
    scheduleTelegramSubscriptionDiscovery,
    hasPendingTelegramSubscriptionDiscovery,
    processPendingSlackBoardMessages,
    processPendingSlackTaskStarts,
    processPendingVerificationMessages: slackRegistration.processPendingVerificationMessages,
    nextVerificationMessageAt: slackRegistration.nextVerificationMessageAt,
    nextChatActionAt: (kind: ScheduledChatAction) => nextChatActionAt(db, kind),
    processPublicationMaintenance,
    nextInboundDeliveryAt,
    nextPublicationAt,
    processPendingGitHubReviewPublications: githubReviews.processPending,
    nextGitHubReviewPublicationAt: githubReviews.nextPendingAt,
    nextSlackReceiptAt,
    onPublicationsSettled: (wake: () => void) => { wakePublications = wake; },
    prepareFailedChatRunRetry,
    authorizeFailedChatRunRetry,
    processFailedChatRunRetry,
    processFailedChatRunRetries,
    processPendingGitHubWebhookIngress,
    processFailedGitHubWebhookDeliveries,
    processPendingProviderEffects,
    processPendingReceiptReactions,
    processPendingSlackFileUploadReceipts,
    processPendingSlackSessionStops,
    processPendingSlackSessionSyncs,
    getIssueBinding,
    shutdown: async () => {
      shuttingDown = true;
      await Promise.allSettled(pendingFailedRetries());
      unregisterFailedRetryAuthority();
      unregisterSlackTaskAuthority();
      voice.unregisterAgentTools();
      unregisterGitHubCloudIngress();
      unregisterCommittedResponseAuthority();
      await Promise.allSettled([...publicationEndpointTasks.values()]);
      await Promise.allSettled([...backgroundMessageTasks]);
      scheduledConversationDrains.clear();
      liveInboundMessages.clear();
      const ownedDiscordGateways = [...discordGatewayOwnerships.values()];
      for (const ownership of ownedDiscordGateways) {
        ownership.stopping = true;
        if (ownership.renewTimer) {
          clearInterval(ownership.renewTimer);
          ownership.renewTimer = null;
        }
      }
      discordGatewayOwnerships.clear();
      await Promise.allSettled(
        ownedDiscordGateways
          .map((ownership) => ownership.renewal)
          .filter((renewal): renewal is Promise<void> => renewal !== null),
      );
      await Promise.allSettled([...discordGatewayStopTasks]);
      // Stop every provider runtime before releasing leader rows. This gives a
      // standby an immediate takeover path without overlapping Gateway sockets.
      await runtime.shutdown();
      await slackRegistration.close();
      await Promise.all(
        ownedDiscordGateways.map((ownership) =>
          releaseDiscordGatewayLeaseRow(ownership),
        ),
      );
    },
  };
}

export type ChatChannelService = ReturnType<typeof chatChannelService>;
