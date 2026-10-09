/** Request intent only. Agents persist the selected adapter, not an automatic choice. */
export type AgentRunnerChoice = "auto" | "paperclip" | "legacy";
export type AgentRunner = Exclude<AgentRunnerChoice, "auto">;

export interface AgentRunnerAvailability {
  supportedRunners: AgentRunner[];
  defaultRunner: AgentRunner;
}

/** Codex is the only harness whose creation default graduates in this release. */
export function paperclipRunnerProfileForHarness(harness: string): { provider: "codex" } | undefined {
  return harness === "codex_local" ? { provider: "codex" } : undefined;
}

/** Public server packages currently ship a Linux x64 daemon; source-build targets are not release qualification. */
export function paperclipRunnerSupportsPlatform(harness: string, platform: string, architecture: string): boolean {
  return !!paperclipRunnerProfileForHarness(harness)
    && platform === "linux" && architecture === "x64";
}

/** Recover harness identity without changing execution or guessing unknown providers. */
export function agentHarnessType(adapterType: string, config: Record<string, unknown> = {}): string {
  if (adapterType !== "paperclip_runner") return adapterType;
  if (config.provider === undefined || config.provider === "codex") return "codex_local";
  if (config.provider === "opencode") return "opencode_local";
  if (config.provider === "acpx") {
    const agent = config.acpxAgent ?? "claude";
    return ({ codex: "codex_local", claude: "claude_local", grok: "grok_local", cursor: "cursor", pi: "pi_local" } as Record<string, string>)[String(agent)] ?? `acpx:${String(agent)}`;
  }
  return String(config.provider);
}

export function agentRunner(adapterType: string): AgentRunner {
  return adapterType === "paperclip_runner" ? "paperclip" : "legacy";
}
