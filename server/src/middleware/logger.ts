import path from "node:path";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";

/** pino-http callback request type — IncomingMessage extended with Express body/params/query/route. */
type PinoReq = IncomingMessage & {
  route?: { path: string };
  body?: unknown;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
};

/** pino-http callback response type — ServerResponse extended with Paperclip error context fields. */
type PinoRes = ServerResponse & {
  __errorContext?: {
    error?: { message?: string };
    reqBody?: unknown;
    reqParams?: unknown;
    reqQuery?: unknown;
  };
  err?: Error;
};

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

function buildTransportTargets() {
  const targets: pino.TransportTargetOptions[] = [
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

  const lokiUrl = process.env.PAPERCLIP_LOKI_URL?.trim();
  if (lokiUrl) {
    const agentId = process.env.PAPERCLIP_AGENT_ID?.trim();
    targets.push({
      target: "pino-loki",
      options: {
        host: lokiUrl,
        labels: {
          job: "paperclip",
          service: "paperclip-server",
          ...(agentId ? { agentId } : {}),
        },
        propsToLabels: ["runId"],
        replaceTimestamp: true,
        silenceErrors: true,
      },
      level: "info",
    });
  }

  return targets;
}

export const logger = pino({
  level: "debug",
}, pino.transport({
  targets: buildTransportTargets(),
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
  customErrorMessage(rawReq, rawRes, err) {
    const res = rawRes as PinoRes;
    const ctx = res.__errorContext;
    const errMsg = ctx?.error?.message || err?.message || res.err?.message || "unknown error";
    return `${rawReq.method} ${rawReq.url} ${rawRes.statusCode} — ${errMsg}`;
  },
  customProps(rawReq, rawRes) {
    if (rawRes.statusCode >= 400) {
      const res = rawRes as PinoRes;
      const ctx = res.__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const req = rawReq as PinoReq;
      const props: Record<string, unknown> = {};
      const { body, params, query } = req;
      if (body && typeof body === "object" && Object.keys(body as object).length > 0) {
        props.reqBody = body;
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = query;
      }
      if (req.route?.path) {
        props.routePath = req.route.path;
      }
      return props;
    }
    return {};
  },
});
