import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatActions, chatConversations, chatEndpoints, chatPublications } from "@paperclipai/db";
import type {
  AskUserQuestionsInteraction,
  AskUserQuestionsQuestion,
  IssueThreadInteraction,
  RequestConfirmationInteraction,
  SafeExternalChatCardAction,
} from "@paperclipai/shared";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { chatQuestionFormActionRecords, createChatQuestionFormDraft } from "./chat-question-forms.js";

const MAX_NATIVE_QUESTION_OPTIONS = 12;
const QUESTION_ACTION_PREFIX = "pcq:";
const QUESTION_ACTION_TOKEN_BYTES = 16;
export const CHAT_QUESTION_ACTION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;

type ChatPublicationDb = Pick<Db, "select" | "insert" | "update">;

function publicTaskUrl(issueId: string): string | null {
  const configured =
    process.env.PAPERCLIP_PUBLIC_URL?.trim() ||
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim() ||
    process.env.BETTER_AUTH_BASE_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:") return null;
    url.pathname = `/issues/${issueId}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

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
export function telegramChatSdkCallbackData(actionId: string, value?: string): string {
  return `chat:${JSON.stringify({
    a: actionId,
    ...(typeof value === "string" ? { v: value } : {}),
  })}`;
}

export function telegramCallbackDataByteLength(actionId: string, value?: string): number {
  return Buffer.byteLength(telegramChatSdkCallbackData(actionId, value), "utf8");
}

export function nativeChatQuestion(interaction: AskUserQuestionsInteraction): AskUserQuestionsQuestion | null {
  if (interaction.payload.questions.length !== 1) return null;
  const question = interaction.payload.questions[0];
  if (
    question.selectionMode !== "single" ||
    question.allowOther !== false ||
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
export function nativeTelegramConfirmation(interaction: IssueThreadInteraction): RequestConfirmationInteraction | null {
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

function textForQuestionInteraction(interaction: AskUserQuestionsInteraction, taskUrl: string | null): string {
  const lines = [interaction.payload.title ?? interaction.title ?? "Input needed", ""];
  for (const question of interaction.payload.questions) {
    lines.push(question.prompt);
    for (const option of question.options) lines.push(`- ${option.label}`);
    lines.push("");
  }
  lines.push(taskUrl ? `Open the task in Paperclip to respond: ${taskUrl}` : "Open the task in Paperclip to respond.");
  return lines.join("\n");
}

function genericInteractionText(taskUrl: string | null): string {
  return [
    "This task needs an authorized response in Paperclip.",
    taskUrl ? `Open the task in Paperclip to respond: ${taskUrl}` : "Open the task in Paperclip to respond.",
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
  const bindings = await db
    .select({
      conversation: chatConversations,
      endpoint: chatEndpoints,
    })
    .from(chatConversations)
    .innerJoin(
      chatEndpoints,
      and(eq(chatEndpoints.companyId, chatConversations.companyId), eq(chatEndpoints.id, chatConversations.endpointId)),
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

  const taskUrl = publicTaskUrl(interaction.issueId);
  const question = interaction.kind === "ask_user_questions" ? nativeChatQuestion(interaction) : null;
  const inserted: Array<typeof chatPublications.$inferSelect> = [];
  for (const { conversation, endpoint } of bindings) {
    const formDraft =
      interaction.kind === "ask_user_questions" &&
      (endpoint.provider === "slack" || endpoint.provider === "microsoft-teams") &&
      endpoint.capabilities.actions === true &&
      endpoint.capabilities.modals === true
        ? createChatQuestionFormDraft(interaction)
        : null;
    const supportsCallbacks = formDraft === null && question !== null && endpoint.capabilities.actions === true;
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
        ({ actionId }) => telegramCallbackDataByteLength(actionId) > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
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
              style: decision === "accept" ? ("primary" as const) : ("danger" as const),
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
    const text =
      interaction.kind === "ask_user_questions"
        ? textForQuestionInteraction(interaction, taskUrl)
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
              ? (question?.prompt ?? interaction.payload.title ?? interaction.title ?? "Input needed")
              : interaction.kind === "request_confirmation"
                ? interaction.payload.prompt
                : "Response needed in Paperclip",
          body:
            interaction.kind === "ask_user_questions"
              ? (question?.helpText ?? undefined)
              : interaction.kind === "request_confirmation"
                ? (interaction.payload.detailsMarkdown ?? undefined)
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
    if (publication && formDraft) {
      await db.insert(chatActions).values(
        chatQuestionFormActionRecords(formDraft, {
          companyId: interaction.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          publicationId: publication.id,
        }),
      );
    } else if (publication && question && questionActionTokens.length > 0) {
      const expiresAt = new Date(publication.createdAt.getTime() + CHAT_QUESTION_ACTION_TOKEN_TTL_MS).toISOString();
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
    } else if (publication && confirmation && confirmationActionTokens.length > 0) {
      const expiresAt = new Date(publication.createdAt.getTime() + CHAT_QUESTION_ACTION_TOKEN_TTL_MS).toISOString();
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
        inArray(chatActions.kind, ["question_answer", "confirmation_response"]),
        eq(chatActions.status, "issued"),
        inArray(sql<string>`${chatActions.payload}->>'interactionId'`, [...input.interactionIds]),
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
        inArray(sql<string>`${chatPublications.payload}->>'interactionId'`, [...input.interactionIds]),
      ),
    )
    .returning();
}
