import type { TelemetryConfig } from "./types.js";

const CI_ENV_VARS = ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI"];

function isCI(): boolean {
  return CI_ENV_VARS.some((key) => process.env[key] === "true" || process.env[key] === "1");
}

export function resolveTelemetryConfig(fileConfig?: { enabled?: boolean }): TelemetryConfig {
  // Telemetry is now disabled by default
  return { enabled: false };
}
