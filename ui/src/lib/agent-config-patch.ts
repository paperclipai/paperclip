import { ADAPTER_AGNOSTIC_KEYS, type Agent } from "@paperclipai/shared";

const REDACTED_CONFIG_VALUE = "***REDACTED***";

export interface AgentConfigOverlay {
  identity: Record<string, unknown>;
  adapterType?: string;
  adapterConfig: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  debug: Record<string, unknown>;
  runtime: Record<string, unknown>;
  literalRedactedConfigPaths?: string[][];
}

export function omitUndefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

export function buildAgentUpdatePatch(agent: Agent, overlay: AgentConfigOverlay) {
  const patch: Record<string, unknown> = {};

  if (Object.keys(overlay.identity).length > 0) {
    Object.assign(patch, overlay.identity);
  }

  if (overlay.adapterType !== undefined) {
    patch.adapterType = overlay.adapterType;
  }

  if (overlay.adapterType !== undefined || Object.keys(overlay.adapterConfig).length > 0) {
    const existing = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const nextAdapterConfig =
      overlay.adapterType !== undefined
        ? {
            ...Object.fromEntries(
              ADAPTER_AGNOSTIC_KEYS
                .filter((key) => existing[key] !== undefined)
                .map((key) => [key, existing[key]]),
            ),
            ...overlay.adapterConfig,
          }
        : {
            ...existing,
            ...overlay.adapterConfig,
          };

    patch.adapterConfig = omitUndefinedEntries(nextAdapterConfig);
    patch.replaceAdapterConfig = true;
  }

  if (
    Object.keys(overlay.heartbeat).length > 0
    || Object.keys(overlay.debug).length > 0
  ) {
    const existingRc = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    const nextRuntimeConfig: Record<string, unknown> = (patch.runtimeConfig as Record<string, unknown> | undefined)
      ?? { ...existingRc };

    if (Object.keys(overlay.heartbeat).length > 0) {
      const existingHb = (existingRc.heartbeat ?? {}) as Record<string, unknown>;
      nextRuntimeConfig.heartbeat = { ...existingHb, ...overlay.heartbeat };
    }

    if (Object.keys(overlay.debug).length > 0) {
      const existingDebug = (existingRc.debug ?? {}) as Record<string, unknown>;
      const nextDebug = omitUndefinedEntries({ ...existingDebug, ...overlay.debug });
      if (Object.keys(nextDebug).length === 0) {
        delete nextRuntimeConfig.debug;
      } else {
        nextRuntimeConfig.debug = nextDebug;
      }
    }

    patch.runtimeConfig = nextRuntimeConfig;
  }

  if (Object.keys(overlay.runtime).length > 0) {
    Object.assign(patch, overlay.runtime);
  }

  if (patch.adapterConfig !== undefined || patch.runtimeConfig !== undefined) {
    patch.preserveRedactedConfigValues = true;
    const literalPaths: string[][] = [...(overlay.literalRedactedConfigPaths ?? [])];
    const existingAdapterConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(overlay.adapterConfig)) {
      if (value === REDACTED_CONFIG_VALUE && existingAdapterConfig[key] === REDACTED_CONFIG_VALUE) {
        literalPaths.push(["adapterConfig", key]);
      }
    }
    const existingRuntimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    const existingHeartbeat = (existingRuntimeConfig.heartbeat ?? {}) as Record<string, unknown>;
    const existingDebug = (existingRuntimeConfig.debug ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(overlay.heartbeat)) {
      if (value === REDACTED_CONFIG_VALUE && existingHeartbeat[key] === REDACTED_CONFIG_VALUE) {
        literalPaths.push(["runtimeConfig", "heartbeat", key]);
      }
    }
    for (const [key, value] of Object.entries(overlay.debug)) {
      if (value === REDACTED_CONFIG_VALUE && existingDebug[key] === REDACTED_CONFIG_VALUE) {
        literalPaths.push(["runtimeConfig", "debug", key]);
      }
    }
    if (literalPaths.length > 0) {
      patch.literalRedactedConfigPaths = [
        ...new Map(literalPaths.map((path) => [JSON.stringify(path), path])).values(),
      ];
    }
  }

  return patch;
}
