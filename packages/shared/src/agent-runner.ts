/** A creation-time choice. Saved agents keep their resolved adapter. */
export type AgentRunnerChoice = "auto" | "paperclip" | "legacy";
export type AgentRunner = Exclude<AgentRunnerChoice, "auto">;

/** Qualification is a release property, never an operator-configurable bypass. */
export const PAPERCLIP_RUNNER_ACPX_PROFILES = Object.freeze([
  { value: "grok", label: "Grok Build", qualified: true, credentialEnvironment: ["XAI_API_KEY"] },
  { value: "claude", label: "Claude", qualified: true, credentialEnvironment: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] },
  { value: "cursor", label: "Cursor", qualified: true, credentialEnvironment: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] },
  { value: "copilot", label: "GitHub Copilot", qualified: false, credentialEnvironment: ["COPILOT_GITHUB_TOKEN"] },
  { value: "pi", label: "Pi", qualified: false, credentialEnvironment: ["OPENROUTER_API_KEY"] },
] as const);

const NATIVE_HARNESSES: Record<string, { provider: string; acpxAgent?: string }> = {
  codex_local: { provider: "codex" },
  opencode_local: { provider: "opencode" },
  claude_local: { provider: "acpx", acpxAgent: "claude" },
  grok_local: { provider: "acpx", acpxAgent: "grok" },
  cursor: { provider: "acpx", acpxAgent: "cursor" },
};

export function paperclipRunnerProfileForHarness(harness: string) {
  const profile = Object.hasOwn(NATIVE_HARNESSES, harness) ? NATIVE_HARNESSES[harness] : undefined;
  if (profile?.acpxAgent && !PAPERCLIP_RUNNER_ACPX_PROFILES.some(p => p.value === profile.acpxAgent && p.qualified)) return undefined;
  return profile ? { ...profile } : undefined;
}

/** Platforms shipped by the qualified runner/provider distributions. */
export function paperclipRunnerSupportsPlatform(harness: string, platform: string, architecture: string): boolean {
  if (!paperclipRunnerProfileForHarness(harness)) return false;
  if (platform === "linux") return architecture === "x64";
  return platform === "darwin" && (architecture === "arm64" || (architecture === "x64" && harness !== "grok_local"));
}

/** Unknown or managed profiles keep their identity; never guess Codex. */
export function agentHarnessType(adapterType: string, config: Record<string, unknown> = {}): string {
  if (adapterType !== "paperclip_runner") return adapterType;
  if (config.provider === undefined || config.provider === "codex") return "codex_local";
  if (config.provider === "opencode") return "opencode_local";
  if (config.provider === "acpx") {
    const agent = config.acpxAgent ?? "claude";
    if (agent === "codex") return "codex_local";
    return Object.entries(NATIVE_HARNESSES).find(([, profile]) => profile.acpxAgent === agent)?.[0] ?? `acpx:${String(agent)}`;
  }
  return String(config.provider);
}

export function agentRunner(adapterType: string): AgentRunner {
  return adapterType === "paperclip_runner" ? "paperclip" : "legacy";
}

export interface AgentRunnerAvailability {
  supportedRunners: AgentRunner[];
  defaultRunner: AgentRunner;
}
