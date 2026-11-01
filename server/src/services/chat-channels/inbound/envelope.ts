import { providerResourceType, durableExternalThreadIdentity, canonicalProviderResourceId, chatSurfaceKind } from "./surfaces.js";

import type { EndpointRow, InboundRuntimeContext } from "../runtime-types.js";

import {
  MAX_INBOUND_TEXT,
  stableExternalPrincipalId,
} from "../message-lifecycle.js";
import {
  telegramMessageSequence,
  telegramMessageSentAt,
} from "../telegram/messages.js";
import {
  slackMessageSentAt,
} from "../slack/messages.js";
import {
  teamsActivitySentAt,
} from "../microsoft-teams/messages.js";

import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";

import { chatGitHubConfigurations } from "@paperclipai/db";
import type { GitHubReviewEventContext, GitHubIssueEventContext, GitHubReviewPolicy } from "@paperclipai/shared";

import { photonReplyReference } from "../../photon/adapter.js";

import {
  and,
  eq,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatEndpointResources,
} from "@paperclipai/db";
import type {
  ChatEventKind,
} from "@paperclipai/shared";

import {
  normalizeContentType,
} from "../../../attachment-types.js";
import {
  deriveTeamsPersonalRecipient,
} from "../../chat-teams-personal-recipient.js";

import {
  type ChatSdkMessageCallbackEvent,
} from "../../chat-sdk-runtime.js";

import {
  githubAttachmentLimitOmissions,
} from "../../chat-github-attachments.js";

import { chatProviderConversationUrl } from "../../chat-provider-links.js";

import type {
  Attachment,
  Message,
  Thread,
} from "chat";

export type InboundEnvelopeInput = {
  endpoint: EndpointRow;
  thread: Thread;
  message: Message;
  trigger: ChatSdkMessageCallbackEvent["trigger"];
  receiptReactionSupported: boolean;
  recoveredProviderUrl: string | null;
  runtimeContext?: InboundRuntimeContext;
  providerUpdateId?: number;
  admittedDeliveryId: string | null;
  suppressSetupDestinationActivation: boolean;
  slackSlashControl: boolean;
};
type InboundEnvelopeOptions = {
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  sanitizeFilename: (value: string | undefined) => string | null;
  githubManualMessages: WeakMap<object, { policy: GitHubReviewPolicy; revision: number; event: "mention" | "comment" }>;
  githubAutomaticMessages: WeakMap<object, { context: GitHubReviewEventContext; revision: number; policy: GitHubReviewPolicy }>;
  githubIssueMessages: WeakMap<object, { context: GitHubIssueEventContext; revision: number; policy: GitHubReviewPolicy }>;
};
export function createInboundEnvelope(db: Db, options: InboundEnvelopeOptions) {
  const { runtimeFor, sanitizeFilename, githubManualMessages, githubAutomaticMessages, githubIssueMessages } = options;
  async function prepareInboundEnvelope(input: InboundEnvelopeInput) {
    const { endpoint, thread, message, trigger, receiptReactionSupported, recoveredProviderUrl, runtimeContext, providerUpdateId, admittedDeliveryId, suppressSetupDestinationActivation, slackSlashControl } = input;
    const githubAutomatic = endpoint.provider === "github" ? githubAutomaticMessages.get(message) : undefined;
    const githubIssue = endpoint.provider === "github" ? githubIssueMessages.get(message) : undefined;
    let githubManual = githubManualMessages.get(message);
    if (endpoint.provider === "github" && !githubAutomatic && !githubIssue && !githubManual) {
      const [config] = await db.select().from(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, endpoint.id));
      if (config) {
        const repository = thread.channelId.replace(/^github:/, "").toLowerCase();
        const [repo] = await db.select().from(chatEndpointResources).where(and(eq(chatEndpointResources.endpointId, endpoint.id), eq(chatEndpointResources.providerResourceId, repository)));
        const repositoryId = String(repo?.metadata?.providerRepositoryId ?? "");
        githubManual = { policy: { ...config.configuration.defaults, ...config.configuration.repositories[repositoryId] }, revision: config.revision, event: trigger === "mention" || message.isMention ? "mention" : "comment" };
      }
    }
    const providerEventId = `${durableExternalThreadIdentity(thread.id)}:${message.id}`;
    const surfaceKind = chatSurfaceKind(endpoint.provider, thread);
    const addressed =
      endpoint.provider === "imessage-photon" ||
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
    // Non-personal generic files still require a separate Graph grant. Only
    // exact inline image resources from the authenticated original activity
    // receive a scope-bound, URL-free recovery locator. Reconstructed input
    // can retain that proof, but cannot mint one from legacy fetch metadata.
    const teamsNonPersonal =
      endpoint.provider === "microsoft-teams" && !thread.isDM;
    const attachmentSource = {
      threadId: thread.id,
      messageId: message.id,
      runtimeGeneration: runtimeContext?.generation,
      credentialFingerprint: runtimeContext?.credentialFingerprint,
      principalExternalId: stableExternalPrincipalId(
        endpoint.provider,
        message.author,
        message.raw,
      ),
      isDirectMessage: thread.isDM,
      ...(runtimeContext?.endpointRuntime && !admittedDeliveryId
        ? { message }
        : {}),
    };
    const inlineRecovery = new Map<
      Attachment,
      ReturnType<ChatEndpointRuntime["attachmentRecoveryDescriptor"]>
    >();
    const nativeInboundAttachments = teamsNonPersonal
      ? message.attachments.slice(0, 20).flatMap((attachment) => {
          const descriptor = endpointRuntime.attachmentRecoveryDescriptor(
            attachment,
            attachmentSource,
          );
          if (descriptor?.locator.kind !== "teams_inline_image") return [];
          const restored = endpointRuntime.rehydrateAttachment(
            descriptor,
            attachmentSource,
          );
          if (!restored) return [];
          inlineRecovery.set(attachment, descriptor);
          return [restored];
        })
      : message.attachments;
    const unavailableTeamsReferences = teamsNonPersonal
      ? Math.min(message.attachments.length, 20) -
        nativeInboundAttachments.length
      : 0;
    const providerSentAt =
      endpoint.provider === "microsoft-teams"
        ? teamsActivitySentAt(message.raw)
        : endpoint.provider === "telegram"
          ? telegramMessageSentAt(message.raw)
          : endpoint.provider === "slack"
            ? slackMessageSentAt(message.raw, message.id)
            : message.metadata.dateSent instanceof Date &&
                Number.isFinite(message.metadata.dateSent.getTime())
              ? message.metadata.dateSent
              : null;
    const providerSentAtSource = providerSentAt
      ? endpoint.provider === "microsoft-teams"
        ? "teams_activity_timestamp"
        : endpoint.provider === "telegram"
          ? "telegram_message_date"
          : endpoint.provider === "slack"
            ? "slack_message_ts"
            : null
      : null;
    const providerUrl =
      (githubAutomatic
        ? `https://github.com/${githubAutomatic.context.repository}/pull/${githubAutomatic.context.pullNumber}`
        : githubIssue ? `https://github.com/${githubIssue.context.repository}/issues/${githubIssue.context.issueNumber}` : null) ??
      // Description/review requests and edits have synthetic ledger IDs, not
      // native comment IDs. Their verified source URL must not acquire a fake
      // issuecomment anchor from that ledger identity.
      (endpoint.provider === "github" && githubManual && !receiptReactionSupported ? recoveredProviderUrl : null) ??
      chatProviderConversationUrl({
        provider: endpoint.provider,
        providerAccountId: endpoint.providerAccountId,
        botUsername: endpoint.botUsername,
        threadId: thread.id,
        providerMessageId: message.id,
        raw: message.raw,
      }) ?? recoveredProviderUrl;
    // Preserve only the closed personal-recipient proof from the runtime that
    // authenticated this original activity. A reconstructed delivery's AAD-only
    // author and SDK route caches cannot recreate its Bot Framework recipient.
    const teamsPersonalRecipient =
      endpoint.provider === "microsoft-teams" &&
      runtimeContext?.endpointRuntime &&
      !admittedDeliveryId &&
      endpoint.providerAccountId &&
      endpoint.botExternalId
        ? deriveTeamsPersonalRecipient(message, {
            companyId: endpoint.companyId,
            endpointId: endpoint.id,
            runtimeGeneration: runtimeContext.generation,
            credentialFingerprint: runtimeContext.credentialFingerprint,
            tenantId: endpoint.providerAccountId,
            botAppId: endpoint.botExternalId,
            providerEventId,
            threadId: thread.id,
            isDirectMessage: thread.isDM,
          })
        : null;
    const normalized = {
      providerEventId,
      kind: eventKind,
      trigger,
      ...(teamsPersonalRecipient ? { teamsPersonalRecipient } : {}),
      ...(slackSlashControl
        ? { admission: { origin: "slack_slash_control" } }
        : suppressSetupDestinationActivation
          ? // A slash-command root is provider-confirmed only after an enabled
            // destination authorized its transport. Persist that closed origin so
            // crash recovery can never reinterpret it as first-time setup traffic
            // and undo a later operator reach revocation.
            { admission: { origin: "provider_confirmed_action" } }
          : {}),
      ...(runtimeContext
        ? {
            runtimeContext: {
              credentialFingerprint: runtimeContext.credentialFingerprint,
              generation: runtimeContext.generation,
            },
          }
        : {}),
      acknowledgement: {
        // Some provider callbacks represent an auditable user command without
        // a provider message that can receive a reaction. Persist the
        // distinction so a crash/retry cannot mistake the synthetic ledger id
        // for a native message id.
        receiptReactionSupported,
      },
      ...(githubAutomatic ? { githubAutomatic } : {}),
      ...(githubIssue ? { githubIssue } : {}),
      ...(githubManual ? { githubManual } : {}),
      principal: {
        // Bot/system authors have already been rejected at this intake boundary.
        isBot: false,
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
        ...(endpoint.provider === "github" && typeof (message.raw as { githubSourceMessageId?: unknown })?.githubSourceMessageId === "string" && /^[1-9][0-9]*$/.test((message.raw as { githubSourceMessageId: string }).githubSourceMessageId)
          ? { sourceProviderMessageId: (message.raw as { githubSourceMessageId: string }).githubSourceMessageId } : {}),
        ...(endpoint.provider === "imessage-photon"
          ? { photonReply: photonReplyReference(message.raw) }
          : {}),
        providerMessageSequence:
          endpoint.provider === "telegram"
            ? telegramMessageSequence(message.raw)
            : null,
        providerUpdateId:
          endpoint.provider === "telegram" ? (providerUpdateId ?? null) : null,
        text: message.text.slice(0, MAX_INBOUND_TEXT),
        mentionedBot: message.isMention === true,
        providerSentAt: providerSentAt?.toISOString() ?? null,
        ...(providerSentAtSource ? { providerSentAtSource } : {}),
        ...((endpoint.provider === "github" ||
          endpoint.provider === "imessage-photon") &&
        (githubAttachmentLimitOmissions(message) ||
          Math.max(0, message.attachments.length - 20))
          ? {
              attachmentLimitOmissions:
                githubAttachmentLimitOmissions(message) ||
                Math.max(0, message.attachments.length - 20),
            }
          : {}),
        attachments: message.attachments.slice(0, 20).map((attachment) => ({
          name: sanitizeFilename(attachment.name),
          mimeType: normalizeContentType(attachment.mimeType),
          size: attachment.size ?? null,
          recovery: teamsNonPersonal
            ? (inlineRecovery.get(attachment) ?? null)
            : nativeInboundAttachments.includes(attachment)
              ? endpointRuntime.attachmentRecoveryDescriptor(
                  attachment,
                  ["telegram", "imessage-photon"].includes(endpoint.provider)
                    ? attachmentSource
                    : undefined,
                )
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
      ...(runtimeContext
        ? {
            runtimeContext: {
              credentialFingerprint: runtimeContext.credentialFingerprint,
              generation: runtimeContext.generation,
            },
          }
        : {}),
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
    return { githubAutomatic, githubIssue, githubManual, providerEventId, surfaceKind, addressed, eventKind, endpointRuntime, nativeInboundAttachments, unavailableTeamsReferences, providerSentAt, providerUrl, normalized, redactedDestinationNormalized };
  }
  return { prepareInboundEnvelope };
}
export type InboundEnvelope = Awaited<ReturnType<ReturnType<typeof createInboundEnvelope>["prepareInboundEnvelope"]>>;
