import path from "node:path";
import {
  TelemetryClient,
  resolveTelemetryConfig,
  loadOrCreateState,
  trackInstallStarted,
  trackInstallCompleted,
  trackCompanyImported,
} from "../../packages/shared/src/telemetry/index.js";
import { resolvePaperclipInstanceRoot } from "./config/home.js";
import { readConfig } from "./config/store.js";
import { cliVersion } from "./version.js";

let client: TelemetryClient | null = null;

export function initTelemetry(fileConfig?: { enabled?: boolean }): TelemetryClient | null {
  if (client) return client;

  const config = resolveTelemetryConfig(fileConfig);
  if (!config.enabled) return null;

  const stateDir = path.join(resolvePaperclipInstanceRoot(), "telemetry");
  client = new TelemetryClient(config, () => loadOrCreateState(stateDir, cliVersion), cliVersion);
  return client;
}

export function initTelemetryFromConfigFile(configPath?: string): TelemetryClient | null {
  try {
    return initTelemetry(readConfig(configPath)?.telemetry);
  } catch {
    return initTelemetry();
  }
}

export function getTelemetryClient(): TelemetryClient | null {
  return client;
}

export async function flushTelemetry(): Promise<void> {
  if (client) {
    await client.flush();
  }
}

export {
  trackInstallStarted,
  trackInstallCompleted,
  trackCompanyImported,
};
