import type { EndpointRow, DbTransaction, RuntimeContext, LifecycleRuntimeFence } from "../../chat-channels/runtime-types.js";

import { notifyChatPublicationWork } from "../../chat-work-notifications.js";

import { nativeSha256 } from "../../native-runtime/canonical.js";

import { projectSafeChatPublicationText } from "../../chat-publication-projection.js";
import { PhotonAnswerValidationError, nativePhotonInteraction, photonResponseCommand, parsePhotonQuestionAnswer, type PhotonPromptReceipt, type PhotonInteractionBinding, type PhotonDraft } from "../../photon/interactions.js";
import { validateNativeQuestionResponseInput } from "../../native-runtime/native-question-bridge.js";
import type { AskUserQuestionsAnswer, AskUserQuestionsInteraction, IssueThreadInteraction } from "@paperclipai/shared";
import { PhotonError, photonFailure } from "../../photon/cloud.js";
import { PhotonChatAdapter, photonThreadId } from "../../photon/adapter.js";

import type { LiveEvent as PhotonEvent } from "@photon-ai/advanced-imessage";

import {
  and,
  eq,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatPublications,
  issues,
  toolConnections,
} from "@paperclipai/db";

import {
  HttpError,
  forbidden,
} from "../../../errors.js";

import {
  type ChatSdkMessageCallbackEvent,
} from "../../chat-sdk-runtime.js";

import {
  logActivity,
} from "../../activity-log.js";

import { issueThreadInteractionService } from "../../issue-thread-interactions.js";
import {
  questionResponseDeliveryService,
} from "../../question-response-delivery.js";

import type {
  Author,
} from "chat";

import type { EndpointRecord } from "../runtime-types.js";

type PhotonEventsOptions = {
  runtimeCallbackRecord: (endpointId: string, context: RuntimeContext, statuses: EndpointRow["status"][]) => Promise<EndpointRecord | null>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  invalidateRuntime: (endpointId: string) => Promise<boolean>;
  ensurePrincipal: (endpoint: EndpointRow, author: Author, raw?: unknown) => Promise<{ principal: Pick<typeof chatExternalPrincipals.$inferSelect, "id" | "kind" | "isBot">; userId: string | null; linkedDenied: boolean }>;
  requireCurrentExternalActionAuthorization: (tx: DbTransaction, input: { conversationId: string; endpointId: string; expectedUserId: string; principalId: string; runtimeContext: LifecycleRuntimeFence }) => Promise<void>;
  isExternalActionAuthorizationChange: (error: unknown) => boolean;
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  processPendingPublications: () => Promise<unknown>;
  questionResponses: Pick<ReturnType<typeof questionResponseDeliveryService>, "deliver">;
  redactError: (error: unknown) => string;
  renewDiscordGatewayOwnershipForMessageAdmission: (tx: DbTransaction, endpointId: string, context: RuntimeContext) => Promise<{ kind: "owned" | "lost" }>;
  handleSdkMessage: (event: ChatSdkMessageCallbackEvent, runtimeContext?: RuntimeContext, messageOptions?: { receiptReactionSupported?: boolean; slackSlashControl?: boolean }) => Promise<void>;
};

export function createPhotonEvents(db: Db, options: PhotonEventsOptions) {
  const { runtimeCallbackRecord, runtimeCallbackEndpoint, invalidateRuntime, ensurePrincipal, requireCurrentExternalActionAuthorization, isExternalActionAuthorizationChange, scheduleMessageProcessing, processPendingPublications, questionResponses, redactError, renewDiscordGatewayOwnershipForMessageAdmission, handleSdkMessage } = options;


  async function handlePhotonFailure(
    endpointId: string,
    error: unknown,
    context: RuntimeContext,
  ) {
    if (error instanceof PhotonError && error.code === "attachment_not_ready")
      return;
    error = photonFailure(error);
    const fatal =
      error instanceof PhotonError &&
      [
        "credentials",
        "line_unavailable",
        "history_gap",
        "invalid_response",
      ].includes(error.code);
    const message =
      error instanceof PhotonError
        ? error.message
        : "Photon connection interrupted; reconnecting";
    await db.transaction(async (tx) => {
      const endpoint = await runtimeCallbackEndpoint(tx, endpointId, context, [
        "verifying",
        "active",
        "attention",
      ]);
      if (!endpoint) return;
      await tx
        .update(chatEndpoints)
        .set({
          status: "attention",
          healthMessage: message,
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(chatEndpoints.id, endpointId));
      if (fatal)
        await tx
          .update(toolConnections)
          .set({
            enabled: false,
            healthStatus: "error",
            healthMessage: message,
          })
          .where(eq(toolConnections.id, endpoint.connectionId));
    });
    // Retirement is queued outside the receiver callback to avoid self-joining.
    void invalidateRuntime(endpointId).catch(() => undefined);
  }

  async function processPhotonResponse(
    endpoint: EndpointRow,
    event: PhotonEvent,
    threadId: string,
    adapter: PhotonChatAdapter,
    context: RuntimeContext,
  ): Promise<boolean> {
    const command =
      event.type === "message.received"
        ? photonResponseCommand(event.message.content.text ?? "")
        : null;
    const replyGuid =
      event.type === "message.received" ? event.message.replyTargetGuid : null;
    const prompt =
      event.type === "poll.changed"
        ? await adapter.state.read<PhotonPromptReceipt>(
            `poll-message:${event.pollMessageGuid}`,
          )
        : replyGuid
          ? ((await adapter.state.read<PhotonPromptReceipt>(
              `prompt-message:${replyGuid}`,
            )) ??
            (await adapter.state.read<PhotonPromptReceipt>(
              `poll-message:${replyGuid}`,
            )))
          : null;
    const reference = command?.reference ?? prompt?.reference;
    if (!reference) {
      if (
        !event.isFromMe &&
        (replyGuid ||
          (event.type === "poll.changed" &&
            (event.delta.type === "voted" || event.delta.type === "unvoted")))
      ) {
        // A vote can beat the local poll-binding write. Keep it behind the
        // checkpoint while a publication in this chat is in flight.
        const pending = await db
          .select({ id: chatPublications.id })
          .from(chatPublications)
          .innerJoin(
            chatConversations,
            eq(chatConversations.id, chatPublications.conversationId),
          )
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              eq(chatConversations.externalThreadId, threadId),
              inArray(chatPublications.state, [
                "pending",
                "retry",
                "streaming",
                "delivery_unknown",
              ]),
              isNotNull(sql`${chatPublications.payload}->>'interactionId'`),
            ),
          )
          .limit(1);
        if (pending.length)
          throw new PhotonError(
            "attachment_not_ready",
            "Waiting for Photon poll binding",
          );
      }
      return (
        event.type === "poll.changed" ||
        (event.type === "message.received" &&
          /^\/(answer|submit)\b/i.test(event.message.content.text ?? ""))
      );
    }
    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, endpoint.companyId),
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "photon_interaction"),
          eq(chatActions.providerActionId, `photon:${reference}`),
        ),
      )
      .then((rows) => rows[0]);
    if (!action || action.status !== "issued" || !action.conversationId)
      return true;
    const binding = action.payload as unknown as PhotonInteractionBinding;
    if (
      binding.version !== 1 ||
      binding.reference !== reference ||
      !Number.isFinite(Date.parse(binding.expiresAt)) ||
      Date.parse(binding.expiresAt) <= Date.now()
    )
      return true;
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.id, action.conversationId),
        ),
      )
      .then((rows) => rows[0]);
    if (
      !conversation ||
      !["active", "waiting"].includes(conversation.state) ||
      conversation.sessionGeneration !== binding.sessionGeneration ||
      conversation.externalThreadId !== threadId
    )
      return true;
    const publication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, endpoint.companyId),
          eq(chatPublications.endpointId, endpoint.id),
          eq(chatPublications.id, binding.publicationId),
          eq(chatPublications.conversationId, conversation.id),
        ),
      )
      .then((rows) => rows[0]);
    if (
      !publication ||
      publication.payload.interactionId !== binding.interactionId ||
      new Date(event.occurredAt).getTime() < action.createdAt.getTime()
    )
      return true;
    if (
      ["pending", "retry", "streaming", "delivery_unknown"].includes(
        publication.state,
      )
    )
      throw new PhotonError(
        "attachment_not_ready",
        "Waiting for Photon prompt publication",
      );
    if (publication.state !== "published") return true;
    const interaction = (
      await issueThreadInteractionService(db).listForIssue(conversation.issueId)
    ).find((candidate) => candidate.id === binding.interactionId);
    if (
      !interaction ||
      interaction.status !== "pending" ||
      interaction.companyId !== endpoint.companyId ||
      interaction.createdByAgentId !== endpoint.assignedAgentId ||
      !nativePhotonInteraction(interaction)
    )
      return true;
    const actor =
      event.type === "message.received" ? event.message.sender : event.actor;
    if (event.isFromMe || !actor?.address || actor.service !== "iMessage")
      return true;
    const chat = await adapter.chatInfo(threadId);
    if (
      chat.isArchived ||
      !chat.participants.some(
        (person) =>
          person.address === actor.address && person.service === actor.service,
      )
    )
      return true;
    const principal = await ensurePrincipal(
      endpoint,
      {
        userId: `${actor.service}:${actor.address}`,
        userName: actor.address,
        fullName: actor.address,
        isMe: false,
        isBot: false,
      },
      event,
    );
    if (
      !principal.userId ||
      principal.linkedDenied ||
      principal.principal.kind !== "user" ||
      principal.principal.isBot
    )
      return true;
    const assertCurrent = async () =>
      db.transaction((tx) =>
        requireCurrentExternalActionAuthorization(tx, {
          conversationId: conversation.id,
          endpointId: endpoint.id,
          expectedUserId: principal.userId!,
          principalId: principal.principal.id,
          runtimeContext: context,
        }),
      );
    try {
      await assertCurrent();
    } catch (error) {
      if (isExternalActionAuthorizationChange(error)) return true;
      throw error;
    }
    const draftKey = `draft:${reference}:${principal.principal.id}:${principal.userId}`;
    let draft = (await adapter.state.read<PhotonDraft>(draftKey)) ?? {
      schema: 1,
      interactionId: interaction.id,
      principalId: principal.principal.id,
      userId: principal.userId,
      answers: [],
      lastSequence: 0,
    };
    if (draft.lastSequence > event.sequence) return true;
    const questionIndex = command?.questionIndex ?? prompt?.questionIndex ?? 0;
    let answerValue =
      command?.value ??
      (event.type === "message.received"
        ? (event.message.content.text ?? "")
        : "");
    let pollChoice: string | undefined;
    if (event.type === "poll.changed") {
      if (!prompt || event.pollMessageGuid !== prompt.pollMessageGuid)
        return true;
      if (event.delta.type !== "voted" && event.delta.type !== "unvoted")
        return true;
      pollChoice = prompt.options[event.delta.optionIdentifier];
      if (!pollChoice) return true;
      if (event.delta.type === "unvoted") {
        const questionId =
          interaction.kind === "ask_user_questions"
            ? interaction.payload.questions[questionIndex]?.id
            : null;
        await adapter.state.update<PhotonDraft>(draftKey, () => ({
          ...draft,
          answers: draft.answers.filter(
            (answer) =>
              answer.questionId !== questionId ||
              !answer.optionIds.includes(pollChoice!),
          ),
          decision: draft.decision === pollChoice ? undefined : draft.decision,
          lastSequence: event.sequence,
        }));
        return true;
      }
    }
    const enqueueResponse = async (key: string, text: string) => {
      await assertCurrent();
      await db.transaction(async (tx) => {
        await tx
          .insert(chatActions)
          .values({
            companyId: endpoint.companyId,
            endpointId: endpoint.id,
            conversationId: conversation.id,
            kind: "photon_response_notice",
            providerActionId: `photon-notice:${key}`,
            payload: {
              reference,
              questionIndex,
              publicationId: binding.publicationId,
            },
            status: "processed",
          })
          .onConflictDoNothing();
        await notifyChatPublicationWork(tx);
        await tx
          .insert(chatPublications)
          .values({
            companyId: endpoint.companyId,
            endpointId: endpoint.id,
            conversationId: conversation.id,
            issueId: conversation.issueId,
            idempotencyKey: key,
            payload: {
              ...publication.payload,
              card: undefined,
              text: projectSafeChatPublicationText(text),
            },
            state: "pending",
          })
          .onConflictDoNothing();
      });
      scheduleMessageProcessing(() =>
        processPendingPublications().then(() => undefined),
      );
    };
    const notice = (text: string) =>
      enqueueResponse(`photon-response:${reference}:${event.sequence}`, text);
    try {
      if (interaction.kind === "ask_user_questions") {
        if (command?.command !== "submit") {
          let answer: AskUserQuestionsAnswer;
          if (pollChoice) {
            const question = interaction.payload.questions[questionIndex];
            if (
              !question ||
              !question.options.some((option) => option.id === pollChoice)
            )
              return true;
            answer = { questionId: question.id, optionIds: [pollChoice] };
          } else
            answer = parsePhotonQuestionAnswer(
              interaction,
              questionIndex,
              answerValue,
            );
          draft = {
            ...draft,
            answers: [
              ...draft.answers.filter(
                (entry) => entry.questionId !== answer.questionId,
              ),
              answer,
            ],
            lastSequence: event.sequence,
          };
        }
        const answers = interaction.payload.questions.flatMap((question) =>
          draft.answers.filter((answer) => answer.questionId === question.id),
        );
        if (
          interaction.payload.questions.length > 1 &&
          command?.command !== "submit"
        ) {
          await adapter.state.update<PhotonDraft>(draftKey, () => draft);
          const next = interaction.payload.questions.findIndex(
            (question) =>
              !answers.some((answer) => answer.questionId === question.id),
          );
          if (next >= 0)
            await enqueueResponse(
              `photon-question:${reference}:${next}`,
              "Input needed",
            );
          else
            await notice(
              `Your answers are saved. Send /submit ${reference} to submit them.`,
            );
          return true;
        }
        await validateNativeQuestionResponseInput(interaction, { answers });
        // Canonical service rechecks required fields, options, audience, and
        // pending -> answered atomically with the response-delivery receipt.
        const issue = await db
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, endpoint.companyId),
              eq(issues.id, conversation.issueId),
            ),
          )
          .then((rows) => rows[0]);
        if (!issue) return true;
        const answered = await issueThreadInteractionService(
          db,
        ).answerQuestions(
          issue,
          interaction.id,
          { answers },
          { userId: principal.userId },
          {
            beforeResolveInTransaction: async (tx) => {
              await requireCurrentExternalActionAuthorization(tx, {
                conversationId: conversation.id,
                endpointId: endpoint.id,
                expectedUserId: principal.userId!,
                principalId: principal.principal.id,
                runtimeContext: context,
              });
              const current = await tx
                .select()
                .from(chatConversations)
                .where(eq(chatConversations.id, conversation.id))
                .then((rows) => rows[0]);
              if (
                current?.sessionGeneration !== binding.sessionGeneration ||
                Date.parse(binding.expiresAt) <= Date.now()
              )
                throw forbidden(
                  "Photon prompt expired or its task generation changed",
                );
            },
            afterResolveInTransaction: async (tx, resolved) => {
              const claimed = await tx
                .update(chatActions)
                .set({
                  principalId: principal.principal.id,
                  status: "processed",
                  result: {
                    code: "photon_question_answered",
                    interactionId: resolved.id,
                    interactionStatus: resolved.status,
                    answersSha256: nativeSha256(
                      (resolved as AskUserQuestionsInteraction).result?.answers,
                    ),
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
              if (!claimed.length)
                throw forbidden("Photon prompt has already been resolved");
              await logActivity(tx as unknown as Db, {
                companyId: endpoint.companyId,
                actorType: "user",
                actorId: principal.userId!,
                action: "issue.thread_interaction_answered",
                entityType: "issue",
                entityId: issue.id,
                details: {
                  source: "external_chat",
                  provider: endpoint.provider,
                  endpointId: endpoint.id,
                  conversationId: conversation.id,
                  interactionId: resolved.id,
                },
              });
            },
          },
        );
        scheduleMessageProcessing(async () => {
          await questionResponses.deliver(answered.id);
          await processPendingPublications();
        });
      } else {
        if (command?.command === "submit") return true;
        const matched = /^(accept|reject|1|2)(?:\s+([\s\S]+))?$/i.exec(
          answerValue.trim(),
        );
        const decision =
          pollChoice === "accept" || pollChoice === "reject"
            ? pollChoice
            : matched
              ? /^(accept|1)$/i.test(matched[1])
                ? "accept"
                : "reject"
              : draft.decision;
        if (!decision)
          throw new PhotonAnswerValidationError(
            `Send /answer ${reference} Accept or /answer ${reference} Reject <reason>.`,
          );
        const reason =
          matched?.[2]?.trim() ??
          (draft.decision === "reject" && !pollChoice
            ? answerValue.trim()
            : "");
        if (
          decision === "reject" &&
          interaction.payload.rejectRequiresReason &&
          !reason
        ) {
          await adapter.state.update<PhotonDraft>(draftKey, () => ({
            ...draft,
            decision,
            lastSequence: event.sequence,
          }));
          await notice(
            `Give a rejection reason with /answer ${reference} Reject <reason>.`,
          );
          return true;
        }
        const issue = await db
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, endpoint.companyId),
              eq(issues.id, conversation.issueId),
            ),
          )
          .then((rows) => rows[0]);
        if (!issue) return true;
        const mutation = {
          beforeResolveInTransaction: async (tx: DbTransaction) => {
            await requireCurrentExternalActionAuthorization(tx, {
              conversationId: conversation.id,
              endpointId: endpoint.id,
              expectedUserId: principal.userId!,
              principalId: principal.principal.id,
              runtimeContext: context,
            });
            const current = await tx
              .select()
              .from(chatConversations)
              .where(eq(chatConversations.id, conversation.id))
              .then((rows) => rows[0]);
            if (
              current?.sessionGeneration !== binding.sessionGeneration ||
              Date.parse(binding.expiresAt) <= Date.now()
            )
              throw forbidden(
                "Photon prompt expired or its task generation changed",
              );
          },
          afterResolveInTransaction: async (
            tx: DbTransaction,
            resolved: IssueThreadInteraction,
          ) => {
            const claimed = await tx
              .update(chatActions)
              .set({
                principalId: principal.principal.id,
                status: "processed",
                result: {
                  code: "photon_confirmation_resolved",
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
            if (!claimed.length)
              throw forbidden("Photon prompt has already been resolved");
            await logActivity(tx as unknown as Db, {
              companyId: endpoint.companyId,
              actorType: "user",
              actorId: principal.userId!,
              action:
                decision === "accept"
                  ? "issue.thread_interaction_accepted"
                  : "issue.thread_interaction_rejected",
              entityType: "issue",
              entityId: issue.id,
              details: {
                source: "external_chat",
                provider: endpoint.provider,
                endpointId: endpoint.id,
                conversationId: conversation.id,
                interactionId: resolved.id,
              },
            });
          },
        };
        if (decision === "accept")
          await issueThreadInteractionService(db).acceptInteraction(
            issue,
            interaction.id,
            {},
            { userId: principal.userId },
            mutation,
          );
        else
          await issueThreadInteractionService(db).rejectInteraction(
            issue,
            interaction.id,
            { reason },
            { userId: principal.userId },
            mutation,
          );
        scheduleMessageProcessing(async () => {
          await processPendingPublications();
        });
      }
    } catch (error) {
      if (error instanceof PhotonError) throw error;
      if (isExternalActionAuthorizationChange(error)) return true;
      if (error instanceof HttpError && [403, 404, 409].includes(error.status))
        return true;
      // Only validator errors become correction copy. Infrastructure errors
      // leave the checkpoint unchanged and retry through durable recovery.
      if (
        (error instanceof HttpError && error.status === 422) ||
        error instanceof PhotonAnswerValidationError
      ) {
        const missingIndex = interaction.kind === "ask_user_questions" && command?.command === "submit"
          ? interaction.payload.questions.findIndex((question) =>
              question.required !== false && !draft.answers.some((answer) => answer.questionId === question.id))
          : -1;
        await notice(
          `${redactError(error)} Send /answer ${reference}.${(missingIndex >= 0 ? missingIndex : questionIndex) + 1} <answer> to correct it.`,
        );
        return true;
      }
      throw error;
    }
    return true;
  }

  async function handlePhotonEvent(
    endpointId: string,
    event: PhotonEvent,
    context: RuntimeContext,
  ) {
    const record = await runtimeCallbackRecord(endpointId, context, [
      "verifying",
      "active",
      "attention",
    ]);
    if (!record)
      throw new Error("Photon receiver no longer owns this endpoint");
    const adapter = context.endpointRuntime!.getProviderAdapter();
    if (!(adapter instanceof PhotonChatAdapter))
      throw new Error("Photon adapter unavailable");
    if (adapter.authentication.identity.allocation === "shared" && event.type === "group.changed") return;
    if (
      event.type === "group.changed" &&
      (event.change.type === "participantRemoved" ||
        event.change.type === "participantLeft") &&
      event.change.participant.address === record.endpoint.botExternalId
    ) {
      const removedThreadId = photonThreadId({
        lineId: adapter.authentication.identity.lineId,
        chatGuid: event.chatGuid,
        isGroup: true,
      });
      await db.transaction(async (tx) => {
        if (
          !(await runtimeCallbackEndpoint(tx, endpointId, context, [
            "verifying",
            "active",
          ]))
        )
          throw new Error("Photon receiver is no longer current");
        if (
          (
            await renewDiscordGatewayOwnershipForMessageAdmission(
              tx,
              endpointId,
              context,
            )
          ).kind !== "owned"
        )
          throw new Error("Photon receiver lease was replaced");
        // Removal can be the first retained event after activation. Preserve a
        // tombstone even when the group has never been discovered locally.
        await tx
          .insert(chatEndpointResources)
          .values({
            companyId: record.endpoint.companyId,
            endpointId,
            providerResourceId: removedThreadId,
            type: "group_chat",
            label: "Unavailable iMessage group",
            enabled: false,
            availability: "unavailable",
            metadata: { photonRemoved: true },
          })
          .onConflictDoUpdate({
            target: [
              chatEndpointResources.endpointId,
              chatEndpointResources.type,
              chatEndpointResources.providerResourceId,
            ],
            set: {
              availability: "unavailable",
              metadata: sql`jsonb_set(${chatEndpointResources.metadata}, '{photonRemoved}', 'true'::jsonb)`,
              updatedAt: new Date(),
            },
          });
      });
      await adapter.endTyping(removedThreadId);
      return;
    }
    const groupIdentity = photonThreadId({ lineId: adapter.authentication.identity.lineId, chatGuid: event.chatGuid, isGroup: true });
    const removedGroup = await db.select({ metadata: chatEndpointResources.metadata }).from(chatEndpointResources).where(and(eq(chatEndpointResources.companyId, record.endpoint.companyId), eq(chatEndpointResources.endpointId, endpointId), eq(chatEndpointResources.providerResourceId, groupIdentity))).limit(1).then((rows) => rows[0]);
    const readded = event.type === "group.changed" && event.change.type === "participantAdded" && event.change.participant.address === record.endpoint.botExternalId;
    // Late events from a removed chat must still advance recovery without a
    // now-forbidden chat lookup holding every other conversation behind them.
    if (removedGroup?.metadata.photonRemoved === true && !readded) return;
    const chat = await adapter.client.chats
      .get(event.chatGuid)
      .catch((error) => {
        throw photonFailure(error);
      });
    if (chat.guid !== event.chatGuid || chat.service !== "iMessage" || (chat.isGroup && adapter.authentication.identity.allocation === "shared")) return;
    const threadId = photonThreadId({
      lineId: adapter.authentication.identity.lineId,
      chatGuid: chat.guid,
      isGroup: chat.isGroup,
    });
    const removed =
      event.type === "group.changed" &&
      (event.change.type === "participantRemoved" ||
        event.change.type === "participantLeft") &&
      event.change.participant.address === record.endpoint.botExternalId;
    const available = await db.transaction(async (tx) => {
      if (
        !(await runtimeCallbackEndpoint(tx, endpointId, context, [
          "verifying",
          "active",
        ]))
      )
        throw new Error("Photon receiver is no longer current");
      const ownership = await renewDiscordGatewayOwnershipForMessageAdmission(
        tx,
        endpointId,
        context,
      );
      if (ownership.kind !== "owned")
        throw new Error("Photon receiver lease was replaced");
      const existing = await tx
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.endpointId, endpointId),
            eq(chatEndpointResources.providerResourceId, threadId),
            eq(
              chatEndpointResources.type,
              chat.isGroup ? "group_chat" : "direct_message",
            ),
          ),
        )
        .then((rows) => rows[0]);
      const added =
        event.type === "group.changed" &&
        event.change.type === "participantAdded" &&
        event.change.participant.address === record.endpoint.botExternalId;
      const stillRemoved =
        removed || (existing?.metadata.photonRemoved === true && !added);
      const availability =
        stillRemoved || chat.isArchived ? "unavailable" : "available";
      const metadata = {
        photonRemoved: stillRemoved,
        participants: chat.participants
          .slice(0, 256)
          .map((p) => ({ address: p.address, service: p.service })),
      };
      const label = (
        chat.displayName || chat.participants.map((p) => p.address).join(", ")
      ).slice(0, 512);
      await tx
        .insert(chatEndpointResources)
        .values({
          companyId: record.endpoint.companyId,
          endpointId,
          providerResourceId: threadId,
          type: chat.isGroup ? "group_chat" : "direct_message",
          label,
          enabled: !chat.isGroup,
          availability,
          metadata,
        })
        .onConflictDoUpdate({
          target: [
            chatEndpointResources.endpointId,
            chatEndpointResources.type,
            chatEndpointResources.providerResourceId,
          ],
          set: { label, availability, metadata, updatedAt: new Date() },
        });
      return availability === "available";
    });
    if (!available) return;
    if (
      !event.isFromMe &&
      (await processPhotonResponse(
        record.endpoint,
        event,
        threadId,
        adapter,
        context,
      ))
    )
      return;
    if (event.type === "message.received" && !event.isFromMe) {
      await handleSdkMessage(
        {
          provider: "imessage-photon",
          endpointId,
          thread: context.endpointRuntime!.thread(threadId),
          message: adapter.normalize(event.message, chat),
          trigger: chat.isGroup ? "unaddressed_message" : "direct_message",
        },
        context,
      );
    }
  }
  return { handlePhotonFailure, handlePhotonEvent };
}
