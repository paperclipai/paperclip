export const NATIVE_ACCOUNT_CHANGE_CONTINUATION_CODE = "native_account_change_continuation";
export const NATIVE_ACCOUNT_CHANGE_MAX_CONTINUATIONS = 1;
export const NATIVE_ACCOUNT_CHANGE_CONTINUATION_DELAY_MS = 5_000;
export const NATIVE_ACCOUNT_CHANGE_MESSAGE =
  "The execution environment refused to resume the saved provider session because its account binding changed. Paperclip continues the task once in a fresh provider session with the same workspace.";
export const NATIVE_ACCOUNT_CHANGE_HINT = "The previous run could not resume its saved provider session, because the execution environment's account binding changed since that session started. "
  + "Paperclip started this fresh session once to continue. Earlier sessions may already have completed some steps: "
  + "check the workspace files, this task's documents and its comments before repeating a step, and never post a comment or save a document that already exists. "
  + "Then finish the remaining work and report the real outcome.";
