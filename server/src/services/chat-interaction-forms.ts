import type { AskUserQuestionsInteraction, AskUserQuestionsAnswer, IssueThreadInteraction, RequestItemVerdictValue } from "@paperclipai/shared";
import type { ChatQuestionFormSubmitTokenPayload } from "./chat-question-forms.js";

/** A view model for the existing form transport; canonical interactions keep their original kind. */
export function chatInteractionForm(interaction: IssueThreadInteraction, provider: string): AskUserQuestionsInteraction | null {
  if (interaction.kind === "ask_user_questions") return interaction;
  if (provider !== "slack" || interaction.kind !== "request_item_verdicts" || interaction.payload.target ||
      interaction.payload.items.length > 12 || interaction.payload.items.some(item => item.attachmentId)) return null;
  const remaining = interaction.payload.items.filter(item => !interaction.result?.items.some(result => result.id === item.id));
  if (!remaining.length) return null;
  const verdicts = interaction.payload.verdicts ?? ["approve", "reject"];
  const reasons = interaction.payload.requireReasonOn ?? [];
  return { ...interaction, kind: "ask_user_questions", result: null, summary: [interaction.summary, interaction.payload.prompt, interaction.payload.detailsMarkdown].filter(Boolean).join("\n\n"), payload: {
    version: 1, title: "Review decisions",
    questions: remaining.flatMap(item => [
      { id: `verdict:${item.id}`, prompt: item.label, helpText: [item.description, item.previewMarkdown, item.href].filter(Boolean).join("\n\n"), required: true, selectionMode: "single" as const,
        options: verdicts.map(verdict => ({ id: verdict, label: verdict[0].toUpperCase() + verdict.slice(1) })) },
      { id: `reason:${item.id}`, prompt: `${interaction.payload.reasonLabel ?? "Reason"}: ${item.label}`, helpText: reasons.length ? `Required for: ${reasons.join(", ")}.` : "Optional explanation.", required: false, selectionMode: "single" as const, allowOther: true,
        options: [{ id: "text", label: "Reason", freeText: true }] },
    ]),
  } };
}

export function chatItemVerdicts(interaction: IssueThreadInteraction, answers: AskUserQuestionsAnswer[], payload: ChatQuestionFormSubmitTokenPayload) {
  if (interaction.kind !== "request_item_verdicts") return null;
  const errors: Record<string, string> = {};
  const verdicts = interaction.payload.items.filter(item => !interaction.result?.items.some(result => result.id === item.id)).map(item => {
    const verdict = answers.find(answer => answer.questionId === `verdict:${item.id}`)?.optionIds[0] as RequestItemVerdictValue;
    const reason = answers.find(answer => answer.questionId === `reason:${item.id}`)?.otherText?.trim();
    if (interaction.payload.requireReasonOn?.includes(verdict) && !reason) {
      const field = payload.fields.find(field => field.questionId === `reason:${item.id}`);
      if (field) errors[field.fieldId] = `Explain why you chose ${verdict}.`;
    }
    return { id: item.id, verdict, ...(reason ? { reason } : {}) };
  });
  return { verdicts, errors };
}
