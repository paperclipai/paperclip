import { slackPublicationCard } from "../slack/cards.js";
import type { PublicationTransportInput } from "./types.js";
import { createPhotonPublicationDelivery } from "../imessage-photon/publications.js";
import { createOutboundAttachments } from "../outbound-attachments.js";
import { discordMarkdownAttachment } from "../discord/messages.js";
import { telegramMarkdownAttachment } from "../telegram/messages.js";

import type { EndpointRow, DbOrTransaction } from "../runtime-types.js";

import { createChatPublicationReplacement } from "../publication-replacement.js";

import { voiceSessionService } from "../../voice/voice-session-service.js";

import { voiceSessionStore } from "../../voice/voice-session-store.js";
import { type ChatRuntime } from "../../chat-runtime.js";
import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";

import { chatGitHubConfigurations } from "@paperclipai/db";

import { githubResponseCommentService } from "../../chat-github-response-comments.js";

import {
  and,
  eq,
  isNull,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatMessageLinks,
  chatPublications,
} from "@paperclipai/db";
import type {
  ChatAdapterCapabilities,
  ChatEndpointSetupState,
  ChatProvider,
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

import { telegramAttachmentForUpload } from "../../chat-telegram-photo.js";

import {
  conflict,
  forbidden,
} from "../../../errors.js";

import {
  type ChatSdkRuntime,
} from "../../chat-sdk-runtime.js";

import { safeChatTaskUrl } from "../../chat-task-url.js";

import {
  renderPublicationTransportText,
} from "../../chat-publication-text-parts.js";

import { classifyChatPublicationError } from "../../chat-publication-errors.js";

import {
  prepareTeamsInlineImage,
} from "../../chat-teams-inline-images.js";
import {
  shouldStreamSafePublicationText,
  streamSafePublicationText,
} from "../../chat-publication-stream.js";

import {
  isChatQuestionFormOpenActionId,
} from "../../chat-question-forms.js";

import type {
  AdapterPostableMessage,
  Attachment,
  FileUpload,
} from "chat";
import { Actions, Button, Card, CardText, LinkButton } from "chat";
import type { EndpointRecord } from "../runtime-types.js";
import { isExplicitOperatorPublication } from "./policy.js";
type PublicationTransportOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  fetchImpl: typeof globalThis.fetch;
  getTaskBaseUrl: () => string | null | undefined;
  publicationFiles: ReturnType<typeof createOutboundAttachments>["publicationFiles"];
  receiptReactionCompletionRunId: ReturnType<typeof createChatPublicationReplacement>["receiptReactionCompletionRunId"];
  runIdFromMilestonePublication: ReturnType<typeof createChatPublicationReplacement>["runIdFromMilestonePublication"];
  runtime: Pick<ChatRuntime | ChatSdkRuntime, "get">;
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  CAPABILITIES: Record<ChatProvider, ChatAdapterCapabilities>;
  voice: Pick<ReturnType<typeof voiceSessionService>, "pushReplies">;
  voiceStore: Pick<ReturnType<typeof voiceSessionStore>, "enqueuePublication">;
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
};
export function createChatPublicationTransport(db: Db, options: PublicationTransportOptions) {
  const { endpointRecord, fetchImpl, getTaskBaseUrl, publicationFiles, receiptReactionCompletionRunId, runIdFromMilestonePublication, runtime, runtimeFor, runtimeGeneration, CAPABILITIES, voice, voiceStore, scheduleMessageProcessing } = options;
  const { deliverPhotonPublication } = createPhotonPublicationDelivery(db, { endpointRecord, runtimeGeneration, runtime, receiptReactionCompletionRunId, getTaskBaseUrl });


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
  if (provider === "slack") return slackPublicationCard(payload);
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

  async function recordExactOutboundPublicationLink(
    tx: DbOrTransaction,
    input: {
      publication: typeof chatPublications.$inferSelect;
      providerMessageId: string;
    },
  ): Promise<boolean> {
    const inserted = await tx
      .insert(chatMessageLinks)
      .values({
        companyId: input.publication.companyId,
        endpointId: input.publication.endpointId,
        conversationId: input.publication.conversationId,
        publicationId: input.publication.id,
        commentId: input.publication.commentId,
        providerMessageId: input.providerMessageId,
        direction: "outbound",
      })
      .onConflictDoNothing()
      .returning({ id: chatMessageLinks.id });
    if (inserted.length) return true;
    return tx
      .select({ id: chatMessageLinks.id })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.companyId, input.publication.companyId),
          eq(chatMessageLinks.endpointId, input.publication.endpointId),
          eq(chatMessageLinks.conversationId, input.publication.conversationId),
          eq(chatMessageLinks.publicationId, input.publication.id),
          input.publication.commentId
            ? eq(chatMessageLinks.commentId, input.publication.commentId)
            : isNull(chatMessageLinks.commentId),
          eq(chatMessageLinks.providerMessageId, input.providerMessageId),
          eq(chatMessageLinks.direction, "outbound"),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
  }

  async function postSafePublication(input: PublicationTransportInput) {
    if (input.endpoint.provider === "speko") {
      const receipt = await voiceStore.enqueuePublication(input.endpoint.companyId, input.publication.id);
      scheduleMessageProcessing(() => voice.pushReplies(25, input.endpoint.companyId, input.endpoint.id).then(() => undefined));
      return receipt;
    }
    if (input.endpoint.provider === "github" && ["failed", "completed"].includes(input.payload.progressState ?? "") &&
        !input.payload.interactionId && !isExplicitOperatorPublication(input.publication) &&
        (await db.select({ endpointId: chatGitHubConfigurations.endpointId }).from(chatGitHubConfigurations).where(and(
          eq(chatGitHubConfigurations.companyId, input.endpoint.companyId), eq(chatGitHubConfigurations.endpointId, input.endpoint.id))).limit(1)).length > 0) {
      const runId = runIdFromMilestonePublication(input.publication);
      if (!runId) throw forbidden("GitHub failure has no run binding");
      const receipt = await githubResponseCommentService(db, fetchImpl).failRun({
        companyId: input.publication.companyId, endpointId: input.endpoint.id,
        issueId: input.publication.issueId, runId, body: input.payload.progressState === "completed"
          ? "This turn ended without publishing a final response. See the Paperclip task for details."
          : renderPublicationTransportText(input.payload),
      });
      if (!receipt) throw conflict("GitHub response publication is busy");
      return { id: receipt.id, threadId: input.conversation.externalThreadId, raw: {}, text: input.payload.text };
    }
    const endpointRuntime = await runtimeFor(input.endpoint);
    const thread = endpointRuntime.thread(input.conversation.externalThreadId);
    const card = safeCardForPublication(input.payload, input.endpoint.provider);
    let attachments: Attachment[] = [];
    let files: FileUpload[] = [];
    let text = renderPublicationTransportText(input.payload);
    if (input.payload.attachmentIds?.length) {
      if (
        input.endpoint.provider === "microsoft-teams" &&
        !input.conversation.isDirectMessage
      ) {
        // The staged personal-file lane remains authoritative for consent.
        // Channel/group pictures need no OneDrive upload or public asset URL:
        // send only verified original picture bytes through the native adapter.
        const candidates = await publicationFiles(
          input.publication,
          input.payload,
          { teamsInlineImagesOnly: true },
        );
        const pictures = await Promise.all(
          candidates.map(prepareTeamsInlineImage),
        );
        if (pictures.length && pictures.every((picture) => picture !== null)) {
          files = pictures;
        }
      }
      const nativeFileSurface =
        CAPABILITIES[input.endpoint.provider].files &&
        input.endpoint.provider !== "microsoft-teams";
      if (nativeFileSurface) {
        const uploads = await publicationFiles(
          input.publication,
          input.payload,
        );
        if (input.endpoint.provider === "telegram") {
          attachments = await Promise.all(
            uploads.map(telegramAttachmentForUpload),
          );
        } else {
          files = uploads;
        }
      } else if (files.length === 0) {
        const taskUrl = safeChatTaskUrl(
          getTaskBaseUrl(),
          input.publication.issueId,
        );
        if (
          input.endpoint.provider === "github" ||
          input.endpoint.provider === "microsoft-teams"
        ) {
          // GitHub lacks a bot upload contract. Teams reaches this fallback
          // only without an admissible personal-consent destination. Replace
          // our generated caption, preserving any future custom text.
          const generatedFileLabel = /^Shared (.+)\.$/s.exec(text)?.[1] ?? null;
          const limitation =
            input.endpoint.provider === "github"
              ? "This GitHub App connection cannot upload file bytes into comments."
              : "Direct file delivery isn't available for this Teams conversation.";
          if (generatedFileLabel) {
            const saved = taskUrl
              ? `File saved on the Paperclip task: ${generatedFileLabel}.`
              : `File saved on the private Paperclip task: ${generatedFileLabel}.`;
            text = taskUrl
              ? `${saved} ${limitation} Download it: ${taskUrl}`
              : `${saved} ${limitation}`;
          } else {
            const handoff = taskUrl
              ? `Open the file on its Paperclip task: ${taskUrl}`
              : "The file remains available only on the private Paperclip task.";
            text = `${text}\n\n${limitation} ${handoff}`;
          }
        } else {
          const attachmentFallback = taskUrl
            ? `Open the task in Paperclip: ${taskUrl}`
            : "Open the task in Paperclip to download the attachment.";
          text = `${text}\n\n${attachmentFallback}`;
        }
      }
    }
    if (input.endpoint.provider === "imessage-photon") {
      return deliverPhotonPublication(input, endpointRuntime, thread, text, files);
    }
    if (
      input.endpoint.provider === "discord" &&
      input.payload.transportPart?.mode === "discord_markdown_attachment"
    ) {
      files.push(discordMarkdownAttachment(text));
      text =
        input.payload.transportPart.count > 1
          ? "Complete response attached."
          : "Paperclip attached the complete response because it exceeds Discord’s message limit.";
    }
    if (
      input.endpoint.provider === "telegram" &&
      input.payload.transportPart?.mode === "telegram_markdown_attachment"
    ) {
      attachments.push(telegramMarkdownAttachment(text));
      text =
        input.payload.transportPart.count > 1
          ? "Complete response attached."
          : "Paperclip attached the complete response to preserve its Markdown formatting.";
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
    if (attachments.length) {
      const attachmentMessage: AdapterPostableMessage = {
        attachments,
        markdown: text,
      };
      return await attemptProviderPublication(async () =>
        input.replaceProviderMessageId
          ? await editOrPostProviderPublication(
              () =>
                thread.adapter.editMessage(
                  thread.id,
                  input.replaceProviderMessageId!,
                  attachmentMessage,
                ),
              () => thread.post(attachmentMessage),
            )
          : await thread.post(attachmentMessage),
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
      if (
        input.endpoint.provider === "slack" &&
        !input.replaceProviderMessageId &&
        !input.payload.card &&
        !input.payload.interactionId &&
        !input.publication.idempotencyKey.startsWith("control:") &&
        input.payload.attachmentIds?.length &&
        input.onSlackFileUploadAccepted
      ) {
        return await attemptProviderPublication(
          async () =>
            await endpointRuntime.postSlackFilePublication(
              thread.id,
              fileMessage,
              input.onSlackFileUploadAccepted!,
            ),
        );
      }
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
      !input.payload.transportPart &&
      CAPABILITIES[input.endpoint.provider].nativeStreaming &&
      (input.endpoint.provider !== "telegram" ||
        !input.conversation.isDirectMessage ||
        input.telegramDraftControl !== undefined) &&
      shouldStreamSafePublicationText(text)
    ) {
      return await attemptProviderPublication(async () =>
        input.telegramDraftControl
          ? endpointRuntime.streamTelegramDraft(
              input.conversation.externalThreadId,
              streamSafePublicationText(text),
              input.telegramDraftControl,
            )
          : thread.post(streamSafePublicationText(text)),
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
  return { postSafePublication, recordExactOutboundPublicationLink };
}
