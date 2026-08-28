import pino from "pino";
import { pinoHttp } from "pino-http";
import { HTTP_LOG_REDACT_PATHS } from "./http-log-redaction.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import { redactSensitive } from "./redact-sensitive.js";
import { redactWorkspaceHandoffTicket } from "../auth/workspace-login-handoff.js";

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

const isProduction = process.env.NODE_ENV === "production";
export const logger = isProduction
  ? pino({ level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "info", redact: [...HTTP_LOG_REDACT_PATHS] })
  : pino({ level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "debug", redact: [...HTTP_LOG_REDACT_PATHS] }, pino.transport({
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
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
    // A workspace login handoff ticket is a bearer credential that rides in the
    // query string, so the request line has to be redacted before it is logged.
    return `${req.method} ${redactWorkspaceHandoffTicket(req.url ?? "")} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${redactWorkspaceHandoffTicket(req.url ?? "")} ${res.statusCode} — ${errMsg}`;
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
