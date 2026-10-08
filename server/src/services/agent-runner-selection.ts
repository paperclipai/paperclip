import { agentHarnessType, isEnvironmentDriverSupportedForAdapter, paperclipRunnerSupportsPlatform, type AgentRunnerChoice, type AgentRunnerAvailability, paperclipRunnerProfileForHarness } from "@paperclipai/shared";
import { QUALIFIED_ACPX_PROFILES } from "../vendor/paperclip-runner/index.js";
import type { Db } from "@paperclipai/db";
import { AgentRunnerConfigError, resolveAgentRunnerConfig } from "@paperclipai/adapter-utils";
import { findActiveServerAdapter, hasActiveAdapterOverride, listEnabledServerAdapters } from "../adapters/registry.js";
import { getDisabledAdapterTypes } from "./adapter-plugin-store.js";
import { unprocessable } from "../errors.js";
import { PaperclipRunnerProviderProfileError, resolvePaperclipRunnerProviderProfile, validatePaperclipRunnerDotConfig } from "./native-runtime/provider-profile.js";
import { runSshCommand } from "@paperclipai/adapter-utils/ssh";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";

export function agentRunnerAvailability(harness: string, target?: { driver: string; platform?: string; architecture?: string }): AgentRunnerAvailability {
  const profile = paperclipRunnerProfileForHarness(harness);
  const qualified = profile && (!profile.acpxAgent
    || QUALIFIED_ACPX_PROFILES[profile.acpxAgent as keyof typeof QUALIFIED_ACPX_PROFILES]?.qualificationStatus !== "pending");
  const supported = !!qualified
    && !hasActiveAdapterOverride(harness)
    && !hasActiveAdapterOverride("paperclip_runner")
    && !!findActiveServerAdapter("paperclip_runner")
    && !getDisabledAdapterTypes().includes("paperclip_runner")
    && (!target || isEnvironmentDriverSupportedForAdapter("paperclip_runner", target.driver))
    && (!target?.platform || paperclipRunnerSupportsPlatform(harness, target.platform, target.architecture ?? ""));
  return { supportedRunners: supported ? ["paperclip", "legacy"] : ["legacy"], defaultRunner: supported ? "paperclip" : "legacy" };
}

/** Resolve before credentials, approval payloads, and adapter-specific defaults. */
export function resolveNewAgentRunner(input: {
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown>;
  runner?: AgentRunnerChoice;
  target?: { driver: string; platform?: string; architecture?: string };
}) {
  const adapterType = input.adapterType ?? "process";
  const harness = agentHarnessType(adapterType, input.adapterConfig);
  const availability = agentRunnerAvailability(harness, input.target);
  try {
    if (input.runner === "paperclip" && paperclipRunnerProfileForHarness(harness)
      && availability.defaultRunner !== "paperclip") {
      throw new AgentRunnerConfigError("Paperclip Runner is unavailable for this harness and target. Select the legacy runner.");
    }
    const resolved = resolveAgentRunnerConfig({ ...input, adapterType, nativeSupported: availability.defaultRunner === "paperclip" });
    const disabled = new Set(getDisabledAdapterTypes());
    for (const type of new Set([adapterType, resolved.adapterType])) {
      if (!findActiveServerAdapter(type)) throw unprocessable(`Unknown adapter type: ${type}`);
      if (disabled.has(type)) throw unprocessable(
        `Adapter "${type}" is not available on this instance. Available adapters: ${listEnabledServerAdapters().map(a => a.type).sort().join(", ") || "(none configured)"}`,
        { code: "agent_runner_unavailable" },
      );
    }
    if (resolved.adapterType === "paperclip_runner") {
      // Pairing happens after the agent is saved; execution still requires a binding.
      if (resolved.adapterConfig.provider === "openai_dot") validatePaperclipRunnerDotConfig(resolved.adapterConfig, false);
      else resolvePaperclipRunnerProviderProfile(resolved.adapterConfig);
    }
    return resolved;
  } catch (error) {
    if (error instanceof AgentRunnerConfigError) throw unprocessable(error.message, { code: error.code, fields: error.fields });
    if (error instanceof PaperclipRunnerProviderProfileError) throw unprocessable(error.message, { code: error.code });
    throw error;
  }
}

/** Resolve the same default environment used at dispatch, before any creation writes. */
export async function resolveNewAgentRunnerForCompany(db: Db, companyId: string, input: {
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown>;
  runner?: AgentRunnerChoice;
  defaultEnvironmentId?: string | null;
}) {
  const harness = agentHarnessType(input.adapterType ?? "process", input.adapterConfig);
  if (!paperclipRunnerProfileForHarness(harness) || input.runner === "legacy"
    || (input.adapterType === "paperclip_runner" && input.runner === undefined)) return resolveNewAgentRunner(input);
  const { instanceSettingsService } = await import("./instance-settings.js");
  const { environmentService } = await import("./environments.js");
  const settings = await instanceSettingsService(db).get();
  const envs = environmentService(db);
  const environmentId = input.defaultEnvironmentId ?? settings.defaultEnvironmentId;
  let environment = environmentId ? await envs.getById(environmentId)
    : settings.experimental?.enableManagedSandboxOnly ? await envs.findManagedSandboxEnvironment(companyId) : null;
  if (settings.experimental?.enableManagedSandboxOnly && (!environment || environment.driver === "local")) {
    environment = await envs.findManagedSandboxEnvironment(companyId);
    if (!environment) throw unprocessable("The managed sandbox is unavailable. Restore Paperclip Computer and retry.", { code: "managed_sandbox_unavailable" });
  }
  if (settings.general?.executionMode === "kubernetes") {
    environment = await envs.findKubernetesEnvironment(companyId);
    if (!environment) throw unprocessable("The required Kubernetes environment is unavailable.", { code: "kubernetes_environment_unavailable" });
  }
  const driver = environment?.driver ?? "local";
  let target = driver === "local" ? { driver, platform: process.platform, architecture: process.arch }
    : { driver, ...(driver === "sandbox" ? { platform: "linux", architecture: "x64" } : {}) };
  if (driver === "ssh" && environment && agentRunnerAvailability(harness, target).defaultRunner === "paperclip") {
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, environment);
    if (parsed.driver !== "ssh") throw unprocessable("The selected SSH environment is unavailable.", { code: "agent_runner_target_unavailable" });
    let output: string;
    try {
      // Probe only OS/CPU identity: no provider credentials or workspace writes.
      output = (await runSshCommand(parsed.config, "uname -s; uname -m", { timeoutMs: 10_000 })).stdout;
    } catch {
      throw unprocessable("Could not check the SSH host's platform. Check its connection and retry, or explicitly select the legacy runner.", { code: "agent_runner_platform_probe_failed" });
    }
    const [os = "", architecture = ""] = output.trim().split(/\r?\n/);
    target = { driver, platform: os === "Linux" ? "linux" : os === "Darwin" ? "darwin" : "unknown", architecture: architecture === "x86_64" ? "x64" : ["aarch64", "arm64"].includes(architecture) ? "arm64" : architecture };
  }
  return resolveNewAgentRunner({ ...input, target });
}
