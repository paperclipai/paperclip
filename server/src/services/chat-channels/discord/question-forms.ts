import { createChatSdkStatePersistence } from "../sdk-state.js";

import type { DbTransaction, RuntimeContext, LifecycleRuntimeFence } from "../runtime-types.js";

import {
  and,
  eq,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatConversations,
  chatExternalPrincipals,
  chatPublications,
  issueThreadInteractions,
} from "@paperclipai/db";
import type {
  SafeChatPublicationPayload,
  AskUserQuestionsInteraction,
} from "@paperclipai/shared";

import {
  forbidden,
} from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";
import {
  type ChatSdkCallbackEvent,
} from "../../chat-sdk-runtime.js";
import type {
  ChatSdkStatePersistence,
} from "../../chat-sdk-state.js";

import {
  deleteDiscordQuestionFormCorrection,
  retainDiscordQuestionFormCorrection,
} from "../../chat-discord-question-forms.js";

import { issueThreadInteractionService } from "../../issue-thread-interactions.js";

import {
  isChatQuestionFormOpenActionId,
  loadChatQuestionFormSubmissionToken,
  resolveChatQuestionFormOpen,
} from "../../chat-question-forms.js";
import type {
  ModalResponse,
  ModalSubmitEvent,
} from "chat";
import type { EndpointRecord } from "../runtime-types.js";

import type { ChatQuestionFormValidationResult } from "../../chat-question-forms.js";
type LoadedForm = NonNullable<Awaited<ReturnType<typeof loadChatQuestionFormSubmissionToken>>>;
type DiscordFormActor = { principal: typeof chatExternalPrincipals.$inferSelect; userId: string };
type DiscordFormCorrectionInput = {
  record: EndpointRecord; event: ChatSdkCallbackEvent<ModalSubmitEvent>; runtimeContext: RuntimeContext;
  conversation: typeof chatConversations.$inferSelect; principal: DiscordFormActor; loaded: LoadedForm;
  originalPublication: typeof chatPublications.$inferSelect; providerMessageId: string;
  interaction: AskUserQuestionsInteraction;
  payload: SafeChatPublicationPayload; validation: Exclude<ChatQuestionFormValidationResult, { ok: true }>;
  deny: (code: string) => Promise<ModalResponse>;
};
type DiscordQuestionFormsOptions = {
  requireCurrentExternalActionAuthorization: (tx: DbTransaction, input: { conversationId: string; endpointId: string; expectedUserId: string; principalId: string; runtimeContext: LifecycleRuntimeFence }) => Promise<void>;
  isExternalActionAuthorizationChange: (error: unknown) => boolean;
  persistence: ChatSdkStatePersistence;
};
export function createDiscordQuestionForms(db: Db, options: DiscordQuestionFormsOptions) {
  const { requireCurrentExternalActionAuthorization, isExternalActionAuthorizationChange, persistence } = options;
  const denialError = () => forbidden("This chat form is not a current Paperclip question");
  async function handleDiscordFormCorrection(input: DiscordFormCorrectionInput) {
    const { record, event, runtimeContext, conversation, principal, loaded, originalPublication, providerMessageId, interaction, payload, validation, deny } = input;

    const openAction = payload.card?.actions?.find(
      (action) =>
        action.type === "callback" &&
        isChatQuestionFormOpenActionId(action.actionId),
    );
    const openActionId =
      openAction?.type === "callback" ? openAction.actionId : null;
    if (!openActionId) return deny("chat_modal_open_token_not_current");
    try {
      return await db.transaction(async (tx) => {
        await requireCurrentExternalActionAuthorization(tx, {
          conversationId: conversation.id,
          endpointId: record.endpoint.id,
          expectedUserId: principal.userId!,
          principalId: principal.principal.id,
          runtimeContext,
        });
        const pending = await tx
          .select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions)
          .where(
            and(
              eq(
                issueThreadInteractions.companyId,
                record.endpoint.companyId,
              ),
              eq(issueThreadInteractions.issueId, conversation.issueId),
              eq(issueThreadInteractions.id, interaction.id),
              eq(issueThreadInteractions.status, "pending"),
            ),
          )
          .for("update")
          .then((rows) => rows[0]);
        const resolved = pending
          ? await resolveChatQuestionFormOpen(tx, {
              companyId: record.endpoint.companyId,
              endpointId: record.endpoint.id,
              conversationId: conversation.id,
              interaction,
              openActionId,
            })
          : null;
        if (
          !resolved ||
          resolved.submitActionId !== loaded.payload.formActionId ||
          resolved.publicationId !== originalPublication.id
        )
          throw denialError();
        return retainDiscordQuestionFormCorrection(
          createChatSdkStatePersistence(tx as unknown as Db),
          {
            companyId: record.endpoint.companyId,
            endpointId: record.endpoint.id,
          },
          {
            principalId: principal.principal.id,
            userId: principal.userId!,
            externalUserId: event.event.user.userId,
            conversationId: conversation.id,
            publicationId: originalPublication.id,
            providerMessageId,
            threadId: conversation.externalThreadId,
            interactionId: interaction.id,
            openActionId,
            submitActionId: resolved.submitActionId,
            parentExpiresAt: loaded.payload.expiresAt,
            modal: resolved.modal,
            values: event.event.values,
            fieldErrors: validation.fieldErrors,
          },
        );
      });
    } catch (error) {
      if (
        isExternalActionAuthorizationChange(error) ||
        (error &&
          typeof error === "object" &&
          "status" in error &&
          error.status === 403)
      )
        return deny("chat_modal_correction_not_authorized");
      throw error;
    }

  }
  async function acceptDiscordQuestionForm(input: { record: EndpointRecord; event: ChatSdkCallbackEvent<ModalSubmitEvent>; principal: DiscordFormActor; loaded: LoadedForm }): Promise<ModalResponse> {
    const { record, event, principal, loaded } = input;

    try {
      await deleteDiscordQuestionFormCorrection(
        persistence,
        {
          companyId: record.endpoint.companyId,
          endpointId: record.endpoint.id,
        },
        {
          principalId: principal.principal.id,
          userId: principal.userId!,
          externalUserId: event.event.user.userId,
        },
        loaded.payload.formActionId,
      );
    } catch {
      // The answer receipt is already committed. Cleanup is retryable on
      // exact replay/expiry access and cannot relabel an accepted answer.
      logger.warn(
        {
          endpointId: record.endpoint.id,
          code: "discord_question_correction_cleanup_failed",
        },
        "Discord correction draft cleanup will be retried",
      );
    }

    return { action: "clear" };
  }
  return { handleDiscordFormCorrection, acceptDiscordQuestionForm };
}
