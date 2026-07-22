import type { ServerRuntimeInfo } from "@paperclipai/shared";

function parsePortFromUrl(value: string): number | null {
  try {
    const url = new URL(value);
    if (url.port) {
      const parsed = Number.parseInt(url.port, 10);
      return Number.isInteger(parsed) ? parsed : null;
    }
    if (url.protocol === "http:") return 80;
    if (url.protocol === "https:") return 443;
    return null;
  } catch {
    return null;
  }
}

export function normalizeShadowSourceApi(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.replace(/\/$/, "");
}

export function isShadowRuntime(value: string | null | undefined): boolean {
  return normalizeShadowSourceApi(value) !== null;
}

export function resolveServerRuntimeInfo(input: {
  listenPort: number | null;
  shadowSourceApi?: string | null;
  heartbeatSchedulerEnabled: boolean;
  databaseBackupEnabled: boolean;
}): ServerRuntimeInfo {
  const shadowSourceApi = normalizeShadowSourceApi(input.shadowSourceApi);
  const shadowMode = shadowSourceApi !== null;

  return {
    role: shadowMode ? "shadow" : "primary",
    shadowSourceApi,
    shadowSourcePort: shadowSourceApi ? parsePortFromUrl(shadowSourceApi) : null,
    targetPort: input.listenPort,
    scheduler: {
      enabled: shadowMode ? false : input.heartbeatSchedulerEnabled,
      owner: shadowMode ? "source_api" : "local",
    },
    backups: {
      enabled: shadowMode ? false : input.databaseBackupEnabled,
      owner: shadowMode ? "source_api" : "local",
    },
  };
}
