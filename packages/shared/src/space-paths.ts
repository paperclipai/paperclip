import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";
export const DEFAULT_PAPERCLIP_SPACE_ID = "default";
export const PAPERCLIP_CONFIG_BASENAME = "config.json";
export const PAPERCLIP_ENV_FILENAME = ".env";
export const DEFAULT_SPACE_OWNED_PATH_NAMES = [
  PAPERCLIP_CONFIG_BASENAME,
  PAPERCLIP_ENV_FILENAME,
  "db",
  "data",
  "logs",
  "secrets",
  "workspaces",
  "projects",
  "companies",
] as const;
export const DEFAULT_SPACE_ADAPTER_LOCAL_PATH_NAMES = ["codex-home"] as const;

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export interface PaperclipSpaceRegistry {
  $meta: {
    version: 1;
    updatedAt: string;
    source: "onboard" | "configure" | "doctor" | "system";
  };
  activeSpaceId: string;
  spaces: Array<{
    id: string;
    root: string;
    createdAt: string;
  }>;
  defaultSpaceMigration?: {
    migratedAt: string;
    sourceRoot: string;
    destinationRoot: string;
    movedPaths: string[];
  };
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

export function resolvePaperclipInstanceConfigPath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipInstanceRoot(input), PAPERCLIP_CONFIG_BASENAME);
}

function readJsonIfPresent(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPaperclipRuntimeConfig(value: unknown): boolean {
  return isObject(value) && isObject(value.database) && isObject(value.server);
}

function readActiveSpaceIdFromRegistry(instanceConfigPath: string): string | null {
  const parsed = readJsonIfPresent(instanceConfigPath);
  if (!isObject(parsed) || isPaperclipRuntimeConfig(parsed)) return null;
  const activeSpaceId = parsed.activeSpaceId;
  return typeof activeSpaceId === "string" && PATH_SEGMENT_RE.test(activeSpaceId)
    ? activeSpaceId
    : null;
}

export function hasLegacyDefaultSpaceInstall(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): boolean {
  return isPaperclipRuntimeConfig(readJsonIfPresent(resolvePaperclipInstanceConfigPath(input)));
}

export function resolvePaperclipSpaceId(input: {
  homeDir?: string;
  instanceId?: string;
  spaceId?: string;
} = {}): string {
  const raw =
    input.spaceId?.trim() ||
    process.env.PAPERCLIP_SPACE_ID?.trim() ||
    readActiveSpaceIdFromRegistry(resolvePaperclipInstanceConfigPath(input)) ||
    DEFAULT_PAPERCLIP_SPACE_ID;
  if (!PATH_SEGMENT_RE.test(raw)) {
    throw new Error(`Invalid PAPERCLIP_SPACE_ID '${raw}'.`);
  }
  return raw;
}

export function resolvePaperclipSpacesRoot(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipInstanceRoot(input), "spaces");
}

export function resolvePaperclipSpaceRoot(input: {
  homeDir?: string;
  instanceId?: string;
  spaceId?: string;
} = {}): string {
  const spaceId = resolvePaperclipSpaceId(input);
  if (spaceId === DEFAULT_PAPERCLIP_SPACE_ID && hasLegacyDefaultSpaceInstall(input)) {
    return resolvePaperclipInstanceRoot(input);
  }
  return path.resolve(resolvePaperclipSpacesRoot(input), spaceId);
}

export function resolvePaperclipSpaceConfigPath(input: {
  homeDir?: string;
  instanceId?: string;
  spaceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipSpaceRoot(input), PAPERCLIP_CONFIG_BASENAME);
}

export function resolvePaperclipConfigPathForInstance(input: {
  homeDir?: string;
  instanceId?: string;
  spaceId?: string;
} = {}): string {
  const spaceConfigPath = resolvePaperclipSpaceConfigPath(input);
  if (fs.existsSync(spaceConfigPath)) return spaceConfigPath;

  const instanceConfigPath = resolvePaperclipInstanceConfigPath(input);
  if (isPaperclipRuntimeConfig(readJsonIfPresent(instanceConfigPath))) return instanceConfigPath;

  return spaceConfigPath;
}

export function resolvePaperclipEnvPathForConfig(configPath: string): string {
  return path.resolve(path.dirname(configPath), PAPERCLIP_ENV_FILENAME);
}

export function resolveDefaultEmbeddedPostgresDir(input: {
  homeDir?: string;
  instanceId?: string;
  spaceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipSpaceRoot(input), "db");
}

export function resolveDefaultLogsDir(input: {
  homeDir?: string;
  instanceId?: string;
  spaceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipSpaceRoot(input), "logs");
}

export function resolveDefaultSecretsKeyFilePath(input: {
  homeDir?: string;
  instanceId?: string;
  spaceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipSpaceRoot(input), "secrets", "master.key");
}

export function resolveDefaultStorageDir(input: {
  homeDir?: string;
  instanceId?: string;
  spaceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipSpaceRoot(input), "data", "storage");
}

export function resolveDefaultBackupDir(input: {
  homeDir?: string;
  instanceId?: string;
  spaceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipSpaceRoot(input), "data", "backups");
}

export function createDefaultSpaceRegistry(source: PaperclipSpaceRegistry["$meta"]["source"]): PaperclipSpaceRegistry {
  const now = new Date().toISOString();
  return {
    $meta: {
      version: 1,
      updatedAt: now,
      source,
    },
    activeSpaceId: DEFAULT_PAPERCLIP_SPACE_ID,
    spaces: [
      {
        id: DEFAULT_PAPERCLIP_SPACE_ID,
        root: path.join("spaces", DEFAULT_PAPERCLIP_SPACE_ID),
        createdAt: now,
      },
    ],
  };
}

export function ensureDefaultSpaceRegistry(input: {
  source: PaperclipSpaceRegistry["$meta"]["source"];
  homeDir?: string;
  instanceId?: string;
}): string {
  const registryPath = resolvePaperclipInstanceConfigPath(input);
  if (fs.existsSync(registryPath)) return registryPath;
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, `${JSON.stringify(createDefaultSpaceRegistry(input.source), null, 2)}\n`, {
    mode: 0o600,
  });
  return registryPath;
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
