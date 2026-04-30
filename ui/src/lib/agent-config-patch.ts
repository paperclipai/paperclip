import type { Agent } from "@paperclipai/shared";

export interface AgentModelProfileOverlay {
  enabled?: boolean;
  adapterConfig?: Record<string, unknown>;
  /**
   * Mark the cheap profile for clearing. When true, the patch removes
   * `runtimeConfig.modelProfiles.cheap` instead of merging into it.
   */
  cleared?: boolean;
}

export interface AgentConfigOverlay {
  identity: Record<string, unknown>;
  adapterType?: string;
  adapterConfig: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  runtime: Record<string, unknown>;
  modelProfiles?: { cheap?: AgentModelProfileOverlay };
}

const ADAPTER_AGNOSTIC_KEYS = [
  "env",
  "promptTemplate",
  "instructionsFilePath",
  "cwd",
  "timeoutSec",
  "graceSec",
  "bootstrapPromptTemplate",
] as const;

function omitUndefinedEntries(value: Record<string, unknown>) {
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

  const cheapOverlay = overlay.modelProfiles?.cheap;
  const hasModelProfileChange = cheapOverlay !== undefined;

  if (Object.keys(overlay.heartbeat).length > 0 || hasModelProfileChange) {
    const existingRc = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    const nextRuntimeConfig: Record<string, unknown> = (patch.runtimeConfig as Record<string, unknown> | undefined)
      ?? { ...existingRc };

    if (Object.keys(overlay.heartbeat).length > 0) {
      const existingHb = (existingRc.heartbeat ?? {}) as Record<string, unknown>;
      nextRuntimeConfig.heartbeat = { ...existingHb, ...overlay.heartbeat };
    }

    if (hasModelProfileChange) {
      const existingProfiles = ((existingRc.modelProfiles ?? {}) as Record<string, unknown>);
      const existingCheap = ((existingProfiles.cheap ?? {}) as Record<string, unknown>);
      const nextProfiles = { ...existingProfiles };

      if (cheapOverlay?.cleared) {
        delete nextProfiles.cheap;
      } else if (cheapOverlay) {
        const mergedAdapterConfig = {
          ...((existingCheap.adapterConfig ?? {}) as Record<string, unknown>),
          ...(cheapOverlay.adapterConfig ?? {}),
        };
        const enabled = cheapOverlay.enabled ?? (existingCheap.enabled !== false);
        nextProfiles.cheap = {
          ...existingCheap,
          enabled,
          adapterConfig: mergedAdapterConfig,
        };
      }

      if (Object.keys(nextProfiles).length === 0) {
        delete nextRuntimeConfig.modelProfiles;
      } else {
        nextRuntimeConfig.modelProfiles = nextProfiles;
      }
    }

    patch.runtimeConfig = nextRuntimeConfig;
  }

  if (Object.keys(overlay.runtime).length > 0) {
    Object.assign(patch, overlay.runtime);
  }

  return patch;
}
