import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";
export const PAPERCLIP_CONFIG_BASENAME = "config.json";
export const PAPERCLIP_ENV_FILENAME = ".env";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

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

export const HEALTH_PROBE_TOKEN_HEADER = "x-paperclip-health-token";

export function resolveDefaultHealthTokenPath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolvePaperclipInstanceRoot(input), ".health-token");
}

function readExistingToken(tokenPath: string): string | null {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, "utf8").trim();
        if (token.length > 0) return token;
      }
    } catch {
      // transient read error; retry
    }
  }
  return null;
}

export function resolveInstanceHealthToken(options: {
  instanceId?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string | null {
  const env = options.env ?? process.env;
  const fromEnv = env.PAPERCLIP_HEALTH_TOKEN?.trim();

  try {
    const tokenPath = resolveDefaultHealthTokenPath(options);
    // For file-backed managed instances, the persisted token on disk is the
    // canonical source of truth. Preferring an existing token on disk prevents
    // a caller-local environment variable from diverging from the running service.
    const existingToken = readExistingToken(tokenPath);
    if (existingToken) return existingToken;

    const instanceRoot = resolvePaperclipInstanceRoot(options);
    fs.mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });

    const newToken = fromEnv || crypto.randomBytes(32).toString("hex");
    const tempPath = path.join(
      instanceRoot,
      `.health-token.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
    );

    fs.writeFileSync(tempPath, `${newToken}\n`, { mode: 0o600 });

    try {
      // Atomic hard link: fails with EEXIST if tokenPath already exists,
      // guaranteeing that an existing token is NEVER replaced.
      fs.linkSync(tempPath, tokenPath);
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup error
      }
      return newToken;
    } catch (linkError) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup error
      }

      const code = (linkError as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") {
        return readExistingToken(tokenPath);
      }

      // Fallback for filesystems that do not support hard links:
      // wx flag guarantees exclusive file creation (O_CREAT | O_EXCL)
      try {
        fs.writeFileSync(tokenPath, `${newToken}\n`, { mode: 0o600, flag: "wx" });
        return newToken;
      } catch {
        return readExistingToken(tokenPath);
      }
    }
  } catch {
    return null;
  }
}

