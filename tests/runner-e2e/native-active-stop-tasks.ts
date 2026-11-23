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
/** Shared native transport-loss fixture: the run root is lost while a native mutation waits for permission. */
export const nativeProviderLossTasks: readonly RunnerTaskFixture[] = [{
  id: "pending-permission-provider-loss", label: "Owned runtime loss with pending permission", groups: [], workMode: "standard", flow: "native_provider_loss",
  expectedRunCount: 1, attemptTimeoutMs: { local: 300_000, daytona: 300_000 }, turnTimeoutMs: 120_000,
  expectedTerminalState: { issue: "blocked", run: "failed" },
  buildTitle: nonce => `Native provider loss ${nonce}`,
  buildVisibleMarker: nonce => `NATIVE-PROVIDER-LOSS-${nonce}`,
  buildPrompt: () => "Attempt the supplied exact native shell operation once and leave its permission callback unanswered. Do not retry, use another tool or path, answer your own permission, call paperclip_finish, or claim completion. The qualification fixture will deliberately lose the isolated runtime before any approval.",
  buildMatchers: () => [],
}];
