import { agentRuntimeSettingsHarness } from "@paperclipai/shared";

// Cloud choices are opt-in. Qualifying a new local harness does not release it
// to Cloud users, including through experimental settings or saved setup links.
const CLOUD_HARNESSES = new Set([
  "claude_local",
  "codex_local",
  "grok_local",
  "opencode_local",
  "copilot_runtime",
]);

export function isCloudHarnessAllowed(type: string, config: Record<string, unknown> = {}): boolean {
  return CLOUD_HARNESSES.has(agentRuntimeSettingsHarness(type, config));
}

export function isCloudRunnerProviderAllowed(provider: string, acpxAgent?: string): boolean {
  return isCloudHarnessAllowed("paperclip_runner", {
    provider: ["claude", "grok", "copilot"].includes(provider) ? "acpx" : provider,
    acpxAgent: acpxAgent ?? (provider === "acpx" ? "claude" : provider),
  });
}
