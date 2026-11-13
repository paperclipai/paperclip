import { nativeSha256 } from "../native-runtime/canonical.js";
import { createHash } from "node:crypto";
import type {
  AskUserQuestionsInteraction,
  AskUserQuestionsAnswer,
  IssueThreadInteraction,
  RequestConfirmationInteraction,
} from "@paperclipai/shared";
import { PhotonChatAdapter } from "./adapter.js";
import { PhotonError, photonFailure } from "./cloud.js";
import { projectSafeChatPublicationText } from "../chat-publication-projection.js";

export class PhotonAnswerValidationError extends Error {}

export interface PhotonInteractionBinding {
  version: 1;
  reference: string;
  interactionId: string;
  publicationId: string;
  sessionGeneration: number;
  expiresAt: string;
}
export interface PhotonPromptReceipt {
  schema: 1;
  reference: string;
  questionIndex: number;
  publicationId: string;
  promptMessageGuid: string;
  promptMessageGuids?: string[];
  pollMessageGuid?: string;
  options: Record<string, string>;
}
export interface PhotonDraft {
  schema: 1;
  interactionId: string;
  userId: string;
  principalId: string;
  answers: AskUserQuestionsAnswer[];
  decision?: "accept" | "reject";
  reason?: string;
  lastSequence: number;
}
export function nativePhotonInteraction(
  interaction: IssueThreadInteraction,
): interaction is AskUserQuestionsInteraction | RequestConfirmationInteraction {
  if (interaction.kind === "ask_user_questions")
    return (
      interaction.payload.questions.length > 0 &&
      interaction.payload.questions.length <= 64
    );
  return (
    interaction.kind === "request_confirmation" &&
    !interaction.payload.toolAction &&
    !interaction.payload.secretProposal &&
    !interaction.payload.connectionAuthorization
  );
}
export function photonResponseCommand(text: string): {
  command: "answer" | "submit";
  reference: string;
  questionIndex: number;
  value: string;
} | null {
  const match =
    /^\/(answer|submit)\s+([a-zA-Z0-9_-]{8,24})(?:\.(\d{1,2}))?(?:\s+([\s\S]*))?$/i.exec(
      text.trim(),
    );
  if (!match) return null;
  return {
    command: match[1].toLowerCase() as "answer" | "submit",
    reference: match[2],
    questionIndex: Number(match[3] ?? 1) - 1,
    value: match[4]?.trim() ?? "",
  };
}
export function parsePhotonQuestionAnswer(
  interaction: AskUserQuestionsInteraction,
  questionIndex: number,
  value: string,
): AskUserQuestionsAnswer {
  const question = interaction.payload.questions[questionIndex];
  if (!question)
    throw new PhotonAnswerValidationError("That question does not exist");
  if (value.toLowerCase() === "skip") {
    if (question.required !== false)
      throw new PhotonAnswerValidationError("This question requires an answer");
    return { questionId: question.id, optionIds: [] };
  }
  if (!value || value.length > 100_000)
    throw new PhotonAnswerValidationError(
      "Enter a nonempty answer within the task’s length limit",
    );
  const numbers =
    /^\d+(?:[ ,]+\d+)*$/.test(value) &&
    question.options.some((option) => !option.freeText)
      ? value.split(/[ ,]+/).map(Number)
      : null;
  if (numbers) {
    if (
      new Set(numbers).size !== numbers.length ||
      numbers.some((index) => index < 1 || index > question.options.length)
    )
      throw new PhotonAnswerValidationError(
        "Choose valid option numbers without duplicates",
      );
    if (question.selectionMode === "single" && numbers.length !== 1)
      throw new PhotonAnswerValidationError("Choose one option");
    if (numbers.some((index) => question.options[index - 1].freeText))
      throw new PhotonAnswerValidationError("Write your custom answer as text");
    return {
      questionId: question.id,
      optionIds: numbers.map((index) => question.options[index - 1].id),
    };
  }
  const freeText = question.options.find((option) => option.freeText);
  if (question.options.length && question.allowOther === false && !freeText)
    throw new PhotonAnswerValidationError(
      "Answer with the option number(s) shown in the prompt",
    );
  return {
    questionId: question.id,
    optionIds: freeText ? [freeText.id] : [],
    otherText: value,
  };
}
export function photonAnswersMatch(
  interaction: AskUserQuestionsInteraction,
  result: unknown,
): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as {
    code?: unknown;
    interactionId?: unknown;
    answersSha256?: unknown;
  };
  return (
    record.code === "photon_question_answered" &&
    record.interactionId === interaction.id &&
    record.answersSha256 === nativeSha256(interaction.result?.answers)
  );
}

/** Prompt and poll receipts persist independently, before the outbox is settled.
 * A vote arriving before this binding is finalized must wait for this record. */
export async function publishPhotonPrompt(input: {
  adapter: PhotonChatAdapter;
  threadId: string;
  binding: PhotonInteractionBinding;
  interaction: AskUserQuestionsInteraction | RequestConfirmationInteraction;
  questionIndex: number;
  taskUrl?: string | null;
  retryUnknown?: boolean;
  assertCurrent(): Promise<void>;
}): Promise<PhotonPromptReceipt> {
  const { adapter, binding, interaction, questionIndex, assertCurrent } = input;
  const key = `prompt:${binding.reference}:${questionIndex}`;
  const digest = nativeSha256({
    binding,
    threadId: input.threadId,
    kind: interaction.kind,
    payload: interaction.payload,
    questionIndex,
    taskUrl: input.taskUrl ?? null,
  });
  await adapter.state.update<{ digest: string }>(
    `${key}:identity`,
    (current) => {
      if (current && current.digest !== digest)
        throw new PhotonError(
          "rejected",
          "Photon prompt changed after preparation",
        );
      return current ?? { digest };
    },
  );
  const existing = await adapter.state.read<PhotonPromptReceipt>(key);
  if (existing) {
    for (const guid of existing.promptMessageGuids ?? [
      existing.promptMessageGuid,
    ])
      await adapter.state.update<PhotonPromptReceipt>(
        `prompt-message:${guid}`,
        (current) => current ?? existing,
      );
    if (existing.pollMessageGuid)
      await adapter.state.update<PhotonPromptReceipt>(
        `poll-message:${existing.pollMessageGuid}`,
        (current) => current ?? existing,
      );
    return existing;
  }
  const question =
    interaction.kind === "ask_user_questions"
      ? interaction.payload.questions[questionIndex]
      : null;
  if (interaction.kind === "ask_user_questions" && !question)
    throw new PhotonAnswerValidationError("Photon question index is invalid");
  const reference = `${binding.reference}.${questionIndex + 1}`;
  const title =
    projectSafeChatPublicationText(
      question?.prompt ??
        (interaction as RequestConfirmationInteraction).payload.prompt,
    ).trim() || "Input needed";
  const choices = question
    ? question.options.map((option) => ({
        id: option.id,
        label:
          projectSafeChatPublicationText(option.label).trim() ||
          `Choice ${question.options.indexOf(option) + 1}`,
      }))
    : [
        {
          id: "accept",
          label: projectSafeChatPublicationText(
            (interaction as RequestConfirmationInteraction).payload
              .acceptLabel ?? "Accept",
          ),
        },
        {
          id: "reject",
          label: projectSafeChatPublicationText(
            (interaction as RequestConfirmationInteraction).payload
              .rejectLabel ?? "Reject",
          ),
        },
      ];
  const nativePoll =
    (!question ||
      (question.selectionMode === "single" &&
        !question.allowOther &&
        !question.options.some((o) => o.freeText))) &&
    choices.length >= 2 &&
    choices.length <= 10;
  const text = [
    title,
    interaction.kind === "request_confirmation" &&
    interaction.payload.detailsMarkdown
      ? projectSafeChatPublicationText(interaction.payload.detailsMarkdown)
      : "",
    question?.helpText ? projectSafeChatPublicationText(question.helpText) : "",
    ...choices.map((choice, index) => `${index + 1}. ${choice.label}`),
    `Reply to this message, or send /answer ${reference} ${question?.selectionMode === "multi" ? "<numbers separated by commas>" : "<answer>"}.`,
    question?.required === false ? `Optional: /answer ${reference} skip` : "",
    interaction.kind === "request_confirmation" &&
    interaction.payload.rejectRequiresReason
      ? "To reject, send Reject followed by your reason."
      : "",
    interaction.kind === "ask_user_questions" &&
    interaction.payload.questions.length > 1
      ? `Answers are saved for you. Finish with /submit ${binding.reference}.`
      : "",
    input.taskUrl ? `Open this Paperclip task: ${input.taskUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const prompt = await adapter.publish(
    input.threadId,
    `${binding.publicationId}:question:${questionIndex}`,
    { markdown: text },
    { assertCurrent, retryUnknown: input.retryUnknown },
  );
  const receipt: PhotonPromptReceipt = {
    schema: 1,
    reference: binding.reference,
    publicationId: binding.publicationId,
    questionIndex,
    promptMessageGuid: prompt.id,
    promptMessageGuids: prompt.messageIds,
    options: {},
  };
  if (nativePoll) {
    const stateKey = `poll:${binding.publicationId}:${questionIndex}`;
    type PollSend = {
      schema: 1;
      phase: "prepared" | "creating" | "created";
      receipt?: {
        pollMessageGuid: string;
        options: Array<{ optionIdentifier: string; text: string }>;
      };
    };
    let saved = await adapter.state.read<PollSend>(stateKey);
    if (saved?.phase === "creating" && !input.retryUnknown)
      throw new PhotonError(
        "delivery_unknown",
        "Photon poll creation is unknown; reconcile this publication before retrying",
      );
    if (!saved || saved.phase !== "created") {
      await assertCurrent();
      await adapter.state.update<PollSend>(stateKey, (current) => {
        if (current?.phase === "creating" && !input.retryUnknown)
          throw new PhotonAnswerValidationError("Photon poll already claimed");
        return { schema: 1, phase: "creating" };
      });
      const poll = await adapter.client.polls
        .create(
          adapter.decodeThreadId(input.threadId).chatGuid,
          title,
          choices.map((choice) => choice.label),
          {
            clientMessageId: createHash("sha256")
              .update(`${adapter.state.scope.endpointId}:${stateKey}`)
              .digest("hex"),
          },
        )
        .catch(async (error) => {
          const failure = photonFailure(error, true);
          if (failure.code !== "delivery_unknown")
            await adapter.state.update<PollSend>(stateKey, () => ({
              schema: 1,
              phase: "prepared",
            }));
          throw failure;
        });
      if (
        !poll.pollMessageGuid ||
        poll.options.length !== choices.length ||
        new Set(poll.options.map((option) => option.optionIdentifier)).size !==
          choices.length ||
        poll.options.some(
          (option, index) =>
            !option.optionIdentifier ||
            option.text.trim() !== choices[index].label.trim(),
        )
      )
        throw new PhotonError(
          "delivery_unknown",
          "Photon returned an incomplete poll receipt",
        );
      saved = await adapter.state.update<PollSend>(stateKey, () => ({
        schema: 1,
        phase: "created",
        receipt: {
          pollMessageGuid: poll.pollMessageGuid,
          options: poll.options.map((option) => ({
            optionIdentifier: option.optionIdentifier,
            text: option.text,
          })),
        },
      }));
    }
    receipt.pollMessageGuid = saved.receipt!.pollMessageGuid;
    // Creation response preserves requested option order; labels/titles are never a lookup key.
    receipt.options = Object.fromEntries(
      saved.receipt!.options.map((option, index) => [
        option.optionIdentifier,
        choices[index].id,
      ]),
    );
  }
  await adapter.state.update<PhotonPromptReceipt>(
    key,
    (current) => current ?? receipt,
  );
  for (const guid of prompt.messageIds)
    await adapter.state.update<PhotonPromptReceipt>(
      `prompt-message:${guid}`,
      (current) => current ?? receipt,
    );
  if (receipt.pollMessageGuid)
    await adapter.state.update<PhotonPromptReceipt>(
      `poll-message:${receipt.pollMessageGuid}`,
      (current) => current ?? receipt,
    );
  return receipt;
}
