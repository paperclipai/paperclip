import pino from "pino";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LogFn, Logger, LoggerOptions } from "pino";
import { pinoHttp } from "pino-http";
import {
  HTTP_LOG_REDACT_PATHS,
  HEADER_REDACTION_MARKER,
  redactCredentialFields,
  redactSensitiveHeaders,
  sanitizeCredentialText,
  sanitizeErrorObject,
  UNREADABLE_ERROR,
} from "./http-log-redaction.js";
import {
  isPrivateWebhookHttpRequest,
  isSecretSensitiveHttpRequest,
  isPrivateAgentCommentaryHttpRequest,
  isPrivateAgentObservabilityHttpRequest,
  isPrivateMuseHttpRequest,
  isPrivateDotPrincipalHttpRequest,
  shouldSilenceHttpSuccessLog,
} from "./http-log-policy.js";
import {
  redactSensitive,
  stripSecretBearingUrlParts,
} from "./redact-sensitive.js";

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

function serializeLoggedError(err: unknown): unknown {
  try {
    return sanitizeErrorObject(pino.stdSerializers.err(err as Error));
  } catch {
    return UNREADABLE_ERROR;
  }
}

export const basePinoOptions = {
  redact: {
    paths: [...HTTP_LOG_REDACT_PATHS],
    censor: HEADER_REDACTION_MARKER,
  },
  serializers: {
    headers: (h: unknown) =>
      h && typeof h === "object"
        ? redactSensitiveHeaders(h as Record<string, unknown>)
        : h,
    err: serializeLoggedError,
  },
  hooks: {
    streamWrite(serialized: string) {
      try {
        const record: unknown = JSON.parse(serialized);
        return `${JSON.stringify(redactCredentialFields(record))}\n`;
      } catch {
        return '{"level":50,"msg":"Log record could not be safely redacted"}\n';
      }
    },
    logMethod(this: Logger, inputArgs: Parameters<LogFn>, method: LogFn) {
      const args: readonly unknown[] = inputArgs;
      const safeArgs = args.map((arg) =>
        typeof arg === "string" ? sanitizeCredentialText(arg) : redactCredentialFields(arg),
      );
      return method.apply(this, safeArgs as Parameters<LogFn>);
    },
  },
} satisfies LoggerOptions;

const isProduction = process.env.NODE_ENV === "production";
export const logger: Logger = isProduction
  ? pino({
      level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "info",
      ...basePinoOptions,
    })
  : pino(
      {
        level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "debug",
        ...basePinoOptions,
      },
      pino.transport({
        target: "pino-pretty",
        options: {
          ...sharedOpts,
          ignore: "pid,hostname,req,res,responseTime",
          colorize: true,
          destination: 1,
        },
      }),
    );

function requestClassificationUrl(req: {
  originalUrl?: unknown;
  url?: unknown;
}): string | undefined {
  return typeof req.originalUrl === "string"
    ? req.originalUrl
    : typeof req.url === "string"
      ? req.url
      : undefined;
}

function isPrivateWebhook(req: {
  method?: string;
  originalUrl?: unknown;
  url?: unknown;
}) {
  return isPrivateWebhookHttpRequest(
    req.method,
    requestClassificationUrl(req),
  );
}

function privateWebhookLogUrl(url: unknown) {
  return typeof url === "string" && /\/routine-triggers\/public(?:\/|$)/i.test(url)
    ? "/api/routine-triggers/public/:publicId/fire"
    : "/api/chat-webhooks/:publicId/:provider";
}

function requestLogUrl(req: {
  method?: string;
  originalUrl?: unknown;
  url?: unknown;
}) {
  if(isPrivateDotPrincipalHttpRequest(requestClassificationUrl(req)))return "/mcp/runner/oauth/cloud-principal";
  if(isPrivateMuseHttpRequest(requestClassificationUrl(req)))return "/api/muse/:protocol";
  if (isPrivateAgentObservabilityHttpRequest(requestClassificationUrl(req))) return "/api/companies/:companyId/observability";
  return isPrivateWebhook(req)
    ? privateWebhookLogUrl(requestClassificationUrl(req))
    : stripSecretBearingUrlParts(typeof req.url === "string" ? req.url : "");
}

function abortedRequestMessage(req: IncomingMessage, res: ServerResponse) {
  if (!req.readableAborted && res.writableFinished) return null;
  return `${req.method} ${requestLogUrl(req)} — request aborted${res.headersSent ? " during response" : " before response"}`;
}

export function createHttpLogger(baseLogger: Logger) {
  return pinoHttp({
    logger: baseLogger,
    serializers: {
      err: sanitizeErrorObject,
      req(req: Record<string, unknown> & { url?: unknown; headers?: unknown }) {
        if (isPrivateAgentObservabilityHttpRequest(typeof req.url === "string" ? req.url : undefined)) {
          return { id: req.id, method: req.method, url: "/api/companies/:companyId/observability" };
        }
        if (isPrivateDotPrincipalHttpRequest(typeof req.url === "string" ? req.url : undefined)) return { id: req.id, method: req.method, url: "/mcp/runner/oauth/cloud-principal" };
        if (isPrivateMuseHttpRequest(typeof req.url === "string" ? req.url : undefined)) return { id: req.id, method: req.method, url: "/api/muse/:protocol" };
        if (isPrivateAgentCommentaryHttpRequest(typeof req.url === "string" ? req.url : undefined)) {
          return { id: req.id, method: req.method, url: stripSecretBearingUrlParts(req.url as string) };
        }
        if (
          isPrivateWebhook({
            method: typeof req.method === "string" ? req.method : undefined,
            url: req.url,
          })
        ) {
          // pino's standard request serializer has already selected originalUrl.
          // A closed projection also excludes params, arbitrary headers and any
          // parser/SDK-added body copies, including Buffer numeric byte keys.
          return {
            id: req.id,
            method: req.method,
            url: privateWebhookLogUrl(req.url),
          };
        }
        const headers =
          req.headers && typeof req.headers === "object"
            ? redactSensitiveHeaders(req.headers as Record<string, unknown>)
            : req.headers;
        return {
          ...req,
          url:
            typeof req.url === "string"
              ? stripSecretBearingUrlParts(req.url)
              : req.url,
          headers,
          query: undefined,
        };
      },
      res(
        res: Record<string, unknown> & {
          headers?: unknown;
          raw?: {
            req?: { method?: string; originalUrl?: unknown; url?: unknown };
          };
        },
      ) {
        // A provider error may also be reflected in response headers. Keep the
        // same content-free contract on both sides of a webhook request.
        if (
          res.raw?.req &&
          (isPrivateWebhook(res.raw.req) ||
            isPrivateMuseHttpRequest(requestClassificationUrl(res.raw.req)) ||
            isPrivateDotPrincipalHttpRequest(requestClassificationUrl(res.raw.req)) ||
            isPrivateAgentCommentaryHttpRequest(
              requestClassificationUrl(res.raw.req),
            ) ||
            isPrivateAgentObservabilityHttpRequest(
              requestClassificationUrl(res.raw.req),
            ))
        ) {
          return { statusCode: res.statusCode };
        }
        if (res.headers && typeof res.headers === "object") {
          return {
            ...res,
            headers: redactSensitiveHeaders(
              res.headers as Record<string, unknown>,
            ),
          };
        }
        return res;
      },
    },
    customLogLevel(_req, res, err) {
      if (err || (res as ServerResponse & { err?: unknown }).err || res.statusCode >= 500) return "error";
      if (_req.readableAborted || !res.writableFinished) return "warn";
      if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
        return "silent";
      }
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage(req, res) {
      return abortedRequestMessage(req, res) ?? `${req.method} ${requestLogUrl(req)} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      const abortedMessage = abortedRequestMessage(req, res);
      if (abortedMessage) return abortedMessage;
      if (
        isSecretSensitiveHttpRequest(req.method, requestClassificationUrl(req))
      ) {
        return `${req.method} ${requestLogUrl(req)} ${res.statusCode} — request failed`;
      }
      const ctx = (res as any).__errorContext;
      const errMsg =
        ctx?.error?.message ||
        err?.message ||
        (res as any).err?.message ||
        "unknown error";
      return `${req.method} ${stripSecretBearingUrlParts(req.url ?? "")} ${res.statusCode} — ${errMsg}`;
    },
    customErrorObject(req, _res, _err, value) {
      if (isPrivateAgentObservabilityHttpRequest(requestClassificationUrl(req))) {
        return { ...value, err: { type: "Error", message: "Agent observability request failed" } };
      }
      if(isPrivateDotPrincipalHttpRequest(requestClassificationUrl(req)))return {...value,err:{type:"Error",message:"Dot principal request failed"}};
      if (isPrivateMuseHttpRequest(requestClassificationUrl(req)))return {...value,err:{type:"Error",message:"External agent request failed"}};
      if (isPrivateAgentCommentaryHttpRequest(requestClassificationUrl(req))) {
        return { ...value, err: { type: "Error", message: "Feedback request failed" } };
      }
      // pino-http serializes res.err independently of customProps/errorContext.
      // Do not rely on a particular error handler having sanitized an SDK Error.
      return isPrivateWebhook(req)
        ? {
            ...value,
            err: { type: "Error", message: "Chat webhook request failed" },
          }
        : value;
    },
    customProps(req, res) {
      if (res.statusCode >= 400) {
        const ctx = (res as any).__errorContext;
        if (/^\/mcp\/(?:oauth|paperclip)(?:\/|$)/.test(requestClassificationUrl(req) ?? "")) {
          return { reqBody: "[REDACTED]", ...(ctx ? { errorContext: { name: "Error" } } : {}) };
        }
        if (isPrivateWebhook(req) || isPrivateMuseHttpRequest(requestClassificationUrl(req)) || isPrivateDotPrincipalHttpRequest(requestClassificationUrl(req)) || isPrivateAgentCommentaryHttpRequest(requestClassificationUrl(req)) || isPrivateAgentObservabilityHttpRequest(requestClassificationUrl(req))) {
          // Omit, rather than recursively redact, the entire provider payload.
          // This applies equally before/after parsing and with/without context.
          return {
            reqBody: "[REDACTED]",
            ...(ctx || (res as any).err
              ? { errorContext: { name: "Error" } }
              : {}),
          };
        }
        if (ctx) {
          const secretSensitiveRoute = isSecretSensitiveHttpRequest(
            req.method,
            requestClassificationUrl(req),
          );
          return {
            // Provider SDK and validation errors sometimes echo the supplied
            // credential in their prose. Keep only a non-sensitive type marker
            // for setup routes; the status, route, and redacted body remain.
            errorContext: secretSensitiveRoute
              ? { name: "Error" }
              : redactSensitive(ctx.error),
            reqBody: redactSensitive(ctx.reqBody),
            reqParams: redactSensitive(ctx.reqParams),
          };
        }
        const props: Record<string, unknown> = {};
        const { body, params } = req as any;
        if (body && typeof body === "object" && Object.keys(body).length > 0) {
          props.reqBody = redactSensitive(body);
        }
        if (
          params &&
          typeof params === "object" &&
          Object.keys(params).length > 0
        ) {
          props.reqParams = redactSensitive(params);
        }
        if ((req as any).route?.path) {
          props.routePath = (req as any).route.path;
        }
        return props;
      }
      return {};
    },
  });
}

export const httpLogger = createHttpLogger(logger);
