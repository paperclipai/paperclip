export const NATIVE_ENVIRONMENT_BLOCKER_CODE = "native_environment_blocker";
export const NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_CODE = "native_environment_blocker_exhausted";
export const NATIVE_ENVIRONMENT_BLOCKER_MAX_RETRIES = 2;
export const NATIVE_ENVIRONMENT_BLOCKER_RETRY_DELAY_MS = 30_000;
export const NATIVE_ENVIRONMENT_BLOCKER_MESSAGE =
  "The agent reported its execution environment unavailable. Paperclip continues the task in a fresh session.";
export const NATIVE_ENVIRONMENT_BLOCKER_HINT = "The previous run stopped because it reported its execution environment or tools unavailable. "
  + "Paperclip started this fresh session to continue. Earlier attempts may already have completed some steps: "
  + "check the workspace files, this task's documents and its comments before repeating a step, and never post a comment or save a document that already exists. "
  + "Then finish the remaining work and report the real outcome. If a tool result looks wrong, retry that step once before reporting a blocker.";
export const NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_ACTION =
  "The agent still reported its execution environment unavailable after Paperclip continued the task in fresh sessions. The saved work is kept. Comment on the task when the agent should continue.";

const ENVIRONMENT_BLOCKER_REASON_CODES: ReadonlySet<string> = new Set(["environment_unavailable", "tool_unavailable"]);

export function isNativeEnvironmentBlocker(result: {
  reportedWorkDisposition?: unknown;
  blocker?: { owner?: { kind?: unknown } | null; reasonCode?: unknown } | null;
}) {
  return result.reportedWorkDisposition === "blocked" && result.blocker?.owner?.kind === "system"
    && typeof result.blocker.reasonCode === "string" && ENVIRONMENT_BLOCKER_REASON_CODES.has(result.blocker.reasonCode);
}
