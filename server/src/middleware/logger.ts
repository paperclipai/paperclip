import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";

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

// Field-level redaction. Applied by pino at serialization time so any structured
// log entry that surfaces these keys (req body, custom props, error contexts)
// gets scrubbed regardless of which middleware attached them.
//
// `*` is a single-segment wildcard in pino redact paths, so for nested objects
// we have to enumerate the parent keys we actually emit (`reqBody`,
// `errorContext`, `req.body`).
const SENSITIVE_KEYS = [
  "password",
  "newPassword",
  "currentPassword",
  "passwordConfirmation",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "secret",
  "clientSecret",
  "privateKey",
];

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  ...SENSITIVE_KEYS.flatMap((key) => [
    `req.body.${key}`,
    `reqBody.${key}`,
    `errorContext.${key}`,
    `*.${key}`,
  ]),
];

const REDACTED = "[REDACTED]";

// Defensive sanitizer applied before we hand a body to pino. Pino's redact paths
// already cover the structured log path, but we shallow-clone here too so we
// never mutate the live `req.body` and so deeply-nested or untyped shapes still
// get scrubbed.
function sanitizeForLog<T>(value: T, depth = 0): T {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, depth + 1)) as unknown as T;
  }
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.includes(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = sanitizeForLog(val, depth + 1);
  }
  return out as unknown as T;
}

// Auth endpoints accept credentials in the body. Even with field-level redaction
// we don't want to log the body shape at all - log only the route + status.
function isAuthPath(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("/api/auth/") || url.startsWith("/auth/");
}

export const logger = pino({
  level: "debug",
  redact: {
    paths: REDACT_PATHS,
    censor: REDACTED,
  },
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
      const onAuthPath = isAuthPath((req as any).url);
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: sanitizeForLog(ctx.error),
          reqBody: onAuthPath ? undefined : sanitizeForLog(ctx.reqBody),
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (
        !onAuthPath &&
        body &&
        typeof body === "object" &&
        Object.keys(body).length > 0
      ) {
        props.reqBody = sanitizeForLog(body);
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
