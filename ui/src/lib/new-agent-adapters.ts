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
    openAiDotEnabled = false,
    runnerProvider,
  }: { cloud: boolean; nativeRunnerEnabled: boolean; openAiDotEnabled?: boolean; runnerProvider?: string },
) {
  if (type === "openai_dot" || (type === "paperclip_runner" && runnerProvider === "openai_dot")) {
    return !cloud && openAiDotEnabled;
  }
  if (type === "paperclip_runner") return false;
  if (cloud) return CLOUD_ADAPTERS.has(type);
  return true;
}
