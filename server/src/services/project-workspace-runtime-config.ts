import type { ProjectWorkspaceRuntimeConfig } from "@paperclipai/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? { ...value } : null;
}

function readDesiredState(value: unknown): ProjectWorkspaceRuntimeConfig["desiredState"] {
  return value === "running" || value === "stopped" || value === "manual" ? value : null;
}

function readServiceStates(value: unknown): ProjectWorkspaceRuntimeConfig["serviceStates"] {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter(([, state]) =>
    state === "running" || state === "stopped" || state === "manual"
  );
  if (entries.length === 0) return null;
  return Object.fromEntries(entries) as ProjectWorkspaceRuntimeConfig["serviceStates"];
}

export function readProjectWorkspaceRuntimeConfig(
  metadata: Record<string, unknown> | null | undefined,
): ProjectWorkspaceRuntimeConfig | null {
  const raw = isRecord(metadata?.runtimeConfig) ? metadata.runtimeConfig : null;
  if (!raw) return null;

  const config: ProjectWorkspaceRuntimeConfig = {
    workspaceRuntime: cloneRecord(raw.workspaceRuntime),
    desiredState: readDesiredState(raw.desiredState),
    serviceStates: readServiceStates(raw.serviceStates),
  };

  const hasConfig = config.workspaceRuntime !== null || config.desiredState !== null || config.serviceStates !== null;
  return hasConfig ? config : null;
}

export function mergeProjectWorkspaceRuntimeConfig(
  metadata: Record<string, unknown> | null | undefined,
  patch: Partial<ProjectWorkspaceRuntimeConfig> | null,
): Record<string, unknown> | null {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const current = readProjectWorkspaceRuntimeConfig(metadata) ?? {
    workspaceRuntime: null,
    desiredState: null,
    serviceStates: null,
  };

  if (patch === null) {
    delete nextMetadata.runtimeConfig;
    return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
  }

  const nextConfig: ProjectWorkspaceRuntimeConfig = {
    workspaceRuntime:
      patch.workspaceRuntime !== undefined ? cloneRecord(patch.workspaceRuntime) : current.workspaceRuntime,
    desiredState:
      patch.desiredState !== undefined ? readDesiredState(patch.desiredState) : current.desiredState,
    serviceStates:
      patch.serviceStates !== undefined ? readServiceStates(patch.serviceStates) : current.serviceStates,
  };

  if (nextConfig.workspaceRuntime === null && nextConfig.desiredState === null && nextConfig.serviceStates === null) {
    delete nextMetadata.runtimeConfig;
  } else {
    nextMetadata.runtimeConfig = nextConfig;
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
}
