import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { sanitizeLogValue } from "../redaction.js";

const LOG_LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

type LogLevel = keyof typeof LOG_LEVEL_ORDER;

function parseLogLevel(value: string | null | undefined): LogLevel | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return normalized in LOG_LEVEL_ORDER ? (normalized as LogLevel) : null;
}

function resolveMinLogLevel(levels: LogLevel[]): LogLevel {
  return levels.reduce((current, candidate) =>
    LOG_LEVEL_ORDER[candidate] < LOG_LEVEL_ORDER[current] ? candidate : current,
  );
}

function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

function resolveConsoleLogLevel(): LogLevel {
  return (
    parseLogLevel(process.env.PAPERCLIP_LOG_CONSOLE_LEVEL) ??
    parseLogLevel(process.env.PAPERCLIP_LOG_LEVEL) ??
    parseLogLevel(readConfigFile()?.logging.consoleLevel) ??
    (process.env.NODE_ENV === "production" ? "info" : "debug")
  );
}

function resolveFileLogLevel(): LogLevel {
  return (
    parseLogLevel(process.env.PAPERCLIP_LOG_FILE_LEVEL) ??
    parseLogLevel(process.env.PAPERCLIP_LOG_LEVEL) ??
    parseLogLevel(readConfigFile()?.logging.fileLevel) ??
    "debug"
  );
}

function resolveMaxFileSizeBytes(): number {
  const maxFileSizeMb =
    parsePositiveInt(process.env.PAPERCLIP_LOG_MAX_FILE_SIZE_MB) ??
    readConfigFile()?.logging.maxFileSizeMb ??
    25;
  return maxFileSizeMb * 1024 * 1024;
}

function resolveMaxLogFiles(): number {
  return parsePositiveInt(process.env.PAPERCLIP_LOG_MAX_FILES) ?? readConfigFile()?.logging.maxFiles ?? 10;
}

function buildLogDateStamp(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isManagedLogFile(name: string): boolean {
  return /^server-\d{4}-\d{2}-\d{2}(?:-\d+)?\.log$/u.test(name);
}

function selectManagedLogFile(logDir: string, maxFileSizeBytes: number, now = new Date()): string {
  const dateStamp = buildLogDateStamp(now);
  const primaryName = `server-${dateStamp}.log`;
  const primaryPath = path.join(logDir, primaryName);

  try {
    const primaryStat = fs.statSync(primaryPath);
    if (primaryStat.size < maxFileSizeBytes) {
      return primaryPath;
    }
  } catch {
    return primaryPath;
  }

  let index = 1;
  while (true) {
    const candidatePath = path.join(logDir, `server-${dateStamp}-${index}.log`);
    try {
      const candidateStat = fs.statSync(candidatePath);
      if (candidateStat.size < maxFileSizeBytes) {
        return candidatePath;
      }
      index += 1;
    } catch {
      return candidatePath;
    }
  }
}

export function pruneManagedLogFiles(logDir: string, maxFiles: number, fileSystem: typeof fs = fs) {
  const managedFiles = fileSystem
    .readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isManagedLogFile(entry.name))
    .map((entry) => {
      const filePath = path.join(logDir, entry.name);
      const stat = fileSystem.statSync(filePath);
      return {
        filePath,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const stale of managedFiles.slice(maxFiles)) {
    fileSystem.unlinkSync(stale.filePath);
  }
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });
const consoleLevel = resolveConsoleLogLevel();
const fileLevel = resolveFileLogLevel();
const rootLevel = resolveMinLogLevel([consoleLevel, fileLevel]);
const maxFileSizeBytes = resolveMaxFileSizeBytes();
const maxFiles = resolveMaxLogFiles();
const logFile = selectManagedLogFile(logDir, maxFileSizeBytes);
pruneManagedLogFiles(logDir, maxFiles);

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedRequestValue(value: unknown) {
  const sanitized = sanitizeLogValue(value);
  if (sanitized === null || sanitized === undefined) return undefined;
  if (isPlainObject(sanitized) && Object.keys(sanitized).length === 0) return undefined;
  return sanitized;
}

export const logger = pino({
  level: rootLevel,
  redact: ["req.headers.authorization"],
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: consoleLevel,
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: fileLevel,
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: sanitizeLogValue(ctx.error),
          reqBody: sanitizedRequestValue(ctx.reqBody),
          reqParams: sanitizedRequestValue(ctx.reqParams),
          reqQuery: sanitizedRequestValue(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      const sanitizedBody = sanitizedRequestValue(body);
      if (sanitizedBody !== undefined) {
        props.reqBody = sanitizedBody;
      }
      const sanitizedParams = sanitizedRequestValue(params);
      if (sanitizedParams !== undefined) {
        props.reqParams = sanitizedParams;
      }
      const sanitizedQuery = sanitizedRequestValue(query);
      if (sanitizedQuery !== undefined) {
        props.reqQuery = sanitizedQuery;
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
