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

// Anything that authenticates a request (gate JWT in the cookie,
// per-workspace gate secret, team-sync HMAC, raw Authorization) gets
// replaced with `[Redacted]` before pino writes to disk. The same paths
// are also stripped from the response set-cookie so a fresh issued
// session token doesn't end up on disk either.
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["set-cookie"]',
  'req.headers["x-jade-gate-secret"]',
  'req.headers["x-jade-team-sync-signature"]',
  'req.headers["x-paperclip-cloud-tenant-token"]',
  "res.headers.authorization",
  'res.headers["set-cookie"]',
  // Same fields show up under `reqBody` when error context dumps the
  // body to logs. Customizer below assigns this; we still belt-and-
  // suspenders these paths so an accidental new dump site is covered.
  "reqBody.password",
  "reqBody.newPassword",
  "reqBody.token",
  "reqBody.apiKey",
  "errorContext.password",
];

const SENSITIVE_BODY_KEYS = new Set([
  "password",
  "newPassword",
  "currentPassword",
  "token",
  "apiKey",
  "api_key",
  "secret",
]);

function scrubBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map(scrubBody);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (SENSITIVE_BODY_KEYS.has(k.toLowerCase())) {
      out[k] = "[Redacted]";
    } else if (v && typeof v === "object") {
      out[k] = scrubBody(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const logger = pino({
  level: "debug",
  redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
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
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: scrubBody(ctx.reqBody),
          reqParams: ctx.reqParams,
          reqQuery: scrubBody(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = scrubBody(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = scrubBody(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
