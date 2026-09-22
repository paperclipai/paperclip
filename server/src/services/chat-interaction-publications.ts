import { nativePhotonInteraction } from "./photon/interactions.js";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  chatActions,
  chatConversations,
  chatEndpoints,
  chatPublications,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type {
  AskUserQuestionsInteraction,
  AskUserQuestionsQuestion,
  IssueThreadInteraction,
  RequestConfirmationInteraction,
  SafeExternalChatCardAction,
} from "@paperclipai/shared";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { publicChatTaskUrl } from "./chat-task-url.js";
import {
  chatQuestionFormActionRecords,
  createChatQuestionFormDraft,
} from "./chat-question-forms.js";

const MAX_NATIVE_QUESTION_OPTIONS = 12;
const QUESTION_ACTION_PREFIX = "pcq:";
const QUESTION_ACTION_TOKEN_BYTES = 16;
export const CHAT_QUESTION_ACTION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;

type ChatPublicationDb = Pick<Db, "select" | "insert" | "update">;

/**
 * The idempotency key of a terminal acknowledgement for one card.
 *
 * It is scoped to the *conversation*, not just the endpoint, because a single
 * endpoint can carry several conversations (for example two `#general` threads
 * for the same task). Keying only by endpoint made the second thread's
 * acknowledgement a no-op under the `(company_id, idempotency_key)` unique
 * index, so the board could answer in thread B and never hear back. Every
 * conversation that actually received the card gets its own acknowledgement.
 */
export function interactionResolutionPublicationKey(input: {
  interactionId: string;
  endpointId: string;
  conversationId: string;
}): string {
  return `interaction-resolution:${input.interactionId}:${input.endpointId}:${input.conversationId}`;
}

/** True when `idempotencyKey` is the terminal acknowledgement for this binding. */
export function isInteractionResolutionPublicationKey(input: {
  idempotencyKey: string;
  interactionId: string;
  endpointId: string;
  conversationId: string;
}): boolean {
  return input.idempotencyKey === interactionResolutionPublicationKey(input);
}

function terminalNativeInteractionCopy(
  interaction: IssueThreadInteraction,
): { body: string; text: string } | null {
  if (interaction.kind === "request_confirmation") {
    if (interaction.status === "accepted")
      return { body: "Accepted", text: "Accepted." };
    if (interaction.status === "rejected")
      return { body: "Rejected", text: "Rejected." };
    if (interaction.status === "cancelled") {
      const outcome = interaction.result?.outcome;
      const body =
        outcome === "skipped"
          ? "Skipped in Paperclip"
          : outcome === "withdrawn"
            ? "Withdrawn in Paperclip"
            : outcome === "addressee_deleted"
              ? "Cancelled: addressed agent was removed"
              : "Cancelled in Paperclip";
      return { body, text: `${body}.` };
    }
    if (interaction.status === "expired") {
      const body =
        interaction.result?.outcome === "superseded_by_comment"
          ? "Expired: superseded by a newer reply"
          : interaction.result?.outcome === "superseded_by_newer_request"
            ? "Expired: replaced by a newer request"
            : interaction.result?.outcome === "stale_target"
              ? "Expired: target is no longer current"
              : interaction.result?.outcome === "issue_closed"
                ? "Expired: task is closed"
                : "Expired in Paperclip";
      return { body, text: `${body}.` };
    }
    return null;
  }
  if (interaction.kind !== "ask_user_questions") return null;
  if (interaction.status === "answered") {
    const question = nativeChatQuestion(interaction);
    const answer = question
      ? interaction.result?.answers.find(
          (candidate) => candidate.questionId === question.id,
        )
      : null;
    const option =
      answer?.optionIds.length === 1 && !answer.otherText
        ? question?.options.find(
            (candidate) => candidate.id === answer.optionIds[0],
          )
        : null;
    const body = option ? `Answered: ${option.label}.` : "Answered.";
    return { body, text: body };
  }
  if (interaction.status === "cancelled") {
    const outcome = interaction.result?.outcome;
    const body =
      outcome === "skipped"
        ? "Skipped in Paperclip."
        : outcome === "withdrawn"
          ? "Withdrawn in Paperclip."
          : "Cancelled in Paperclip.";
    return { body, text: body };
  }
  if (interaction.status === "expired") {
    const body =
      interaction.result?.expirationReason === "superseded_by_comment"
        ? "Expired: superseded by a newer reply"
        : interaction.result?.expirationReason ===
            "superseded_by_newer_interaction"
          ? "Expired: replaced by a newer request"
          : interaction.result?.outcome === "issue_closed"
            ? "Expired: task is closed"
            : "Expired in Paperclip";
    return { body, text: `${body}.` };
  }
  return null;
}

export const publicChatInteractionTaskUrl = publicChatTaskUrl;

/**
 * Provider callbacks carry this compact, cryptographically random action id.
 * Its durable chat_actions row is the only mapping back to an interaction,
 * question, and option. Keeping the token opaque avoids exposing canonical ids
 * and fits Telegram's strict 64-byte callback_data envelope.
 */
export function createChatQuestionOptionActionToken(): string {
  return `${QUESTION_ACTION_PREFIX}${randomBytes(QUESTION_ACTION_TOKEN_BYTES).toString("base64url")}`;
}

export function createChatConfirmationActionToken(): string {
  return createChatQuestionOptionActionToken();
}

/** Mirrors the pinned Chat SDK Telegram adapter's exact wire envelope. */
export function telegramChatSdkCallbackData(
  actionId: string,
  value?: string,
): string {
  return `chat:${JSON.stringify({
    a: actionId,
    ...(typeof value === "string" ? { v: value } : {}),
  })}`;
}

export function telegramCallbackDataByteLength(
  actionId: string,
  value?: string,
): number {
  return Buffer.byteLength(
    telegramChatSdkCallbackData(actionId, value),
    "utf8",
  );
}

export function nativeChatQuestion(
  interaction: AskUserQuestionsInteraction,
): AskUserQuestionsQuestion | null {
  if (interaction.payload.questions.length !== 1) return null;
  const question = interaction.payload.questions[0];
  if (
    question.selectionMode !== "single" ||
    question.allowOther === true ||
    question.options.length > MAX_NATIVE_QUESTION_OPTIONS ||
    question.options.some((option) => option.freeText === true)
  ) {
    return null;
  }
  return question;
}

/**
 * Telegram can safely render ordinary binary confirmations as inline buttons.
 * Confirmations that collect a rejection reason or authorize a credential,
 * connection, or tool side effect stay in Paperclip, where the complete
 * governed review UI and permission checks are available.
 */
export function nativeTelegramConfirmation(
  interaction: IssueThreadInteraction,
): RequestConfirmationInteraction | null {
  if (interaction.kind !== "request_confirmation") return null;
  if (
    interaction.payload.rejectRequiresReason === true ||
    interaction.payload.toolAction !== undefined ||
    interaction.payload.secretProposal !== undefined ||
    interaction.payload.connectionAuthorization !== undefined ||
    interaction.payload.target?.type === "issue_document"
  ) {
    return null;
  }
  return interaction;
}

/**
 * Resolves which non-creator agents may carry a pending interaction card on
 * their own endpoint. Two cases qualify, and nothing else:
 *
 * 1. A manager in the creator's `reportsTo` chain of command.
 * 2. The company's CEO, who is the board's single point of contact and already
 *    holds company-wide authority, so carrying a report's gate here does not
 *    widen authority — it only lets that authority be exercised from chat.
 *
 * The endpoint's `assignedAgentId` still has to match one of these ids, the
 * resolver policy on the interaction is unchanged, and the per-endpoint
 * idempotency key means a bridged card is never duplicated. When no manager or
 * CEO exists the set is empty, so the endpoint filter fails closed.
 */
async function resolveBridgedManagerAgentIds(
  db: ChatPublicationDb,
  interaction: IssueThreadInteraction,
  _conversations: Array<typeof chatConversations.$inferSelect>,
): Promise<Set<string>> {
  if (!interaction.createdByAgentId) return new Set();
  const companyAgents = await db
    .select({ id: agents.id, reportsTo: agents.reportsTo, role: agents.role })
    .from(agents)
    .where(eq(agents.companyId, interaction.companyId));
  const byId = new Map(companyAgents.map((agent) => [agent.id, agent]));
  const bridged = new Set<string>();
  let cursor = byId.get(interaction.createdByAgentId)?.reportsTo ?? null;
  for (let depth = 0; cursor && depth < 50; depth += 1) {
    const ancestor = byId.get(cursor);
    if (!ancestor) break;
    bridged.add(ancestor.id);
    cursor = ancestor.reportsTo;
  }
  for (const agent of companyAgents) {
    if (agent.role === "ceo") bridged.add(agent.id);
  }
  bridged.delete(interaction.createdByAgentId);
  return bridged;
}

/**
 * The `#general` thread menu for a pending binary confirmation. Discord has no
 * Approve/Reject buttons, so the card carries numbered choices that a linked
 * user resolves with a bare `1`/`2` reply in the bound thread. The server maps
 * only these numbered choices; every other reply stays ordinary thread input.
 */
function numberedConfirmationText(
  interaction: RequestConfirmationInteraction,
  taskUrl: string | null,
): string {
  const lines = [
    interaction.payload.detailsMarkdown?.trim() ?? interaction.payload.prompt,
    "",
    numberedConfirmationBody(interaction),
  ];
  if (taskUrl) lines.push("", `Or open in Paperclip: ${taskUrl}`);
  return lines.join("\n");
}

function numberedConfirmationBody(
  interaction: RequestConfirmationInteraction,
): string {
  return [
    "Reply in this thread with just the number:",
    `1 — ${interaction.payload.acceptLabel ?? "Approve"}`,
    `2 — ${interaction.payload.rejectLabel ?? "Reject"}${
      interaction.payload.rejectRequiresReason
        ? " (add your reason after the number)"
        : ""
    }`,
  ].join("\n");
}

function textForQuestionInteraction(
  interaction: AskUserQuestionsInteraction,
  taskUrl: string | null,
): string {
  const lines = [
    interaction.payload.title ?? interaction.title ?? "Input needed",
    "",
  ];
  for (const question of interaction.payload.questions) {
    lines.push(question.prompt);
    for (const option of question.options) lines.push(`- ${option.label}`);
    lines.push("");
  }
  lines.push(
    taskUrl
      ? `Open the task in Paperclip to respond: ${taskUrl}`
      : "Open the task in Paperclip to respond.",
  );
  return lines.join("\n");
}

function genericInteractionText(taskUrl: string | null): string {
  return [
    "This task needs an authorized response in Paperclip.",
    taskUrl
      ? `Open the task in Paperclip to respond: ${taskUrl}`
      : "Open the task in Paperclip to respond.",
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

/**
 * Enqueues one immutable outbox item per live external task binding. A lone
 * closed single-select question receives compact executable buttons. Slack and
 * Teams can also receive an opaque modal opener for safe text and closed
 * single-select forms. Unsupported question shapes stay link-only.
 */
export async function enqueueIssueInteractionChatPublications(
  db: ChatPublicationDb,
  interaction: IssueThreadInteraction,
) {
  if (interaction.status !== "pending") return [];
  // The first native-chat wave intentionally externalizes only questions and
  // confirmations. Other governance interactions have richer partial and
  // terminal semantics that are authoritative in Paperclip; projecting a
  // generic link card without complete settlement/recovery would leave stale
  // provider prompts after a board decision.
  if (
    interaction.kind !== "ask_user_questions" &&
    interaction.kind !== "request_confirmation"
  ) {
    return [];
  }
  // An endpoint is one immutable provider bot identity. Never externalize a
  // user/system-authored interaction, or let one agent speak through another
  // agent's endpoint. If the interaction names a source run, verify that run's
  // company and agent instead of trusting the denormalized creator alone.
  if (!interaction.createdByAgentId) return [];
  if (interaction.sourceRunId) {
    const sourceRun = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, interaction.sourceRunId),
          eq(heartbeatRuns.companyId, interaction.companyId),
          eq(heartbeatRuns.agentId, interaction.createdByAgentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!sourceRun) return [];
  }
  const bindings = await db
    .select({
      conversation: chatConversations,
      endpoint: chatEndpoints,
    })
    .from(chatConversations)
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.companyId, chatConversations.companyId),
        eq(chatEndpoints.id, chatConversations.endpointId),
          eq(chatEndpoints.publicationMode, "automatic"),
      ),
    )
    .where(
      and(
        eq(chatConversations.companyId, interaction.companyId),
        eq(chatConversations.issueId, interaction.issueId),
        inArray(chatConversations.state, ["active", "waiting"]),
        inArray(chatEndpoints.status, ["active", "verifying"]),
      ),
    );
  if (bindings.length === 0) return [];

  // An agent speaks only through an endpoint it owns. The one deliberate
  // exception is the owner bridge: a task's assignee can be managed by another
  // agent, and that direct manager's endpoint may carry the gate so the
  // conversation stays in one thread. The bridge mirrors the task binding on
  // the conversation; it never lets an unrelated agent speak, and it does not
  // widen the resolver policy, which is still enforced by the interaction.
  const bridgedManagerIds = await resolveBridgedManagerAgentIds(
    db,
    interaction,
    bindings.map((binding) => binding.conversation),
  );

  const taskUrl = publicChatInteractionTaskUrl(interaction.issueId);
  const question =
    interaction.kind === "ask_user_questions"
      ? nativeChatQuestion(interaction)
      : null;
  const inserted: Array<typeof chatPublications.$inferSelect> = [];
  for (const { conversation, endpoint } of bindings) {
    const ownsEndpoint = endpoint.assignedAgentId === interaction.createdByAgentId;
    const bridgedManager =
      endpoint.assignedAgentId !== null &&
      bridgedManagerIds.has(endpoint.assignedAgentId);
    if (!ownsEndpoint && !bridgedManager) continue;
    const formDraft =
      interaction.kind === "ask_user_questions" &&
      (endpoint.provider === "slack" ||
        endpoint.provider === "discord" ||
        endpoint.provider === "microsoft-teams") &&
      endpoint.capabilities.actions === true &&
      endpoint.capabilities.modals === true
        ? createChatQuestionFormDraft(
            interaction,
            endpoint.provider === "discord"
              ? { nativeProvider: "discord" }
              : {},
          )
        : null;
    const supportsCallbacks =
      endpoint.provider !== "imessage-photon" &&
      formDraft === null &&
      question !== null &&
      endpoint.capabilities.actions === true;
    const questionActionTokens = supportsCallbacks
      ? question.options.map((option) => ({
          actionId: createChatQuestionOptionActionToken(),
          option,
        }))
      : [];
    const confirmation =
      endpoint.provider === "telegram" && endpoint.capabilities.actions === true
        ? nativeTelegramConfirmation(interaction)
        : null;
    const confirmationActionTokens = confirmation
      ? (["accept", "reject"] as const).map((decision) => ({
          actionId: createChatConfirmationActionToken(),
          decision,
        }))
      : [];
    if (
      endpoint.provider === "telegram" &&
      [...questionActionTokens, ...confirmationActionTokens].some(
        ({ actionId }) =>
          telegramCallbackDataByteLength(actionId) >
          TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
      )
    ) {
      throw new Error("Generated Telegram question action exceeds 64 bytes");
    }
    const actions: SafeExternalChatCardAction[] = formDraft
      ? [
          {
            type: "callback" as const,
            actionId: formDraft.openActionId,
            label: "Respond",
            style: "primary" as const,
          },
        ]
      : supportsCallbacks
        ? questionActionTokens.map(({ actionId, option }) => ({
            type: "callback" as const,
            actionId,
            label: option.label,
          }))
        : confirmation
          ? confirmationActionTokens.map(({ actionId, decision }) => ({
              type: "callback" as const,
              actionId,
              label:
                decision === "accept"
                  ? (confirmation.payload.acceptLabel ?? "Accept")
                  : (confirmation.payload.rejectLabel ?? "Reject"),
              style:
                decision === "accept"
                  ? ("primary" as const)
                  : ("danger" as const),
            }))
          : taskUrl
            ? [
                {
                  type: "link" as const,
                  label: "Open in Paperclip",
                  url: taskUrl,
                },
              ]
            : [];
    // Providers without native confirmation actions render the binary gate as
    // numbered text choices; the linked user's bare `1`/`2` thread reply is
    // mapped back to accept/reject by the inbound handler.
    const linkOnlyConfirmation =
      interaction.kind === "request_confirmation" && confirmation === null;
    const text =
      interaction.kind === "ask_user_questions"
        ? textForQuestionInteraction(interaction, taskUrl)
        : linkOnlyConfirmation
          ? numberedConfirmationText(interaction, taskUrl)
          : genericInteractionText(taskUrl);
    const payload = projectSafeChatPublication({
      classification: "external",
      source: "issue_interaction",
      text,
      progressState: "waiting_for_input",
      interaction: {
        id: interaction.id,
        card: {
          kind:
            interaction.kind === "ask_user_questions"
              ? "question"
              : interaction.kind === "request_confirmation"
                ? "confirmation"
                : "status",
          title:
            interaction.kind === "ask_user_questions"
              ? (question?.prompt ??
                interaction.payload.title ??
                interaction.title ??
                "Input needed")
              : interaction.kind === "request_confirmation"
                ? interaction.payload.prompt
                : "Response needed in Paperclip",
          body:
            interaction.kind === "ask_user_questions"
              ? (question?.helpText ?? undefined)
              : interaction.kind === "request_confirmation"
                ? linkOnlyConfirmation
                  ? numberedConfirmationBody(interaction)
                  : (interaction.payload.detailsMarkdown ?? undefined)
                : "Open the task in Paperclip to review and respond.",
          actions,
        },
      },
    });
    const rows = await db
      .insert(chatPublications)
      .values({
        companyId: interaction.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: interaction.issueId,
        idempotencyKey: `interaction:${interaction.id}:${endpoint.id}`,
        payload,
        state: "pending",
      })
      .onConflictDoNothing()
      .returning();
    const publication = rows[0];
    if (publication && endpoint.provider === "imessage-photon" && nativePhotonInteraction(interaction)) {
      const reference = randomBytes(9).toString("base64url");
      await db.insert(chatActions).values({ companyId: interaction.companyId, endpointId: endpoint.id, conversationId: conversation.id,
        kind: "photon_interaction", providerActionId: `photon:${reference}`,
        payload: { version: 1, reference, interactionId: interaction.id, publicationId: publication.id, sessionGeneration: conversation.sessionGeneration,
          expiresAt: new Date(publication.createdAt.getTime() + CHAT_QUESTION_ACTION_TOKEN_TTL_MS).toISOString() }, status: "issued" });
    } else if (publication && formDraft) {
      await db.insert(chatActions).values(
        chatQuestionFormActionRecords(formDraft, {
          companyId: interaction.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          publicationId: publication.id,
        }),
      );
    } else if (publication && question && questionActionTokens.length > 0) {
      const expiresAt = new Date(
        publication.createdAt.getTime() + CHAT_QUESTION_ACTION_TOKEN_TTL_MS,
      ).toISOString();
      await db.insert(chatActions).values(
        questionActionTokens.map(({ actionId, option }) => ({
          companyId: interaction.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          kind: "question_answer",
          providerActionId: actionId,
          payload: {
            version: 1,
            publicationId: publication.id,
            interactionId: interaction.id,
            questionId: question.id,
            optionId: option.id,
            expiresAt,
          },
          status: "issued",
        })),
      );
    } else if (
      publication &&
      confirmation &&
      confirmationActionTokens.length > 0
    ) {
      const expiresAt = new Date(
        publication.createdAt.getTime() + CHAT_QUESTION_ACTION_TOKEN_TTL_MS,
      ).toISOString();
      await db.insert(chatActions).values(
        confirmationActionTokens.map(({ actionId, decision }) => ({
          companyId: interaction.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          kind: "confirmation_response",
          providerActionId: actionId,
          payload: {
            version: 1,
            publicationId: publication.id,
            interactionId: interaction.id,
            decision,
            expiresAt,
          },
          status: "issued",
        })),
      );
    }
    inserted.push(...rows);
  }
  return inserted;
}

/**
 * Where a settled card must be acknowledged. Mirrored cards carry their own
 * endpoint/conversation through their publication row; a card delivered without
 * one resolves the same conversations the enqueue path would have used.
 */
type InteractionSettlementTarget = {
  endpointId: string;
  conversationId: string;
  cardKind: "confirmation" | "question" | "status";
  cardTitle: string;
};

/**
 * Decides where a settled card must be acknowledged.
 *
 * A card mirrored by `enqueueIssueInteractionChatPublications` always leaves an
 * interaction-keyed publication row, so settlement addresses exactly the
 * conversations that received it — and stays silent when that row was never
 * provider-visible, because the card was never delivered.
 *
 * A card with no mirror row has no durable record of where (or whether) it was
 * delivered. Settlement must fail closed rather than broadcast a resolution to
 * every live conversation bound to the task: a task can carry several threads,
 * and only one of them may have shown the card. The resolution conversation is
 * acknowledged by its own mirror when the card went through the publication
 * pipeline.
 */
export function selectInteractionSettlementTargets<T extends { endpointId: string; conversationId: string }>(input: {
  /** Whether any `interaction:{id}:{endpointId}` publication row exists. */
  hasMirroredOriginal: boolean;
  /** Mirrored rows that were actually delivered to the provider. */
  providerVisibleTargets: T[];
}): T[] {
  return input.hasMirroredOriginal ? input.providerVisibleTargets : [];
}

/**
 * Live task conversations eligible to receive an internal continuation wake for
 * a card that was delivered without a mirrored `interaction:` publication row.
 *
 * Settlement never uses these targets: a terminal external publication must
 * address only the conversation that actually showed the card, and that binding
 * lives on the mirrored row. This resolver exists solely so the assignee agent
 * still wakes when the board answers a card that has no durable delivery row.
 */
async function resolveInteractionSettlementTargets(
  db: ChatPublicationDb,
  interaction: IssueThreadInteraction,
): Promise<InteractionSettlementTarget[]> {
  const bridgedManagerIds = await resolveBridgedManagerAgentIds(
    db,
    interaction,
    [],
  );
  const rows = await db
    .select({
      conversation: chatConversations,
      endpoint: chatEndpoints,
    })
    .from(chatConversations)
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.companyId, chatConversations.companyId),
        eq(chatEndpoints.id, chatConversations.endpointId),
        eq(chatEndpoints.publicationMode, "automatic"),
      ),
    )
    .where(
      and(
        eq(chatConversations.companyId, interaction.companyId),
        eq(chatConversations.issueId, interaction.issueId),
        inArray(chatConversations.state, ["active", "waiting"]),
        inArray(chatEndpoints.status, ["active", "verifying"]),
      ),
    );
  const cardKind: "confirmation" | "question" =
    interaction.kind === "request_confirmation" ? "confirmation" : "question";
  // Match the mirrored-card title so a fallback follow-up reads the same as the
  // card it settles: confirmations are titled by their prompt, questions by the
  // native question prompt.
  let cardTitle: string;
  if (interaction.kind === "request_confirmation") {
    cardTitle = interaction.payload.prompt;
  } else if (interaction.kind === "ask_user_questions") {
    cardTitle =
      nativeChatQuestion(interaction)?.prompt ??
      interaction.payload.title ??
      interaction.title ??
      "Input needed";
  } else {
    cardTitle = interaction.title ?? "Input needed";
  }
  const targets: InteractionSettlementTarget[] = [];
  for (const { conversation, endpoint } of rows) {
    const ownsEndpoint =
      endpoint.assignedAgentId === interaction.createdByAgentId;
    const bridgedManager =
      endpoint.assignedAgentId !== null &&
      bridgedManagerIds.has(endpoint.assignedAgentId);
    if (!ownsEndpoint && !bridgedManager) continue;
    targets.push({
      endpointId: endpoint.id,
      conversationId: conversation.id,
      cardKind,
      cardTitle,
    });
  }
  return targets;
}

/**
 * Settles every delivered question or confirmation card. Providers without a
 * native callback receive the same actionless terminal edit/follow-up as
 * providers with buttons, so an "Open in Paperclip" prompt never remains
 * visibly pending after the authoritative board decision.
 *
 * The terminal publication shares the provider callback idempotency key. If a
 * provider click wins the race, its handler converges on the same row; if the
 * Paperclip UI wins, all still-issued callback tokens expire in this same
 * authoritative resolution transaction.
 */
export async function enqueueTerminalIssueInteractionChatPublications(
  db: ChatPublicationDb,
  interaction: IssueThreadInteraction,
) {
  if (interaction.status === "pending") return [];
  const originals = (
    await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, interaction.companyId),
          eq(chatPublications.issueId, interaction.issueId),
          eq(
            sql<string>`${chatPublications.payload}->>'interactionId'`,
            interaction.id,
          ),
        ),
      )
  ).filter(
    (publication) =>
      publication.idempotencyKey ===
      `interaction:${interaction.id}:${publication.endpointId}`,
  );

  await db
    .update(chatActions)
    .set({
      status: "expired",
      result: { code: "interaction_resolved_elsewhere" },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatActions.companyId, interaction.companyId),
        inArray(chatActions.kind, [
          "photon_interaction",
          "question_answer",
          "question_form_open",
          "question_form_submit",
          "confirmation_response",
          "photon_interaction",
        ]),
        eq(chatActions.status, "issued"),
        eq(
          sql<string>`${chatActions.payload}->>'interactionId'`,
          interaction.id,
        ),
      ),
    );

  const unsentIds = originals
    .filter(
      (publication) =>
        publication.state === "pending" || publication.state === "retry",
    )
    .map((publication) => publication.id);
  if (unsentIds.length > 0) {
    await db
      .update(chatPublications)
      .set({
        state: "cancelled",
        nextAttemptAt: null,
        redactedError: "Interaction was resolved before provider publication",
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(chatPublications.id, unsentIds),
          inArray(chatPublications.state, ["pending", "retry"]),
        ),
      );
  }

  const originalIds = originals.map((publication) => publication.id);
  // The dispatcher may claim pending -> streaming after the first read but
  // before the cancellation CAS. Re-read every executable original after that
  // CAS so a loser is treated as potentially provider-visible and receives a
  // terminal replacement instead of being decided from the stale snapshot.
  // A published row without a provider id is also potentially visible: that
  // is the durable result of an operator choosing `mark_delivered` after an
  // ambiguous send, so resolution must post a terminal follow-up rather than
  // leaving the external card looking actionable forever.
  const currentOriginals =
    originalIds.length > 0
      ? await db
          .select()
          .from(chatPublications)
          .where(inArray(chatPublications.id, originalIds))
      : [];
  const providerVisibleOriginals = currentOriginals.filter(
    (original) =>
      original.state === "streaming" ||
      original.state === "delivery_unknown" ||
      original.state === "published",
  );
  const mirroredTargets: InteractionSettlementTarget[] = providerVisibleOriginals
    .filter((original) => Boolean(original.payload.card))
    .map((original) => ({
      endpointId: original.endpointId,
      conversationId: original.conversationId,
      cardKind: original.payload.card!.kind,
      cardTitle: original.payload.card!.title,
    }));
  const settlementTargets = selectInteractionSettlementTargets({
    hasMirroredOriginal: originals.length > 0,
    providerVisibleTargets: mirroredTargets,
  });
  const planTarget =
    interaction.kind === "request_confirmation" &&
    interaction.payload.target?.type === "issue_document" &&
    interaction.payload.target.issueId === interaction.issueId &&
    interaction.payload.target.key === "plan"
      ? interaction.payload.target
      : null;
  const rejectedPlanNeedsRevision =
    interaction.status === "rejected" && planTarget !== null;
  const resolutionOutcome = (interaction.result as { outcome?: unknown } | null)
    ?.outcome;
  const continuationWakeRequired =
    interaction.status !== "expired" &&
    resolutionOutcome !== "skipped" &&
    !(
      interaction.kind === "ask_user_questions" &&
      interaction.status === "answered"
    ) &&
    (interaction.continuationPolicy === "wake_assignee" ||
      (interaction.continuationPolicy === "wake_assignee_on_accept" &&
        (interaction.status === "accepted" ||
          interaction.status === "answered")) ||
      rejectedPlanNeedsRevision);
  // The wake follows the card's original delivery binding when one exists —
  // including a card that was cancelled before it became provider-visible, which
  // the assignee must still learn about. Only a card with no original row at all
  // resolves the live task conversations, and only for this internal wake: an
  // external settlement publication must never broadcast to unrelated threads.
  const courierWakeTargets =
    continuationWakeRequired && currentOriginals.length === 0
      ? await resolveInteractionSettlementTargets(db, interaction)
      : [];
  const wakeBinding = currentOriginals[0] ?? courierWakeTargets[0] ?? null;
  if (continuationWakeRequired && wakeBinding) {
    const issue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, interaction.companyId),
          eq(issues.id, interaction.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    const requestedByActorType = interaction.resolvedByUserId
      ? "user"
      : interaction.resolvedByAgentId
        ? "agent"
        : "system";
    const requestedByActorId =
      interaction.resolvedByUserId ??
      interaction.resolvedByAgentId ??
      "system:interaction-resolution";
    if (
      issue?.assigneeAgentId &&
      issue.status !== "done" &&
      issue.status !== "cancelled" &&
      !(
        resolutionOutcome === "withdrawn" &&
        interaction.resolvedByAgentId === issue.assigneeAgentId
      )
    ) {
      await db
        .insert(chatActions)
        .values({
          companyId: interaction.companyId,
          endpointId: wakeBinding.endpointId,
          conversationId: wakeBinding.conversationId,
          kind: "interaction_wakeup",
          providerActionId: `interaction_wakeup:${interaction.id}`,
          payload: {
            version: 1,
            interactionId: interaction.id,
            interactionKind: interaction.kind,
            interactionStatus: interaction.status,
            issueId: interaction.issueId,
            agentId: issue.assigneeAgentId,
            sourceCommentId: interaction.sourceCommentId ?? null,
            sourceRunId: interaction.sourceRunId ?? null,
            requestedByActorType,
            requestedByActorId,
            ...(planTarget
              ? {
                  planReviewInteraction: {
                    id: interaction.id,
                    kind: interaction.kind,
                    status: interaction.status,
                    target: planTarget,
                    acceptedTargetRevision:
                      interaction.status === "accepted" ? planTarget : null,
                    result: interaction.result,
                  },
                }
              : {}),
            ...(interaction.status === "accepted" && planTarget
              ? {
                  forceFreshSession: true,
                  workspaceRefreshReason: "accepted_plan_confirmation",
                }
              : {}),
            ...(interaction.resolvedByUserId
              ? { requestedByUserId: interaction.resolvedByUserId }
              : {}),
          },
          status: "issued",
        })
        .onConflictDoNothing();
    }
  }

  const copy = terminalNativeInteractionCopy(interaction);
  if (!copy) return [];
  const inserted: Array<typeof chatPublications.$inferSelect> = [];
  for (const target of settlementTargets) {
    const rows = await db
      .insert(chatPublications)
      .values({
        companyId: interaction.companyId,
        endpointId: target.endpointId,
        conversationId: target.conversationId,
        issueId: interaction.issueId,
        idempotencyKey: interactionResolutionPublicationKey({
          interactionId: interaction.id,
          endpointId: target.endpointId,
          conversationId: target.conversationId,
        }),
        payload: projectSafeChatPublication({
          classification: "external",
          source: "issue_interaction",
          text: copy.text,
          interaction: {
            id: interaction.id,
            card: {
              kind: target.cardKind,
              title: target.cardTitle,
              body: copy.body,
              actions: [],
            },
          },
        }),
        state: "pending",
      })
      .onConflictDoNothing()
      .returning();
    inserted.push(...rows);
  }
  return inserted;
}

/** Prevents an unstarted stale question card from being sent after replacement. */
export async function cancelPendingIssueInteractionChatPublications(
  db: ChatPublicationDb,
  input: {
    companyId: string;
    issueId: string;
    interactionIds: readonly string[];
  },
) {
  if (input.interactionIds.length === 0) return [];
  await db
    .update(chatActions)
    .set({
      status: "expired",
      result: { code: "interaction_superseded_before_publication" },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatActions.companyId, input.companyId),
        inArray(chatActions.kind, [
          "question_answer",
          "question_form_open",
          "question_form_submit",
          "confirmation_response",
          "photon_interaction",
        ]),
        eq(chatActions.status, "issued"),
        inArray(sql<string>`${chatActions.payload}->>'interactionId'`, [
          ...input.interactionIds,
        ]),
      ),
    );
  return db
    .update(chatPublications)
    .set({
      state: "cancelled",
      nextAttemptAt: null,
      redactedError: "Interaction was superseded before publication",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatPublications.companyId, input.companyId),
        eq(chatPublications.issueId, input.issueId),
        inArray(chatPublications.state, ["pending", "retry"]),
        inArray(sql<string>`${chatPublications.payload}->>'interactionId'`, [
          ...input.interactionIds,
        ]),
      ),
    )
    .returning();
}
