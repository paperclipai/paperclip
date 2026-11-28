export const NATIVE_RESUME_REFUSAL_REASONS = ["account_binding_mismatch", "session_state_unavailable"] as const;
export type NativeResumeRefusalReason = typeof NATIVE_RESUME_REFUSAL_REASONS[number];
export const NATIVE_RESUME_REFUSED_CONTINUATION_CODE = "native_resume_refused_continuation";
export const NATIVE_RESUME_REFUSED_MAX_CONTINUATIONS = 1;
export const NATIVE_RESUME_REFUSED_CONTINUATION_DELAY_MS = 5_000;

const REFUSAL_CAUSES: Record<NativeResumeRefusalReason, string> = {
  account_binding_mismatch: "the execution environment's account binding changed since that session started",
  session_state_unavailable: "the execution environment could not find the saved session state",
};

export function nativeResumeRefusedMessage(reason: NativeResumeRefusalReason) {
  return `The saved provider session could not be resumed, because ${REFUSAL_CAUSES[reason]}. `
    + "Paperclip continues the task once in a fresh provider session with the same workspace.";
}

export function nativeResumeRefusedHint(reason: NativeResumeRefusalReason) {
  return `The previous run could not resume its saved provider session, because ${REFUSAL_CAUSES[reason]}. `
    + "Paperclip started this fresh session once to continue. Earlier sessions may already have completed some steps: "
    + "check the workspace files, this task's documents and its comments before repeating a step, and never post a comment or save a document that already exists. "
    + "Then finish the remaining work and report the real outcome.";
}
