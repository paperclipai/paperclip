import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  heartbeatRuns,
  issueComments,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
} from "@paperclipai/db";
import type { AskUserQuestionsInteraction } from "@paperclipai/shared";
import {
  parseChatQuestionFormSubmitTokenPayload,
  validateChatQuestionFormSubmission,
} from "../chat-question-forms.js";
import { questionResponseDeliveryValues } from "../question-response-delivery.js";
import { nativeSha256 } from "./canonical.js";

export const EXTERNAL_CHAT_QUESTION_RESPONSE_KEY =
  "paperclipExternalChatQuestionResponse";
type Binding = {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
};
type LockMode = "blocking" | "nonblocking" | "read";
type Marker = {
  schema: "paperclip.external_chat_question_response.v1";
  interactionId: string;
  responseDeliveryId: string;
  sourceRunId: string;
  sourceCommentId: string;
  endpointId: string;
  conversationId: string;
  bindingSha256: string;
};
type ResolvedQuestionResponse = {
  marker: Marker;
  provider: typeof chatEndpoints.$inferSelect.provider;
  /** Server-recorded current answer time, already bound into the marker hash. */
  answeredAtMs: number;
  authorizationContext: Record<string, unknown>;
  /** Authoritative answered interactions, oldest first; not persisted answer text. */
  interactionIds: string[];
};
// Keep authorization work/lock duration bounded. A ninth linked answer is
// denied, never admitted with a silently truncated ancestor history.
const MAX_QUESTION_RESPONSE_CHAIN_DEPTH = 8;
type Chain = {
  runIds: Set<string>;
  interactionIds: Set<string>;
  deliveryIds: Set<string>;
  actionIds: Set<string>;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];

function completedQuestionFormMatchesInteraction(
  interaction: AskUserQuestionsInteraction,
  action: typeof chatActions.$inferSelect,
): boolean {
  const payload = parseChatQuestionFormSubmitTokenPayload(action.payload);
  const result = record(action.result);
  const answers = record(interaction.result).answers;
  const resolvedAt =
    interaction.resolvedAt instanceof Date
      ? interaction.resolvedAt
      : new Date(interaction.resolvedAt ?? Number.NaN);
  if (
    !payload ||
    interaction.status !== "answered" ||
    action.providerActionId !== payload.formActionId ||
    payload.interactionId !== interaction.id ||
    result.code !== "question_form_answered" ||
    result.interactionId !== interaction.id ||
    !Number.isFinite(resolvedAt.getTime()) ||
    !Array.isArray(answers) ||
    answers.length !== payload.fields.length
  )
    return false;

  const answerByQuestionId = new Map<string, Record<string, unknown>>();
  for (const value of answers) {
    const answer = record(value);
    const questionId =
      typeof answer.questionId === "string" ? answer.questionId : null;
    if (!questionId || answerByQuestionId.has(questionId)) return false;
    answerByQuestionId.set(questionId, answer);
  }
  const values: Record<string, string> = {};
  for (const field of payload.fields) {
    const answer = answerByQuestionId.get(field.questionId);
    if (!answer) return false;
    const optionIds = ids(answer.optionIds);
    if (
      !Array.isArray(answer.optionIds) ||
      optionIds.length !== answer.optionIds.length
    )
      return false;
    if (field.kind === "single_select") {
      if (
        optionIds.length > 1 ||
        (answer.otherText !== undefined &&
          answer.otherText !== null &&
          answer.otherText !== "")
      )
        return false;
      const option = optionIds[0]
        ? field.options.find((candidate) => candidate.optionId === optionIds[0])
        : null;
      if (optionIds.length === 1 && !option) return false;
      values[field.fieldId] = option?.value ?? "";
      continue;
    }
    if (
      optionIds.length !== 0 ||
      (answer.otherText !== undefined &&
        answer.otherText !== null &&
        typeof answer.otherText !== "string")
    )
      return false;
    values[field.fieldId] =
      typeof answer.otherText === "string" ? answer.otherText : "";
  }
  const validation = validateChatQuestionFormSubmission({
    callbackId: payload.formActionId,
    privateMetadata: payload.formActionId,
    interaction: { ...interaction, status: "pending" },
    payload,
    values,
    // Recheck the durable answer time against the opaque token's lifetime;
    // continuing later must not depend on the current wall clock.
    now: resolvedAt,
  });
  return (
    validation.ok &&
    nativeSha256(validation.answers) === nativeSha256(answers)
  );
}

/**
 * Resolve a durable provider answer or GitHub's authenticated Board fallback,
 * never a caller-supplied wake marker. This
 * is routing/reading authority only: it never checks out a task or resolves a
 * review. Callers retain their issue/run/actor and current destination checks.
 */
export async function resolveExternalChatQuestionResponse(
  tx: Db,
  binding: Binding,
  contextSnapshot: unknown,
  lockMode: LockMode = "blocking",
  mint = false,
): Promise<ResolvedQuestionResponse | null> {
  return resolveQuestionResponseChain(
    tx,
    binding,
    contextSnapshot,
    lockMode,
    mint,
    {
      runIds: new Set(),
      interactionIds: new Set(),
      deliveryIds: new Set(),
      actionIds: new Set(),
    },
  );
}

async function resolveQuestionResponseChain(
  tx: Db,
  binding: Binding,
  contextSnapshot: unknown,
  lockMode: LockMode,
  mint: boolean,
  chain: Chain,
): Promise<ResolvedQuestionResponse | null> {
  if (
    chain.runIds.has(binding.runId) ||
    chain.runIds.size >= MAX_QUESTION_RESPONSE_CHAIN_DEPTH
  )
    return null;
  chain.runIds.add(binding.runId);
  const context = record(contextSnapshot);
  if (
    context.source !== "issue.interaction.respond" ||
    context.issueId !== binding.issueId ||
    context.wakeReason !== "issue_commented" ||
    context.interactionKind !== "ask_user_questions" ||
    context.interactionStatus !== "answered" ||
    context.externalChatContinuation !== true ||
    typeof context.interactionId !== "string" ||
    typeof context.sourceRunId !== "string" ||
    typeof context.sourceCommentId !== "string" ||
    context.wakeCommentId !== context.sourceCommentId ||
    ids(context.wakeCommentIds).length !== 1 ||
    ids(context.wakeCommentIds)[0] !== context.sourceCommentId
  )
    return null;

  const runQuery = tx
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, binding.runId),
        eq(heartbeatRuns.companyId, binding.companyId),
        eq(heartbeatRuns.agentId, binding.agentId),
      ),
    );
  const [run] = await (lockMode === "read"
    ? runQuery
    : lockMode === "nonblocking"
      ? runQuery.for("update", { noWait: true })
      : runQuery.for("update"));
  if (!run?.wakeupRequestId) return null;
  const admitted = record(run.contextSnapshot);
  for (const key of [
    "source",
    "issueId",
    "interactionId",
    "interactionKind",
    "interactionStatus",
    "sourceRunId",
    "sourceCommentId",
    "externalChatContinuation",
    "wakeCommentId",
    "wakeCommentIds",
  ]) {
    if (
      nativeSha256(admitted[key] ?? null) !== nativeSha256(context[key] ?? null)
    )
      return null;
  }

  const query = tx
    .select({
      interaction: issueThreadInteractions,
      delivery: issueQuestionResponseDeliveries,
      wake: agentWakeupRequests,
      source: heartbeatRuns,
    })
    .from(issueThreadInteractions)
    .innerJoin(
      issueQuestionResponseDeliveries,
      and(
        eq(
          issueQuestionResponseDeliveries.interactionId,
          issueThreadInteractions.id,
        ),
        eq(
          issueQuestionResponseDeliveries.companyId,
          issueThreadInteractions.companyId,
        ),
        eq(
          issueQuestionResponseDeliveries.issueId,
          issueThreadInteractions.issueId,
        ),
        eq(
          issueQuestionResponseDeliveries.sourceRunId,
          issueThreadInteractions.sourceRunId,
        ),
      ),
    )
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.id, issueThreadInteractions.sourceRunId),
        eq(heartbeatRuns.companyId, issueThreadInteractions.companyId),
      ),
    )
    .innerJoin(
      agentWakeupRequests,
      and(
        eq(agentWakeupRequests.id, run.wakeupRequestId),
        eq(agentWakeupRequests.companyId, issueThreadInteractions.companyId),
        eq(agentWakeupRequests.agentId, binding.agentId),
        eq(agentWakeupRequests.runId, binding.runId),
      ),
    )
    .where(
      and(
        eq(issueThreadInteractions.id, context.interactionId),
        eq(issueThreadInteractions.companyId, binding.companyId),
        eq(issueThreadInteractions.issueId, binding.issueId),
        eq(issueThreadInteractions.sourceRunId, context.sourceRunId),
      ),
    );
  const rows = await (lockMode === "read"
    ? query
    : lockMode === "nonblocking"
      ? query.for("update", { noWait: true })
      : query.for("update"));
  if (rows.length !== 1) return null;
  const { interaction, delivery, source, wake } = rows[0]!;
  if (
    chain.interactionIds.has(interaction.id) ||
    chain.deliveryIds.has(delivery.id) ||
    chain.runIds.has(source.id)
  )
    return null;
  chain.interactionIds.add(interaction.id);
  chain.deliveryIds.add(delivery.id);
  const sourceContext = record(source.contextSnapshot);
  const sourceWake = record(sourceContext.paperclipWake);
  // A follow-up question inherits no authority from its marker alone. Rebuild
  // every parent proof from current durable state until the direct-chat root.
  const parent =
    sourceContext.source === "issue.interaction.respond"
      ? await resolveQuestionResponseChain(
          tx,
          {
            companyId: binding.companyId,
            agentId: binding.agentId,
            issueId: binding.issueId,
            runId: source.id,
          },
          sourceContext,
          lockMode,
          false,
          chain,
        )
      : null;
  if (sourceContext.source === "issue.interaction.respond" && !parent)
    return null;
  const provider =
    parent?.provider ??
    (
      ["slack", "github", "discord", "microsoft-teams", "telegram"] as const
    ).find(
      (candidate) =>
        sourceContext.source === `chat:${candidate}` ||
        sourceContext.source === `chat:${candidate}:recovery`,
    );
  const sourceIds = ids(sourceContext.wakeCommentIds);
  const wakePayload = record(wake.payload);
  if (
    !provider ||
    source.agentId !== binding.agentId ||
    source.runtimeMode !== "native" ||
    source.nativeIssueId !== binding.issueId ||
    sourceContext.issueId !== binding.issueId ||
    (source.status !== "succeeded" &&
      !(
        source.status === "cancelled" &&
        source.errorCode === "external_chat_continuation"
      )) ||
    sourceWake.externalChatProvider !== provider ||
    !(
      (sourceContext.paperclipHarnessCheckedOut === true &&
        sourceWake.checkedOutByHarness === true) ||
      (sourceContext.paperclipExternalChatExecutionBound === true &&
        sourceWake.externalChatExecutionBound === true)
    ) ||
    sourceIds.length !== 1 ||
    sourceIds[0] !== context.sourceCommentId ||
    (parent !== null &&
      parent.marker.sourceCommentId !== context.sourceCommentId) ||
    interaction.kind !== "ask_user_questions" ||
    interaction.status !== "answered" ||
    interaction.createdByAgentId !== binding.agentId ||
    !interaction.resolvedByUserId ||
    (interaction.sourceCommentId !== null &&
      interaction.sourceCommentId !== context.sourceCommentId) ||
    interaction.resolvedByAgentId !== null ||
    !interaction.resolvedAt ||
    record(interaction.result).cancelled === true ||
    wake.requestedByActorType !== "user" ||
    wake.requestedByActorId !== interaction.resolvedByUserId ||
    wake.idempotencyKey !== `question-response:${interaction.id}` ||
    ["skipped", "cancelled"].includes(wake.status) ||
    wakePayload.issueId !== binding.issueId ||
    wakePayload.interactionId !== interaction.id ||
    wakePayload.sourceRunId !== source.id ||
    wakePayload.sourceCommentId !== context.sourceCommentId ||
    wakePayload.externalChatContinuation !== true ||
    !(
      (delivery.status === "fallback_queued" &&
        delivery.deliveryMode === "wake_fallback" &&
        delivery.targetRunId === binding.runId) ||
      (delivery.status === "delivering" &&
        delivery.targetRunId === null &&
        delivery.deliveryMode === null)
    )
  )
    return null;
  let expected: ReturnType<typeof questionResponseDeliveryValues>;
  try {
    expected = questionResponseDeliveryValues(
      interaction as unknown as AskUserQuestionsInteraction,
    );
  } catch {
    return null;
  }
  if (
    delivery.payloadSha256 !== expected.payloadSha256 ||
    delivery.correlationId !== expected.correlationId
  )
    return null;

  const actionQuery = tx
    .select({
      action: chatActions,
      publication: chatPublications,
      link: chatMessageLinks,
      inbound: chatDeliveries,
      comment: issueComments,
      conversation: chatConversations,
      endpoint: chatEndpoints,
      identity: chatIdentityLinks,
    })
    .from(chatActions)
    .innerJoin(
      chatPublications,
      and(
        sql`${chatActions.payload}->>'publicationId' = ${chatPublications.id}::text`,
        eq(chatPublications.companyId, chatActions.companyId),
        eq(chatPublications.endpointId, chatActions.endpointId),
        eq(chatPublications.conversationId, chatActions.conversationId),
      ),
    )
    .innerJoin(
      chatMessageLinks,
      and(
        eq(chatMessageLinks.companyId, chatActions.companyId),
        eq(chatMessageLinks.endpointId, chatActions.endpointId),
        eq(chatMessageLinks.conversationId, chatActions.conversationId),
        eq(chatMessageLinks.commentId, context.sourceCommentId),
        eq(chatMessageLinks.direction, "inbound"),
      ),
    )
    .innerJoin(
      chatDeliveries,
      and(
        eq(chatDeliveries.id, chatMessageLinks.deliveryId),
        eq(chatDeliveries.companyId, chatActions.companyId),
        eq(chatDeliveries.endpointId, chatActions.endpointId),
        eq(chatDeliveries.conversationId, chatActions.conversationId),
        eq(chatDeliveries.principalId, chatActions.principalId),
      ),
    )
    .innerJoin(
      issueComments,
      and(
        eq(issueComments.id, chatMessageLinks.commentId),
        eq(issueComments.companyId, chatActions.companyId),
        eq(issueComments.issueId, binding.issueId),
      ),
    )
    .innerJoin(
      chatConversations,
      and(
        eq(chatConversations.id, chatActions.conversationId),
        eq(chatConversations.companyId, chatActions.companyId),
        eq(chatConversations.endpointId, chatActions.endpointId),
      ),
    )
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.id, chatActions.endpointId),
        eq(chatEndpoints.companyId, chatActions.companyId),
      ),
    )
    .innerJoin(
      chatIdentityLinks,
      and(
        eq(chatIdentityLinks.companyId, chatActions.companyId),
        eq(chatIdentityLinks.endpointId, chatActions.endpointId),
        eq(chatIdentityLinks.principalId, chatActions.principalId),
      ),
    )
    .where(
      and(
        eq(chatActions.companyId, binding.companyId),
        inArray(chatActions.kind, ["question_answer", "question_form_submit"]),
        eq(chatActions.status, "processed"),
        sql`${chatActions.payload}->>'interactionId' = ${interaction.id}`,
        sql`${chatActions.result}->>'interactionId' = ${interaction.id}`,
      ),
    );
  // GitHub has no executable question callback. Its published link leads to
  // the ordinary authenticated Board answer route, whose pending→answered CAS
  // creates the response delivery above atomically. Do not fabricate a provider
  // action: bind that distinct receipt to the original linked person instead.
  const boardQuery = tx
    .select({
      action: sql<null>`null`,
      publication: chatPublications,
      link: chatMessageLinks,
      inbound: chatDeliveries,
      comment: issueComments,
      conversation: chatConversations,
      endpoint: chatEndpoints,
      identity: chatIdentityLinks,
    })
    .from(chatPublications)
    .innerJoin(
      chatMessageLinks,
      and(
        eq(chatMessageLinks.companyId, chatPublications.companyId),
        eq(chatMessageLinks.endpointId, chatPublications.endpointId),
        eq(chatMessageLinks.conversationId, chatPublications.conversationId),
        eq(chatMessageLinks.commentId, context.sourceCommentId),
        eq(chatMessageLinks.direction, "inbound"),
      ),
    )
    .innerJoin(
      chatDeliveries,
      and(
        eq(chatDeliveries.id, chatMessageLinks.deliveryId),
        eq(chatDeliveries.companyId, chatMessageLinks.companyId),
        eq(chatDeliveries.endpointId, chatMessageLinks.endpointId),
        eq(chatDeliveries.conversationId, chatMessageLinks.conversationId),
      ),
    )
    .innerJoin(
      issueComments,
      and(
        eq(issueComments.id, chatMessageLinks.commentId),
        eq(issueComments.companyId, chatMessageLinks.companyId),
        eq(issueComments.issueId, binding.issueId),
      ),
    )
    .innerJoin(
      chatConversations,
      and(
        eq(chatConversations.id, chatPublications.conversationId),
        eq(chatConversations.companyId, chatPublications.companyId),
        eq(chatConversations.endpointId, chatPublications.endpointId),
      ),
    )
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.id, chatPublications.endpointId),
        eq(chatEndpoints.companyId, chatPublications.companyId),
        eq(chatEndpoints.provider, "github"),
      ),
    )
    .innerJoin(
      chatIdentityLinks,
      and(
        eq(chatIdentityLinks.companyId, chatDeliveries.companyId),
        eq(chatIdentityLinks.endpointId, chatDeliveries.endpointId),
        eq(chatIdentityLinks.principalId, chatDeliveries.principalId),
      ),
    )
    .where(
      and(
        eq(chatPublications.companyId, binding.companyId),
        eq(chatPublications.issueId, binding.issueId),
        sql`${chatPublications.idempotencyKey} = 'interaction:' || ${interaction.id} || ':' || ${chatEndpoints.id}::text`,
        notExists(
          tx
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.companyId, binding.companyId),
                sql`${chatActions.payload}->>'interactionId' = ${interaction.id}`,
                inArray(chatActions.kind, [
                  "question_answer",
                  "question_form_submit",
                ]),
              ),
            ),
        ),
      ),
    );
  const evidenceQuery = provider === "github" ? boardQuery : actionQuery;
  let expectedPrincipalId: string | null = null;
  if (lockMode !== "read") {
    // Identity changes take this advisory lock before their row lock. Resolve
    // the candidate without row locks, acquire that same policy fence, then
    // reread everything under locks. A changed candidate is never adopted.
    const candidates = await evidenceQuery;
    if (candidates.length !== 1 || !candidates[0]!.inbound.principalId)
      return null;
    expectedPrincipalId = candidates[0]!.inbound.principalId;
    const key = `chat-identity:${binding.companyId}:${expectedPrincipalId}`;
    if (lockMode === "blocking") {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
    } else {
      const [lock] = await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`,
      );
      if (!lock?.acquired)
        throw Object.assign(
          new Error("paperclip_external_chat_wait_authorization_contended"),
          { code: "55P03" },
        );
    }
  }
  const actions = await (lockMode === "read"
    ? evidenceQuery
    : lockMode === "nonblocking"
      ? evidenceQuery.for("update", { noWait: true })
      : evidenceQuery.for("update"));
  // One exact provider response, never whichever responder happened to be last.
  if (
    actions.length !== 1 ||
    (expectedPrincipalId !== null &&
      actions[0]!.inbound.principalId !== expectedPrincipalId)
  )
    return null;
  const {
    action,
    publication,
    link,
    inbound,
    comment,
    conversation,
    endpoint,
    identity,
  } = actions[0]!;
  if (action) {
    if (chain.actionIds.has(action.id)) return null;
    chain.actionIds.add(action.id);
  }
  if (
    parent &&
    (parent.marker.endpointId !== endpoint.id ||
      parent.marker.conversationId !== conversation.id)
  )
    return null;
  const boardRuntime = record(record(inbound.normalizedEvent).runtimeContext);
  const boardGeneration = record(endpoint.setup).runtimeGeneration;
  if (!action) {
    const card = record(record(publication.payload).card);
    const links = Array.isArray(card.actions) ? card.actions.map(record) : [];
    if (
      provider !== "github" ||
      interaction.resolvedByRunId !== null ||
      publication.payload.progressState !== "waiting_for_input" ||
      card.kind !== "question" ||
      (card.actions !== undefined && !Array.isArray(card.actions)) ||
      links.some((link) => link.type !== "link") ||
      !publication.publishedAt ||
      publication.publishedAt > interaction.resolvedAt ||
      typeof boardGeneration !== "number" ||
      !Number.isSafeInteger(boardGeneration) ||
      boardGeneration < 0 ||
      boardRuntime.generation !== boardGeneration ||
      typeof boardRuntime.credentialFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(boardRuntime.credentialFingerprint)
    )
      return null;
  } else if (action.kind === "question_answer") {
    const answers = record(interaction.result).answers;
    const selectedAnswer = Array.isArray(answers)
      ? answers
          .map(record)
          .find((answer) => answer.questionId === action.payload.questionId)
      : null;
    const questions = record(interaction.payload).questions;
    const selectedQuestion = Array.isArray(questions)
      ? questions
          .map(record)
          .find((question) => question.id === action.payload.questionId)
      : null;
    if (
      record(action.result).interactionStatus !== "answered" ||
      !selectedAnswer ||
      !selectedQuestion ||
      selectedQuestion.selectionMode !== "single" ||
      ids(selectedAnswer.optionIds).length !== 1 ||
      ids(selectedAnswer.optionIds)[0] !== action.payload.optionId ||
      !Array.isArray(selectedQuestion.options) ||
      !selectedQuestion.options.some(
        (option) => record(option).id === action.payload.optionId,
      )
    )
      return null;
  } else if (
    !completedQuestionFormMatchesInteraction(
      interaction as unknown as AskUserQuestionsInteraction,
      action,
    )
  ) {
    return null;
  }
  if (
    inbound.state !== "processed" ||
    comment.deletedAt !== null ||
    comment.authorUserId !== interaction.resolvedByUserId ||
    conversation.issueId !== binding.issueId ||
    !["active", "waiting"].includes(conversation.state) ||
    endpoint.provider !== provider ||
    endpoint.assignedAgentId !== binding.agentId ||
    endpoint.status !== "active" ||
    publication.state !== "published" ||
    !publication.providerMessageId ||
    publication.issueId !== binding.issueId ||
    record(publication.payload).interactionId !== interaction.id ||
    identity.status !== "linked" ||
    identity.paperclipUserId !== interaction.resolvedByUserId
  )
    return null;
  const marker: Marker = {
    schema: "paperclip.external_chat_question_response.v1",
    interactionId: interaction.id,
    responseDeliveryId: delivery.id,
    sourceRunId: source.id,
    sourceCommentId: comment.id,
    endpointId: endpoint.id,
    conversationId: conversation.id,
    bindingSha256: nativeSha256({
      binding: {
        companyId: binding.companyId,
        issueId: binding.issueId,
        runId: binding.runId,
        agentId: binding.agentId,
      },
      responseDeliveryId: delivery.id,
      payloadSha256: delivery.payloadSha256,
      sourceRunId: source.id,
      sourceIds,
      sourceOrigin: sourceContext.source,
      // Omit this field for a direct-chat parent so deployed v1 proofs remain
      // byte-compatible. A chained proof commits to every validated ancestor.
      ...(parent
        ? { sourceQuestionResponseSha256: parent.marker.bindingSha256 }
        : {}),
      interaction: {
        id: interaction.id,
        payload: interaction.payload,
        result: interaction.result,
        resolvedAt: interaction.resolvedAt.toISOString(),
        resolvedByUserId: interaction.resolvedByUserId,
        createdByAgentId: interaction.createdByAgentId,
      },
      wake: {
        id: wake.id,
        actor: wake.requestedByActorId,
        payload: wake.payload,
      },
      ...(action
        ? {
            action: {
              id: action.id,
              principalId: action.principalId,
              payload: action.payload,
              result: action.result,
            },
          }
        : {
            boardResponse: {
              schema: "paperclip.github_board_question_response.v1",
              principalId: inbound.principalId,
              runtimeGeneration: boardGeneration,
              credentialFingerprint: boardRuntime.credentialFingerprint,
            },
          }),
      publication: {
        id: publication.id,
        providerMessageId: publication.providerMessageId,
      },
      linkId: link.id,
      inboundId: inbound.id,
      comment: { id: comment.id, body: comment.body },
      conversation: {
        id: conversation.id,
        generation: conversation.sessionGeneration,
      },
      endpointId: endpoint.id,
      identityId: identity.id,
    }),
  };
  if (
    !mint &&
    nativeSha256(record(context[EXTERNAL_CHAT_QUESTION_RESPONSE_KEY])) !==
      nativeSha256(marker)
  )
    return null;
  return {
    marker,
    provider,
    answeredAtMs: interaction.resolvedAt.getTime(),
    interactionIds: [...(parent?.interactionIds ?? []), interaction.id],
    authorizationContext: {
      ...context,
      source: `chat:${provider}`,
      paperclipHarnessCheckedOut: false,
      paperclipExternalChatExecutionBound: true,
    },
  };
}
