import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog, shouldDownlevel404ToDebug } from "./http-log-policy.js";

// Short-window deduplication for repeated identical 404 warn lines.
// Key: "METHOD:routePath:statusCode". Suppresses re-emission within the TTL window.
const WARN_DEDUPE_TTL_MS = 30_000;
const warnDedupeMap = new Map<string, number>();

function dedupeWarnKey(req: { method?: string; route?: { path?: string }; url?: string }, statusCode: number): string {
  const route = (req.route as { path?: string } | undefined)?.path ?? req.url?.split("?")[0] ?? "unknown";
  return `${req.method ?? ""}:${route}:${statusCode}`;
}

function shouldSuppressRepeatedWarn(req: { method?: string; route?: { path?: string }; url?: string }, statusCode: number): boolean {
  const key = dedupeWarnKey(req, statusCode);
  const now = Date.now();
  const last = warnDedupeMap.get(key);
  if (last !== undefined && now - last < WARN_DEDUPE_TTL_MS) return true;
  warnDedupeMap.set(key, now);
  // Evict oldest entry when map grows large to prevent unbounded memory use.
  if (warnDedupeMap.size > 500) {
    warnDedupeMap.delete(warnDedupeMap.keys().next().value as string);
  }
  return false;
}

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
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino({
  level: "debug",
  redact: ["req.headers.authorization"],
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

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) {
      if (shouldDownlevel404ToDebug(_req.method, _req.url, res.statusCode)) return "debug";
      if (shouldSuppressRepeatedWarn(_req, res.statusCode)) return "silent";
      return "warn";
    }
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
