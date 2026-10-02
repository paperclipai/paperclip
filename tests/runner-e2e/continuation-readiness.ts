/** A terminal child does not mean the parent has processed its completion wake. */
export function continuationInitialReady(interactions: ReadonlyArray<{ kind?: unknown; status?: unknown }>): boolean {
  return interactions.some((i) => i.kind === "ask_user_questions" && i.status === "pending");
}

/** A successful click can return before the form POST commits. Do not accept
 * the original paused run as the result of the answer we just submitted. */
export function continuationAnswerCommitted(interactions: ReadonlyArray<{ id?: unknown; status?: unknown }>, interactionId?: string): boolean {
  return !interactionId || interactions.some(i => i.id === interactionId && i.status === "answered");
}
