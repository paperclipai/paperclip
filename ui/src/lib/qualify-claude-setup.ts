import { localizeUiError } from "@/lib/localized-ui-error";
import type { AgentRunner, AgentRunnerChoice, Environment, EnvironmentProbeResult } from "@paperclipai/shared";
import type { AdapterInfo } from "../api/adapters";

export function needsClaudeSetupQualification(input: {
  adapterType: string;
  runner: AgentRunnerChoice;
  savedAgentId?: string | null;
  environment?: Pick<Environment, "driver" | "config"> | null;
}): boolean {
  return !input.savedAgentId && input.adapterType === "claude_local" && input.runner === "auto"
    && canQualifyRunnerEnvironment(input.environment);
}

export function canQualifyRunnerEnvironment(environment?: Pick<Environment, "driver" | "config"> | null): boolean {
  const config = environment?.config;
  const immutableImage = typeof config?.image === "string" && /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(config.image) && !config.snapshot;
  const daytonaSnapshot = config?.provider === "daytona" && typeof config.snapshot === "string" && !!config.snapshot.trim() && !config.image;
  return environment?.driver === "sandbox" && (immutableImage || daytonaSnapshot)
    && !config?.template && !config?.templateRef;
}

export async function qualifyClaudeSetup(input: Parameters<typeof needsClaudeSetupQualification>[0] & {
  readAdapters: () => Promise<AdapterInfo[]>;
  probeEnvironment: () => Promise<EnvironmentProbeResult>;
  isCurrent: () => boolean;
}): Promise<{ runner: AgentRunner; adapters: AdapterInfo[] } | undefined> {
  if (!needsClaudeSetupQualification(input)) return undefined;
  return qualifyRunnerEnvironment(input);
}

export async function qualifyRunnerEnvironment(input: {
  adapterType: string;
  readAdapters: () => Promise<AdapterInfo[]>;
  probeEnvironment: () => Promise<EnvironmentProbeResult>;
  isCurrent: () => boolean;
}): Promise<{ runner: AgentRunner; adapters: AdapterInfo[] } | undefined> {
  const validate = (adapters: AdapterInfo[]) => {
    const harness = adapters.find(adapter => adapter.type === input.adapterType);
    const runner = harness?.defaultRunner;
    if (!harness || (runner !== "paperclip" && runner !== "legacy") || !harness.supportedRunners?.includes(runner)) {
      throw localizeUiError(new Error("Could not confirm runner availability for this environment. Retry setup."), { key: "integration-errors:runnerUnavailable" });
    }
    return { runner, harness };
  };
  let adapters = await input.readAdapters();
  if (!input.isCurrent()) return undefined;
  const selected = validate(adapters);
  const native = adapters.find(adapter => adapter.type === "paperclip_runner");
  if (selected.runner === "paperclip" || selected.harness.disabled || selected.harness.overriddenBuiltin
    || !native || native.disabled || native.overriddenBuiltin) return { runner: selected.runner, adapters };
  const probe = await input.probeEnvironment();
  if (!input.isCurrent()) return undefined;
  if (probe.ok !== true || probe.details?.platformQualificationRecorded !== true
    || typeof probe.details.leaseId !== "string" || !probe.details.leaseId) {
    // Provider diagnostics remain raw even when they exactly equal our fallback.
    if (typeof probe.details?.platformQualificationDiagnostic === "string") {
      throw new Error(probe.details.platformQualificationDiagnostic);
    }
    if (probe.summary) throw new Error(probe.summary);
    throw localizeUiError(new Error("The environment's platform qualification could not be confirmed. Retry the connection probe or select Legacy runner in Advanced."), { key: "integration-errors:qualificationUnconfirmed" });
  }
  adapters = await input.readAdapters();
  if (!input.isCurrent()) return undefined;
  return { runner: validate(adapters).runner, adapters };
}
