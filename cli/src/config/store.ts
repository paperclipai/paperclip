import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  mergePaperclipConfig,
  paperclipConfigSchema,
  migrateLegacyConfig,
  validatePaperclipConfig,
  type PaperclipConfig,
  type ConfigValidationResult,
  type ConfigValidationIssue,
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

export function validateConfigFile(configPath?: string): ConfigValidationResult & {
  filePath: string;
  exists: boolean;
} {
  const filePath = resolveConfigPath(configPath);
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      valid: false,
      errors: [`Config file not found at ${filePath}`],
      issues: [{ path: "config", message: `Config file not found at ${filePath}` }],
      warnings: [],
    };
  }

  let raw: unknown;
  try {
    raw = parseJson(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      filePath,
      exists: true,
      valid: false,
      errors: [message],
      issues: [{ path: "config", message }],
      warnings: [],
    };
  }

  const result = validatePaperclipConfig(raw, { migrateLegacy: true });
  return {
    filePath,
    exists: true,
    ...result,
  };
}

export function readConfig(configPath?: string): PaperclipConfig | null {
  const filePath = resolveConfigPath(configPath);
  if (!fs.existsSync(filePath)) return null;
  const raw = parseJson(filePath);
  const result = validatePaperclipConfig(raw, { migrateLegacy: true });
  if (!result.valid) {
    throw new Error(`Invalid config at ${filePath}: ${result.errors.join("; ")}`);
  }
  return result.data!;
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

  let backupDescriptor: number | null = null;
  try {
    backupDescriptor = fs.openSync(destinationPath, "r");
    fs.fsyncSync(backupDescriptor);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(String(code))) {
      throw error;
    }
  } finally {
    if (backupDescriptor !== null) fs.closeSync(backupDescriptor);
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
