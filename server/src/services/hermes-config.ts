import { statSync } from "node:fs";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPlainEnvString(value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return null;
  if (record.type === "plain" && typeof record.value === "string") {
    return record.value;
  }
  return null;
}

export function normalizeHermesConfigForPersistence(
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...adapterConfig };
  const env = asRecord(adapterConfig.env);
  const legacyHermesHome = readPlainEnvString(env?.HERMES_HOME);
  if (!legacyHermesHome) {
    return normalized;
  }

  const command = asNonEmptyString(adapterConfig.command);
  const hermesCommand = asNonEmptyString(adapterConfig.hermesCommand);
  const shouldPromoteProfilePath =
    (!command && !hermesCommand)
    || command === legacyHermesHome
    || hermesCommand === legacyHermesHome;

  if (shouldPromoteProfilePath) {
    normalized.command = legacyHermesHome;
    normalized.hermesCommand = legacyHermesHome;
  }

  const nextEnv = { ...env };
  delete nextEnv.HERMES_HOME;
  normalized.env = nextEnv;
  return normalized;
}

export function resolveHermesRuntimeConfig(
  adapterType: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (adapterType !== "hermes_local") return config;

  const normalized = { ...config };
  if (normalized.timeoutSec == null || normalized.timeoutSec === 0) {
    // Hermes currently treats `0` as falsy and falls back to its internal
    // 300-second default. Pass `-1` at runtime so PrivateClip's "no timeout"
    // intent survives until the adapter package is fixed upstream.
    normalized.timeoutSec = -1;
  }

  const effectiveCommand = asNonEmptyString(config.hermesCommand) ?? asNonEmptyString(config.command);
  if (!effectiveCommand) {
    return normalized;
  }

  try {
    if (statSync(effectiveCommand).isDirectory()) {
      const env = asRecord(normalized.env);
      normalized.env = {
        ...(env ?? {}),
        HERMES_HOME: effectiveCommand,
      };
      normalized.command = "hermes";
      normalized.hermesCommand = "hermes";
      return normalized;
    }
  } catch {
    // Fall through and treat the configured value as an executable path.
  }

  normalized.command = effectiveCommand;
  normalized.hermesCommand = effectiveCommand;
  return normalized;
}
