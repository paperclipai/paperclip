export type AgentRunnerChoice = "auto" | "paperclip" | "legacy";
export type AgentRunner = Exclude<AgentRunnerChoice, "auto">;

export interface AgentRunnerAvailability {
  supportedRunners: AgentRunner[];
  defaultRunner: AgentRunner;
}

export function paperclipRunnerProfileForHarness(harness: string): { provider: "codex" | "opencode" } | { provider: "acpx"; acpxAgent: "claude" | "pi" | "grok" } | undefined {
  if (harness === "codex_local") return { provider: "codex" };
  if (harness === "claude_local") return { provider: "acpx", acpxAgent: "claude" };
  if (harness === "pi_local") return { provider: "acpx", acpxAgent: "pi" };
  if (harness === "grok_local") return { provider: "acpx", acpxAgent: "grok" };
  if (harness === "opencode_local") return { provider: "opencode" };
  return undefined;
}

export const PAPERCLIP_RUNNER_MINIMUM_GLIBC_VERSION = "2.39";

function supportsLinuxLibc(libc?: "glibc" | "musl" | "unknown", version?: string): boolean {
  if (libc !== undefined && libc !== "glibc") return false;
  if (version === undefined) return true;
  const match = typeof version === "string" ? version.trim().match(/^(?:glibc\s+)?(\d+)\.(\d+)(?:\.\d+)?$/) : null;
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return false;
  const [requiredMajor, requiredMinor] = PAPERCLIP_RUNNER_MINIMUM_GLIBC_VERSION.split(".").map(Number);
  return major > requiredMajor! || (major === requiredMajor && minor >= requiredMinor!);
}

export function paperclipRunnerSupportsPlatform(harness: string, platform: string, architecture: string, libc?: "glibc" | "musl" | "unknown", glibcVersion?: string): boolean {
  return !!paperclipRunnerProfileForHarness(harness)
    && (harness !== "grok_local" || (platform === "linux" && architecture === "x64") || (platform === "darwin" && architecture === "arm64"))
    && !(["opencode_local", "pi_local"].includes(harness) && platform === "linux" && architecture === "arm64")
    && ((platform === "linux" && supportsLinuxLibc(libc, glibcVersion) && (architecture === "x64" || architecture === "arm64"))
      || (platform === "darwin" && (architecture === "arm64" || architecture === "x64")));
}

export function agentHarnessType(adapterType: string, config: Record<string, unknown> = {}): string {
  if (adapterType !== "paperclip_runner") return adapterType;
  if (config.provider === undefined || config.provider === "codex") return "codex_local";
  if (config.provider === "opencode") return "opencode_local";
  if (config.provider === "acpx") {
    const agent = config.acpxAgent ?? "claude";
    return ({ codex: "codex_local", claude: "claude_local", grok: "grok_local", cursor: "cursor", pi: "pi_local", antigravity: "antigravity_runtime" } as Record<string, string>)[String(agent)] ?? `acpx:${String(agent)}`;
  }
  return String(config.provider);
}

export function agentRunner(adapterType: string): AgentRunner {
  return adapterType === "paperclip_runner" ? "paperclip" : "legacy";
}

/** Stable configuration group across native and legacy execution backends. */
export function agentRuntimeSettingsHarness(adapterType: string, config: Record<string, unknown> = {}): string {
  const harness = agentHarnessType(adapterType, config);
  if (harness === "acpx:copilot") return "copilot_runtime";
  if (harness === "cursor") return "cursor_local";
  return harness;
}
