import type { RunnerTaskFixture } from "./types.js";
export const contextOrientation = "First invoke the dedicated Paperclip get_task_context tool directly and wait for its returned context. It is already available; no discovery is needed. search_api discovers HTTP routes, not semantic tools. Do not use call_api or an HTTP route as a substitute for get_task_context. Then ";
export const nativeActiveStopTasks: readonly RunnerTaskFixture[] = [{
  id: "pending-permission-stop", label: "Stop while native permission is unanswered", groups: [], workMode: "standard", flow: "native_active_stop",
  expectedRunCount: 1, attemptTimeoutMs: { local: 300_000, daytona: 300_000 }, turnTimeoutMs: 120_000,
  expectedTerminalState: { issue: "in_progress", run: "cancelled" },
  buildTitle: nonce => `Native pending permission Stop ${nonce}`,
  buildVisibleMarker: nonce => `NATIVE-ACTIVE-STOP-${nonce}`,
  buildPrompt: () => contextOrientation + "attempt the supplied exact native operation once. Leave its native permission callback pending for the board operator. Do not answer, reject or cancel your own permission; do not retry, use another tool/path, call paperclip_finish, or claim completion. The operator will stop this unfinished task while permission is still unanswered.",
  buildMatchers: () => [], // Dedicated flow requires pending API observation, caller-owned Stop and retirement.
}];

export const copilotProviderDeathTasks: readonly RunnerTaskFixture[] = [{
  id: "pending-permission-provider-death", label: "Copilot dies while permission is unanswered", groups: [], workMode: "standard", flow: "native_active_stop",
  expectedRunCount: 1, attemptTimeoutMs: { local: 300_000, daytona: 300_000 }, turnTimeoutMs: 120_000,
  expectedTerminalState: { issue: "blocked", run: "failed" },
  buildTitle: nonce => `Copilot pending permission provider death ${nonce}`,
  buildVisibleMarker: nonce => `COPILOT-PROVIDER-DEATH-${nonce}`,
  buildPrompt: () => contextOrientation + "attempt the supplied exact native edit once. Leave its native permission callback unanswered for the board operator. Do not retry, use another tool/path, call paperclip_finish, or claim completion. The operator will terminate the owned provider process while this unfinished task waits for permission.",
  buildMatchers: () => [],
}];
