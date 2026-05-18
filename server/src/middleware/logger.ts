import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { detectInsecureLogDir } from "@paperclipai/shared";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";

export function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

// LET-436: refuse to start the server when the resolved log dir points at a
// vitest scratch path. A production deployment that ends up writing to
// `/tmp/paperclip-vitest-*` loses logs whenever vitest cleans the tempdir,
// which then surfaces in Paperclip as a flood of `adapter_failed` /
// `process_lost` terminals from the heartbeat reaper. Fail loudly at startup
// instead so the misconfiguration is visible to the operator.
export function assertServerLogDirIsSafe(
  resolvedLogDir: string,
  options?: { nodeEnv?: string | undefined },
): void {
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV;
  const mode = nodeEnv === "test" ? "test" : "production";
  const verdict = detectInsecureLogDir(resolvedLogDir, { mode });
  if (verdict.ok) return;
  const message =
    "[paperclip][LET-436] Refusing to start: " +
    (verdict.reason ?? `insecure logging.logDir: ${resolvedLogDir}`);
  if (verdict.severity === "error") {
    throw new Error(message);
  }
  // eslint-disable-next-line no-console
  console.warn(message);
}

const logDir = resolveServerLogDir();
assertServerLogDirIsSafe(logDir);
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
