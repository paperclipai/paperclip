import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";
export const PAPERCLIP_CONFIG_BASENAME = "config.json";
export const PAPERCLIP_ENV_FILENAME = ".env";
export const PAPERCLIP_X10_SENTINEL_BASENAME = ".thinkstack-x10-sentinel";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export interface PaperclipCompanyConfig {
  workProductsRoot: string | null;
}

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolvePaperclipHomeDir(homeOverride?: string): string {
  const raw = homeOverride?.trim() || process.env.PAPERCLIP_HOME?.trim();
  if (raw) return path.resolve(expandHomePrefix(raw));
  return path.resolve(os.homedir(), ".paperclip");
}

export function resolvePaperclipInstanceId(instanceIdOverride?: string): string {
  const raw = instanceIdOverride?.trim() || process.env.PAPERCLIP_INSTANCE_ID?.trim() || DEFAULT_PAPERCLIP_INSTANCE_ID;
  if (!PATH_SEGMENT_RE.test(raw)) {
    throw new Error(`Invalid PAPERCLIP_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolvePaperclipInstanceRoot(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipHomeDir(input.homeDir), "instances", resolvePaperclipInstanceId(input.instanceId));
}

export function resolvePaperclipCompanyRoot(
  companyId: string,
  input: {
    homeDir?: string;
    instanceId?: string;
  } = {},
): string {
  const trimmed = companyId.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid company id '${companyId}'.`);
  }
  return path.resolve(resolvePaperclipInstanceRoot(input), "companies", trimmed);
}

export function resolvePaperclipCompanyConfigPath(
  companyId: string,
  input: {
    homeDir?: string;
    instanceId?: string;
  } = {},
): string {
  return path.resolve(resolvePaperclipCompanyRoot(companyId, input), PAPERCLIP_CONFIG_BASENAME);
}

function resolvePaperclipX10VolumeRoot(): string {
  const raw = process.env.PAPERCLIP_X10_VOLUME_ROOT?.trim();
  return path.resolve(raw ? expandHomePrefix(raw) : "/Volumes/X10 Pro");
}

function assertConfiguredWorkProductsRootIsAvailable(configuredRoot: string) {
  const x10VolumeRoot = resolvePaperclipX10VolumeRoot();
  const relativeToX10 = path.relative(x10VolumeRoot, configuredRoot);
  if (relativeToX10 === ".." || relativeToX10.startsWith(`..${path.sep}`)) return;

  const sentinelPath = path.join(x10VolumeRoot, PAPERCLIP_X10_SENTINEL_BASENAME);
  if (fs.existsSync(sentinelPath)) return;
  throw new Error(
    `Configured work-products root '${configuredRoot}' requires the real X10 volume, ` +
    `but sentinel '${sentinelPath}' is missing.`,
  );
}

export function readPaperclipCompanyConfig(
  companyId: string,
  input: {
    homeDir?: string;
    instanceId?: string;
  } = {},
): PaperclipCompanyConfig {
  const configPath = resolvePaperclipCompanyConfigPath(companyId, input);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { workProductsRoot: null };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { workProductsRoot: null };
  }

  const workProductsRootRaw =
    typeof (parsed as { workProductsRoot?: unknown }).workProductsRoot === "string"
      ? (parsed as { workProductsRoot: string }).workProductsRoot.trim()
      : "";

  return {
    workProductsRoot: workProductsRootRaw ? path.resolve(expandHomePrefix(workProductsRootRaw)) : null,
  };
}

export function resolvePaperclipCompanyWorkProductsDir(
  companyId: string,
  input: {
    homeDir?: string;
    instanceId?: string;
  } = {},
): string {
  const configuredRoot = readPaperclipCompanyConfig(companyId, input).workProductsRoot;
  if (configuredRoot) {
    assertConfiguredWorkProductsRootIsAvailable(configuredRoot);
    return configuredRoot;
  }
  return path.resolve(resolvePaperclipCompanyRoot(companyId, input), "work-products");
}

export function resolvePaperclipInstanceConfigPath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipInstanceRoot(input), PAPERCLIP_CONFIG_BASENAME);
}

export function resolvePaperclipConfigPathForInstance(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return resolvePaperclipInstanceConfigPath(input);
}

export function resolvePaperclipEnvPathForConfig(configPath: string): string {
  return path.resolve(path.dirname(configPath), PAPERCLIP_ENV_FILENAME);
}

export function resolveDefaultEmbeddedPostgresDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipInstanceRoot(input), "db");
}

export function resolveDefaultLogsDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipInstanceRoot(input), "logs");
}

export function resolveDefaultSecretsKeyFilePath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipInstanceRoot(input), "secrets", "master.key");
}

export function resolveDefaultStorageDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipInstanceRoot(input), "data", "storage");
}

export function resolveDefaultBackupDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipInstanceRoot(input), "data", "backups");
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
