import type { AgentAdapterType, EnvironmentDriver } from "./constants.js";

export type EnvironmentSupportStatus = "supported" | "unsupported";

export interface AdapterEnvironmentSupport {
  adapterType: AgentAdapterType;
  drivers: Record<EnvironmentDriver, EnvironmentSupportStatus>;
}

export interface EnvironmentCapabilities {
  adapters: AdapterEnvironmentSupport[];
  drivers: Record<EnvironmentDriver, EnvironmentSupportStatus>;
}

const REMOTE_MANAGED_ADAPTERS = new Set<AgentAdapterType>([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

export function adapterSupportsRemoteManagedEnvironments(adapterType: string): boolean {
  return REMOTE_MANAGED_ADAPTERS.has(adapterType as AgentAdapterType);
}

export function supportedEnvironmentDriversForAdapter(adapterType: string): EnvironmentDriver[] {
  return adapterSupportsRemoteManagedEnvironments(adapterType)
    ? ["local", "ssh"]
    : ["local"];
}

export function isEnvironmentDriverSupportedForAdapter(
  adapterType: string,
  driver: string,
): boolean {
  return supportedEnvironmentDriversForAdapter(adapterType).includes(driver as EnvironmentDriver);
}

export function getAdapterEnvironmentSupport(
  adapterType: AgentAdapterType,
): AdapterEnvironmentSupport {
  const supportedDrivers = new Set(supportedEnvironmentDriversForAdapter(adapterType));
  return {
    adapterType,
    drivers: {
      local: supportedDrivers.has("local") ? "supported" : "unsupported",
      ssh: supportedDrivers.has("ssh") ? "supported" : "unsupported",
    },
  };
}

export function getEnvironmentCapabilities(
  adapterTypes: readonly AgentAdapterType[],
): EnvironmentCapabilities {
  return {
    adapters: adapterTypes.map((adapterType) => getAdapterEnvironmentSupport(adapterType)),
    drivers: {
      local: "supported",
      ssh: "supported",
    },
  };
}
