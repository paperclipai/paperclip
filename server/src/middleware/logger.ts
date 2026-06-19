import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import { redactSensitive } from "./redact-sensitive.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

// Render format for both log streams. Precedence: env > config file > default.
// "json" emits one JSON object per line (machine-parseable for log shippers
// like Grafana Loki / ELK); "pretty" keeps the human-readable pino-pretty
// output (default, back-compatible).
function resolveLogFormat(): "pretty" | "json" {
  const envOverride = process.env.PAPERCLIP_LOG_FORMAT?.trim().toLowerCase();
  if (envOverride === "pretty" || envOverride === "json") return envOverride;

  const fileFormat = readConfigFile()?.logging.format;
  if (fileFormat === "pretty" || fileFormat === "json") return fileFormat;

  return "pretty";
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const logFormat = resolveLogFormat();

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

// "json": raw pino JSON via the built-in pino/file transport (stdout = fd 1,
// plus the rotated-by-nothing server.log). "pretty": pino-pretty as before.
const transportTargets: pino.TransportTargetOptions[] = logFormat === "json"
  ? [
      {
        target: "pino/file",
        options: { destination: 1 },
        level: "info",
      },
      {
        target: "pino/file",
        options: { destination: logFile, mkdir: true },
        level: "debug",
      },
    ]
  : [
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
    ];

export const logger = pino({
  level: "debug",
  redact: ["req.headers.authorization"],
}, pino.transport({ targets: transportTargets }));

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
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
          reqBody: redactSensitive(ctx.reqBody),
          reqParams: redactSensitive(ctx.reqParams),
          reqQuery: redactSensitive(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = redactSensitive(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = redactSensitive(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = redactSensitive(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
