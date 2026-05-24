import os from "node:os";
import path from "node:path";

export const DEFAULT_VALADRIEN_OS_INSTANCE_ID = "default";
export const VALADRIEN_OS_CONFIG_BASENAME = "config.json";
export const VALADRIEN_OS_ENV_FILENAME = ".env";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolveValadrienOsHomeDir(homeOverride?: string): string {
  const raw = homeOverride?.trim() || process.env.VALADRIEN_OS_HOME?.trim();
  if (raw) return path.resolve(expandHomePrefix(raw));
  return path.resolve(os.homedir(), ".valadrien-os");
}

export function resolveValadrienOsInstanceId(instanceIdOverride?: string): string {
  const raw = instanceIdOverride?.trim() || process.env.VALADRIEN_OS_INSTANCE_ID?.trim() || DEFAULT_VALADRIEN_OS_INSTANCE_ID;
  if (!PATH_SEGMENT_RE.test(raw)) {
    throw new Error(`Invalid VALADRIEN_OS_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolveValadrienOsInstanceRoot(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveValadrienOsHomeDir(input.homeDir), "instances", resolveValadrienOsInstanceId(input.instanceId));
}

export function resolveValadrienOsInstanceConfigPath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveValadrienOsInstanceRoot(input), VALADRIEN_OS_CONFIG_BASENAME);
}

export function resolveValadrienOsConfigPathForInstance(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return resolveValadrienOsInstanceConfigPath(input);
}

export function resolveValadrienOsEnvPathForConfig(configPath: string): string {
  return path.resolve(path.dirname(configPath), VALADRIEN_OS_ENV_FILENAME);
}

export function resolveDefaultEmbeddedPostgresDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveValadrienOsInstanceRoot(input), "db");
}

export function resolveDefaultLogsDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveValadrienOsInstanceRoot(input), "logs");
}

export function resolveDefaultSecretsKeyFilePath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveValadrienOsInstanceRoot(input), "secrets", "master.key");
}

export function resolveDefaultStorageDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveValadrienOsInstanceRoot(input), "data", "storage");
}

export function resolveDefaultBackupDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveValadrienOsInstanceRoot(input), "data", "backups");
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
