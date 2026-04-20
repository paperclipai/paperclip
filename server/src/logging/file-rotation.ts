import fs from "node:fs";
import path from "node:path";
import {
  defaultLoggingRotationConfig,
  type LoggingRotationConfig,
} from "@paperclipai/shared";

export type LogRotationWarningSink = (message: string, error?: unknown) => void;

type RotationContext = {
  logFile: string;
  rotation: LoggingRotationConfig;
  now?: () => Date;
  warn?: LogRotationWarningSink;
};

function defaultWarn(message: string, error?: unknown): void {
  if (error instanceof Error) {
    console.warn(`[logger] ${message}: ${error.message}`);
    return;
  }
  if (error !== undefined) {
    console.warn(`[logger] ${message}:`, error);
    return;
  }
  console.warn(`[logger] ${message}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureDirectory(logFile: string): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
}

function ensureLogFileExists(logFile: string): void {
  const fd = fs.openSync(logFile, "a");
  fs.closeSync(fd);
}

function getFileSize(logFile: string): number {
  try {
    return fs.statSync(logFile).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function formatRotationTimestamp(now: Date): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function getRotationRegex(logFile: string): RegExp {
  return new RegExp(`^${escapeRegex(path.basename(logFile))}\\.\\d{8}-\\d{6}(?:-\\d+)?$`);
}

function resolveNextRotatedLogFile(logFile: string, now: Date): string {
  const candidateBase = `${logFile}.${formatRotationTimestamp(now)}`;
  let candidate = candidateBase;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${candidateBase}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function normalizeLoggingRotationConfig(
  rotation?: Partial<LoggingRotationConfig> | null,
): LoggingRotationConfig {
  return {
    ...defaultLoggingRotationConfig,
    ...(rotation ?? {}),
  };
}

export function getMaxLogFileSizeBytes(rotation: LoggingRotationConfig): number {
  return Math.max(1, Math.floor(rotation.maxFileSizeMb * 1024 * 1024));
}

export function getRotatedLogFiles(logFile: string): string[] {
  const logDir = path.dirname(logFile);
  const matcher = getRotationRegex(logFile);

  try {
    return fs.readdirSync(logDir)
      .filter((entry) => matcher.test(entry))
      .sort((left, right) => left.localeCompare(right))
      .map((entry) => path.join(logDir, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function pruneRotatedLogFiles(logFile: string, rotation: LoggingRotationConfig): void {
  const keepRotatedFiles = Math.max(0, rotation.maxFiles - 1);
  const rotatedFiles = getRotatedLogFiles(logFile);
  const filesToRemove = Math.max(0, rotatedFiles.length - keepRotatedFiles);

  for (const file of rotatedFiles.slice(0, filesToRemove)) {
    fs.rmSync(file, { force: true });
  }
}

export function rotateActiveLogFile(input: RotationContext): string | null {
  const rotation = normalizeLoggingRotationConfig(input.rotation);
  const activeFileSize = getFileSize(input.logFile);
  if (activeFileSize === 0) {
    ensureLogFileExists(input.logFile);
    return null;
  }

  ensureDirectory(input.logFile);
  const rotatedLogFile = resolveNextRotatedLogFile(input.logFile, (input.now ?? (() => new Date()))());
  fs.renameSync(input.logFile, rotatedLogFile);
  pruneRotatedLogFiles(input.logFile, rotation);
  ensureLogFileExists(input.logFile);
  return rotatedLogFile;
}

export function prepareLogFileForWrite(input: RotationContext): void {
  const rotation = normalizeLoggingRotationConfig(input.rotation);
  const warn = input.warn ?? defaultWarn;

  ensureDirectory(input.logFile);
  if (!rotation.enabled) {
    ensureLogFileExists(input.logFile);
    return;
  }

  try {
    const activeFileSize = getFileSize(input.logFile);
    if (activeFileSize >= getMaxLogFileSizeBytes(rotation)) {
      rotateActiveLogFile({
        ...input,
        rotation,
      });
    } else {
      pruneRotatedLogFiles(input.logFile, rotation);
      ensureLogFileExists(input.logFile);
    }
  } catch (error) {
    warn(`failed to rotate or prune ${input.logFile}`, error);
    ensureLogFileExists(input.logFile);
  }
}
