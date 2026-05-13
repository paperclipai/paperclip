import os from "node:os";
import path from "node:path";

export const DEFAULT_ODYSSEUS_INSTANCE_ID = "default";
export const ODYSSEUS_CONFIG_BASENAME = "config.json";
export const ODYSSEUS_ENV_FILENAME = ".env";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolveOdysseusHomeDir(homeOverride?: string): string {
  const raw = homeOverride?.trim() || process.env.ODYSSEUS_HOME?.trim();
  if (raw) return path.resolve(expandHomePrefix(raw));
  return path.resolve(os.homedir(), ".odysseus");
}

export function resolveOdysseusInstanceId(instanceIdOverride?: string): string {
  const raw = instanceIdOverride?.trim() || process.env.ODYSSEUS_INSTANCE_ID?.trim() || DEFAULT_ODYSSEUS_INSTANCE_ID;
  if (!PATH_SEGMENT_RE.test(raw)) {
    throw new Error(`Invalid ODYSSEUS_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolveOdysseusInstanceRoot(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveOdysseusHomeDir(input.homeDir), "instances", resolveOdysseusInstanceId(input.instanceId));
}

export function resolveOdysseusInstanceConfigPath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveOdysseusInstanceRoot(input), ODYSSEUS_CONFIG_BASENAME);
}

export function resolveOdysseusConfigPathForInstance(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return resolveOdysseusInstanceConfigPath(input);
}

export function resolveOdysseusEnvPathForConfig(configPath: string): string {
  return path.resolve(path.dirname(configPath), ODYSSEUS_ENV_FILENAME);
}

export function resolveDefaultEmbeddedPostgresDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveOdysseusInstanceRoot(input), "db");
}

export function resolveDefaultLogsDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveOdysseusInstanceRoot(input), "logs");
}

export function resolveDefaultSecretsKeyFilePath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveOdysseusInstanceRoot(input), "secrets", "master.key");
}

export function resolveDefaultStorageDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveOdysseusInstanceRoot(input), "data", "storage");
}

export function resolveDefaultBackupDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveOdysseusInstanceRoot(input), "data", "backups");
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
