import { createChatPublicationReplacement } from "../publication-replacement.js";

import { type ChatRuntime } from "../../chat-runtime.js";
import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";

import { nativePhotonInteraction, publishPhotonPrompt, type PhotonPromptReceipt, type PhotonInteractionBinding } from "../../photon/interactions.js";
import { PhotonError } from "../../photon/cloud.js";
import { PhotonChatAdapter } from "../../photon/adapter.js";
import {
  and,
  desc,
  eq,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatActions,
  chatEndpointResources,
  chatMessageLinks,
  heartbeatRuns,
  issueThreadInteractions,
} from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

import {
  type ChatSdkRuntime,
} from "../../chat-sdk-runtime.js";
import { safeChatTaskUrl } from "../../chat-task-url.js";

import { issueThreadInteractionService } from "../../issue-thread-interactions.js";

import type {
  FileUpload,
} from "chat";

import type { EndpointRecord } from "../runtime-types.js";

import type { PublicationTransportInput } from "../publications/types.js";
import type { Thread } from "chat";
type PhotonPublicationDeliveryOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  runtime: Pick<ChatRuntime | ChatSdkRuntime, "get">;
  receiptReactionCompletionRunId: ReturnType<typeof createChatPublicationReplacement>["receiptReactionCompletionRunId"];
  getTaskBaseUrl: () => string | null | undefined;
};
export function createPhotonPublicationDelivery(db: Db, options: PhotonPublicationDeliveryOptions) {
  const { endpointRecord, runtimeGeneration, runtime, receiptReactionCompletionRunId, getTaskBaseUrl } = options;
  async function deliverPhotonPublication(input: PublicationTransportInput, endpointRuntime: ChatEndpointRuntime, thread: Pick<Thread, "id">, text: string, files: FileUpload[]) {
      const adapter = endpointRuntime.getProviderAdapter();
      if (!(adapter instanceof PhotonChatAdapter))
        throw new Error("Photon publication runtime unavailable");
      const assertCurrent = async () => {
        await input.beforePhotonWrite?.();
        const current = await endpointRecord(input.endpoint.id);
        if (
          !current ||
          !["verifying", "active"].includes(current.endpoint.status) ||
          runtimeGeneration(current.endpoint.setup) !==
            runtimeGeneration(input.endpoint.setup) ||
          runtime.get(input.endpoint.id) !== endpointRuntime
        )
          throw new PhotonError(
            "rejected",
            "Photon publication authority changed",
          );
        const resource = await db
          .select()
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.companyId, current.endpoint.companyId),
              eq(chatEndpointResources.endpointId, current.endpoint.id),
              eq(chatEndpointResources.id, input.conversation.resourceId!),
            ),
          )
          .then((rows) => rows[0]);
        if (
          resource?.availability !== "available" ||
          (!input.conversation.isDirectMessage && !resource.enabled) ||
          (input.conversation.isDirectMessage &&
            !current.endpoint.allowDirectMessages)
        )
          throw new PhotonError(
            "rejected",
            "Photon conversation is no longer enabled",
          );
      };
      const retry = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, input.endpoint.id),
            eq(chatActions.kind, "photon_publication_retry"),
            eq(
              chatActions.providerActionId,
              `photon-retry:${input.publication.id}:${input.publication.attempts + 1}`,
            ),
            eq(chatActions.status, "processed"),
          ),
        )
        .then((rows) => rows[0]);
      const retryUnknown = Boolean(retry);
      const nextQuestion =
        /^photon-question:([a-zA-Z0-9_-]{8,24}):(\d{1,2})$/.exec(
          input.publication.idempotencyKey,
        );
      if (
        input.payload.interactionId &&
        (input.publication.idempotencyKey ===
          `interaction:${input.payload.interactionId}:${input.endpoint.id}` ||
          nextQuestion)
      ) {
        const action = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.companyId, input.endpoint.companyId),
              eq(chatActions.endpointId, input.endpoint.id),
              eq(chatActions.kind, "photon_interaction"),
              nextQuestion
                ? eq(chatActions.providerActionId, `photon:${nextQuestion[1]}`)
                : eq(
                    sql<string>`${chatActions.payload}->>'publicationId'`,
                    input.publication.id,
                  ),
              eq(chatActions.status, "issued"),
            ),
          )
          .then((rows) => rows[0]);
        const interaction = (
          await issueThreadInteractionService(db).listForIssue(
            input.publication.issueId,
          )
        ).find((candidate) => candidate.id === input.payload.interactionId);
        if (
          action &&
          interaction?.status === "pending" &&
          nativePhotonInteraction(interaction)
        ) {
          const promptGuard = async () => {
            await assertCurrent();
            const current = await db
              .select({ status: issueThreadInteractions.status })
              .from(issueThreadInteractions)
              .where(
                and(
                  eq(
                    issueThreadInteractions.companyId,
                    input.endpoint.companyId,
                  ),
                  eq(issueThreadInteractions.id, interaction.id),
                ),
              )
              .then((rows) => rows[0]);
            if (current?.status !== "pending")
              throw new PhotonError(
                "rejected",
                "This interaction has already been resolved",
              );
          };
          const receipt = await publishPhotonPrompt({
            adapter,
            threadId: thread.id,
            binding: action.payload as unknown as PhotonInteractionBinding,
            interaction,
            questionIndex: nextQuestion ? Number(nextQuestion[2]) : 0,
            taskUrl: safeChatTaskUrl(
              getTaskBaseUrl(),
              input.publication.issueId,
            ),
            assertCurrent: promptGuard,
            retryUnknown,
          });
          return { id: receipt.promptMessageGuid };
        }
        if (nextQuestion)
          throw new PhotonError(
            "rejected",
            "This question is no longer available",
          );
      }
      const reply = await adapter.state.read<{ guid: string | null }>(
        `publication-reply:${input.publication.id}`,
      );
      let replyTo = reply?.guid ?? null;
      if (!reply) {
        const sourceRunId = await receiptReactionCompletionRunId(
          db,
          input.publication,
          input.payload,
        );
        if (sourceRunId) {
          const source = await db
            .select({ guid: chatMessageLinks.providerMessageId })
            .from(heartbeatRuns)
            .innerJoin(
              chatMessageLinks,
              and(
                eq(chatMessageLinks.companyId, input.endpoint.companyId),
                eq(chatMessageLinks.endpointId, input.endpoint.id),
                eq(chatMessageLinks.conversationId, input.conversation.id),
                eq(chatMessageLinks.direction, "inbound"),
                or(
                  sql`${chatMessageLinks.commentId}::text = ${heartbeatRuns.contextSnapshot}->>'wakeCommentId'`,
                  sql`coalesce(${heartbeatRuns.contextSnapshot}->'wakeCommentIds', '[]'::jsonb) ? ${chatMessageLinks.commentId}::text`,
                ),
              ),
            )
            .where(
              and(
                eq(heartbeatRuns.id, sourceRunId),
                eq(heartbeatRuns.companyId, input.endpoint.companyId),
              ),
            )
            .orderBy(desc(chatMessageLinks.createdAt))
            .limit(1)
            .then((rows) => rows[0]);
          replyTo = source?.guid ?? null;
        }
        replyTo = (
          await adapter.state.update<{ guid: string | null }>(
            `publication-reply:${input.publication.id}`,
            (current) => current ?? { guid: replyTo },
          )
        ).guid;
      }
      const sent = await adapter.publish(
        thread.id,
        input.publication.id,
        { markdown: text, files },
        { assertCurrent, retryUnknown, replyTo: replyTo ?? undefined },
      );
      if (input.publication.idempotencyKey.startsWith("photon-response:")) {
        const notice = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.companyId, input.endpoint.companyId),
              eq(chatActions.endpointId, input.endpoint.id),
              eq(chatActions.kind, "photon_response_notice"),
              eq(
                chatActions.providerActionId,
                `photon-notice:${input.publication.idempotencyKey}`,
              ),
            ),
          )
          .then((rows) => rows[0]);
        if (
          notice &&
          typeof notice.payload.reference === "string" &&
          typeof notice.payload.questionIndex === "number" &&
          typeof notice.payload.publicationId === "string"
        ) {
          const receipt: PhotonPromptReceipt = {
            schema: 1,
            reference: notice.payload.reference,
            questionIndex: notice.payload.questionIndex,
            publicationId: notice.payload.publicationId,
            promptMessageGuid: sent.id,
            promptMessageGuids: sent.messageIds,
            options: {},
          };
          for (const guid of sent.messageIds)
            await adapter.state.update<PhotonPromptReceipt>(
              `prompt-message:${guid}`,
              (current) => current ?? receipt,
            );
        }
      }
      return sent;
    }
  return { deliverPhotonPublication };
}


export function imessageProgressSupersessionReason(
  progress: SafeChatPublicationPayload["progressState"],
): string | null {
  return progress && ["queued", "working"].includes(progress)
    ? "iMessage uses typing instead of progress bubbles"
    : null;
}