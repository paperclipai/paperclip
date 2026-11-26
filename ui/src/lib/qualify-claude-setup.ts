import type { AgentRunner, AgentRunnerChoice, Environment, EnvironmentProbeResult } from "@paperclipai/shared";
import type { AdapterInfo } from "../api/adapters";

export function needsClaudeSetupQualification(input: {
  adapterType: string;
  runner: AgentRunnerChoice;
  savedAgentId?: string | null;
  environment?: Pick<Environment, "driver" | "config"> | null;
}): boolean {
  const config = input.environment?.config;
  const immutableImage = typeof config?.image === "string" && /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(config.image) && !config.snapshot;
  const daytonaSnapshot = config?.provider === "daytona" && typeof config.snapshot === "string" && !!config.snapshot.trim() && !config.image;
  return !input.savedAgentId && input.adapterType === "claude_local" && input.runner === "auto"
    && input.environment?.driver === "sandbox" && (immutableImage || daytonaSnapshot)
    && !config?.template && !config?.templateRef;
}

export async function qualifyClaudeSetup(input: Parameters<typeof needsClaudeSetupQualification>[0] & {
  readAdapters: () => Promise<AdapterInfo[]>;
  probeEnvironment: () => Promise<EnvironmentProbeResult>;
  isCurrent: () => boolean;
}): Promise<{ runner: AgentRunner; adapters: AdapterInfo[] } | undefined> {
  if (!needsClaudeSetupQualification(input)) return undefined;
  const validate = (adapters: AdapterInfo[]) => {
    const claude = adapters.find(adapter => adapter.type === "claude_local");
    const runner = claude?.defaultRunner;
    if (!claude || (runner !== "paperclip" && runner !== "legacy") || !claude.supportedRunners?.includes(runner)) {
      throw new Error("Could not confirm Claude runner availability for this environment. Retry setup.");
    }
    return { runner, claude };
  };
  let adapters = await input.readAdapters();
  if (!input.isCurrent()) return undefined;
  const selected = validate(adapters);
  const native = adapters.find(adapter => adapter.type === "paperclip_runner");
  if (selected.runner === "paperclip" || selected.claude.disabled || selected.claude.overriddenBuiltin
    || !native || native.disabled || native.overriddenBuiltin) return { runner: selected.runner, adapters };
  const probe = await input.probeEnvironment();
  if (!input.isCurrent()) return undefined;
  if (probe.ok !== true || probe.details?.platformQualificationRecorded !== true
    || typeof probe.details.leaseId !== "string" || !probe.details.leaseId) {
    throw new Error(typeof probe.details?.platformQualificationDiagnostic === "string"
      ? probe.details.platformQualificationDiagnostic
      : probe.summary || "The environment's platform qualification could not be confirmed. Retry the connection probe or select Legacy runner in Advanced.");
  }
  adapters = await input.readAdapters();
  if (!input.isCurrent()) return undefined;
  return { runner: validate(adapters).runner, adapters };
}
