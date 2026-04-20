import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { TransportTargetOptions } from "pino";
import {
  defaultLoggingRotationConfig,
  type LoggingRotationConfig,
} from "@paperclipai/shared";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { sanitizeRecord } from "../redaction.js";

type ResolvedServerLoggingConfig = {
  mode: "file" | "cloud";
  logDir: string;
  rotation: LoggingRotationConfig;
};

function resolveServerLoggingConfig(): ResolvedServerLoggingConfig {
  const configLogging = readConfigFile()?.logging;
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  const logDir = envOverride
    ? resolveHomeAwarePath(envOverride)
    : (configLogging?.logDir?.trim() ? resolveHomeAwarePath(configLogging.logDir) : resolveDefaultLogsDir());

  return {
    mode: configLogging?.mode ?? "file",
    logDir,
    rotation: {
      ...defaultLoggingRotationConfig,
      ...(configLogging?.rotation ?? {}),
    },
  };
}

const loggingConfig = resolveServerLoggingConfig();
const logDir = loggingConfig.logDir;
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");
const rotatingPrettyTarget = fileURLToPath(new URL("../logging/rotating-pretty-target.js", import.meta.url));
const canUseRotatingPrettyTarget =
  process.env.PAPERCLIP_FORCE_ROTATING_PRETTY_TARGET === "1"
  || fs.existsSync(rotatingPrettyTarget);

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

const targets: TransportTargetOptions[] = [
  {
    target: "pino-pretty",
    options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
    level: "info",
  },
];

if (loggingConfig.mode === "file") {
  targets.push({
    target: canUseRotatingPrettyTarget ? rotatingPrettyTarget : "pino-pretty",
    options: canUseRotatingPrettyTarget
      ? {
        ...sharedOpts,
        colorize: false,
        logFile,
        rotation: loggingConfig.rotation,
      }
      : {
        ...sharedOpts,
        colorize: false,
        destination: logFile,
        mkdir: true,
      },
    level: "debug",
  } as TransportTargetOptions);
} else {
  targets.push({
    target: "pino-pretty",
    options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
    level: "debug",
  } as TransportTargetOptions);
}

export const logger = pino({
  level: "debug",
  redact: [
    "req.headers.authorization",
    "reqBody.password",
    "reqBody.currentPassword",
    "reqBody.newPassword",
    "reqBody.token",
    "reqBody.secret",
  ],
}, pino.transport({
  targets: [
    ...targets,
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
          errorContext: ctx.error,
          reqBody: ctx.reqBody && typeof ctx.reqBody === "object" ? sanitizeRecord(ctx.reqBody) : ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = sanitizeRecord(body);
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
