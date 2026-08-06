import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino({
  level: "debug",
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

/**
 * Rate-limited error logger for recurring background tasks.
 *
 * Prevents log flooding when a recurring operation (e.g., heartbeat timer tick)
 * fails repeatedly due to an external dependency being unavailable.
 *
 * Behaviour:
 * - Logs the first error immediately (with full details).
 * - Subsequent errors with the same key are suppressed until
 *   `cooldownMs` has elapsed since the last log.
 * - When a previously-failing operation succeeds, the counter resets.
 * - Returns `true` when the error was actually logged.
 */
function createRateLimitedErrorLogger() {
  const lastLoggedBy = new Map<string, number>();
  const failureCountBy = new Map<string, number>();
  const cooldownMs = 5 * 60 * 1000; // 5 minutes

  const rle = {
    error(err: unknown, msg: string) {
      const now = Date.now();
      const lastLogged = lastLoggedBy.get(msg) ?? 0;
      const shouldLog = (now - lastLogged) >= cooldownMs;

      if (shouldLog) {
        lastLoggedBy.set(msg, now);
        failureCountBy.set(msg, 0);
        logger.error({ err }, msg);
        return true;
      }
      return false;
    },

    success(msg: string) {
      const count = failureCountBy.get(msg) ?? 0;
      if (count > 0) {
        logger.info({ suppressedErrors: count }, `${msg}: recovered`);
        failureCountBy.set(msg, 0);
      }
    },

    recordFailure(msg: string) {
      failureCountBy.set(msg, (failureCountBy.get(msg) ?? 0) + 1);
    },

    reset() {
      lastLoggedBy.clear();
      failureCountBy.clear();
    },
  };

  return rle;
}

export const rateLimitedError = createRateLimitedErrorLogger();

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
          errorContext: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = body;
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = query;
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
