import type { RunnerTaskFixture } from "./types.js";

export const kimiLifecycleTasks: readonly RunnerTaskFixture[] = (["stop", "loss"] as const).map(branch => ({
  id: branch === "stop" ? "native-write-permission-stop" : "native-write-provider-loss",
  label: branch === "stop" ? "Stop unanswered native Kimi Write" : "Lose the native Kimi worker during unanswered Write",
  groups: [], workMode: "standard", flow: "kimi_native_lifecycle", expectedRunCount: 1,
  attemptTimeoutMs: { local: 300_000, daytona: 300_000 }, turnTimeoutMs: 120_000,
  expectedTerminalState: { issue: branch === "stop" ? "in_progress" : "blocked", run: branch === "stop" ? "cancelled" : "failed" },
  automaticRetryPolicy: "single_attempt",
  buildTitle: nonce => `Kimi native Write ${branch} ${nonce}`,
  buildVisibleMarker: nonce => `KIMI-NATIVE-WRITE-${branch.toUpperCase()}-${nonce}`,
  buildPrompt: () => "Use the native Kimi Write tool exactly once for the supplied absolute path and content MUST_NOT_EXIST. Leave its permission request unanswered for the board operator. Do not use Bash, Edit, delegation, another path or any semantic tool. Do not reject, approve, retry, cancel yourself, call paperclip_finish, or claim completion. The operator has already supplied the exact task title. This unfinished task will end while your real Write permission is still pending.",
  buildMatchers: () => [],
}));
