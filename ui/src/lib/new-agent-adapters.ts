const CLOUD_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "opencode_local",
  "grok_local",
]);

/** Creation policy shared by the picker and direct setup links. */
export function isNewAgentAdapterAllowed(
  type: string,
  {
    cloud,
    nativeRunnerEnabled,
    openAiDotEnabled = false,
    museEnabled = false,
    runnerProvider,
  }: { cloud: boolean; nativeRunnerEnabled: boolean; openAiDotEnabled?: boolean; museEnabled?: boolean; runnerProvider?: string },
) {
  if (type === "openai_dot" || (type === "paperclip_runner" && runnerProvider === "openai_dot")) {
    return openAiDotEnabled;
  }
  if (type === "muse" || (type === "paperclip_runner" && runnerProvider === "muse")) return museEnabled && nativeRunnerEnabled;
  if (type === "paperclip_runner") return nativeRunnerEnabled;
  if (cloud) return CLOUD_ADAPTERS.has(type);
  return true;
}
