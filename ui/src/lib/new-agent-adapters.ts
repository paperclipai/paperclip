import { PAPERCLIP_RUNNER_ACPX_PROFILES } from "@paperclipai/adapter-utils";
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
    candidateHarnesses,
  }: { cloud: boolean; nativeRunnerEnabled: boolean; openAiDotEnabled?: boolean; museEnabled?: boolean; runnerProvider?: string;
    candidateHarnesses?: readonly { agent: "antigravity"; model: string }[] },
) {
  if (type === "openai_dot" || (type === "paperclip_runner" && runnerProvider === "openai_dot")) {
    return openAiDotEnabled;
  }
  if (type === "muse" || (type === "paperclip_runner" && runnerProvider === "muse")) return museEnabled && nativeRunnerEnabled;
  if (type === "paperclip_runner" && runnerProvider === "antigravity") return PAPERCLIP_RUNNER_ACPX_PROFILES.some(profile => profile.value === "antigravity" && profile.qualified)
    || Boolean(candidateHarnesses?.some(candidate => candidate.agent === "antigravity" && candidate.model));
  if (type === "paperclip_runner") return runnerProvider === "copilot" || nativeRunnerEnabled;
  if (cloud) return CLOUD_ADAPTERS.has(type);
  return true;
}
