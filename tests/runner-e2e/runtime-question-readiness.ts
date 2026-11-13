/** Provider-native questions pause inside a turn; they need an answer, not a
 * terminal run. Plain semantic questions instead wake a subsequent run. */
export function answerableRuntimeRunIds(interactions: ReadonlyArray<Record<string, any>>): Set<string> {
  return new Set(interactions.filter((i) => i.kind === "ask_user_questions" && i.status === "pending" &&
    typeof i.sourceRunId === "string" && typeof i.payload?.runtimeRequestId === "string")
    .map((i) => i.sourceRunId));
}

/** Claude's one question includes the ACP adapter's optional custom-answer
 * companion field. It is not a second user question. */
export function isSingleClaudeQuestion(questions: ReadonlyArray<Record<string, any>>) {
  return questions.length >= 1 && questions.length <= 2 && questions[0]?.answerMode === "single_select" &&
    questions.slice(1).every(q => q.answerMode === "text" && q.required === false && q.header === "Other" && /_custom-/.test(q.id));
}
