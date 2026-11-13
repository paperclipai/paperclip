import type { AskUserQuestionsInteraction, IssueThreadInteraction } from "@paperclipai/shared";

export function chatInteractionPresentation(interaction: IssueThreadInteraction, options: { compactChoices?: boolean; nativeCustomAnswer?: boolean } = {}) {
  const context = [interaction.summary].filter((value): value is string => Boolean(value?.trim()));
  switch (interaction.kind) {
    case "ask_user_questions": {
      const { payload } = interaction;
      if (payload.questionSet?.description) context.push(payload.questionSet.description);
      for (const question of payload.questions) {
        const source = payload.questionSet?.questions.find(item => item.id === question.id);
        if (source?.header && source.header !== question.helpText && source.header !== question.prompt) context.push(source.header);
        context.push(question.prompt);
        if (question.helpText) context.push(question.helpText);
        for (const option of question.options.filter(item => !item.freeText || question.options.length > 1)) {
          if (options.nativeCustomAnswer && option.freeText) continue;
          const recommended = source?.options?.find(item => item.id === option.id)?.recommended;
          if (options.compactChoices && option.label.length <= 60 && (option.description?.length ?? 0) <= 75) continue;
          context.push(`- ${option.label}${recommended ? " (recommended)" : ""}${option.description ? `: ${option.description}` : ""}`);
        }
        if (!options.compactChoices && !options.nativeCustomAnswer && (source?.customAnswer || (question.allowOther && question.options.some(item => !item.freeText)))) {
          context.push("You can also provide your own answer.");
        }
      }
      return {
        title: payload.title ?? interaction.title ?? "Input needed",
        body: context.join("\n\n"),
      };
    }
    case "request_confirmation":
    case "request_checkbox_confirmation":
    case "request_item_verdicts": {
      const { payload } = interaction;
      context.push(payload.prompt);
      if (payload.detailsMarkdown) context.push(payload.detailsMarkdown);
      if (interaction.kind === "request_checkbox_confirmation") {
        const minimum = interaction.payload.minSelected ?? 0;
        const maximum = interaction.payload.maxSelected;
        if (minimum > 0 || maximum != null) context.push(minimum === maximum
          ? `Select exactly ${minimum}.`
          : `Select ${minimum}–${maximum ?? interaction.payload.options.length} checks.`);
        for (const option of interaction.payload.options) {
          if (options.compactChoices && option.label.length <= 60 && (option.description?.length ?? 0) <= 75) continue;
          context.push(`- ${option.label}${option.description ? `: ${option.description}` : ""}`);
        }
      }
      if (interaction.kind === "request_item_verdicts") {
        for (const item of interaction.payload.items) {
          context.push(`- ${item.label}${item.description ? `: ${item.description}` : ""}`);
        }
      }
      return { title: payload.prompt, body: context.join("\n\n") };
    }
    case "suggest_tasks": {
      for (const task of interaction.payload.tasks.filter(item => !item.hiddenInPreview)) {
        if (options.compactChoices && task.title.length <= 60 && (task.description?.length ?? 0) <= 75) continue;
        context.push(`- ${task.title}${task.description ? `: ${task.description}` : ""}`);
      }
      return { title: interaction.title ?? "Review suggested tasks", body: context.join("\n\n") };
    }
    case "connection_intent": {
      const { payload } = interaction;
      context.push(`${payload.requestingAgentName} needs ${payload.serviceName}${payload.accessRequest ? ` (${payload.accessRequest.connectionName})` : ""}.`);
      context.push("The addressed user must review this connection request in Paperclip.");
      return { title: interaction.title ?? `Connect ${payload.serviceName}`, body: context.join("\n\n") };
    }
  }
}

/** Keep the submitted response readable without publishing internal result metadata. */
export function answeredChatQuestionBody(interaction: AskUserQuestionsInteraction): string {
  const lines = [...new Set([interaction.summary, interaction.payload.questionSet?.description]
    .filter((value): value is string => Boolean(value?.trim())))];
  for (const question of interaction.payload.questions) {
    const answer = interaction.result?.answers.find(item => item.questionId === question.id);
    const labels = (answer?.optionIds ?? []).flatMap(id => {
      const option = question.options.find(item => item.id === id && !item.freeText);
      return option ? [option.label] : [];
    });
    if (answer?.otherText?.trim()) labels.push(answer.otherText.trim());
    lines.push(question.prompt, labels.length ? `Answered: ${labels.join("; ")}` : "No answer provided (optional).");
  }
  return lines.join("\n\n");
}
