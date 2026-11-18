export const NATIVE_AGENT_BLOCKER_CONTINUATION_CODE = "native_agent_blocker_continuation";
export const NATIVE_AGENT_BLOCKER_HANDOFF_CODE = "native_agent_blocker_needs_person";
export const NATIVE_AGENT_BLOCKER_MAX_CONTINUATIONS = 1;
export const NATIVE_AGENT_BLOCKER_CONTINUATION_DELAY_MS = 30_000;
export const NATIVE_AGENT_BLOCKER_MESSAGE =
  "The agent reported a blocker it owns. Paperclip continues the task once in a fresh session.";
export const NATIVE_AGENT_BLOCKER_HINT = "The previous run stopped on a blocker that it said the agent itself owns. "
  + "Paperclip started this fresh session once to continue. Earlier attempts may already have completed some steps: "
  + "check the workspace files, this task's documents and its comments before repeating a step, and never post a comment or save a document that already exists. "
  + "Resolve the blocker yourself if you can, then finish the remaining work and report the real outcome. "
  + "If only a person can resolve it, report the blocker with owner kind user and the exact action that person must take.";
