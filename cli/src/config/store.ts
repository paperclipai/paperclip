import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  mergePaperclipConfig,
  paperclipConfigSchema,
  type PaperclipConfig,
} from "./schema.js";
import {
  resolveDefaultConfigPath,
  resolvePaperclipInstanceId,
} from "./home.js";

const DEFAULT_CONFIG_BASENAME = "config.json";

function findConfigFileFromAncestors(startDir: string): string | null {
  const absoluteStartDir = path.resolve(startDir);
  let currentDir = absoluteStartDir;

  while (true) {
    const candidate = path.resolve(currentDir, ".paperclip", DEFAULT_CONFIG_BASENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return null;
}

export function resolveConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.PAPERCLIP_CONFIG) return path.resolve(process.env.PAPERCLIP_CONFIG);
  return findConfigFileFromAncestors(process.cwd()) ?? resolveDefaultConfigPath(resolvePaperclipInstanceId());
}

function parseJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function migrateLegacyConfig(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const config = { ...(raw as Record<string, unknown>) };
  const databaseRaw = config.database;
  if (typeof databaseRaw !== "object" || databaseRaw === null || Array.isArray(databaseRaw)) {
    return config;
  }

  const database = { ...(databaseRaw as Record<string, unknown>) };
  if (database.mode === "pglite") {
    database.mode = "embedded-postgres";

    if (typeof database.embeddedPostgresDataDir !== "string" && typeof database.pgliteDataDir === "string") {
      database.embeddedPostgresDataDir = database.pgliteDataDir;
    }
    if (
      typeof database.embeddedPostgresPort !== "number" &&
      typeof database.pglitePort === "number" &&
      Number.isFinite(database.pglitePort)
    ) {
      database.embeddedPostgresPort = database.pglitePort;
    }
  }

  config.database = database;
  return config;
}

function formatValidationError(err: unknown): string {
  const issues = (err as { issues?: Array<{ path?: unknown; message?: unknown }> })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .map((issue) => {
        const pathParts = Array.isArray(issue.path) ? issue.path.map(String) : [];
        const issuePath = pathParts.length > 0 ? pathParts.join(".") : "config";
        const message = typeof issue.message === "string" ? issue.message : "Invalid value";
        return `${issuePath}: ${message}`;
      })
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

export function readConfig(configPath?: string): PaperclipConfig | null {
  const filePath = resolveConfigPath(configPath);
  if (!fs.existsSync(filePath)) return null;
  const raw = parseJson(filePath);
  const migrated = migrateLegacyConfig(raw);
  const parsed = paperclipConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${filePath}: ${formatValidationError(parsed.error)}`);
  }
  return parsed.data;
}

function effectiveConfig(config: PaperclipConfig): Record<string, unknown> {
  const meta = { ...config.$meta } as Record<string, unknown>;
  delete meta.updatedAt;
  delete meta.source;
  return {
    ...config,
    $meta: meta,
  };
}

function syncDirectory(directoryPath: string): void {
  let directoryDescriptor: number | null = null;
  try {
    directoryDescriptor = fs.openSync(directoryPath, "r");
    fs.fsyncSync(directoryDescriptor);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(String(code))) {
      throw error;
    }
  } finally {
    if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
  }
}

function durableCopyFile(sourcePath: string, destinationPath: string, flags = 0): void {
  fs.copyFileSync(sourcePath, destinationPath, flags);
  fs.chmodSync(destinationPath, 0o600);

  const backupDescriptor = fs.openSync(destinationPath, "r");
  try {
    fs.fsyncSync(backupDescriptor);
  } finally {
    fs.closeSync(backupDescriptor);
  }
  syncDirectory(path.dirname(destinationPath));
}

function atomicWriteFile(filePath: string, contents: string): void {
  let attempt = 0;

  while (true) {
    const temporaryPath = `${filePath}.tmp-${process.pid}-${attempt}`;
    attempt += 1;
    let fileDescriptor: number | null = null;
    try {
      fileDescriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(fileDescriptor, contents, "utf8");
      fs.fsyncSync(fileDescriptor);
      fs.closeSync(fileDescriptor);
      fileDescriptor = null;
      fs.renameSync(temporaryPath, filePath);
      syncDirectory(path.dirname(filePath));
      return;
    } catch (error) {
      if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
      fs.rmSync(temporaryPath, { force: true });
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (code === "EEXIST") continue;
      throw error;
    }
  }
}

export function backupInvalidConfig(configPath?: string): string {
  const filePath = resolveConfigPath(configPath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Cannot back up missing config at ${filePath}`);
  }

  for (let suffix = 1; ; suffix += 1) {
    const backupPath = `${filePath}.invalid-${suffix}`;
    try {
      durableCopyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL);
      return backupPath;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (code === "EEXIST") continue;
      throw error;
    }
  }
}

export function writeConfig(
  config: PaperclipConfig,
  configPath?: string,
  options: { invalidBackupPath?: string } = {},
): boolean {
  const filePath = resolveConfigPath(configPath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let nextConfig = paperclipConfigSchema.parse(config);
  if (fs.existsSync(filePath)) {
    try {
      const source = paperclipConfigSchema.parse(migrateLegacyConfig(parseJson(filePath)));
      nextConfig = paperclipConfigSchema.parse(mergePaperclipConfig(source, nextConfig));
      if (isDeepStrictEqual(effectiveConfig(source), effectiveConfig(nextConfig))) {
        return false;
      }
    } catch (error) {
      const invalidBackupPath = options.invalidBackupPath;
      if (!invalidBackupPath) {
        throw new Error(
          `Refusing to overwrite invalid config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        !fs.existsSync(invalidBackupPath) ||
        !fs.readFileSync(filePath).equals(fs.readFileSync(invalidBackupPath))
      ) {
        throw new Error(
          `Refusing to overwrite ${filePath} because it changed after the invalid backup was created`,
        );
      }
    }
  }

  // Backup existing config before overwriting
  if (fs.existsSync(filePath)) {
    const backupPath = filePath + ".backup";
    durableCopyFile(filePath, backupPath);
  }

  atomicWriteFile(filePath, JSON.stringify(nextConfig, null, 2) + "\n");
  return true;
}

export function configExists(configPath?: string): boolean {
  return fs.existsSync(resolveConfigPath(configPath));
}
