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
/**
 * Playbook section 13 "Permission denial" for providers whose proof is the
 * canonical stream alone (Antigravity): the operator denies the real native
 * permission in the browser, then stops the task. Same flow as the pending
 * Stop, with a browser denial first.
 */
export const nativePermissionDenialTasks: readonly RunnerTaskFixture[] = [{
  id: "permission-deny-stop", label: "Deny a native permission, then Stop", groups: [], workMode: "standard", flow: "native_active_stop",
  expectedRunCount: 1, attemptTimeoutMs: { local: 300_000, daytona: 300_000 }, turnTimeoutMs: 120_000,
  expectedTerminalState: { issue: "in_progress", run: "cancelled" },
  buildTitle: nonce => `Native permission denial ${nonce}`,
  buildVisibleMarker: nonce => `NATIVE-PERMISSION-DENIAL-${nonce}`,
  buildPrompt: () => "Attempt the supplied exact native operation once and wait for the board operator's permission decision. If it is denied, do not retry, do not use another tool or path, do not call paperclip_finish and do not claim completion; say only that the operation was denied. The operator will then stop this unfinished task.",
  buildMatchers: () => [], // Dedicated flow: browser denial, delivered decline, Stop and no-effect proof.
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
