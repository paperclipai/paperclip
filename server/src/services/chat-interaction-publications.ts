import { chatInteractionForm } from "./chat-interaction-forms.js";
import { slackInteractionRequiresBoard } from "./chat-channels/slack/cards.js";
import { answeredChatQuestionBody, chatInteractionPresentation } from "./chat-interaction-presentation.js";
import { notifyChatPublicationWork } from "./chat-work-notifications.js";
import { nativePhotonInteraction } from "./photon/interactions.js";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
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
  RequestCheckboxConfirmationInteraction,
  SuggestTasksInteraction,
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

type ChatPublicationDb = Pick<Db, "select" | "insert" | "update" | "transaction">;

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
  if (interaction.kind === "request_checkbox_confirmation" && interaction.status === "accepted") {
    const labels = interaction.payload.options.filter(option => interaction.result?.selectedOptionIds?.includes(option.id)).map(option => option.label);
    const body = labels.length ? `Saved checks: ${labels.join("; ")}` : "Saved checks: none selected.";
    return { body, text: body };
  }
  if (interaction.kind === "request_item_verdicts" && interaction.status === "answered") {
    const body = interaction.payload.items.map(item => {
      const result = interaction.result?.items.find(result => result.id === item.id);
      return `${item.label}: ${result?.verdict ?? "pending"}${result?.reason ? ` — ${result.reason}` : ""}`;
    }).join("\n\n");
    return { body, text: body };
  }
  if (interaction.kind === "suggest_tasks" && (interaction.status === "accepted" || interaction.status === "rejected")) {
    const body = interaction.status === "rejected" ? "Dismissed — no tasks created." :
      (interaction.result?.createdTasks ?? []).map(task => {
        const url = publicChatTaskUrl(task.issueId);
        return `Created: ${task.identifier ?? "Task"} — ${task.title}${url ? `\n${url}` : ""}`;
      }).join("\n\n");
    return { body, text: body };
  }
  if (interaction.kind === "connection_intent" && (interaction.status === "accepted" || interaction.status === "rejected")) {
    const body = interaction.status === "accepted" ? `Connected: ${interaction.payload.serviceName}` : `Declined: ${interaction.payload.serviceName}. No access was granted.`;
    return { body, text: body };
  }
  if (interaction.kind !== "ask_user_questions") {
    const body = ({ accepted: "Accepted", rejected: "Rejected", answered: "Answered", cancelled: "Cancelled in Paperclip", expired: "Expired in Paperclip" } as Record<string, string>)[interaction.status];
    return body ? { body, text: `${body}.` } : null;
  }
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
    const body = option ? `Answered: ${option.label}.` : answeredChatQuestionBody(interaction);
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
  maxOptions = MAX_NATIVE_QUESTION_OPTIONS,
): AskUserQuestionsQuestion | null {
  if (interaction.payload.questions.length !== 1) return null;
  const question = interaction.payload.questions[0];
  if (
    question.selectionMode !== "single" ||
    question.allowOther === true ||
    question.options.length > maxOptions ||
    question.options.some((option) => option.freeText === true)
  ) {
    return null;
  }
  return question;
}

export function nativeChatCustomQuestion(interaction: AskUserQuestionsInteraction): AskUserQuestionsQuestion | null {
  const question = interaction.payload.questions[0];
  if (interaction.payload.questions.length !== 1 || !question || question.selectionMode !== "single" || !question.allowOther ||
      !interaction.payload.questionSet?.questions[0]?.customAnswer) return null;
  const options = question.options.filter(option => !option.freeText);
  return options.length > 0 && options.length <= 100 ? { ...question, options } : null;
}

export function nativeChatMultiQuestion(interaction: AskUserQuestionsInteraction): AskUserQuestionsQuestion | null {
  const question = interaction.payload.questions[0];
  if (interaction.payload.questions.length !== 1 || !question || question.selectionMode !== "multi" || question.allowOther || question.options.length === 0 || question.options.length > 100 || question.options.some(option => option.freeText)) return null;
  return question;
}

export function nativeChatSuggestions(interaction: IssueThreadInteraction): SuggestTasksInteraction | null {
  return interaction.kind === "suggest_tasks" && interaction.payload.tasks.filter(task => !task.hiddenInPreview).length > 0 && interaction.payload.tasks.length <= 100 ? interaction : null;
}

export function nativeChatCheckbox(interaction: IssueThreadInteraction): RequestCheckboxConfirmationInteraction | null {
  return interaction.kind === "request_checkbox_confirmation" && !interaction.payload.rejectRequiresReason &&
    interaction.payload.target?.type !== "issue_document" && interaction.payload.options.length <= 100 ? interaction : null;
}

/**
 * Slack and Telegram can render ordinary binary confirmations as inline buttons.
 * Confirmations that collect a rejection reason or authorize a credential,
 * connection, or tool side effect stay in Paperclip, where the complete
 * governed review UI and permission checks are available.
 */
export function nativeChatConfirmation(
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

  const taskUrl = publicChatInteractionTaskUrl(interaction.issueId);
  const inserted: Array<typeof chatPublications.$inferSelect> = [];
  for (const { conversation, endpoint } of bindings) {
    if (endpoint.assignedAgentId !== interaction.createdByAgentId) continue;
    if (endpoint.provider !== "slack" && interaction.kind !== "ask_user_questions" && interaction.kind !== "request_confirmation") continue;
    let connectionDecline = endpoint.provider === "slack" && endpoint.capabilities.actions && interaction.kind === "connection_intent" ? interaction : null;
    let suggestions = endpoint.provider === "slack" && endpoint.capabilities.actions ? nativeChatSuggestions(interaction) : null;
    const suggestedOptions = suggestions?.payload.tasks.filter(task => !task.hiddenInPreview).map(task => ({ actionId: createChatQuestionOptionActionToken(), option: { id: task.clientKey, label: task.title, description: task.description } })) ?? [];
    let checklist = endpoint.provider === "slack" && endpoint.capabilities.actions ? nativeChatCheckbox(interaction) : null;
    const checklistOptions = checklist?.payload.options.map(option => ({ actionId: createChatQuestionOptionActionToken(), option })) ?? [];
    const customQuestion = endpoint.provider === "slack" && endpoint.capabilities.modals === true && interaction.kind === "ask_user_questions" ? nativeChatCustomQuestion(interaction) : null;
    const multipleQuestion = endpoint.provider === "slack" && interaction.kind === "ask_user_questions" ? nativeChatMultiQuestion(interaction) : null;
    const question = interaction.kind === "ask_user_questions"
      ? multipleQuestion ?? customQuestion ?? nativeChatQuestion(interaction, endpoint.provider === "slack" ? 100 : MAX_NATIVE_QUESTION_OPTIONS) : null;
    const inlineSelection = endpoint.provider === "slack" && question && (multipleQuestion !== null || question.options.length > 5);
    const multipleActionId = multipleQuestion ? createChatQuestionOptionActionToken() : null;
    const presentation = chatInteractionPresentation(interaction, { compactChoices: Boolean(inlineSelection || checklist || suggestedOptions.length > 1), nativeCustomAnswer: Boolean(customQuestion) });
    const requiresBoard = endpoint.provider === "slack" && slackInteractionRequiresBoard(presentation.body);
    if (requiresBoard) {
      connectionDecline = null;
      suggestions = null;
      checklist = null;
    }
    const formInteraction = chatInteractionForm(interaction, endpoint.provider);
    const formDraft =
      !requiresBoard && (!inlineSelection || customQuestion) && formInteraction &&
      (endpoint.provider === "slack" ||
        endpoint.provider === "discord" ||
        endpoint.provider === "microsoft-teams") &&
      endpoint.capabilities.actions === true &&
      endpoint.capabilities.modals === true
        ? createChatQuestionFormDraft(
            formInteraction,
            (endpoint.provider === "discord" || endpoint.provider === "slack")
              ? { nativeProvider: endpoint.provider }
              : {},
          )
        : null;
    const supportsCallbacks =
      !requiresBoard && endpoint.provider !== "imessage-photon" &&
      (formDraft === null || customQuestion !== null) &&
      question !== null &&
      endpoint.capabilities.actions === true;
    const questionActionTokens = supportsCallbacks
      ? question.options.map((option) => ({
          actionId: createChatQuestionOptionActionToken(),
          option,
        }))
      : [];
    const confirmation =
      !requiresBoard && (endpoint.provider === "telegram" || endpoint.provider === "slack") && endpoint.capabilities.actions === true
        ? nativeChatConfirmation(interaction) ?? checklist
        : null;
    const confirmationActionTokens = confirmation || suggestions || connectionDecline
      ? (connectionDecline ? ["reject"] as const : ["accept", "reject"] as const).map((decision) => ({
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
          ...(customQuestion && !inlineSelection ? questionActionTokens.map(({ actionId, option }) => ({ type: "callback" as const, actionId, label: option.label })) : []),
          {
            type: "callback" as const,
            actionId: formDraft.openActionId,
            label: customQuestion ? "Other…" : interaction.kind === "request_item_verdicts" ? "Review decisions" : "Respond",
            style: customQuestion ? "default" as const : "primary" as const,
          },
        ]
      : supportsCallbacks
        ? (inlineSelection ? [] : questionActionTokens).map(({ actionId, option }) => ({
            type: "callback" as const,
            actionId,
            label: option.label,
          }))
        : confirmation || suggestions || connectionDecline
          ? confirmationActionTokens.filter(item => !(checklist || suggestedOptions.length > 1) || item.decision !== "accept").map(({ actionId, decision }) => ({
              type: "callback" as const,
              actionId,
              label:
                decision === "accept"
                  ? (suggestions ? "Create task" : confirmation!.payload.acceptLabel ?? "Accept")
                  : (connectionDecline ? "Not now" : suggestions ? "Dismiss" : confirmation!.payload.rejectLabel ?? "Reject"),
              style:
                decision === "accept"
                  ? ("primary" as const)
                  : (connectionDecline || suggestions ? "default" as const : "danger" as const),
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
    if (connectionDecline && taskUrl) actions.unshift({ type: "link", label: "Review connection", url: taskUrl });
    if (suggestions && taskUrl) actions.push({ type: "link", label: "Revise in Paperclip", url: taskUrl });
    const text = [presentation.title, presentation.body, taskUrl ? `Open the task in Paperclip to respond: ${taskUrl}` : "Open the task in Paperclip to respond."].join("\n\n");
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
          title: interaction.kind === "ask_user_questions" && question ? question.prompt : presentation.title,
          body: presentation.body,
          actions,
          ...(suggestions && suggestedOptions.length > 1 ? { selection: {
            actionId: confirmationActionTokens.find(item => item.decision === "accept")!.actionId,
            label: "Select tasks to create", multiple: true, submitLabel: "Create selected",
            options: suggestedOptions.map(({ actionId, option }) => ({ actionId, label: option.label, ...(option.description ? { description: option.description } : {}) })),
          } } : {}),
          ...(checklist ? { selection: {
            actionId: confirmationActionTokens.find(item => item.decision === "accept")!.actionId,
            label: "Select checks", multiple: true, submitLabel: checklist.payload.acceptLabel ?? "Save checks",
            options: checklistOptions.map(({ actionId, option }) => ({ actionId, label: option.label,
              ...(option.description ? { description: option.description } : {}),
              selected: checklist.payload.defaultSelectedOptionIds?.includes(option.id) ?? false })),
          } } : {}),
          ...(inlineSelection && supportsCallbacks ? { selection: {
            actionId: multipleActionId ?? `pcs:${interaction.id}`,
            label: multipleQuestion ? "Choose one or more" : "Choose an answer",
            ...(multipleQuestion ? { multiple: true, submitLabel: "Submit answer" } : {}),
            options: questionActionTokens.map(({ actionId, option }) => ({ actionId,
              label: option.label + (interaction.kind === "ask_user_questions" && interaction.payload.questionSet?.questions.find(item => item.id === question.id)?.options?.find(item => item.id === option.id)?.recommended ? " (recommended)" : ""),
              ...(option.description ? { description: option.description } : {}) })),
          } } : {}),
        },
      },
    });
    const rows = await db.transaction(async (tx) => {
      await notifyChatPublicationWork(tx);
      const rows = await tx
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
        await tx.insert(chatActions).values({ companyId: interaction.companyId, endpointId: endpoint.id, conversationId: conversation.id,
          kind: "photon_interaction", providerActionId: `photon:${reference}`,
          payload: { version: 1, reference, interactionId: interaction.id, publicationId: publication.id, sessionGeneration: conversation.sessionGeneration,
            expiresAt: new Date(publication.createdAt.getTime() + CHAT_QUESTION_ACTION_TOKEN_TTL_MS).toISOString() }, status: "issued" });
      } else if (publication && formDraft) {
        await tx.insert(chatActions).values(
          chatQuestionFormActionRecords(formDraft, {
            companyId: interaction.companyId,
            endpointId: endpoint.id,
            conversationId: conversation.id,
            publicationId: publication.id,
          }),
        );
      }
      if (publication && supportsCallbacks && multipleQuestion && multipleActionId) {
        await tx.insert(chatActions).values({
          companyId: interaction.companyId, endpointId: endpoint.id, conversationId: conversation.id,
          kind: "question_answer", providerActionId: multipleActionId, status: "issued",
          payload: { version: 1, publicationId: publication.id, interactionId: interaction.id, questionId: multipleQuestion.id,
            selectionOptions: questionActionTokens.map(({ actionId, option }) => ({ value: actionId, optionId: option.id })),
            expiresAt: new Date(publication.createdAt.getTime() + CHAT_QUESTION_ACTION_TOKEN_TTL_MS).toISOString() },
        });
      } else if (publication && question && questionActionTokens.length > 0) {
        const expiresAt = new Date(
          publication.createdAt.getTime() + CHAT_QUESTION_ACTION_TOKEN_TTL_MS,
        ).toISOString();
        await tx.insert(chatActions).values(
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
        (confirmation || suggestions || connectionDecline) &&
        confirmationActionTokens.length > 0
      ) {
        const expiresAt = new Date(
          publication.createdAt.getTime() + CHAT_QUESTION_ACTION_TOKEN_TTL_MS,
        ).toISOString();
        await tx.insert(chatActions).values(
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
              ...(suggestions ? { selectionOptions: suggestedOptions.map(({ actionId, option }) => ({ value: actionId, optionId: option.id })) } : {}),
              ...(checklist ? { selectionOptions: checklistOptions.map(({ actionId, option }) => ({ value: actionId, optionId: option.id })) } : {}),
              expiresAt,
            },
            status: "issued",
          })),
        );
      }
      return rows;
    });
    inserted.push(...rows);
  }
  return inserted;
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
  if (originals.length === 0) return [];

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
    await db.transaction(async (tx) => {
      await notifyChatPublicationWork(tx);
      return tx
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
    });
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
    (interaction.kind === "ask_user_questions" || interaction.kind === "request_confirmation" || interaction.kind === "request_item_verdicts") &&
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
  if (continuationWakeRequired && currentOriginals.length > 0) {
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
    const wakeBinding = currentOriginals[0]!;
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
  for (const original of providerVisibleOriginals) {
    const card = original.payload.card;
    if (!card) continue;
    const rows = await db.transaction(async (tx) => {
      await notifyChatPublicationWork(tx);
      return tx
        .insert(chatPublications)
        .values({
          companyId: interaction.companyId,
          endpointId: original.endpointId,
          conversationId: original.conversationId,
          issueId: interaction.issueId,
          idempotencyKey: `interaction-resolution:${interaction.id}:${original.endpointId}`,
          payload: projectSafeChatPublication({
            classification: "external",
            source: "issue_interaction",
            text: copy.text,
            interaction: {
              id: interaction.id,
              card: {
                kind: card.kind,
                title: card.title,
                body: copy.body,
                actions: [],
              },
            },
          }),
          state: "pending",
        })
        .onConflictDoNothing()
        .returning();
    });
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
  return db.transaction(async (tx) => {
    await notifyChatPublicationWork(tx);
    return tx
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
  });
}
