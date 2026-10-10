import type { RunnerTaskFixture } from "./types.js";
export const nativeActiveStopTasks: readonly RunnerTaskFixture[] = [{
  id: "pending-permission-stop", label: "Stop while native permission is unanswered", groups: [], workMode: "standard", flow: "native_active_stop",
  expectedRunCount: 1, attemptTimeoutMs: { local: 300_000, daytona: 300_000 }, turnTimeoutMs: 120_000,
  expectedTerminalState: { issue: "in_progress", run: "cancelled" },
  buildTitle: nonce => `Native pending permission Stop ${nonce}`,
  buildVisibleMarker: nonce => `NATIVE-ACTIVE-STOP-${nonce}`,
  buildPrompt: () => "Attempt the supplied exact native operation once. Leave its native permission callback pending for the board operator. Do not answer, reject or cancel your own permission; do not retry, use another tool/path, call paperclip_finish, or claim completion. The operator will stop this unfinished task while permission is still unanswered.",
  buildMatchers: () => [], // Dedicated flow requires pending API observation, caller-owned Stop and retirement.
}];
