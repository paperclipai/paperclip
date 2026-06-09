import type { TelemetryConfig } from "./types.js";

const CI_ENV_VARS = ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI"];

function isCI(): boolean {
  return CI_ENV_VARS.some((key) => process.env[key] === "true" || process.env[key] === "1");
}

export function resolveTelemetryConfig(fileConfig?: { enabled?: boolean }): TelemetryConfig {
  if (process.env.PAPERCLIP_TELEMETRY_DISABLED === "1") {
    return { enabled: false };
  }
  if (process.env.DO_NOT_TRACK === "1") {
    return { enabled: false };
  }
  if (isCI()) {
    return { enabled: false };
  }
  if (fileConfig?.enabled === false) {
    return { enabled: false };
  }

  const endpoint = process.env.PAPERCLIP_TELEMETRY_ENDPOINT || undefined;
  return { enabled: true, endpoint };
}
