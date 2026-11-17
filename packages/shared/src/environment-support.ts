import type { AgentAdapterType, EnvironmentDriver } from "./constants.js";
import type { SandboxEnvironmentProvider } from "./types/environment.js";
import type {
  JsonSchema,
  PluginEnvironmentTemplateConfigBinding,
  SandboxProviderCapabilities,
} from "./types/plugin.js";

/**
 * Resolve the DECLARED sandbox capabilities of a provider driver, with the
 * legacy `supportsReusableLeases` flag folded in for compatibility.
 *
 * The result is a partial: a key is present only when the driver declared it,
 * so a caller can tell a declared `false` from an absent key. The nested
 * `sandboxCapabilities.reusableLeases` wins over the legacy flag when both are
 * present. This is the DECLARATION only; the runtime still intersects it with
 * the verified worker methods and any narrowing before it grants a capability.
 */
export function resolveDeclaredSandboxCapabilities(
  driver: {
    supportsReusableLeases?: boolean;
    sandboxCapabilities?: SandboxProviderCapabilities;
  },
): SandboxProviderCapabilities {
  const declared: SandboxProviderCapabilities = { ...(driver.sandboxCapabilities ?? {}) };
  if (declared.reusableLeases === undefined && driver.supportsReusableLeases !== undefined) {
    declared.reusableLeases = driver.supportsReusableLeases;
  }
  return declared;
}

export type EnvironmentSupportStatus = "supported" | "unsupported";

export interface AdapterEnvironmentSupport {
  adapterType: AgentAdapterType;
  drivers: Record<EnvironmentDriver, EnvironmentSupportStatus>;
  sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentSupportStatus>;
}

export interface EnvironmentProviderCapability {
  status: EnvironmentSupportStatus;
  supportsSavedProbe: boolean;
  supportsUnsavedProbe: boolean;
  supportsRunExecution: boolean;
  supportsReusableLeases: boolean;
  supportsInteractiveSetup: boolean;
  interactiveSetupConnectionTypes: string[];
  supportsTemplateCapture: boolean;
  templateRefKind?: string;
  templateConfigBinding?: PluginEnvironmentTemplateConfigBinding;
  supportsTemplateDelete: boolean;
  supportsLoginPty: boolean;
  displayName?: string;
  description?: string;
  source?: "builtin" | "plugin";
  pluginKey?: string;
  pluginId?: string;
  configSchema?: JsonSchema;
}

export interface EnvironmentCapabilities {
  adapters: AdapterEnvironmentSupport[];
  drivers: Record<EnvironmentDriver, EnvironmentSupportStatus>;
  sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentProviderCapability>;
}

const REMOTE_MANAGED_ADAPTERS = new Set<AgentAdapterType>([
  "claude_local",
  "codex_local",
  "paperclip_runner",
  "cursor",
  "gemini_local",
  "grok_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
]);

// Adapters that run in sandbox environments only, never over SSH, and only on the
// listed sandbox providers. hermes_local (TECH-8174) carries its system prompt and
// provider key in the exec env, which only the Kubernetes provider keeps out of the
// exec command (env over stdin), so other providers are not offered. Keep in sync with
// HERMES_SANDBOX_PROVIDERS in packages/adapters/hermes/src/server/execute-sandbox.ts, which refuses
// any other provider at run time (the adapter does not depend on this package).
const SANDBOX_ONLY_ADAPTER_PROVIDERS: ReadonlyMap<AgentAdapterType, readonly string[]> = new Map([
  ["hermes_local", ["kubernetes"]],
]);
const SANDBOX_ONLY_ADAPTERS = new Set<AgentAdapterType>(SANDBOX_ONLY_ADAPTER_PROVIDERS.keys());

export function adapterSupportsRemoteManagedEnvironments(adapterType: string): boolean {
  return REMOTE_MANAGED_ADAPTERS.has(adapterType as AgentAdapterType);
}

/** True when the adapter may run in a sandbox environment (remote-managed or sandbox-only). */
export function adapterSupportsSandboxEnvironments(adapterType: string): boolean {
  return adapterSupportsRemoteManagedEnvironments(adapterType) ||
    SANDBOX_ONLY_ADAPTERS.has(adapterType as AgentAdapterType);
}

export function supportedEnvironmentDriversForAdapter(adapterType: string): EnvironmentDriver[] {
  if (adapterType === "paperclip_runner") return ["local", "ssh", "sandbox", "plugin"];
  if (adapterSupportsRemoteManagedEnvironments(adapterType)) return ["local", "ssh", "sandbox"];
  return SANDBOX_ONLY_ADAPTERS.has(adapterType as AgentAdapterType) ? ["local", "sandbox"] : ["local"];
}

export function supportedSandboxProvidersForAdapter(
  adapterType: string,
  additionalProviders: readonly string[] = [],
): SandboxEnvironmentProvider[] {
  if (!adapterSupportsSandboxEnvironments(adapterType)) return [];
  const providers = Array.from(new Set(additionalProviders));
  const only = SANDBOX_ONLY_ADAPTER_PROVIDERS.get(adapterType as AgentAdapterType);
  return (only ? providers.filter((provider) => only.includes(provider)) : providers) as SandboxEnvironmentProvider[];
}

export function isEnvironmentDriverSupportedForAdapter(
  adapterType: string,
  driver: string,
): boolean {
  return supportedEnvironmentDriversForAdapter(adapterType).includes(driver as EnvironmentDriver);
}

export function isSandboxProviderSupportedForAdapter(
  adapterType: string,
  provider: string | null | undefined,
  additionalProviders: readonly string[] = [],
): boolean {
  if (!provider) return false;
  return supportedSandboxProvidersForAdapter(adapterType, additionalProviders).includes(
    provider as SandboxEnvironmentProvider,
  );
}

export function getAdapterEnvironmentSupport(
  adapterType: AgentAdapterType,
  additionalSandboxProviders: readonly string[] = [],
): AdapterEnvironmentSupport {
  const supportedDrivers = new Set(supportedEnvironmentDriversForAdapter(adapterType));
  const supportedProviders = new Set(supportedSandboxProvidersForAdapter(adapterType, additionalSandboxProviders));
  const sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentSupportStatus> = {
    fake: "unsupported",
  };
  for (const provider of additionalSandboxProviders) {
    sandboxProviders[provider as SandboxEnvironmentProvider] = supportedProviders.has(provider as SandboxEnvironmentProvider)
      ? "supported"
      : "unsupported";
  }
  return {
    adapterType,
    drivers: {
      local: supportedDrivers.has("local") ? "supported" : "unsupported",
      ssh: supportedDrivers.has("ssh") ? "supported" : "unsupported",
      sandbox: supportedDrivers.has("sandbox") ? "supported" : "unsupported",
      plugin: supportedDrivers.has("plugin") ? "supported" : "unsupported",
    },
    sandboxProviders,
  };
}

export function getEnvironmentCapabilities(
  adapterTypes: readonly AgentAdapterType[],
  options: {
    sandboxProviders?: Record<string, Partial<EnvironmentProviderCapability>>;
  } = {},
): EnvironmentCapabilities {
  const pluginProviderKeys = Object.keys(options.sandboxProviders ?? {});
  const sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentProviderCapability> = {
    fake: {
      status: "unsupported",
      supportsSavedProbe: true,
      supportsUnsavedProbe: true,
      supportsRunExecution: false,
      // The fake provider runtime declares false. The presentation must match
      // it, so execution and presentation agree.
      supportsReusableLeases: false,
      supportsInteractiveSetup: false,
      interactiveSetupConnectionTypes: [],
      supportsTemplateCapture: false,
      supportsTemplateDelete: false,
      supportsLoginPty: false,
      displayName: "Fake",
      source: "builtin",
    },
  };
  for (const [provider, capability] of Object.entries(options.sandboxProviders ?? {})) {
    sandboxProviders[provider as SandboxEnvironmentProvider] = {
      status: capability.status ?? "supported",
      supportsSavedProbe: capability.supportsSavedProbe ?? true,
      supportsUnsavedProbe: capability.supportsUnsavedProbe ?? true,
      supportsRunExecution: capability.supportsRunExecution ?? true,
      // Default absent to false. A manifest that does not declare reusable
      // leases must present as false, so execution (=== true) agrees.
      supportsReusableLeases: capability.supportsReusableLeases ?? false,
      supportsInteractiveSetup: capability.supportsInteractiveSetup ?? false,
      interactiveSetupConnectionTypes: capability.interactiveSetupConnectionTypes ?? [],
      supportsTemplateCapture: capability.supportsTemplateCapture ?? false,
      templateRefKind: capability.templateRefKind,
      templateConfigBinding: capability.templateConfigBinding,
      supportsTemplateDelete: capability.supportsTemplateDelete ?? false,
      supportsLoginPty: capability.supportsLoginPty ?? false,
      displayName: capability.displayName,
      description: capability.description,
      source: capability.source ?? "plugin",
      pluginKey: capability.pluginKey,
      pluginId: capability.pluginId,
      configSchema: capability.configSchema,
    };
  }
  return {
    adapters: adapterTypes.map((adapterType) => getAdapterEnvironmentSupport(adapterType, pluginProviderKeys)),
    drivers: {
      local: "supported",
      ssh: "supported",
      sandbox: "supported",
      plugin: adapterTypes.includes("paperclip_runner") ? "supported" : "unsupported",
    },
    sandboxProviders,
  };
}
